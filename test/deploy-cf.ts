// `voidbase deploy --dry-run` against test/cf-mock.ts: token help without a token, account resolution, idempotent
// D1/R2 provisioning, cloud/ generation with a real-id wrangler.jsonc, superuser credentials file.
//   bun test/cf-mock.ts &   then   bun test/deploy-cf.ts
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const MOCK = "http://127.0.0.1:5197"; const BIN = resolve(import.meta.dir, "../bin/voidbase.ts"); const PKG = resolve(import.meta.dir, ".."); const PROJECT = `${PKG}/.cloud/shopdemo-backend`;
let pass = 0, fail = 0; const check = (l: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}${ok ? "" : "  " + d}`); };
const root = mkdtempSync(join(tmpdir(), "vb-deploy-")); const dir = `${root}/shopdemo/vb`; mkdirSync(`${dir}/pb_hooks`, { recursive: true }); mkdirSync(`${dir}/pb_migrations`);
// pb_secrets/: two declared, one valued locally; the other must already be on the Worker, which a dry run only reports
mkdirSync(`${dir}/pb_secrets`); writeFileSync(`${dir}/pb_secrets/main.ts`, `import { boolean, defineSecrets, flag, local, secret, server, string } from ${JSON.stringify(resolve(import.meta.dir, "../src/env/define.ts"))};\nexport default defineSecrets({ OPTIONAL_TOKEN: secret(string().optional(), "may be absent"), NEW_CHECKOUT: flag(boolean().default(true), "the new checkout flow"), SMTP_PASSWORD: secret(string(), "the SMTP password"), WEBHOOK_TOKEN: secret(string()), ADMIN_EMAILS: server(string().default("root@example.com")), DEPLOY_NOTE: local(string().default("never deployed")) });\n`); writeFileSync(`${dir}/pb_secrets/secrets.json`, JSON.stringify({ SMTP_PASSWORD: "smtp-secret" }));
mkdirSync(`${root}/shopdemo/sk/build`, { recursive: true }); writeFileSync(`${root}/shopdemo/sk/build/index.html`, "<title>app</title>"); // a frontend build next door
writeFileSync(`${dir}/package.json`, JSON.stringify({ name: "vb", private: true, dependencies: { "@voidbase-cloud/voidbase": "link:@voidbase-cloud/voidbase" } }));
writeFileSync(`${dir}/main.ts`, `export function register(app: { router: unknown; hooks: Record<string, (...a: unknown[]) => unknown> }) { app.hooks.routerAdd!("GET", "/api/ts-hello", (e: { json: (s: number, d: unknown) => unknown }) => e.json(200, { message: "hi" })); }\n`);
const run = (args: string[], env: Record<string, string> = {}) => { const p = Bun.spawnSync(["bun", BIN, ...args], { cwd: dir, env: { ...process.env, CLOUDFLARE_API_BASE: MOCK, VOIDBASE_DEPLOY_CF_API_KEY: "", CLOUDFLARE_API_TOKEN: "", VOIDBASE_SUPERUSER_EMAIL: "", VOIDBASE_SUPERUSER_PASSWORD: "", PB_SUPERUSER_EMAIL: "", PB_SUPERUSER_PASSWORD: "", VOIDBASE_HOOKS_DIR: "", VOIDBASE_MIGRATIONS_DIR: "", VOIDBASE_MAIL_DOMAIN: "", VOIDBASE_AI: "", VOIDBASE_DOMAINS: "", VOIDBASE_DEPLOY_DOMAIN: "", ...env } }); return { code: p.exitCode, out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr) }; };
try {
  await fetch(`${MOCK}/__calls`, { method: "DELETE" });
  const noToken = run(["deploy", "--dry-run"]);
  check("without the token: exit 1 and the dashboard deep link", noToken.code === 1 && noToken.out.includes("dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=") && noToken.out.includes("workers_scripts") && noToken.out.includes("VOIDBASE_DEPLOY_CF_API_KEY"), noToken.out.slice(0, 200));
  const help = run(["token"]);
  check("voidbase token prints the same link", help.code === 0 && help.out.includes("%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22"), help.out.slice(0, 200));
  const bad = run(["deploy", "--dry-run"], { VOIDBASE_DEPLOY_CF_API_KEY: "wrong" });
  check("wrong token: clear error", bad.code === 1 && /cannot list accounts/.test(bad.out), bad.out.slice(0, 200));
  // a bundled workflow beside the project: the deploy exports its class and binds it
  mkdirSync(`${dir}/workflows`, { recursive: true }); writeFileSync(`${dir}/workflows/nightly-report.js`, "// voidbase:workflow NightlyReport\nexport default class NightlyReport {}\n");
  const first = run(["deploy", "--dry-run", "--public-dir", "../sk/build", "--analytics"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  const cfg = existsSync(`${PROJECT}/wrangler.jsonc`) ? readFileSync(`${PROJECT}/wrangler.jsonc`, "utf8") : "";
  const parsed = cfg ? JSON.parse(cfg.replace(/^\/\/.*\n/, "")) as { name: string; account_id: string; d1_databases: { database_id: string; database_name: string }[]; r2_buckets: { bucket_name: string }[] } : null;
  check("first dry run: resources created, project + wrangler.jsonc written inside the voidbase package", first.code === 0 && /D1 .*-db created/.test(first.out) && /R2 .*-storage created/.test(first.out) && !!parsed && parsed.account_id === "acc123" && /^[0-9a-f-]{36}$/.test(parsed.d1_databases[0]!.database_id) && parsed.r2_buckets[0]!.bucket_name === `${parsed.name}-storage` && existsSync(`${PROJECT}/vite.config.ts`) && !existsSync(`${dir}/cloud`), first.out.slice(0, 300));
  check("hooks and migrations point at the consumer's directories, the worker name and account are baked, AUDITLOG only when set", readFileSync(`${PROJECT}/vite.config.ts`, "utf8").includes(`${realpathSync(dir)}/pb_hooks`) && /^VOIDBASE_WORKER_NAME=shopdemo-backend\nVOIDBASE_ACCOUNT_ID=acc123(\nAUDITLOG=.*)?\nNEW_CHECKOUT=true\nADMIN_EMAILS=root@example\.com\nVOIDBASE_FLAGS=\{\"NEW_CHECKOUT\":true\}$/.test(readFileSync(`${PROJECT}/.env`, "utf8").trim()), `hooks ok=${readFileSync(`${PROJECT}/vite.config.ts`, "utf8").includes(`${realpathSync(dir)}/pb_hooks`)} env=${JSON.stringify(readFileSync(`${PROJECT}/.env`, "utf8"))} dir=${dir} real=${realpathSync(dir)}`);
  check("worker name derives from the parent directory (vb -> <parent>-backend)", !!parsed && parsed.name === "shopdemo-backend", parsed?.name ?? "");
  check("dry run stops before secrets and deploying, reports the workers.dev url", first.out.includes("dry run") && first.out.includes(".testsub.workers.dev"), first.out.slice(-200));
  check("pb_secrets: the valued secret joins the Worker's secrets, the unvalued one is reported with the push command, the server default becomes a var", /put 3 secrets \(VOIDBASE_SUPERUSER_EMAIL, VOIDBASE_SUPERUSER_PASSWORD, SMTP_PASSWORD\)/.test(first.out) && /1 declared secret\(s\) have no value .*WEBHOOK_TOKEN.*voidbase secrets push --name shopdemo-backend/.test(first.out) && /vars: .*ADMIN_EMAILS/.test(first.out) && !first.out.includes("smtp-secret"), first.out.slice(-500));
  check("an optional declared secret without a value is not a missing one", !/OPTIONAL_TOKEN/.test(first.out), first.out.split("\n").filter((l) => /secrets:/.test(l)).join(" | ").slice(0, 300));
  const list = run(["secrets"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  check("voidbase secrets: a row per declared name with its tier, local value or default, and Worker presence", list.code === 0 && /6 declared \(3 secret, 1 server, 0 public, 1 flag, 1 local, never deployed\), 1 valued in secrets\.json, worker "shopdemo-backend" has 0 of the secrets/.test(list.out) && /OPTIONAL_TOKEN\s+secret/.test(list.out) && /SMTP_PASSWORD\s+secret\s+local value\s+NOT on the worker\s+the SMTP password/.test(list.out) && /WEBHOOK_TOKEN\s+secret\s+no local value/.test(list.out) && /ADMIN_EMAILS\s+server\s+default "root@example\.com"/.test(list.out) && /DEPLOY_NOTE\s+local\s+default "never deployed"/.test(list.out), list.out.slice(0, 500));
  const push = run(["secrets", "push"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  check("voidbase secrets push before the first deploy: the Worker does not exist yet, and it says so", push.code === 1 && /must exist/.test(push.out), push.out.slice(-300));
  // the account's Secrets Store: a deploy told which store stores the declared secrets there, binds them by name and retires the Worker's own
  const stored = run(["deploy", "--dry-run", "--analytics"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_SECRETS_STORE: "store-1" });
  check("a workflow beside the project is bound: the plan names it, and the config carries the workflows binding", /workflows: nightly-report \(NightlyReport\) bound as WORKFLOW_NIGHTLY_REPORT/.test(first.out) && /"workflows": \[\s*\{\s*"name": "shopdemo-backend-nightly-report",\s*"binding": "WORKFLOW_NIGHTLY_REPORT",\s*"class_name": "NightlyReport"/.test(readFileSync(`${PROJECT}/wrangler.jsonc`, "utf8")), first.out.split("\n").filter((l) => /workflows/.test(l)).join(" | "));
  check("a declared flag: the dry run names the Flagship app it would create, the flag, the binding and the baked defaults", /flags: NEW_CHECKOUT in the Flagship app "shopdemo-backend" \(would be created\); would create NEW_CHECKOUT; bound as FLAGS, defaults baked as VOIDBASE_FLAGS/.test(first.out), first.out.split("\n").filter((l) => /flags:/.test(l)).join(" | "));
  check("with VOIDBASE_SECRETS_STORE the dry run says what it would store and bind, and what it would retire from the Worker", stored.code === 0 && /secrets store store-1: would store [^;]*VOIDBASE_SUPERUSER_EMAIL/.test(stored.out) && /bound by name: [^\n]*VOIDBASE_SUPERUSER_PASSWORD/.test(stored.out) && !/storing .* on the Worker/.test(stored.out), stored.out.split("\n").filter((l) => /secrets/.test(l)).join(" | ").slice(0, 400));
  check("with a store, the vars file names the secrets bound from it, so a Workflow step can resolve them", /^VOIDBASE_STORE_SECRETS=(?=.*VOIDBASE_SUPERUSER_EMAIL)(?=.*VOIDBASE_SUPERUSER_PASSWORD)[A-Z_,]+$/m.test(readFileSync(`${PROJECT}/.env`, "utf8")), JSON.stringify(readFileSync(`${PROJECT}/.env`, "utf8")));
  const pushStore = run(["secrets", "push"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_SECRETS_STORE: "store-1" });
  const storeState = (await (await fetch(`${MOCK}/__state`)).json()) as { storeSecrets: Record<string, { name: string; scopes: string[] }[]> };
  check("secrets push with a store: the values land in the store as <worker>__KEY, scoped to Workers", pushStore.code === 0 && /pushed \d+ secret\(s\) to the Secrets Store store-1/.test(pushStore.out) && (storeState.storeSecrets["store-1"] ?? []).some((x) => /__SMTP_PASSWORD$/.test(x.name) && x.scopes.includes("workers")), pushStore.out + JSON.stringify(storeState.storeSecrets));
  const pushAgain = run(["secrets", "push"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_SECRETS_STORE: "store-1" });
  check("pushing again replaces rather than duplicates", pushAgain.code === 0 && /\(replaced\)/.test(pushAgain.out) && (storeState.storeSecrets["store-1"] ?? []).length === ((await (await fetch(`${MOCK}/__state`)).json()) as { storeSecrets: Record<string, unknown[]> }).storeSecrets["store-1"].length, pushAgain.out);
  const listStore = run(["secrets"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_SECRETS_STORE: "store-1" });
  check("voidbase secrets with a store says which names the store holds", listStore.code === 0 && /SMTP_PASSWORD\s+secret\s+local value\s+in the store/.test(listStore.out), listStore.out.split("\n").filter((l) => /SMTP_PASSWORD/.test(l)).join(" | "));
  // CI="": a build deploys and no more, so the pipeline part is exercised as it is on a machine
  const syncDry = run(["sync", "--dry-run"], { CI: "", VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", CLOUDFLARE_BUILDS_TOKEN: "" });
  check("voidbase sync: the deploy, then the pipeline part says what it needs when there is no Builds token", syncDry.code === 0 && /dry run: would sync the panel/.test(syncDry.out) && /ci: not connected.*CLOUDFLARE_BUILDS_TOKEN as a local\(\) key/.test(syncDry.out), syncDry.out.slice(-400));
  const syncPlan = run(["sync", "--dry-run", "--repo", "voidbase-cloud/voidbase", "--branch", "main"], { CI: "", VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", CLOUDFLARE_BUILDS_TOKEN: "cf-test-user-token" });
  const syncInCI = run(["sync", "--dry-run"], { CI: "true", VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", CLOUDFLARE_BUILDS_TOKEN: "cf-test-user-token" });
  check("in a build, sync is the deploy alone: nothing is connected", syncInCI.code === 0 && /pb layout/.test(syncInCI.out) && !/^ci/m.test(syncInCI.out), syncInCI.out.slice(-200));
  check("voidbase sync --dry-run with a Builds token plans the connection: repository, Worker, branch, commands", syncPlan.code === 0 && /ci \(dry run\): would connect voidbase-cloud\/voidbase to Worker shopdemo-backend: branch main builds `.*` and deploys `bunx @voidbase-cloud\/voidbase sync --name shopdemo-backend/.test(syncPlan.out), syncPlan.out.slice(-400));
  // a project that has the three verbs gets the three verbs, so the commands a person set in the dashboard survive
  writeFileSync(`${dir}/package.json`, JSON.stringify({ name: "vb", private: true, scripts: { build: "vite build", deploy: "voidbase deploy", version: "voidbase secrets" }, dependencies: { "@voidbase-cloud/voidbase": "link:@voidbase-cloud/voidbase" } }));
  const syncVerbs = run(["sync", "--dry-run", "--repo", "voidbase-cloud/voidbase", "--branch", "main"], { CI: "", VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", CLOUDFLARE_BUILDS_TOKEN: "cf-test-user-token" });
  check("a project with build/deploy/version scripts gets those verbs as its commands, not a spelled-out deploy", syncVerbs.code === 0 && /builds `bun run build` and deploys `bun run deploy`/.test(syncVerbs.out), syncVerbs.out.slice(-300));
  // --previews: the Worker's second trigger takes every other branch and deploys a preview with the branch Workers Builds names
  const syncPreviews = run(["sync", "--dry-run", "--repo", "voidbase-cloud/voidbase", "--branch", "main", "--previews"], { CI: "", VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", CLOUDFLARE_BUILDS_TOKEN: "cf-test-user-token" });
  check("sync --previews plans the second trigger: the project's verb with VOIDBASE_PREVIEW=$WORKERS_CI_BRANCH in front", syncPreviews.code === 0 && /every other branch builds `bun run build` and deploys a preview with `VOIDBASE_PREVIEW=\$WORKERS_CI_BRANCH bun run deploy`/.test(syncPreviews.out), syncPreviews.out.slice(-400));
  writeFileSync(`${dir}/package.json`, JSON.stringify({ name: "vb", private: true, dependencies: { "@voidbase-cloud/voidbase": "link:@voidbase-cloud/voidbase" } }));
  const syncPreviews2 = run(["sync", "--dry-run", "--repo", "voidbase-cloud/voidbase", "--branch", "main", "--previews"], { CI: "", VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", CLOUDFLARE_BUILDS_TOKEN: "cf-test-user-token" });
  check("without the verb, the spelled-out deploy gets --preview $WORKERS_CI_BRANCH", syncPreviews2.code === 0 && /deploys a preview with `bunx @voidbase-cloud\/voidbase sync --name shopdemo-backend --preview \$WORKERS_CI_BRANCH`/.test(syncPreviews2.out), syncPreviews2.out.slice(-400));
  // what `voidbase init` leaves behind is what a build machine needs: a pinned dependency and the verbs to run
  {
    const scaffold = mkdtempSync(join(tmpdir(), "vb-init-"));
    const r = Bun.spawnSync(["bun", BIN, "init", scaffold], { env: { ...process.env } });
    void r;
    const pkg = existsSync(`${scaffold}/package.json`) ? (JSON.parse(readFileSync(`${scaffold}/package.json`, "utf8")) as { scripts?: Record<string, string>; dependencies?: Record<string, string> }) : null;
    check("voidbase init writes a package.json pinning voidbase, with the verbs a pipeline calls", !!pkg?.dependencies?.["@voidbase-cloud/voidbase"] && pkg.scripts?.deploy === "voidbase deploy" && !!pkg.scripts?.version, JSON.stringify(pkg));
    const ignored = existsSync(`${scaffold}/.gitignore`) ? readFileSync(`${scaffold}/.gitignore`, "utf8") : "";
    check("and a .gitignore that keeps the values, the data and the generated project out of the repository", ["pb_data/", "pb_secrets/secrets.json", ".cloud/"].every((l) => ignored.includes(l)), JSON.stringify(ignored));
    rmSync(scaffold, { recursive: true, force: true });
  }

  const creds = JSON.parse(readFileSync(`${dir}/pb_data/.superuser-credentials`, "utf8")) as { email: string; password: string };
  check("superuser credentials generated once, kept in pb_data", creds.email === "admin@example.com" && creds.password.length === 20, JSON.stringify(creds));
  const second = run(["deploy", "--dry-run", "--analytics"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  const creds2 = JSON.parse(readFileSync(`${dir}/pb_data/.superuser-credentials`, "utf8")) as { password: string };
  check("second run is idempotent: resources exist, same ids, same password", second.code === 0 && /D1 .* exists/.test(second.out) && /R2 .* exists/.test(second.out) && readFileSync(`${PROJECT}/wrangler.jsonc`, "utf8") === cfg && creds2.password === creds.password, second.out.slice(0, 200));
  {
    const { CfApi } = await import("../src/cloud/rest"); const { ensureFlags, ensureFlagshipApp } = await import("../src/node/flagship");
    const api = new CfApi("cf-test-token", MOCK);
    const app = await ensureFlagshipApp(api, "acc123", "shopdemo-backend"); const again = await ensureFlagshipApp(api, "acc123", "shopdemo-backend");
    const made = await ensureFlags(api, "acc123", app.id, [{ key: "NEW_CHECKOUT", description: "the new checkout flow", fallback: true }, { key: "DARK", fallback: false }]);
    const madeAgain = await ensureFlags(api, "acc123", app.id, [{ key: "NEW_CHECKOUT", fallback: false }]);
    const fs = ((await (await fetch(`${MOCK}/__state`)).json()) as { flagship: { name: string; flags: { key: string; default_variation: string; variations: Record<string, boolean> }[] }[] }).flagship;
    check("the Flagship app is created once and adopted by name; a flag is created with its default and left alone afterwards", app.created && !again.created && again.id === app.id && made.join() === "NEW_CHECKOUT,DARK" && madeAgain.length === 0 && fs[0]?.flags.find((f) => f.key === "NEW_CHECKOUT")?.default_variation === "on" && fs[0]?.flags.find((f) => f.key === "DARK")?.variations.off === false, JSON.stringify(fs));
  }
  const calls = (await fetch(`${MOCK}/__calls`).then((r) => r.json())) as string[];
  // resources, the Worker's secrets and the account's Secrets Store (one create for the store's secrets, then a replace)
  check("only the expected API calls were made", calls.every((c) => /^GET \/accounts|d1\/database|r2\/buckets|queues|workers\/subdomain|workers\/scripts\/[^/]+\/secrets|secrets_store\/stores\/store-1\/secrets|flagship\/apps/.test(c)) && calls.filter((c) => c.startsWith("POST")).length === 7 && calls.filter((c) => c.startsWith("PATCH")).length === 1, calls.join(", "));

  // managing instances without a project: both commands resolve the account from the token and nothing else
  const onAccount = run(["instances"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  check("voidbase instances: resolves the account and reports what is on it", onAccount.code === 0 && /instances? on|no voidbase instances on account Test Account/.test(onAccount.out), onAccount.out.slice(-200));
  const gone = run(["destroy", "ghost-instance", "--yes"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  check("voidbase destroy: names every resource it would remove, and reports what was not there", gone.code === 0 && /the Worker ghost-instance/.test(gone.out) && /the bucket ghost-instance-storage/.test(gone.out) && /0 deleted, 6 not there/.test(gone.out), gone.out.slice(-300));
  const unconfirmed = run(["destroy", "ghost-instance"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  check("voidbase destroy without --yes refuses when nobody can be asked", unconfirmed.code === 1 && /refusing to delete without a confirmation/.test(unconfirmed.out), unconfirmed.out.slice(-200));

  // a project that declares its own target is not deployed onto another one by an ambient environment
  writeFileSync(`${dir}/pb_secrets/main.ts`, readFileSync(`${dir}/pb_secrets/main.ts`, "utf8").replace("export default defineSecrets({", 'export default defineSecrets({ VOIDBASE_DEPLOY_NAME: local(string().default("declared-name")),'));
  const wrongTarget = run(["deploy", "--dry-run"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_DEPLOY_NAME: "someone-elses-worker" });
  check("a declared deploy target is not overridden by the environment", wrongTarget.code === 1 && /declares VOIDBASE_DEPLOY_NAME=declared-name.*environment says someone-elses-worker/s.test(wrongTarget.out) && /--name someone-elses-worker to mean it/.test(wrongTarget.out), wrongTarget.out.slice(-300));
  const meantIt = run(["deploy", "--dry-run", "--name", "someone-elses-worker"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_DEPLOY_NAME: "someone-elses-worker" });
  check("--name says it on purpose and the deploy goes ahead", meantIt.code === 0 && /worker "someone-elses-worker"/.test(meantIt.out), meantIt.out.slice(-200));
  writeFileSync(`${dir}/pb_secrets/main.ts`, readFileSync(`${dir}/pb_secrets/main.ts`, "utf8").replace(' VOIDBASE_DEPLOY_NAME: local(string().default("declared-name")),', ""));
  const named = run(["deploy", "--dry-run", "--name", "My Shop API", "--account", "acc123"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", PB_SUPERUSER_EMAIL: "owner@example.com", PB_SUPERUSER_PASSWORD: "s3cret-from-env" });
  const named2 = JSON.parse(readFileSync(`${PKG}/.cloud/my-shop-api/wrangler.jsonc`, "utf8").replace(/^\/\/.*\n/, "")) as { name: string };
  const noBuild = run(["deploy", "--dry-run", "--public-dir", "../sk/missing"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  check("--public-dir without an index.html is refused before anything is touched", noBuild.code === 1 && /no index\.html \(build the site first\)/.test(noBuild.out), noBuild.out.slice(-200));
  mkdirSync(`${dir}/pb_public`); writeFileSync(`${dir}/pb_public/index.html`, "<title>site</title>");
  writeFileSync(`${dir}/pb_public/_redirects`, "# per-host rules\nhttps://api.example.com/  /_/  302\nhttps://www.example.com/*  https://example.com/:splat  301!\n/old  /new\n/ignored  /x  200\n");
  const pbPublic = run(["deploy", "--dry-run", "--name", "public-demo"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  check("./pb_public is picked up by default, like PocketBase", pbPublic.code === 0 && /would sync the panel and pb_public into/.test(pbPublic.out), pbPublic.out.slice(-300));
  check("_redirects in the public dir is parsed: path rules for the assets, host rules for zone Redirect Rules", /redirects \(.*_redirects\): https:\/\/api\.example\.com\/ -> \/_\/ \(302\), https:\/\/www\.example\.com\/\* -> https:\/\/example\.com\/:splat \(301\), \/old -> \/new \(302\); the 2 host-scoped rule\(s\) become zone Redirect Rules after the upload/.test(pbPublic.out) && !/ignored/.test(pbPublic.out.split("redirects (")[1] ?? ""), pbPublic.out.slice(-400));
  rmSync(`${dir}/pb_public`, { recursive: true, force: true });
  const twoDomains = run(["deploy", "--dry-run", "--name", "site-demo", "--domain", "example.com, api.example.com"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
  check("--domain takes a list: the first is the URL, all are attached after the upload", twoDomains.code === 0 && /custom domains example\.com, api\.example\.com \(workers\.dev off\)/.test(twoDomains.out) && /https:\/\/example\.com/.test(twoDomains.out), twoDomains.out.slice(-300));
  // the domains plugin (src/node/plugins/domains.ts) does that now: the dry run names it, says its plan, and the vars are baked
  const siteEnv = readFileSync(`${PKG}/.cloud/site-demo/.env`, "utf8");
  check("the domains plugin is the shipped deploy plugin that does it: the plan names the redirect, the after hook says what it would attach, the vars are baked", /deploy plugins: previews \(shipped\), domains \(shipped\)/.test(twoDomains.out) && /api\.example\.com redirects to example\.com \(301\)/.test(twoDomains.out) && /dry run: would attach example\.com, api\.example\.com to site-demo, wait for each certificate and set 1 redirect rule\(s\) to example\.com/.test(twoDomains.out) && /^VOIDBASE_DOMAINS=example\.com,api\.example\.com$/m.test(siteEnv) && /^VOIDBASE_CANONICAL_DOMAIN=example\.com$/m.test(siteEnv), `${twoDomains.out.slice(-400)} :: ${siteEnv}`);
  const aliasKnob = run(["deploy", "--dry-run", "--name", "site-demo"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_DOMAINS: "shop.example.com" });
  check("VOIDBASE_DOMAINS is the knob's name; the older VOIDBASE_DEPLOY_DOMAIN is still read", aliasKnob.code === 0 && /custom domain shop\.example\.com \(workers\.dev off\)/.test(aliasKnob.out) && /https:\/\/shop\.example\.com/.test(aliasKnob.out) && /custom domain example\.com/.test(run(["deploy", "--dry-run", "--name", "site-demo"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_DEPLOY_DOMAIN: "example.com" }).out), aliasKnob.out.slice(-300));
  const badHost = run(["deploy", "--dry-run", "--name", "site-demo"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_DOMAINS: "not a host" });
  check("an invalid hostname is refused by the plugin before the upload, with the plugin named", badHost.code === 1 && /deploy plugin domains \(shipped\) failed in before: invalid custom domain "not a host"/.test(badHost.out), badHost.out.slice(-300));
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
  check("without VOIDBASE_MAIL_DOMAIN there is no send_email binding", !bareCfg.includes("send_email") && !cfg.includes("send_email"), bareCfg.slice(0, 200));
  check("without VOIDBASE_AI there is no ai binding and no VOIDBASE_AI var", !/"ai":/.test(bareCfg) && !/"ai":/.test(cfg) && !readFileSync(`${PKG}/.cloud/bare-api/.env`, "utf8").includes("VOIDBASE_AI"), bareCfg.slice(0, 200));
  // Workers AI: the ai binding, the model baked as a var, the plan names it; config only, nothing created on the account
  const aiOn = run(["deploy", "--dry-run", "--name", "ai-api"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_AI: "1" });
  const aiCfg = readFileSync(`${PKG}/.cloud/ai-api/wrangler.jsonc`, "utf8"); const aiEnv = readFileSync(`${PKG}/.cloud/ai-api/.env`, "utf8");
  check("VOIDBASE_AI=1: the ai binding AI in the config, the default model baked as VOIDBASE_AI, the plan names it", aiOn.code === 0 && /"ai": \{\s*"binding": "AI"\s*\}/.test(aiCfg) && /^VOIDBASE_AI=@cf\/meta\/llama-3\.3-70b-instruct-fp8-fast$/m.test(aiEnv) && /bindings: .*Workers AI \(AI, @cf\/meta\/llama-3\.3-70b-instruct-fp8-fast\)/.test(aiOn.out), `${aiOn.out.slice(-300)} :: ${aiEnv}`);
  const aiNamed = run(["deploy", "--dry-run", "--name", "ai-api"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_AI: "@cf/qwen/qwen3-30b-a3b-fp8" });
  check("VOIDBASE_AI=<model>: that model is the var", aiNamed.code === 0 && /^VOIDBASE_AI=@cf\/qwen\/qwen3-30b-a3b-fp8$/m.test(readFileSync(`${PKG}/.cloud/ai-api/.env`, "utf8")) && /"binding": "AI"/.test(readFileSync(`${PKG}/.cloud/ai-api/wrangler.jsonc`, "utf8")), aiNamed.out.slice(-200));
  const aiBad = run(["deploy", "--dry-run", "--name", "ai-api"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_AI: "llama" });
  check("VOIDBASE_AI that is neither 1 nor a model name is refused before anything is touched", aiBad.code === 1 && /VOIDBASE_AI=llama is neither 1 nor a Workers AI model name/.test(aiBad.out), aiBad.out.slice(-200));
  // a sending domain: the send_email binding, the domain baked as a var, and what the token could see on the account
  const mailOn = run(["deploy", "--dry-run", "--name", "mail-api"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_MAIL_DOMAIN: "Example.com" });
  const mailCfg = readFileSync(`${PKG}/.cloud/mail-api/wrangler.jsonc`, "utf8"); const mailEnv = readFileSync(`${PKG}/.cloud/mail-api/.env`, "utf8");
  check("VOIDBASE_MAIL_DOMAIN: the send_email binding SEND_EMAIL in the config, the domain lowercased as a var, the plan names it", mailOn.code === 0 && /"send_email": \[\s*\{\s*"name": "SEND_EMAIL"\s*\}\s*\]/.test(mailCfg) && /^VOIDBASE_MAIL_DOMAIN=example\.com$/m.test(mailEnv) && /bindings: .*Email Sending \(SEND_EMAIL\)/.test(mailOn.out), `${mailOn.out.slice(-300)} :: ${mailEnv}`);
  check("the zone is on the account but not onboarded: the dry run says so and names the dashboard step", /mail: example\.com bound as SEND_EMAIL; zone example\.com is on the account but the domain is not onboarded for Email Sending yet: onboard example\.com for Email Sending once in the dashboard/.test(mailOn.out), mailOn.out.split("\n").filter((l) => /^mail:/.test(l)).join(" | "));
  await fetch(`${MOCK}/zones/zone123/email/sending/subdomains`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer cf-test-token" }, body: JSON.stringify({ name: "example.com" }) }); // somebody onboarded it
  const mailOnboarded = run(["deploy", "--dry-run", "--name", "mail-api"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_MAIL_DOMAIN: "example.com" });
  check("once the domain is onboarded the dry run says that instead", mailOnboarded.code === 0 && /mail: example\.com bound as SEND_EMAIL; the domain is onboarded for Email Sending on zone example\.com/.test(mailOnboarded.out), mailOnboarded.out.split("\n").filter((l) => /^mail:/.test(l)).join(" | "));
  const mailNoZone = run(["deploy", "--dry-run", "--name", "mail-api"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_MAIL_DOMAIN: "mail.example.org" });
  check("a domain with no zone on the account: bound anyway, and told to add the domain to Cloudflare first", mailNoZone.code === 0 && /mail: mail\.example\.org bound as SEND_EMAIL, but no zone on account acc123 covers it: add the domain to Cloudflare first, then onboard/.test(mailNoZone.out), mailNoZone.out.split("\n").filter((l) => /^mail:/.test(l)).join(" | "));
  const mailAddress = run(["deploy", "--dry-run", "--name", "mail-api"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_MAIL_DOMAIN: "noreply@example.com" });
  check("an address instead of a domain is refused before anything is touched", mailAddress.code === 1 && /VOIDBASE_MAIL_DOMAIN=noreply@example\.com is not a domain name/.test(mailAddress.out), mailAddress.out.slice(-200));
  // a deploy-time plugin (src/node/deploy-plugins.ts): an installed plugin's deploy.js, pinned by the lock beside its
  // bundle, runs before the upload (the config and the vars are its to change), after it (the URL), and on --remove
  {
    const { integrityOf } = await import("../src/node/registry");
    const sri = async (s: string) => integrityOf(new TextEncoder().encode(s));
    const bundle = `export default { manifest: { name: "greeter", version: "0.1.0", tier: "community", voidbase: "*" } };\n`;
    const deployJs = `export default { name: "greeter", manifest: { name: "greeter", version: "0.1.0", tier: "community", voidbase: "*" }, deploy: { async before(ctx) { ctx.config.greeter = { worker: ctx.name, account: ctx.account.id }; ctx.vars.GREETER_SAYS = ctx.dryRun ? "dry" : "hello"; ctx.log("greeter before: " + (ctx.api ? "api" : "no api")); }, async after(ctx) { ctx.log("greeter after: " + ctx.url + (ctx.dryRun ? " (dry run)" : "")); }, async remove(ctx) { ctx.log("greeter remove: " + ctx.name); } } };\n`;
    const lockWith = async (deploy: string) => writeFileSync(`${dir}/voidbase.lock`, JSON.stringify({ lockfileVersion: 1, marketplaces: [], plugins: { greeter: { version: "0.1.0", integrity: await sri(bundle), deploy: await sri(deploy), marketplace: "https://m.example", source: { repository: "x/y", commit: "0" }, installedOn: "2026-09-11" } }, disabled: [] }));
    mkdirSync(`${dir}/pb_plugins/greeter`, { recursive: true }); writeFileSync(`${dir}/pb_plugins/greeter/bundle.js`, bundle); writeFileSync(`${dir}/pb_plugins/greeter/deploy.js`, deployJs); await lockWith(deployJs);
    const hooked = run(["deploy", "--dry-run", "--name", "hooked-api"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
    const hookedCfg = existsSync(`${PKG}/.cloud/hooked-api/wrangler.jsonc`) ? readFileSync(`${PKG}/.cloud/hooked-api/wrangler.jsonc`, "utf8") : ""; const hookedEnv = existsSync(`${PKG}/.cloud/hooked-api/.env`) ? readFileSync(`${PKG}/.cloud/hooked-api/.env`, "utf8") : "";
    check("an installed plugin's deploy.js is discovered; before changes the config and the vars, after sees the URL, and a dry run reaches both as a dry run", hooked.code === 0 && /deploy plugins: previews \(shipped\), domains \(shipped\), greeter \(https:\/\/m\.example 0\.1\.0\)/.test(hooked.out) && /greeter before: api/.test(hooked.out) && /greeter after: https:\/\/hooked-api\.testsub\.workers\.dev \(dry run\)/.test(hooked.out) && /"greeter": \{\s*"worker": "hooked-api",\s*"account": "acc123"/.test(hookedCfg) && /^GREETER_SAYS=dry$/m.test(hookedEnv), `${hooked.out.slice(-400)} :: ${hookedEnv}`);
    const removeDry = run(["deploy", "--remove", "--dry-run", "--name", "hooked-api"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
    check("deploy --remove --dry-run runs the remove hooks and says what it would delete and what stays", removeDry.code === 0 && /greeter remove: hooked-api/.test(removeDry.out) && /would delete the Worker hooked-api; its database, bucket and queue stay \(voidbase destroy hooked-api removes those\)/.test(removeDry.out), removeDry.out.slice(-300));
    const removeNo = run(["deploy", "--remove", "--name", "hooked-api"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
    check("deploy --remove without --yes refuses when nobody can be asked", removeNo.code === 1 && /refusing to delete the Worker without a confirmation/.test(removeNo.out), removeNo.out.slice(-200));
    const broken = deployJs.replace('ctx.log("greeter before: " + (ctx.api ? "api" : "no api"));', 'throw new Error("no zone covers it");');
    writeFileSync(`${dir}/pb_plugins/greeter/deploy.js`, broken);
    const tampered = run(["deploy", "--dry-run", "--name", "hooked-api"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
    check("a deploy.js that is not the bytes the lock pins is refused before any hook runs", tampered.code === 1 && /pb_plugins\/greeter\/deploy\.js is not the bytes voidbase\.lock promises/.test(tampered.out) && !/greeter before/.test(tampered.out), tampered.out.slice(-300));
    await lockWith(broken);
    const failed = run(["deploy", "--dry-run", "--name", "hooked-api"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
    check("a hook that throws fails the deploy with the plugin, its origin and the phase named", failed.code === 1 && /deploy plugin greeter \(https:\/\/m\.example 0\.1\.0\) failed in before: no zone covers it/.test(failed.out), failed.out.slice(-300));
    rmSync(`${dir}/pb_plugins`, { recursive: true, force: true }); rmSync(`${dir}/voidbase.lock`, { force: true });
  }
  // the domains plugin on a live Worker: attach, wait for the certificate, redirect the rest to the canonical name,
  // keep the _redirects rules of the same zone; then `deploy --remove` detaches, clears its rules, deletes the Worker
  {
    const { CfApi } = await import("../src/cloud/rest"); const { domainsDeploy } = await import("../src/node/plugins/domains");
    const { applyZoneRedirects } = await import("../src/node/zone-redirects"); const { parseRedirects } = await import("../src/node/cloud-init");
    type Rule = { description: string; expression: string; action_parameters: { from_value: { status_code: number; target_url: { expression?: string; value?: string } } } };
    type State = { domains: { hostname: string; service: string }[]; rulesets: Record<string, Rule[]>; scripts: Record<string, unknown>; d1: [string, string][] };
    const state = async () => (await (await fetch(`${MOCK}/__state`)).json()) as State;
    const api = new CfApi("cf-test-token", MOCK);
    // the Worker on the account, as the upload leaves it
    const form = new FormData(); form.append("metadata", new Blob([JSON.stringify({ main_module: "index.js" })], { type: "application/json" }), "metadata"); form.append("index.js", new Blob(["export default {}"], { type: "application/javascript+module" }), "index.js");
    await api.form("PUT", "/accounts/acc123/workers/scripts/site-demo", form);
    const lines: string[] = [];
    const ctx = { name: "site-demo", account: { id: "acc123" }, api, env: { VOIDBASE_DOMAINS: "example.com, www.example.com" }, config: {}, vars: {}, url: "https://example.com", log: (l: string) => lines.push(l), local: false, dryRun: false };
    await domainsDeploy.deploy!.after!(ctx);
    const own = (r: Rule) => r.description.startsWith("voidbase:site-demo:@domains:");
    const s1 = await state(); const attached = (s: State) => s.domains.filter((d) => d.service === "site-demo").map((d) => d.hostname).sort().join();
    const www = (s1.rulesets.zone123 ?? []).find((r) => r.description === "voidbase:site-demo:@domains:www.example.com");
    check("after: both hostnames attached, each certificate polled until active, www sent to the apex by a 301 zone rule tagged as the plugin's", attached(s1) === "example.com,www.example.com" && lines.some((l) => /custom domain example\.com attached \(zone zone123\)/.test(l)) && lines.some((l) => /certificate for example\.com: active/.test(l)) && lines.some((l) => /certificate for www\.example\.com: active/.test(l)) && !!www && www.expression === '(http.host eq "www.example.com")' && www.action_parameters.from_value.status_code === 301 && www.action_parameters.from_value.target_url.expression === 'concat("https://example.com", http.request.uri.path)' && lines.some((l) => /zone example\.com: 1 redirect rule\(s\) set \(www\.example\.com\)/.test(l)), `${lines.join(" | ")} :: ${JSON.stringify(s1.rulesets)}`);
    lines.length = 0; await domainsDeploy.deploy!.after!(ctx);
    const s2 = await state();
    check("after again: idempotent, already attached, still one rule of its own", attached(s2) === "example.com,www.example.com" && lines.filter((l) => /already attached/.test(l)).length === 2 && (s2.rulesets.zone123 ?? []).filter(own).length === 1, lines.join(" | "));
    // a project's _redirects host rule on the same zone is another set: each pass replaces its own and keeps the other's
    await applyZoneRedirects(api, "acc123", "site-demo", parseRedirects("https://api.example.com/  /_/  302\n"), () => undefined);
    lines.length = 0; await domainsDeploy.deploy!.after!(ctx);
    const s3 = await state(); const apiRule = (s: State) => (s.rulesets.zone123 ?? []).filter((r) => r.description === "voidbase:site-demo:https://api.example.com/").length;
    check("the _redirects rules and the plugin's rules are two sets on one zone, and neither pass replaces the other's", apiRule(s3) === 1 && (s3.rulesets.zone123 ?? []).filter(own).length === 1 && (s3.rulesets.zone123 ?? []).length === 2, JSON.stringify(s3.rulesets));
    // --remove through the CLI: the plugin detaches and clears its set, then the Worker goes; the data stays
    const removed = run(["deploy", "--remove", "--yes", "--name", "site-demo"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_DOMAINS: "example.com,www.example.com" });
    const s4 = await state();
    check("deploy --remove --yes: hostnames detached, the plugin's rules removed, the _redirects rule left, the Worker deleted, the database kept", removed.code === 0 && /deploy plugins: previews \(shipped\), domains \(shipped\)/.test(removed.out) && /custom domain example\.com detached/.test(removed.out) && /custom domain www\.example\.com detached/.test(removed.out) && /zone example\.com: 1 redirect rule\(s\) removed/.test(removed.out) && /worker site-demo deleted; its database, bucket and queue stay/.test(removed.out) && attached(s4) === "" && (s4.rulesets.zone123 ?? []).filter(own).length === 0 && apiRule(s4) === 1 && !("site-demo" in s4.scripts) && s4.d1.some(([n]) => n === "site-demo-db"), `${removed.out.slice(-500)} :: ${JSON.stringify(s4.rulesets)}`);
    const removedAgain = run(["deploy", "--remove", "--yes", "--name", "site-demo"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_DOMAINS: "example.com,www.example.com" });
    check("removing again: nothing attached, nothing to detach, the Worker is not there, and it says so", removedAgain.code === 0 && !/detached/.test(removedAgain.out) && /worker site-demo: not on the account/.test(removedAgain.out), removedAgain.out.slice(-300));
  }
  // previews (src/node/plugins/previews.ts): a branch's own instance, named from the production name and the branch,
  // its resources its own, workers.dev on, the production hostnames left alone; then the account side against the
  // mock: the pull request comment, the listing, the removal with everything the preview owns, the prune
  {
    const { previewWorkerName } = await import("../src/server/plugins/previews");
    const { previewsDeploy, MARKER } = await import("../src/node/plugins/previews");
    const { CfApi } = await import("../src/cloud/rest");
    const api = new CfApi("cf-test-token", MOCK);
    type Cfg = { name: string; workers_dev?: boolean; d1_databases: { database_name: string }[]; r2_buckets: { bucket_name: string }[] };
    type GhState = { ghComments: { id: number; issue: number; body: string }[]; scripts: Record<string, unknown>; d1: [string, string][]; r2: Record<string, string[]>; queues: [string, string][] };
    const state = async () => (await (await fetch(`${MOCK}/__state`)).json()) as GhState;
    const branch = "feature/Login-Flow"; const pname = previewWorkerName("shop", branch);
    const prevDry = run(["deploy", "--dry-run", "--name", "shop", "--preview", branch, "--domain", "example.com,www.example.com"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
    const prevCfg = existsSync(`${PKG}/.cloud/${pname}/wrangler.jsonc`) ? (JSON.parse(readFileSync(`${PKG}/.cloud/${pname}/wrangler.jsonc`, "utf8").replace(/^\/\/.*\n/, "")) as Cfg) : null;
    const prevEnv = existsSync(`${PKG}/.cloud/${pname}/.env`) ? readFileSync(`${PKG}/.cloud/${pname}/.env`, "utf8") : "";
    check("--preview: the Worker is <name>-pr-<slug>, its D1, R2 and queue are named after it, workers.dev stays on", prevDry.code === 0 && /^shop-pr-feature-login-flow-[a-z0-9]{4}$/.test(pname) && new RegExp(`worker "${pname}" \\(a preview of shop for branch feature/Login-Flow\\)`).test(prevDry.out) && new RegExp(`D1 ${pname}-db created`).test(prevDry.out) && new RegExp(`R2 ${pname}-storage created`).test(prevDry.out) && new RegExp(`Queue ${pname}-jobs created`).test(prevDry.out) && prevCfg?.name === pname && prevCfg.workers_dev === true && prevCfg.d1_databases[0]!.database_name === `${pname}-db` && prevCfg.r2_buckets[0]!.bucket_name === `${pname}-storage`, `${pname} :: ${prevDry.out.slice(-600)}`);
    check("the vars are baked, the domains plugin stands down, the URL is the preview's workers.dev, the plan says what after would do", /deploy plugins: previews \(shipped\), domains \(shipped\)/.test(prevDry.out) && /^VOIDBASE_PREVIEW=feature\/Login-Flow$/m.test(prevEnv) && /^VOIDBASE_PREVIEW_OF=shop$/m.test(prevEnv) && !/VOIDBASE_DOMAINS/.test(prevEnv) && /custom domains example\.com, www\.example\.com: skipped, a preview stays on workers\.dev/.test(prevDry.out) && !/would attach/.test(prevDry.out) && new RegExp(`dry run: would seed ${pname} from https://shop\\.testsub\\.workers\\.dev \\(schema`).test(prevDry.out) && new RegExp(`\\(https://${pname}\\.testsub\\.workers\\.dev\\)`).test(prevDry.out), `${prevDry.out.slice(-700)} :: ${prevEnv}`);
    const viaEnv = run(["deploy", "--dry-run", "--name", "shop"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_PREVIEW: branch, VOIDBASE_PREVIEW_SEED: "data" });
    check("VOIDBASE_PREVIEW=<branch> (what a Workers build sets from WORKERS_CI_BRANCH) is the knob's form; the seed kind follows its knob", viaEnv.code === 0 && new RegExp(`worker "${pname}"`).test(viaEnv.out) && new RegExp(`D1 ${pname}-db exists`).test(viaEnv.out) && /\(data\)/.test(viaEnv.out), viaEnv.out.slice(-400));
    const badSeed = run(["deploy", "--dry-run", "--name", "shop", "--preview", branch], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_PREVIEW_SEED: "rows" });
    check("a seed kind that is not schema, data or none is refused before the upload, with the plugin named", badSeed.code === 1 && /deploy plugin previews \(shipped\) failed in before: VOIDBASE_PREVIEW_SEED=rows/.test(badSeed.out), badSeed.out.slice(-300));
    // the account side: the preview Worker as the upload leaves it (its vars as plain_text bindings), a pull request for the branch
    const upload = async (name: string, b: string) => { const form = new FormData(); form.append("metadata", new Blob([JSON.stringify({ main_module: "index.js", bindings: [{ type: "plain_text", name: "VOIDBASE_PREVIEW", text: b }, { type: "plain_text", name: "VOIDBASE_PREVIEW_OF", text: "shop" }, { type: "d1", name: "DB" }, { type: "r2_bucket", name: "STORAGE" }] })], { type: "application/json" }), "metadata"); form.append("index.js", new Blob(["export default {}"], { type: "application/javascript+module" }), "index.js"); await api.form("PUT", `/accounts/acc123/workers/scripts/${name}`, form); };
    const openPr = async (head: string) => ((await (await fetch(`${MOCK}/repos/voidbase-cloud/voidbase/pulls`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ head }) })).json()) as { number: number }).number;
    const closePr = (n: number, merged: boolean) => fetch(`${MOCK}/repos/voidbase-cloud/voidbase/pulls/${n}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(merged ? { merged: true } : { state: "closed" }) });
    await upload(pname, branch); const pr = await openPr(branch);
    const ghEnv = { VOIDBASE_GH_TOKEN: "gh-test", VOIDBASE_PROJECT_REPO: "voidbase-cloud/voidbase", GITHUB_API_URL: MOCK };
    const lines: string[] = [];
    const ctx = { name: pname, account: { id: "acc123" }, api, env: { VOIDBASE_PREVIEW: branch, VOIDBASE_PREVIEW_OF: "shop", VOIDBASE_PREVIEW_SEED: "none", ...ghEnv }, config: {}, vars: { VOIDBASE_PREVIEW: branch, VOIDBASE_PREVIEW_OF: "shop" }, url: `https://${pname}.testsub.workers.dev`, log: (l: string) => lines.push(l), local: false, dryRun: false };
    await previewsDeploy.deploy!.after!(ctx); await previewsDeploy.deploy!.after!(ctx);
    const g1 = await state();
    check("after (seed off): one comment on the branch's pull request, marked, with the address; a second deploy updates it rather than adding one", g1.ghComments.length === 1 && g1.ghComments[0]!.issue === pr && g1.ghComments[0]!.body.startsWith(MARKER) && g1.ghComments[0]!.body.includes(`https://${pname}.testsub.workers.dev`) && g1.ghComments[0]!.body.includes("not seeded") && lines.some((l) => new RegExp(`pull request #${pr}: preview comment posted`).test(l)) && lines.some((l) => /preview comment updated/.test(l)), `${lines.join(" | ")} :: ${JSON.stringify(g1.ghComments)}`);
    const listed = run(["previews", "--name", "shop"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
    check("voidbase previews: the previews of the production Worker, the branch each was deployed for, its address", listed.code === 0 && /1 preview\(s\) of shop/.test(listed.out) && new RegExp(`${pname}\\s+feature/Login-Flow\\s+https://${pname}\\.testsub\\.workers\\.dev`).test(listed.out), listed.out);
    const removeDry = run(["deploy", "--remove", "--dry-run", "--name", "shop", "--preview", branch], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token" });
    check("deploy --remove --preview --dry-run names the preview and everything that would go with it", removeDry.code === 0 && new RegExp(`would delete the preview ${pname} with its database, bucket and queue`).test(removeDry.out) && /would mark the preview comment on the pull request for feature\/Login-Flow as removed/.test(removeDry.out), removeDry.out.slice(-300));
    const removed = run(["deploy", "--remove", "--yes", "--name", "shop", "--preview", branch], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", ...ghEnv });
    const g2 = await state();
    check("deploy --remove --yes --preview: the Worker, its D1, R2 and queue are gone, and the comment says removed", removed.code === 0 && !(pname in g2.scripts) && !g2.d1.some(([n]) => n === `${pname}-db`) && !(`${pname}-storage` in g2.r2) && !g2.queues.some(([n]) => n === `${pname}-jobs`) && new RegExp(`preview ${pname} removed: 4 deleted`).test(removed.out) && g2.ghComments[0]!.body.includes("removed") && new RegExp(`pull request #${pr}: preview comment updated`).test(removed.out) && g2.d1.some(([n]) => n === "shopdemo-backend-db"), `${removed.out.slice(-500)} :: ${JSON.stringify(g2.ghComments)}`);
    // prune --merged: the preview whose pull request is merged goes, the one whose pull request is open stays
    const stale = previewWorkerName("shop", "old/thing"), live = previewWorkerName("shop", "wip");
    await upload(stale, "old/thing"); await upload(live, "wip"); const stalePr = await openPr("old/thing"); const livePr = await openPr("wip"); await closePr(stalePr, true);
    const pruned = run(["previews", "prune", "--merged", "--name", "shop"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", ...ghEnv });
    const g3 = await state();
    check("previews prune --merged: the merged pull request's preview is removed, the open one's kept, and it says which and why", pruned.code === 0 && !(stale in g3.scripts) && live in g3.scripts && new RegExp(`preview ${stale} \\(old/thing\\): pull request #${stalePr} is merged, removing it`).test(pruned.out) && new RegExp(`preview ${live} \\(wip\\): kept, pull request #${livePr} is open`).test(pruned.out) && /1 removed, 1 kept/.test(pruned.out), pruned.out.slice(-500));
    // and a production deploy with VOIDBASE_PREVIEW_PRUNE=1 does the same in its after hook (here as a dry run)
    await closePr(livePr, false);
    const prodPrune = run(["deploy", "--dry-run", "--name", "shop"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", VOIDBASE_PREVIEW_PRUNE: "1", ...ghEnv });
    check("a production deploy with VOIDBASE_PREVIEW_PRUNE=1 prunes in its after hook: the dry run says what would go", prodPrune.code === 0 && new RegExp(`dry run: would remove the preview ${live} \\(wip\\): pull request #${livePr} is closed`).test(prodPrune.out), prodPrune.out.slice(-400));
    const noPrune = run(["deploy", "--dry-run", "--name", "shop"], { VOIDBASE_DEPLOY_CF_API_KEY: "cf-test-token", ...ghEnv });
    check("without the knob a production deploy leaves the previews alone", noPrune.code === 0 && !/would remove the preview/.test(noPrune.out), noPrune.out.slice(-300));
  }
} finally { rmSync(root, { recursive: true, force: true }); if (existsSync(`${PKG}/.cloud`)) for (const d of readdirSync(`${PKG}/.cloud`).filter((d) => d.startsWith("shop-pr-") || d === "shop")) rmSync(`${PKG}/.cloud/${d}`, { recursive: true, force: true }); for (const d of ["my-shop-api", "noqueue-api", "bare-api", "mail-api", "ai-api", "hooked-api", "site-demo", "api-demo", "public-demo"]) rmSync(`${PKG}/.cloud/${d}`, { recursive: true, force: true }); rmSync(PROJECT, { recursive: true, force: true }); }
console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
