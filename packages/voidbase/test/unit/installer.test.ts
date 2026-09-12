// The installer core plugin: the three places an instance's plugins can live, what a change does in each, and which
// marketplaces a request may name.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { addPlugin, listPlugins, removePlugin, updatePlugins } from "../../src/node/installed";
import { provideAuthLookup } from "../../src/server/auth-slot";
import { ApiError } from "../../src/server/errors";
import { installerInfo, type FilesystemInstaller } from "../../src/server/installer-info";
import { createKernel, load, whatLoaded } from "../../src/server/kernel";
import { auth, provider } from "../../src/server/plugins/auth";
import { installer } from "../../src/server/plugins/installer";
import type { Plugin } from "../../src/server/plugins/manifest";
import { emptyLock, lockText } from "../../src/server/project-sync";
import type { AppEnv, AuthRecord, Bindings } from "../../src/server/types";

// a marketplace: one plugin, two versions. `from` is whose build of echo a marketplace serves, so a test can tell two apart by their bytes
const echo = (v: string, from = "echo") => `const manifest = { name: "echo", version: "${v}", tier: "community", voidbase: "*" };\nexport default { manifest, apply(ctx) { ctx.app.get("/api/echo", (c) => c.text("${from} ${v}")); } };\n`;
const integrityOf = async (t: string) => `sha256-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))))}`;
const record = async (v: string, from = "echo") => ({ version: v, manifest: { name: "echo", version: v, tier: "community", voidbase: "*" }, integrity: await integrityOf(echo(v, from)), bundle: `plugins/echo/${v}/bundle.js`, bytes: echo(v, from).length, source: { repository: "example/voidbase-plugin-echo", commit: "0123456789abcdef0123456789abcdef01234567" }, publishedOn: "2026-09-10" });
// every request a marketplace answered, as "<from> <path>": how a test says a marketplace was never asked
const asked: string[] = [];
const marketplace = async (from: string, latestOf: () => string) => { const records = { "0.1.0": await record("0.1.0", from), "0.2.0": await record("0.2.0", from) }; return Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { const p = new URL(req.url).pathname; asked.push(`${from} ${p}`); if (p === "/registry/v1/index.json") { const latest = latestOf(); return Response.json({ schemaVersion: 1, marketplace: { name: from, url: "http://t" }, generatedOn: "2026-09-10", plugins: [{ name: "echo", repository: "example/voidbase-plugin-echo", title: "Echo", summary: "x", latest, versions: latest === "0.2.0" ? [records["0.2.0"], records["0.1.0"]] : [records["0.1.0"]] }], templates: [] }); } const m = p.match(/^\/registry\/v1\/plugins\/echo\/([\d.]+)\/bundle\.js$/); if (m) return new Response(echo(m[1]!, from)); return new Response("no", { status: 404 }); } }); };
// MARKET is the marketplace the fixture lockfiles list; OTHER is a working one that none of them lists, serving an echo of its own
let market: ReturnType<typeof Bun.serve>; let MARKET = ""; let latest = "0.1.0";
let other: ReturnType<typeof Bun.serve>; let OTHER = "";
// a GitHub with the Git Data API, one repository, files in a map
const files = new Map<string, string>(); const blobs = new Map<string, string>(); const trees = new Map<string, { path: string; sha: string | null }[]>(); const commits = new Map<string, { tree: string; parents: string[]; message: string; changes: Record<string, string | null> }>();
let head = "seed0000"; const sha = () => crypto.randomUUID().replace(/-/g, "");
let gh: ReturnType<typeof Bun.serve>; let GH = "";
// every request GitHub answered, as "<method> <path in the repository>": a refused change is a lock read and nothing else
const ghCalls: string[] = [];
const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t))); const fromB64 = (b: string) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
/** fn with nothing past this machine reachable: any host but 127.0.0.1 answers 404, so a test never asks the official marketplace or a lookalike's host */
const offline = async <T>(fn: () => Promise<T>): Promise<T> => { const real = globalThis.fetch; globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).hostname === "127.0.0.1" ? real(input, init) : Promise.resolve(new Response("not from a test", { status: 404 }))) as typeof fetch; try { return await fn(); } finally { globalThis.fetch = real; } };

beforeAll(async () => {
  market = await marketplace("echo", () => latest); MARKET = `http://127.0.0.1:${market.port}`;
  other = await marketplace("other", () => "0.2.0"); OTHER = `http://127.0.0.1:${other.port}`;
  // the project's lockfile lists MARKET and nothing else
  files.set("voidbase.lock", lockText({ ...emptyLock(), marketplaces: [MARKET] }));
  commits.set(head, { tree: "tree0", parents: [], message: "seed", changes: {} });
  gh = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const p = new URL(req.url).pathname; const path = p.replace(/^\/repos\/acme\/shop/, ""); ghCalls.push(`${req.method} ${path}`);
    if (path.startsWith("/git/ref/heads/")) return Response.json({ object: { sha: head } });
    if (path.startsWith("/git/refs/heads/") && req.method === "PATCH") { const b = (await req.json()) as { sha: string }; const c = commits.get(b.sha)!; head = b.sha; for (const [k, v] of Object.entries(c.changes)) { if (v === null) files.delete(k); else files.set(k, v); } return Response.json({ object: { sha: head } }); }
    if (path.startsWith("/git/commits/") && req.method === "GET") { const c = commits.get(path.slice("/git/commits/".length))!; return Response.json({ sha: head, tree: { sha: c.tree } }); }
    if (path === "/git/commits" && req.method === "POST") { const b = (await req.json()) as { message: string; tree: string; parents: string[] }; const id = sha(); const changes: Record<string, string | null> = {}; for (const e of trees.get(b.tree)!) changes[e.path] = e.sha === null ? null : blobs.get(e.sha)!; commits.set(id, { tree: b.tree, parents: b.parents, message: b.message, changes }); return Response.json({ sha: id, html_url: `https://github.example/acme/shop/commit/${id}` }, { status: 201 }); }
    if (path === "/git/blobs" && req.method === "POST") { const b = (await req.json()) as { content: string; encoding: string }; const id = sha(); blobs.set(id, b.encoding === "base64" ? fromB64(b.content) : b.content); return Response.json({ sha: id }, { status: 201 }); }
    if (path === "/git/trees" && req.method === "POST") { const b = (await req.json()) as { tree: { path: string; sha: string | null }[] }; const id = sha(); trees.set(id, b.tree); return Response.json({ sha: id }, { status: 201 }); }
    if (path.startsWith("/contents/")) { const f = decodeURIComponent(path.slice("/contents/".length).split("?")[0]!); if (files.has(f)) return Response.json({ type: "file", path: f, encoding: "base64", content: b64(files.get(f)!) }); const inDir = [...files.keys()].filter((k) => k.startsWith(f + "/")); if (inDir.length) return Response.json(inDir.map((k) => ({ type: "file", path: k }))); return Response.json({ message: "Not Found" }, { status: 404 }); }
    return Response.json({ message: `no route ${req.method} ${p}` }, { status: 404 });
  } });
  GH = `http://127.0.0.1:${gh.port}`;
});
afterAll(() => { market.stop(true); other.stop(true); gh.stop(true); });

const superuser = { collection: { name: "_superusers" }, row: { id: "s1" } } as unknown as AuthRecord;
async function appWith(env: Partial<Bindings>, filesystem: FilesystemInstaller | null, extra: Plugin[] = []) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("auth", superuser); await next(); });
  app.onError((err, c) => (err instanceof ApiError ? c.json({ message: err.message }, err.status as 400) : c.json({ message: String(err) }, 500)));
  const kernel = createKernel(app);
  // the graph the removal check reads is what this instance loaded, asked at request time, the way app.ts passes it
  await load(kernel, [auth, installer("0.9.0", filesystem, () => whatLoaded(kernel).plugins), ...extra], "0.9.0");
  provideAuthLookup(() => provider);
  const call = async (method: string, path: string, body?: unknown) => { const r = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env as Bindings); return { status: r.status, json: (await r.json()) as any }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { call };
}

describe("the installer says where an instance's plugins live", () => {
  test("fixed: a Worker with no repository; a change says what to connect", async () => {
    expect(installerInfo({} as Bindings, null).mode).toBe("fixed");
    const { call } = await appWith({}, null);
    const r = await call("POST", "/api/plugins/install", { name: "echo", marketplace: MARKET });
    expect(r.status).toBe(400); expect(r.json.message).toMatch(/VOIDBASE_PROJECT_REPO/);
  });
  test("repository: VOIDBASE_PROJECT_REPO and a token", () => {
    expect(installerInfo({ VOIDBASE_PROJECT_REPO: "Acme/Shop", VOIDBASE_GH_TOKEN: "t" } as Bindings, null)).toEqual({ mode: "repository", repository: "acme/shop", branch: "master" });
  });
  test("filesystem: Bun with a project on disk", () => {
    expect(installerInfo({} as Bindings, { root: "/x" } as FilesystemInstaller).mode).toBe("filesystem");
  });
});

describe("a project instance: a change is one commit to its repository", () => {
  const env = { VOIDBASE_PROJECT_REPO: "acme/shop", VOIDBASE_GH_TOKEN: "gh-test", GITHUB_API_BASE: "" } as Partial<Bindings> & { GITHUB_API_BASE: string };
  test("install: the bundle is downloaded and verified here, the files and the lock entry land in one commit", async () => {
    env.GITHUB_API_BASE = GH;
    const { call } = await appWith(env, null);
    const r = await call("POST", "/api/plugins/install", { name: "echo", marketplace: MARKET });
    expect(r.status).toBe(200); expect(r.json.applied).toBe("repository"); expect(r.json.committed.repository).toBe("acme/shop"); expect(r.json.added).toEqual([{ name: "echo", version: "0.1.0", marketplace: MARKET }]);
    expect(files.get("pb_plugins/echo/bundle.js")).toBe(echo("0.1.0"));
    const lock = JSON.parse(files.get("voidbase.lock")!); expect(lock.plugins.echo.version).toBe("0.1.0"); expect(lock.plugins.echo.marketplace).toBe(MARKET);
    expect(commits.get(head)!.message).toBe("plugins: add echo 0.1.0");
  });
  test("install again at the same version: nothing to commit", async () => {
    const { call } = await appWith(env, null); const before = head;
    const r = await call("POST", "/api/plugins/install", { name: "echo", marketplace: MARKET });
    expect(r.status).toBe(200); expect(r.json.unchanged).toBe(true); expect(head).toBe(before);
  });
  test("update: a newer version on the plugin's own marketplace becomes the next commit; nothing newer is up to date", async () => {
    const { call } = await appWith(env, null);
    const same = await call("POST", "/api/plugins/update", {}); expect(same.json.unchanged).toBe(true);
    latest = "0.2.0";
    const r = await call("POST", "/api/plugins/update", { name: "echo" });
    expect(r.status).toBe(200); expect(r.json.added?.[0]?.version).toBe("0.2.0"); expect(JSON.parse(files.get("voidbase.lock")!).plugins.echo.version).toBe("0.2.0"); expect(commits.get(head)!.message).toBe("plugins: add echo 0.2.0");
  });
  test("remove: the files and the lock entry go; a name not installed is refused", async () => {
    const { call } = await appWith(env, null);
    const r = await call("POST", "/api/plugins/remove", { name: "echo" });
    expect(r.status).toBe(200); expect(r.json.removed).toEqual(["echo"]); expect(files.has("pb_plugins/echo/bundle.js")).toBe(false); expect(JSON.parse(files.get("voidbase.lock")!).plugins).toEqual({});
    expect((await call("POST", "/api/plugins/remove", { name: "echo" })).status).toBe(400);
  });
  test("a version the marketplace does not serve, and a bad name, are refused before anything is read from GitHub", async () => {
    const { call } = await appWith(env, null);
    expect((await call("POST", "/api/plugins/install", { name: "echo", version: "9.9.9", marketplace: MARKET })).json.message).toMatch(/not served/);
    expect((await call("POST", "/api/plugins/install", { name: "Bad Name" })).status).toBe(400);
  });
  test("a marketplace the lockfile does not name is refused with 400: it is never asked, and GitHub gets the lock read and no commit or ref update", async () => {
    const { call } = await appWith(env, null); const before = head; asked.length = 0; ghCalls.length = 0;
    const r = await call("POST", "/api/plugins/install", { name: "echo", marketplace: OTHER });
    expect(r.status).toBe(400); expect(r.json.message).toContain(`The marketplace ${OTHER} is not one this project trusts`); expect(r.json.message).toContain(`"marketplaces" in voidbase.lock on acme/shop`); expect(r.json.message).toContain(`voidbase plugins add echo --marketplace ${OTHER}`);
    expect(asked).toEqual([]); expect(ghCalls).toEqual(["GET /contents/voidbase.lock"]); expect(head).toBe(before); expect(files.has("pb_plugins/echo/bundle.js")).toBe(false);
  });
  test("a marketplace the lockfile lists installs: the owner's commit adding OTHER to marketplaces turns the same request from a refusal into an install", async () => {
    const { call } = await appWith(env, null);
    expect((await call("POST", "/api/plugins/install", { name: "echo", marketplace: OTHER })).status).toBe(400);
    // the owner's commit, with a trailing slash in the lockfile and spaces around the request's: both are read the same way
    const lock = JSON.parse(files.get("voidbase.lock")!); files.set("voidbase.lock", lockText({ ...lock, marketplaces: [...lock.marketplaces, `${OTHER}/`] }));
    const r = await call("POST", "/api/plugins/install", { name: "echo", marketplace: ` ${OTHER}/ ` });
    expect(r.status).toBe(200); expect(r.json.added).toEqual([{ name: "echo", version: "0.2.0", marketplace: OTHER }]); expect(files.get("pb_plugins/echo/bundle.js")).toBe(echo("0.2.0", "other"));
  });
  test("update still asks the plugin's own recorded marketplace, which the list need not name; once that plugin is removed, its marketplace is refused like any other", async () => {
    const { call } = await appWith(env, null); const v = await record("0.1.0", "other");
    // what `voidbase plugins add echo@0.1.0 --marketplace OTHER` on the owner's checkout leaves once pushed: OTHER on echo's entry, not in marketplaces
    files.set("voidbase.lock", lockText({ ...emptyLock(), marketplaces: [MARKET], plugins: { echo: { version: "0.1.0", integrity: v.integrity, marketplace: OTHER, source: v.source, installedOn: "2026-09-10" } } })); files.set("pb_plugins/echo/bundle.js", echo("0.1.0", "other"));
    asked.length = 0;
    const up = await call("POST", "/api/plugins/update", { name: "echo" });
    expect(up.status).toBe(200); expect(up.json.added).toEqual([{ name: "echo", version: "0.2.0", marketplace: OTHER }]); expect(files.get("pb_plugins/echo/bundle.js")).toBe(echo("0.2.0", "other"));
    expect(asked.filter((a) => a.startsWith("echo "))).toEqual([]); // MARKET serves an echo 0.2.0 too, and was not asked
    expect((await call("POST", "/api/plugins/remove", { name: "echo" })).status).toBe(200);
    const r = await call("POST", "/api/plugins/install", { name: "echo", marketplace: OTHER });
    expect(r.status).toBe(400); expect(r.json.message).toContain(`The marketplace ${OTHER} is not one this project trusts`);
  });
  test("a lookalike of a listed marketplace is refused: the URLs are compared whole, never by a prefix", async () => {
    const { call } = await appWith(env, null);
    files.set("voidbase.lock", lockText({ ...emptyLock(), marketplaces: [MARKET, "https://listed.example"] }));
    const lookalikes = [
      `${MARKET}/registry`, `${MARKET}0`, MARKET.replace(/:\d+$/, ""), `${MARKET}@127.0.0.1:${other.port}`, // MARKET with a path after it, a longer port, no port, and as userinfo in front of OTHER
      "https://listed.example/evil", "https://listed.example.evil.example", "https://listed.examples", "https://listed.example@evil.example", "https://evil.example/https://listed.example",
    ];
    asked.length = 0; ghCalls.length = 0;
    // offline: were one of these let through, its host would answer 404 rather than be reached from a test
    for (const m of lookalikes) { const r = await offline(() => call("POST", "/api/plugins/install", { name: "echo", marketplace: m })); expect([m, r.status, r.json.message]).toEqual([m, 400, expect.stringContaining(`The marketplace ${m} is not one this project trusts`)]); }
    expect(asked).toEqual([]); expect(ghCalls.filter((c) => !c.startsWith("GET "))).toEqual([]);
  });
  test("a marketplace recorded on one plugin's entry is trusted for that plugin alone: another name from it is refused, and nothing is committed", async () => {
    const { call } = await appWith(env, null); const v = await record("0.1.0", "other");
    files.set("voidbase.lock", lockText({ ...emptyLock(), marketplaces: [MARKET], plugins: { foo: { version: "0.1.0", integrity: v.integrity, marketplace: OTHER, source: v.source, installedOn: "2026-09-10" } } }));
    const before = head; asked.length = 0; ghCalls.length = 0;
    const r = await call("POST", "/api/plugins/install", { name: "echo", marketplace: OTHER });
    expect(r.status).toBe(400); expect(r.json.message).toContain(`The marketplace ${OTHER} is not one this project trusts for echo`);
    expect(asked).toEqual([]); expect(ghCalls.filter((c) => !c.startsWith("GET "))).toEqual([]); expect(head).toBe(before);
  });
  test("available reads another marketplace by URL, which installs nothing; an install from it is still refused", async () => {
    const { call } = await appWith(env, null);
    files.set("voidbase.lock", lockText({ ...emptyLock(), marketplaces: [MARKET] }));
    const listed = await offline(() => call("GET", `/api/plugins/available?marketplace=${encodeURIComponent(OTHER)}`));
    expect(listed.status).toBe(200); expect(listed.json.available.map((a: { marketplace: string }) => a.marketplace)).toEqual(["https://marketplace.voidbase.cloud", OTHER]);
    expect(listed.json.available[1].plugins.map((p: { name: string }) => p.name)).toEqual(["echo"]);
    const r = await call("POST", "/api/plugins/install", { name: "echo", marketplace: OTHER });
    expect(r.status).toBe(400); expect(r.json.message).toContain(`The marketplace ${OTHER} is not one this project trusts`);
  });
});

describe("a project on disk (Bun): the change is written in place, and the instance is told to restart", () => {
  const root = mkdtempSync(join(tmpdir(), "vb-installer-"));
  // the project's lockfile lists MARKET, which has an address once the file's beforeAll has run
  beforeAll(() => writeFileSync(join(root, "voidbase.lock"), lockText({ ...emptyLock(), marketplaces: [MARKET] })));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const fs: FilesystemInstaller = { root, list: () => { const l = listPlugins(root); return { installed: l.installed, disabled: [], marketplaces: l.marketplaces }; }, add: (spec, o) => addPlugin(root, spec, o), remove: (n) => removePlugin(root, n), update: (n, o) => updatePlugins(root, n, o) };
  test("a marketplace the lockfile does not name is refused the same way, and nothing is written", async () => {
    const { call } = await appWith({}, fs); const lock = readFileSync(join(root, "voidbase.lock"), "utf8"); asked.length = 0;
    const r = await call("POST", "/api/plugins/install", { name: "echo", marketplace: OTHER });
    expect(r.status).toBe(400); expect(r.json.message).toContain(`The marketplace ${OTHER} is not one this project trusts`); expect(r.json.message).toContain(`"marketplaces" in ${root}/voidbase.lock`); expect(r.json.message).toContain(`voidbase plugins add echo --marketplace ${OTHER} --dir ${root}`);
    expect(asked).toEqual([]); expect(existsSync(join(root, "pb_plugins"))).toBe(false); expect(readFileSync(join(root, "voidbase.lock"), "utf8")).toBe(lock);
  });
  test("with VOIDBASE_PLUGIN_MARKETPLACES set, the refusal says to add the marketplace there, since that list replaces the lockfile's", async () => {
    const { call } = await appWith({}, fs); const was = process.env.VOIDBASE_PLUGIN_MARKETPLACES;
    process.env.VOIDBASE_PLUGIN_MARKETPLACES = MARKET;
    try {
      const r = await call("POST", "/api/plugins/install", { name: "echo", marketplace: OTHER });
      expect(r.status).toBe(400); expect(r.json.message).toContain("add it to VOIDBASE_PLUGIN_MARKETPLACES"); expect(r.json.message).not.toContain(`"marketplaces" in ${root}/voidbase.lock`);
    } finally { if (was === undefined) delete process.env.VOIDBASE_PLUGIN_MARKETPLACES; else process.env.VOIDBASE_PLUGIN_MARKETPLACES = was; }
  });
  test("a lockfile that cannot be read answers 400 with the reason, as it did before the marketplace check", async () => {
    const broken = mkdtempSync(join(tmpdir(), "vb-installer-broken-")); writeFileSync(join(broken, "voidbase.lock"), "{ not json");
    const bfs: FilesystemInstaller = { ...fs, root: broken, list: () => { const l = listPlugins(broken); return { installed: l.installed, disabled: [], marketplaces: l.marketplaces }; }, add: (spec, o) => addPlugin(broken, spec, o) };
    try {
      const { call } = await appWith({}, bfs);
      const r = await call("POST", "/api/plugins/install", { name: "echo", marketplace: MARKET });
      expect(r.status).toBe(400); expect(r.json.message).toMatch(/JSON/);
    } finally { rmSync(broken, { recursive: true, force: true }); }
  });
  test("install writes pb_plugins/<name> and the lockfile; remove takes them away", async () => {
    const { call } = await appWith({}, fs);
    const r = await call("POST", "/api/plugins/install", { name: "echo", marketplace: MARKET });
    expect(r.status).toBe(200); expect(r.json.applied).toBe("filesystem"); expect(r.json.message).toMatch(/restart/);
    expect(existsSync(join(root, "pb_plugins/echo/bundle.js"))).toBe(true); expect(JSON.parse(readFileSync(join(root, "voidbase.lock"), "utf8")).plugins.echo.version).toBe("0.2.0");
    const gone = await call("POST", "/api/plugins/remove", { name: "echo" });
    expect(gone.json.result).toBe("removed"); expect(existsSync(join(root, "pb_plugins/echo"))).toBe(false);
  });
  test("removing a shipped plugin turns it off", async () => {
    const { call } = await appWith({}, fs);
    expect((await call("POST", "/api/plugins/remove", { name: "backups" })).json.result).toBe("disabled");
  });
});

describe("removing a core plugin, or one something else requires, is a deliberate act", () => {
  const root = mkdtempSync(join(tmpdir(), "vb-installer-core-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const fs: FilesystemInstaller = { root, list: () => { const l = listPlugins(root); return { installed: l.installed, disabled: [], marketplaces: l.marketplaces }; }, add: (spec, o) => addPlugin(root, spec, o), remove: (n, o) => removePlugin(root, n, o), update: (n, o) => updatePlugins(root, n, o) };

  test("409 with what stops working, the core flag, what it provides and who depended on it", async () => {
    const { call } = await appWith({}, fs);
    const r = await call("POST", "/api/plugins/remove", { name: "auth" });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({
      message: expect.stringContaining("auth is a core plugin: it provides auth@1"),
      core: true,
      provides: ["auth@1"],
      dependents: [],
    });
    expect(r.json.message).toContain("runs with nobody signed in");
    expect(r.json.message).toContain('send this again with "force": true');
    expect(existsSync(join(root, "voidbase.lock"))).toBe(false); // nothing was written
  });

  test('force: true is the saying-so, and the removal goes through', async () => {
    const { call } = await appWith({}, fs);
    const r = await call("POST", "/api/plugins/remove", { name: "auth", force: true });
    expect(r.status).toBe(200); expect(r.json.result).toBe("disabled");
    expect(JSON.parse(readFileSync(join(root, "voidbase.lock"), "utf8")).disabled).toEqual(["auth"]);
  });

  test("a plugin whose interface a dependent requires is refused the same way, and the dependent is named", async () => {
    const pays: Plugin = { manifest: { name: "pays", version: "0.1.0", tier: "community", voidbase: "*", provides: ["payments@1"] } };
    const shop: Plugin = { manifest: { name: "shop", version: "0.1.0", tier: "community", voidbase: "*", requires: ["payments@1"] } };
    const { call } = await appWith({}, fs, [pays, shop]);
    const r = await call("POST", "/api/plugins/remove", { name: "pays" });
    expect(r.status).toBe(409);
    expect(r.json.core).toBe(false); expect(r.json.dependents).toEqual(["shop"]); expect(r.json.provides).toEqual(["payments@1"]);
    expect(r.json.message).toContain("shop requires payments@1, and only pays provides it");
  });
});
