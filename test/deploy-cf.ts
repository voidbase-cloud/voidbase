// `voidbase deploy --dry-run` against test/cf-mock.ts: token help without a token, account resolution, idempotent
// D1/R2 provisioning, cloud/ generation with a real-id wrangler.jsonc, superuser credentials file.
//   bun test/cf-mock.ts &   then   bun test/deploy-cf.ts
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const MOCK = "http://127.0.0.1:5197"; const BIN = resolve(import.meta.dir, "../bin/voidbase.ts"); const PKG = resolve(import.meta.dir, ".."); const PROJECT = `${PKG}/.cloud/shopdemo-backend`;
let pass = 0, fail = 0; const check = (l: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}${ok ? "" : "  " + d}`); };
const root = mkdtempSync(join(tmpdir(), "vb-deploy-")); const dir = `${root}/shopdemo/vb`; mkdirSync(`${dir}/pb_hooks`, { recursive: true }); mkdirSync(`${dir}/pb_migrations`);
mkdirSync(`${root}/shopdemo/sk/build`, { recursive: true }); writeFileSync(`${root}/shopdemo/sk/build/index.html`, "<title>app</title>"); // a frontend build next door
writeFileSync(`${dir}/package.json`, JSON.stringify({ name: "vb", private: true, dependencies: { "@voidbase-cloud/voidbase": "link:@voidbase-cloud/voidbase" } }));
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
  const first = run(["deploy", "--dry-run", "--public-dir", "../sk/build", "--analytics"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  const cfg = existsSync(`${PROJECT}/wrangler.jsonc`) ? readFileSync(`${PROJECT}/wrangler.jsonc`, "utf8") : "";
  const parsed = cfg ? JSON.parse(cfg.replace(/^\/\/.*\n/, "")) as { name: string; account_id: string; d1_databases: { database_id: string; database_name: string }[]; r2_buckets: { bucket_name: string }[] } : null;
  check("first dry run: resources created, project + wrangler.jsonc written inside the voidbase package", first.code === 0 && /D1 .*-db created/.test(first.out) && /R2 .*-storage created/.test(first.out) && !!parsed && parsed.account_id === "acc123" && /^[0-9a-f-]{36}$/.test(parsed.d1_databases[0]!.database_id) && parsed.r2_buckets[0]!.bucket_name === `${parsed.name}-storage` && existsSync(`${PROJECT}/vite.config.ts`) && !existsSync(`${dir}/cloud`), first.out.slice(0, 300));
  check("hooks and migrations point at the consumer's directories, the worker name and account are baked, AUDITLOG only when set", readFileSync(`${PROJECT}/vite.config.ts`, "utf8").includes(`${realpathSync(dir)}/pb_hooks`) && /^VOIDBASE_WORKER_NAME=shopdemo-backend\nVOIDBASE_ACCOUNT_ID=acc123(\nAUDITLOG=.*)?$/.test(readFileSync(`${PROJECT}/.env`, "utf8").trim()), `hooks ok=${readFileSync(`${PROJECT}/vite.config.ts`, "utf8").includes(`${realpathSync(dir)}/pb_hooks`)} env=${JSON.stringify(readFileSync(`${PROJECT}/.env`, "utf8"))} dir=${dir} real=${realpathSync(dir)}`);
  check("worker name derives from the parent directory (vb -> <parent>-backend)", !!parsed && parsed.name === "shopdemo-backend", parsed?.name ?? "");
  check("dry run stops before secrets and deploying, reports the workers.dev url", first.out.includes("dry run") && first.out.includes(".testsub.workers.dev"), first.out.slice(-200));
  const creds = JSON.parse(readFileSync(`${dir}/pb_data/.superuser-credentials`, "utf8")) as { email: string; password: string };
  check("superuser credentials generated once, kept in pb_data", creds.email === "admin@example.com" && creds.password.length === 20, JSON.stringify(creds));
  const second = run(["deploy", "--dry-run", "--analytics"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  const creds2 = JSON.parse(readFileSync(`${dir}/pb_data/.superuser-credentials`, "utf8")) as { password: string };
  check("second run is idempotent: resources exist, same ids, same password", second.code === 0 && /D1 .* exists/.test(second.out) && /R2 .* exists/.test(second.out) && readFileSync(`${PROJECT}/wrangler.jsonc`, "utf8") === cfg && creds2.password === creds.password, second.out.slice(0, 200));
  const calls = (await fetch(`${MOCK}/__calls`).then((r) => r.json())) as string[];
  check("only the expected API calls were made", calls.every((c) => /^GET \/accounts|d1\/database|r2\/buckets|queues|workers\/subdomain/.test(c)) && calls.filter((c) => c.startsWith("POST")).length === 3, calls.join(", "));
  const named = run(["deploy", "--dry-run", "--name", "My Shop API", "--account", "acc123"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", PB_SUPERUSER_EMAIL: "owner@example.com", PB_SUPERUSER_PASSWORD: "s3cret-from-env" });
  const named2 = JSON.parse(readFileSync(`${PKG}/.cloud/my-shop-api/wrangler.jsonc`, "utf8").replace(/^\/\/.*\n/, "")) as { name: string };
  const noBuild = run(["deploy", "--dry-run", "--public-dir", "../sk/missing"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  check("--public-dir without an index.html is refused before anything is touched", noBuild.code === 1 && /no index\.html \(build the site first\)/.test(noBuild.out), noBuild.out.slice(-200));
  mkdirSync(`${dir}/pb_public`); writeFileSync(`${dir}/pb_public/index.html`, "<title>site</title>");
  writeFileSync(`${dir}/pb_public/_redirects`, "# per-host rules\nhttps://api.example.com/  /_/  302\nhttps://www.example.com/*  https://example.com/:splat  301!\n/old  /new\n/ignored  /x  200\n");
  const pbPublic = run(["deploy", "--dry-run", "--name", "public-demo"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  check("./pb_public is picked up by default, like PocketBase", pbPublic.code === 0 && /would sync the panel and pb_public into/.test(pbPublic.out), pbPublic.out.slice(-300));
  const voidJson = JSON.parse(readFileSync(`${PKG}/.cloud/public-demo/void.json`, "utf8")) as { routing?: { redirects?: Record<string, { to: string; status: number }> } };
  check("_redirects in the public dir becomes Void's host-aware routing.redirects (3xx only, default 302)", JSON.stringify(voidJson.routing?.redirects) === JSON.stringify({ "https://api.example.com/": { to: "/_/", status: 302 }, "https://www.example.com/*": { to: "https://example.com/:splat", status: 301 }, "/old": { to: "/new", status: 302 } }), JSON.stringify(voidJson.routing));
  rmSync(`${dir}/pb_public`, { recursive: true, force: true });
  const twoDomains = run(["deploy", "--dry-run", "--name", "site-demo", "--domain", "example.com, api.example.com"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  check("--domain takes a list: the first is the URL, all are attached after the upload", twoDomains.code === 0 && /custom domains example\.com, api\.example\.com \(workers\.dev off\)/.test(twoDomains.out) && /https:\/\/example\.com/.test(twoDomains.out), twoDomains.out.slice(-300));
  const withDomain = run(["deploy", "--dry-run", "--name", "api-demo", "--domain", "https://api.example.com/"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  const domainCfg = JSON.parse(readFileSync(`${PKG}/.cloud/api-demo/wrangler.jsonc`, "utf8").replace(/^\/\/.*\n/, "")) as { workers_dev?: boolean; routes?: { pattern: string; custom_domain: boolean }[] };
  check("--domain: workers.dev off, no wrangler routes (attached via the API after upload), https url from the host", withDomain.code === 0 && domainCfg.workers_dev === false && domainCfg.routes === undefined && withDomain.out.includes("https://api.example.com") && !withDomain.out.includes("workers.dev)"), withDomain.out.slice(-300));

  const creds3 = JSON.parse(readFileSync(`${dir}/pb_data/.superuser-credentials`, "utf8")) as { email: string; password: string };
  check("--name slug, --account, PB_SUPERUSER_* from the environment", named.code === 0 && named2.name === "my-shop-api" && creds3.email === "owner@example.com" && creds3.password === "s3cret-from-env", `${named2.name} ${JSON.stringify(creds3)} ${named.out.slice(0, 120)}`);
  // the generated project must build with the package's own toolchain (relative imports, no install of its own)
  // a dry run syncs no panel or app: stand-in index files let the build exercise the 404-shell step
  mkdirSync(`${PROJECT}/public/_`, { recursive: true }); writeFileSync(`${PROJECT}/public/index.html`, "<html>app</html>"); writeFileSync(`${PROJECT}/public/_/index.html`, "<html>panel</html>");
  const build = Bun.spawnSync(["bun", "x", "vp", "build"], { cwd: PROJECT, env: { ...process.env, VOIDBASE_PERSIST_TO: `${PROJECT}/.void-state` } });
  check("generated project builds (vp build) with main.ts composed in", build.exitCode === 0 && existsSync(`${PROJECT}/dist`) && readFileSync(`${PROJECT}/routes/api/[...path].ts`, "utf8").includes("register(appApi())"), new TextDecoder().decode(build.stderr).slice(-400));
  const builtConfig = readFileSync(`${PROJECT}/dist/ssr/wrangler.json`, "utf8");
  check("queue provisioned and consumed: queues/jobs.ts, producer + consumer, rate limit and analytics bindings in the built config", calls.includes("POST /accounts/acc123/queues") && existsSync(`${PROJECT}/queues/shopdemo-backend-jobs.ts`) && builtConfig.includes('"queue":"shopdemo-backend-jobs"') && builtConfig.includes('"consumers"') && builtConfig.includes('"ratelimits"') && builtConfig.includes('"limit":300') && builtConfig.includes('"analytics_engine_datasets"') && builtConfig.includes('"dataset":"shopdemo_backend_requests"'), `${calls.filter((c) => c.includes("queues")).join(" | ")} :: ${builtConfig.slice(0, 200)}`);
  const cfgNamed = readFileSync(`${PKG}/.cloud/my-shop-api/wrangler.jsonc`, "utf8");
  const ns = (c: string) => /"namespace_id": "(\d+)"/.exec(c)?.[1] ?? "";
  check("every instance gets its own resources: db, bucket, queue, rate-limit namespace and dataset are named or derived per app", ns(cfg) !== "" && ns(cfgNamed) !== "" && ns(cfg) !== ns(cfgNamed) && cfgNamed.includes("my-shop-api-db") && cfgNamed.includes("my-shop-api-storage") && cfg.includes("shopdemo_backend_requests") && builtConfig.includes(`"namespace_id":"${ns(cfg)}"`), `${ns(cfg)} vs ${ns(cfgNamed)}`);
  const builtWorker = readFileSync(`${PROJECT}/dist/ssr/index.js`, "utf8");
  check("realtime hub: VoidbaseHub exported from the built Worker, binding and sqlite migration in the built config", /export\s*\{[^}]*VoidbaseHub[^}]*\}/.test(builtWorker) && builtConfig.includes('"class_name":"VoidbaseHub"') && builtConfig.includes('"new_sqlite_classes":["VoidbaseHub"]'), builtConfig.slice(0, 200));
  check("built project is asset-first with 404-page handling and the 404 shells", existsSync(`${PROJECT}/dist/client/404.html`) && existsSync(`${PROJECT}/dist/client/_/404.html`) && !existsSync(`${PROJECT}/middleware`) && readFileSync(`${PROJECT}/dist/ssr/wrangler.json`, "utf8").includes('"not_found_handling":"404-page"') && !readFileSync(`${PROJECT}/dist/ssr/wrangler.json`, "utf8").includes('"/**"'), `${existsSync(`${PROJECT}/dist/client/404.html`)} ${existsSync(`${PROJECT}/dist/client/_/404.html`)}`);
  // a token without the Queues permission: the queue is skipped with a hint and the project has no consumer file
  const noq = run(["deploy", "--dry-run", "--name", "noqueue-api"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token-noqueues" });
  check("token without Queues edit: deploy continues without the queue and says how to enable it", noq.code === 0 && /Queue noqueue-api-jobs not created/.test(noq.out) && /Queues edit permission/.test(noq.out) && !existsSync(`${PKG}/.cloud/noqueue-api/queues`) && existsSync(`${PKG}/.cloud/noqueue-api/wrangler.jsonc`), noq.out.slice(-300));
  const noExtras = run(["deploy", "--dry-run", "--name", "bare-api", "--no-hub"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_DEPLOY_QUEUE: "0", VOIDBASE_DEPLOY_ANALYTICS: "0", VOIDBASE_DEPLOY_RATE_LIMIT: "0" });
  const bareCfg = existsSync(`${PKG}/.cloud/bare-api/wrangler.jsonc`) ? readFileSync(`${PKG}/.cloud/bare-api/wrangler.jsonc`, "utf8") : "";
  check("VOIDBASE_DEPLOY_QUEUE/ANALYTICS/RATE_LIMIT=0 leave only D1 and R2", noExtras.code === 0 && !existsSync(`${PKG}/.cloud/bare-api/queues`) && !bareCfg.includes("ratelimits") && !bareCfg.includes("analytics_engine_datasets") && !bareCfg.includes("durable_objects") && !readFileSync(`${PKG}/.cloud/bare-api/vite.config.ts`, "utf8").includes("hubEntry") && bareCfg.includes("d1_databases"), noExtras.out.slice(-200));
} finally { rmSync(root, { recursive: true, force: true }); for (const d of ["my-shop-api", "noqueue-api", "bare-api"]) rmSync(`${PKG}/.cloud/${d}`, { recursive: true, force: true }); rmSync(PROJECT, { recursive: true, force: true }); }
console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
