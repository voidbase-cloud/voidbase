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
const url = (flags.url ?? process.env.VOIDBASE_URL ?? "http://127.0.0.1:5180").replace(/\/$/, "");
const admin = () => { const [email, password] = (flags.admin ?? `${process.env.VOIDBASE_SUPERUSER_EMAIL ?? "admin@example.com"}:${process.env.VOIDBASE_SUPERUSER_PASSWORD ?? ""}`).split(":") as [string, string]; return { email, password }; };
const HELP = `voidbase - PocketBase-compatible backend on Cloudflare Workers (Void)

  init [dir]                         scaffold .env, pb_hooks/, pb_migrations/ in a fresh checkout and sync the panel
  dev [--port 5180]                  start the Void dev server (vp dev)
  build | preview [--port 5181]      production build / run the built Worker locally (vp build / vp preview)
  deploy [--cloudflare] [--provision] void deploy, or void deploy --backend cloudflare [--provision]
  superuser upsert <email> <password>  create or update a superuser on a running instance (--url, --admin email:pass)
  superuser list                     list superusers (--url, --admin)
  import <collections.json> [--delete-missing]   PUT /api/collections/import on a running instance (--url, --admin)
  export <outDir>                    SQLite + collections.json + storage/ from a running instance (--url, --admin)
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
  case "deploy": await run("./node_modules/.bin/void", ["deploy", ...(flags.cloudflare ? ["--backend", "cloudflare"] : []), ...(flags.provision ? ["--provision"] : [])]); break;
  case "superuser": {
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
  case "panel": await run("bun", ["scripts/sync-panel.ts", ...(flags.brand ? ["--brand", flags.brand] : [])]); break;
  case "app": await run("bun", ["scripts/sync-app.ts"]); break;
  case "seed-user": await run("bash", ["scripts/seed-app-user.sh", url], { REFERENCE_USER_EMAIL: sub ?? "user@example.com", REFERENCE_USER_PASSWORD: rest[0] ?? "changeme123" }); break;
  default: console.error(`unknown command "${cmd}"\n\n${HELP}`); process.exit(1);
}
