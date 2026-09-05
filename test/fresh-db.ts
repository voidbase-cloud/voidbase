// Fresh-database boot: builds the Worker with the PocketBase-style migration fixtures, starts `vp preview`
// (its local D1 starts empty) and checks that bootstrap + pb_migrations produced the expected schema.
//   bun test/fresh-db.ts [port=5181]
import { $ } from "bun";

const port = Number(process.argv[2] ?? 5181);
const base = `http://127.0.0.1:${port}`;
await $`bun run build`.env({ ...process.env, VOIDBASE_MIGRATIONS_DIR: "test/fixtures/migrations" }).quiet();
const logPath = ".void/preview.log";
// setsid: vp spawns vite and workerd children; killing the process group at the end takes them all down
const preview = Bun.spawn(["setsid", "./node_modules/.bin/vp", "preview", "--port", String(port), "--host", "127.0.0.1", "--strictPort"], { stdout: Bun.file(logPath), stderr: Bun.file(logPath) });
let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  " + detail}`); };
try {
  let health = 0;
  for (let i = 0; i < 90 && health !== 200; i++) { await Bun.sleep(1000); health = await fetch(`${base}/api/health`).then((r) => r.status).catch(() => 0); }
  check("health after bootstrap on an empty D1", health === 200, String(health));
  const list = await fetch(`${base}/api/collections/ks_mig/records`);
  check("created + updated migration: ks_mig public list", list.status === 200, String(list.status));
  const created = await fetch(`${base}/api/collections/ks_mig/records`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "m", extra: "kept" }) });
  const rec = (await created.json()) as Record<string, unknown>;
  check("field added by fields.addAt survives", created.status === 200 && rec.extra === "kept", JSON.stringify(rec).slice(0, 160));
  const tmp = await fetch(`${base}/api/collections/ks_tmp/records`);
  check("created then deleted migration: ks_tmp gone", tmp.status === 404, String(tmp.status));
  const su = await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: process.env.VOIDBASE_SUPERUSER_EMAIL ?? "admin@example.com", password: process.env.VOIDBASE_SUPERUSER_PASSWORD ?? "changeme123" }) });
  check("superuser upserted from env", su.status === 200, String(su.status));
  const panel = await fetch(`${base}/_/`);
  check("admin panel served at /_/", panel.status === 200 && (panel.headers.get("content-type") ?? "").includes("text/html"), String(panel.status));
  const spa = await fetch(`${base}/posts/`, { headers: { accept: "text/html,*/*;q=0.8" } }); // a browser navigation
  check("app SPA fallback at /posts/ for HTML navigations", spa.status === 200 && (spa.headers.get("content-type") ?? "").includes("text/html"), String(spa.status));
  const nonHtml = await fetch(`${base}/missing.js`);
  check("index fallback for any missing non-API path (PocketBase Static semantics)", nonHtml.status === 200 && (nonHtml.headers.get("content-type") ?? "").includes("text/html"), String(nonHtml.status));
  const versionJson = await fetch(`${base}/_app/version.json`);
  check("real asset under _app/ served as JSON", versionJson.status === 200 && (versionJson.headers.get("content-type") ?? "").includes("json"), `${versionJson.status} ${versionJson.headers.get("content-type")}`);
  const api404 = await fetch(`${base}/api/nope`, { headers: { accept: "text/html,*/*;q=0.8" } });
  check("unknown /api path stays a JSON 404", api404.status === 404 && (api404.headers.get("content-type") ?? "").includes("json"), String(api404.status));
} catch (err) {
  console.error("fresh-db: aborted:", err instanceof Error ? err.message : err);
  console.error("--- preview log tail ---\n" + (await Bun.file(logPath).text()).split("\n").slice(-25).join("\n"));
  fail++;
} finally {
  try { process.kill(-preview.pid, "SIGTERM"); } catch { preview.kill("SIGTERM"); }
  await preview.exited;
  await $`bun run build`.quiet(); // leave dist/ built from the project's own configuration
}
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
