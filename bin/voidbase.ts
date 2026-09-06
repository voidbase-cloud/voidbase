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

  serve [--http 127.0.0.1:8090] [--dir pb_data] [--hooksDir pb_hooks] [--migrationsDir pb_migrations] [--publicDir ../sk/build] [--dev]
                                     run the server like "pocketbase serve" (--dev restarts when hooks or migrations change)
  superuser upsert <email> <password>  create or update a superuser: on the local data directory (--dir) or on a running
                                     instance (--url, --admin email:pass)

  init [dir]                         scaffold .env, pb_hooks/, pb_migrations/ in a fresh checkout and sync the panel
  dev [--port 5180]                  start the Void dev server (vp dev)
  build | preview [--port 5181]      production build / run the built Worker locally (vp build / vp preview)
  deploy [--cloudflare] [--provision] void deploy, or void deploy --backend cloudflare [--provision]
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
  case "serve": {
    if (!flags.dev) { const { serve } = await import("../src/node/serve"); await serve(serveOpts()); break; }
    // --dev: run the server as a child and restart it when pb_hooks / pb_migrations change (like modd for PocketBase)
    const { watch } = await import("node:fs");
    const childArgs = process.argv.slice(2).filter((a) => a !== "--dev");
    let child: ReturnType<typeof Bun.spawn> | null = null; let timer: ReturnType<typeof setTimeout> | null = null;
    const start = () => { child = Bun.spawn(["bun", import.meta.path, ...childArgs], { stdio: ["inherit", "inherit", "inherit"], env: process.env }); };
    const restart = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { console.log("voidbase: hooks changed, restarting"); child?.kill(); start(); }, 300); };
    for (const d of [flags.hooksDir ?? "pb_hooks", flags.migrationsDir ?? "pb_migrations"]) { try { watch(resolve(d), { recursive: true }, restart); } catch { /* directory may not exist yet */ } }
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
  case "deploy": await run("./node_modules/.bin/void", ["deploy", ...(flags.cloudflare ? ["--backend", "cloudflare"] : []), ...(flags.provision ? ["--provision"] : [])]); break;
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
    const out = resolve(rest[0] ?? "cloud");
    const parentPkg = existsSync("package.json") ? (JSON.parse(await Bun.file("package.json").text()) as { dependencies?: Record<string, string> }) : {};
    const spec = parentPkg.dependencies?.voidbase ?? "^0.1.0";
    const own = JSON.parse(await Bun.file(`${ROOT}/package.json`).text()) as { devDependencies: Record<string, string> };
    const rel = (p: string) => p.replace(/\\/g, "/");
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "cloud", private: true, type: "module", scripts: { dev: "vp dev --port 8090 --host 0.0.0.0", build: "vp build", preview: "vp preview --port 8090", "panel:sync": "voidbase panel sync --dest public/_", deploy: "void deploy" }, dependencies: { voidbase: spec }, devDependencies: { "@cloudflare/workers-types": own.devDependencies["@cloudflare/workers-types"], typescript: "^5.9.3", vite: own.devDependencies.vite, "vite-plus": own.devDependencies["vite-plus"], void: own.devDependencies.void } }, null, 2) + "\n",
      "vite.config.ts": `import { defineConfig, loadEnv } from "vite";\nimport { voidPlugin } from "void";\nimport { pbHooksPlugin } from "voidbase/plugin";\n\n// the project's pb_hooks/ and pb_migrations/ (one directory up) are bundled into the Worker\nexport default defineConfig(({ mode }) => {\n  const env = loadEnv(mode, process.cwd(), "");\n  return { plugins: [voidPlugin({ persistTo: env.VOIDBASE_PERSIST_TO || undefined }), pbHooksPlugin({ dir: env.VOIDBASE_HOOKS_DIR || "../pb_hooks", migrationsDir: env.VOIDBASE_MIGRATIONS_DIR || "../pb_migrations" })] };\n});\n`,
      "void.json": JSON.stringify({ $schema: "./node_modules/void/schema.json", worker: { compatibility_date: "2026-09-05", compatibility_flags: ["nodejs_compat"] }, routing: { notFound: "none" }, inference: { bindings: { db: true, storage: true } } }, null, 2) + "\n",
      "env.ts": `export { default } from "voidbase/env";\n`,
      "routes/api/[...path].ts": `// Every /api/* request is handled by voidbase's Hono app (PocketBase wire protocol).\nimport { defineHandler } from "void";\nimport { app } from "voidbase/app";\n\nconst handle = defineHandler((c) => app.fetch(c.req.raw, c.env, (c as unknown as { executionCtx?: ExecutionContext }).executionCtx));\nexport const GET = handle; export const POST = handle; export const PATCH = handle; export const PUT = handle; export const DELETE = handle; export const OPTIONS = handle;\n`,
      "middleware/01.request-context.ts": `// Static files and SPA fallback outside /api, the admin panel under /_/ (PocketBase --publicDir semantics).\nexport { default } from "voidbase/middleware";\n`,
      "crons/every-minute.ts": `// Cloudflare cron trigger: PocketBase's maintenance jobs and cronAdd jobs from pb_hooks, once a minute.\nimport { defineScheduled } from "void";\nimport "voidbase/app";\nimport { runDue } from "voidbase/crons";\n\nexport const cron = "* * * * *";\nexport default defineScheduled(async (controller, env) => { await runDue(env as never, new Date(controller.scheduledTime)); });\n`,
      "db/schema.ts": `// voidbase's system tables; user collections are data, as in PocketBase.\nexport * from "voidbase/schema";\n`,
      "tsconfig.json": JSON.stringify({ extends: "./.void/tsconfig.json", compilerOptions: { types: ["@cloudflare/workers-types"], strict: true, noEmit: true, moduleResolution: "bundler", module: "esnext", target: "esnext" }, include: ["routes", "middleware", "crons", "db", "env.ts", "vite.config.ts"] }, null, 2) + "\n",
      ".gitignore": "node_modules\ndist\n.void\n.wrangler\n.env\n.env.*\n!.env.example\npublic/*\n",
      ".env.example": "# worker vars for local dev/preview of this Void project (production secrets: void secret put / wrangler secret put)\nVOIDBASE_SUPERUSER_EMAIL=admin@example.com\nVOIDBASE_SUPERUSER_PASSWORD=changeme123\nAUDITLOG=posts,users\n",
      "README.md": "# cloud\n\nGenerated by `voidbase cloud init`: the Void project that deploys ../pb_hooks and ../pb_migrations to Cloudflare Workers.\n\n```bash\nbun install\nbun run panel:sync                   # admin panel into public/_ (copy a frontend build into public/ too, if any)\nvoid deploy                          # Void platform\nvoid deploy --backend cloudflare --provision   # your own Cloudflare account\n```\n\nRegenerate with `voidbase cloud init` after upgrading voidbase; keep your own changes elsewhere.\n",
    };
    for (const [name, content] of Object.entries(files)) { mkdirSync(resolve(out, name, ".."), { recursive: true }); writeFileSync(resolve(out, name), content); }
    mkdirSync(resolve(out, "db/migrations"), { recursive: true });
    cpSync(`${ROOT}/db/migrations`, resolve(out, "db/migrations"), { recursive: true });
    console.log(`wrote ${Object.keys(files).length} files + db/migrations to ${rel(out)}\nnext: cd ${rel(rest[0] ?? "cloud")} && bun install && bun run panel:sync && void deploy`);
    break;
  }
  // destinations resolve against the caller's directory (run() executes in the package root)
  case "panel": await run("bun", ["scripts/sync-panel.ts", "--dest", resolve(flags.dest ?? "public/_"), ...(flags.brand ? ["--brand", resolve(flags.brand)] : [])]); break;
  case "app": await run("bun", ["scripts/sync-app.ts", "--dest", resolve(flags.dest ?? "public")], { VOIDBASE_APP_DIR: resolve(flags.src ?? process.env.VOIDBASE_APP_DIR ?? "../sk/build") }); break;
  case "seed-user": await run("bash", ["scripts/seed-app-user.sh", url], { REFERENCE_USER_EMAIL: sub ?? "user@example.com", REFERENCE_USER_PASSWORD: rest[0] ?? "changeme123" }); break;
  default: console.error(`unknown command "${cmd}"\n\n${HELP}`); process.exit(1);
}
