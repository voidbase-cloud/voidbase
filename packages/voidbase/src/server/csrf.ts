// The double-submit CSRF token: the half of the CSRF defence a named origin list cannot cover.
//
// response-policy.ts already refuses a state-changing cookie request whose Origin is not one of the origins
// VOIDBASE_CORS_ORIGINS names. That rule reads what the browser says about itself, which is the right first line
// and also everything an operator gets for free. This is the second line, and it reads something the browser
// cannot invent: a token the page had to have fetched.
//
// `VOIDBASE_CSRF=double-submit` turns it on (off by default; the origin rule is unchanged either way). `GET
// /api/csrf` answers `{ token }` and sets a cookie holding the same value, and a state-changing request that
// carries cookies must send that value in `X-CSRF-Token` or be refused 403. The cookie is deliberately not
// httpOnly, because the page has to read it to send it back; that is safe, since the attack this stops is a
// cross-site page making the browser send a request it cannot read the response or the cookies of.
//
// A request authenticated with an `Authorization` header is never subject to it. A browser attaches cookies on its
// own and never attaches a bearer token on its own, so a token in a header cannot be forged cross-site, and that is
// what the SDK sends. Turning this on therefore changes nothing for an SDK client and everything for a cookie one.
import type { Context, Hono } from "hono";
import { notFound } from "./errors";
import type { AppEnv } from "./types";

/** `VOIDBASE_CSRF`: `double-submit` or off, which is anything else, unset included */
export type CsrfMode = "off" | "double-submit";
/** the methods the check applies to, as PocketBase's own CSRF-shaped rules use (a GET is never state-changing) */
export const STATE_CHANGING = new Set(["POST", "PATCH", "PUT", "DELETE"]);
/** the cookie's name on https: `__Host-` binds it to this exact origin, with no Domain and a Path of `/` */
export const CSRF_COOKIE_SECURE = "__Host-vb_csrf";
/** the same cookie on http, where `__Host-` would require Secure and no browser would keep it */
export const CSRF_COOKIE = "vb_csrf";
/** the header the token comes back in */
export const CSRF_HEADER = "X-CSRF-Token";
/** where a page gets a token */
export const CSRF_PATH = "/api/csrf";

/** the knob's value as a mode: only the exact word turns it on */
export const csrfModeOf = (value: string): CsrfMode => (value.trim().toLowerCase() === "double-submit" ? "double-submit" : "off");

/** the cookie this request's scheme uses */
export const csrfCookieName = (https: boolean): string => (https ? CSRF_COOKIE_SECURE : CSRF_COOKIE);

/** a new token: 32 random bytes, base64url, which is what the cookie holds and what the header must repeat */
export function newCsrfToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let raw = ""; for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** the Set-Cookie a `GET /api/csrf` sends: readable by the page, scoped to this origin, sent on top-level navigation */
export const csrfSetCookie = (token: string, https: boolean): string =>
  `${csrfCookieName(https)}=${token}; Path=/; SameSite=Lax${https ? "; Secure" : ""}`;

/** one cookie out of a Cookie header, or "" */
export function cookieValue(header: string, name: string): string {
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

/** equal or not, in time that does not depend on where they first differ */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  if (!x.length) return false;
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ (y.length ? y[i % y.length]! : 0);
  return diff === 0;
}

/**
 * The reason this request is refused for want of a matching token, or null. The rule in this file's header applied
 * to one request: off, not state-changing, or carrying an Authorization header, and it never applies; carrying no
 * cookie at all, and there is no session to forge against.
 */
export function csrfTokenRefusal(c: Context<AppEnv>, mode: CsrfMode): string | null {
  if (mode !== "double-submit") return null;
  const method = c.req.method.toUpperCase();
  if (!STATE_CHANGING.has(method)) return null;
  if (c.req.header("authorization")) return null; // a bearer token is not something a browser attaches by itself
  const cookies = c.req.header("cookie");
  if (!cookies) return null;
  const name = csrfCookieName(new URL(c.req.url).protocol === "https:");
  const held = cookieValue(cookies, name);
  const sent = c.req.header(CSRF_HEADER.toLowerCase())?.trim() ?? "";
  if (!held) return `Cross-site request refused: this ${method} carries cookies but no ${name} cookie. Call GET ${CSRF_PATH} and send the token it answers in ${CSRF_HEADER}.`;
  if (!sent) return `Cross-site request refused: the ${CSRF_HEADER} header is missing. VOIDBASE_CSRF=double-submit requires it on a cookie-authenticated ${method}; a request authenticated with an Authorization header is not subject to it.`;
  if (!timingSafeEqual(sent, held)) return `Cross-site request refused: the ${CSRF_HEADER} header does not match the ${name} cookie. Call GET ${CSRF_PATH} for a fresh token.`;
  return null;
}

/**
 * `GET /api/csrf`. Mounted always and answering 404 while the knob is off, because the knob is read per request
 * (a feature flag may decide it) and the routes are fixed when the app is built. Every call is a fresh token and a
 * fresh cookie, so a page that asks twice has rotated its own and the older one stops matching.
 */
export function mountCsrfRoute(app: Hono<AppEnv>, mode: (env?: object) => CsrfMode): void {
  app.get(CSRF_PATH, (c) => {
    if (mode(c.env) !== "double-submit") throw notFound();
    const token = newCsrfToken();
    c.header("Set-Cookie", csrfSetCookie(token, new URL(c.req.url).protocol === "https:"));
    c.header("Cache-Control", "no-store");
    return c.json({ token });
  });
}
