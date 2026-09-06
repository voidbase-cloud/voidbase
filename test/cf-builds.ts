// scripts/cf-builds.ts and scripts/gh-release.ts against test/cf-mock.ts: the Builds API wants the user token, setup
// connects the repository and creates the two Workers with four triggers (push builds off, variables and secrets set,
// idempotently) and stores the workflow's variables and secret in GitHub through a stubbed gh; builds are triggered,
// listed, followed and cancelled, variables set; release assets are uploaded, replaced and the notes rewritten
// through GitHub's API.
//   bun test/cf-builds.ts        (starts its own cf-mock on a free port)
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const PORT = probe.port; probe.stop(true);
const MOCK = `http://127.0.0.1:${PORT}`; const PKG = resolve(import.meta.dir, "..");
const mock = Bun.spawn(["bun", "test/cf-mock.ts", String(PORT)], { cwd: PKG, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 50; i++) { try { await fetch(`${MOCK}/__state`); break; } catch { await Bun.sleep(100); } }
let pass = 0, fail = 0; const check = (l: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}${ok ? "" : "  " + d}`); };
const base: Record<string, string | undefined> = { ...process.env, CLOUDFLARE_API_BASE: MOCK, GITHUB_API_URL: MOCK, CLOUDFLARE_ACCOUNT_ID: "acc123", GH_TOKEN: "gh-test", NPM_TOKEN: "npm-test", CI_CACHE_TOKEN: "cf-test-token", GH_PACKAGES_TOKEN: undefined, VOIDBASE_NPM_TOKEN: undefined, CF_BUILDS_POLL_MS: "50", GITHUB_REPOSITORY: "voidbase-cloud/voidbase" };
const run = (script: string, args: string[], env: Record<string, string | undefined> = {}) => { const p = Bun.spawnSync(["bun", `scripts/${script}`, ...args], { cwd: PKG, env: { ...base, ...env } as Record<string, string>, stdout: "pipe", stderr: "pipe" }); return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }; };
const cfb = (args: string[], env: Record<string, string | undefined> = {}) => run("cf-builds.ts", args, { CLOUDFLARE_BUILDS_TOKEN: "cf-test-user-token", ...env });
const ghr = (args: string[]) => run("gh-release.ts", args);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const state = async () => (await (await fetch(`${MOCK}/__state`)).json()) as any;
const scripts = async () => ((await (await fetch(`${MOCK}/accounts/acc123/workers/scripts`, { headers: { authorization: "Bearer cf-test-user-token" } })).json()) as { result: { id: string; tag: string }[] }).result;
try {
  const noToken = run("cf-builds.ts", ["status"], { CLOUDFLARE_BUILDS_TOKEN: undefined });
  check("without CLOUDFLARE_BUILDS_TOKEN: exit 1 and what token to create", noToken.code === 1 && /user API token/.test(noToken.out), noToken.out.slice(0, 200));
  const acct = cfb(["setup"], { CLOUDFLARE_BUILDS_TOKEN: "cf-test-token" });
  check("an account-owned token: the Builds API's rejection is explained", acct.code === 1 && /user tokens only/.test(acct.out), acct.out.slice(0, 300));
  // a project the dashboard wizard created first: its Worker, connection and production trigger get adopted, not duplicated
  const pre = await (await fetch(`${MOCK}/accounts/acc123/builds/repos/connections`, { method: "PUT", headers: { authorization: "Bearer cf-test-user-token", "content-type": "application/json" }, body: JSON.stringify({ provider_type: "github", provider_account_id: "325612581", provider_account_name: "voidbase-cloud", repo_id: "1359087906", repo_name: "voidbase" }) })).json() as { result: { repo_connection_uuid: string } };
  const form = new FormData(); form.set("metadata", new Blob([JSON.stringify({ main_module: "index.js" })], { type: "application/json" })); form.set("index.js", new File(["export default {}"], "index.js", { type: "application/javascript+module" }));
  await fetch(`${MOCK}/accounts/acc123/workers/scripts/voidbase-ci`, { method: "PUT", headers: { authorization: "Bearer cf-test-user-token" }, body: form });
  const preTag = (await scripts()).find((x) => x.id === "voidbase-ci")!.tag;
  const wizard = await (await fetch(`${MOCK}/accounts/acc123/builds/triggers`, { method: "POST", headers: { authorization: "Bearer cf-test-user-token", "content-type": "application/json" }, body: JSON.stringify({ external_script_id: preTag, repo_connection_uuid: pre.result.repo_connection_uuid, build_token_uuid: "bt-1", trigger_name: "Deploy production", build_command: "npm run build", deploy_command: "npx wrangler deploy", branch_includes: ["master"], branch_excludes: [], path_includes: ["*"], path_excludes: [] }) })).json() as { result: { trigger_uuid: string } };
  const setup = cfb(["setup"]);
  let s = await state(); let w = await scripts();
  const byName = (n: string) => s.triggers.find((t: { trigger_name: string }) => t.trigger_name === n);
  const tagOf = (n: string) => w.find((x) => x.id === n)?.tag;
  check("setup: repository connected, two Workers with tags, four triggers", setup.code === 0 && s.connections.length === 1 && s.connections[0].repo_id === "1359087906" && s.connections[0].provider_account_name === "voidbase-cloud" && !!tagOf("voidbase-ci") && !!tagOf("voidbase-release") && s.triggers.length === 4, setup.out.slice(0, 400));
  const prod = byName("voidbase-ci (master)"), preview = byName("voidbase-ci (branches)"), rel = byName("voidbase-release (master)"), dry = byName("voidbase-release (dry run)");
  check("the wizard's production trigger was adopted: same uuid, renamed, commands replaced, connection reused", prod?.trigger_uuid === wizard.result.trigger_uuid && prod.build_command === "bash scripts/ci.sh" && s.connections[0].repo_connection_uuid === pre.result.repo_connection_uuid, JSON.stringify(prod));
  check("the CI production trigger: master, scripts/ci.sh, deploys the status Worker, cache on", prod?.external_script_id === tagOf("voidbase-ci") && prod.build_command === "bash scripts/ci.sh" && /wrangler deploy -c ci\/wrangler\.jsonc/.test(prod.deploy_command) && JSON.stringify(prod.branch_includes) === '["master"]' && prod.build_caching_enabled === true && prod.build_token_uuid === "bt-1", JSON.stringify(prod));
  check("the CI preview trigger: every other branch, versions upload for a preview URL", preview?.external_script_id === tagOf("voidbase-ci") && /versions upload -c ci\/wrangler\.jsonc/.test(preview.deploy_command) && JSON.stringify(preview.branch_includes) === '["*"]' && JSON.stringify(preview.branch_excludes) === '["master"]', JSON.stringify(preview));
  check("the release triggers: master runs scripts/release.sh, the dry run trigger runs it with --dry-run and uploads a version", rel?.external_script_id === tagOf("voidbase-release") && rel.build_command === "bash scripts/release.sh" && JSON.stringify(rel.branch_includes) === '["master"]' && dry?.external_script_id === tagOf("voidbase-release") && dry.build_command === "bash scripts/release.sh --dry-run" && /versions upload/.test(dry.deploy_command) && JSON.stringify(dry.branch_excludes) === '["master"]', JSON.stringify([rel, dry]));
  check("push events never build: every trigger's watch paths exclude everything", s.triggers.every((t: { path_includes: string[]; path_excludes: string[] }) => JSON.stringify(t.path_includes) === '["*"]' && JSON.stringify(t.path_excludes) === '["*"]'), JSON.stringify(s.triggers.map((t: { path_excludes: string[] }) => t.path_excludes)));
  check("the cache bucket exists and every trigger knows it, the R2 token as a secret", Object.keys(s.r2 ?? {}).includes("voidbase-ci-cache") && [prod, preview, rel, dry].every((t) => s.buildEnv[t.trigger_uuid]?.CI_CACHE_BUCKET?.value === "voidbase-ci-cache" && s.buildEnv[t.trigger_uuid]?.CI_CACHE_ACCOUNT?.value === "acc123" && s.buildEnv[t.trigger_uuid]?.CI_CACHE_TOKEN?.is_secret === true) && /cache bucket voidbase-ci-cache: created/.test(setup.out), JSON.stringify(Object.keys(s.r2 ?? {})) + setup.out.slice(0, 200));
  check("build variables: BUN_VERSION on the CI triggers, the secrets on both release triggers", s.buildEnv[prod.trigger_uuid]?.BUN_VERSION?.value === "1.3.14" && s.buildEnv[preview.trigger_uuid]?.BUN_VERSION?.value === "1.3.14" && s.buildEnv[rel.trigger_uuid]?.GH_TOKEN?.value === "gh-test" && s.buildEnv[rel.trigger_uuid]?.GH_TOKEN?.is_secret === true && s.buildEnv[rel.trigger_uuid]?.NPM_TOKEN?.is_secret === true && !s.buildEnv[rel.trigger_uuid]?.GH_PACKAGES_TOKEN && s.buildEnv[dry.trigger_uuid]?.NPM_TOKEN?.is_secret === true, JSON.stringify(s.buildEnv));
  check("setup's summary names what it created, the workflow's variables and how to start the first build", /created/.test(setup.out) && /secrets stored: GH_TOKEN, NPM_TOKEN/.test(setup.out) && new RegExp(`CF_CI_TRIGGER_MASTER=${prod.trigger_uuid}`).test(setup.out) && new RegExp(`CF_RELEASE_TRIGGER_DRY_RUN=${dry.trigger_uuid}`).test(setup.out) && /cf-builds\.ts build --branch master --follow/.test(setup.out), setup.out.slice(-600));
  // --github stores the variables and the secret through gh; a stub records the calls
  const stubDir = mkdtempSync(join(tmpdir(), "vb-gh-")); const stubLog = `${stubDir}/calls.log`;
  writeFileSync(`${stubDir}/gh`, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${stubLog}"\nif [ "$1" = secret ]; then cat >> "${stubLog}.stdin"; fi\n`); chmodSync(`${stubDir}/gh`, 0o755);
  const withGh = cfb(["setup", "--github"], { GH_BIN: `${stubDir}/gh` });
  const calls = existsSync(stubLog) ? readFileSync(stubLog, "utf8").trim().split("\n") : [];
  check("setup --github: five repository variables and the secret over stdin, never as an argument", withGh.code === 0 && calls.filter((c) => c.startsWith("variable set ")).length === 5 && calls.some((c) => c === `variable set CF_ACCOUNT_ID --repo voidbase-cloud/voidbase --body acc123`) && calls.some((c) => c === `variable set CF_CI_TRIGGER_BRANCHES --repo voidbase-cloud/voidbase --body ${preview.trigger_uuid}`) && calls.some((c) => c === "secret set CLOUDFLARE_BUILDS_TOKEN --repo voidbase-cloud/voidbase") && !calls.some((c) => c.includes("cf-test-user-token")) && readFileSync(`${stubLog}.stdin`, "utf8") === "cf-test-user-token" && /variables CF_ACCOUNT_ID, .* and the secret CLOUDFLARE_BUILDS_TOKEN stored/.test(withGh.out), withGh.out.slice(-300) + "\n" + calls.join("\n"));
  const again = cfb(["setup"]);
  s = await state();
  check("setup again: nothing duplicated, triggers updated in place", again.code === 0 && s.connections.length === 1 && s.triggers.length === 4 && (await scripts()).length === 2 && /updated/.test(again.out) && /exists/.test(again.out), again.out.slice(0, 300));
  const status = cfb(["status"]);
  check("status lists both projects, their triggers and no builds yet", status.code === 0 && /voidbase-ci \(tag/.test(status.out) && /voidbase-release \(tag/.test(status.out) && (status.out.match(/trigger [0-9a-f-]{36}/g) ?? []).length === 4 && /no builds yet/.test(status.out), status.out);
  const build = cfb(["build", "--branch", "master"]);
  const uuid = build.out.match(/build ([0-9a-f-]{36}) queued/)?.[1];
  check("build --branch master: queued through the master trigger", build.code === 0 && !!uuid && /trigger "voidbase-ci \(master\)"/.test(build.out), build.out);
  const dup = cfb(["build", "--branch", "master"]);
  check("the same build requested again while queued: the pending one is returned", dup.code === 0 && dup.out.includes(uuid!) && /already pending/.test(dup.out), dup.out);
  const list = cfb(["builds"]);
  check("builds lists it", list.code === 0 && list.out.includes(uuid!) && /voidbase-ci: 1 builds/.test(list.out), list.out);
  const logs = cfb(["logs", uuid!]);
  check("logs prints the timestamped build log lines and the status", logs.code === 0 && /\d\d:\d\d:\d\d  Executing user build command: bun run ci/.test(logs.out) && /status: running/.test(logs.out), logs.out);
  const follow = cfb(["build", "--commit", "abc1234", "--follow"]);
  check("build --commit --follow: waits for the end and reports success", follow.code === 0 && /Build completed/.test(follow.out) && /: success$/m.test(follow.out.trim()), follow.out);
  const dryBuild = cfb(["build", "--worker", "voidbase-release", "--dry-run"]);
  check("build --worker voidbase-release --dry-run: the dry run trigger", dryBuild.code === 0 && /trigger "voidbase-release \(dry run\)"/.test(dryBuild.out), dryBuild.out);
  const cancelMe = cfb(["build", "--worker", "voidbase-release", "--branch", "master"]).out.match(/build ([0-9a-f-]{36})/)?.[1];
  const cancel = cfb(["cancel", cancelMe!]);
  s = await state();
  check("cancel: the build is stopped with outcome cancelled", cancel.code === 0 && /cancelled/.test(cancel.out) && s.builds.find((b: { build_uuid: string }) => b.build_uuid === cancelMe)?.build_outcome === "cancelled", cancel.out);
  const envSet = cfb(["env", "--worker", "voidbase-ci", "FOO=bar", "--secret", "SEC=1"]);
  s = await state();
  check("env: sets a variable and a secret on both CI triggers, secrets never echoed", envSet.code === 0 && (envSet.out.match(/FOO=bar SEC=\(secret\)/g) ?? []).length === 2 && !envSet.out.includes("SEC=1") && s.buildEnv[prod.trigger_uuid].SEC.is_secret === true, envSet.out);
  const envOne = cfb(["env", "--worker", "voidbase-release", "--trigger", "voidbase-release (master)", "CI_BROWSER=0"]);
  check("env --trigger: one trigger only, secrets shown as (secret)", envOne.code === 0 && /CI_BROWSER=0/.test(envOne.out) && /GH_TOKEN=\(secret\)/.test(envOne.out) && !envOne.out.includes("gh-test"), envOne.out);
  // scripts/gh-release.ts against the mock's GitHub releases
  const view = ghr(["view", "v9.9.9"]);
  check("gh-release view: the release with its assets", view.code === 0 && JSON.parse(view.out).tag_name === "v9.9.9" && JSON.parse(view.out).assets.length === 0, view.out);
  const missing = ghr(["view", "v0.0.0"]);
  check("gh-release view of a missing release: exit 2", missing.code === 2 && /no release v0.0.0/.test(missing.out), missing.out);
  const dir = mkdtempSync(join(tmpdir(), "vb-ghr-")); writeFileSync(`${dir}/checksums.txt`, "abc  voidbase_9.9.9_linux_amd64.zip\n"); writeFileSync(`${dir}/voidbase_9.9.9_linux_amd64.zip`, "zip");
  const up = ghr(["upload", "v9.9.9", `${dir}/checksums.txt`, `${dir}/voidbase_9.9.9_linux_amd64.zip`]);
  const up2 = ghr(["upload", "v9.9.9", `${dir}/checksums.txt`]);
  s = await state();
  check("gh-release upload: attaches files, a second upload replaces the same-named asset", up.code === 0 && up2.code === 0 && /replaced/.test(up2.out) && s.ghReleases[0].assets.length === 2 && s.ghReleases[0].assets.filter((a: { name: string }) => a.name === "checksums.txt").length === 1, up.out + up2.out);
  writeFileSync(`${dir}/notes.md`, "> _To update the prebuilt executable you can run `./voidbase update`._\n\n### Features\n");
  const notes = ghr(["notes", "v9.9.9", `${dir}/notes.md`]); const body = ghr(["body", "v9.9.9"]);
  check("gh-release notes then body: the notes are replaced", notes.code === 0 && body.code === 0 && body.out.startsWith("> _To update the prebuilt executable"), notes.out + body.out);
} finally { mock.kill(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
