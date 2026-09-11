// The guarded front door of the admin panel: `voidbaseAdapter({ panel: { path, guard: "superuser" } })`.
//
// The adapter writes `_redirects` rules that send the panel's path to `/api/panel` (the asset layer never invokes
// the Worker outside /api), and this is what answers there: the panel's index for a superuser, a 404 for anyone
// else, and a 404 for every URL under it, which is where `hide` sends the old `/_/`.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { d1 } from "../../src/node/d1";
import { newAuthToken } from "../../src/server/auth";
import { insertCollection } from "../../src/server/bootstrap";
import { findCollection, invalidateCollections } from "../../src/server/collections/model";
import { createCollection } from "../../src/server/collections/service";
import { systemCollections } from "../../src/server/collections/system";
import { notFound } from "../../src/server/errors";
import { panelDirectory, panelEntry, panelToken, withBase } from "../../src/server/panel-guard";
import { normalizePanelPath, panelRedirectLines, PANEL_API, PANEL_DEFAULT_PATH } from "../../src/server/panel-paths";
import { ensureSettingsRow, invalidateSettings } from "../../src/server/settings";
import type { AppEnv, AuthRecord } from "../../src/server/types";

const ROOT = resolve(import.meta.dir, "../..");
const INDEX = '<!doctype html>\n<html lang="en">\n<head>\n    <title>PocketBase</title>\n  <script type="module" crossorigin src="./assets/index-abc.js"></script>\n</head>\n<body>\n</body>\n</html>\n';

/** the schema, the system collections, one superuser and one ordinary user, each with a real token */
async function instance() {
  const sqlite = new Database(":memory:");
  for (const file of readdirSync(`${ROOT}/db/migrations`).filter((x) => x.endsWith(".sql")).sort()) {
    for (const s of readFileSync(`${ROOT}/db/migrations/${file}`, "utf8").split("--> statement-breakpoint")) if (s.trim()) sqlite.exec(s);
  }
  const db = d1(sqlite);
  invalidateCollections(); invalidateSettings();
  for (const c of systemCollections()) await insertCollection(db, c);
  await ensureSettingsRow(db);
  sqlite.run("INSERT INTO _superusers (id, password, tokenKey, email) VALUES ('s1', 'hash', 'su-token-key', 'root@example.com')");
  const users = await createCollection(db, { name: "users", type: "auth", fields: [{ name: "name", type: "text" }] });
  sqlite.run("INSERT INTO users (id, password, tokenKey, email, name) VALUES ('u1', 'hash', 'user-token-key', 'u@example.com', 'Una')");
  // the stored collection, not a fresh systemCollections() one: the token is signed with its own authToken secret
  const superusers = (await findCollection(db, "_superusers"))!;
  const suToken = await newAuthToken({ collection: superusers, row: { id: "s1", tokenKey: "su-token-key" } } as unknown as AuthRecord);
  const userToken = await newAuthToken({ collection: users, row: { id: "u1", tokenKey: "user-token-key" } } as unknown as AuthRecord);
  return { db, suToken, userToken };
}

/** the two routes app.ts mounts, over a static layer that holds the panel at /admin/ */
function appOver(db: D1Database) {
  const app = new Hono<AppEnv>();
  app.get(PANEL_API, (c) => panelEntry(c));
  app.get(`${PANEL_API}/*`, (c) => c.json(notFound().toJSON(), 404));
  // the Bun half: the same handler on the path itself, which carries the directory instead of the query
  for (const path of ["/admin", "/admin/", "/admin/index.html"]) app.get(path, (c) => panelEntry(c, "/admin/"));
  const env = {
    DB: db,
    ASSETS: { fetch: async (req: Request) => (new URL(req.url).pathname === "/admin/index.html" ? new Response(INDEX, { status: 200, headers: { "content-type": "text/html" } }) : new Response("not found", { status: 404 })) },
  };
  return (path: string, init?: RequestInit) => app.request(path, init, env as never);
}

describe("the panel's path and its rules", () => {
  test("a path is normalized to one leading and one trailing slash, however it was written", () => {
    expect(normalizePanelPath("/admin")).toBe("/admin/");
    expect(normalizePanelPath("admin/")).toBe("/admin/");
    expect(normalizePanelPath("/ops/panel")).toBe("/ops/panel/");
    expect(normalizePanelPath(PANEL_DEFAULT_PATH)).toBe("/_/");
  });

  test("a path that is the app itself, that walks up, or that is the Worker's own prefix, fails the build", () => {
    expect(() => normalizePanelPath("/")).toThrow(/path of its own/);
    expect(() => normalizePanelPath("/admin/../etc")).toThrow(/".." segment/);
    expect(() => normalizePanelPath("/api/panel")).toThrow(/under \/api/);
    expect(() => normalizePanelPath("/ad min")).toThrow(/not a path segment/);
  });

  test("the guard rules cover the bare path, the directory and its index, and all three carry the directory as `at`", () => {
    expect(panelRedirectLines("/admin/", { guard: true })).toEqual([
      "/admin /api/panel?at=/admin/ 302",
      "/admin/ /api/panel?at=/admin/ 302",
      "/admin/index.html /api/panel?at=/admin/ 302",
    ]);
  });

  test("hide sends every URL under /_/ to the same handler with no `at`, which is the answer-404 case", () => {
    expect(panelRedirectLines("/admin/", { hide: true })).toEqual(["/_ /api/panel 302", "/_/ /api/panel 302", "/_/* /api/panel 302"]);
    expect(panelRedirectLines(PANEL_DEFAULT_PATH, { hide: true })).toEqual([]);
    expect(panelRedirectLines("/admin/", {})).toEqual([]);
  });
});

describe("what the handler reads off a request", () => {
  test("the token comes from the Authorization header, the SDK's pb_auth cookie, a bare cookie, or ?token=", () => {
    const req = (init: RequestInit) => new Request("https://x.test/api/panel?at=/admin/", init);
    expect(panelToken(req({ headers: { authorization: "Bearer abc" } }))).toBe("abc");
    expect(panelToken(req({ headers: { authorization: "abc" } }))).toBe("abc");
    const exported = encodeURIComponent(JSON.stringify({ token: "cookie-token", record: { id: "s1" } }));
    expect(panelToken(req({ headers: { cookie: `other=1; pb_auth=${exported}` } }))).toBe("cookie-token");
    expect(panelToken(req({ headers: { cookie: "pb_auth=bare-token" } }))).toBe("bare-token");
    expect(panelToken(new Request("https://x.test/api/panel?at=/admin/&token=q"))).toBe("q");
    expect(panelToken(new Request("https://x.test/api/panel"))).toBe("");
  });

  test("`at` is a directory of this origin or nothing: no host, no scheme, no walk up, not /api", () => {
    expect(panelDirectory("/admin/")).toBe("/admin/");
    expect(panelDirectory("/_/")).toBe("/_/");
    for (const bad of ["", "/admin", "//evil.example/", "https://evil.example/", "/admin/../../", "/api/files/", "/admin/?x=1", "\\admin\\"]) expect(panelDirectory(bad)).toBe("");
  });

  test("the index gets a <base> so its relative asset URLs resolve against the panel's own directory", () => {
    expect(withBase(INDEX, "/admin/")).toContain('<head><base href="/admin/">');
    expect(withBase('<base href="/x/">', "/admin/")).toBe('<base href="/x/">');
  });
});

describe("GET /api/panel", () => {
  test("a superuser session gets the panel's index, rebased and uncacheable; the same request without one gets 404", async () => {
    const { db, suToken } = await instance();
    const request = appOver(db);

    const open = await request("/api/panel?at=/admin/");
    expect(open.status).toBe(404);
    expect((await open.json() as { message: string }).message).toBe("The requested resource wasn't found.");

    const allowed = await request("/api/panel?at=/admin/", { headers: { authorization: `Bearer ${suToken}` } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-type")).toContain("text/html");
    expect(allowed.headers.get("cache-control")).toBe("private, no-store");
    const html = await allowed.text();
    expect(html).toContain('<base href="/admin/">');
    expect(html).toContain("./assets/index-abc.js");
  });

  test("the same session in the cookie the SDK exports, and in ?token=, is the same answer", async () => {
    const { db, suToken } = await instance();
    const request = appOver(db);
    const cookie = `pb_auth=${encodeURIComponent(JSON.stringify({ token: suToken, record: { id: "s1" } }))}`;
    expect((await request("/api/panel?at=/admin/", { headers: { cookie } })).status).toBe(200);
    expect((await request(`/api/panel?at=/admin/&token=${encodeURIComponent(suToken)}`)).status).toBe(200);
  });

  test("anything that is not a superuser is told the path does not exist: a user's token, a forged one, no token", async () => {
    const { db, userToken, suToken } = await instance();
    const request = appOver(db);
    expect((await request("/api/panel?at=/admin/", { headers: { authorization: `Bearer ${userToken}` } })).status).toBe(404);
    expect((await request("/api/panel?at=/admin/", { headers: { authorization: `Bearer ${suToken}x` } })).status).toBe(404);
    expect((await request("/api/panel?at=/admin/", { headers: { authorization: "Bearer not-a-jwt" } })).status).toBe(404);
    expect((await request("/api/panel?at=/admin/", { headers: { cookie: "pb_auth=nonsense" } })).status).toBe(404);
  });

  test("a superuser is refused an `at` that is not a directory of this origin, and a path the static layer does not hold", async () => {
    const { db, suToken } = await instance();
    const request = appOver(db);
    const su = { headers: { authorization: `Bearer ${suToken}` } };
    expect((await request("/api/panel?at=https://evil.example/", su)).status).toBe(404);
    expect((await request("/api/panel?at=/nowhere/", su)).status).toBe(404);
  });

  test("on Bun the same handler is mounted on the path, which passes the directory in: the answer is the same", async () => {
    const { db, suToken, userToken } = await instance();
    const request = appOver(db);
    const su = { headers: { authorization: `Bearer ${suToken}` } };
    for (const path of ["/admin", "/admin/", "/admin/index.html"]) {
      expect((await request(path)).status).toBe(404);
      expect((await request(path, { headers: { authorization: `Bearer ${userToken}` } })).status).toBe(404);
      const allowed = await request(path, su);
      expect(allowed.status).toBe(200);
      expect(await allowed.text()).toContain('<base href="/admin/">');
    }
  });

  test("with no `at` -- where hide sends /_/ -- and under /api/panel, a superuser gets 404 too", async () => {
    const { db, suToken } = await instance();
    const request = appOver(db);
    const su = { headers: { authorization: `Bearer ${suToken}` } };
    expect((await request("/api/panel", su)).status).toBe(404);
    expect((await request("/api/panel/none", su)).status).toBe(404);
    expect((await request("/api/panel/anything/at/all", su)).status).toBe(404);
  });
});
