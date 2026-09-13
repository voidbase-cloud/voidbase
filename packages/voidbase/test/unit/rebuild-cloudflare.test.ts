// A vanilla instance on Cloudflare rebuilding itself (src/server/rebuild): its declaration in D1, a rebuild run step by
// step the way its Workflow runs it, a version uploaded and deployed through the Cloudflare API, a failure at the upload
// step retried from there, and a rollback. D1 is bun:sqlite, R2 is a map, and GitHub, the marketplace and Cloudflare are
// servers on this machine answering the way the real ones are documented to.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { d1 } from "../../src/node/d1";
import { cloudflareRebuilds, FOLD_SECONDS, rebuildsOnCloudflare } from "../../src/server/rebuild/cloudflare";
import { declareAdd, declareUpdate, readDeclaration } from "../../src/server/rebuild/declaration";
import { readState, RELEASE_PREFIX, releaseModuleKey, runRebuild, type StepApi } from "../../src/server/rebuild/run";

const dirs: string[] = []; const servers: { stop(force?: boolean): void }[] = [];
afterAll(() => { for (const s of servers) s.stop(true); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const enc = new TextEncoder();

const C1 = "1".repeat(40), C2 = "2".repeat(40);
/** hello's repository at a commit, packed the way GitHub packs it */
function packHello(version: string): Uint8Array {
  const d = mkdtempSync(join(tmpdir(), "vb-rebuild-cf-")); dirs.push(d);
  const top = join(d, `hello-${version}`); mkdirSync(join(top, "lib"), { recursive: true });
  writeFileSync(join(top, "manifest.json"), JSON.stringify({ name: "hello", version, tier: "community", voidbase: "*" }));
  writeFileSync(join(top, "main.js"), `import { serve } from "@voidbase-cloud/voidbase/kernel";\nimport { v } from "./lib/v.js";\nexport default { apply(ctx) { serve(ctx, "hello@1", { v }); } };\n`);
  writeFileSync(join(top, "lib/v.js"), `export const v = ${JSON.stringify(version)};\n`);
  Bun.spawnSync(["tar", "-czf", join(d, "repo.tgz"), "-C", d, `hello-${version}`]);
  return new Uint8Array(readFileSync(join(d, "repo.tgz")));
}

/** GitHub's tarballs and a marketplace approving hello 0.1.0, then 0.2.0 */
let latest = "0.1.0"; let tarballFetches = 0;
const tarballs: Record<string, Uint8Array> = { [C1]: packHello("0.1.0"), [C2]: packHello("0.2.0") };
const ver = (version: string, commit: string) => ({ version, manifest: { name: "hello", version, tier: "community", voidbase: "*" }, source: { repository: "me/hello", commit }, publishedOn: "2026-09-13" });
const outside = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/registry/v1/index.json") return Response.json({ schemaVersion: 1, marketplace: { name: "local", url: `http://127.0.0.1:${outside.port}` }, generatedOn: "2026-09-13", templates: [], plugins: [{ name: "hello", repository: "me/hello", title: "Hello", summary: "hello", latest, versions: latest === "0.1.0" ? [ver("0.1.0", C1)] : [ver("0.1.0", C1), ver("0.2.0", C2)] }] });
  const m = u.pathname.match(/^\/me\/hello\/tar\.gz\/(\w+)$/);
  if (m && tarballs[m[1]!]) { tarballFetches++; return new Response(tarballs[m[1]!] as BodyInit); }
  return new Response("not found", { status: 404 });
} });
servers.push(outside);
const BASE = `http://127.0.0.1:${outside.port}`;

/** Cloudflare's versions and deployments, answering an upload with a version id, or failing the next one when told to */
const cf = { uploads: [] as { form: string[]; metadata: Record<string, unknown> }[], deployments: [] as { version: string; force: boolean }[], failNextUpload: false };
const api = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const u = new URL(req.url);
  if (req.headers.get("authorization") !== "Bearer instance-token") return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
  if (u.pathname === "/accounts/acc/workers/scripts/shop/versions" && req.method === "POST") {
    if (cf.failNextUpload) { cf.failNextUpload = false; return Response.json({ success: false, errors: [{ code: 10021, message: "the upload was refused" }] }, { status: 400 }); }
    const form = await req.formData();
    cf.uploads.push({ form: [...form.keys()], metadata: JSON.parse(await (form.get("metadata") as Blob).text()) });
    return Response.json({ success: true, errors: [], messages: [], result: { id: `v-${cf.uploads.length}` } });
  }
  if (u.pathname === "/accounts/acc/workers/scripts/shop/deployments" && req.method === "POST") {
    const body = (await req.json()) as { versions: { version_id: string }[] };
    cf.deployments.push({ version: body.versions[0]!.version_id, force: u.searchParams.get("force") === "true" });
    return Response.json({ success: true, errors: [], messages: [], result: { id: `d-${cf.deployments.length}` } });
  }
  return Response.json({ success: false, errors: [{ code: 7003, message: "no route" }] }, { status: 404 });
} });
servers.push(api);

/** R2 as a map, answering get and put the way a binding does */
function bucket() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key: string, value: string | Uint8Array) { objects.set(key, typeof value === "string" ? enc.encode(value) : value.slice()); return {}; },
    async get(key: string) { const v = objects.get(key); return v ? { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) } : null; },
  };
}

/** an instance: its database, its bucket holding a small rebuildable release, its Workflow binding, token, account and name */
function instance() {
  const storage = bucket(); const created: { id?: string; params?: unknown }[] = [];
  const release: Record<string, string> = {
    "index.js": 'import "./assets/app-X.js";\n',
    "assets/app-X.js": 'import { n as installed } from "./_virtual_voidbase-plugins-abc.js";\n',
    "voidbase-plugins.js": 'import { n as installed, r as projectConfig, t as disabled } from "./assets/_virtual_voidbase-plugins-abc.js";\nexport { disabled, installed, projectConfig };\n',
    "assets/_virtual_voidbase-plugins-abc.js": "var installed = [];\nvar disabled = [];\nvar projectConfig = {};\nexport { installed as n, projectConfig as r, disabled as t };\n",
    "provided/voidbase/kernel.js": "export const serve = () => {};\n",
  };
  for (const [path, body] of Object.entries(release)) storage.objects.set(releaseModuleKey(path), enc.encode(body));
  storage.objects.set(`${RELEASE_PREFIX}manifest.json`, enc.encode(JSON.stringify({ version: "0.9.0-test", mainModule: "index.js", compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"], modules: Object.keys(release).map((path) => ({ path, type: "esm" })) })));
  const env = {
    DB: d1(new Database(":memory:")), STORAGE: storage as unknown as R2Bucket,
    VOIDBASE_REBUILD: { create: async (o: { id?: string; params?: unknown }) => { created.push(o); return {}; } },
    VOIDBASE_REBUILD_TOKEN: "instance-token", VOIDBASE_ACCOUNT_ID: "acc", VOIDBASE_WORKER_NAME: "shop",
  };
  return { env, storage, created };
}

const steps: StepApi = { do: (_name, fn) => fn(), sleep: async () => {} };
const opts = { tarballBase: BASE, api: `http://127.0.0.1:${api.port}` };
const change = { voidbaseVersion: "0.9.0", tarballBase: BASE };

describe("a vanilla instance on Cloudflare rebuilds itself", () => {
  const { env, storage, created } = instance();
  const rebuilds = cloudflareRebuilds(env);

  test("an install pins the approved commit and its files' hash in the declaration, and two changes in a row are one queued run", async () => {
    expect(rebuildsOnCloudflare(env)).toBe(true);
    expect(rebuildsOnCloudflare({ ...env, VOIDBASE_REBUILD_TOKEN: undefined })).toBe(false);
    const added = await declareAdd(env.DB, { name: "hello", marketplace: BASE }, change);
    expect(added).toMatchObject({ name: "hello", version: "0.1.0", marketplace: BASE });
    const d = await readDeclaration(env.DB);
    expect(d.plugins.hello).toMatchObject({ version: "0.1.0", shape: "files", source: { repository: "me/hello", commit: C1 } });
    expect(d.plugins.hello!.integrity).toStartWith("sha256-");
    await rebuilds.queue("install hello 0.1.0");
    const again = await rebuilds.queue("change a setting");
    expect(again.reasons).toEqual(["install hello 0.1.0", "change a setting"]);
    // one Workflow instance, which waits for more changes before its first step
    expect(created).toHaveLength(1);
    expect(created[0]!.params).toEqual({ run: 1, wait: FOLD_SECONDS });
  });

  test("the run's five steps land a version: the plugin assembled in, uploaded keeping bindings and assets, and deployed", async () => {
    const run = await runRebuild(env, 1, steps, 0, opts);
    expect(run?.status).toBe("done");
    expect(run?.steps.map((s) => `${s.name}:${s.status}`)).toEqual(["declare:done", "fetch:done", "assemble:done", "upload:done", "restart:done"]);
    expect(cf.uploads).toHaveLength(1);
    expect(cf.uploads[0]!.form).toEqual(expect.arrayContaining(["metadata", "index.js", "plugins/hello/main.js", "plugins/hello/lib/v.js", "assets/_virtual_voidbase-plugins-abc.js"]));
    expect(cf.uploads[0]!.metadata).toMatchObject({ main_module: "index.js", keep_assets: true, compatibility_flags: ["nodejs_compat"], annotations: { "workers/tag": expect.stringMatching(/^rebuild-1-[0-9a-f]{12}$/) } });
    expect(cf.uploads[0]!.metadata.keep_bindings).toEqual(expect.arrayContaining(["secret_text", "d1", "r2_bucket", "workflow"]));
    const chunk = new TextDecoder().decode(storage.objects.get("_voidbase/rebuilds/1/modules/assets/_virtual_voidbase-plugins-abc.js")!);
    expect(chunk).toContain('import m0 from "../plugins/hello/main.js";');
    expect(cf.deployments).toEqual([{ version: "v-1", force: false }]);
    const s = await readState(env.DB);
    expect(s.current).toBe(1);
    expect(s.versions.map((v) => [v.number, v.workerVersion, v.plugins.hello?.version])).toEqual([[1, "v-1", "0.1.0"]]);
  });

  test("an update whose upload fails names the step, and the retry resumes there without fetching or assembling again", async () => {
    latest = "0.2.0";
    const u = await declareUpdate(env.DB, "hello", change);
    expect(u.updated).toEqual([{ name: "hello", from: "0.1.0", to: "0.2.0", marketplace: BASE }]);
    await rebuilds.queue("update hello");
    cf.failNextUpload = true;
    const failed = await runRebuild(env, 2, steps, 0, opts);
    expect(failed?.status).toBe("failed");
    expect(failed?.steps.find((s) => s.status === "failed")).toMatchObject({ name: "upload", detail: expect.stringContaining("the upload was refused") });
    const fetchesBefore = tarballFetches;
    expect((await rebuilds.retry())?.id).toBe(2);
    expect(created.at(-1)!.params).toEqual({ run: 2, wait: 0 });
    const done = await runRebuild(env, 2, steps, 0, opts);
    expect(done?.steps.map((s) => `${s.name}:${s.status}`)).toEqual(["declare:done", "fetch:done", "assemble:done", "upload:done", "restart:done"]);
    expect(tarballFetches).toBe(fetchesBefore);
    const s = await readState(env.DB);
    expect(s.current).toBe(2);
    expect(cf.deployments.at(-1)).toEqual({ version: "v-2", force: false });
    expect(await rebuilds.retry()).toBeNull();
  });

  test("a rollback deploys the earlier version again and puts its declaration back", async () => {
    const run = await rebuilds.rollback(1);
    expect(run.steps.map((s) => `${s.name}:${s.status}`)).toEqual(["declare:skipped", "fetch:skipped", "assemble:skipped", "upload:skipped", "restart:pending"]);
    expect((await readDeclaration(env.DB)).plugins.hello!.version).toBe("0.1.0");
    const done = await runRebuild(env, run.id, steps, 0, opts);
    expect(done?.status).toBe("done");
    expect(cf.deployments.at(-1)).toEqual({ version: "v-1", force: true });
    expect((await readState(env.DB)).current).toBe(1);
    await expect(Promise.resolve().then(() => rebuilds.rollback(9))).rejects.toThrow("there is no version 9 to roll back to");
  });
});

test("a release module named after a [...path] route is kept under a key Cloudflare accepts", () => {
  const key = releaseModuleKey("assets/_...path_-D-GHDzWl.js");
  expect(key.startsWith(RELEASE_PREFIX + "worker/")).toBe(true);
  expect(key).not.toContain("..");
  expect(releaseModuleKey("assets/_...path_-D-GHDzWl.js")).toBe(key);
});
