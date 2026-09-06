// Cloudflare Workers Builds for this repository through the Builds REST API (docs/ci.md): connects the GitHub
// repository, creates the CI project and the release project (each a Worker that serves its status page) with their
// triggers and build variables, triggers builds and follows their logs.
//   bun scripts/cf-builds.ts setup [--repo voidbase-cloud/voidbase] [--ci voidbase-ci] [--release voidbase-release] [--branch master] [--no-release] [--github]
//   bun scripts/cf-builds.ts status [--ci voidbase-ci] [--release voidbase-release]
//   bun scripts/cf-builds.ts build [--worker voidbase-ci] [--branch master | --commit <sha>] [--trigger <name> | --dry-run] [--follow]
//   bun scripts/cf-builds.ts builds [--worker voidbase-ci]
//   bun scripts/cf-builds.ts logs <build-uuid> [--follow]
//   bun scripts/cf-builds.ts cancel <build-uuid>
//   bun scripts/cf-builds.ts env [--worker voidbase-ci] [--trigger <name>] KEY=value ... [--secret KEY=value] ...
//   bun scripts/cf-builds.ts hot on|off [--budget 60]          hot mode on the CI triggers (docs/ci.md): CI_HOT and CI_HOT_BUDGET
// Auth: CLOUDFLARE_BUILDS_TOKEN, a *user* API token (My Profile > API Tokens) with "Workers Builds Configuration: Edit"
// and "Workers Scripts: Edit"; the Builds API rejects account-owned tokens. CLOUDFLARE_ACCOUNT_ID picks the account when
// the token reaches several. `setup` stores the release project's secrets from the environment when they are set:
// GH_TOKEN (release-please, release assets), NPM_TOKEN or VOIDBASE_NPM_TOKEN, GH_PACKAGES_TOKEN. With CI_CACHE_TOKEN (an
// API token with Workers R2 Storage edit; VOIDBASE_DEPLOY_CF_API_KEY is accepted) it creates the R2 bucket the builds
// keep their downloads in (--cache-bucket, default voidbase-ci-cache) and stores the token on every trigger. Push events never
// build (the triggers' watch paths exclude everything): .github/workflows/cloudflare.yml starts builds through this
// API, and `setup --github` stores what it needs in the repository (`gh variable set` / `gh secret set`; GH_BIN
// overrides the gh binary). CLOUDFLARE_API_BASE and GITHUB_API_URL point everything at test/cf-mock.ts.
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
const CI = args.ci ?? "voidbase-ci", RELEASE = args.release ?? "voidbase-release", BRANCH = args.branch ?? "master";
const BUN_VERSION = "1.3.14";  // the version CI pins (setup-bun in the workflows); the image's default is older
const DEPLOY = "./node_modules/.bin/wrangler deploy -c ci/wrangler.jsonc";
const PREVIEW = "./node_modules/.bin/wrangler versions upload -c ci/wrangler.jsonc";
const CI_BUILD = "bash scripts/ci.sh", RELEASE_BUILD = "bash scripts/release.sh", DRY_RUN_BUILD = "bash scripts/release.sh --dry-run";
const triggerNames = { ciMaster: `${CI} (${BRANCH})`, ciBranches: `${CI} (branches)`, releaseMaster: `${RELEASE} (${BRANCH})`, releaseDryRun: `${RELEASE} (dry run)` };

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
async function ensureTrigger(tag: string, connection: string, buildToken: string, want: Omit<Trigger, "trigger_uuid">): Promise<{ uuid: string; created: boolean }> {
  // adopt a trigger by name, else by shape (the dashboard wizard names its production and preview triggers itself)
  const same = (a: unknown, b: unknown) => JSON.stringify([...((a as string[] | undefined) ?? [])].sort()) === JSON.stringify([...((b as string[] | undefined) ?? [])].sort());
  const all = await triggers(tag);
  const existing = all.find((t) => t.trigger_name === want.trigger_name) ?? all.find((t) => same(t.branch_includes, want.branch_includes) && same(t.branch_excludes, want.branch_excludes));
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
    // 3. the build token Workers Builds deploys with (the dashboard creates one under Settings > Builds > API token)
    const tokens = (await cf.json<{ build_token_uuid: string; build_token_name?: string }[]>("GET", `${A}/builds/tokens`)).result ?? [];
    const buildToken = tokens[0]?.build_token_uuid ?? die(`no build token on the account yet: open ${dash(CI)} > Settings > Builds > API token > Create new token once, then rerun setup`);
    console.log(`build token ${buildToken}${tokens[0]?.build_token_name ? ` (${tokens[0].build_token_name})` : ""}`);
    // watch paths that exclude everything: a push event never builds by itself; GitHub Actions (cloudflare.yml) and
    // `build` start builds through the API, which the watch paths do not filter
    const common = { root_directory: "/", path_includes: ["*"], path_excludes: ["*"], build_caching_enabled: true };
    const prod = await ensureTrigger(ci.tag, connection, buildToken, { trigger_name: triggerNames.ciMaster, build_command: CI_BUILD, deploy_command: DEPLOY, branch_includes: [BRANCH], branch_excludes: [], ...common });
    const preview = await ensureTrigger(ci.tag, connection, buildToken, { trigger_name: triggerNames.ciBranches, build_command: CI_BUILD, deploy_command: PREVIEW, branch_includes: ["*"], branch_excludes: [BRANCH], ...common });
    // the record of the last green run of master, which scripts/ci-plan.ts compares the inputs against
    const sub = await workersSubdomain(cf, account.id).catch(() => null);
    const statusUrl = sub ? `https://${CI}.${sub}.workers.dev/status.json` : "";
    // the bucket scripts/ci-cache.sh keeps the downloads in between builds (Workers Builds keeps nothing else)
    const cacheToken = process.env.CI_CACHE_TOKEN ?? process.env.VOIDBASE_DEPLOY_CF_API_KEY; const bucket = args["cache-bucket"] ?? "voidbase-ci-cache";
    let cacheVars: EnvVars = {};
    if (cacheToken) {
      const r = await ensureR2(new CfApi(cacheToken, process.env.CLOUDFLARE_API_BASE), account.id, bucket).catch((e: unknown) => { console.log(`cache bucket ${bucket}: ${e instanceof Error ? e.message : e}`); return null; });
      if (r) { console.log(`cache bucket ${bucket}: ${r.created ? "created" : "exists"}`); cacheVars = { CI_CACHE_BUCKET: { value: bucket, is_secret: false }, CI_CACHE_ACCOUNT: { value: account.id, is_secret: false }, CI_CACHE_TOKEN: { value: cacheToken, is_secret: true } }; }
    } else console.log("cache bucket: skipped (set CI_CACHE_TOKEN, an API token with Workers R2 Storage edit, to keep downloads between builds)");
    const vars: EnvVars = { BUN_VERSION: { value: BUN_VERSION, is_secret: false }, CI_BROWSER: { value: "1", is_secret: false }, ...(statusUrl ? { CI_STATUS_URL: { value: statusUrl, is_secret: false } } : {}), ...cacheVars };
    await setEnv(prod.uuid, vars); await setEnv(preview.uuid, vars);
    if (statusUrl) console.log(`  CI_STATUS_URL ${statusUrl} (the last green run's record, for incremental runs)`);
    console.log(`  trigger ${prod.uuid} ${BRANCH}: ${prod.created ? "created" : "updated"}; build \`${CI_BUILD}\`, deploy \`${DEPLOY}\``);
    console.log(`  trigger ${preview.uuid} other branches: ${preview.created ? "created" : "updated"}; deploy \`${PREVIEW}\` (preview URL on the pull request)`);
    const github: Record<string, string> = { CF_ACCOUNT_ID: account.id, CF_CI_TRIGGER_MASTER: prod.uuid, CF_CI_TRIGGER_BRANCHES: preview.uuid };
    if (!args["no-release"]) {
      const rel = await ensureWorker(RELEASE);
      console.log(`Worker ${RELEASE}: ${rel.created ? "created" : "exists"} (tag ${rel.tag})`);
      const t = await ensureTrigger(rel.tag, connection, buildToken, { trigger_name: triggerNames.releaseMaster, build_command: RELEASE_BUILD, deploy_command: DEPLOY, branch_includes: [BRANCH], branch_excludes: [], ...common });
      const dry = await ensureTrigger(rel.tag, connection, buildToken, { trigger_name: triggerNames.releaseDryRun, build_command: DRY_RUN_BUILD, deploy_command: PREVIEW, branch_includes: ["*"], branch_excludes: [BRANCH], ...common });
      const secrets: EnvVars = { BUN_VERSION: { value: BUN_VERSION, is_secret: false }, ...cacheVars };
      const gh = process.env.GH_TOKEN, npm = process.env.NPM_TOKEN ?? process.env.VOIDBASE_NPM_TOKEN, ghp = process.env.GH_PACKAGES_TOKEN;
      if (gh) secrets.GH_TOKEN = { value: gh, is_secret: true };
      if (npm) secrets.NPM_TOKEN = { value: npm, is_secret: true };
      if (ghp) secrets.GH_PACKAGES_TOKEN = { value: ghp, is_secret: true };
      await setEnv(t.uuid, secrets); await setEnv(dry.uuid, secrets);
      const stored = Object.keys(secrets).filter((k) => secrets[k]!.is_secret && k !== "CI_CACHE_TOKEN").join(", ") || "none (set GH_TOKEN and NPM_TOKEN in the environment and rerun, or `env --worker " + RELEASE + " --secret GH_TOKEN=...`)";
      console.log(`  trigger ${t.uuid} ${BRANCH}: ${t.created ? "created" : "updated"}; build \`${RELEASE_BUILD}\`; secrets stored: ${stored}`);
      console.log(`  trigger ${dry.uuid} dry run: ${dry.created ? "created" : "updated"}; build \`${DRY_RUN_BUILD}\`, deploy \`${PREVIEW}\``);
      github.CF_RELEASE_TRIGGER_MASTER = t.uuid; github.CF_RELEASE_TRIGGER_DRY_RUN = dry.uuid;
    }
    if (args.github) {
      // what .github/workflows/cloudflare.yml reads: the trigger uuids as variables, the user token as the secret (over stdin, never an argument)
      const gh = process.env.GH_BIN ?? "gh";
      const ghRun = (a: string[], stdin?: string) => { const p = Bun.spawnSync([gh, ...a], { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" }); if (p.exitCode !== 0) die(`${gh} ${a.slice(0, 3).join(" ")} failed: ${p.stderr.toString().trim() || p.stdout.toString().trim()}`); };
      for (const [k, v] of Object.entries(github)) ghRun(["variable", "set", k, "--repo", repo, "--body", v]);
      ghRun(["secret", "set", "CLOUDFLARE_BUILDS_TOKEN", "--repo", repo], token);
      console.log(`GitHub ${repo}: variables ${Object.keys(github).join(", ")} and the secret CLOUDFLARE_BUILDS_TOKEN stored`);
    } else console.log(`\nrepository variables for .github/workflows/cloudflare.yml (or rerun with --github to store them):\n${Object.entries(github).map(([k, v]) => `  ${k}=${v}`).join("\n")}\n  secret CLOUDFLARE_BUILDS_TOKEN=<this token>`);
    console.log(`\ndone. Push events do not build by themselves; the workflow starts builds on ${dash(CI)}. First build: bun scripts/cf-builds.ts build --branch ${BRANCH} --follow`);
  } else if (cmd === "status") {
    for (const name of [CI, RELEASE]) {
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
    const wanted = args.trigger ?? (args["dry-run"] ? triggerNames.releaseDryRun : undefined);
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
  } else if (cmd === "hot") {
    const on = positional[0] === "on"; if (!on && positional[0] !== "off") die("usage: bun scripts/cf-builds.ts hot on|off [--budget 60]");
    const tag = await workerTag(CI); const vars: EnvVars = { CI_HOT: { value: on ? "1" : "0", is_secret: false }, ...(args.budget ? { CI_HOT_BUDGET: { value: args.budget, is_secret: false } } : {}) };
    for (const t of await triggers(tag)) await setEnv(t.trigger_uuid, vars);
    console.log(`hot mode ${on ? "on" : "off"} for ${CI}${args.budget ? ` (budget ${args.budget}s)` : ""}: the next builds ${on ? "keep the checks within the budget and defer the rest" : "run every check the changes reach"}`);
  } else die("usage: bun scripts/cf-builds.ts setup|status|build|builds|logs|cancel|env|hot ... (see the header of the script)");
} catch (e) { guide(e); }
