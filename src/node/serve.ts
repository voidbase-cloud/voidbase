// `voidbase serve`: the PocketBase-shaped single process. The same Hono app that runs on Cloudflare, with D1 on
// bun:sqlite, R2 on the filesystem, SMTP on node sockets and the cron scheduler on a timer.
//   import { serve } from "@voidbase-cloud/voidbase";  serve({ http: "127.0.0.1:8090", dir: "pb_data", publicDir: "../sk/build" });
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { d1, openDatabase } from "./d1";
import { fsBucket } from "./storage";
import { assetsFetcher } from "./assets";
import { ensurePanelDir } from "./panel";
import { embedded } from "./embedded";

export interface ServeOptions { http?: string; dir?: string; hooksDir?: string; migrationsDir?: string;
  /** pb_secrets/: the declaration and the git-ignored values (VOIDBASE_SECRETS_DIR) */
  secretsDir?: string; publicDir?: string; quiet?: boolean }
const PKG = resolve(import.meta.dir, "../..");

// system tables: the same SQL migrations Void applies on Cloudflare
export function readSystemMigrations(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(`${PKG}/db/migrations`).filter((f) => f.endsWith(".sql")).sort()) out[f] = readFileSync(`${PKG}/db/migrations/${f}`, "utf8");
  return out;
}
export function applySystemMigrations(db: ReturnType<typeof openDatabase>, migrations: Record<string, string> = readSystemMigrations()): number {
  db.exec("CREATE TABLE IF NOT EXISTS `_vb_migrations` (name TEXT PRIMARY KEY, applied TEXT NOT NULL)");
  const done = new Set((db.query("SELECT name FROM `_vb_migrations`").all() as { name: string }[]).map((r) => r.name));
  let applied = 0;
  for (const f of Object.keys(migrations).sort()) {
    if (done.has(f)) continue;
    db.transaction(() => {
      for (const statement of migrations[f]!.split("--> statement-breakpoint")) if (statement.trim()) db.exec(statement);
      db.query("INSERT INTO `_vb_migrations` (name, applied) VALUES (?, ?)").run(f, new Date().toISOString());
    })();
    applied++;
  }
  return applied;
}

// Opens (and prepares) a data directory without serving: bindings for the CLI and for embedding.
// Bun loads ./.env itself; a project that keeps its environment one level up (the SvelteKit starter) gets that too.
// PB_* names from the PocketBase starter convention are accepted as aliases of the VOIDBASE_* ones.
const ENV_ALIASES: Record<string, string> = { PB_SUPERUSER_EMAIL: "VOIDBASE_SUPERUSER_EMAIL", PB_SUPERUSER_PASSWORD: "VOIDBASE_SUPERUSER_PASSWORD", PB_USER_EMAIL: "VOIDBASE_USER_EMAIL", PB_USER_PASSWORD: "VOIDBASE_USER_PASSWORD", PB_ENCRYPTION_KEY: "VOIDBASE_ENCRYPTION_KEY" };
import { loadSecrets } from "./secrets";

export function loadEnv(files = [".env", ".env.local", "../.env", "../.env.local"]): void {
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (!m) continue;
      const key = m[1]!; const value = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
      if (!process.env[key]) process.env[key] = value;
    }
  }
  for (const [alias, key] of Object.entries(ENV_ALIASES)) if (!process.env[key] && process.env[alias]) process.env[key] = process.env[alias];
}

export async function openLocal(opts: ServeOptions) {
  // pb_secrets/secrets.json (git-ignored) into the environment before the .env files, so $os.getenv and the app see
  // the same names as on Cloudflare, where the deploy stored them as the Worker's secrets (src/node/secrets.ts):
  // the shell outranks secrets.json, which outranks a dev placeholder in .env
  process.env.VOIDBASE_SECRETS_DIR = resolve(opts.secretsDir ?? process.env.VOIDBASE_SECRETS_DIR ?? "pb_secrets");
  const secrets = loadSecrets(process.env.VOIDBASE_SECRETS_DIR);
  loadEnv();
  const dir = resolve(opts.dir ?? "pb_data");
  mkdirSync(dir, { recursive: true });
  process.env.VOIDBASE_HOOKS_DIR = resolve(opts.hooksDir ?? process.env.VOIDBASE_HOOKS_DIR ?? "pb_hooks");
  process.env.VOIDBASE_MIGRATIONS_DIR = resolve(opts.migrationsDir ?? process.env.VOIDBASE_MIGRATIONS_DIR ?? "pb_migrations");
  if (secrets.missing.length && !opts.quiet) console.warn(`voidbase: ${secrets.missing.length} declared secret(s) have no value here (${process.env.VOIDBASE_SECRETS_DIR}/secrets.json): ${secrets.missing.join(", ")}`);
  if (secrets.undeclared.length && !opts.quiet) console.warn(`voidbase: ${process.env.VOIDBASE_SECRETS_DIR}/secrets.json holds ${secrets.undeclared.join(", ")}, which main.pb.js does not declare; a deploy stores only declared secrets`);
  // pb_data/types.d.ts for editor support in pb_hooks (PocketBase's JSVM typings); a standalone executable carries
  // the typings and the system migrations itself (src/node/embedded.ts)
  const emb = await embedded();
  try { if (!existsSync(`${dir}/types.d.ts`)) writeFileSync(`${dir}/types.d.ts`, emb?.typesDts ?? readFileSync(`${PKG}/types/pb_data.d.ts`, "utf8")); } catch { /* optional */ }
  const sqlite = openDatabase(`${dir}/data.db`);
  applySystemMigrations(sqlite, emb?.migrations ?? readSystemMigrations());
  // PocketBase serves ./pb_public at / when the directory exists (--publicDir); a build there is a full static host
  const publicDir = opts.publicDir ? resolve(opts.publicDir) : existsSync(resolve("pb_public")) ? resolve("pb_public") : undefined;
  const env = { DB: d1(sqlite), STORAGE: fsBucket(`${dir}/storage`), ASSETS: assetsFetcher({ panelDir: await ensurePanelDir(), publicDir }) };
  return { dir, sqlite, env };
}

export interface VoidbaseServer { server: ReturnType<typeof Bun.serve>; env: Awaited<ReturnType<typeof openLocal>>["env"]; stop: () => void }

// The library entry: `const app = await voidbase(opts); register things; await app.start()` (main.go's shape).
export async function voidbase(opts: ServeOptions = {}) {
  const { dir, env } = await openLocal(opts);
  // the app module reads the hooks and migrations directories while loading
  const { app } = await import("../server/app");
  const { appApi } = await import("../server/api");
  const api = appApi();
  const start = async (): Promise<VoidbaseServer> => {
    const [hostname, portStr] = (opts.http ?? "127.0.0.1:8090").split(":");
    const port = Number(portStr ?? 8090);
    const { runDue } = await import("../server/crons");
    const { staticFallback } = await import("../server/static");
    const ctx = { waitUntil: (p: Promise<unknown>) => { Promise.resolve(p).catch((e) => console.error("voidbase: background task failed", e)); }, passThroughOnException() {} };
    const server = Bun.serve({
      hostname, port, idleTimeout: 255,
      async fetch(req) {
        const res = await app.fetch(req, env, ctx as never);
        if (res.status !== 404) return res;
        return (await staticFallback(req, env.ASSETS)) ?? res;
      },
    });
    // cron: every minute on the minute, like the Cloudflare trigger
    const tick = () => runDue(env as never, new Date()).catch((e) => console.error("voidbase: cron failed", e));
    const first = 60_000 - (Date.now() % 60_000);
    const timer = setTimeout(() => { void tick(); setInterval(() => void tick(), 60_000); }, first);
    if (!opts.quiet) {
      const shown = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
      console.log(`voidbase (data: ${dir}, hooks: ${process.env.VOIDBASE_HOOKS_DIR})`);
      console.log(`Server started at http://${shown}:${port}\n├─ REST API:  http://${shown}:${port}/api/\n└─ Dashboard: http://${shown}:${port}/_/`);
    }
    // bootstrap now (system collections, settings, superuser from env, pb_migrations) instead of on the first request
    await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => undefined);
    await seedUser(port);
    return { server, env, stop: () => { clearTimeout(timer); server.stop(true); } };
  };
  return { ...api, env, dir, start };
}

// VOIDBASE_USER_EMAIL / VOIDBASE_USER_PASSWORD: a test user in the `users` collection, created once (the starter's
// entrypoint used to do this with curl)
async function seedUser(port: number): Promise<void> {
  const email = process.env.VOIDBASE_USER_EMAIL, password = process.env.VOIDBASE_USER_PASSWORD;
  const su = process.env.VOIDBASE_SUPERUSER_EMAIL, suPass = process.env.VOIDBASE_SUPERUSER_PASSWORD;
  if (!email || !password || !su || !suPass) return;
  const base = `http://127.0.0.1:${port}`;
  const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
  const auth = await fetch(`${base}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: su, password: suPass }) }).then(json).catch(() => null);
  const token = auth?.token ? String(auth.token) : ""; if (!token) return;
  const existing = await fetch(`${base}/api/collections/users/records?perPage=1&filter=${encodeURIComponent(`email = '${email.replace(/'/g, "\\'")}'`)}`, { headers: { authorization: token } }).then(json).catch(() => null);
  if (!existing || Number(existing.totalItems ?? 0) > 0 || existing.status === 404) return;
  const r = await fetch(`${base}/api/collections/users/records`, { method: "POST", headers: { "content-type": "application/json", authorization: token }, body: JSON.stringify({ email, password, passwordConfirm: password }) });
  console.log(r.status === 200 ? `voidbase: created user ${email}` : `voidbase: could not create user ${email}: ${r.status}`);
}

export async function serve(opts: ServeOptions = {}): Promise<VoidbaseServer> {
  return (await voidbase(opts)).start();
}

// `pocketbase serve`-style flags: --http host:port --dir --hooksDir --migrationsDir --publicDir
export function parseServeArgs(argv: string[] = process.argv.slice(2)): ServeOptions {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) { const a = argv[i]!; if (a.startsWith("--")) { const [k, v] = a.slice(2).split("="); flags[k!] = v ?? (argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "1"); } }
  return { http: flags.http, dir: flags.dir, hooksDir: flags.hooksDir, migrationsDir: flags.migrationsDir, publicDir: flags.publicDir };
}
