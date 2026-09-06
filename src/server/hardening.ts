// Core middleware parity (apis/middlewares*.go): real client IP through settings.trustedProxy, PocketBase's rate
// limit rules (labels, audiences, prefix rules, fixed windows per client) and the default 32 MB body limit.
// Counters live in isolate memory, so limits are approximate across isolates; PocketBase's are per process. On
// Cloudflare a rate-limit binding (RATE_LIMITER, declared by the deploy) adds an exact per-location ceiling per IP.
import type { Context, MiddlewareHandler } from "hono";
import { findCollection } from "./collections/model";
import { ApiError } from "./errors";
import { loadSettings, type Settings } from "./settings";
import type { AppEnv } from "./types";

const isIP = (s: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s) || /^[0-9a-fA-F:]+$/.test(s);

// core/event_request.go RealIP: trusted proxy headers (last value, leftmost or rightmost IP), else the connection IP
export function realIPWith(settings: Settings, c: Context<AppEnv>): string {
  for (const h of settings.trustedProxy.headers) {
    const raw = c.req.header(h);
    if (!raw) continue;
    const ips = raw.split(",").map((s) => s.trim()).filter(isIP);
    if (!ips.length) continue;
    return settings.trustedProxy.useLeftmostIP ? ips[0]! : ips[ips.length - 1]!;
  }
  return c.req.header("CF-Connecting-IP") ?? c.req.header("X-Real-IP") ?? "127.0.0.1"; // the connection's own address on Workers
}
export async function realIP(c: Context<AppEnv>): Promise<string> { return realIPWith(await loadSettings(c.env.DB), c); }

export function ipInList(list: string[], ip: string): boolean {
  if (!list.length || !ip) return false;
  const v4 = (s: string): number | null => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s); return m ? ((+m[1]! << 24) | (+m[2]! << 16) | (+m[3]! << 8) | +m[4]!) >>> 0 : null; };
  for (const item of list) {
    if (item === ip) return true;
    if (!item.includes("/")) continue;
    const [net, bitsStr] = item.split("/"); const bits = Number(bitsStr);
    const a = v4(net ?? ""), b = v4(ip);
    if (a === null || b === null) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if (((a & mask) >>> 0) === ((b & mask) >>> 0)) return true;
  }
  return false;
}

// ---- rate limits ---------------------------------------------------------------------------------
interface Rule { label: string; audience: string; duration: number; maxRequests: number }
interface Window { start: number; count: number }
const limiters = new Map<string, Map<string, Window>>();
let lastSweep = 0;

// tags per route as bound in apis/record_auth.go, record_crud.go and file.go
const COLLECTION_ROUTES: { re: RegExp; method: string; tags: string[]; pattern: string }[] = [
  { re: /^\/api\/collections\/([^/]+)\/records$/, method: "GET", tags: ["list"], pattern: "GET /api/collections/{collection}/records" },
  { re: /^\/api\/collections\/([^/]+)\/records$/, method: "POST", tags: ["create"], pattern: "POST /api/collections/{collection}/records" },
  { re: /^\/api\/collections\/([^/]+)\/records\/[^/]+$/, method: "GET", tags: ["view"], pattern: "GET /api/collections/{collection}/records/{id}" },
  { re: /^\/api\/collections\/([^/]+)\/records\/[^/]+$/, method: "PATCH", tags: ["update"], pattern: "PATCH /api/collections/{collection}/records/{id}" },
  { re: /^\/api\/collections\/([^/]+)\/records\/[^/]+$/, method: "DELETE", tags: ["delete"], pattern: "DELETE /api/collections/{collection}/records/{id}" },
  { re: /^\/api\/files\/([^/]+)\/[^/]+\/[^/]+$/, method: "GET", tags: ["file"], pattern: "GET /api/files/{collection}/{recordId}/{filename}" },
  { re: /^\/api\/collections\/([^/]+)\/auth-methods$/, method: "GET", tags: ["listAuthMethods"], pattern: "GET /api/collections/{collection}/auth-methods" },
  { re: /^\/api\/collections\/([^/]+)\/auth-refresh$/, method: "POST", tags: ["authRefresh"], pattern: "POST /api/collections/{collection}/auth-refresh" },
  { re: /^\/api\/collections\/([^/]+)\/auth-with-password$/, method: "POST", tags: ["authWithPassword", "auth"], pattern: "POST /api/collections/{collection}/auth-with-password" },
  { re: /^\/api\/collections\/([^/]+)\/auth-with-oauth2$/, method: "POST", tags: ["authWithOAuth2", "auth"], pattern: "POST /api/collections/{collection}/auth-with-oauth2" },
  { re: /^\/api\/collections\/([^/]+)\/request-otp$/, method: "POST", tags: ["requestOTP"], pattern: "POST /api/collections/{collection}/request-otp" },
  { re: /^\/api\/collections\/([^/]+)\/auth-with-otp$/, method: "POST", tags: ["authWithOTP", "auth"], pattern: "POST /api/collections/{collection}/auth-with-otp" },
  { re: /^\/api\/collections\/([^/]+)\/request-password-reset$/, method: "POST", tags: ["requestPasswordReset"], pattern: "POST /api/collections/{collection}/request-password-reset" },
  { re: /^\/api\/collections\/([^/]+)\/confirm-password-reset$/, method: "POST", tags: ["confirmPasswordReset"], pattern: "POST /api/collections/{collection}/confirm-password-reset" },
  { re: /^\/api\/collections\/([^/]+)\/request-verification$/, method: "POST", tags: ["requestVerification"], pattern: "POST /api/collections/{collection}/request-verification" },
  { re: /^\/api\/collections\/([^/]+)\/confirm-verification$/, method: "POST", tags: ["confirmVerification"], pattern: "POST /api/collections/{collection}/confirm-verification" },
  { re: /^\/api\/collections\/([^/]+)\/request-email-change$/, method: "POST", tags: ["requestEmailChange"], pattern: "POST /api/collections/{collection}/request-email-change" },
  { re: /^\/api\/collections\/([^/]+)\/confirm-email-change$/, method: "POST", tags: ["confirmEmailChange"], pattern: "POST /api/collections/{collection}/confirm-email-change" },
];

// RateLimitsConfig.FindRateLimitRule: exact label in order, prefix rules ("/api/") against the first label only
function findRule(rules: Rule[], labels: string[], audiences: string[]): Rule | null {
  const prefixRules: Rule[] = [];
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]!;
    for (const r of rules) {
      if (label === r.label && audiences.includes(r.audience)) return r;
      if (i === 0 && r.label.endsWith("/")) prefixRules.push(r);
    }
    for (const r of prefixRules) if ((label + "/").startsWith(r.label) && audiences.includes(r.audience)) return r;
  }
  return null;
}

function consume(limiterId: string, clientKey: string, rule: Rule): boolean {
  const now = Date.now();
  if (now - lastSweep > 60_000) { lastSweep = now; for (const [id, m] of limiters) { for (const [k, w] of m) if (now - w.start > 1800_000) m.delete(k); if (!m.size) limiters.delete(id); } }
  let clients = limiters.get(limiterId);
  if (!clients) { clients = new Map(); limiters.set(limiterId, clients); }
  let w = clients.get(clientKey);
  if (!w || now - w.start >= rule.duration * 1000) { w = { start: now, count: 0 }; clients.set(clientKey, w); }
  w.count++;
  return w.count <= rule.maxRequests;
}

export function rateLimitMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const settings = await loadSettings(c.env.DB);
    const auth = c.get("auth");
    const ip = realIPWith(settings, c);
    if (!settings.rateLimits.enabled || (auth && auth.collection.name === "_superusers") || ipInList(settings.rateLimits.excludedIPs, ip)) return next();
    // the binding's counters are shared by every isolate in a location (its limit and period are fixed at deploy time)
    if (c.env.RATE_LIMITER && !(await c.env.RATE_LIMITER.limit({ key: ip })).success) throw new ApiError(429, "Too Many Requests.", {});
    const path = new URL(c.req.url).pathname;
    const method = c.req.method.toUpperCase();
    const audiences = auth ? ["", "@auth"] : ["", "@guest"];
    const rules = settings.rateLimits.rules as Rule[];
    const route = COLLECTION_ROUTES.find((r) => r.method === method && r.re.test(path));
    let rule: Rule | null = null; let limiterId = "";
    if (route) {
      const collName = route.re.exec(path)![1]!;
      const collection = await findCollection(c.env.DB, collName);
      if (!collection) throw new ApiError(404, "Missing or invalid collection context.", {});
      const labels = [...route.tags.map((t) => `${collection.name}:${t}`), ...route.tags.map((t) => `*:${t}`), `${method} ${path}`, path];
      rule = findRule(rules, labels, audiences);
      if (rule) limiterId = collection.id + route.pattern + route.tags.join("") + rule.audience;
    } else {
      rule = findRule(rules, [`${method} ${path}`, path], audiences);
      if (rule) limiterId = rule.label + rule.audience;
    }
    if (rule) {
      if (rule.audience === "@guest" && auth) return next();
      if (rule.audience === "@auth" && !auth) return next();
      if (!consume(limiterId, ip, rule)) throw new ApiError(429, "Too Many Requests.", {});
    }
    return next();
  };
}

// apis/middlewares_body_limit.go: 32 MB unless a route says otherwise (batch inlines its own limit)
const DEFAULT_MAX_BODY = 32 << 20;
export function bodyLimitMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > DEFAULT_MAX_BODY && !new URL(c.req.url).pathname.startsWith("/api/batch") && !new URL(c.req.url).pathname.startsWith("/api/backups/upload")) throw new ApiError(413, "Request entity too large.", {});
    return next();
  };
}
