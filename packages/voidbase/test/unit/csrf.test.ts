// The double-submit CSRF token (src/server/csrf.ts), measured through the same two places it lives in: the route
// the hardening plugin mounts (GET /api/csrf) and the response policy slot every request passes through.
//
// What is asserted is the whole rule: off by default and the route 404s; on, the cookie's name, attributes and
// scheme; the header matching the cookie passes; a missing, mismatched or absent-cookie request is refused 403
// naming the header; a request carrying an Authorization header is never subject to it; and asking twice rotates
// the token so the older one stops matching.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  cookieValue, csrfSetCookie, CSRF_COOKIE, CSRF_COOKIE_SECURE, CSRF_HEADER, newCsrfToken, timingSafeEqual,
} from "../../src/server/csrf";
import { ApiError, notFound } from "../../src/server/errors";
import type { Hardening } from "../../src/server/interfaces";
import { createKernel, load, using, type Kernel } from "../../src/server/kernel";
import { hardening } from "../../src/server/plugins/hardening";
import type { AppEnv } from "../../src/server/types";

const ON = { VOIDBASE_CSRF: "double-submit" };
const HTTPS = "https://voidbase.example";

// app.ts's shape: the policy slot is registered first, the plugins load afterwards and mount onto the same app,
// so a route a plugin mounts still leaves through the policy
async function appWith(plugins = [hardening]): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>();
  const kernel: Kernel = createKernel(app as never);
  app.use("*", (c, next) => using<Hardening | undefined>(kernel, "hardening@1")?.responsePolicy(c, next) ?? next());
  app.post("/api/collections/posts/records", (c) => c.json({ id: "1" }));
  app.patch("/api/collections/posts/records/1", (c) => c.json({ id: "1" }));
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.onError((err, c) => (err instanceof ApiError ? err.response() : c.json({ message: String(err) }, 500)));
  app.notFound((c) => c.json(notFound().toJSON(), 404));
  await load(kernel, plugins, "0.9.0");
  return app;
}
const req = (app: Hono<AppEnv>, method: string, path: string, env: Record<string, string> = {}, headers: Record<string, string> = {}, base = "http://voidbase.local") =>
  app.request(`${base}${path}`, { method, headers }, env);
const token = async (res: Response) => ((await res.json()) as { token: string }).token;
const setCookie = (res: Response) => res.headers.get("set-cookie") ?? "";

describe("GET /api/csrf: the token and its cookie", () => {
  test("off by default: the route is not there, and no request is ever refused for want of a token", async () => {
    const app = await appWith();
    expect((await req(app, "GET", "/api/csrf")).status).toBe(404);
    expect((await req(app, "POST", "/api/collections/posts/records", {}, { cookie: "session=abc" })).status).toBe(200);
  });

  test("on, it answers a 32-byte base64url token and a cookie holding the same value", async () => {
    const res = await req(await appWith(), "GET", "/api/csrf", ON);
    expect(res.status).toBe(200);
    const t = await token(res);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url, unpadded
    expect(Uint8Array.from(atob(t.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)).length).toBe(32);
    expect(cookieValue(setCookie(res), CSRF_COOKIE)).toBe(t);
  });

  test("the cookie's attributes: __Host- and Secure on https, plain on http, SameSite=Lax, Path=/, readable", async () => {
    const app = await appWith();
    const secure = setCookie(await req(app, "GET", "/api/csrf", ON, {}, HTTPS));
    expect(secure).toContain(`${CSRF_COOKIE_SECURE}=`);
    expect(secure).toContain("; Secure");
    expect(secure).toContain("; Path=/");
    expect(secure).toContain("; SameSite=Lax");
    expect(secure.toLowerCase()).not.toContain("httponly"); // the page has to read it to send it back
    const plain = setCookie(await req(app, "GET", "/api/csrf", ON));
    expect(plain).toContain(`${CSRF_COOKIE}=`);
    expect(plain).not.toContain("Secure");
    expect(csrfSetCookie("t", false)).toBe(`${CSRF_COOKIE}=t; Path=/; SameSite=Lax`);
    expect(csrfSetCookie("t", true)).toBe(`${CSRF_COOKIE_SECURE}=t; Path=/; SameSite=Lax; Secure`);
  });

  test("asking again rotates it: a new token, a new cookie, and the old token stops matching", async () => {
    const app = await appWith();
    const first = await req(app, "GET", "/api/csrf", ON);
    const second = await req(app, "GET", "/api/csrf", ON);
    const a = await token(first), b = await token(second);
    expect(a).not.toBe(b);
    const held = cookieValue(setCookie(second), CSRF_COOKIE);
    expect(held).toBe(b);
    const stale = await req(app, "POST", "/api/collections/posts/records", ON, { cookie: `session=s; ${CSRF_COOKIE}=${held}`, [CSRF_HEADER]: a });
    expect(stale.status).toBe(403);
    const fresh = await req(app, "POST", "/api/collections/posts/records", ON, { cookie: `session=s; ${CSRF_COOKIE}=${held}`, [CSRF_HEADER]: b });
    expect(fresh.status).toBe(200);
  });
});

describe("the rule on a state-changing request", () => {
  test("the header matching the cookie passes, on any state-changing method", async () => {
    const app = await appWith();
    const t = await token(await req(app, "GET", "/api/csrf", ON));
    const cookie = `session=s; ${CSRF_COOKIE}=${t}`;
    expect((await req(app, "POST", "/api/collections/posts/records", ON, { cookie, [CSRF_HEADER]: t })).status).toBe(200);
    expect((await req(app, "PATCH", "/api/collections/posts/records/1", ON, { cookie, [CSRF_HEADER]: t })).status).toBe(200);
  });

  test("a mismatch is refused 403 with a reason naming the header", async () => {
    const app = await appWith();
    const t = await token(await req(app, "GET", "/api/csrf", ON));
    const res = await req(app, "POST", "/api/collections/posts/records", ON, { cookie: `${CSRF_COOKIE}=${t}`, [CSRF_HEADER]: newCsrfToken() });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain(CSRF_HEADER);
    expect(body.message).toContain(CSRF_COOKIE);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff"); // the refusal leaves through the policy too
  });

  test("a missing header, and cookies with no token cookie at all, are both refused naming the header", async () => {
    const app = await appWith();
    const t = await token(await req(app, "GET", "/api/csrf", ON));
    const missing = await req(app, "POST", "/api/collections/posts/records", ON, { cookie: `${CSRF_COOKIE}=${t}` });
    expect(missing.status).toBe(403);
    expect(((await missing.json()) as { message: string }).message).toContain(CSRF_HEADER);
    const never = await req(app, "POST", "/api/collections/posts/records", ON, { cookie: "session=s" });
    expect(never.status).toBe(403);
    expect(((await never.json()) as { message: string }).message).toContain("/api/csrf");
  });

  test("a bearer request is exempt, which is what the SDK sends, and so is a GET and a request with no cookie", async () => {
    const app = await appWith();
    const bearer = { cookie: "session=s", authorization: "Bearer whatever" };
    expect((await req(app, "POST", "/api/collections/posts/records", ON, bearer)).status).toBe(200);
    expect((await req(app, "GET", "/api/health", ON, { cookie: "session=s" })).status).toBe(200);
    expect((await req(app, "POST", "/api/collections/posts/records", ON, {})).status).toBe(200);
  });

  test("the two CSRF rules are independent: the origin rule still refuses first when both are on", async () => {
    const app = await appWith();
    const env = { ...ON, VOIDBASE_CORS_ORIGINS: "https://app.example" };
    const t = await token(await req(app, "GET", "/api/csrf", env));
    const res = await req(app, "POST", "/api/collections/posts/records", env, { cookie: `${CSRF_COOKIE}=${t}`, [CSRF_HEADER]: t, origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toContain("VOIDBASE_CORS_ORIGINS");
  });

  test("without the plugin there is no route and no rule, as with the rest of the policy", async () => {
    const app = await appWith([]);
    expect((await req(app, "GET", "/api/csrf", ON)).status).toBe(404);
    expect((await req(app, "POST", "/api/collections/posts/records", ON, { cookie: "session=s" })).status).toBe(200);
  });
});

describe("the compare, and reading one cookie out of a header", () => {
  test("timingSafeEqual is equality, and never true for an empty or differently sized value", () => {
    const t = newCsrfToken();
    expect(timingSafeEqual(t, t)).toBe(true);
    expect(timingSafeEqual(t, newCsrfToken())).toBe(false);
    expect(timingSafeEqual(t, t.slice(0, -1))).toBe(false);
    expect(timingSafeEqual(t, t + "x")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(false);
    expect(timingSafeEqual("", t)).toBe(false);
  });

  test("cookieValue takes the named one and nothing that merely ends with the name", () => {
    const header = `other=1; ${CSRF_COOKIE}=abc; another_vb_csrf=nope`;
    expect(cookieValue(header, CSRF_COOKIE)).toBe("abc");
    expect(cookieValue(header, CSRF_COOKIE_SECURE)).toBe("");
    expect(cookieValue("", CSRF_COOKIE)).toBe("");
  });
});
