#!/usr/bin/env bun
// voidbase CLI: the PocketBase-shaped chores (superuser upsert, collections import/export, panel sync) plus thin
// wrappers over the Void toolchain (dev, build, preview, deploy). Runs with Bun from the project root.
//   voidbase <command> [options]     voidbase --help
import { existsSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { exportAll } from "../scripts/export";

const ROOT = resolve(`${import.meta.dir}/..`);
const argv = process.argv.slice(2);
const flags: Record<string, string> = {}; const positional: string[] = [];
for (let i = 0; i < argv.length; i++) { const a = argv[i]!; if (a.startsWith("--")) { const [k, v] = a.slice(2).split("="); flags[k!] = v ?? (argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "1"); } else positional.push(a); }
const [cmd, sub, ...rest] = positional;
const url = (flags.url ?? process.env.VOIDBASE_URL ?? "http://127.0.0.1:8090").replace(/\/$/, "");
const serveOpts = () => ({ http: flags.http, dir: flags.dir, hooksDir: flags.hooksDir, migrationsDir: flags.migrationsDir, publicDir: flags.publicDir });
const admin = () => { const [email, password] = (flags.admin ?? `${process.env.VOIDBASE_SUPERUSER_EMAIL ?? "admin@example.com"}:${process.env.VOIDBASE_SUPERUSER_PASSWORD ?? ""}`).split(":") as [string, string]; return { email, password }; };
const HELP = `voidbase - PocketBase-compatible backend: a single Bun process locally, Cloudflare Workers via Void in production

  serve [--http 127.0.0.1:8090] [--dir pb_data] [--hooksDir pb_hooks] [--migrationsDir pb_migrations] [--publicDir ../sk/build] [--dev] [--entry main.ts]
                                     run the server like "pocketbase serve" (--dev restarts when hooks or migrations change;
                                     --entry runs your own main.ts, the counterpart of a custom PocketBase build)
  superuser upsert <email> <password>  create or update a superuser: on the local data directory (--dir) or on a running
                                     instance (--url, --admin email:pass)

  init [dir]                         scaffold .env, pb_hooks/, pb_migrations/ in a fresh checkout and sync the panel
  dev [--port 5180]                  start the Void dev server (vp dev)
  build | preview [--port 5181]      production build / run the built Worker locally (vp build / vp preview)
  deploy [--name worker] [--account id] [--public-dir ../sk/build] [--dry-run] [--no-queue] [--no-hub] [--analytics] [--rate-limit 300/10]
                                     go live on your Cloudflare account with VOIDBASE_DEPLOY_CF_API_KEY: creates the D1
                                     database and R2 bucket, writes cloud/ (voidbase cloud init) with wrangler.jsonc,
                                     stores the superuser as worker secrets and runs void deploy --backend cloudflare
  deploy --void                      deploy to the Void platform instead (void auth login first)
  token                              print the Cloudflare dashboard link that creates VOIDBASE_DEPLOY_CF_API_KEY
  superuser list                     list superusers (--url, --admin)
  import <collections.json> [--delete-missing]   PUT /api/collections/import on a running instance (--url, --admin)
  export <outDir>                    SQLite + collections.json + storage/ from a running instance (--url, --admin)
  cloud init [dir=cloud]             write a Void project (routes, middleware, crons, db, env, vite/void config) that
                                     imports voidbase and uses ../pb_hooks and ../pb_migrations, for "void deploy"
  panel sync [--brand <dir>]         copy PocketBase's ui/dist into public/_ (POCKETBASE_UI_DIST), optional branding
  app sync                           copy a static app build into public/ (VOIDBASE_APP_DIR)
  seed-user [email] [password]       create the app user (default user@example.com) on a running instance

Options: --url http://host (default $VOIDBASE_URL or http://127.0.0.1:5180); --admin email:password (default $VOIDBASE_SUPERUSER_EMAIL / _PASSWORD)`;
const run = async (bin: string, args: string[], env: Record<string, string> = {}) => { const p = Bun.spawn([bin, ...args], { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, ...env } }); const code = await p.exited; if (code !== 0) process.exit(code); };
async function api(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(url + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json: Record<string, unknown> = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
}
async function login(): Promise<string> {
  const { email, password } = admin();
  if (!password) { console.error("superuser credentials needed: --admin email:password or VOIDBASE_SUPERUSER_EMAIL/_PASSWORD"); process.exit(1); }
  const r = await api("POST", "/api/collections/_superusers/auth-with-password", { identity: email, password });
  if (r.status !== 200) { console.error(`login as ${email} at ${url} failed: ${r.status} ${JSON.stringify(r.json)}`); process.exit(1); }
  return String(r.json.token);
}

switch (cmd) {
  case undefined: case "help": case "--help": console.log(HELP); break;
  case "token": { const { tokenHelp } = await import("../src/node/deploy-cf"); console.log(tokenHelp()); break; }
  case "serve": {
    // --entry main.ts: the project's own composition (pb's "custom" build), otherwise the stock server
    if (!flags.dev) { if (flags.entry) { await run("bun", [resolve(flags.entry), ...process.argv.slice(3).filter((a, i, arr) => a !== "--entry" && arr[i - 1] !== "--entry")]); break; } const { serve } = await import("../src/node/serve"); await serve(serveOpts()); break; }
    // --dev: run the server as a child and restart it when pb_hooks / pb_migrations change (like modd for PocketBase)
    const { watch } = await import("node:fs");
    const childArgs = process.argv.slice(2).filter((a) => a !== "--dev");
    const entry = flags.entry ? resolve(flags.entry) : null;
    let child: ReturnType<typeof Bun.spawn> | null = null; let timer: ReturnType<typeof setTimeout> | null = null;
    const entryArgs = childArgs.slice(1).filter((a, i, arr) => a !== "--entry" && arr[i - 1] !== "--entry");
    const start = () => { child = Bun.spawn(entry ? ["bun", entry, ...entryArgs] : ["bun", import.meta.path, ...childArgs], { stdio: ["inherit", "inherit", "inherit"], env: process.env }); };
    const restart = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { console.log("voidbase: hooks changed, restarting"); child?.kill(); start(); }, 300); };
    for (const d of [flags.hooksDir ?? "pb_hooks", flags.migrationsDir ?? "pb_migrations", ...(entry ? [entry] : [])]) { try { watch(resolve(d), { recursive: true }, restart); } catch { /* directory may not exist yet */ } }
    start();
    process.on("SIGINT", () => { child?.kill(); process.exit(0); }); process.on("SIGTERM", () => { child?.kill(); process.exit(0); });
    await new Promise(() => undefined);
    break;
  }
  case "init": {
    const dir = resolve(sub ?? ".");
    mkdirSync(`${dir}/pb_hooks`, { recursive: true }); mkdirSync(`${dir}/pb_migrations`, { recursive: true });
    if (!existsSync(`${dir}/.env`)) { cpSync(`${ROOT}/.env.example`, `${dir}/.env`); console.log("wrote .env from .env.example (set VOIDBASE_SUPERUSER_EMAIL/PASSWORD)"); }
    if (!existsSync(`${dir}/pb_hooks/main.pb.js`)) writeFileSync(`${dir}/pb_hooks/main.pb.js`, `/// <reference path="../pb_data/types.d.ts" />\nrouterAdd("GET", "/api/hello", (e) => e.json(200, { hello: "voidbase" }));\n`);
    console.log("pb_hooks/ and pb_migrations/ ready");
    await run("bun", ["scripts/sync-panel.ts"]).catch(() => undefined);
    console.log("\nnext: bun install && ./node_modules/.bin/void db migrate && voidbase dev");
    break;
  }
  case "dev": await run("./node_modules/.bin/vp", ["dev", "--port", flags.port ?? "5180", "--host", flags.host ?? "127.0.0.1"]); break;
  case "build": await run("./node_modules/.bin/vp", ["build"]); break;
  case "preview": await run("./node_modules/.bin/vp", ["preview", "--port", flags.port ?? "5181", "--host", flags.host ?? "127.0.0.1"]); break;
  case "deploy": {
    if (flags.void) { await run("./node_modules/.bin/void", ["deploy"]); break; } // the Void platform (void auth login first)
    const { deployToCloudflare } = await import("../src/node/deploy-cf");
    await deployToCloudflare({ name: flags.name, account: flags.account, dir: flags.dir, publicDir: flags["public-dir"] ?? flags.publicDir, dryRun: !!flags["dry-run"], regenerate: !!flags.regenerate, queue: flags["no-queue"] ? false : undefined, analytics: flags.analytics ? true : undefined, rateLimit: flags["rate-limit"], hub: flags["no-hub"] ? false : undefined });
    break;
  }
  case "superuser": {
    if (!flags.url && sub === "upsert" && rest.length >= 2) {
      // offline, straight on the data directory (pocketbase superuser upsert)
      const { openLocal } = await import("../src/node/serve"); const { upsertSuperuser } = await import("../src/server/bootstrap");
      const { env, sqlite } = await openLocal({ ...serveOpts(), dir: flags.dir ?? "pb_data" });
      const { ensureBootstrapped } = await import("../src/server/bootstrap"); await ensureBootstrapped(env.DB);
      const [email, password] = rest as [string, string];
      console.log(`${await upsertSuperuser(env.DB, email, password)} superuser ${email} in ${flags.dir ?? "pb_data"}`); sqlite.close(); break;
    }
    const token = await login();
    if (sub === "list") { const r = await api("GET", "/api/collections/_superusers/records?perPage=200&sort=email", undefined, token); for (const s of (r.json.items as { id: string; email: string; created: string }[]) ?? []) console.log(`${s.id}  ${s.email}  ${s.created}`); break; }
    if (sub !== "upsert" || rest.length < 2) { console.error("usage: voidbase superuser upsert <email> <password>"); process.exit(1); }
    const [email, password] = rest as [string, string];
    const existing = await api("GET", `/api/collections/_superusers/records?filter=${encodeURIComponent(`email = '${email.replace(/'/g, "\\'")}'`)}`, undefined, token);
    const found = ((existing.json.items as { id: string }[]) ?? [])[0];
    const r = found ? await api("PATCH", `/api/collections/_superusers/records/${found.id}`, { password, passwordConfirm: password }, token) : await api("POST", "/api/collections/_superusers/records", { email, password, passwordConfirm: password }, token);
    if (r.status !== 200) { console.error(`upsert failed: ${r.status} ${JSON.stringify(r.json)}`); process.exit(1); }
    console.log(`${found ? "updated" : "created"} superuser ${email} (${r.json.id})`); break;
  }
  case "import": {
    if (!sub) { console.error("usage: voidbase import <collections.json> [--delete-missing]"); process.exit(1); }
    const token = await login();
    const collections = JSON.parse(await Bun.file(sub).text()) as unknown[];
    const r = await api("PUT", "/api/collections/import", { collections, deleteMissing: !!flags["delete-missing"] }, token);
    if (r.status !== 204) { console.error(`import failed: ${r.status} ${JSON.stringify(r.json)}`); process.exit(1); }
    console.log(`imported ${collections.length} collections into ${url}`); break;
  }
  case "export": {
    if (!sub) { console.error("usage: voidbase export <outDir>"); process.exit(1); }
    const { email, password } = admin();
    const r = await exportAll(url, sub, email, password);
    console.log(`exported ${r.collections} collections, ${r.rows} rows, ${r.files} files to ${sub}`); break;
  }
  case "cloud": {
    if (sub !== "init") { console.error("usage: voidbase cloud init [dir]"); process.exit(1); }
    const { writeCloudProject } = await import("../src/node/cloud-init");
    const r = writeCloudProject(resolve(rest[0] ?? "cloud"));
    console.log(`wrote ${r.files} files + db/migrations to ${rest[0] ?? "cloud"}\nnext: voidbase deploy   (or: cd ${rest[0] ?? "cloud"} && bun install && bun run panel:sync && void deploy)`);
    break;
  }
  // destinations resolve against the caller's directory (run() executes in the package root)
  case "panel": await run("bun", ["scripts/sync-panel.ts", "--dest", resolve(flags.dest ?? "public/_"), ...(flags.brand ? ["--brand", resolve(flags.brand)] : [])]); break;
  case "app": await run("bun", ["scripts/sync-app.ts", "--dest", resolve(flags.dest ?? "public")], { VOIDBASE_APP_DIR: resolve(flags.src ?? process.env.VOIDBASE_APP_DIR ?? "../sk/build") }); break;
  case "seed-user": await run("bash", ["scripts/seed-app-user.sh", url], { REFERENCE_USER_EMAIL: sub ?? "user@example.com", REFERENCE_USER_PASSWORD: rest[0] ?? "changeme123" }); break;
  default: console.error(`unknown command "${cmd}"\n\n${HELP}`); process.exit(1);
}
