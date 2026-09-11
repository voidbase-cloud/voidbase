// The response policy hardening@1 provides, measured through the slot app.ts registers first in the chain: nothing
// set is today's headers (origin *, the four security headers, the strict policy on a served file); each knob
// its header; a named origin list that echoes and withholds; HSTS on https only; the per-route
// Content-Security-Policy and the order it is decided in (routes, then files, then the global one); and the CSRF
// refusal that the named list turns on for a cookie-carrying request from elsewhere.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ApiError, notFound } from "../../src/server/errors";
import type { Hardening } from "../../src/server/interfaces";
import { createKernel, load, using, type Kernel } from "../../src/server/kernel";
import { hardening } from "../../src/server/plugins/hardening";
import { cspForPath, FILE_CSP, parseCspRoutes } from "../../src/server/response-policy";
import type { AppEnv } from "../../src/server/types";

const STRICT = "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox";

async function kernelWith(plugins = [hardening]): Promise<Kernel> {
  const kernel = createKernel(new Hono() as never);
  await load(kernel, plugins, "0.9.0");
  return kernel;
}

// the slot as app.ts registers it, over a small app with an ordinary route, a file route marked the way app.ts marks
// it, a throwing route and the app's own error and not-found shapes
function appOver(kernel: Kernel) {
  const app = new Hono<AppEnv>();
  const hardened = () => using<Hardening | undefined>(kernel, "hardening@1");
  app.use("*", (c, next) => hardened()?.responsePolicy(c, next) ?? next());
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.post("/api/collections/posts/records", (c) => c.json({ id: "1" }));
  app.get("/api/files/posts/1/a.png", (c) => {
    c.set("file", true);
    return new Response("png", { headers: { "Content-Type": "image/png", "Vary": "Origin" } });
  });
  app.get("/api/backups/x.zip", () => new Response("zip", { headers: { "Content-Security-Policy": "default-src 'none'" } }));
  app.get("/boom", () => { throw new Error("boom"); });
  app.onError((err, c) => (err instanceof ApiError ? err.response() : c.json({ message: "Something went wrong while processing your request." }, 500)));
  app.notFound((c) => c.json(notFound().toJSON(), 404));
  return app;
}

const get = (app: Hono<AppEnv>, path: string, env: Record<string, string> = {}, headers: Record<string, string> = {}, base = "http://voidbase.local") => app.request(`${base}${path}`, { headers }, env);
const post = (app: Hono<AppEnv>, path: string, env: Record<string, string> = {}, headers: Record<string, string> = {}) => app.request(`http://voidbase.local${path}`, { method: "POST", headers }, env);

describe("the defaults: nothing set is today's behaviour", () => {
  test("an ordinary response carries the four headers and origin *, and no CSP", async () => {
    const app = appOver(await kernelWith());
    const res = await get(app, "/api/health", {}, { origin: "https://anywhere.example" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(res.headers.get("X-Xss-Protection")).toBe("1; mode=block");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Vary")).toBeNull();
    for (const h of ["Content-Security-Policy", "Strict-Transport-Security", "Referrer-Policy", "Permissions-Policy", "Cross-Origin-Embedder-Policy", "Cross-Origin-Resource-Policy"]) expect(res.headers.get(h)).toBeNull();
  });

  test("a served file carries the strict policy, which is the one app.ts used to set", async () => {
    expect(FILE_CSP).toBe(STRICT);
    const res = await get(appOver(await kernelWith()), "/api/files/posts/1/a.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe(STRICT);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  test("errors, not-founds and preflights get the headers too, since the slot is first in the chain", async () => {
    const app = appOver(await kernelWith());
    const boom = await get(app, "/boom");
    expect(boom.status).toBe(500);
    expect(boom.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(boom.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const missing = await get(app, "/nowhere");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    const preflight = await app.request("http://voidbase.local/api/health", { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST" } }, {});
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toBe("Authorization,Content-Type");
    expect(preflight.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("without the plugin the slot passes through: no policy, no CORS", async () => {
    const res = await get(appOver(await kernelWith([])), "/api/health", {}, { origin: "https://anywhere.example" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("policy() reads the knobs from an env and answers the defaults for an empty one", async () => {
    const provided = using<Hardening>(await kernelWith(), "hardening@1");
    expect(provided.policy({})).toEqual({ corsOrigins: "*", hstsMaxAge: 0, referrerPolicy: "", permissionsPolicy: "", csp: "", cspFiles: STRICT, cspRoutes: [], csrf: "off", crossOrigin: false });
    expect(provided.policy({ VOIDBASE_CORS_ORIGINS: "https://App.Example/, https://b.example", VOIDBASE_HSTS: "true" }).corsOrigins).toEqual(["https://app.example", "https://b.example"]);
    expect(provided.policy({ VOIDBASE_HSTS: "1" }).hstsMaxAge).toBe(31536000);
    expect(provided.policy({ VOIDBASE_HSTS: "600" }).hstsMaxAge).toBe(600);
    expect(provided.policy({ VOIDBASE_HSTS: "0" }).hstsMaxAge).toBe(0);
    expect(provided.policy({ VOIDBASE_CORS_ORIGINS: "*" }).corsOrigins).toBe("*");
  });
});

describe("each knob produces its header", () => {
  test("VOIDBASE_REFERRER_POLICY and VOIDBASE_PERMISSIONS_POLICY are set as given", async () => {
    const res = await get(appOver(await kernelWith()), "/api/health", { VOIDBASE_REFERRER_POLICY: "strict-origin-when-cross-origin", VOIDBASE_PERMISSIONS_POLICY: "camera=(), geolocation=()" });
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("Permissions-Policy")).toBe("camera=(), geolocation=()");
  });

  test("VOIDBASE_CROSS_ORIGIN adds the embedder and resource policies beside the opener policy", async () => {
    const res = await get(appOver(await kernelWith()), "/api/health", { VOIDBASE_CROSS_ORIGIN: "1" });
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(res.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });

  test("VOIDBASE_CSP applies to every non-file response and leaves a route's own policy alone", async () => {
    const app = appOver(await kernelWith());
    const env = { VOIDBASE_CSP: "default-src 'self'" };
    expect((await get(app, "/api/health", env)).headers.get("Content-Security-Policy")).toBe("default-src 'self'");
    expect((await get(app, "/nowhere", env)).headers.get("Content-Security-Policy")).toBe("default-src 'self'");
    expect((await get(app, "/api/files/posts/1/a.png", env)).headers.get("Content-Security-Policy")).toBe(STRICT);
    expect((await get(app, "/api/backups/x.zip", env)).headers.get("Content-Security-Policy")).toBe("default-src 'none'");
  });

  test("VOIDBASE_CSP_FILES replaces the files' policy and nothing else", async () => {
    const app = appOver(await kernelWith());
    const env = { VOIDBASE_CSP_FILES: "default-src 'none'; img-src 'self'" };
    expect((await get(app, "/api/files/posts/1/a.png", env)).headers.get("Content-Security-Policy")).toBe("default-src 'none'; img-src 'self'");
    expect((await get(app, "/api/health", env)).headers.get("Content-Security-Policy")).toBeNull();
  });

  test("VOIDBASE_HSTS answers on https only, one year for 1/true and the seconds given otherwise", async () => {
    const app = appOver(await kernelWith());
    const https = "https://voidbase.example";
    expect((await get(app, "/api/health", { VOIDBASE_HSTS: "1" }, {}, https)).headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
    expect((await get(app, "/api/health", { VOIDBASE_HSTS: "true" }, {}, https)).headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
    expect((await get(app, "/api/health", { VOIDBASE_HSTS: "86400" }, {}, https)).headers.get("Strict-Transport-Security")).toBe("max-age=86400; includeSubDomains");
    expect((await get(app, "/api/health", { VOIDBASE_HSTS: "1" })).headers.get("Strict-Transport-Security")).toBeNull();
    expect((await get(app, "/api/health", {}, {}, https)).headers.get("Strict-Transport-Security")).toBeNull();
  });
});

describe("VOIDBASE_CSP_ROUTES: a policy per route, first match wins", () => {
  test("the grammar: `;` between entries, `\\;` a literal one inside a policy, the first `:` splitting an entry", () => {
    expect(parseCspRoutes("/admin/*:default-src 'self'")).toEqual([{ glob: "/admin/*", policy: "default-src 'self'" }]);
    expect(parseCspRoutes("/a/*:default-src 'none'\\; sandbox;/b/*:default-src 'self'")).toEqual([
      { glob: "/a/*", policy: "default-src 'none'; sandbox" },
      { glob: "/b/*", policy: "default-src 'self'" },
    ]);
    // an entry with no policy, no glob or nothing at all is dropped rather than half-applied
    expect(parseCspRoutes("  /a/*:x  ;  ; /b/* ; :y ;/c:  ")).toEqual([{ glob: "/a/*", policy: "x" }]);
    expect(parseCspRoutes("")).toEqual([]);
  });

  test("the glob is matched the way the hook router matches a path: segments, `*` for the rest", () => {
    const routes = parseCspRoutes("/api/collections/*/records:a;/api/files/*:b;/api/health:c");
    expect(cspForPath(routes, "/api/collections/posts/records")).toBe("a");
    expect(cspForPath(routes, "/api/files/posts/1/x.png")).toBe("b");
    expect(cspForPath(routes, "/api/health")).toBe("c");
    expect(cspForPath(routes, "/api/health/")).toBe("c"); // a trailing slash is optional, as in the hook router
    expect(cspForPath(routes, "/api/collections")).toBe("");
  });

  test("first match wins, and a path no glob names falls through to VOIDBASE_CSP", async () => {
    const app = appOver(await kernelWith());
    const env = { VOIDBASE_CSP_ROUTES: "/api/health:default-src 'self'\\; frame-ancestors 'none';/api/*:default-src 'none'", VOIDBASE_CSP: "default-src 'self'" };
    expect((await get(app, "/api/health", env)).headers.get("Content-Security-Policy")).toBe("default-src 'self'; frame-ancestors 'none'");
    expect((await post(app, "/api/collections/posts/records", env)).headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    expect((await get(app, "/nowhere", env)).headers.get("Content-Security-Policy")).toBe("default-src 'self'"); // no match: the global one
  });

  test("no match and no VOIDBASE_CSP is no policy at all, as with neither knob set", async () => {
    const app = appOver(await kernelWith());
    const env = { VOIDBASE_CSP_ROUTES: "/admin/*:default-src 'self'" };
    expect((await get(app, "/api/health", env)).headers.get("Content-Security-Policy")).toBeNull();
  });

  test("the order is routes, then files, then the global one", async () => {
    const app = appOver(await kernelWith());
    const file = "/api/files/posts/1/a.png";
    // no route names the file: the files' policy, as before
    expect((await get(app, file, { VOIDBASE_CSP: "default-src 'self'" })).headers.get("Content-Security-Policy")).toBe(STRICT);
    // a route that names it outranks the files' policy, because naming it was the operator's decision
    const named = { VOIDBASE_CSP_ROUTES: "/api/files/*:default-src 'none'\\; img-src 'self'", VOIDBASE_CSP_FILES: STRICT, VOIDBASE_CSP: "default-src 'self'" };
    expect((await get(app, file, named)).headers.get("Content-Security-Policy")).toBe("default-src 'none'; img-src 'self'");
    // and over a policy the route set for itself, which the global one still yields to
    expect((await get(app, "/api/backups/x.zip", { VOIDBASE_CSP_ROUTES: "/api/backups/*:default-src 'self'" })).headers.get("Content-Security-Policy")).toBe("default-src 'self'");
    expect((await get(app, "/api/backups/x.zip", { VOIDBASE_CSP: "default-src 'self'" })).headers.get("Content-Security-Policy")).toBe("default-src 'none'");
  });
});

describe("VOIDBASE_CORS_ORIGINS as a named list", () => {
  const env = { VOIDBASE_CORS_ORIGINS: "https://app.example, https://admin.example" };

  test("a listed origin is echoed with Vary: Origin; another gets no CORS headers", async () => {
    const app = appOver(await kernelWith());
    const listed = await get(app, "/api/health", env, { origin: "https://app.example" });
    expect(listed.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");
    expect(listed.headers.get("Vary")).toBe("Origin");
    const other = await get(app, "/api/health", env, { origin: "https://evil.example" });
    expect(other.status).toBe(200);
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const none = await get(app, "/api/health", env);
    expect(none.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(none.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("a preflight from a listed origin is answered for that origin, from another without one", async () => {
    const app = appOver(await kernelWith());
    const ok = await app.request("http://voidbase.local/api/collections/posts/records", { method: "OPTIONS", headers: { origin: "https://admin.example", "access-control-request-method": "POST" } }, env);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://admin.example");
    const no = await app.request("http://voidbase.local/api/collections/posts/records", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } }, env);
    expect(no.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("the CSRF rule: named origins, a cookie, a state-changing request from elsewhere", () => {
  const env = { VOIDBASE_CORS_ORIGINS: "https://app.example" };

  test("refused with 403 naming Origin when the cookie comes from an origin that is not named", async () => {
    const res = await post(appOver(await kernelWith()), "/api/collections/posts/records", env, { cookie: "session=abc", origin: "https://evil.example" });
    expect(res.status).toBe(403);
    const body = await res.json() as { message: string };
    expect(body.message).toContain("Origin");
    expect(body.message).toContain("VOIDBASE_CORS_ORIGINS");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff"); // the refusal leaves through the policy too
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("refused on Sec-Fetch-Site cross-site when there is no Origin to match", async () => {
    const res = await post(appOver(await kernelWith()), "/api/collections/posts/records", env, { cookie: "session=abc", "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect((await res.json() as { message: string }).message).toContain("Sec-Fetch-Site");
  });

  test("not refused: a listed origin, the instance's own origin, same-origin, or no cookie at all", async () => {
    const app = appOver(await kernelWith());
    expect((await post(app, "/api/collections/posts/records", env, { cookie: "session=abc", origin: "https://app.example" })).status).toBe(200);
    expect((await post(app, "/api/collections/posts/records", env, { cookie: "session=abc", origin: "http://voidbase.local" })).status).toBe(200);
    expect((await post(app, "/api/collections/posts/records", env, { cookie: "session=abc", "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await post(app, "/api/collections/posts/records", env, { cookie: "session=abc" })).status).toBe(200);
    expect((await post(app, "/api/collections/posts/records", env, { origin: "https://evil.example", authorization: "Bearer x" })).status).toBe(200);
  });

  test("never a factor while the origin is *, and never on a GET", async () => {
    const app = appOver(await kernelWith());
    expect((await post(app, "/api/collections/posts/records", {}, { cookie: "session=abc", origin: "https://evil.example" })).status).toBe(200);
    expect((await get(app, "/api/health", env, { cookie: "session=abc", origin: "https://evil.example" })).status).toBe(200);
  });
});
