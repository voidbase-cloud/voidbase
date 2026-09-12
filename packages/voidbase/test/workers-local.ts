// `voidbase serve --workers`: the instance on Cloudflare's local runtime (workerd, through Void's dev server) from a
// pb-layout project on this machine, with nothing reaching Cloudflare.
//   bun test/workers-local.ts
//
// A temporary pb layout (pb_hooks with one route, an empty pb_migrations, a package.json for the worker name), the
// server on a free port, /api/health, the superuser from the environment signing in, a collection and a record
// through the REST API, the hook route the Worker bundled, and the state where the banner says it is. A dead
// Cloudflare API base and a token that must never be used prove the run stays on this machine. The first workerd
// start is the slow part; the whole run stays under about two minutes.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dir, "../bin/voidbase.ts"); const PKG = resolve(import.meta.dir, "..");
const NAME = "wl-test"; const PROJECT = `${PKG}/.cloud/${NAME}`;
const EMAIL = "admin@example.com", PASSWORD = "workers-local-pass1";
const started = Date.now();
let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}${ok ? "" : "  " + d}`); };

// the project: what `voidbase init` leaves behind, minus the panel sync
const root = mkdtempSync(join(tmpdir(), "vb-workers-"));
mkdirSync(`${root}/pb_hooks`); mkdirSync(`${root}/pb_migrations`);
writeFileSync(`${root}/pb_hooks/main.pb.js`, `routerAdd("GET", "/api/hello", (e) => e.json(200, { hello: "workers" }));\n`);
writeFileSync(`${root}/package.json`, JSON.stringify({ name: NAME, private: true }) + "\n");
rmSync(PROJECT, { recursive: true, force: true }); // a fresh D1 every run
const logPath = `${root}/serve.log`;
const freePort = () => { const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") }); const p = s.port; s.stop(true); return p; };
const port = freePort(); const base = `http://127.0.0.1:${port}`;
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  VOIDBASE_SUPERUSER_EMAIL: EMAIL, VOIDBASE_SUPERUSER_PASSWORD: PASSWORD,
  // nothing may reach Cloudflare: a token that must not be used, and an API base nothing listens on
  VOIDBASE_DEPLOY_CF_API_KEY: "must-never-be-used", CLOUDFLARE_API_BASE: "http://127.0.0.1:9",
  VOIDBASE_DEPLOY_NAME: "", VOIDBASE_DEPLOY_DOMAIN: "", VOIDBASE_DOMAINS: "", VOIDBASE_HOOKS_DIR: "", VOIDBASE_MIGRATIONS_DIR: "", VOIDBASE_PLUGINS_DIR: "", VOIDBASE_SECRETS_DIR: "", VOIDBASE_DATA_DIR: "", VOIDBASE_PERSIST_TO: "",
};
// setsid: the CLI spawns vp, which spawns vite and workerd; the process group takes them all down at the end
const server = Bun.spawn(["setsid", "bun", BIN, "serve", "--workers", "--http", `127.0.0.1:${port}`], { cwd: root, env, stdin: "ignore", stdout: Bun.file(logPath), stderr: Bun.file(logPath) });
const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
try {
  let health = 0; let exited: number | null = null; void server.exited.then((c) => { exited = c; });
  for (let i = 0; i < 110 && health !== 200 && exited === null; i++) { await Bun.sleep(1000); health = await fetch(`${base}/api/health`).then((r) => r.status).catch(() => 0); }
  check(`/api/health answers 200 on the local runtime (${Math.round((Date.now() - started) / 1000)} s after start)`, health === 200, `status ${health}, exit ${exited}, log tail: ${log().split("\n").slice(-15).join(" | ")}`);
  check("the project is the one a deploy would generate, with local ids", existsSync(`${PROJECT}/wrangler.jsonc`) && existsSync(`${PROJECT}/vite.config.ts`) && /"database_id": "local"/.test(readFileSync(`${PROJECT}/wrangler.jsonc`, "utf8")) && !/account_id/.test(readFileSync(`${PROJECT}/wrangler.jsonc`, "utf8")), PROJECT);
  check("the superuser is seeded from the environment through the project's .env", /^VOIDBASE_SUPERUSER_EMAIL=admin@example\.com$/m.test(existsSync(`${PROJECT}/.env`) ? readFileSync(`${PROJECT}/.env`, "utf8") : ""), `${PROJECT}/.env`);
  const su = await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: EMAIL, password: PASSWORD }) });
  const token = su.status === 200 ? String((await json(su)).token) : "";
  check("the superuser signs in", su.status === 200 && token.length > 20, String(su.status));
  const H = { "content-type": "application/json", authorization: token };
  const made = await fetch(`${base}/api/collections`, { method: "POST", headers: H, body: JSON.stringify({ name: "wl_posts", type: "base", fields: [{ name: "title", type: "text", required: true }] }) });
  check("a collection is created through the REST API", made.status === 200, `${made.status} ${(await made.text()).slice(0, 200)}`);
  const rec = await fetch(`${base}/api/collections/wl_posts/records`, { method: "POST", headers: H, body: JSON.stringify({ title: "on workerd" }) });
  const record = rec.status === 200 ? await json(rec) : {};
  check("a record is created in it", rec.status === 200 && record.title === "on workerd" && typeof record.id === "string", `${rec.status} ${JSON.stringify(record).slice(0, 200)}`);
  const back = record.id ? await fetch(`${base}/api/collections/wl_posts/records/${record.id}`, { headers: { authorization: token } }) : null;
  const read = back && back.status === 200 ? await json(back) : {};
  check("and read back from the local D1", !!back && back.status === 200 && read.id === record.id && read.title === "on workerd", `${back?.status} ${JSON.stringify(read).slice(0, 200)}`);
  const hello = await fetch(`${base}/api/hello`);
  check("the project's pb_hooks route is bundled into the Worker", hello.status === 200 && (await json(hello)).hello === "workers", String(hello.status));
  const panel = await fetch(`${base}/_/`);
  check("the admin panel is served at /_/", panel.status === 200 && (panel.headers.get("content-type") ?? "").includes("text/html"), String(panel.status));
  const out = log();
  check("the banner names the local runtime, the state directory and the dashboard", /Cloudflare's local runtime/.test(out) && out.includes(`${PROJECT}/.void`) && /Server started at http:\/\/127\.0\.0\.1:\d+/.test(out) && /Dashboard:/.test(out) && out.includes(EMAIL), out.split("\n").slice(-12).join(" | "));
  check("the D1 lives where the banner says", existsSync(`${PROJECT}/.void/v3/d1`), `${PROJECT}/.void`);
  check("Void applied the system migrations to that D1", /Applied \d+ migration\(s\)/.test(out), out.split("\n").filter((l) => /migration/.test(l)).join(" | ").slice(0, 200));
} catch (err) {
  console.error("workers-local: aborted:", err instanceof Error ? err.message : err);
  console.error("--- serve log tail ---\n" + log().split("\n").slice(-30).join("\n"));
  fail++;
} finally {
  try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
  const t = setTimeout(() => { try { process.kill(-server.pid, "SIGKILL"); } catch { /* gone */ } }, 15_000);
  await server.exited; clearTimeout(t);
  rmSync(root, { recursive: true, force: true });
  rmSync(PROJECT, { recursive: true, force: true });
}
console.log(`\n${pass} pass, ${fail} fail  (${Math.round((Date.now() - started) / 1000)} s)`);
process.exit(fail ? 1 : 0);
