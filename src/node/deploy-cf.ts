// `voidbase deploy`: go live on your own Cloudflare account with one API token (VOIDBASE_DEPLOY_CF_API_KEY).
// Resolves the account, creates the D1 database, the R2 bucket and the jobs queue over the REST API (idempotent),
// writes the Void project (cloud/) with a wrangler.jsonc carrying the real ids plus the rate-limit and Analytics
// Engine bindings, stores the superuser credentials as worker secrets and runs `void deploy --backend cloudflare`,
// which builds, applies the D1 migrations and uploads the Worker.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRedirects, writeCloudProject } from "./cloud-init";
import { applyZoneRedirects } from "./zone-redirects";
export { applyZoneRedirects, redirectRule } from "./zone-redirects";
import { pathToFileURL } from "node:url";
import { loadEnv } from "./serve";
import { STORE_KEYS_VAR } from "../server/secrets-store";
import { deleteWorkerSecrets, loadSecrets, putStoreSecrets, readSecretsValues, SECRETS_DIR, STORE_KNOB, storeBindings, storeSecretName, storeSecrets, workerSecretNames, type LoadedSecrets, putWorkerSecrets } from "./secrets";
import { CfApi, destroyInstance, ensureD1, ensureQueue, ensureR2, findQueue, findZone, rateLimitNamespace, resolveAccount, workersSubdomain, workerExists } from "../cloud/rest";
import { PREVIEW_OF_VAR, PREVIEW_VAR, previewWorkerName } from "../server/plugins/previews";
import { ensureFlags, ensureFlagshipApp, FLAGS_BINDING, FLAGS_VAR } from "./flagship";
import { MAIL_BINDING, MAIL_DOMAIN_VAR } from "../server/plugins/mail-binding";
import { AI_BINDING, AI_VAR, aiModelOf } from "../server/plugins/ai-binding";
import { ACCOUNT_VAR as OBSERVABILITY_ACCOUNT_VAR, OBSERVABILITY_VAR, observabilityOn, SAMPLE_VAR as OBSERVABILITY_SAMPLE_VAR, sampleRateOf, TOKEN_VAR as OBSERVABILITY_TOKEN_VAR, workerObservability } from "../server/plugins/observability-binding";
import { SEO_PNG_VAR, seoPngOn } from "../server/plugins/seo-paths";
import { DATABASE_VAR, DB_OBJECT_BINDING, DB_OBJECT_CLASS, DB_OBJECT_MIGRATION_TAG, databaseKind, type DatabaseKind } from "../server/durable-d1";
import { discoverDeployPlugins, runDeployHooks } from "./deploy-plugins";
import type { DeployContext } from "./deploy-plugin";

const API = (process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
export const TOKEN_ENV = "VOIDBASE_DEPLOY_CF_API_KEY";
// Account-owned token template (docs: fundamentals/api/how-to/account-owned-token-template): the dashboard resolves
// :account to the signed-in account and pre-selects exactly what the deploy needs.
export const TOKEN_PERMISSIONS = [
  { key: "workers_scripts", type: "edit" }, // upload the Worker, its cron trigger and secrets
  { key: "d1", type: "edit" },              // create the database, apply migrations
  { key: "workers_r2", type: "edit" },      // create the files bucket
  { key: "queues", type: "edit" },          // create the jobs queue (mail and backups with retries); optional
  { key: "account_settings", type: "read" }, // resolve the account id and workers.dev subdomain
];
export const tokenDeepLink = () => `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${encodeURIComponent(JSON.stringify(TOKEN_PERMISSIONS))}&name=${encodeURIComponent(TOKEN_ENV)}`;
export const tokenHelp = () => `Create the deploy token in the Cloudflare dashboard (permissions pre-selected):

  ${tokenDeepLink()}

Then make it available as ${TOKEN_ENV} (shell export, .env next to pb_hooks, or a CI secret) and run: voidbase deploy
Permissions the link pre-selects: Workers Scripts (edit), D1 (edit), Workers R2 Storage (edit), Queues (edit),
Account Settings (read). Queues is optional: without it the deploy skips the jobs queue and sends mail inline.
If the link format ever changes, pick those by hand at https://dash.cloudflare.com/?to=/:account/api-tokens
(reference: https://developers.cloudflare.com/fundamentals/api/reference/permissions/).`;

export interface DeployOptions { cron?: boolean; domain?: string; name?: string; account?: string; dir?: string; // dir: a visible project instead of <package>/.cloud/<slug>
  publicDir?: string; dryRun?: boolean; regenerate?: boolean; superuserEmail?: string; superuserPassword?: string; log?: (line: string) => void;
  queue?: boolean;      // jobs queue for mail and automatic backups (default on; skipped when the token cannot create queues)
  analytics?: boolean;  // Analytics Engine dataset with one data point per request (opt-in: --analytics or VOIDBASE_DEPLOY_ANALYTICS=1; the account must have Analytics Engine enabled)
  /** Workers Observability: the Worker's logs and invocation logs retained. On unless VOIDBASE_OBSERVABILITY=0
   *  (VOIDBASE_DEPLOY_OBSERVABILITY is the older spelling and still works); the same knob the observability
   *  plugin reads, so turning it off turns the sampling off too (src/server/plugins/observability.ts). */
  observability?: boolean;
  rateLimit?: string;   // exact per-location ceiling per IP as "<requests>/<10|60>", default "300/10" (PocketBase's /api/ rule); "0" disables
  hub?: boolean;        // realtime hub Durable Object in this Worker (default on; VOIDBASE_DEPLOY_HUB=0 keeps the D1 poll)
  /** `voidbase serve --workers`: generate the same project for Cloudflare's local runtime and stop there. No token,
   *  no account, no resource is created and nothing is uploaded; the ids in wrangler.jsonc are local ones. */
  local?: boolean;
  /**
   * `--preview <branch>` (or VOIDBASE_PREVIEW): a preview instance of this project for the branch, a Worker of its
   * own named `<name>-pr-<slug>` with its own database, bucket and queue, seeded from production by the previews
   * plugin (src/node/plugins/previews.ts). `name` stays the production Worker's name.
   */
  preview?: string;
  /** `d1` (the default) or `durable`: the instance's data in its own SQLite-backed Durable Object instead of a D1
   *  database (--database, VOIDBASE_DATABASE from the environment or pb_secrets/secrets.json; docs/platform.md) */
  database?: string;
}

export interface DeployResult {
  name: string; account: string; url: string | null; wranglerConfig: string; project: string;
  /** what holds the data: D1, or the database Durable Object */
  database: DatabaseKind;
  /** the superuser the project was generated with (a local run seeds it through the project's .env) */
  superuser?: { email: string; password: string; file: string; source: "env" | "file" | "generated" };
  /** the keys written to the project's .env: a local run keeps them out of the dev server's shell (Void strips a key the shell also exports) */
  vars?: string[];
}

// the Cloudflare calls live in src/cloud/rest.ts (shared with control planes); this module adds the deploy's own wording
export { rateLimitNamespace } from "../cloud/rest";
export function parseRateLimit(spec: string | undefined): { limit: number; period: 10 | 60 } | null {
  const v = (spec ?? "").trim();
  if (!v || v === "0" || v === "off") return v ? null : { limit: 300, period: 10 };
  const m = /^(\d+)\/(10|60)$/.exec(v);
  if (!m) throw new Error(`invalid rate limit "${spec}": use <requests>/10 or <requests>/60 (seconds), or 0 to disable`);
  return { limit: Number(m[1]), period: Number(m[2]) as 10 | 60 };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 54) || "voidbase";
function projectName(): string {
  try { const n = String((JSON.parse(readFileSync("package.json", "utf8")) as { name?: string }).name ?? ""); if (n && n !== "vb" && n !== "pb") return slug(n); } catch { /* no package.json */ }
  const dir = slug(resolve(".").split("/").at(-1) ?? "");
  return dir === "vb" || dir === "pb" ? slug(`${resolve("..").split("/").at(-1) ?? "voidbase"}-backend`) : dir;
}
const randomPassword = () => { const a = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const b = crypto.getRandomValues(new Uint8Array(20)); return Array.from(b, (x) => a[x % a.length]).join(""); };

// Bun only loads the .env of the working directory; the starter keeps its PB_* and deploy variables one level up.
const ENV_KEYS = [TOKEN_ENV, "VOIDBASE_DEPLOY_CF_ACCOUNT_ID", "VOIDBASE_DEPLOY_NAME", "VOIDBASE_DOMAINS", "VOIDBASE_PREVIEW_SEED", "VOIDBASE_PREVIEW_SOURCE_URL", "VOIDBASE_GH_TOKEN", "VOIDBASE_PROJECT_REPO", "VOIDBASE_DEPLOY_DOMAIN", "VOIDBASE_DEPLOY_QUEUE", "VOIDBASE_DEPLOY_HUB", "VOIDBASE_DEPLOY_ANALYTICS", "VOIDBASE_DEPLOY_RATE_LIMIT", MAIL_DOMAIN_VAR, AI_VAR, OBSERVABILITY_VAR, OBSERVABILITY_SAMPLE_VAR, OBSERVABILITY_ACCOUNT_VAR, SEO_PNG_VAR, DATABASE_VAR, "VOIDBASE_SUPERUSER_EMAIL", "VOIDBASE_SUPERUSER_PASSWORD", "PB_SUPERUSER_EMAIL", "PB_SUPERUSER_PASSWORD", "AUDITLOG"];
export function loadEnvFiles(files = [".env", ".env.local", "../.env", "../.env.local"]): string[] {
  const loaded: string[] = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (!m) continue;
      const [, k, raw] = m as unknown as [string, string, string];
      if (!ENV_KEYS.includes(k) || process.env[k]) continue;
      process.env[k] = raw.replace(/^(['"])(.*)\1$/, "$2"); loaded.push(`${k} (${f})`);
    }
  }
  return loaded;
}

/** The project's own environment: pb_secrets/ and the .env files, before anything about Cloudflare is known. */
async function loadProjectEnv(log: (line: string) => void): Promise<{ secretsDir: string; secrets: LoadedSecrets }> {
  // pb_secrets/ first: the declared names, and on a dev machine their values, which count as environment from here
  // on. The shell outranks secrets.json, and secrets.json outranks the .env files, so a dev placeholder in .env
  // (VOIDBASE_SUPERUSER_PASSWORD=changeme123) never shadows the real value kept beside the declaration.
  const secretsDir = resolve(process.env.VOIDBASE_SECRETS_DIR || SECRETS_DIR);
  const secrets = await loadSecrets(secretsDir);
  if (secrets.invalid.length) throw new Error(`${secretsDir}: ${secrets.invalid.map((i) => `${i.name}: ${i.message}`).join(", ")}`);
  loadEnv(); const fromFiles = loadEnvFiles(); if (fromFiles.length) log(`from .env: ${fromFiles.join(", ")}`);
  if (secrets.state.definition) { const d = secrets.state.definition; log(`${secretsDir}: ${d.names.length} declared (${d.of("secret").length} secret, ${d.of("server").length} server, ${d.of("public").length} public${d.of("flag").length ? `, ${d.of("flag").length} flag` : ""}${d.of("local").length ? `, ${d.of("local").length} local` : ""}), ${secrets.state.provided.length} valued here${secrets.undeclared.length ? `; in secrets.json but not declared (not deployed): ${secrets.undeclared.join(", ")}` : ""}`); }
  return { secretsDir, secrets };
}

/** The production worker name: --name, VOIDBASE_DEPLOY_NAME or the project's, checked against what pb_secrets/main.ts declares. */
function resolveWorkerName(opts: Pick<DeployOptions, "name">, secrets: LoadedSecrets, secretsDir: string): string {
  const name = slug(opts.name || process.env.VOIDBASE_DEPLOY_NAME || projectName());
  // A project that declares its own deploy target may not be deployed onto another one by an ambient environment:
  // a build that already carries VOIDBASE_DEPLOY_NAME (a repository whose CI deploys more than one instance) would
  // otherwise put this project on that Worker, over whatever lives there. An explicit --name says it on purpose.
  const declaredTarget = (key: string) => secrets.state.info.find((i) => i.name === key && i.access === "local")?.fallback;
  const declaredName = declaredTarget("VOIDBASE_DEPLOY_NAME");
  if (!opts.name && declaredName && slug(declaredName) !== name) {
    const declaredDomain = declaredTarget("VOIDBASE_DEPLOY_DOMAIN");
    throw new Error(`this project declares VOIDBASE_DEPLOY_NAME=${slug(declaredName)}${declaredDomain ? ` (${declaredDomain})` : ""} in ${secretsDir}/main.ts, but the environment says ${name}. Deploying would put it on that Worker, over whatever is there. Unset VOIDBASE_DEPLOY_NAME${declaredDomain ? " and VOIDBASE_DEPLOY_DOMAIN" : ""} for this deploy, or pass --name ${name} to mean it.`);
  }
  return name;
}

/**
 * The Worker a deploy targets: the production name, or `<production>-pr-<slug>` for a preview of a branch (`--preview`,
 * else VOIDBASE_PREVIEW, which a Workers build sets from WORKERS_CI_BRANCH). Resolved here, before any resource is
 * named, so a preview's database, bucket and queue are its own; the naming rule is the previews plugin's.
 */
function resolveTarget(opts: Pick<DeployOptions, "name" | "preview">, secrets: LoadedSecrets, secretsDir: string): { name: string; production: string; preview: string | null } {
  const production = resolveWorkerName(opts, secrets, secretsDir);
  const preview = (opts.preview ?? process.env[PREVIEW_VAR] ?? "").trim() || null;
  return { name: preview ? previewWorkerName(production, preview) : production, production, preview };
}

export interface DeployTarget { api: CfApi; token: string; account: { id: string; name: string }; name: string; production: string; preview: string | null; secretsDir: string; secrets: LoadedSecrets }
/** The environment, the token, the account and the worker name a deploy (or `voidbase secrets`) targets. */
export async function deployTarget(opts: Pick<DeployOptions, "name" | "account" | "log" | "preview"> = {}): Promise<DeployTarget> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const { secretsDir, secrets } = await loadProjectEnv(log);
  const token = process.env[TOKEN_ENV] || process.env.CLOUDFLARE_API_TOKEN || ""; // empty means unset
  if (!token) { log(`${TOKEN_ENV} is not set.\n\n${tokenHelp()}`); throw new Error(`${TOKEN_ENV} missing`); }
  const target = resolveTarget(opts, secrets, secretsDir);
  const api = new CfApi(token, API);
  const account = await resolveAccount(api, opts.account || process.env.VOIDBASE_DEPLOY_CF_ACCOUNT_ID || undefined).catch((e: Error) => { throw new Error(`${e.message} (is it ${TOKEN_ENV} with Account Settings read?)`); });
  return { api, token, account, ...target, secretsDir, secrets };
}

/** The same, for a run on this machine (`voidbase serve --workers`): no token, no account, the API never called. */
async function localTarget(opts: Pick<DeployOptions, "name" | "log" | "preview"> = {}): Promise<{ api: null; token: ""; account: { id: string; name: string }; name: string; production: string; preview: string | null; secretsDir: string; secrets: LoadedSecrets }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const { secretsDir, secrets } = await loadProjectEnv(log);
  return { api: null, token: "", account: { id: "", name: "this machine" }, ...resolveTarget(opts, secrets, secretsDir), secretsDir, secrets };
}
/** what the hooks read about a preview: the branch and the production Worker, the way the plugin's knobs are named */
const previewEnv = (t: { production: string; preview: string | null }): Record<string, string> => (t.preview ? { [PREVIEW_VAR]: t.preview, [PREVIEW_OF_VAR]: t.production } : {});

export async function deployToCloudflare(opts: DeployOptions = {}): Promise<DeployResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  // local: the same project, generated for Cloudflare's local runtime (`voidbase serve --workers`, src/node/serve-workers.ts).
  // `api` is null there, and every step that would reach Cloudflare is answered locally instead.
  const local = !!opts.local;
  const { api, token, account, name, production, preview, secretsDir, secrets: pbSecrets } = local ? await localTarget(opts) : await deployTarget(opts);
  if (api) log(`account ${account.name} (${account.id}), worker "${name}"${preview ? ` (a preview of ${production} for branch ${preview})` : ""}`);
  else log(`worker "${name}" on Cloudflare's local runtime (this machine): no token, no account, nothing reaches Cloudflare`);
  // the database: D1 (the default), or the instance's own SQLite-backed Durable Object (VOIDBASE_DATABASE=durable from
  // the environment or pb_secrets/secrets.json, --database durable; src/server/durable-db.ts): then no D1 is created or bound
  const database = databaseKind(opts.database ?? (process.env[DATABASE_VAR] || readSecretsValues(secretsDir)?.[DATABASE_VAR]));
  const durable = database === "durable";
  // the local ids: "local" is what Void's dev server names its Miniflare D1, and where it applies db/migrations
  const db = durable ? null : api ? await ensureD1(api, account.id, `${name}-db`) : { uuid: "local", created: false };
  const bucket = api ? await ensureR2(api, account.id, `${name}-storage`) : { created: false };
  if (durable) log(`database: Durable Object (SQLite): ${DB_OBJECT_CLASS} in this Worker, bound as ${DB_OBJECT_BINDING}; no D1 is created or bound (${DATABASE_VAR}=durable)`);
  if (api) { if (db) log(`D1 ${name}-db ${db.created ? "created" : "exists"} (${db.uuid})`); log(`R2 ${name}-storage ${bucket.created ? "created" : "exists"}`); }
  else log(`${db ? `D1 ${name}-db and ` : ""}R2 ${name}-storage: Miniflare's, kept under the project's .void/`);
  const off = (v: string | undefined) => v !== undefined && ["0", "false", "off", "no"].includes(v.trim().toLowerCase());
  const wantQueue = opts.queue ?? !off(process.env.VOIDBASE_DEPLOY_QUEUE);
  const on = (v: string | undefined) => v !== undefined && ["1", "true", "on", "yes"].includes(v.trim().toLowerCase());
  const analytics = opts.analytics ?? on(process.env.VOIDBASE_DEPLOY_ANALYTICS);
  const rateLimit = parseRateLimit(opts.rateLimit ?? process.env.VOIDBASE_DEPLOY_RATE_LIMIT);
  const hub = opts.hub ?? !off(process.env.VOIDBASE_DEPLOY_HUB);
  // Workers Free allows 5 cron triggers per account; without the trigger PocketBase's maintenance runs lazily in requests
  const cron = opts.cron ?? !off(process.env.VOIDBASE_DEPLOY_CRON);
  // Workers Observability and the observability plugin's sampling share one knob and one rate, read from the
  // environment or pb_secrets/secrets.json; VOIDBASE_DEPLOY_OBSERVABILITY is the older name for the same thing
  const observabilityKnob = String(process.env[OBSERVABILITY_VAR] ?? readSecretsValues(secretsDir)?.[OBSERVABILITY_VAR] ?? process.env.VOIDBASE_DEPLOY_OBSERVABILITY ?? "").trim();
  const observability = opts.observability ?? observabilityOn(observabilityKnob);
  const observabilitySampleKnob = String(process.env[OBSERVABILITY_SAMPLE_VAR] ?? readSecretsValues(secretsDir)?.[OBSERVABILITY_SAMPLE_VAR] ?? "").trim();
  if (observabilitySampleKnob && !(Number.isFinite(Number(observabilitySampleKnob)) && Number(observabilitySampleKnob) >= 0 && Number(observabilitySampleKnob) <= 1)) throw new Error(`${OBSERVABILITY_SAMPLE_VAR}=${observabilitySampleKnob} is not a number between 0 and 1`);
  const observabilitySample = sampleRateOf(observabilitySampleKnob);
  const observabilityAccount = String(process.env[OBSERVABILITY_ACCOUNT_VAR] ?? readSecretsValues(secretsDir)?.[OBSERVABILITY_ACCOUNT_VAR] ?? "").trim();
  // custom domains are the domains plugin's (src/node/plugins/domains.ts, from VOIDBASE_DOMAINS / --domain): its
  // `before` turns workers.dev off and claims the URL, its `after` attaches them; the deploy only reports the URL
  // the static site next to the API: --public-dir, VOIDBASE_DEPLOY_PUBLIC_DIR, or ./pb_public when it exists (PocketBase's default)
  const publicDir = opts.publicDir || process.env.VOIDBASE_DEPLOY_PUBLIC_DIR || (existsSync(resolve("pb_public")) ? "pb_public" : undefined);
  // the sending domain for Cloudflare Email Service (VOIDBASE_MAIL_DOMAIN, from the environment or secrets.json): the
  // Worker gets the send_email binding and the domain as a var; the mail plugin holds the From to it (docs/deploy.md)
  const mailDomain = String(process.env[MAIL_DOMAIN_VAR] || readSecretsValues(secretsDir)?.[MAIL_DOMAIN_VAR] || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (mailDomain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(mailDomain)) throw new Error(`${MAIL_DOMAIN_VAR}=${mailDomain} is not a domain name (a domain, not an address)`);
  // Workers AI for the ai plugin (VOIDBASE_AI=1 or a model name, from the environment or secrets.json): the Worker
  // gets the `ai` binding as AI and the model as a var; the binding is config only, nothing on the account to create
  const aiModel = aiModelOf(process.env[AI_VAR] || readSecretsValues(secretsDir)?.[AI_VAR]);
  if (aiModel && !/^@[a-z0-9-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(aiModel)) throw new Error(`${AI_VAR}=${aiModel} is neither 1 nor a Workers AI model name (@cf/meta/llama-3.3-70b-instruct-fp8-fast, for example)`);
  // share cards as PNG for the seo plugin (VOIDBASE_SEO_PNG=1, from the environment or secrets.json). It is a build
  // knob first: off, the project's vite.config.ts leaves resvg's wasm and the card's font out of the Worker
  // entirely (+1.04 MB gzipped when on, docs/platform.md). The same value is baked as a var so the plugin serves
  // and advertises what this build can actually render. No binding: nothing on the account to create.
  const seoPngRaw = String(process.env[SEO_PNG_VAR] || readSecretsValues(secretsDir)?.[SEO_PNG_VAR] || "").trim();
  if (seoPngRaw && !/^(0|1|true|false|on|off|yes|no)$/i.test(seoPngRaw)) throw new Error(`${SEO_PNG_VAR}=${seoPngRaw} is neither on nor off (1 or 0)`);
  const seoPng = seoPngOn(seoPngRaw);
  if (publicDir && !existsSync(resolve(publicDir, "index.html"))) throw new Error(`public dir ${resolve(publicDir)} has no index.html (build the site first)`);
  // <public dir>/_redirects, Netlify/Pages syntax. Path-only lines go to the assets as Cloudflare's own _redirects (it
  // only accepts relative sources); host-scoped lines (`https://api.example.com/ /_/ 302`) become zone Redirect Rules
  // after the upload, which is how one Worker behind several custom domains answers differently per hostname.
  const redirects = publicDir && existsSync(resolve(publicDir, "_redirects")) ? parseRedirects(readFileSync(resolve(publicDir, "_redirects"), "utf8")) : [];
  const hostRedirects = redirects.filter((r) => r.host), pathRedirects = redirects.filter((r) => !r.host);
  if (redirects.length) log(`redirects (${resolve(publicDir!, "_redirects")}): ${redirects.map((r) => `${r.source} -> ${r.to} (${r.status})`).join(", ")}${hostRedirects.length ? `; the ${hostRedirects.length} host-scoped rule(s) become zone Redirect Rules after the upload` : ""}`);
  let queue: string | false = false;
  if (wantQueue && !api) { queue = `${name}-jobs`; log(`Queue ${name}-jobs: Miniflare's (mail and automatic backups run from it with retries)`); }
  else if (wantQueue && api) {
    const q = await ensureQueue(api, account.id, `${name}-jobs`);
    queue = q.id ? `${name}-jobs` : false;
    if (queue) log(`Queue ${name}-jobs ${q.created ? "created" : "exists"} (mail and automatic backups run from it with retries)`);
    else log(`Queue ${name}-jobs not created (${q.reason}): mail is sent inline and backups run in the cron tick. Give the token the Queues edit permission (${tokenDeepLink()}) to enable it, or VOIDBASE_DEPLOY_QUEUE=0 to silence this.`);
  }

  // the Void project lives inside the voidbase package (<package>/.cloud/<slug>) when the package is a checkout:
  // its entry files import this package by relative path and resolve `void`/`vite` by walking up to node_modules.
  // An installed package sits under node_modules, where Node refuses to strip types, and Void loads the project's
  // env.ts with Node: the project then lives in the consumer's tree (<consumer>/.cloud/<slug>, git-ignored) and
  // imports the package by name.
  const PKG = resolve(import.meta.dir, "../.."); const consumer = resolve(".");
  const installed = /[\\/]node_modules[\\/]/.test(PKG);
  const cloud = opts.dir ? resolve(opts.dir) : installed ? resolve(consumer, ".cloud", name) : resolve(PKG, ".cloud", name);
  const mode: "package" | "internal" = opts.dir || installed ? "package" : "internal";
  const entry = ["main.ts", "main.js"].map((f) => resolve(consumer, f)).find((f) => existsSync(f) && /export\s+(async\s+)?function\s+register\b|export\s*\{[^}]*\bregister\b/.test(readFileSync(f, "utf8")));
  if (entry) log(`composing ${entry} (register) into the Worker`);
  // workflows/: the adapter's bundles (src/adapter/bundle.ts bundleWorkflow), each exported from the Worker under the
  // class the first line names and bound as WORKFLOW_<NAME>; a project may also write one by hand
  const workflowsDir = resolve(consumer, process.env.VOIDBASE_WORKFLOWS_DIR || "workflows");
  const workflows = existsSync(workflowsDir) ? readdirSync(workflowsDir).filter((f) => f.endsWith(".js")).sort().map((f) => {
    const head = readFileSync(resolve(workflowsDir, f), "utf8").split("\n")[0] ?? "";
    const className = /^\/\/ voidbase:workflow (\w+)/.exec(head)?.[1] ?? "";
    if (!className) throw new Error(`voidbase: ${workflowsDir}/${f} does not name its class on its first line (// voidbase:workflow <ClassName>): the adapter writes that, and a hand-written one has to`);
    const stem = f.replace(/\.js$/, "");
    return { file: resolve(workflowsDir, f), className, stem, binding: `WORKFLOW_${stem.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`, workflowName: `${name}-${stem}` };
  }) : [];
  const pluginsDir = resolve(consumer, process.env.VOIDBASE_PLUGINS_DIR || "pb_plugins");
  // the plugins that act at deploy time (src/node/deploy-plugins.ts): the shipped ones first, then the installed
  // ones that carry a deploy.js; their hooks run before the upload, after it, and on --remove
  const deployPlugins = await discoverDeployPlugins(pluginsDir);
  if (deployPlugins.length) log(`deploy plugins: ${deployPlugins.map((p) => `${p.name} (${p.origin})`).join(", ")}`);
  writeCloudProject(cloud, mode, { hooksDir: resolve(consumer, process.env.VOIDBASE_HOOKS_DIR || "pb_hooks"), migrationsDir: resolve(consumer, process.env.VOIDBASE_MIGRATIONS_DIR || "pb_migrations"), pluginsDir, entry, queue, hub, database, seoPng, workflows: workflows.map((w) => ({ file: w.file, className: w.className })) });
  log(seoPng ? `${SEO_PNG_VAR}=1: seo share cards are rasterised to PNG (resvg, about 1 MB gzipped in the Worker)` : `share cards are SVG (${SEO_PNG_VAR}=1 bundles resvg and serves them as PNG, about 1 MB gzipped more)`);
  if (!queue) { const { rmSync } = await import("node:fs"); rmSync(`${cloud}/queues`, { recursive: true, force: true }); }
  if (!cron) { const { rmSync } = await import("node:fs"); rmSync(`${cloud}/crons`, { recursive: true, force: true }); log("cron trigger disabled (VOIDBASE_DEPLOY_CRON=0 / --no-cron): maintenance runs lazily in requests"); }
  log(observability
    ? `observability: the Worker's logs and invocation logs are kept (head_sampling_rate ${observabilitySample}); the observability plugin samples the request path at the same rate${analytics ? " into the Analytics Engine dataset" : ", where LOGS_ANALYTICS is bound (--analytics)"}, and GET /api/observability/summary reads Analytics Engine once ${OBSERVABILITY_TOKEN_VAR} is a secret on the Worker, the D1 request log until then`
    : `observability off (${OBSERVABILITY_VAR}=0): the Worker's logs are not kept, nothing is sampled, and GET /api/observability/summary answers from the D1 request log`);
  // Smart Placement runs the Worker next to its D1 database: PocketBase-shaped requests are several dependent queries.
  // The rate-limit binding is an exact per-location ceiling per IP on top of the settings' rules (which count per
  // isolate); the Analytics Engine dataset takes one data point per request at any log level.
  // the SQLite-backed Durable Object classes exported from this Worker (free plan included), one of each per instance: the
  // realtime hub, and with the knob the database, each under its own migration tag (a Worker already at the hub's tag
  // gets only the database's step)
  const doClasses = [...(hub ? [{ binding: "HUB", className: "VoidbaseHub", tag: "voidbase-hub-v1" }] : []), ...(durable ? [{ binding: DB_OBJECT_BINDING, className: DB_OBJECT_CLASS, tag: DB_OBJECT_MIGRATION_TAG }] : [])];
  const workerConfig: Record<string, unknown> = {
    name, ...(api ? { account_id: account.id } : {}), placement: { mode: "smart" },
    ...(db ? { d1_databases: [{ binding: "DB", database_name: `${name}-db`, database_id: db.uuid, migrations_dir: "./db/migrations" }] } : {}),
    r2_buckets: [{ binding: "STORAGE", bucket_name: `${name}-storage` }],
    ...(rateLimit ? { ratelimits: [{ name: "RATE_LIMITER", namespace_id: rateLimitNamespace(name), simple: { limit: rateLimit.limit, period: rateLimit.period } }] } : {}),
    ...(analytics ? { analytics_engine_datasets: [{ binding: "LOGS_ANALYTICS", dataset: `${name.replace(/-/g, "_")}_requests` }] } : {}),
    // Workers Observability, in the shape Cloudflare's configuration documents today (checked 2026-09-11,
    // https://developers.cloudflare.com/workers/wrangler/configuration/): `enabled` persists this Worker's logs
    // and `head_sampling_rate` is a number between 0 and 1. Invocation logs, which carry the request and the
    // response of every invocation, are on by default and only need turning off, so nothing is written for them
    // (https://developers.cloudflare.com/workers/observability/logs/workers-logs/).
    ...(observability ? { observability: workerObservability(observabilitySample) } : {}),
    ...(doClasses.length ? { durable_objects: { bindings: doClasses.map((d) => ({ name: d.binding, class_name: d.className })) }, migrations: doClasses.map((d) => ({ tag: d.tag, new_sqlite_classes: [d.className] })) } : {}),
    ...(workflows.length ? { workflows: workflows.map((w) => ({ name: w.workflowName, binding: w.binding, class_name: w.className })) } : {}),
    // Cloudflare Email Service: the binding sends from any domain onboarded on the account (the plugin holds the
    // From to VOIDBASE_MAIL_DOMAIN) to any recipient once the domain is onboarded, else to verified addresses only
    ...(mailDomain ? { send_email: [{ name: MAIL_BINDING }] } : {}),
    // Workers AI: the ai plugin's chat runs the model this binding serves (docs/plugins.md, "A chat over the instance")
    ...(aiModel ? { ai: { binding: AI_BINDING } } : {}),
  };
  const configHeader = api ? `// written by voidbase deploy; ids are real resources on account ${account.id}` : "// written by voidbase serve --workers; local ids for Cloudflare's local runtime, nothing here exists on an account";
  const writeWorkerConfig = () => writeFileSync(`${cloud}/wrangler.jsonc`, `${configHeader}\n${JSON.stringify(workerConfig, null, 2)}\n`);
  writeWorkerConfig();
  // non-secret worker vars: the instance's own name and account (a control plane needs them to find itself), the
  // hooks' AUDITLOG, plus VOIDBASE_DEPLOY_VARS=A,B from the environment; secrets (VOIDBASE_DEPLOY_SECRETS=X,Y) never go here
  const listed = (key: string) => (process.env[key] ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  const extraVars = listed("VOIDBASE_DEPLOY_VARS"), extraSecrets = listed("VOIDBASE_DEPLOY_SECRETS");
  const baked: Record<string, string> = { VOIDBASE_WORKER_NAME: name, ...(api ? { VOIDBASE_ACCOUNT_ID: account.id } : {}) };
  for (const k of ["AUDITLOG", ...extraVars]) if (process.env[k]) baked[k] = process.env[k]!;
  if (mailDomain) baked[MAIL_DOMAIN_VAR] = mailDomain;
  if (aiModel) baked[AI_VAR] = aiModel;
  if (seoPng) baked[SEO_PNG_VAR] = "1";
  // the observability plugin's knobs, baked so the Worker reads the same numbers the config was written from. The
  // token is not among them: it is a secret, declared in pb_secrets or pushed with VOIDBASE_DEPLOY_SECRETS.
  if (!observability) baked[OBSERVABILITY_VAR] = "0";
  if (observabilitySampleKnob) baked[OBSERVABILITY_SAMPLE_VAR] = String(observabilitySample);
  if (observabilityAccount) baked[OBSERVABILITY_ACCOUNT_VAR] = observabilityAccount;
  // the declared server and public values, parsed (defaults filled in): a var is the code's to set on every deploy
  const definition = pbSecrets.state.definition;
  const plainKeys = definition ? definition.of("server", "public", "flag") : [];
  for (const k of plainKeys) { const v = pbSecrets.evaluation?.stored[k]; if (v !== undefined) baked[k] = v; }
  const missingVars = pbSecrets.missing.filter((k) => plainKeys.includes(k));
  if (missingVars.length) {
    const msg = `${missingVars.length} declared value(s) have no value in ${secretsDir}/secrets.json or the environment and no default: ${missingVars.join(", ")}`;
    if (opts.dryRun) log(`vars: ${msg}`); else throw new Error(msg);
  }
  if (plainKeys.length) log(`vars: ${plainKeys.filter((k) => baked[k] !== undefined).join(", ") || "none"}${definition!.of("public").length ? ` (public: ${definition!.of("public").join(", ")})` : ""}`);
  // the declared flags: Flagship holds them (the deploy creates the app and the missing flags, binds it), and
  // their defaults are baked as vars for a Worker whose Flagship is out of reach (src/node/flagship.ts)
  const flagKeys = definition ? definition.of("flag") : [];
  if (flagKeys.length) {
    const infos = await definition!.info();
    const flagDefs = flagKeys.map((k) => { const i = infos.find((x) => x.name === k); return { key: k, description: i?.description, fallback: (baked[k] ?? i?.fallback ?? "false") === "true" }; });
    baked[FLAGS_VAR] = JSON.stringify(Object.fromEntries(flagDefs.map((f) => [f.key, f.fallback])));
    if (!api) log(`flags: ${flagKeys.join(", ")} keep their defaults here (Flagship is not reachable from this machine), baked as ${FLAGS_VAR}`);
    else try {
      const app = await ensureFlagshipApp(api, account.id, name, opts.dryRun);
      const created = await ensureFlags(api, account.id, app.id, flagDefs, opts.dryRun);
      if (app.id) workerConfig.flagship = [{ binding: FLAGS_BINDING, app_id: app.id }];
      writeWorkerConfig();
      log(`flags: ${flagKeys.join(", ")} in the Flagship app "${name}" (${app.created ? (opts.dryRun ? "would be created" : "created") : app.id}); ${created.length ? `${opts.dryRun ? "would create" : "created"} ${created.join(", ")}` : "all present"}; bound as ${FLAGS_BINDING}, defaults baked as ${FLAGS_VAR}`);
    } catch (err) {
      log(`flags: ${flagKeys.join(", ")} keep their defaults: ${err instanceof Error ? err.message.split("\n")[0] : err} (Flagship needs "Flagship: Write" on the deploy token)`);
    }
  }
  // the deploy plugins' `before`: the config and the vars are theirs to change here, and a plugin may claim the
  // URL (a custom domain); the config is written again once they ran. `env` is read the way the deploy's own knobs
  // are: the shell and the .env files first, then pb_secrets/secrets.json; --domain is the knob's flag form.
  const hookCtx: DeployContext = { name, account: { id: account.id }, api, env: hookEnv(secretsDir, { ...(opts.domain ? { VOIDBASE_DEPLOY_DOMAIN: opts.domain } : {}), ...previewEnv({ production, preview }) }), config: workerConfig, vars: baked, url: null, log, local, dryRun: !!opts.dryRun };
  await runDeployHooks("before", deployPlugins, hookCtx); writeWorkerConfig();
  if (mailDomain) log(await mailDomainReport(api, account.id, mailDomain));
  log(`project: ${cloud}`);

  // superuser: from the environment (PB_* is what the starter's entrypoint uses) or generated once and kept in pb_data
  const dataDir = resolve(consumer, process.env.VOIDBASE_DATA_DIR || "pb_data"); mkdirSync(dataDir, { recursive: true });
  const credFile = `${dataDir}/.superuser-credentials`;
  let email = opts.superuserEmail || process.env.VOIDBASE_SUPERUSER_EMAIL || process.env.PB_SUPERUSER_EMAIL || "";
  let password = opts.superuserPassword || process.env.VOIDBASE_SUPERUSER_PASSWORD || process.env.PB_SUPERUSER_PASSWORD || "";
  const saved = existsSync(credFile) ? (JSON.parse(readFileSync(credFile, "utf8")) as { email: string; password: string }) : null;
  // the local dev default never goes live; on this machine it is what `voidbase serve` would use, so it stands
  const isPlaceholder = (p: string) => !p || (!local && p === "changeme123");
  const placeholder = isPlaceholder(password);
  let superuserSource: NonNullable<DeployResult["superuser"]>["source"] = "env";
  if (placeholder && saved && (!email || email === saved.email)) { email = saved.email; password = saved.password; superuserSource = "file"; }
  // what the Worker already holds: a checkout with no credentials of its own (CI) must not replace the superuser
  // the Worker has with a generated one that only this checkout would know
  const onWorker = api ? await workerSecretNames(api, account.id, name) : [];
  // the account's Secrets Store, when the deploy is told which one (src/node/secrets.ts): a secret held there counts
  // the way one on the Worker does; a local run has no store and keeps every value in the project's .env
  const store = api ? process.env[STORE_KNOB] || readSecretsValues(secretsDir)?.[STORE_KNOB] || "" : "";
  const inStore = store && api ? await storeSecrets(api, account.id, store) : new Map<string, string>();
  const heldInStore = (k: string) => inStore.has(storeSecretName(name, k));
  const held = (k: string) => onWorker.includes(k) || heldInStore(k);
  const keepSuperuser = placeholder && !saved && held("VOIDBASE_SUPERUSER_EMAIL") && held("VOIDBASE_SUPERUSER_PASSWORD");
  if (keepSuperuser) log("superuser: no credentials in this checkout, the Worker keeps the ones it has");
  else {
    if (!email) email = "admin@example.com";
    if (isPlaceholder(password)) { password = randomPassword(); superuserSource = "generated"; log(`generated a superuser password for ${email} (saved in ${credFile}; change it after the first login)`); }
    writeFileSync(credFile, JSON.stringify({ email, password }, null, 2) + "\n", { mode: 0o600 });
  }

  // the Worker's secrets: the superuser, VOIDBASE_DEPLOY_SECRETS=X,Y from the environment, and the declared
  // pb_secrets/ names the Worker does not have yet. A deploy ships code; a value the Worker already holds is
  // replaced only by `voidbase secrets push`, so a checkout whose secrets.json carries dev values (another OAuth
  // client, the placeholder password) cannot overwrite production by deploying. A declared name with no value
  // here must already be on the Worker.
  const declared = definition ? definition.of("secret") : [];
  const secretMap = new Map<string, string>(keepSuperuser ? [] : [["VOIDBASE_SUPERUSER_EMAIL", email], ["VOIDBASE_SUPERUSER_PASSWORD", password]]);
  for (const k of extraSecrets) if (process.env[k]) secretMap.set(k, process.env[k]!);
  const kept: string[] = [];
  for (const k of declared) {
    const v = pbSecrets.evaluation?.stored[k]; if (v === undefined) continue;
    if (held(k)) { kept.push(k); continue; }
    if (k === "VOIDBASE_SUPERUSER_PASSWORD" && v === "changeme123") { log("secrets: VOIDBASE_SUPERUSER_PASSWORD in secrets.json is the dev placeholder, not stored"); continue; }
    secretMap.set(k, v);
  }
  // a secret declared optional may have no value anywhere: the app reads undefined, as declared, and the deploy goes on
  const optionalSecrets = new Set(definition ? (await definition.info()).filter((k) => k.optional).map((k) => k.name) : []);
  const missingSecrets = declared.filter((k) => !secretMap.has(k) && !held(k) && !optionalSecrets.has(k));
  if (missingSecrets.length && local) log(`secrets: ${missingSecrets.length} declared secret(s) have no value in ${secretsDir}/secrets.json or the shell: ${missingSecrets.join(", ")} (the app reads them as unset here)`);
  else if (missingSecrets.length) {
    const msg = `${missingSecrets.length} declared secret(s) have no value in ${secretsDir}/secrets.json and are not on the Worker "${name}" yet: ${missingSecrets.join(", ")}. Push them once from a machine that has them: voidbase secrets push --name ${name}`;
    if (opts.dryRun) log(`secrets: ${msg}`); else throw new Error(msg);
  } else if (declared.length && local) log(`secrets: ${declared.length} declared, ${declared.filter((k) => secretMap.has(k)).length} valued here`);
  else if (declared.length) log(`secrets: ${declared.length} declared; ${declared.filter((k) => secretMap.has(k)).length} stored from here, ${kept.length} kept as the Worker has them (voidbase secrets push replaces)`);
  const secrets = [...secretMap.entries()];
  // with a store: every secret the Worker uses is bound from the store by name, and the Worker's own of those names
  // are retired, because a binding name is one thing or the other
  const storeKeys = store ? [...new Set([...secretMap.keys(), ...declared.filter(heldInStore), ...extraSecrets.filter(heldInStore)])] : [];
  const retire = storeKeys.filter((k) => onWorker.includes(k));
  // the vars file Void bakes into the Worker. A local run has no Worker secrets to put anything in, so the superuser
  // and the declared secrets go in as plain vars too: the file is git-ignored, and a deploy rewrites it without them.
  const envFile = () => [...Object.entries(baked), ...(local ? secrets : [])].map(([k, v]) => `${k}=${v}\n`).join("");
  if (!store) writeFileSync(`${cloud}/.env`, envFile());
  if (local && secrets.length) log(`vars: ${secrets.map(([k]) => k).join(", ")} written to ${cloud}/.env as the Worker's vars (a deploy stores them as secrets instead)`);
  if (store) {
    workerConfig.secrets_store_secrets = storeBindings(store, name, storeKeys); writeWorkerConfig();
    // the names, as a var: a Workflow step sees the same bindings as RPC stubs whose shape says nothing (src/server/secrets-store.ts)
    if (storeKeys.length) baked[STORE_KEYS_VAR] = storeKeys.join(",");
    // the vars file Void bakes into the Worker is written here, once everything that goes in it is known
    writeFileSync(`${cloud}/.env`, Object.entries(baked).map(([k, v]) => `${k}=${v}\n`).join(""));
    log(`secrets store ${store}: ${secrets.length ? `${opts.dryRun ? "would store" : "storing"} ${secrets.map(([k]) => k).join(", ")}` : "nothing to store"}; bound by name: ${storeKeys.join(", ") || "none"}${retire.length ? `; ${opts.dryRun ? "would retire" : "retiring"} ${retire.join(", ")} from the Worker's own secrets` : ""}`);
  }

  // the URL: what a plugin claimed (a custom domain), else the workers.dev address unless something turned it off
  const url = !api ? null : hookCtx.url ?? (workerConfig.workers_dev === false ? null : await workersSubdomain(api, account.id).then((s) => (s ? `https://${name}.${s}.workers.dev` : null)));
  hookCtx.url = url;
  if (workflows.length) log(`workflows: ${workflows.map((w) => `${w.stem} (${w.className}) bound as ${w.binding}`).join(", ")}`);
  log(`bindings: ${durable ? "database (Durable Object, SQLite)" : "D1"}, R2${hub ? ", realtime hub (Durable Object)" : ""}${queue ? ", Queue" : ""}${mailDomain ? `, Email Sending (${MAIL_BINDING})` : ""}${aiModel ? `, Workers AI (${AI_BINDING}, ${aiModel})` : ""}${rateLimit ? `, rate limit ceiling ${rateLimit.limit}/${rateLimit.period}s per IP` : ""}${analytics ? ", Analytics Engine (needs Analytics Engine enabled once for the account: https://dash.cloudflare.com/" + account.id + "/workers/analytics-engine)" : ""}`);
  if (opts.dryRun) { await runDeployHooks("after", deployPlugins, hookCtx); log(`dry run: would sync the panel${publicDir ? ` and ${publicDir}` : ""} into ${cloud}/public, put ${secrets.length} secrets (${secrets.map(([k]) => k).join(", ")}) and run void deploy --backend cloudflare (${url ?? "url unknown"})`); return { name, account: account.id, url, wranglerConfig: JSON.stringify(workerConfig, null, 2) + "\n", project: cloud, database }; }

  // the toolchain comes with the voidbase package (void, and wrangler through void)
  const voidDir = resolve(Bun.resolveSync("void/package.json", PKG), "..");
  const voidBin = resolve(voidDir, "..", ".bin", "void"); const wrangler = resolve(Bun.resolveSync("wrangler/package.json", voidDir), "..", "bin", "wrangler.js");
  // values also exported in the shell are stripped from baked vars by the Cloudflare backend, so keep the vars file clean instead
  // the generated project has no node_modules of its own: `void deploy` shells out to `vite build`, so the package's toolchain goes on PATH
  const binDirs = [resolve(PKG, "node_modules/.bin"), resolve(voidDir, "..", ".bin")].filter((d, i, a) => a.indexOf(d) === i);
  // Void runs project code with Node (its env probe, the Vite config, drizzle-kit): an installed voidbase is
  // TypeScript under node_modules, which Node will not strip on its own, so Node gets this package's loader
  const loader = `--import ${pathToFileURL(resolve(PKG, "src/node/ts-loader.mjs")).href}`;
  const env: Record<string, string | undefined> = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, loader].filter(Boolean).join(" "), PATH: `${binDirs.join(":")}:${process.env.PATH ?? ""}`, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account.id, ...(keepSuperuser ? {} : { VOIDBASE_SUPERUSER_EMAIL: email, VOIDBASE_SUPERUSER_PASSWORD: password }) };
  for (const k of Object.keys(baked)) delete env[k];
  const sh = async (cmd: string[], input?: string) => { const p = Bun.spawn(cmd, { cwd: cloud, env: env as Record<string, string>, stdin: input === undefined ? "inherit" : new TextEncoder().encode(input), stdout: "inherit", stderr: "inherit" }); const code = await p.exited; if (code !== 0) throw new Error(`${cmd.join(" ")} exited with ${code}`); };
  mkdirSync(`${cloud}/public`, { recursive: true });
  // the panel comes from a cache or a one-time download; a machine without network still gets its API
  try { await sh(["bun", resolve(PKG, "scripts/sync-panel.ts"), "--dest", `${cloud}/public/_`]); }
  catch (err) { if (!local) throw err; log(`panel: not synced (${err instanceof Error ? err.message : err}); /_/ answers 404 until a run with network access, or set POCKETBASE_UI_DIST`); }
  if (publicDir) {
    env.VOIDBASE_APP_DIR = resolve(publicDir); await sh(["bun", resolve(PKG, "scripts/sync-app.ts"), "--dest", `${cloud}/public`], undefined); log(`static site ${resolve(publicDir)} served at / (the panel stays at /_/)`);
    if (pathRedirects.length) writeFileSync(`${cloud}/public/_redirects`, pathRedirects.map((r) => `${r.path} ${r.to} ${r.status}`).join("\n") + "\n");
  }
  // a local run stops here: the project is complete, and src/node/serve-workers.ts starts Void's dev server in it
  if (!api) { await runDeployHooks("after", deployPlugins, hookCtx); return { name, account: "", url: null, wranglerConfig: JSON.stringify(workerConfig, null, 2) + "\n", project: cloud, database, superuser: { email, password, file: credFile, source: superuserSource }, vars: [...Object.keys(baked), ...secrets.map(([k]) => k)] }; }
  if (secrets.length && !store) log(`secrets: storing ${secrets.map(([k]) => k).join(", ")} on the Worker`);
  // Through the Workers API when the Worker exists, which is every deploy but the first: `wrangler secret put` reads
  // the value from stdin and, on Cloudflare's build machines, sometimes never sees the end of it and waits forever
  // (the demo's deploys hung there twice). The first deploy has no Worker to put a secret on, and wrangler creates
  // one, so that is the only time it is still used.
  if (store) {
    if (secrets.length) { const r = await putStoreSecrets(api, account.id, store, name, Object.fromEntries(secrets)); log(`secrets store: ${r.created.length ? `created ${r.created.join(", ")}` : ""}${r.created.length && r.updated.length ? "; " : ""}${r.updated.length ? `replaced ${r.updated.join(", ")}` : ""}`); }
    if (retire.length) { await deleteWorkerSecrets(api, account.id, name, retire); log(`secrets: ${retire.join(", ")} retired from the Worker's own secrets; the store binds them now`); }
  } else if (secrets.length && (await workerExists(api, account.id, name))) await putWorkerSecrets(api, account.id, name, Object.fromEntries(secrets));
  else for (const [k, v] of secrets) await sh(["bun", wrangler, "secret", "put", k, "--name", name], v + "\n");
  await sh([voidBin, "deploy", "--backend", "cloudflare"]);
  if (hostRedirects.length) await applyZoneRedirects(api, account.id, name, hostRedirects, log);
  // the deploy plugins' `after`: the Worker is up, the account is theirs to act on
  await runDeployHooks("after", deployPlugins, hookCtx);
  if (url) {
    const ok = await fetch(`${url}/api/health`).then((r) => r.status).catch(() => 0);
    log(`\nlive: ${url}  (health ${ok || "not reachable yet"})\n├─ REST API:  ${url}/api/\n└─ Dashboard: ${url}/_/   sign in as ${keepSuperuser ? "the superuser the Worker already had" : `${email} (password in ${credFile})`}`);
  } else log("deployed; workers.dev subdomain not enabled on this account, add a route or enable it in the dashboard (or VOIDBASE_DOMAINS=<host> / --domain)");
  return { name, account: account.id, url, wranglerConfig: JSON.stringify(workerConfig, null, 2) + "\n", project: cloud, database };
}

/** the environment a deploy plugin reads: pb_secrets/secrets.json under the shell and the .env files, plus what a flag says */
function hookEnv(secretsDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return { ...(readSecretsValues(secretsDir) ?? {}), ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string")), ...extra };
}

/**
 * `voidbase deploy --remove`: the deploy plugins undo their part (`remove` hooks), then the Worker is deleted. Its
 * database, bucket and queue stay, with the data in them: `voidbase destroy` is the command that removes those.
 * With `--preview <branch>` the target is the branch's preview instance, and everything it owns goes with the
 * Worker (a preview is disposable by definition; the CLI still asks, or takes `--yes`).
 */
export async function removeDeployment(opts: Pick<DeployOptions, "name" | "account" | "dryRun" | "log" | "preview"> = {}): Promise<{ name: string; deleted: boolean; hooks: string[] }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const { api, account, name, production, preview, secretsDir } = await deployTarget(opts);
  log(`account ${account.name} (${account.id}), worker "${name}"${preview ? ` (the preview of ${production} for branch ${preview})` : ""}`);
  const deployPlugins = await discoverDeployPlugins(resolve(".", process.env.VOIDBASE_PLUGINS_DIR || "pb_plugins"));
  if (deployPlugins.length) log(`deploy plugins: ${deployPlugins.map((p) => `${p.name} (${p.origin})`).join(", ")}`);
  const ctx: DeployContext = { name, account: { id: account.id }, api, env: hookEnv(secretsDir, previewEnv({ production, preview })), config: {}, vars: { ...previewEnv({ production, preview }) }, url: null, log, local: false, dryRun: !!opts.dryRun };
  const hooks = await runDeployHooks("remove", deployPlugins, ctx);
  if (preview) {
    if (opts.dryRun) { log(`dry run: would delete the preview ${name} with its database, bucket and queue`); return { name, deleted: false, hooks }; }
    const out = await destroyInstance(api, { account: account.id, name, log: (l) => log(`  ${l}`) });
    if (out.errors.length) throw new Error(`removing the preview ${name}: ${out.errors.join("; ")}`);
    log(`preview ${name} removed: ${out.deleted.length} deleted, ${out.skipped.length} not there`);
    return { name, deleted: out.deleted.includes(`worker ${name}`), hooks };
  }
  const stays = `its database, bucket and queue stay (voidbase destroy ${name} removes those)`;
  if (opts.dryRun) { log(`dry run: would delete the Worker ${name}; ${stays}`); return { name, deleted: false, hooks }; }
  if (!(await workerExists(api, account.id, name))) { log(`worker ${name}: not on the account; ${stays}`); return { name, deleted: false, hooks }; }
  // Cloudflare refuses to delete a Worker that consumes a queue (10064): the consumer goes first, the queue stays
  const q = await findQueue(api, account.id, `${name}-jobs`);
  if (q) {
    const consumers = await api.json<{ consumer_id?: string; id?: string; script?: string; script_name?: string }[]>("GET", `/accounts/${account.id}/queues/${q.id}/consumers`);
    for (const c of consumers.result ?? []) if ((c.script ?? c.script_name) === name) await api.json("DELETE", `/accounts/${account.id}/queues/${q.id}/consumers/${c.consumer_id ?? c.id}`);
  }
  const r = await api.raw("DELETE", `/accounts/${account.id}/workers/scripts/${name}?force=true`); const body = await r.text();
  if (!r.ok && r.status !== 404) throw new Error(`deleting the Worker ${name}: HTTP ${r.status} ${body.slice(0, 200)}`);
  log(`worker ${name} deleted; ${stays}`);
  return { name, deleted: true, hooks };
}

// The sending domain's standing on the account, as far as the token can see. The binding needs the domain onboarded
// for Email Sending (Cloudflare writes the SPF, DKIM and DMARC records itself), which is a dashboard step or the
// zone's email/sending API; the deploy token has neither zone permission, so this checks what it can and says the
// rest. Read with the zone's sending-subdomains list when the token happens to allow it (checked 2026-09-11 against
// developers.cloudflare.com/api/resources/email_sending: the list carries `name` and `enabled`).
export async function mailDomainReport(api: CfApi | null, account: string, domain: string): Promise<string> {
  const onboard = `onboard ${domain} for Email Sending once in the dashboard (Email > Email Sending > add a domain: Cloudflare writes the SPF, DKIM and DMARC records itself); until then the binding delivers only to the account's verified destination addresses`;
  if (!api) return `mail: ${domain} would send through Cloudflare Email Service as ${MAIL_BINDING}; nothing to check from this machine`;
  let zone: { id: string; name: string } | null | undefined;
  try { zone = await findZone(api, domain, account); } catch { zone = undefined; }
  if (zone === undefined) return `mail: ${domain} bound as ${MAIL_BINDING}; the token cannot list zones, so whether its zone is on the account was not checked: ${onboard}`;
  if (!zone) return `mail: ${domain} bound as ${MAIL_BINDING}, but no zone on account ${account} covers it: add the domain to Cloudflare first, then ${onboard}`;
  try {
    const r = await api.raw("GET", `/zones/${zone.id}/email/sending/subdomains`);
    if (r.ok) {
      const list = ((JSON.parse(await r.text()) as { result?: { name?: string; enabled?: boolean }[] }).result ?? []);
      if (list.some((s) => s.name === domain && s.enabled)) return `mail: ${domain} bound as ${MAIL_BINDING}; the domain is onboarded for Email Sending on zone ${zone.name}`;
      return `mail: ${domain} bound as ${MAIL_BINDING}; zone ${zone.name} is on the account but the domain is not onboarded for Email Sending yet: ${onboard}`;
    }
  } catch { /* the token cannot read the zone's email settings, which is the expected case */ }
  return `mail: ${domain} bound as ${MAIL_BINDING} (zone ${zone.name} is on the account; the token cannot read its Email Sending state): ${onboard}`;
}

// the host-scoped redirects as zone Redirect Rules live in src/node/zone-redirects.ts (re-exported above)
