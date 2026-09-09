// Cloudflare Workers Builds for this repository through the Builds REST API (docs/ci.md): connects the GitHub
// repository, creates the CI project (a Worker that serves its status page) with its three triggers, build variables
// and secrets, triggers builds and follows their logs. The release flow runs inside the CI build (scripts/ci.sh).
//   bun scripts/cf-builds.ts setup [--repo voidbase-cloud/voidbase] [--ci voidbase-ci] [--builder voidbase-builder] [--branch master] [--domain release.voidbase.cloud] [--cloud https://voidbase.cloud]
//   bun scripts/cf-builds.ts status [--ci voidbase-ci]
//   bun scripts/cf-builds.ts build [--worker voidbase-ci] [--branch master | --commit <sha>] [--trigger <name>] [--follow]
//   bun scripts/cf-builds.ts builds [--worker voidbase-ci]
//   bun scripts/cf-builds.ts logs <build-uuid> [--follow]
//   bun scripts/cf-builds.ts cancel <build-uuid>
//   bun scripts/cf-builds.ts env [--worker voidbase-ci] [--trigger <name>] KEY=value ... [--secret KEY=value] ...
//   bun scripts/cf-builds.ts hot on|off [--budget 60]          hot mode on the CI triggers (docs/ci.md): CI_HOT and CI_HOT_BUDGET
//   bun scripts/cf-builds.ts remove <worker>                     deletes a project's triggers and its Worker
// Auth: CLOUDFLARE_BUILDS_TOKEN, a *user* API token (My Profile > API Tokens) with "Workers Builds Configuration: Edit"
// and "Workers Scripts: Edit"; the Builds API rejects account-owned tokens. CLOUDFLARE_ACCOUNT_ID picks the account when
// the token reaches several. `setup` stores the release secrets from the environment on the master trigger when they
// are set: GH_TOKEN (release-please, release assets), NPM_TOKEN or VOIDBASE_NPM_TOKEN, GH_PACKAGES_TOKEN. With CI_CACHE_TOKEN (an
// API token with Workers R2 Storage edit; VOIDBASE_DEPLOY_CF_API_KEY is accepted) it creates the R2 bucket the builds
// keep their downloads in (--cache-bucket, default voidbase-ci-cache) and stores the token on every trigger. Every push
// builds: master on the master trigger, any other branch on the branches trigger, except release-please's own branch,
// whose diff the master build already ran. A Worker takes two triggers at most (the API says 12030 to a third), so
// the instance builder is a second Worker, `voidbase-builder` (a placeholder script that serves nothing), with one
// trigger, `voidbase-builder (instance-build)`, that never builds on push: it runs scripts/instance-build.ts for
// cloud instances and is started by the control plane (--cloud, or VB_CLOUD_URL; the builder's superuser there from
// VB_BUILD_EMAIL and VB_BUILD_PASSWORD). CLOUDFLARE_API_BASE and GITHUB_API_URL point everything at test/cf-mock.ts.
import { CfApi, CfError, ensureR2, resolveAccount, workersSubdomain } from "../src/cloud/rest";

const [cmd = "status", ...rest] = process.argv.slice(2);
const args: Record<string, string> = {}; const positional: string[] = []; const secretArgs: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (a === "--secret") secretArgs.push(rest[++i] ?? "");
  else if (a.startsWith("--")) { const v = rest[i + 1]; if (v !== undefined && !v.startsWith("--")) { args[a.slice(2)] = v; i++; } else args[a.slice(2)] = "1"; }
  else positional.push(a);
}
const token = process.env.CLOUDFLARE_BUILDS_TOKEN;
if (!token) {
  console.error("CLOUDFLARE_BUILDS_TOKEN is not set. The Builds API takes a user API token (dash.cloudflare.com/profile/api-tokens) with\n  Workers Builds Configuration: Edit and Workers Scripts: Edit; account-owned tokens (VOIDBASE_DEPLOY_CF_API_KEY) are rejected.");
  process.exit(1);
}
const cf = new CfApi(token, process.env.CLOUDFLARE_API_BASE);
const GITHUB_API = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
const CI = args.ci ?? "voidbase-ci", BRANCH = args.branch ?? "master", BUILDER = args.builder ?? "voidbase-builder";
// release-please's branch, by its exact name: the Builds API takes no wildcard in a branch filter
const RELEASE_BRANCH = `release-please--branches--${BRANCH}--components--${args.component ?? "voidbase"}`;
const BUN_VERSION = "1.3.14";  // the version CI pins on every trigger; the image's default is older
// the three verbs every project answers (docs/ci.md): scripts/pipeline.ts reads what they mean from the environment
const DEPLOY = "bun run deploy";
const PREVIEW = "bun run version";
const CI_BUILD = "bun run build";
const INSTANCE_BUILD = "bun scripts/instance-build.ts";
const INSTANCE_DEPLOY = 'echo "instance builds reach their instances through the control plane; nothing to deploy here"';
const triggerNames = { ciMaster: `${CI} (${BRANCH})`, ciBranches: `${CI} (branches)`, instanceBuild: `${BUILDER} (instance-build)` };

interface Trigger { trigger_uuid: string; trigger_name: string; external_script_id?: string; build_command?: string; deploy_command?: string; root_directory?: string; branch_includes?: string[]; branch_excludes?: string[]; path_includes?: string[]; path_excludes?: string[]; build_caching_enabled?: boolean; [k: string]: unknown }
interface Build { build_uuid: string; status?: string; build_outcome?: string; created_on?: string; created_at?: string; stopped_on?: string; build_trigger_metadata?: { branch?: string; commit_hash?: string; [k: string]: unknown }; [k: string]: unknown }
type EnvVars = Record<string, { value: string; is_secret: boolean }>;

const die: (m: string) => never = (m) => { console.error(m); process.exit(1); };
const guide: (e: unknown) => never = (e) => {
  if (e instanceof CfError && e.path.includes("/builds/") && (e.has(10000) || e.status === 401 || e.status === 403))
    die(`${e.message}\n  The Builds API accepts user tokens only: create one at dash.cloudflare.com/profile/api-tokens with Workers Builds\n  Configuration: Edit and Workers Scripts: Edit, and put it in CLOUDFLARE_BUILDS_TOKEN (account-owned tokens are rejected).`);
  die(e instanceof Error ? e.message : String(e));
};
const account = await resolveAccount(cf, process.env.CLOUDFLARE_ACCOUNT_ID).catch(guide);
const A = `/accounts/${account.id}`;
const dash = (name: string) => `https://dash.cloudflare.com/${account.id}/workers/services/view/${name}`;

async function workers(): Promise<{ id: string; tag?: string }[]> { return (await cf.json<{ id: string; tag?: string }[]>("GET", `${A}/workers/scripts`)).result ?? []; }
async function workerTag(name: string): Promise<string> {
  const w = (await workers()).find((s) => s.id === name);
  return w?.tag ?? die(`no Worker ${name} on account ${account.name}; run \`bun scripts/cf-builds.ts setup\` first`);
}
async function ensureWorker(name: string): Promise<{ tag: string; created: boolean }> {
  const found = (await workers()).find((s) => s.id === name);
  if (found?.tag) return { tag: found.tag, created: false };
  // a placeholder Worker so the project exists; the first build replaces it with the status page (assets only)
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify({ main_module: "index.js", compatibility_date: "2026-01-01" })], { type: "application/json" }));
  form.set("index.js", new File([`export default { fetch: () => new Response("${name}: no build yet\\n") };`], "index.js", { type: "application/javascript+module" }));
  await cf.form("PUT", `${A}/workers/scripts/${name}`, form);
  const tag = (await workers()).find((s) => s.id === name)?.tag ?? die(`Worker ${name} uploaded but not listed with a tag`);
  return { tag, created: true };
}
async function triggers(tag: string): Promise<Trigger[]> { return (await cf.json<Trigger[]>("GET", `${A}/builds/workers/${tag}/triggers`)).result ?? []; }
async function ensureTrigger(tag: string, connection: string, buildToken: string, want: Omit<Trigger, "trigger_uuid">, byNameOnly = false): Promise<{ uuid: string; created: boolean }> {
  // adopt a trigger by name, else by shape (the dashboard wizard names its production and preview triggers itself);
  // a trigger that shares a shape with another on purpose (the instance builder builds master too) is adopted by name only
  const same = (a: unknown, b: unknown) => JSON.stringify([...((a as string[] | undefined) ?? [])].sort()) === JSON.stringify([...((b as string[] | undefined) ?? [])].sort());
  const all = await triggers(tag);
  const existing = all.find((t) => t.trigger_name === want.trigger_name) ?? (byNameOnly ? undefined : all.find((t) => same(t.branch_includes, want.branch_includes) && same(t.branch_excludes, want.branch_excludes)));
  if (existing) { await cf.json("PATCH", `${A}/builds/triggers/${existing.trigger_uuid}`, { ...want, build_token_uuid: buildToken }); return { uuid: existing.trigger_uuid, created: false }; }
  const r = await cf.json<Trigger>("POST", `${A}/builds/triggers`, { ...want, external_script_id: tag, repo_connection_uuid: connection, build_token_uuid: buildToken });
  return { uuid: r.result.trigger_uuid, created: true };
}
async function setEnv(trigger: string, vars: EnvVars): Promise<void> { if (Object.keys(vars).length) await cf.json("PATCH", `${A}/builds/triggers/${trigger}/environment_variables`, vars); }
async function latestBuild(tag: string): Promise<Build | null> { const r = await cf.json<Build[]>("GET", `${A}/builds/workers/${tag}/builds`); return (r.result ?? [])[0] ?? null; }
const when = (b: Build) => b.created_on ?? b.created_at ?? "";
// the live API ends a build with status "stopped" and build_outcome "success" | "fail"; older shapes put the outcome in status
const outcome = (b: Build | null | undefined): string => { if (!b) return ""; const st = b.status ?? ""; if (st === "stopped") return b.build_outcome === "success" ? "success" : b.build_outcome ? `failed (${b.build_outcome})` : "stopped"; return FINAL.has(st) ? st : ""; };
const describe = (b: Build) => `${b.build_uuid}  ${(outcome(b) || b.status || "?").padEnd(16)} ${(b.build_trigger_metadata?.branch ?? "").padEnd(12)} ${(b.build_trigger_metadata?.commit_hash ?? "").slice(0, 10).padEnd(10)} ${when(b)}`;
type LogLine = { line?: string; message?: string; ts?: string } | string | [number, string];
interface LogsResult { lines?: LogLine[]; status?: string; build?: { status?: string } }
async function printLogs(uuid: string, from = 0): Promise<{ next: number; status: string }> {
  // a build that is still queued has no log yet: treat a failed fetch as "nothing so far" and keep polling
  const r = await cf.json<LogsResult>("GET", `${A}/builds/builds/${uuid}/logs`).catch((): { result: LogsResult } => ({ result: { lines: [] } }));
  const lines = r.result?.lines ?? [];
  if (lines.length < from) return { next: from, status: "" };
  // the live API returns [unix ms, text] pairs; the mock returns {ts, line}
  const text = (l: LogLine) => (typeof l === "string" ? l : Array.isArray(l) ? `${new Date(l[0]).toISOString().slice(11, 19)}  ${l[1]}` : `${l.ts ? l.ts + "  " : ""}${l.line ?? l.message ?? JSON.stringify(l)}`);
  for (const l of lines.slice(from)) console.log(text(l));
  let status = outcome({ build_uuid: uuid, status: r.result?.status ?? r.result?.build?.status, build_outcome: (r.result as { build_outcome?: string } | undefined)?.build_outcome });
  if (!status) { const b = await cf.json<Build>("GET", `${A}/builds/builds/${uuid}`, undefined, [10000]).catch(() => null); status = outcome(b?.result); if (!status && b?.result?.status) status = ""; }
  return { next: lines.length, status };
}
const FINAL = new Set(["success", "failure", "failed", "canceled", "cancelled", "timed_out", "error"]);
async function follow(uuid: string): Promise<void> {
  let from = 0, status = "";
  for (;;) {
    const r = await printLogs(uuid, from); from = r.next; status = r.status;
    if (status) break;
    await Bun.sleep(Number(process.env.CF_BUILDS_POLL_MS ?? 5000));
  }
  console.log(`build ${uuid}: ${status}`);
  if (status !== "success") process.exit(1);
}

try {
  if (cmd === "setup") {
    const repo = args.repo ?? "voidbase-cloud/voidbase";
    const gh = await fetch(`${GITHUB_API}/repos/${repo}`, { headers: { accept: "application/vnd.github+json", "user-agent": "voidbase-cf-builds", ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) } });
    if (!gh.ok) die(`GitHub: ${gh.status} for ${repo}`);
    const info = (await gh.json()) as { id: number; name: string; owner: { id: number; login: string }; default_branch: string };
    console.log(`account ${account.name} (${account.id}); repository ${repo} (id ${info.id}, owner ${info.owner.login} ${info.owner.id})`);
    // 1. the repository connection (needs the "Cloudflare Workers and Pages" GitHub App installed for the repository)
    const conn = await cf.json<{ repo_connection_uuid?: string; uuid?: string; id?: string }>("PUT", `${A}/builds/repos/connections`, { provider_type: "github", provider_account_id: String(info.owner.id), provider_account_name: info.owner.login, repo_id: String(info.id), repo_name: info.name });
    const connection = conn.result?.repo_connection_uuid ?? conn.result?.uuid ?? conn.result?.id ?? die(`connection created but no uuid in ${JSON.stringify(conn.result)}`);
    console.log(`repository connection ${connection}`);
    // 2. the projects' Workers first, so the dashboard link below points at something that exists
    const ci = await ensureWorker(CI);
    console.log(`Worker ${CI}: ${ci.created ? "created" : "exists"} (tag ${ci.tag})`);
    const bw = await ensureWorker(BUILDER);
    console.log(`Worker ${BUILDER}: ${bw.created ? "created" : "exists"} (tag ${bw.tag}); a placeholder, its trigger builds instances`);
    // 3. the build token Workers Builds deploys with (the dashboard creates one under Settings > Builds > API token)
    const tokens = (await cf.json<{ build_token_uuid: string; build_token_name?: string }[]>("GET", `${A}/builds/tokens`)).result ?? [];
    const buildToken = tokens[0]?.build_token_uuid ?? die(`no build token on the account yet: open ${dash(CI)} > Settings > Builds > API token > Create new token once, then rerun setup`);
    console.log(`build token ${buildToken}${tokens[0]?.build_token_name ? ` (${tokens[0].build_token_name})` : ""}`);
    // every push builds (watch paths that include everything); release-please's branch is the one exception, since
    // its diff is a changelog and a version generated from commits the master build already ran
    const common = { root_directory: "/", path_includes: ["*"], path_excludes: [], build_caching_enabled: true };
    const prod = await ensureTrigger(ci.tag, connection, buildToken, { trigger_name: triggerNames.ciMaster, build_command: CI_BUILD, deploy_command: DEPLOY, branch_includes: [BRANCH], branch_excludes: [], ...common });
    const preview = await ensureTrigger(ci.tag, connection, buildToken, { trigger_name: triggerNames.ciBranches, build_command: CI_BUILD, deploy_command: PREVIEW, branch_includes: ["*"], branch_excludes: [BRANCH, RELEASE_BRANCH], ...common });
    // the instance builder: master's code on its own Worker, started through the API by the control plane and never by a push
    const builder = await ensureTrigger(bw.tag, connection, buildToken, { trigger_name: triggerNames.instanceBuild, build_command: INSTANCE_BUILD, deploy_command: INSTANCE_DEPLOY, branch_includes: [BRANCH], branch_excludes: [], root_directory: "/", path_includes: ["*"], path_excludes: ["*"], build_caching_enabled: false });
    // the record of the last green run of master, which scripts/ci-plan.ts compares the inputs against: the status
    // page's canonical address (--domain, the custom domain ci/wrangler.jsonc declares), else the workers.dev one
    const domain = args.domain ?? process.env.CI_DOMAIN ?? "release.voidbase.cloud";
    const sub = domain ? null : await workersSubdomain(cf, account.id).catch(() => null);
    const statusUrl = domain ? `https://${domain}/status.json` : sub ? `https://${CI}.${sub}.workers.dev/status.json` : "";
    // the bucket scripts/ci-cache.sh keeps the downloads in between builds (Workers Builds keeps nothing else)
    const cacheToken = process.env.CI_CACHE_TOKEN ?? process.env.VOIDBASE_DEPLOY_CF_API_KEY; const bucket = args["cache-bucket"] ?? "voidbase-ci-cache";
    let cacheVars: EnvVars = {};
    if (cacheToken) {
      const r = await ensureR2(new CfApi(cacheToken, process.env.CLOUDFLARE_API_BASE), account.id, bucket).catch((e: unknown) => { console.log(`cache bucket ${bucket}: ${e instanceof Error ? e.message : e}`); return null; });
      if (r) { console.log(`cache bucket ${bucket}: ${r.created ? "created" : "exists"}`); cacheVars = { CI_CACHE_BUCKET: { value: bucket, is_secret: false }, CI_CACHE_ACCOUNT: { value: account.id, is_secret: false }, CI_CACHE_TOKEN: { value: cacheToken, is_secret: true } }; }
    } else console.log("cache bucket: skipped (set CI_CACHE_TOKEN, an API token with Workers R2 Storage edit, to keep downloads between builds)");
    const vars: EnvVars = { BUN_VERSION: { value: BUN_VERSION, is_secret: false }, CI_BROWSER: { value: "1", is_secret: false }, ...(statusUrl ? { CI_STATUS_URL: { value: statusUrl, is_secret: false } } : {}), ...cacheVars };
    // the release secrets on the master trigger only: builds of other branches never carry them
    const secrets: EnvVars = {};
    const ghTok = process.env.GH_TOKEN, npmTok = process.env.NPM_TOKEN ?? process.env.VOIDBASE_NPM_TOKEN, ghpTok = process.env.GH_PACKAGES_TOKEN;
    if (ghTok) secrets.GH_TOKEN = { value: ghTok, is_secret: true };
    if (npmTok) secrets.NPM_TOKEN = { value: npmTok, is_secret: true };
    if (ghpTok) secrets.GH_PACKAGES_TOKEN = { value: ghpTok, is_secret: true };
    await setEnv(prod.uuid, { ...vars, ...secrets }); await setEnv(preview.uuid, vars);
    // the builder's three variables: where the control plane is, and the superuser it claims builds as
    const cloud = (args.cloud ?? process.env.VB_CLOUD_URL ?? "https://voidbase.cloud").replace(/\/+$/, "");
    const builderVars: EnvVars = { BUN_VERSION: { value: BUN_VERSION, is_secret: false }, VB_CLOUD_URL: { value: cloud, is_secret: false } };
    if (process.env.VB_BUILD_EMAIL) builderVars.VB_BUILD_EMAIL = { value: process.env.VB_BUILD_EMAIL, is_secret: true };
    if (process.env.VB_BUILD_PASSWORD) builderVars.VB_BUILD_PASSWORD = { value: process.env.VB_BUILD_PASSWORD, is_secret: true };
    await setEnv(builder.uuid, builderVars);
    if (statusUrl) console.log(`  CI_STATUS_URL ${statusUrl} (the last green run's record, for incremental runs)`);
    console.log(`  release secrets on the ${BRANCH} trigger: ${Object.keys(secrets).join(", ") || "none (set GH_TOKEN and NPM_TOKEN in the environment and rerun, or `env --trigger \"" + triggerNames.ciMaster + "\" --secret GH_TOKEN=...`)"}`);
    console.log(`  trigger ${prod.uuid} ${BRANCH}: ${prod.created ? "created" : "updated"}; build \`${CI_BUILD}\`, deploy \`${DEPLOY}\``);
    console.log(`  trigger ${preview.uuid} other branches: ${preview.created ? "created" : "updated"}; deploy \`${PREVIEW}\` (preview URL on the pull request)`);
    console.log(`  trigger ${builder.uuid} instance builds on ${BUILDER}: ${builder.created ? "created" : "updated"}; build \`${INSTANCE_BUILD}\` for ${cloud}, started by the control plane, never by a push; builder superuser ${builderVars.VB_BUILD_EMAIL && builderVars.VB_BUILD_PASSWORD ? "stored" : "not set (VB_BUILD_EMAIL and VB_BUILD_PASSWORD in the environment, or `env --worker " + BUILDER + " --secret ...`)"}`);
    console.log(`\ndone. Every push to ${repo} builds on ${dash(CI)}. First build: bun scripts/cf-builds.ts build --branch ${BRANCH} --follow`);
  } else if (cmd === "status") {
    for (const name of [CI, BUILDER]) {
      const w = (await workers()).find((s) => s.id === name);
      if (!w?.tag) { console.log(`${name}: no such Worker`); continue; }
      const ts = await triggers(w.tag); const last = await latestBuild(w.tag);
      console.log(`${name} (tag ${w.tag}) ${dash(name)}`);
      for (const t of ts) console.log(`  trigger ${t.trigger_uuid}  ${t.trigger_name}: branches ${JSON.stringify(t.branch_includes ?? [])}${t.branch_excludes?.length ? ` minus ${JSON.stringify(t.branch_excludes)}` : ""}; build \`${t.build_command ?? ""}\`; deploy \`${t.deploy_command ?? ""}\``);
      console.log(last ? `  latest build: ${describe(last)}` : "  no builds yet");
    }
  } else if (cmd === "build") {
    const name = args.worker ?? CI; const tag = await workerTag(name);
    const ts = await triggers(tag); const branch = args.commit ? undefined : args.branch ?? BRANCH;
    const wanted = args.trigger;
    const t = wanted ? ts.find((x) => x.trigger_name === wanted) : ts.find((x) => (branch ? (x.branch_includes ?? []).includes(branch) : true)) ?? ts[0];
    if (!t) die(`no trigger on ${name}`);
    const body = args.commit ? { commit_hash: args.commit, ...(args.branch ? { branch: args.branch } : {}) } : { branch };
    const r = await cf.json<{ build_uuid: string; status?: string; already_exists?: boolean }>("POST", `${A}/builds/triggers/${t.trigger_uuid}/builds`, body);
    console.log(`build ${r.result.build_uuid} ${r.result.status ?? "queued"} on ${name} via trigger "${t.trigger_name}" (${JSON.stringify(body)})${r.result.already_exists ? " (already pending)" : ""}`);
    if (args.follow) await follow(r.result.build_uuid);
  } else if (cmd === "builds") {
    const name = args.worker ?? CI; const tag = await workerTag(name);
    const list = (await cf.json<Build[]>("GET", `${A}/builds/workers/${tag}/builds`)).result ?? [];
    if (args.json) console.log(JSON.stringify(list, null, 2)); else { console.log(`${name}: ${list.length} builds`); for (const b of list) console.log("  " + describe(b)); }
  } else if (cmd === "logs") {
    const uuid = positional[0] ?? die("logs: build uuid missing");
    if (args.follow) await follow(uuid); else { const r = await printLogs(uuid); const b = await cf.json<Build>("GET", `${A}/builds/builds/${uuid}`, undefined, [10000]).catch(() => null); console.log(`status: ${r.status || b?.result?.status || "unknown"}`); }
  } else if (cmd === "cancel") {
    const uuid = positional[0] ?? die("cancel: build uuid missing");
    await cf.json("PUT", `${A}/builds/builds/${uuid}/cancel`); console.log(`build ${uuid} cancelled`);
  } else if (cmd === "env") {
    const name = args.worker ?? CI; const tag = await workerTag(name); const ts = await triggers(tag);
    const targets = args.trigger ? ts.filter((t) => t.trigger_name === args.trigger) : ts;
    if (!targets.length) die(`no trigger${args.trigger ? ` named ${args.trigger}` : ""} on ${name}`);
    const vars: EnvVars = {};
    for (const kv of positional) { const i = kv.indexOf("="); if (i < 1) die(`expected KEY=value, got ${kv}`); vars[kv.slice(0, i)] = { value: kv.slice(i + 1), is_secret: false }; }
    for (const kv of secretArgs) { const i = kv.indexOf("="); if (i < 1) die(`expected --secret KEY=value, got ${kv}`); vars[kv.slice(0, i)] = { value: kv.slice(i + 1), is_secret: true }; }
    for (const t of targets) {
      if (Object.keys(vars).length) await setEnv(t.trigger_uuid, vars);
      const now = (await cf.json<EnvVars>("GET", `${A}/builds/triggers/${t.trigger_uuid}/environment_variables`)).result ?? {};
      console.log(`${name} "${t.trigger_name}": ${Object.entries(now).map(([k, v]) => `${k}=${v.is_secret ? "(secret)" : v.value}`).join(" ") || "(no variables)"}`);
    }
  } else if (cmd === "remove") {
    const name = positional[0] ?? die("remove: worker name missing");
    const w = (await workers()).find((s) => s.id === name); if (!w) die(`no Worker ${name}`);
    if (w.tag) for (const t of await triggers(w.tag)) { await cf.json("DELETE", `${A}/builds/triggers/${t.trigger_uuid}`, undefined, [10000, 12000]).catch(() => null); console.log(`trigger ${t.trigger_uuid} "${t.trigger_name}" removed`); }
    await cf.json("DELETE", `${A}/workers/scripts/${name}`); console.log(`Worker ${name} removed`);
  } else if (cmd === "hot") {
    const on = positional[0] === "on"; if (!on && positional[0] !== "off") die("usage: bun scripts/cf-builds.ts hot on|off [--budget 60]");
    const tag = await workerTag(CI); const vars: EnvVars = { CI_HOT: { value: on ? "1" : "0", is_secret: false }, ...(args.budget ? { CI_HOT_BUDGET: { value: args.budget, is_secret: false } } : {}) };
    for (const t of await triggers(tag)) await setEnv(t.trigger_uuid, vars);
    console.log(`hot mode ${on ? "on" : "off"} for ${CI}${args.budget ? ` (budget ${args.budget}s)` : ""}: the next builds ${on ? "keep the checks within the budget and defer the rest" : "run every check the changes reach"}`);
  } else die("usage: bun scripts/cf-builds.ts setup|status|build|builds|logs|cancel|env|hot|remove ... (see the header of the script)");
} catch (e) { guide(e); }
