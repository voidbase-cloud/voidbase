// apis/record_helpers.go recordAuthResponse: every successful authentication (password, OAuth2, OTP, passkey,
// refresh, impersonate) ends here. Superuser IP allowlist, the collection's authRule, OnRecordAuthRequest, the
// MFA handshake (401 {mfaId} until a second method confirms), record export with email, expand, login alert.
import type { Context } from "hono";
import { newAuthToken } from "./auth";
import type { Collection } from "./collections/model";
import { one, run } from "./db";
import { badRequest, forbidden } from "./errors";
import { HookRecord } from "./hooks/record";
import { trigger } from "./hooks/runtime";
import { nowString, randomId } from "./ids";
import { sendRecordAuthAlert } from "./mail";
import { enrich, recordMatchesRule, type RecordContext } from "./records/service";
import { rowToValues } from "./records/values";
import { loadSettings } from "./settings";
import type { AppEnv, Row } from "./types";

const opt = <T>(c: Collection, path: string, fallback: T): T => { let cur: unknown = c.options; for (const k of path.split(".")) { if (!cur || typeof cur !== "object") return fallback; cur = (cur as Record<string, unknown>)[k]; } return (cur === undefined || cur === null ? fallback : cur) as T; };

export interface AuthResponseOptions { token?: string; body?: Record<string, unknown>; meta?: Record<string, unknown> }

export async function recordAuthResponse(c: Context<AppEnv>, ctx: RecordContext, collection: Collection, row: Row, method: string, options: AuthResponseOptions = {}): Promise<Response> {
  const token = options.token ?? (await newAuthToken({ collection, row }));
  const db = c.env.DB;
  if (collection.name === "_superusers") {
    const allowed = (await loadSettings(db)).superuserIPs;
    if (allowed.length && !ipInList(allowed, realIP(c))) throw forbidden();
  }
  // authRule: "" lets everyone in, a filter restricts, null (superusers only) blocks regular logins
  const rawRule = (collection.options as Record<string, unknown>).authRule;
  const authRule = rawRule === undefined ? "" : (rawRule as string | null);
  if (authRule === null) { if (!ctx.superuser) throw forbidden("The request doesn't satisfy the collection requirements to authenticate."); }
  else if (authRule.trim() !== "") {
    const ok = await recordMatchesRule(ctx, collection, authRule, rowToValues(collection, row));
    if (!ok) throw forbidden("The request doesn't satisfy the collection requirements to authenticate.");
  }

  const rec = HookRecord.fromRow(collection, row);
  const ev = { app: undefined as unknown, collection, record: rec, token, meta: options.meta, authMethod: method, written: false, next: async () => undefined as unknown };
  let response: Response | null = null;
  await trigger("onRecordAuthRequest", ev, collection.name, async () => {
    const mfaId = await checkMFA(c, ctx, collection, row, method, options.body ?? {});
    if (mfaId) { response = c.json({ mfaId }, 401); return; }
    const authCtx: RecordContext = { ...ctx, auth: { collection, row }, superuser: ctx.superuser || collection.name === "_superusers" };
    const own = { ...authCtx, request: { ...authCtx.request, auth: { collection, row } } };
    const [json] = await enrich(own, collection, [row], { expand: c.req.query("expand") ?? "" });
    const exported = json as Record<string, unknown>;
    if (!("email" in exported)) exported.email = row.email ?? ""; // IgnoreEmailVisibility(true)
    if (method !== "" && opt<boolean>(collection, "authAlert.enabled", false)) {
      try { await authAlert(c, collection, row); } catch (err) { console.warn("voidbase: failed to send login alert", err); }
    }
    const result: Record<string, unknown> = {};
    if (ev.meta !== undefined && ev.meta !== null) result.meta = ev.meta;
    result.record = sortKeys(exported);
    result.token = ev.token;
    response = c.json(result);
  });
  return response ?? c.body(null, 204);
}

const sortKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function realIP(c: Context<AppEnv>): string {
  return c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? c.req.header("X-Real-IP") ?? "127.0.0.1";
}
function ipInList(list: string[], ip: string): boolean {
  for (const entry of list) {
    if (!entry.includes("/")) { if (entry === ip) return true; continue; }
    const [net, bitsStr] = entry.split("/"); const bits = Number(bitsStr);
    const a = ipv4(net ?? ""), b = ipv4(ip);
    if (a === null || b === null) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if (((a & mask) >>> 0) === ((b & mask) >>> 0)) return true;
  }
  return false;
}
const ipv4 = (s: string): number | null => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s); if (!m) return null; return ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0; };

// checkMFA: first method opens an MFA session (401 {mfaId}); a *different* method within the duration closes it
async function checkMFA(c: Context<AppEnv>, ctx: RecordContext, collection: Collection, row: Row, method: string, body: Record<string, unknown>): Promise<string> {
  if (!opt<boolean>(collection, "mfa.enabled", false) || method === "") return "";
  const rule = opt<string>(collection, "mfa.rule", "");
  if (rule.trim() !== "") {
    let wants = true;
    try { wants = await recordMatchesRule(ctx, collection, rule, rowToValues(collection, row)); } catch { throw badRequest("Failed to authenticate."); }
    if (!wants) return "";
  }
  const mfaId = c.req.query("mfaId") || String(body.mfaId ?? "");
  const db = c.env.DB;
  if (!mfaId) {
    const id = randomId(); const now = nowString();
    await run(db, "INSERT INTO `_mfas` (id, collectionRef, recordRef, method, created, updated) VALUES (?, ?, ?, ?, ?, ?)", [id, collection.id, String(row.id), method, now, now]);
    return id;
  }
  const mfa = await one<Row>(db, "SELECT * FROM `_mfas` WHERE id = ? LIMIT 1", [mfaId]);
  const duration = Number(opt<number>(collection, "mfa.duration", 1800)) * 1000;
  if (!mfa || Date.now() - Date.parse(String(mfa.created).replace(" ", "T")) > duration) {
    if (mfa) await run(db, "DELETE FROM `_mfas` WHERE id = ?", [mfaId]);
    throw badRequest("Invalid or expired MFA session.");
  }
  if (mfa.recordRef !== row.id || mfa.collectionRef !== collection.id) throw badRequest("Invalid MFA session.");
  if (mfa.method === method) throw badRequest("A different authentication method is required.");
  await run(db, "DELETE FROM `_mfas` WHERE id = ?", [mfaId]);
  return "";
}

// authAlert: fingerprint = hash(ip + user agent); a new fingerprint on a record with previous origins mails the alert
async function authAlert(c: Context<AppEnv>, collection: Collection, row: Row) {
  const db = c.env.DB;
  const ip = realIP(c);
  let ua = c.req.header("User-Agent") ?? "";
  if (ua.length > 200) ua = ua.slice(0, 200) + "...";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + ua)));
  const fingerprint = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const info = `${nowString()} - ${ip} ${ua}`;
  const origins = await (await import("./db")).all<Row>(db, "SELECT * FROM `_authOrigins` WHERE collectionRef = ? AND recordRef = ?", [collection.id, String(row.id)]);
  const isFirstLogin = origins.length === 0;
  const known = origins.some((o) => o.fingerprint === fingerprint);
  if (!known) {
    const now = nowString();
    await run(db, "INSERT INTO `_authOrigins` (id, collectionRef, recordRef, fingerprint, created, updated) VALUES (?, ?, ?, ?, ?, ?)", [randomId(), collection.id, String(row.id), fingerprint, now, now]);
    if (!isFirstLogin && row.email) await sendRecordAuthAlert(db, collection, row, info);
  }
}
