// scripts/cf-builds.ts and scripts/gh-release.ts against test/cf-mock.ts: the Builds API wants the user token, setup
// connects the repository and creates the CI Worker with its one trigger (master builds on push, with the variables
// and the release secrets), removes any other trigger on it (the branches and instance-build triggers of earlier
// layouts), idempotently; a Worker's third trigger is refused the way the live API refuses it; builds are triggered, listed, followed and cancelled, variables set, a project removed; release
// assets are uploaded, replaced and the notes rewritten through GitHub's API.
//   bun test/cf-builds.ts        (starts its own cf-mock on a free port)
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const PORT = probe.port; probe.stop(true);
// the mock is the package's own test server; cf-builds.ts and gh-release.ts are the repository's tooling and run
// from the workspace root
const MOCK = `http://127.0.0.1:${PORT}`; const PKG = resolve(import.meta.dir, ".."); const ROOT = resolve(PKG, "../..");
const mock = Bun.spawn(["bun", "test/cf-mock.ts", String(PORT)], { cwd: PKG, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 50; i++) { try { await fetch(`${MOCK}/__state`); break; } catch { await Bun.sleep(100); } }
let pass = 0, fail = 0; const check = (l: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}${ok ? "" : "  " + d}`); };
const base: Record<string, string | undefined> = { ...process.env, CLOUDFLARE_API_BASE: MOCK, GITHUB_API_URL: MOCK, CLOUDFLARE_ACCOUNT_ID: "acc123", GH_TOKEN: "gh-test", NPM_TOKEN: "npm-test", CI_CACHE_TOKEN: "cf-test-token", GH_PACKAGES_TOKEN: undefined, VOIDBASE_NPM_TOKEN: undefined, CF_BUILDS_POLL_MS: "50", GITHUB_REPOSITORY: "voidbase-cloud/voidbase", VB_BUILD_EMAIL: "builds@example.com", VB_BUILD_PASSWORD: "build-pass", VB_CLOUD_URL: undefined };
const run = (script: string, args: string[], env: Record<string, string | undefined> = {}) => { const p = Bun.spawnSync(["bun", `scripts/${script}`, ...args], { cwd: ROOT, env: { ...base, ...env } as Record<string, string>, stdout: "pipe", stderr: "pipe" }); return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }; };
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
  check("setup: repository connected, one CI Worker with a tag, one trigger", setup.code === 0 && s.connections.length === 1 && s.connections[0].repo_id === "1359087906" && s.connections[0].provider_account_name === "voidbase-cloud" && !!tagOf("voidbase-ci") && (await scripts()).length === 1 && s.triggers.length === 1, setup.out.slice(0, 400));
  const prod = byName("voidbase-ci (master)");
  check("the wizard's production trigger was adopted: same uuid, renamed, commands replaced, connection reused", prod?.trigger_uuid === wizard.result.trigger_uuid && prod.build_command === "bun run build" && s.connections[0].repo_connection_uuid === pre.result.repo_connection_uuid, JSON.stringify(prod));
  check("the CI production trigger: master, the three verbs (build, deploy), cache on", prod?.external_script_id === tagOf("voidbase-ci") && prod.build_command === "bun run build" && prod.deploy_command === "bun run deploy" && JSON.stringify(prod.branch_includes) === '["master"]' && prod.build_caching_enabled === true && prod.build_token_uuid === "bt-1", JSON.stringify(prod));
  check("no branches trigger, no instance-build trigger: other branches build nowhere", !byName("voidbase-ci (branches)") && !byName("voidbase-ci (instance-build)") && s.triggers.length === 1, JSON.stringify(s.triggers.map((t: { trigger_name: string }) => t.trigger_name)));
  check("every push to master builds: the master trigger's watch paths exclude nothing", JSON.stringify(prod.path_includes) === '["*"]' && JSON.stringify(prod.path_excludes) === '[]', JSON.stringify(prod));
  check("the cache bucket exists and the master trigger knows it, the R2 token as a secret", Object.keys(s.r2 ?? {}).includes("voidbase-ci-cache") && [prod].every((t) => s.buildEnv[t.trigger_uuid]?.CI_CACHE_BUCKET?.value === "voidbase-ci-cache" && s.buildEnv[t.trigger_uuid]?.CI_CACHE_ACCOUNT?.value === "acc123" && s.buildEnv[t.trigger_uuid]?.CI_CACHE_TOKEN?.is_secret === true) && /cache bucket voidbase-ci-cache: created/.test(setup.out), JSON.stringify(Object.keys(s.r2 ?? {})) + setup.out.slice(0, 200));
  check("the status record URL points at the canonical domain", s.buildEnv[prod.trigger_uuid]?.CI_STATUS_URL?.value === "https://release.voidbase.cloud/status.json", JSON.stringify(s.buildEnv[prod.trigger_uuid]));
  check("build variables: BUN_VERSION and the release secrets on the master trigger", s.buildEnv[prod.trigger_uuid]?.BUN_VERSION?.value === "1.3.14" && s.buildEnv[prod.trigger_uuid]?.GH_TOKEN?.value === "gh-test" && s.buildEnv[prod.trigger_uuid]?.GH_TOKEN?.is_secret === true && s.buildEnv[prod.trigger_uuid]?.NPM_TOKEN?.is_secret === true && !s.buildEnv[prod.trigger_uuid]?.GH_PACKAGES_TOKEN && true, JSON.stringify(s.buildEnv));
  check("setup's summary names what it created, the secrets and how to start the first build", /created/.test(setup.out) && /release secrets on the master trigger: GH_TOKEN, NPM_TOKEN/.test(setup.out) && /Every push to voidbase-cloud\/voidbase builds/.test(setup.out) && /cf-builds\.ts build --branch master --follow/.test(setup.out) && !/\.github/.test(setup.out), setup.out.slice(-700));
  const again = cfb(["setup"]);
  s = await state();
  check("setup again: nothing duplicated, the trigger updated in place", again.code === 0 && s.connections.length === 1 && s.triggers.length === 1 && (await scripts()).length === 1 && /updated/.test(again.out) && /exists/.test(again.out), again.out.slice(0, 300));
  const second = await fetch(`${MOCK}/accounts/acc123/builds/triggers`, { method: "POST", headers: { authorization: "Bearer cf-test-user-token", "content-type": "application/json" }, body: JSON.stringify({ external_script_id: preTag, repo_connection_uuid: pre.result.repo_connection_uuid, build_token_uuid: "bt-1", trigger_name: "second one too many", branch_includes: ["master"], branch_excludes: [] }) });
  const third = await fetch(`${MOCK}/accounts/acc123/builds/triggers`, { method: "POST", headers: { authorization: "Bearer cf-test-user-token", "content-type": "application/json" }, body: JSON.stringify({ external_script_id: preTag, repo_connection_uuid: pre.result.repo_connection_uuid, build_token_uuid: "bt-1", trigger_name: "one too many", branch_includes: ["master"], branch_excludes: [] }) });
  const secondId = ((await second.json()) as { result?: { trigger_uuid?: string } }).result?.trigger_uuid ?? "";
  if (secondId) await fetch(`${MOCK}/accounts/acc123/builds/triggers/${secondId}`, { method: "DELETE", headers: { authorization: "Bearer cf-test-user-token" } });
  check("a Worker's second trigger is allowed and its third refused with 12030, the way the live API refuses it", second.status < 300 && third.status === 400 && /12030/.test(await third.text()), String(third.status));
  const status = cfb(["status"]);
  check("status lists the project, its trigger and no builds yet", status.code === 0 && /voidbase-ci \(tag/.test(status.out) && (status.out.match(/trigger [0-9a-f-]{36}/g) ?? []).length === 1 && /no builds yet/.test(status.out), status.out);
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
  // a project from the time the release flow had its own: remove deletes its triggers and its Worker
  const oldForm = new FormData(); oldForm.set("metadata", new Blob([JSON.stringify({ main_module: "index.js" })], { type: "application/json" })); oldForm.set("index.js", new File(["export default {}"], "index.js", { type: "application/javascript+module" }));
  await fetch(`${MOCK}/accounts/acc123/workers/scripts/voidbase-release`, { method: "PUT", headers: { authorization: "Bearer cf-test-user-token" }, body: oldForm });
  const oldTag = (await scripts()).find((x) => x.id === "voidbase-release")!.tag;
  await fetch(`${MOCK}/accounts/acc123/builds/triggers`, { method: "POST", headers: { authorization: "Bearer cf-test-user-token", "content-type": "application/json" }, body: JSON.stringify({ external_script_id: oldTag, repo_connection_uuid: pre.result.repo_connection_uuid, build_token_uuid: "bt-1", trigger_name: "voidbase-release (master)", branch_includes: ["master"], branch_excludes: [] }) });
  const removed = cfb(["remove", "voidbase-release"]); s = await state();
  check("remove: the old release project's trigger and Worker are gone", removed.code === 0 && /trigger .* removed/.test(removed.out) && /Worker voidbase-release removed/.test(removed.out) && s.triggers.length === 1 && (await scripts()).length === 1, removed.out);
  const cancelMe = cfb(["build", "--worker", "voidbase-ci", "--branch", "master"]).out.match(/build ([0-9a-f-]{36})/)?.[1];
  const cancel = cfb(["cancel", cancelMe!]);
  s = await state();
  check("cancel: the build is stopped with outcome cancelled", cancel.code === 0 && /cancelled/.test(cancel.out) && s.builds.find((b: { build_uuid: string }) => b.build_uuid === cancelMe)?.build_outcome === "cancelled", cancel.out);
  const envSet = cfb(["env", "--worker", "voidbase-ci", "FOO=bar", "--secret", "SEC=1"]);
  s = await state();
  check("env: sets a variable and a secret on the CI trigger, secrets never echoed", envSet.code === 0 && (envSet.out.match(/FOO=bar SEC=\(secret\)/g) ?? []).length === 1 && !envSet.out.includes("SEC=1") && s.buildEnv[prod.trigger_uuid].SEC.is_secret === true, envSet.out);
  const envOne = cfb(["env", "--worker", "voidbase-ci", "--trigger", "voidbase-ci (master)", "CI_BROWSER=0"]);
  check("env --trigger: one trigger only, secrets shown as (secret)", envOne.code === 0 && (envOne.out.match(/CI_BROWSER=0/g) ?? []).length === 1 && /GH_TOKEN=\(secret\)/.test(envOne.out) && !envOne.out.includes("gh-test"), envOne.out);
  const hotOn = cfb(["hot", "on", "--budget", "45"]); s = await state();
  check("hot on: CI_HOT=1 and the budget on the CI trigger", hotOn.code === 0 && [prod].every((t) => s.buildEnv[t.trigger_uuid]?.CI_HOT?.value === "1" && s.buildEnv[t.trigger_uuid]?.CI_HOT_BUDGET?.value === "45"), hotOn.out);
  const hotOff = cfb(["hot", "off"]); s = await state();
  check("hot off: CI_HOT=0", hotOff.code === 0 && s.buildEnv[prod.trigger_uuid]?.CI_HOT?.value === "0" && /run every check/.test(hotOff.out), hotOff.out);
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
