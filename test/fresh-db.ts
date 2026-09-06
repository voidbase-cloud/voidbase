// Fresh-database boot: builds the Worker with the PocketBase-style migration fixtures, starts `vp preview`
// (its local D1 starts empty) and checks that bootstrap + pb_migrations produced the expected schema.
//   bun test/fresh-db.ts [port=5181]
import { $ } from "bun";

const port = Number(process.argv[2] ?? 5181);
const base = `http://127.0.0.1:${port}`;
// isolated local state: vp preview would otherwise share .void/v3 with the dev server
const FRESH_STATE = ".void-fresh";
await $`rm -rf ${FRESH_STATE}`.quiet();
const testEnv = { ...process.env, VOIDBASE_MIGRATIONS_DIR: "test/fixtures/migrations", VOIDBASE_HOOKS_DIR: "test/fixtures/hooks", VOIDBASE_PERSIST_TO: FRESH_STATE };
// Void bakes .env into the worker vars but strips any key that the shell also exports with the same value,
// and Bun auto-loads .env into process.env: keep the superuser credentials out of the build's environment.
const buildEnv = { ...testEnv }; delete buildEnv.VOIDBASE_SUPERUSER_EMAIL; delete buildEnv.VOIDBASE_SUPERUSER_PASSWORD;
await $`bun run build`.env(buildEnv).quiet();
// The system tables come from Void's Drizzle migrations (void deploy applies them in production; `void db migrate`
// only knows the default .void state). Seed the isolated D1 file the same way: miniflare names the database file
// deterministically, so reuse the dev file name and apply db/migrations/*.sql in order.
{
  const { Database } = await import("bun:sqlite");
  const { mkdirSync, readdirSync, readFileSync } = await import("node:fs");
  const devDir = ".void/v3/d1/miniflare-D1DatabaseObject";
  const fileName = readdirSync(devDir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (!fileName) throw new Error(`no dev D1 file under ${devDir}; run the dev server once first`);
  const dir = `${FRESH_STATE}/v3/d1/miniflare-D1DatabaseObject`;
  mkdirSync(dir, { recursive: true });
  const db = new Database(`${dir}/${fileName}`, { create: true });
  for (const f of readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(`db/migrations/${f}`, "utf8").split("--> statement-breakpoint")) if (statement.trim()) db.run(statement);
  }
  db.close();
}
const logPath = ".void/preview.log";
// setsid: vp spawns vite and workerd children; killing the process group at the end takes them all down
const preview = Bun.spawn(["setsid", "./node_modules/.bin/vp", "preview", "--port", String(port), "--host", "127.0.0.1", "--strictPort"], { env: testEnv, stdout: Bun.file(logPath), stderr: Bun.file(logPath) });
let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  " + detail}`); };
try {
  let health = 0;
  for (let i = 0; i < 90 && health !== 200; i++) { await Bun.sleep(1000); health = await fetch(`${base}/api/health`).then((r) => r.status).catch(() => 0); }
  check("health after bootstrap on an empty D1", health === 200, String(health));
  const list = await fetch(`${base}/api/collections/ks_mig/records`);
  check("created + updated migration: ks_mig public list", list.status === 200, String(list.status));
  const su = await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: process.env.VOIDBASE_SUPERUSER_EMAIL ?? "admin@example.com", password: process.env.VOIDBASE_SUPERUSER_PASSWORD ?? "changeme123" }) });
  check("superuser upserted from env", su.status === 200, String(su.status));
  const suToken = su.status === 200 ? String(((await su.json()) as { token: string }).token) : "";
  // as superuser: the fixture enrich hook hides `extra` from everyone else
  const created = await fetch(`${base}/api/collections/ks_mig/records`, { method: "POST", headers: { "content-type": "application/json", authorization: suToken }, body: JSON.stringify({ title: "m", extra: "kept" }) });
  const rec = (await created.json()) as Record<string, unknown>;
  check("field added by fields.addAt survives", created.status === 200 && rec.extra === "kept", JSON.stringify(rec).slice(0, 160));
  const tmp = await fetch(`${base}/api/collections/ks_tmp/records`);
  check("created then deleted migration: ks_tmp gone", tmp.status === 404, String(tmp.status));
  const panel = await fetch(`${base}/_/`);
  check("admin panel served at /_/", panel.status === 200 && (panel.headers.get("content-type") ?? "").includes("text/html"), String(panel.status));
  const spa = await fetch(`${base}/posts/`, { headers: { accept: "text/html,*/*;q=0.8" } }); // a browser navigation
  check("app SPA fallback at /posts/ for HTML navigations", spa.status === 200 && (spa.headers.get("content-type") ?? "").includes("text/html"), String(spa.status));
  const nonHtml = await fetch(`${base}/missing.js`);
  check("index fallback for any missing non-API path (PocketBase Static semantics)", nonHtml.status === 200 && (nonHtml.headers.get("content-type") ?? "").includes("text/html"), String(nonHtml.status));
  const versionJson = await fetch(`${base}/_app/version.json`);
  check("real asset under _app/ served as JSON", versionJson.status === 200 && (versionJson.headers.get("content-type") ?? "").includes("json"), `${versionJson.status} ${versionJson.headers.get("content-type")}`);
  // hooks from test/fixtures/hooks: $apis guards, $app helpers, enrich/validate/after-error events
  const guest = await fetch(`${base}/api/hooktest/guest`); const guestAuthed = await fetch(`${base}/api/hooktest/guest`, { headers: { authorization: suToken } });
  check("$apis.requireGuestOnly: 200 anonymous, 400 authenticated", guest.status === 200 && guestAuthed.status === 400, `${guest.status} ${guestAuthed.status}`);
  const sup = await fetch(`${base}/api/hooktest/super`); const supAuthed = await fetch(`${base}/api/hooktest/super`, { headers: { authorization: suToken } });
  check("$apis.requireSuperuserAuth: 401 anonymous, 200 superuser", sup.status === 401 && supAuthed.status === 200, `${sup.status} ${supAuthed.status}`);
  for (let i = 0; i < 2; i++) await fetch(`${base}/api/collections/ks_mig/records`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "counted" }) });
  const counts = (await fetch(`${base}/api/hooktest/count`).then((r) => r.json())) as { all: number; filtered: number; dbx: number };
  check("$app.countRecords with filter string and $dbx.hashExp", counts.all >= 3 && counts.filtered === 2 && counts.dbx === 2, JSON.stringify(counts));
  const enriched = (await fetch(`${base}/api/collections/ks_mig/records/${rec.id}`).then((r) => r.json())) as Record<string, unknown>;
  check("onRecordEnrich hides a field from the API output", enriched.id === rec.id && !("extra" in enriched), JSON.stringify(enriched).slice(0, 160));
  const forbidden = await fetch(`${base}/api/collections/ks_mig/records`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "forbidden" }) });
  check("onRecordValidate rejects the write with 400", forbidden.status === 400 && ((await forbidden.json()) as { message: string }).message === "Failed to create record.", String(forbidden.status));
  const seen = (await fetch(`${base}/api/collections/ks_mig/records?filter=${encodeURIComponent('title = "error-seen"')}`).then((r) => r.json())) as { totalItems: number };
  check("onRecordAfterCreateError fired for the rejected write", seen.totalItems === 1, JSON.stringify(seen).slice(0, 120));
  const byEmail = (await fetch(`${base}/api/hooktest/admin-by-email?email=${encodeURIComponent(process.env.VOIDBASE_SUPERUSER_EMAIL ?? "admin@example.com")}`, { headers: { authorization: suToken } }).then((r) => r.json())) as { id?: string; email?: string };
  check("$app.findAuthRecordByEmail", !!byEmail.id && byEmail.email === (process.env.VOIDBASE_SUPERUSER_EMAIL ?? "admin@example.com"), JSON.stringify(byEmail));
  // request-level hooks: collections, settings, auth-with-password, list post-processing; hook-registered cron
  const superJson = { "content-type": "application/json", authorization: suToken };
  const refused = await fetch(`${base}/api/collections`, { method: "POST", headers: superJson, body: JSON.stringify({ name: "ks_hookfail", type: "base" }) });
  check("onCollectionCreateRequest can refuse with an ApiError", refused.status === 400 && ((await refused.json()) as { message: string }).message === "Hook refused." /* sentenized like PocketBase */, String(refused.status));
  const hooked = await fetch(`${base}/api/collections`, { method: "POST", headers: superJson, body: JSON.stringify({ name: "ks_hooked", type: "base" }) });
  const markers = (await fetch(`${base}/api/collections/ks_mig/records?filter=${encodeURIComponent("title = 'collection-created'")}`).then((r) => r.json())) as { totalItems: number };
  check("onCollectionAfterCreateSuccess fired for the tagged collection", hooked.status === 200 && markers.totalItems === 1, `${hooked.status} ${JSON.stringify(markers).slice(0, 100)}`);
  const settings = (await fetch(`${base}/api/settings`, { headers: { authorization: suToken } }).then((r) => r.json())) as { meta?: { hideControls?: boolean } };
  check("onSettingsListRequest edits the returned settings", settings.meta?.hideControls === true, JSON.stringify(settings.meta).slice(0, 120));
  const blocked = await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "blocked@example.com", password: "whatever" }) });
  check("onRecordAuthWithPasswordRequest runs before the password check", blocked.status === 403, String(blocked.status));
  const listed = (await fetch(`${base}/api/collections/ks_mig/records`).then((r) => r.json())) as { hooked?: boolean; items: unknown[] };
  check("onRecordsListRequest post-processes the result after e.next()", listed.hooked === true && Array.isArray(listed.items), JSON.stringify(listed).slice(0, 100));
  const crons = (await fetch(`${base}/api/crons`, { headers: { authorization: suToken } }).then((r) => r.json())) as { id: string; expression: string }[];
  check("cronAdd job listed first with its expression", crons[0]?.id === "hookjob" && crons[0]?.expression === "*/5 * * * *", JSON.stringify(crons).slice(0, 120));
  const ran = await fetch(`${base}/api/crons/hookjob`, { method: "POST", headers: { authorization: suToken } });
  await Bun.sleep(1500);
  const cronMarkers = (await fetch(`${base}/api/collections/ks_mig/records?filter=${encodeURIComponent("title = 'cron-ran'")}`).then((r) => r.json())) as { totalItems: number };
  check("POST /api/crons/:id runs the hook job", ran.status === 204 && cronMarkers.totalItems === 1, `${ran.status} ${JSON.stringify(cronMarkers).slice(0, 100)}`);
  const boom = await fetch(`${base}/api/hooktest/boom`);
  check("hook route exception -> generic 500", boom.status === 500 && ((await boom.json()) as { message: string }).message === "Something went wrong while processing your request.", String(boom.status));
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
