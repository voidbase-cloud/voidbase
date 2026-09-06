// `voidbase deploy`: go live on your own Cloudflare account with one API token (VOIDBASE_DEPLOY_CF_API_KEY).
// Resolves the account, creates the D1 database and R2 bucket over the REST API (idempotent), writes the Void
// project (cloud/) with a wrangler.jsonc carrying the real ids, stores the superuser credentials as worker secrets
// and runs `void deploy --backend cloudflare`, which builds, applies the D1 migrations and uploads the Worker.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeCloudProject } from "./cloud-init";

const API = (process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
export const TOKEN_ENV = "VOIDBASE_DEPLOY_CF_API_KEY";
// Account-owned token template (docs: fundamentals/api/how-to/account-owned-token-template): the dashboard resolves
// :account to the signed-in account and pre-selects exactly what the deploy needs.
export const TOKEN_PERMISSIONS = [
  { key: "workers_scripts", type: "edit" }, // upload the Worker, its cron trigger and secrets
  { key: "d1", type: "edit" },              // create the database, apply migrations
  { key: "workers_r2", type: "edit" },      // create the files bucket
  { key: "account_settings", type: "read" }, // resolve the account id and workers.dev subdomain
];
export const tokenDeepLink = () => `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${encodeURIComponent(JSON.stringify(TOKEN_PERMISSIONS))}&name=${encodeURIComponent(TOKEN_ENV)}`;
export const tokenHelp = () => `Create the deploy token in the Cloudflare dashboard (permissions pre-selected):

  ${tokenDeepLink()}

Then make it available as ${TOKEN_ENV} (shell export, .env next to pb_hooks, or a CI secret) and run: voidbase deploy
Permissions the link pre-selects: Workers Scripts (edit), D1 (edit), Workers R2 Storage (edit), Account Settings (read).
If the link format ever changes, pick those four by hand at https://dash.cloudflare.com/?to=/:account/api-tokens
(reference: https://developers.cloudflare.com/fundamentals/api/reference/permissions/).`;

export interface DeployOptions { name?: string; account?: string; dir?: string; publicDir?: string; dryRun?: boolean; regenerate?: boolean; superuserEmail?: string; superuserPassword?: string; log?: (line: string) => void }

interface CfResponse<T> { success: boolean; errors: { code: number; message: string }[]; result: T }
async function cf<T>(token: string, method: string, path: string, body?: unknown): Promise<CfResponse<T>> {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  try { return JSON.parse(text) as CfResponse<T>; } catch { return { success: false, errors: [{ code: res.status, message: text.slice(0, 200) || res.statusText }], result: null as T }; }
}
const fail = (what: string, r: CfResponse<unknown>) => new Error(`${what}: ${r.errors?.map((e) => `${e.code} ${e.message}`).join("; ") || "unknown error"}`);

export async function resolveAccount(token: string, wanted?: string): Promise<{ id: string; name: string }> {
  const r = await cf<{ id: string; name: string }[]>(token, "GET", "/accounts?per_page=50");
  if (!r.success) throw fail(`the token cannot list accounts (is it ${TOKEN_ENV} with Account Settings read?)`, r);
  const accounts = r.result ?? [];
  if (wanted) { const a = accounts.find((x) => x.id === wanted || x.name === wanted); if (!a) throw new Error(`account ${wanted} is not reachable with this token (${accounts.map((x) => x.id).join(", ")})`); return a; }
  if (accounts.length === 1) return accounts[0]!;
  if (accounts.length === 0) throw new Error("the token reaches no account");
  throw new Error(`the token reaches ${accounts.length} accounts; pass --account <id> (${accounts.map((x) => `${x.id} ${x.name}`).join(", ")})`);
}
export async function ensureD1(token: string, account: string, name: string): Promise<{ uuid: string; created: boolean }> {
  const list = await cf<{ uuid: string; name: string }[]>(token, "GET", `/accounts/${account}/d1/database?name=${encodeURIComponent(name)}&per_page=100`);
  if (!list.success) throw fail("listing D1 databases", list);
  const found = (list.result ?? []).find((d) => d.name === name);
  if (found) return { uuid: found.uuid, created: false };
  const made = await cf<{ uuid: string }>(token, "POST", `/accounts/${account}/d1/database`, { name });
  if (!made.success) {
    if (made.errors?.some((e) => e.code === 7406)) throw new Error(`creating the D1 database ${name}: the account is at its D1 database limit (${made.errors.map((e) => e.message).join("; ")}). Delete an unused database (dashboard > Storage & Databases > D1, or \`wrangler d1 delete <name>\`) or upgrade the Workers plan, then run voidbase deploy again; nothing was created.`);
    throw fail(`creating the D1 database ${name}`, made);
  }
  return { uuid: made.result.uuid, created: true };
}
export async function ensureR2(token: string, account: string, name: string): Promise<{ created: boolean }> {
  const head = await cf<unknown>(token, "GET", `/accounts/${account}/r2/buckets/${encodeURIComponent(name)}`);
  if (head.success) return { created: false };
  const made = await cf<unknown>(token, "POST", `/accounts/${account}/r2/buckets`, { name });
  if (!made.success) throw fail(`creating the R2 bucket ${name}`, made);
  return { created: true };
}
export async function workersSubdomain(token: string, account: string): Promise<string | null> {
  const r = await cf<{ subdomain?: string }>(token, "GET", `/accounts/${account}/workers/subdomain`);
  return r.success && r.result?.subdomain ? r.result.subdomain : null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 54) || "voidbase";
function projectName(): string {
  try { const n = String((JSON.parse(readFileSync("package.json", "utf8")) as { name?: string }).name ?? ""); if (n && n !== "vb" && n !== "pb") return slug(n); } catch { /* no package.json */ }
  const dir = slug(resolve(".").split("/").at(-1) ?? "");
  return dir === "vb" || dir === "pb" ? slug(`${resolve("..").split("/").at(-1) ?? "voidbase"}-backend`) : dir;
}
const randomPassword = () => { const a = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const b = crypto.getRandomValues(new Uint8Array(20)); return Array.from(b, (x) => a[x % a.length]).join(""); };

// Bun only loads the .env of the working directory; the starter keeps its PB_* and deploy variables one level up.
const ENV_KEYS = [TOKEN_ENV, "VOIDBASE_DEPLOY_CF_ACCOUNT_ID", "VOIDBASE_DEPLOY_NAME", "VOIDBASE_SUPERUSER_EMAIL", "VOIDBASE_SUPERUSER_PASSWORD", "PB_SUPERUSER_EMAIL", "PB_SUPERUSER_PASSWORD"];
export function loadEnvFiles(files = [".env", "../.env"]): string[] {
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

export async function deployToCloudflare(opts: DeployOptions = {}): Promise<{ name: string; account: string; url: string | null; wranglerConfig: string }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const fromFiles = loadEnvFiles(); if (fromFiles.length) log(`from .env: ${fromFiles.join(", ")}`);
  const token = process.env[TOKEN_ENV] || process.env.CLOUDFLARE_API_TOKEN || ""; // empty means unset
  if (!token) { log(`${TOKEN_ENV} is not set.\n\n${tokenHelp()}`); throw new Error(`${TOKEN_ENV} missing`); }
  const name = slug(opts.name || process.env.VOIDBASE_DEPLOY_NAME || projectName());
  const account = await resolveAccount(token, opts.account || process.env.VOIDBASE_DEPLOY_CF_ACCOUNT_ID || undefined);
  log(`account ${account.name} (${account.id}), worker "${name}"`);
  const db = await ensureD1(token, account.id, `${name}-db`); log(`D1 ${name}-db ${db.created ? "created" : "exists"} (${db.uuid})`);
  const bucket = await ensureR2(token, account.id, `${name}-storage`); log(`R2 ${name}-storage ${bucket.created ? "created" : "exists"}`);

  // the Void project: generated once, regenerated on request; wrangler.jsonc carries the real ids
  const cloud = resolve(opts.dir ?? "cloud");
  if (opts.regenerate || !existsSync(`${cloud}/vite.config.ts`)) { const r = writeCloudProject(cloud); log(`wrote ${r.files} files to ${cloud}`); }
  const wranglerConfig = JSON.stringify({ name, account_id: account.id, d1_databases: [{ binding: "DB", database_name: `${name}-db`, database_id: db.uuid, migrations_dir: "./db/migrations" }], r2_buckets: [{ binding: "STORAGE", bucket_name: `${name}-storage` }] }, null, 2) + "\n";
  writeFileSync(`${cloud}/wrangler.jsonc`, `// written by voidbase deploy; ids are real resources on account ${account.id}\n${wranglerConfig}`);
  if (existsSync(`${cloud}/.env`)) log("note: cloud/.env ships as plaintext worker vars; keep secrets out of it (voidbase deploy stores the superuser as secrets)");

  // superuser: from the environment (PB_* is what the starter's entrypoint uses) or generated once and kept locally
  const credFile = `${cloud}/.superuser-credentials`;
  let email = opts.superuserEmail || process.env.VOIDBASE_SUPERUSER_EMAIL || process.env.PB_SUPERUSER_EMAIL || "";
  let password = opts.superuserPassword || process.env.VOIDBASE_SUPERUSER_PASSWORD || process.env.PB_SUPERUSER_PASSWORD || "";
  const saved = existsSync(credFile) ? (JSON.parse(readFileSync(credFile, "utf8")) as { email: string; password: string }) : null;
  const placeholder = !password || password === "changeme123"; // the local dev default never goes live
  if (placeholder && saved && (!email || email === saved.email)) { email = saved.email; password = saved.password; }
  if (!email) email = "admin@example.com";
  if (!password || password === "changeme123") { password = randomPassword(); log(`generated a superuser password for ${email} (saved in ${credFile}; change it after the first login)`); }
  writeFileSync(credFile, JSON.stringify({ email, password }, null, 2) + "\n", { mode: 0o600 });
  const gi = `${cloud}/.gitignore`; if (existsSync(gi) && !readFileSync(gi, "utf8").includes(".superuser-credentials")) writeFileSync(gi, readFileSync(gi, "utf8") + ".superuser-credentials\n");

  const url = await workersSubdomain(token, account.id).then((s) => (s ? `https://${name}.${s}.workers.dev` : null));
  if (opts.dryRun) { log(`dry run: would install ${cloud}, sync the panel${opts.publicDir ? ` and ${opts.publicDir}` : ""}, put 2 secrets and run void deploy --backend cloudflare (${url ?? "url unknown"})`); return { name, account: account.id, url, wranglerConfig }; }

  const env = { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account.id, VOIDBASE_SUPERUSER_EMAIL: email, VOIDBASE_SUPERUSER_PASSWORD: password };
  const sh = async (cmd: string[], input?: string) => { const p = Bun.spawn(cmd, { cwd: cloud, env, stdin: input === undefined ? "inherit" : new TextEncoder().encode(input), stdout: "inherit", stderr: "inherit" }); const code = await p.exited; if (code !== 0) throw new Error(`${cmd.join(" ")} exited with ${code}`); };
  if (!existsSync(`${cloud}/node_modules/void`)) { log("installing the cloud project"); await sh(["bun", "install"]); }
  mkdirSync(`${cloud}/public`, { recursive: true });
  await sh(["bun", `${resolve(import.meta.dir, "../../scripts/sync-panel.ts")}`, "--dest", `${cloud}/public/_`]);
  if (opts.publicDir) await sh(["bun", `${resolve(import.meta.dir, "../../scripts/sync-app.ts")}`, "--dest", `${cloud}/public`], undefined).catch((e) => log(`frontend build not synced: ${e instanceof Error ? e.message : e}`));
  // secrets on the (draft) worker, never in vars: the values above are exported in the shell too, which makes the
  // Cloudflare backend strip them from any .env it bakes
  const wrangler = `${cloud}/node_modules/.bin/wrangler`;
  for (const [k, v] of [["VOIDBASE_SUPERUSER_EMAIL", email], ["VOIDBASE_SUPERUSER_PASSWORD", password]] as const) await sh([wrangler, "secret", "put", k, "--name", name], v + "\n");
  await sh([`${cloud}/node_modules/.bin/void`, "deploy", "--backend", "cloudflare"]);
  if (url) {
    const ok = await fetch(`${url}/api/health`).then((r) => r.status).catch(() => 0);
    log(`\nlive: ${url}  (health ${ok || "not reachable yet"})\n├─ REST API:  ${url}/api/\n└─ Dashboard: ${url}/_/   sign in as ${email} (password in ${credFile})`);
  } else log("deployed; workers.dev subdomain not enabled on this account, add a route or enable it in the dashboard");
  return { name, account: account.id, url, wranglerConfig };
}
