// One session across the pages and the API: the token voidbase mints, set as a cookie as well.
//
// A stack app has two notions of who is signed in. voidbase authenticates a request from `Authorization: Bearer
// <token>`, which is what the SDK sends from the browser. A Void page's loader runs server-side on the same Worker
// and is handed an ordinary navigation, which carries cookies and no header of the app's own, so without this it
// cannot tell who the visitor is. `VOIDBASE_AUTH_COOKIE=1` closes that: every route that mints a token sets it as
// a cookie too, sign-out clears it, and the server accepts that cookie as a source of the token when there is no
// `Authorization` header. The header still wins whenever both are there, so nothing an SDK client does changes.
//
// It is off by default because a cookie changes the security posture. A browser attaches a cookie on its own and
// never attaches a bearer token on its own, so the moment a cookie authenticates a state-changing request, a
// cross-site page can make the browser send one. That is exactly the hole the hardening plugin's origin rule
// (response-policy.ts, live once VOIDBASE_CORS_ORIGINS names origins) and its double-submit token (csrf.ts,
// VOIDBASE_CSRF=double-submit) exist for. So the knob refuses to take effect while neither is on: no cookie is
// set, none is accepted, and the instance says why once rather than opening the hole quietly. `voidbase deploy`
// refuses the same combination before it ships (src/node/deploy-cf.ts).
//
// Every knob here is read at request time, from the request's env first and the runtime's after it, exactly as the
// response policy's are, because a knob may be a feature flag evaluated per request (flags.ts).
import type { Context } from "hono";
import { cookieValue, csrfModeOf } from "./csrf";
import { decodeJWT } from "./jwt";
import { readKnob } from "./response-policy";
import type { AppEnv } from "./types";

/** the knob: `1`, `true`, `on` or `yes` asks for the cookie; anything else, unset included, is off */
export const AUTH_COOKIE_KNOB = "VOIDBASE_AUTH_COOKIE";
/** the cookie's name on https: `__Host-` binds it to this exact origin, with no Domain and a Path of `/` */
export const AUTH_COOKIE_SECURE = "__Host-vb_auth";
/** the same cookie on http, where `__Host-` would require Secure and no browser would keep it */
export const AUTH_COOKIE = "vb_auth";
/** where a browser session ends */
export const AUTH_CLEAR_PATH = "auth-clear";

/** the cookie this request's scheme uses */
export const authCookieName = (https: boolean): string => (https ? AUTH_COOKIE_SECURE : AUTH_COOKIE);

/** this request's scheme, without throwing on a URL that is not one */
export function isHttps(url: string): boolean {
  try { return new URL(url).protocol === "https:"; } catch { return false; }
}

const truthy = (v: string): boolean => ["1", "true", "on", "yes"].includes(v.trim().toLowerCase());

/**
 * The reason `VOIDBASE_AUTH_COOKIE` is refused, from the two knobs that could protect it, or null when one of them
 * does. Pure, and takes the raw knob values rather than a parsed policy, so `voidbase deploy` can ask the same
 * question of a Worker's vars before it ships them.
 */
export function authCookieRefusal(corsOrigins: string, csrf: string): string | null {
  const named = corsOrigins.split(",").map((o) => o.trim()).filter(Boolean);
  const originRule = named.length > 0 && !named.includes("*");
  if (originRule || csrfModeOf(csrf) === "double-submit") return null;
  return `${AUTH_COOKIE_KNOB} was refused: a cookie that authenticates a request needs a CSRF protection and neither is on. Set VOIDBASE_CORS_ORIGINS to the origins the application is served from, which turns the origin rule on, or VOIDBASE_CSRF=double-submit, which requires an X-CSRF-Token header on a cookie-authenticated write, or both. Until then no auth cookie is set and none is accepted.`;
}

/** what the knob amounts to on this request: asked for at all, in effect, and the reason when the two differ */
export interface AuthCookieState { asked: boolean; on: boolean; refusal: string | null }

let said = false;
/** the knob, resolved: off unless asked for, and refused unless one of the two CSRF protections is on */
export function authCookieState(env?: object): AuthCookieState {
  if (!truthy(readKnob(AUTH_COOKIE_KNOB, env))) return { asked: false, on: false, refusal: null };
  const refusal = authCookieRefusal(readKnob("VOIDBASE_CORS_ORIGINS", env), readKnob("VOIDBASE_CSRF", env));
  // said once per instance: the knob is read on every request, and the reason does not change between two of them
  if (refusal && !said) { said = true; console.error(`voidbase: ${refusal}`); }
  return { asked: true, on: !refusal, refusal };
}

/** how long the cookie may live: what is left of the token's own `exp`, in whole seconds */
export function tokenMaxAge(token: string, now = Date.now()): number {
  const exp = decodeJWT(token)?.exp;
  if (typeof exp !== "number") return 0;
  return Math.max(0, Math.floor(exp - now / 1000));
}

/** the Set-Cookie that carries the token: only the server reads it, and only as long as the token itself lives */
export function authSetCookie(token: string, https: boolean, maxAge: number): string {
  const parts = [`${authCookieName(https)}=${token}`, "Path=/"];
  if (maxAge > 0) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  parts.push("HttpOnly", "SameSite=Lax");
  if (https) parts.push("Secure");
  return parts.join("; ");
}

/** the Set-Cookie that takes it away: the same cookie, empty and already expired */
export function authClearCookie(https: boolean): string {
  const parts = [`${authCookieName(https)}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"];
  if (https) parts.push("Secure");
  return parts.join("; ");
}

/** the token this request carries in its own cookie, or "": the scheme names it, the knob decides whether it counts */
export function authCookieToken(request: Request, env?: object): string {
  if (!authCookieState(env).on) return "";
  const header = request.headers.get("cookie");
  return header ? cookieValue(header, authCookieName(isHttps(request.url))) : "";
}

/** the Set-Cookie an answer carrying a token should send, or null while the knob is off or refused */
export function authCookieFor(c: Context<AppEnv>, token: string): string | null {
  if (!token || !authCookieState(c.env).on) return null;
  return authSetCookie(token, isHttps(c.req.url), tokenMaxAge(token));
}

/** the Set-Cookie a sign-out should send, or null while the knob is off or refused */
export function authClearCookieFor(c: Context<AppEnv>): string | null {
  return authCookieState(c.env).on ? authClearCookie(isHttps(c.req.url)) : null;
}
