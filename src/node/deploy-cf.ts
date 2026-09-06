// `voidbase deploy`: go live on your own Cloudflare account with one API token (VOIDBASE_DEPLOY_CF_API_KEY).
// Resolves the account, creates the D1 database, the R2 bucket and the jobs queue over the REST API (idempotent),
// writes the Void project (cloud/) with a wrangler.jsonc carrying the real ids plus the rate-limit and Analytics
// Engine bindings, stores the superuser credentials as worker secrets and runs `void deploy --backend cloudflare`,
// which builds, applies the D1 migrations and uploads the Worker.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeCloudProject } from "./cloud-init";
import { loadEnv } from "./serve";
import { CfApi, attachCustomDomain, ensureD1, ensureQueue, ensureR2, rateLimitNamespace, resolveAccount, workersSubdomain } from "../cloud/rest";

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
  rateLimit?: string;   // exact per-location ceiling per IP as "<requests>/<10|60>", default "300/10" (PocketBase's /api/ rule); "0" disables
  hub?: boolean;        // realtime hub Durable Object in this Worker (default on; VOIDBASE_DEPLOY_HUB=0 keeps the D1 poll)
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
const ENV_KEYS = [TOKEN_ENV, "VOIDBASE_DEPLOY_CF_ACCOUNT_ID", "VOIDBASE_DEPLOY_NAME", "VOIDBASE_DEPLOY_QUEUE", "VOIDBASE_DEPLOY_HUB", "VOIDBASE_DEPLOY_ANALYTICS", "VOIDBASE_DEPLOY_RATE_LIMIT", "VOIDBASE_SUPERUSER_EMAIL", "VOIDBASE_SUPERUSER_PASSWORD", "PB_SUPERUSER_EMAIL", "PB_SUPERUSER_PASSWORD", "AUDITLOG"];
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

export async function deployToCloudflare(opts: DeployOptions = {}): Promise<{ name: string; account: string; url: string | null; wranglerConfig: string; project: string }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  loadEnv(); const fromFiles = loadEnvFiles(); if (fromFiles.length) log(`from .env: ${fromFiles.join(", ")}`);
  const token = process.env[TOKEN_ENV] || process.env.CLOUDFLARE_API_TOKEN || ""; // empty means unset
  if (!token) { log(`${TOKEN_ENV} is not set.\n\n${tokenHelp()}`); throw new Error(`${TOKEN_ENV} missing`); }
  const name = slug(opts.name || process.env.VOIDBASE_DEPLOY_NAME || projectName());
  const api = new CfApi(token, API);
  const account = await resolveAccount(api, opts.account || process.env.VOIDBASE_DEPLOY_CF_ACCOUNT_ID || undefined).catch((e: Error) => { throw new Error(`${e.message} (is it ${TOKEN_ENV} with Account Settings read?)`); });
  log(`account ${account.name} (${account.id}), worker "${name}"`);
  const db = await ensureD1(api, account.id, `${name}-db`); log(`D1 ${name}-db ${db.created ? "created" : "exists"} (${db.uuid})`);
  const bucket = await ensureR2(api, account.id, `${name}-storage`); log(`R2 ${name}-storage ${bucket.created ? "created" : "exists"}`);
  const off = (v: string | undefined) => v !== undefined && ["0", "false", "off", "no"].includes(v.trim().toLowerCase());
  const wantQueue = opts.queue ?? !off(process.env.VOIDBASE_DEPLOY_QUEUE);
  const on = (v: string | undefined) => v !== undefined && ["1", "true", "on", "yes"].includes(v.trim().toLowerCase());
  const analytics = opts.analytics ?? on(process.env.VOIDBASE_DEPLOY_ANALYTICS);
  const rateLimit = parseRateLimit(opts.rateLimit ?? process.env.VOIDBASE_DEPLOY_RATE_LIMIT);
  const hub = opts.hub ?? !off(process.env.VOIDBASE_DEPLOY_HUB);
  // Workers Free allows 5 cron triggers per account; without the trigger PocketBase's maintenance runs lazily in requests
  const cron = opts.cron ?? !off(process.env.VOIDBASE_DEPLOY_CRON);
  // a custom domain on a zone of the account (wrangler attaches it: DNS record + certificate); workers.dev is then off
  const domain = String(opts.domain || process.env.VOIDBASE_DEPLOY_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error(`invalid custom domain "${domain}"`);
  let queue: string | false = false;
  if (wantQueue) {
    const q = await ensureQueue(api, account.id, `${name}-jobs`);
    queue = q.id ? `${name}-jobs` : false;
    if (queue) log(`Queue ${name}-jobs ${q.created ? "created" : "exists"} (mail and automatic backups run from it with retries)`);
    else log(`Queue ${name}-jobs not created (${q.reason}): mail is sent inline and backups run in the cron tick. Give the token the Queues edit permission (${tokenDeepLink()}) to enable it, or VOIDBASE_DEPLOY_QUEUE=0 to silence this.`);
  }

  // the Void project lives inside the voidbase package (<package>/.cloud/<slug>), not in the consumer's tree:
  // its entry files import this package by relative path and resolve `void`/`vite` by walking up to node_modules
  const PKG = resolve(import.meta.dir, "../.."); const cloud = opts.dir ? resolve(opts.dir) : resolve(PKG, ".cloud", name);
  const consumer = resolve(".");
  const entry = ["main.ts", "main.js"].map((f) => resolve(consumer, f)).find((f) => existsSync(f) && /export\s+(async\s+)?function\s+register\b|export\s*\{[^}]*\bregister\b/.test(readFileSync(f, "utf8")));
  if (entry) log(`composing ${entry} (register) into the Worker`);
  writeCloudProject(cloud, opts.dir ? "package" : "internal", { hooksDir: resolve(consumer, process.env.VOIDBASE_HOOKS_DIR || "pb_hooks"), migrationsDir: resolve(consumer, process.env.VOIDBASE_MIGRATIONS_DIR || "pb_migrations"), entry, queue, hub });
  if (!queue) { const { rmSync } = await import("node:fs"); rmSync(`${cloud}/queues`, { recursive: true, force: true }); }
  if (!cron) { const { rmSync } = await import("node:fs"); rmSync(`${cloud}/crons`, { recursive: true, force: true }); log("cron trigger disabled (VOIDBASE_DEPLOY_CRON=0 / --no-cron): maintenance runs lazily in requests"); }
  // Smart Placement runs the Worker next to its D1 database: PocketBase-shaped requests are several dependent queries.
  // The rate-limit binding is an exact per-location ceiling per IP on top of the settings' rules (which count per
  // isolate); the Analytics Engine dataset takes one data point per request at any log level.
  const wranglerConfig = JSON.stringify({
    name, account_id: account.id, placement: { mode: "smart" },
    ...(domain ? { workers_dev: false } : {}), // the custom domain is attached through the API after the upload (see below)
    d1_databases: [{ binding: "DB", database_name: `${name}-db`, database_id: db.uuid, migrations_dir: "./db/migrations" }],
    r2_buckets: [{ binding: "STORAGE", bucket_name: `${name}-storage` }],
    ...(rateLimit ? { ratelimits: [{ name: "RATE_LIMITER", namespace_id: rateLimitNamespace(name), simple: { limit: rateLimit.limit, period: rateLimit.period } }] } : {}),
    ...(analytics ? { analytics_engine_datasets: [{ binding: "LOGS_ANALYTICS", dataset: `${name.replace(/-/g, "_")}_requests` }] } : {}),
    // the realtime hub: a SQLite-backed Durable Object class exported from this Worker (free plan included), one per instance
    ...(hub ? { durable_objects: { bindings: [{ name: "HUB", class_name: "VoidbaseHub" }] }, migrations: [{ tag: "voidbase-hub-v1", new_sqlite_classes: ["VoidbaseHub"] }] } : {}),
  }, null, 2) + "\n";
  writeFileSync(`${cloud}/wrangler.jsonc`, `// written by voidbase deploy; ids are real resources on account ${account.id}\n${wranglerConfig}`);
  // non-secret worker vars: the instance's own name and account (a control plane needs them to find itself), the
  // hooks' AUDITLOG, plus VOIDBASE_DEPLOY_VARS=A,B from the environment; secrets (VOIDBASE_DEPLOY_SECRETS=X,Y) never go here
  const listed = (key: string) => (process.env[key] ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  const extraVars = listed("VOIDBASE_DEPLOY_VARS"), extraSecrets = listed("VOIDBASE_DEPLOY_SECRETS");
  const baked: Record<string, string> = { VOIDBASE_WORKER_NAME: name, VOIDBASE_ACCOUNT_ID: account.id };
  for (const k of ["AUDITLOG", ...extraVars]) if (process.env[k]) baked[k] = process.env[k]!;
  writeFileSync(`${cloud}/.env`, Object.entries(baked).map(([k, v]) => `${k}=${v}\n`).join(""));
  log(`project: ${cloud}`);

  // superuser: from the environment (PB_* is what the starter's entrypoint uses) or generated once and kept in pb_data
  const dataDir = resolve(consumer, process.env.VOIDBASE_DATA_DIR || "pb_data"); mkdirSync(dataDir, { recursive: true });
  const credFile = `${dataDir}/.superuser-credentials`;
  let email = opts.superuserEmail || process.env.VOIDBASE_SUPERUSER_EMAIL || process.env.PB_SUPERUSER_EMAIL || "";
  let password = opts.superuserPassword || process.env.VOIDBASE_SUPERUSER_PASSWORD || process.env.PB_SUPERUSER_PASSWORD || "";
  const saved = existsSync(credFile) ? (JSON.parse(readFileSync(credFile, "utf8")) as { email: string; password: string }) : null;
  const placeholder = !password || password === "changeme123"; // the local dev default never goes live
  if (placeholder && saved && (!email || email === saved.email)) { email = saved.email; password = saved.password; }
  if (!email) email = "admin@example.com";
  if (!password || password === "changeme123") { password = randomPassword(); log(`generated a superuser password for ${email} (saved in ${credFile}; change it after the first login)`); }
  writeFileSync(credFile, JSON.stringify({ email, password }, null, 2) + "\n", { mode: 0o600 });

  const url = domain ? `https://${domain}` : await workersSubdomain(api, account.id).then((s) => (s ? `https://${name}.${s}.workers.dev` : null));
  if (domain) log(`custom domain ${domain} (workers.dev off): attached through the Workers Custom Domains API after the upload (Cloudflare adds the DNS record and certificate)`);
  log(`bindings: D1, R2${hub ? ", realtime hub (Durable Object)" : ""}${queue ? ", Queue" : ""}${rateLimit ? `, rate limit ceiling ${rateLimit.limit}/${rateLimit.period}s per IP` : ""}${analytics ? ", Analytics Engine (needs Analytics Engine enabled once for the account: https://dash.cloudflare.com/" + account.id + "/workers/analytics-engine)" : ""}`);
  if (opts.dryRun) { log(`dry run: would sync the panel${opts.publicDir ? ` and ${opts.publicDir}` : ""} into ${cloud}/public, put 2 secrets and run void deploy --backend cloudflare (${url ?? "url unknown"})`); return { name, account: account.id, url, wranglerConfig, project: cloud }; }

  // the toolchain comes with the voidbase package (void, and wrangler through void)
  const voidDir = resolve(Bun.resolveSync("void/package.json", PKG), "..");
  const voidBin = resolve(voidDir, "..", ".bin", "void"); const wrangler = resolve(Bun.resolveSync("wrangler/package.json", voidDir), "..", "bin", "wrangler.js");
  // values also exported in the shell are stripped from baked vars by the Cloudflare backend, so keep the vars file clean instead
  // the generated project has no node_modules of its own: `void deploy` shells out to `vite build`, so the package's toolchain goes on PATH
  const binDirs = [resolve(PKG, "node_modules/.bin"), resolve(voidDir, "..", ".bin")].filter((d, i, a) => a.indexOf(d) === i);
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${binDirs.join(":")}:${process.env.PATH ?? ""}`, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account.id, VOIDBASE_SUPERUSER_EMAIL: email, VOIDBASE_SUPERUSER_PASSWORD: password };
  for (const k of Object.keys(baked)) delete env[k];
  const sh = async (cmd: string[], input?: string) => { const p = Bun.spawn(cmd, { cwd: cloud, env: env as Record<string, string>, stdin: input === undefined ? "inherit" : new TextEncoder().encode(input), stdout: "inherit", stderr: "inherit" }); const code = await p.exited; if (code !== 0) throw new Error(`${cmd.join(" ")} exited with ${code}`); };
  mkdirSync(`${cloud}/public`, { recursive: true });
  await sh(["bun", resolve(PKG, "scripts/sync-panel.ts"), "--dest", `${cloud}/public/_`]);
  if (opts.publicDir) await sh(["bun", resolve(PKG, "scripts/sync-app.ts"), "--dest", `${cloud}/public`], undefined).catch((e) => log(`frontend build not synced: ${e instanceof Error ? e.message : e}`));
  const secrets: [string, string][] = [["VOIDBASE_SUPERUSER_EMAIL", email], ["VOIDBASE_SUPERUSER_PASSWORD", password], ...extraSecrets.filter((k) => process.env[k]).map((k): [string, string] => [k, process.env[k]!])];
  for (const [k, v] of secrets) await sh(["bun", wrangler, "secret", "put", k, "--name", name], v + "\n");
  await sh([voidBin, "deploy", "--backend", "cloudflare"]);
  if (domain) {
    const d = await attachCustomDomain(api, account.id, { hostname: domain, service: name });
    log(`custom domain ${d.hostname} ${d.created ? "attached" : "already attached"} (zone ${d.zone_id}); the certificate can take a minute`);
  }
  if (url) {
    const ok = await fetch(`${url}/api/health`).then((r) => r.status).catch(() => 0);
    log(`\nlive: ${url}  (health ${ok || "not reachable yet"})\n├─ REST API:  ${url}/api/\n└─ Dashboard: ${url}/_/   sign in as ${email} (password in ${credFile})`);
  } else log("deployed; workers.dev subdomain not enabled on this account, add a route or enable it in the dashboard (or VOIDBASE_DEPLOY_DOMAIN=<host> / --domain)");
  return { name, account: account.id, url, wranglerConfig, project: cloud };
}
