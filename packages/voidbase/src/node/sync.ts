// `voidbase sync`: one command that takes a project from "in git" to "live and deploying on every push".
//
//   1. the instance: `voidbase deploy`, which creates the D1 database, the R2 bucket, the queue and the Worker when
//      they do not exist, stores the secrets the Worker lacks, bakes the declared vars and uploads the code. Run
//      again, it updates what changed (pb_hooks, pb_migrations, the site). A Void app is built first, and deployed
//      from its generated .voidbase/.
//   2. the pipeline: Cloudflare Workers Builds connected to the GitHub repository, so every push to the production
//      branch runs the same deploy on Cloudflare. With --previews a second trigger takes every other branch and
//      deploys it as a preview instance (src/node/plugins/previews.ts). This part runs only on a machine that has
//      CLOUDFLARE_BUILDS_TOKEN (a local() key in pb_secrets), never inside a build: in CI, `sync` is just the deploy.
//
// Two layouts, named the way their directories are:
//
//   pb   PocketBase's structure: pb_hooks/, pb_migrations/, pb_secrets/, pb_public/, pb_data/. Deployed in place.
//        (`voidbase init` makes one; voidbase-site's generated .voidbase/ is one.)
//   vb   a Void app with the adapter: routes/, vb_hooks/, vb_secrets/, vb_migrations/ at the root. Built first, and
//        deployed from the pb layout the build generates in .voidbase/. (voidbase-site itself is one.)
//
// A brand-new project therefore is: fork voidbase-site (vb) or `voidbase init` (pb), push it to GitHub, fill in
// the secrets.json, run `voidbase sync`. The first run says which dashboard step the API cannot do (install the
// GitHub App for the repository and connect it, which also creates the build token); the second run finishes.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CfApi, resolveAccount } from "../cloud/rest";
import { appNotInstalled, buildTokens, buildsSettingsLink, connectRepo, ensureTrigger, githubRepo, setTriggerEnv, triggers, workerTag, type BuildEnv } from "../cloud/builds";
import { deployToCloudflare, type DeployOptions } from "./deploy-cf";
import { SECRETS_DIR, secretsState } from "./secrets";

const API = (process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
export const BUILDS_TOKEN_ENV = "CLOUDFLARE_BUILDS_TOKEN";

export interface SyncOptions extends Pick<DeployOptions, "name" | "account" | "domain" | "dryRun" | "log" | "preview"> {
  /** the project (default: the current directory); a Void app is recognised by its vb_secrets/ or .voidbase/ */
  dir?: string;
  /** build a Void app before deploying (default: yes on a machine, never in CI) */
  build?: boolean;
  /** connect the repository to Workers Builds: true forces it, false skips it; by default a build (CI) only deploys */
  ci?: boolean;
  /** the GitHub repository, owner/name (default: the origin remote) */
  repo?: string;
  /** the production branch (default: the checkout's current branch) */
  branch?: string;
  /**
   * the second trigger, "<name> (previews)": every branch but the production one builds and deploys a preview
   * instance (`voidbase deploy --preview $WORKERS_CI_BRANCH`). true creates or updates it, false removes it; by
   * default an existing one is kept as it is.
   */
  previews?: boolean;
}

const sh = (cmd: string[], cwd: string): string => { const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" }); return r.exitCode === 0 ? r.stdout.toString().trim() : ""; };

/** owner/name from the origin remote, or null */
export function repoFromGit(root: string): string | null {
  const url = sh(["git", "remote", "get-url", "origin"], root);
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}
export function branchFromGit(root: string): string {
  return sh(["git", "branch", "--show-current"], root) || "main";
}
/** where the project sits inside its repository ("demo/", or "" at the root) */
export function prefixFromGit(root: string): string {
  return sh(["git", "rev-parse", "--show-prefix"], root).replace(/\/*$/, "");
}

export async function sync(opts: SyncOptions = {}): Promise<void> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const root = resolve(opts.dir ?? ".");
  const inCI = !!process.env.CI;
  // vb: a Void app, deployed from the pb layout the adapter generates; pb: PocketBase's structure, deployed in place
  const voidApp = !existsSync(join(root, "pb_hooks")) && (existsSync(join(root, "vb_secrets")) || existsSync(join(root, "vb_hooks")) || existsSync(join(root, ".voidbase")) || existsSync(join(root, "vite.config.ts")) || existsSync(join(root, "vite.config.mts")));
  const pbDir = voidApp ? join(root, ".voidbase") : root;
  log(voidApp ? `vb layout: a Void app at ${root}; it deploys from the pb layout its build generates at .voidbase/` : `pb layout: PocketBase's structure at ${root}, deployed in place`);
  const pkg = existsSync(join(root, "package.json")) ? (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }) : {};
  const hasScript = (s: string) => !!pkg.scripts?.[s];

  if (voidApp && opts.build !== false && !inCI) {
    log(`building the Void app (${hasScript("build") ? "bun run build" : "bunx --bun vite build"})`);
    const r = Bun.spawnSync(hasScript("build") ? ["bun", "run", "build"] : ["bunx", "--bun", "vite", "build"], { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) throw new Error("the build failed; nothing deployed");
  }
  if (voidApp && !existsSync(join(pbDir, "main.ts"))) throw new Error(`${pbDir} has no main.ts: build the app first (bun run build), or run sync from a PocketBase-shaped directory`);

  // 1. the instance
  const before = process.cwd(); process.chdir(pbDir);
  let deployed: Awaited<ReturnType<typeof deployToCloudflare>>;
  try { deployed = await deployToCloudflare({ name: opts.name, account: opts.account, domain: opts.domain, dryRun: opts.dryRun, preview: opts.preview, log }); }
  finally { process.chdir(before); }

  // 2. the pipeline. A build deploys and nothing more (it has no Builds token and nothing to connect that the
  // connection did not already set up), unless --ci says otherwise.
  if (opts.ci === false || (inCI && opts.ci !== true)) return;
  const buildsToken = process.env[BUILDS_TOKEN_ENV];
  if (!buildsToken) {
    log(`\nci: not connected. To have every push deploy this instance from Cloudflare Workers Builds, declare ${BUILDS_TOKEN_ENV} as a local() key and value it in ${SECRETS_DIR}/secrets.json: a *user* API token (dash.cloudflare.com/profile/api-tokens) with "Workers Builds Configuration: Edit" and "Workers Scripts: Edit". Then run voidbase sync again.`);
    return;
  }
  const repo = opts.repo ?? repoFromGit(root);
  if (!repo) { log("\nci: not connected: no GitHub origin remote (push the project to GitHub, or pass --repo owner/name)"); return; }
  const branch = opts.branch ?? branchFromGit(root);
  // A Workers build may only deploy the Worker its trigger belongs to, so every instance in a repository has its own
  // trigger; the commands run from the repository root (where the lockfile is) and step into the project.
  const prefix = prefixFromGit(root);
  const step = prefix ? `cd ${prefix} && ` : "";
  // The commands are the project's own verbs when it has them: `bun run build`, `bun run deploy`, `bun run version`
  // mean the same three things in a build, on a branch and on a laptop, and the project decides what they do by
  // reading the environment. A project without them gets commands that say the whole thing, which is what the CLI
  // did before the verbs existed.
  const buildCmd = hasScript("build") ? `${step}bun run build` : voidApp ? `${step}bunx --bun vite build` : prefix ? `echo "${prefix}: nothing to build"` : "true";
  const deployCmd = hasScript("deploy") ? `${step}bun run deploy` : `${step}bunx @voidbase-cloud/voidbase sync --name ${deployed.name}${opts.domain || process.env.VOIDBASE_DEPLOY_DOMAIN ? ` --domain ${opts.domain || process.env.VOIDBASE_DEPLOY_DOMAIN}` : ""}`;
  // One trigger, one branch: a push to it builds and deploys, other branches build nowhere (the plainest pipeline;
  // `bun run version` stays a verb for a laptop). With --previews, the Worker's second and last trigger (the API
  // refuses a third with 12030, and two triggers may not watch the same branch) takes every other branch and deploys
  // it as a preview instance: the same build, then the deploy with the branch Workers Builds names in WORKERS_CI_BRANCH.
  const previewsName = `${deployed.name} (previews)`;
  const previewCmd = hasScript("deploy") ? `${step}VOIDBASE_PREVIEW=$WORKERS_CI_BRANCH bun run deploy` : `${deployCmd} --preview $WORKERS_CI_BRANCH`;
  if (opts.dryRun) { log(`\nci (dry run): would connect ${repo} to Worker ${deployed.name}: branch ${branch} builds \`${buildCmd}\` and deploys \`${deployCmd}\`; ${opts.previews ? `every other branch builds \`${buildCmd}\` and deploys a preview with \`${previewCmd}\`` : "other branches build nowhere"}`); return; }

  const cf = new CfApi(buildsToken, API);
  const account = await resolveAccount(cf, deployed.account).catch((e: Error) => { throw new Error(`${e.message} (is ${BUILDS_TOKEN_ENV} a user token that reaches account ${deployed.account}?)`); });
  const tag = await workerTag(cf, account.id, deployed.name);
  if (!tag) { log(`\nci: Worker ${deployed.name} not found through ${BUILDS_TOKEN_ENV}; deploy first`); return; }
  const info = await githubRepo(repo, { token: process.env.GH_TOKEN });
  const link = buildsSettingsLink(deployed.name);
  const manual = `open ${link}\n  Under Builds, connect ${repo}: that installs the "Cloudflare Workers and Pages" GitHub App for it and creates the build token. Then run voidbase sync again.`;
  let connection: string;
  try { connection = await connectRepo(cf, account.id, info); }
  catch (e) { if (appNotInstalled(e)) { log(`\nci: the GitHub App is not installed for ${repo}. One dashboard step: ${manual}`); return; } throw e; }
  const tokens = await buildTokens(cf, account.id);
  const buildToken = tokens[0]?.uuid;
  if (!buildToken) { log(`\nci: the account has no build token yet. One dashboard step: ${manual}`); return; }

  const existing = await triggers(cf, account.id, tag);
  const common = { root_directory: "/", build_caching: true, path_includes: ["*"], path_excludes: [] as string[] };
  const prod = await ensureTrigger(cf, account.id, tag, connection, buildToken, { trigger_name: `${deployed.name} (${branch})`, build_command: buildCmd, deploy_command: deployCmd, branch_includes: [branch], branch_excludes: [], ...common });
  const wantPreviews = opts.previews ?? existing.some((t) => t.trigger_name === previewsName);
  const previewsTrigger = wantPreviews ? await ensureTrigger(cf, account.id, tag, connection, buildToken, { trigger_name: previewsName, build_command: buildCmd, deploy_command: previewCmd, branch_includes: ["*"], branch_excludes: [branch], ...common }) : null;
  // the branches trigger of earlier layouts goes: nothing builds but a push to the branch (and, with previews, the rest)
  const stale = existing.filter((t) => t.trigger_uuid !== prod.uuid && t.trigger_uuid !== previewsTrigger?.uuid);
  for (const t of stale) await cf.json("DELETE", `/accounts/${account.id}/builds/triggers/${t.trigger_uuid}`);

  // what a build on Cloudflare needs: Bun, the deploy token, and the declared server/public values this machine has
  // (a build has no secrets.json; the Worker keeps its secrets)
  const state = await secretsState(join(pbDir, SECRETS_DIR));
  const env: BuildEnv = { BUN_VERSION: { value: process.versions.bun ?? "1.3.14", is_secret: false } };
  const deployToken = process.env.VOIDBASE_DEPLOY_CF_API_KEY;
  if (deployToken) env.VOIDBASE_DEPLOY_CF_API_KEY = { value: deployToken, is_secret: true };
  const plain: string[] = [];
  if (state.definition) for (const k of state.definition.of("server", "public")) { const v = state.values?.[k]; if (v !== undefined) { env[k] = { value: v, is_secret: false }; plain.push(k); } }
  // what the previews need on both triggers: the repository (Workers Builds sets no variable for it), the GitHub token
  // for the pull request comment, and on the production trigger the prune switch; the previews trigger also needs the
  // superuser, which is how the preview signs in on production to seed itself
  const ghToken = process.env.VOIDBASE_GH_TOKEN; const superuser = { email: process.env.VOIDBASE_SUPERUSER_EMAIL, password: process.env.VOIDBASE_SUPERUSER_PASSWORD };
  const forPreviews: BuildEnv = wantPreviews ? { VOIDBASE_PROJECT_REPO: { value: repo, is_secret: false }, ...(ghToken ? { VOIDBASE_GH_TOKEN: { value: ghToken, is_secret: true } } : {}) } : {};
  await setTriggerEnv(cf, account.id, prod.uuid, { ...env, ...forPreviews, ...(wantPreviews ? { VOIDBASE_PREVIEW_PRUNE: { value: "1", is_secret: false } } : {}) });
  if (previewsTrigger) await setTriggerEnv(cf, account.id, previewsTrigger.uuid, { ...env, ...forPreviews, ...(superuser.email && superuser.password ? { VOIDBASE_SUPERUSER_EMAIL: { value: superuser.email, is_secret: true }, VOIDBASE_SUPERUSER_PASSWORD: { value: superuser.password, is_secret: true } } : {}) });

  log(`\nci: ${repo} -> Worker ${deployed.name} (account ${account.name})`);
  log(`  ${prod.created ? "created" : "updated"} trigger "${deployed.name} (${branch})": a push to ${branch} runs \`${buildCmd}\`, then \`${deployCmd}\`${existing.length && !prod.created ? " (watch paths left as they were)" : ""}`);
  if (previewsTrigger) log(`  ${previewsTrigger.created ? "created" : "updated"} trigger "${previewsName}": a push to any other branch runs \`${buildCmd}\`, then \`${previewCmd}\`; the production build prunes the previews whose pull request is over (VOIDBASE_PREVIEW_PRUNE=1)${ghToken ? "" : "; set VOIDBASE_GH_TOKEN in the environment and rerun for the pull request comments"}${superuser.email && superuser.password ? "" : "; set VOIDBASE_SUPERUSER_EMAIL and VOIDBASE_SUPERUSER_PASSWORD in the environment and rerun for the seeding"}`);
  for (const t of stale) log(`  removed trigger "${t.trigger_name}": only a push to ${branch} builds${wantPreviews ? ", and the previews trigger" : ""}`);
  log(`  build environment: BUN_VERSION${deployToken ? ", VOIDBASE_DEPLOY_CF_API_KEY (secret)" : ""}${plain.length ? `, ${plain.join(", ")}` : ""}${wantPreviews ? `, VOIDBASE_PROJECT_REPO${ghToken ? ", VOIDBASE_GH_TOKEN (secret)" : ""}` : ""}`);
  log(`  the pipeline: push to ${branch} and watch it at ${link}`);
}
