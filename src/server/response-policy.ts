// The response policy: what every answer says about itself. The part of hardening@1 that is not a limit.
//
// PocketBase's four security headers on every response, the strict Content-Security-Policy on a served file, CORS,
// and the CSRF check that naming the origins makes possible. Every knob is read from the instance's env on each
// request (the request's env first, since a knob may be a feature flag evaluated per request: flags.ts), and an
// instance that sets none of them answers exactly as it did when app.ts carried these headers itself: origin *,
// the four headers, the files' policy, no CSRF check.
//
// The CSRF rule, and why it is tied to VOIDBASE_CORS_ORIGINS: origin * is safe while authentication is a bearer
// token, because nothing a browser sends on its own carries one. A cookie is sent on its own. So once an operator
// has named the origins their application lives on, a state-changing request (POST, PATCH, PUT, DELETE) that
// arrives with a cookie from an origin that is not this instance's own and not one of the named ones is refused
// with 403, naming the header the decision came from. Origin decides when the browser sent it; Sec-Fetch-Site
// decides when it did not (same-origin and none pass, same-site and cross-site are refused); a request with
// neither, which no browser makes cross-site, passes. A request without a cookie is never touched.
import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { env as runtimeEnv } from "#platform/env";
import { ApiError } from "./errors";
import type { AppEnv } from "./types";

/** the policy on a served file, PocketBase's (apis/file.go): nothing runs, nothing loads, nothing escapes the sandbox */
export const FILE_CSP = "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox";
/** VOIDBASE_HSTS=1: one year, the value preload lists expect */
const HSTS_DEFAULT_MAX_AGE = 31536000;
const CORS_HEADERS = ["Authorization", "Content-Type"];
const CORS_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS", "HEAD"];
const STATE_CHANGING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** The knobs, resolved: what `hardening@1`'s `policy(env)` answers and what the middleware applies. */
export interface ResponsePolicy {
  /** `*` (the default, and what an unset VOIDBASE_CORS_ORIGINS means) or the origins it names, lowercased */
  corsOrigins: "*" | string[];
  /** seconds of Strict-Transport-Security on https requests; 0 (the default) sends none */
  hstsMaxAge: number;
  /** Referrer-Policy, when VOIDBASE_REFERRER_POLICY names one */
  referrerPolicy: string;
  /** Permissions-Policy, when VOIDBASE_PERMISSIONS_POLICY names one */
  permissionsPolicy: string;
  /** Content-Security-Policy on every response that is not a served file and did not set its own; empty by default */
  csp: string;
  /** Content-Security-Policy on a served file: FILE_CSP unless VOIDBASE_CSP_FILES replaces it */
  cspFiles: string;
  /** VOIDBASE_CROSS_ORIGIN: Cross-Origin-Embedder-Policy require-corp and Cross-Origin-Resource-Policy same-origin */
  crossOrigin: boolean;
}

const read = (name: string, env?: object): string => {
  try { return String((env as Record<string, unknown> | undefined)?.[name] ?? (runtimeEnv as Record<string, unknown>)[name] ?? process.env?.[name] ?? "").trim(); } catch { return ""; }
};
const truthy = (v: string): boolean => ["1", "true", "on", "yes"].includes(v.toLowerCase());
const normalizeOrigin = (o: string): string => o.trim().toLowerCase().replace(/\/+$/, "");

/** the knobs as this request's env sets them; nothing set is today's behaviour */
export function responsePolicy(env?: object): ResponsePolicy {
  const named = read("VOIDBASE_CORS_ORIGINS", env).split(",").map(normalizeOrigin).filter(Boolean);
  const hsts = read("VOIDBASE_HSTS", env);
  return {
    corsOrigins: !named.length || named.includes("*") ? "*" : named,
    hstsMaxAge: truthy(hsts) ? HSTS_DEFAULT_MAX_AGE : Math.max(0, Math.floor(Number(hsts)) || 0),
    referrerPolicy: read("VOIDBASE_REFERRER_POLICY", env),
    permissionsPolicy: read("VOIDBASE_PERMISSIONS_POLICY", env),
    csp: read("VOIDBASE_CSP", env),
    cspFiles: read("VOIDBASE_CSP_FILES", env) || FILE_CSP,
    crossOrigin: truthy(read("VOIDBASE_CROSS_ORIGIN", env)),
  };
}

/** the reason a request is refused as cross-site, or null: the rule in this file's header, applied to one request */
export function csrfRefusal(c: Context<AppEnv>, policy: ResponsePolicy): string | null {
  if (policy.corsOrigins === "*" || !STATE_CHANGING.has(c.req.method.toUpperCase()) || !c.req.header("cookie")) return null;
  const origin = c.req.header("origin")?.trim();
  if (origin) {
    const o = normalizeOrigin(origin);
    if (o === normalizeOrigin(new URL(c.req.url).origin) || policy.corsOrigins.includes(o)) return null;
    return `Cross-site request refused: Origin ${JSON.stringify(origin)} is not one of the origins VOIDBASE_CORS_ORIGINS names.`;
  }
  const site = c.req.header("sec-fetch-site")?.trim().toLowerCase();
  if (site && site !== "same-origin" && site !== "none") return `Cross-site request refused: Sec-Fetch-Site ${JSON.stringify(site)} says the request did not come from this instance, and it carries no Origin to match against VOIDBASE_CORS_ORIGINS.`;
  return null;
}

/** first in the chain, so every response passes through it: errors, not-founds, preflights and files included */
export function responsePolicyMiddleware(): MiddlewareHandler<AppEnv> {
  const wildcard = cors({ origin: "*", allowHeaders: CORS_HEADERS, allowMethods: CORS_METHODS });
  return async (c, next) => {
    const policy = responsePolicy(c.env);
    // a named list: the matching origin is echoed and Vary: Origin added; a non-listed origin gets no CORS headers
    const corsFor = policy.corsOrigins === "*" ? wildcard : cors({ origin: (origin) => (policy.corsOrigins as string[]).includes(normalizeOrigin(origin)) ? origin : null, allowHeaders: CORS_HEADERS, allowMethods: CORS_METHODS });
    // refused here rather than thrown, so the headers below still land on the refusal
    const refused = csrfRefusal(c, policy);
    const preflight = await corsFor(c, refused ? async () => { c.res = new ApiError(403, refused, {}).response(); } : next);
    if (preflight instanceof Response) c.res = preflight; // OPTIONS: cors answers it without calling next
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "SAMEORIGIN");
    c.header("X-Xss-Protection", "1; mode=block");
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    if (policy.crossOrigin) {
      c.header("Cross-Origin-Embedder-Policy", "require-corp");
      c.header("Cross-Origin-Resource-Policy", "same-origin");
    }
    if (policy.hstsMaxAge > 0 && new URL(c.req.url).protocol === "https:") c.header("Strict-Transport-Security", `max-age=${policy.hstsMaxAge}; includeSubDomains`);
    if (policy.referrerPolicy) c.header("Referrer-Policy", policy.referrerPolicy);
    if (policy.permissionsPolicy) c.header("Permissions-Policy", policy.permissionsPolicy);
    // a served file (the route marks it: c.set("file", true)) gets the files' policy; anything else gets the
    // instance's, when it has one, unless the route set its own (backups' download does)
    if (c.get("file")) c.header("Content-Security-Policy", policy.cspFiles);
    else if (policy.csp && !c.res.headers.has("Content-Security-Policy")) c.header("Content-Security-Policy", policy.csp);
  };
}
