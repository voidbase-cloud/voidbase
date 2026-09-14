// `voidbase update --cloudflare` and `voidbase rollback --cloudflare` through the instance's own rebuild
// (src/node/cloud-rebuild.ts): the release staged in its bucket, its assets uploaded, a run queued in its D1 and its
// Workflow started, all over a Cloudflare API answering on this machine, with the instance's D1 as bun:sqlite.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CfApi, type ReleaseSource } from "../../src/cloud/rest";
import { d1 } from "../../src/node/d1";
import { rollbackOnCloudflare, updateOnCloudflare } from "../../src/node/cloud-rebuild";
import { FOLD_SECONDS } from "../../src/server/rebuild/cloudflare";
import { readState, RELEASE_PREFIX, releaseModuleKeyIn, stagedReleasePrefix, writeState } from "../../src/server/rebuild/run";

const sqlite = new Database(":memory:"); const db = d1(sqlite);
const objects = new Map<string, Uint8Array>(); const started: { instance_id?: string; params?: unknown }[] = []; const assetUploads: string[] = [];
const enc = new TextEncoder();
const ok = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const u = new URL(req.url); const p = decodeURIComponent(u.pathname);
  if (p === "/accounts/acc/d1/database" && req.method === "GET") return ok([{ uuid: "db-1", name: "shop-db" }]);
  if (p === "/accounts/acc/d1/database/db-1/query") {
    const { sql, params } = (await req.json()) as { sql: string; params?: unknown[] };
    const results = (await db.prepare(sql).bind(...(params ?? [])).all()).results ?? [];
    return ok([{ results, success: true, meta: {} }]);
  }
  if (p === "/accounts/acc/workflows/shop-rebuild" && req.method === "GET") return ok({ name: "shop-rebuild" });
  if (p === "/accounts/acc/workflows/shop-rebuild/instances" && req.method === "POST") { started.push((await req.json()) as { instance_id?: string; params?: unknown }); return ok({ id: "wf-1" }); }
  const obj = p.match(/^\/accounts\/acc\/r2\/buckets\/shop-storage\/objects\/(.+)$/);
  if (obj) {
    if (req.method === "PUT") { objects.set(obj[1]!, new Uint8Array(await req.arrayBuffer())); return ok({}); }
    const v = objects.get(obj[1]!); return v ? new Response(v as BodyInit) : Response.json({ success: false, errors: [{ code: 10007, message: "not found" }] }, { status: 404 });
  }
  if (p === "/accounts/acc/workers/scripts/shop/assets-upload-session") return ok({ jwt: "session-jwt", buckets: [["h1"]] });
  if (p === "/accounts/acc/workers/assets/upload" && req.headers.get("authorization") === "Bearer session-jwt") { assetUploads.push([...(await req.formData()).keys()].join()); return ok({ jwt: "completion-jwt" }); }
  return Response.json({ success: false, errors: [{ code: 7003, message: `no route for ${req.method} ${p}` }] }, { status: 404 });
} });
afterAll(() => server.stop(true));
const cf = new CfApi("deploy-token", `http://127.0.0.1:${server.port}`);

const baseManifest = { voidbase: "0.9.0", builtAt: "2026-09-14", compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"], mainModule: "index.js", crons: [], durableObjects: [], queueBinding: null, assetsConfig: { html_handling: "none" } };
objects.set(`${RELEASE_PREFIX}manifest.json`, enc.encode(JSON.stringify({ ...baseManifest, version: "0.9.0-test", modules: [], assets: [], migrations: [] })));
const release: ReleaseSource = {
  manifest: { ...baseManifest, version: "0.9.1-test", modules: [{ path: "index.js", type: "esm", size: 3 }, { path: "assets/_...path_-X.js", type: "esm", size: 3 }], assets: [{ path: "_/index.html", size: 5, hash: "h1", contentType: "text/html" }], migrations: [] },
  read: async (path) => enc.encode(path.startsWith("assets/") ? "<html" : "x;\n"),
};

/** the instance's Workflow finishing a run: what its steps would have recorded */
async function land(runId: number, version: number) {
  const s = await readState(db); const run = s.runs.find((r) => r.id === runId)!;
  for (const st of run.steps) st.status = st.status === "skipped" ? "skipped" : "done";
  run.status = "done"; run.version = version; if (run.release) s.release = run.release; delete run.assets;
  if (!s.versions.some((v) => v.number === version)) s.versions.push({ number: version, at: "2026-09-14", plugins: {}, disabled: [], from: s.current, run: runId, workerVersion: `v-${version}`, ...(run.release ? { release: run.release } : {}) });
  s.current = version; await writeState(db, s);
}

test("an update stages the release and its assets, queues the instance's own rebuild, and returns when it lands", async () => {
  await writeState(db, { runs: [], versions: [{ number: 1, at: "2026-09-13", plugins: {}, disabled: [], from: null, run: 1, workerVersion: "v-1" }], current: 1 });
  const log: string[] = [];
  const updating = updateOnCloudflare({ cf, account: "acc", name: "shop", release, log: (l) => log.push(l), pollMs: 20 });
  for (let i = 0; i < 200 && !started.length; i++) await Bun.sleep(10);
  expect(started).toHaveLength(1);
  expect(started[0]!.params).toEqual({ run: 1, wait: FOLD_SECONDS });
  const queued = (await readState(db)).runs[0]!;
  expect(queued).toMatchObject({ reasons: ["update voidbase 0.9.0-test -> 0.9.1-test"], release: "0.9.1-test", assets: "completion-jwt", status: "queued" });
  const staged = stagedReleasePrefix("0.9.1-test");
  expect(objects.has(`${staged}manifest.json`)).toBe(true);
  expect(objects.has(releaseModuleKeyIn(staged, "assets/_...path_-X.js"))).toBe(true);
  expect(assetUploads).toEqual(["h1"]);
  await land(1, 2);
  expect(await updating).toEqual({ run: 1, from: "0.9.0-test", to: "0.9.1-test", version: 2 });
  expect(log.some((l) => l.includes("rebuild 1 done"))).toBe(true);
  // the same release again is nothing to do
  expect(await updateOnCloudflare({ cf, account: "acc", name: "shop", release, pollMs: 20 })).toEqual({ run: null, from: "0.9.1-test", to: "0.9.1-test" });
});

test("a rollback queues the instance's rebuild back onto the version before, and the release it was built on", async () => {
  const rolling = rollbackOnCloudflare({ cf, account: "acc", name: "shop", pollMs: 20 });
  for (let i = 0; i < 200 && started.length < 2; i++) await Bun.sleep(10);
  const run = (await readState(db)).runs.at(-1)!;
  expect(run.reasons).toEqual(["roll back to version 1"]);
  expect(started.at(-1)!.params).toEqual({ run: run.id, wait: 0 });
  expect((await readState(db)).release).toBeUndefined();
  await land(run.id, 1);
  expect(await rolling).toEqual({ to: 1, release: undefined });
});

test("a release adding a Durable Object class is refused before anything is staged", async () => {
  const withClass: ReleaseSource = { ...release, manifest: { ...release.manifest, version: "0.9.2-test", durableObjects: [{ binding: "HUB", className: "VoidbaseHub", tag: "v2" }] } };
  const stagedBefore = objects.size;
  await expect(updateOnCloudflare({ cf, account: "acc", name: "shop", release: withClass, pollMs: 20 })).rejects.toThrow("cannot carry their migration");
  expect(objects.size).toBe(stagedBefore);
});
