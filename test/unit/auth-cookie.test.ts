// The auth cookie (src/server/auth-cookie.ts): one session across the pages and the API, and the CSRF protection
// it is not allowed to exist without.
//
// What is asserted is the whole knob: off unless VOIDBASE_AUTH_COOKIE asks for it; refused, with the reason, while
// neither VOIDBASE_CORS_ORIGINS nor VOIDBASE_CSRF=double-submit is on; the cookie's exact attributes and the name
// each scheme uses; a lifetime that is the token's own; the header still winning over the cookie; and the route
// list the auth plugin mounts, sign-out included.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  AUTH_CLEAR_PATH, AUTH_COOKIE, AUTH_COOKIE_KNOB, AUTH_COOKIE_SECURE, authClearCookie, authCookieName,
  authCookieRefusal, authCookieState, authCookieToken, authSetCookie, tokenMaxAge,
} from "../../src/server/auth-cookie";
import { tokenFromRequest } from "../../src/server/auth";
import { signJWT } from "../../src/server/jwt";
import { sessionOf } from "../../src/adapter/runtime";
import { createKernel, load } from "../../src/server/kernel";
import { auth } from "../../src/server/plugins/auth";

const ORIGINS = { VOIDBASE_CORS_ORIGINS: "https://app.example" };
const DOUBLE_SUBMIT = { VOIDBASE_CSRF: "double-submit" };
const ON = { [AUTH_COOKIE_KNOB]: "1", ...ORIGINS };
const HTTPS = "https://voidbase.example/api/health";
const HTTP = "http://voidbase.local/api/health";
const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

describe("the knob, and the CSRF protection it needs", () => {
  test("off unless asked for: no cookie is read and nothing says anything", () => {
    expect(authCookieState({})).toEqual({ asked: false, on: false, refusal: null });
    expect(authCookieState({ [AUTH_COOKIE_KNOB]: "0" }).asked).toBe(false);
    expect(authCookieState({ [AUTH_COOKIE_KNOB]: "" }).asked).toBe(false);
  });

  test("every way of saying yes is the same yes", () => {
    for (const v of ["1", "true", "on", "yes", " TRUE "]) expect(authCookieState({ [AUTH_COOKIE_KNOB]: v, ...ORIGINS }).on).toBe(true);
    for (const v of ["no", "off", "2", "double-submit"]) expect(authCookieState({ [AUTH_COOKIE_KNOB]: v, ...ORIGINS }).asked).toBe(false);
  });

  test("asked for with neither protection on, it is refused and the reason names both fixes", () => {
    const state = authCookieState({ [AUTH_COOKIE_KNOB]: "1" });
    expect(state.asked).toBe(true);
    expect(state.on).toBe(false);
    expect(state.refusal).toContain(AUTH_COOKIE_KNOB);
    expect(state.refusal).toContain("VOIDBASE_CORS_ORIGINS");
    expect(state.refusal).toContain("VOIDBASE_CSRF=double-submit");
    expect(state.refusal).toContain("no auth cookie is set and none is accepted");
  });

  test("a wildcard origin list is no origin rule at all, so it is still refused", () => {
    expect(authCookieState({ [AUTH_COOKIE_KNOB]: "1", VOIDBASE_CORS_ORIGINS: "*" }).on).toBe(false);
    expect(authCookieState({ [AUTH_COOKIE_KNOB]: "1", VOIDBASE_CORS_ORIGINS: "https://a.example, *" }).on).toBe(false);
  });

  test("either protection alone is enough, and the refusal is pure: the two raw knobs decide", () => {
    expect(authCookieState({ [AUTH_COOKIE_KNOB]: "1", ...ORIGINS }).on).toBe(true);
    expect(authCookieState({ [AUTH_COOKIE_KNOB]: "1", ...DOUBLE_SUBMIT }).on).toBe(true);
    expect(authCookieState({ [AUTH_COOKIE_KNOB]: "1", ...ORIGINS, ...DOUBLE_SUBMIT }).refusal).toBeNull();
    expect(authCookieRefusal("", "")).toContain("refused");
    expect(authCookieRefusal("*", "off")).toContain("refused");
    expect(authCookieRefusal("https://app.example", "")).toBeNull();
    expect(authCookieRefusal("", "double-submit")).toBeNull();
  });
});

describe("the cookie itself", () => {
  test("__Host- and Secure on https, the plain name on http, and never a Domain", () => {
    expect(authCookieName(true)).toBe("__Host-vb_auth");
    expect(authCookieName(false)).toBe("vb_auth");
    const secure = authSetCookie("tok", true, 60);
    expect(secure.startsWith(`${AUTH_COOKIE_SECURE}=tok;`)).toBe(true);
    expect(secure).toContain("; Secure");
    expect(secure).not.toContain("Domain");
    const plain = authSetCookie("tok", false, 60);
    expect(plain.startsWith(`${AUTH_COOKIE}=tok;`)).toBe(true);
    expect(plain).not.toContain("Secure");
  });

  test("HttpOnly, SameSite=Lax and Path=/ on both schemes: the page never reads it, the server always does", () => {
    for (const https of [true, false]) {
      const c = authSetCookie("tok", https, 60);
      expect(c).toContain("; HttpOnly");
      expect(c).toContain("; SameSite=Lax");
      expect(c).toContain("; Path=/");
    }
  });

  test("its lifetime is the token's own expiry, in whole seconds, and a token without one is a session cookie", async () => {
    const token = await signJWT({ id: "u1", type: "auth" }, "secret", 600);
    const left = tokenMaxAge(token);
    expect(left).toBeGreaterThan(595);
    expect(left).toBeLessThanOrEqual(600);
    expect(authSetCookie(token, true, left)).toContain(`; Max-Age=${left}`);
    expect(tokenMaxAge("not-a-token")).toBe(0);
    expect(tokenMaxAge(await signJWT({ id: "u1" }, "s", -10))).toBe(0); // already expired: no Max-Age at all
    expect(authSetCookie("tok", true, 0)).not.toContain("Max-Age");
  });

  test("clearing it is the same cookie, empty and already expired", () => {
    const cleared = authClearCookie(true);
    expect(cleared.startsWith(`${AUTH_COOKIE_SECURE}=;`)).toBe(true);
    expect(cleared).toContain("; Max-Age=0");
    expect(cleared).toContain("; HttpOnly");
    expect(cleared).toContain("; SameSite=Lax");
    expect(cleared).toContain("; Secure");
    expect(authClearCookie(false).startsWith(`${AUTH_COOKIE}=;`)).toBe(true);
    expect(authClearCookie(false)).not.toContain("Secure");
  });
});

describe("where the token comes from", () => {
  test("the cookie counts only while the knob is on, and the scheme names the one that is read", () => {
    const onHttps = req(HTTPS, { cookie: `${AUTH_COOKIE_SECURE}=from-cookie` });
    expect(authCookieToken(onHttps, ON)).toBe("from-cookie");
    expect(authCookieToken(onHttps, {})).toBe("");
    expect(authCookieToken(onHttps, { [AUTH_COOKIE_KNOB]: "1" })).toBe(""); // asked for, refused, so it is nobody
    // the https cookie is not read on http and the http one is not read on https: __Host- means this exact origin
    expect(authCookieToken(req(HTTP, { cookie: `${AUTH_COOKIE_SECURE}=x` }), ON)).toBe("");
    expect(authCookieToken(req(HTTPS, { cookie: `${AUTH_COOKIE}=x` }), ON)).toBe("");
    expect(authCookieToken(req(HTTP, { cookie: `${AUTH_COOKIE}=x` }), ON)).toBe("x");
    expect(authCookieToken(req(HTTPS), ON)).toBe("");
  });

  test("the Authorization header still wins whenever both are there", () => {
    const both = req(HTTP, { authorization: "Bearer from-header", cookie: `${AUTH_COOKIE}=from-cookie` });
    expect(tokenFromRequest(both, ON)).toBe("from-header");
    expect(tokenFromRequest(req(HTTP, { authorization: "from-header" }), ON)).toBe("from-header");
    expect(tokenFromRequest(req(HTTP, { cookie: `${AUTH_COOKIE}=from-cookie` }), ON)).toBe("from-cookie");
    expect(tokenFromRequest(req(HTTP, { cookie: `${AUTH_COOKIE}=from-cookie` }), {})).toBe("");
    expect(tokenFromRequest(req(HTTP))).toBe("");
  });

  test("a cookie header holding other cookies too is read by name", () => {
    const r = req(HTTP, { cookie: `other=1; ${AUTH_COOKIE}=mine; __Host-vb_csrf=t` });
    expect(authCookieToken(r, ON)).toBe("mine");
  });
});

describe("what a page's loader imports", () => {
  test("sessionOf asks the generated app's own globals, and is null where there are none", async () => {
    const g = globalThis as Record<string, unknown>;
    delete g.__voidbaseHooks;
    // Void's build imports the same module to prerender a page, with no voidbase in the process: null, not a throw
    expect(await sessionOf(req(HTTP, { cookie: `${AUTH_COOKIE}=t` }))).toBeNull();
    let seen: Request | null = null;
    g.__voidbaseHooks = {
      $auth: { cookieName: authCookieName, enabled: () => true, fromCookie: async (r: Request) => { seen = r; return { id: "u1" } as never; } },
    };
    // a separate copy of this module, reaching the instance only through the handoff the generated hook published
    expect((await sessionOf(req(HTTP, { cookie: `${AUTH_COOKIE}=t` })) as unknown as { id: string })?.id).toBe("u1");
    expect(seen).not.toBeNull();
    delete g.__voidbaseHooks;
  });
});

describe("sign-out", () => {
  test("the auth plugin mounts it beside the routes that mint a token", async () => {
    const app = new Hono();
    await load(createKernel(app as never), [auth], "0.9.0");
    const paths = app.routes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain(`POST /api/collections/:collection/${AUTH_CLEAR_PATH}`);
    expect(AUTH_CLEAR_PATH).toBe("auth-clear");
  });
});
