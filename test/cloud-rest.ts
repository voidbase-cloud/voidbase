// voidbase/cloud against test/cf-mock.ts: provision an instance from a small fake release (D1 + R2 + queue, D1
// migrations through /query, asset upload session, script upload with bindings/tags/DO migration, cron schedule,
// workers.dev subdomain), re-provision idempotently, list, then destroy everything.
//   bun test/cloud-rest.ts        (starts its own cf-mock on a free port)
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CfApi, attachCustomDomain, destroyInstance, findZone, listCustomDomains, listVoidbaseWorkers, provisionInstance, workerExists, assetHash, contentTypeFor, type ReleaseManifest } from "../src/cloud/rest";
import { releaseFromDir } from "../src/node/bundle";
const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const PORT = probe.port; probe.stop(true); // a free port
const MOCK = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0; const check = (l: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}${ok ? "" : "  " + d}`); };
const mock = Bun.spawn(["bun", resolve(import.meta.dir, "cf-mock.ts"), String(PORT)], { stdout: "ignore", stderr: "inherit" });
for (let i = 0; i < 50; i++) { try { await fetch(`${MOCK}/__calls`); break; } catch { await Bun.sleep(100); } }
const state = async () => (await fetch(`${MOCK}/__state`).then((r) => r.json())) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// a fake release: two modules, a wasm, three assets, two migrations
const dir = mkdtempSync(join(tmpdir(), "vb-release-"));
const put = (rel: string, content: string | Uint8Array) => { mkdirSync(resolve(dir, rel, ".."), { recursive: true }); writeFileSync(resolve(dir, rel), content); };
put("worker/index.js", "import './assets/app.js'; export default { fetch() { return new Response('ok') } }");
put("worker/assets/app.js", "export const x = 1;");
put("worker/assets/photon.wasm", new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const assets = [["_/index.html", "<!doctype html><title>panel</title>"], ["404.html", "<h1>404</h1>"], ["_/assets/app.css", "body{}"]] as const;
const manifest: ReleaseManifest = {
  version: "0.1.0-test", voidbase: "0.1.0", builtAt: new Date().toISOString(), compatibilityDate: "2026-09-05", compatibilityFlags: ["nodejs_compat"], mainModule: "index.js",
  modules: [{ path: "index.js", type: "esm", size: 1 }, { path: "assets/app.js", type: "esm", size: 1 }, { path: "assets/photon.wasm", type: "wasm", size: 8 }],
  assets: [], migrations: [{ name: "0000_init.sql", size: 1 }, { name: "0001_logs.sql", size: 1 }], crons: ["0 * * * *"],
  durableObjects: [{ binding: "HUB", className: "VoidbaseHub", tag: "voidbase-hub-v1" }], queueBinding: "QUEUE_JOBS", assetsConfig: { not_found_handling: "404-page", run_worker_first: ["/api", "/api/*"] },
};
for (const [path, body] of assets) { put(`assets/${path}`, body); manifest.assets.push({ path, size: body.length, hash: await assetHash(new TextEncoder().encode(body)), contentType: contentTypeFor(path) }); }
put("migrations/0000_init.sql", "CREATE TABLE a (id TEXT);\n--> statement-breakpoint\nCREATE TABLE b (id TEXT);");
put("migrations/0001_logs.sql", "CREATE TABLE _logs (id TEXT);");
put("manifest.json", JSON.stringify(manifest));
const release = releaseFromDir(dir);
const cf = new CfApi("cf-test-token", MOCK); const lines: string[] = []; const log = (l: string) => lines.push(l);
try {
  const bad = await provisionInstance(new CfApi("wrong", MOCK), { account: "acc123", name: "shop", release, superuser: { email: "a@b.c", password: "pw" } }).catch((e) => e as Error);
  check("wrong token fails before creating anything", bad instanceof Error && /Cloudflare API .*10000/.test(bad.message) && (await state()).d1.length === 0, String(bad instanceof Error ? bad.message : bad));
  const badName = await provisionInstance(cf, { account: "acc123", name: "Bad Name", release, superuser: { email: "a@b.c", password: "pw" } }).catch((e) => e as Error);
  check("worker name is validated", badName instanceof Error && /invalid worker name/.test(badName.message));

  const r = await provisionInstance(cf, { account: "acc123", name: "shop", release, superuser: { email: "admin@shop.test", password: "pw-123456" }, vars: { AUDITLOG: "posts" }, log });
  const s = await state();
  check("D1, R2 and queue created with per-instance names", r.d1.created && r.bucket.created && !!r.queue?.created && s.d1[0][0] === "shop-db" && "shop-storage" in s.r2 && s.queues[0][0] === "shop-jobs", JSON.stringify([s.d1, Object.keys(s.r2), s.queues]));
  const mig = s.d1Migrations[r.d1.uuid] as string[];
  check("D1 migrations applied through /query and tracked in d1_migrations", r.migrationsApplied.length === 2 && mig.join() === "0000_init.sql,0001_logs.sql" && (s.d1Queries[r.d1.uuid] as string[]).some((q: string) => q.startsWith("CREATE TABLE b")), JSON.stringify(s.d1Queries));
  const script = s.scripts.shop; const meta = script.metadata;
  const names = (meta.bindings as { name: string; type: string }[]).map((b) => `${b.type}:${b.name}`).sort();
  check("worker uploaded with every module and the bindings", script.modules.sort().join() === "assets/app.js,assets/photon.wasm,index.js" && meta.main_module === "index.js" && names.join() === "assets:ASSETS,d1:DB,durable_object_namespace:HUB,plain_text:AUDITLOG,queue:QUEUE_JOBS,r2_bucket:STORAGE,secret_text:VOIDBASE_SUPERUSER_EMAIL,secret_text:VOIDBASE_SUPERUSER_PASSWORD", names.join());
  check("compat date/flags, smart placement, DO migration and tags in the metadata", meta.compatibility_date === "2026-09-05" && (meta.compatibility_flags as string[]).includes("nodejs_compat") && (meta.placement as { mode: string }).mode === "smart" && (meta.migrations as { tag: string }[])[0].tag === "voidbase-hub-v1" && (meta.tags as string[]).join() === "voidbase,voidbase-release:0.1.0-test", JSON.stringify(meta));
  check("assets: session, upload, completion token, config", s.uploadedHashes.length === 3 && (meta.assets as { jwt: string; config: Record<string, unknown> }).jwt === "completion-jwt" && (meta.assets as { config: Record<string, unknown> }).config.not_found_handling === "404-page", JSON.stringify(meta.assets));
  check("queue consumer, cron schedule, workers.dev subdomain", (s.consumers[r.queue!.id] as { script_name: string }[])[0].script_name === "shop" && script.schedules.join() === "0 * * * *" && script.subdomain === true && r.url === "https://shop.testsub.workers.dev", JSON.stringify([s.consumers, script.schedules, r.url]));
  check("log lines narrate the steps", lines.some((l) => /D1 shop-db created/.test(l)) && lines.some((l) => /worker shop uploaded/.test(l)) && lines.some((l) => /live: https:\/\/shop\.testsub/.test(l)), lines.join(" | "));

  const again = await provisionInstance(cf, { account: "acc123", name: "shop", release, superuser: { email: "admin@shop.test", password: "pw-123456" }, applyDoMigrations: false });
  const s2 = await state();
  check("re-provision is idempotent: resources reused, no migration re-run, assets already there, no duplicate consumer", !again.d1.created && !again.bucket.created && again.migrationsApplied.length === 0 && (s2.d1Migrations[r.d1.uuid] as string[]).length === 2 && (s2.consumers[r.queue!.id] as unknown[]).length === 1 && !s2.scripts.shop.metadata.migrations, JSON.stringify(again));
  const list = await listVoidbaseWorkers(cf, "acc123");
  check("listing finds the instance by tag with its release", list.length === 1 && list[0]!.name === "shop" && list[0]!.release === "0.1.0-test" && (await workerExists(cf, "acc123", "shop")), JSON.stringify(list));

  const zone = await findZone(cf, "api.shop.example.com", "acc123");
  const attached = await attachCustomDomain(cf, "acc123", { hostname: "api.shop.example.com", service: "shop" });
  const attachedAgain = await attachCustomDomain(cf, "acc123", { hostname: "api.shop.example.com", service: "shop" });
  check("custom domain: zone found by walking the labels, attached once, idempotent", zone?.id === "zone123" && attached.created && attached.zone_id === "zone123" && !attachedAgain.created && (await listCustomDomains(cf, "acc123", { service: "shop" })).length === 1, JSON.stringify([zone, attached, attachedAgain]));
  const noZone = await attachCustomDomain(cf, "acc123", { hostname: "api.other.net", service: "shop" }).catch((e) => e as Error);
  check("custom domain on a zone the account does not have is a clear error", noZone instanceof Error && /no zone on account/.test(noZone.message));
  await cf.raw("PUT", `/accounts/acc123/r2/buckets/shop-storage/objects/some/file.png`, { body: "x" }).then((x) => x.text());
  const d = await destroyInstance(cf, { account: "acc123", name: "shop", log });
  const s3 = await state();
  check("destroy removes custom domains, worker, queue, D1 and the emptied bucket", d.deleted.length === 5 && d.errors.length === 0 && s3.domains.length === 0 && Object.keys(s3.scripts).length === 0 && s3.d1.length === 0 && s3.queues.length === 0 && Object.keys(s3.r2).length === 0, JSON.stringify(d));
  const d2 = await destroyInstance(cf, { account: "acc123", name: "shop" });
  check("destroying again reports nothing found, no errors", d2.deleted.length === 0 && d2.skipped.length === 5 && d2.errors.length === 0 && !(await workerExists(cf, "acc123", "shop")), JSON.stringify(d2));
} finally { mock.kill(); rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
