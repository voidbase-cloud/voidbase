// `voidbase deploy --dry-run` against test/cf-mock.ts: token help without a token, account resolution, idempotent
// D1/R2 provisioning, cloud/ generation with a real-id wrangler.jsonc, superuser credentials file.
//   bun test/cf-mock.ts &   then   bun test/deploy-cf.ts
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const MOCK = "http://127.0.0.1:5197"; const BIN = resolve(import.meta.dir, "../bin/voidbase.ts"); const PKG = resolve(import.meta.dir, ".."); const PROJECT = `${PKG}/.cloud/shopdemo-backend`;
let pass = 0, fail = 0; const check = (l: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}${ok ? "" : "  " + d}`); };
const root = mkdtempSync(join(tmpdir(), "vb-deploy-")); const dir = `${root}/shopdemo/vb`; mkdirSync(`${dir}/pb_hooks`, { recursive: true }); mkdirSync(`${dir}/pb_migrations`);
writeFileSync(`${dir}/package.json`, JSON.stringify({ name: "vb", private: true, dependencies: { voidbase: "link:voidbase" } }));
writeFileSync(`${dir}/main.ts`, `import { mountWebAuthn } from "${resolve(import.meta.dir, "../src/server/webauthn")}";\nexport function register(app: { router: unknown; hooks: Record<string, (...a: unknown[]) => unknown> }) { mountWebAuthn(app.router as never); app.hooks.routerAdd!("GET", "/api/ts-hello", (e: { json: (s: number, d: unknown) => unknown }) => e.json(200, { message: "hi" })); }\n`);
const run = (args: string[], env: Record<string, string> = {}) => { const p = Bun.spawnSync(["bun", BIN, ...args], { cwd: dir, env: { ...process.env, CLOUDFLARE_API_BASE: MOCK, VOIDBASE_DEPLOY_CF_API_KEY: "", CLOUDFLARE_API_TOKEN: "", VOIDBASE_SUPERUSER_EMAIL: "", VOIDBASE_SUPERUSER_PASSWORD: "", PB_SUPERUSER_EMAIL: "", PB_SUPERUSER_PASSWORD: "", VOIDBASE_HOOKS_DIR: "", VOIDBASE_MIGRATIONS_DIR: "", ...env } }); return { code: p.exitCode, out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr) }; };
try {
  await fetch(`${MOCK}/__calls`, { method: "DELETE" });
  const noToken = run(["deploy", "--dry-run"]);
  check("without the token: exit 1 and the dashboard deep link", noToken.code === 1 && noToken.out.includes("dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=") && noToken.out.includes("workers_scripts") && noToken.out.includes("VOIDBASE_DEPLOY_CF_API_KEY"), noToken.out.slice(0, 200));
  const help = run(["token"]);
  check("voidbase token prints the same link", help.code === 0 && help.out.includes("%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22"), help.out.slice(0, 200));
  const bad = run(["deploy", "--dry-run"], { VOIDBASE_DEPLOY_CF_API_KEY: "wrong" });
  check("wrong token: clear error", bad.code === 1 && /cannot list accounts/.test(bad.out), bad.out.slice(0, 200));
  const first = run(["deploy", "--dry-run", "--public-dir", "../sk/build"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  const cfg = existsSync(`${PROJECT}/wrangler.jsonc`) ? readFileSync(`${PROJECT}/wrangler.jsonc`, "utf8") : "";
  const parsed = cfg ? JSON.parse(cfg.replace(/^\/\/.*\n/, "")) as { name: string; account_id: string; d1_databases: { database_id: string; database_name: string }[]; r2_buckets: { bucket_name: string }[] } : null;
  check("first dry run: resources created, project + wrangler.jsonc written inside the voidbase package", first.code === 0 && /D1 .*-db created/.test(first.out) && /R2 .*-storage created/.test(first.out) && !!parsed && parsed.account_id === "acc123" && /^[0-9a-f-]{36}$/.test(parsed.d1_databases[0]!.database_id) && parsed.r2_buckets[0]!.bucket_name === `${parsed.name}-storage` && existsSync(`${PROJECT}/vite.config.ts`) && !existsSync(`${dir}/cloud`), first.out.slice(0, 300));
  check("hooks and migrations point at the consumer's directories, AUDITLOG is the only baked var", readFileSync(`${PROJECT}/vite.config.ts`, "utf8").includes(`${realpathSync(dir)}/pb_hooks`) && /^(AUDITLOG=.*)?$/.test(readFileSync(`${PROJECT}/.env`, "utf8").trim()), `hooks ok=${readFileSync(`${PROJECT}/vite.config.ts`, "utf8").includes(`${realpathSync(dir)}/pb_hooks`)} env=${JSON.stringify(readFileSync(`${PROJECT}/.env`, "utf8"))} dir=${dir} real=${realpathSync(dir)}`);
  check("worker name derives from the parent directory (vb -> <parent>-backend)", !!parsed && parsed.name === "shopdemo-backend", parsed?.name ?? "");
  check("dry run stops before secrets and deploying, reports the workers.dev url", first.out.includes("dry run") && first.out.includes(".testsub.workers.dev"), first.out.slice(-200));
  const creds = JSON.parse(readFileSync(`${dir}/pb_data/.superuser-credentials`, "utf8")) as { email: string; password: string };
  check("superuser credentials generated once, kept in pb_data", creds.email === "admin@example.com" && creds.password.length === 20, JSON.stringify(creds));
  const second = run(["deploy", "--dry-run"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  const creds2 = JSON.parse(readFileSync(`${dir}/pb_data/.superuser-credentials`, "utf8")) as { password: string };
  check("second run is idempotent: resources exist, same ids, same password", second.code === 0 && /D1 .* exists/.test(second.out) && /R2 .* exists/.test(second.out) && readFileSync(`${PROJECT}/wrangler.jsonc`, "utf8") === cfg && creds2.password === creds.password, second.out.slice(0, 200));
  const calls = (await fetch(`${MOCK}/__calls`).then((r) => r.json())) as string[];
  check("only the expected API calls were made", calls.every((c) => /^GET \/accounts|d1\/database|r2\/buckets|workers\/subdomain/.test(c)) && calls.filter((c) => c.startsWith("POST")).length === 2, calls.join(", "));
  const named = run(["deploy", "--dry-run", "--name", "My Shop API", "--account", "acc123"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", PB_SUPERUSER_EMAIL: "owner@example.com", PB_SUPERUSER_PASSWORD: "s3cret-from-env" });
  const named2 = JSON.parse(readFileSync(`${PKG}/.cloud/my-shop-api/wrangler.jsonc`, "utf8").replace(/^\/\/.*\n/, "")) as { name: string };
  const creds3 = JSON.parse(readFileSync(`${dir}/pb_data/.superuser-credentials`, "utf8")) as { email: string; password: string };
  check("--name slug, --account, PB_SUPERUSER_* from the environment", named.code === 0 && named2.name === "my-shop-api" && creds3.email === "owner@example.com" && creds3.password === "s3cret-from-env", `${named2.name} ${JSON.stringify(creds3)} ${named.out.slice(0, 120)}`);
  // the generated project must build with the package's own toolchain (relative imports, no install of its own)
  const build = Bun.spawnSync(["bun", "x", "vp", "build"], { cwd: PROJECT, env: { ...process.env, VOIDBASE_PERSIST_TO: `${PROJECT}/.void-state` } });
  check("generated project builds (vp build) with main.ts composed in", build.exitCode === 0 && existsSync(`${PROJECT}/dist`) && readFileSync(`${PROJECT}/routes/api/[...path].ts`, "utf8").includes("register(appApi())"), new TextDecoder().decode(build.stderr).slice(-400));
} finally { rmSync(root, { recursive: true, force: true }); rmSync(`${PKG}/.cloud/my-shop-api`, { recursive: true, force: true }); rmSync(PROJECT, { recursive: true, force: true }); }
console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
