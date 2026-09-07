#!/usr/bin/env bun
// voidbase CLI: the PocketBase-shaped chores (superuser upsert, collections import/export, panel sync) plus thin
// wrappers over the Void toolchain (dev, build, preview, deploy). Runs with Bun from the project root.
//   voidbase <command> [options]     voidbase --help
import { existsSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { exportAll } from "../scripts/export";
import { embedded, isExecutable } from "../src/node/embedded";

// the version: the executable carries it, a checkout reads package.json
async function currentVersion(): Promise<string> { return (await embedded())?.version ?? (JSON.parse(await Bun.file(resolve(import.meta.dir, "../package.json")).text()) as { version: string }).version; }
// the prebuilt executable serves; the Cloudflare toolchain (Void, Vite, wrangler) comes with the npm package
const TOOLCHAIN = new Set(["dev", "build", "preview", "deploy", "sync", "bundle", "release", "cloud", "panel", "app", "init", "seed-user"]);

const ROOT = resolve(`${import.meta.dir}/..`);
const argv = process.argv.slice(2);
const flags: Record<string, string> = {}; const positional: string[] = [];
for (let i = 0; i < argv.length; i++) { const a = argv[i]!; if (a.startsWith("--")) { const [k, v] = a.slice(2).split("="); flags[k!] = v ?? (argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "1"); } else positional.push(a); }
const [cmd, sub, ...rest] = positional;
const url = (flags.url ?? process.env.VOIDBASE_URL ?? "http://127.0.0.1:8090").replace(/\/$/, "");
const serveOpts = () => ({ http: flags.http, dir: flags.dir, hooksDir: flags.hooksDir, migrationsDir: flags.migrationsDir, secretsDir: flags.secretsDir, publicDir: flags.publicDir });
const admin = () => { const [email, password] = (flags.admin ?? `${process.env.VOIDBASE_SUPERUSER_EMAIL ?? "admin@example.com"}:${process.env.VOIDBASE_SUPERUSER_PASSWORD ?? ""}`).split(":") as [string, string]; return { email, password }; };
const HELP = `voidbase - PocketBase-compatible backend: a single Bun process locally, Cloudflare Workers via Void in production

  serve [--http 127.0.0.1:8090] [--dir pb_data] [--hooksDir pb_hooks] [--migrationsDir pb_migrations] [--secretsDir pb_secrets] [--publicDir pb_public] [--dev] [--entry main.ts]
                                     run the server like "pocketbase serve" (--dev restarts when hooks or migrations change;
                                     --entry runs your own main.ts, the counterpart of a custom PocketBase build)
  superuser upsert <email> <password>  create or update a superuser: on the local data directory (--dir) or on a running
                                     instance (--url, --admin email:pass)

  adapt [dir] [--public-dir .voidbase/pb_public] [--no-migrations]
                                     generate a voidbase app under .voidbase/ from a Void app: PocketBase's layout
                                     (main.ts, package.json, pb_hooks, pb_migrations, pb_public) with the project's
                                     routes/middleware/crons/queues and whatever src/voidbase/ adds. vite build does
                                     this too through the voidbaseAdapter() plugin; this is the same pass without Vite.
  init [dir]                         scaffold .env, pb_hooks/, pb_migrations/, pb_secrets/ in a fresh checkout and sync the panel
  dev [--port 5180]                  start the Void dev server (vp dev)
  build | preview [--port 5181]      production build / run the built Worker locally (vp build / vp preview)
  deploy [--name worker] [--account id] [--domain example.com,api.example.com] [--public-dir pb_public] [--dry-run] [--no-queue] [--no-hub] [--no-cron]
         [--analytics] [--rate-limit 300/10]
                                     go live on your Cloudflare account with VOIDBASE_DEPLOY_CF_API_KEY: creates the D1
                                     database and R2 bucket, writes cloud/ (voidbase cloud init) with wrangler.jsonc,
                                     stores the superuser as worker secrets and runs void deploy --backend cloudflare
  deploy --void                      deploy to the Void platform instead (void auth login first)
  sync [dir] [--repo owner/name] [--branch main] [--no-build] [--ci] [--no-ci] [--dry-run]
                                     the instance and its pipeline: deploy (a Void app is built first and deployed from
                                     .voidbase/), then connect the GitHub repository to Cloudflare Workers Builds so a
                                     push to the branch deploys and other branches build. Needs CLOUDFLARE_BUILDS_TOKEN
                                     (a local() key) for the pipeline part; in CI, sync is the deploy alone (--ci forces it)
  token                              print the Cloudflare dashboard link that creates VOIDBASE_DEPLOY_CF_API_KEY
  secrets [list] [--dir pb_secrets]  what pb_secrets/main.ts declares (secret / server / public), which have a value in
  secrets push [--name worker]       secrets.json (git-ignored) or a default, which secrets the Worker has; push stores the
                                     local secrets on the Worker (vars are set by every deploy)
  update [--dir pb_data] [--backup]  prebuilt executable only: fetch the latest GitHub release for this platform, verify
                                     its checksum and replace the executable (--backup zips pb_data first)
  version                            print the version
  bundle [--out dir] [--version v]   build the generic Worker + panel as a release directory (default .cloud/releases/<v>)
         [--push http://vb --token t]  and optionally push it into a voidbase control plane (POST /api/vbcloud/releases)
  release push <dir> --url http://vb --token <superuser token>   push a built release ( --no-activate keeps the current one)
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

if (cmd && TOOLCHAIN.has(cmd) && isExecutable()) { console.error(`"${cmd}" needs the Cloudflare toolchain, which comes with the npm package, not the prebuilt executable:\n  bunx @voidbase-cloud/voidbase ${argv.join(" ")}`); process.exit(1); }
switch (cmd) {
  case undefined: case "help": case "--help": console.log(HELP); break;
  case "version": case "--version": console.log(await currentVersion()); break;
  case "update": {
    if (!isExecutable()) { console.error("voidbase update replaces the prebuilt executable; this is a checkout or an npm install: update the package instead (bun update @voidbase-cloud/voidbase)."); process.exit(1); }
    const { update } = await import("../src/node/update");
    await update({ currentVersion: await currentVersion(), dataDir: resolve(flags.dir ?? "pb_data"), backup: !!flags.backup });
    break;
  }
  case "secrets": {
    // pb_secrets/ (src/node/secrets.ts): what is declared, what has a value here, what the Worker has; push the values
    const { secretsState, putWorkerSecrets, workerSecretNames, SECRETS_DIR } = await import("../src/node/secrets");
    const { deployTarget } = await import("../src/node/deploy-cf");
    const dir = resolve(flags.dir ?? process.env.VOIDBASE_SECRETS_DIR ?? SECRETS_DIR);
    const state = await secretsState(dir);
    if (!state.definition) { console.log(`${dir}/main.ts does not exist: nothing declared (voidbase init writes one)`); break; }
    const def = state.definition; const secretNames = def.of("secret");
    if (sub === "push") {
      const { api, account, name } = await deployTarget({ name: flags.name, account: flags.account, log: () => undefined });
      // only the secret tier is pushed: vars are the code's, set by every deploy
      const ev = await def.evaluate({ ...(state.values ?? {}) }, ["secret"]);
      if (ev.invalid.length) throw new Error(`${dir}/secrets.json: ${ev.invalid.map((i) => `${i.name}: ${i.message}`).join(", ")}`);
      const values: Record<string, string> = {}; for (const k of secretNames) if (state.provided.includes(k) && ev.stored[k] !== undefined) values[k] = ev.stored[k]!;
      if (!Object.keys(values).length) { console.log(`nothing to push: none of ${secretNames.join(", ") || "(no secrets declared)"} has a value in ${dir}/secrets.json`); break; }
      const before = await workerSecretNames(api, account.id, name);
      const done = await putWorkerSecrets(api, account.id, name, values).catch((e: Error) => { throw new Error(`${e.message}\n  (the Worker "${name}" must exist: voidbase deploy creates it and stores the secrets itself)`); });
      console.log(`pushed ${done.length} secret(s) to worker "${name}" (account ${account.name}): ${done.map((k) => `${k}${before.includes(k) ? " (replaced)" : ""}`).join(", ")}`);
      const left = secretNames.filter((k) => !values[k]); if (left.length) console.log(`no local value, left as they are: ${left.join(", ")}`);
      break;
    }
    // list (default): a row per declared name
    let onWorker: string[] | null = null; let worker = "";
    try { const t = await deployTarget({ name: flags.name, account: flags.account, log: () => undefined }); worker = t.name; onWorker = await workerSecretNames(t.api, t.account.id, t.name); } catch { /* no token here: local view only */ }
    console.log(`${dir}: ${def.names.length} declared (${secretNames.length} secret, ${def.of("server").length} server, ${def.of("public").length} public${def.of("local").length ? `, ${def.of("local").length} local, never deployed` : ""})${state.values ? `, ${state.provided.length} valued in secrets.json` : ", no secrets.json"}${onWorker ? `, worker "${worker}" has ${onWorker.filter((k) => secretNames.includes(k)).length} of the secrets` : " (set VOIDBASE_DEPLOY_CF_API_KEY to compare with the Worker)"}`);
    for (const i of state.info) {
      const where = state.provided.includes(i.name) ? "local value" : i.fallback !== undefined ? `default ${i.access === "secret" ? "(set)" : JSON.stringify(i.fallback)}` : i.optional ? "optional, unset" : "no local value";
      const worker = onWorker && i.access === "secret" ? `  ${onWorker.includes(i.name) ? "on the worker" : "NOT on the worker"}` : "";
      console.log(`  ${i.name.padEnd(30)} ${i.access.padEnd(7)} ${where.padEnd(18)}${worker}${i.description ? `  ${i.description}` : ""}`);
    }
    if (state.undeclared.length) console.log(`  in secrets.json but not declared (never deployed): ${state.undeclared.join(", ")}`);
    break;
  }
  case "token": { const { tokenHelp } = await import("../src/node/deploy-cf"); console.log(tokenHelp()); break; }
  case "bundle": {
    const { buildRelease, pushRelease } = await import("../src/node/bundle");
    const r = await buildRelease({ out: flags.out as string | undefined, version: flags.version as string | undefined, hub: flags["no-hub"] ? false : undefined, queue: flags["no-queue"] ? false : undefined, keepProject: !!flags["keep-project"] });
    if (flags.push) await pushRelease({ dir: r.dir, url: String(flags.push), token: String(flags.token ?? process.env.VOIDBASE_RELEASE_TOKEN ?? ""), activate: !flags["no-activate"] });
    break;
  }
  case "release": {
    if (sub !== "push") { console.error(`unknown release command "${sub}"\n\n${HELP}`); process.exit(1); }
    const { pushRelease } = await import("../src/node/bundle");
    await pushRelease({ dir: resolve(String(rest[0] ?? flags.dir ?? ".")), url: String(flags.url ?? process.env.VOIDBASE_URL ?? "http://127.0.0.1:8090"), token: String(flags.token ?? process.env.VOIDBASE_RELEASE_TOKEN ?? ""), activate: !flags["no-activate"] });
    break;
  }
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
  case "adapt": {
    const { adapt } = await import("../src/adapter/index");
    const root = resolve(sub ?? ".");
    const { manifest, written, copied } = await adapt(root, { publicDir: flags["public-dir"], migrations: !flags["no-migrations"], quiet: true });
    for (const u of manifest.unsupported) console.warn(`not carried over: ${u.what} — ${u.why}`);
    for (const c of manifest.collisions) console.warn(`shadowed by voidbase's own API, the app route never runs: ${c}`);
    console.log(`${manifest.mode === "static" ? "static" : "server"} app at ${root}`);
    console.log(`  ${manifest.routes.length} route(s), ${manifest.middleware.length} middleware, ${manifest.hooks.length} hook(s), ${manifest.crons.length} cron(s), ${manifest.queues.length} queue(s), ${manifest.migrations.length} migration(s)${manifest.secrets ? `, ${manifest.secrets.names.length} secret(s)` : ""}`);
    console.log(`  wrote ${written.join(", ") || "nothing"}${copied ? `, ${copied} entr(ies) into ${flags["public-dir"] ?? ".voidbase/pb_public"}` : ""}`);
    console.log("  run it:    bun .voidbase/main.ts --http 127.0.0.1:8090");
    console.log("  deploy it: cd .voidbase && voidbase deploy");
    break;
  }
  case "init": {
    const dir = resolve(sub ?? ".");
    mkdirSync(`${dir}/pb_hooks`, { recursive: true }); mkdirSync(`${dir}/pb_migrations`, { recursive: true }); mkdirSync(`${dir}/pb_secrets`, { recursive: true });
    { // pb_secrets/main.pb.js declares the secrets; secrets.json holds their values and never enters git
      const { declarationScaffold } = await import("../src/node/secrets");
      if (!existsSync(`${dir}/pb_secrets/main.ts`)) writeFileSync(`${dir}/pb_secrets/main.ts`, declarationScaffold());
      const gi = `${dir}/.gitignore`; const have = existsSync(gi) ? await Bun.file(gi).text() : "";
      const lines = ["pb_data/", "pb_secrets/secrets.json", ".cloud/"].filter((l) => !have.split("\n").some((x) => x.trim() === l || x.trim() === l.replace(/\/$/, "")));
      if (lines.length) writeFileSync(gi, `${have}${have && !have.endsWith("\n") ? "\n" : ""}${lines.join("\n")}\n`);
    }
    if (!existsSync(`${dir}/.env`)) { cpSync(`${ROOT}/.env.example`, `${dir}/.env`); console.log("wrote .env from .env.example (set VOIDBASE_SUPERUSER_EMAIL/PASSWORD)"); }
    if (!existsSync(`${dir}/pb_hooks/main.pb.js`)) writeFileSync(`${dir}/pb_hooks/main.pb.js`, `/// <reference path="../pb_data/types.d.ts" />\nrouterAdd("GET", "/api/hello", (e) => e.json(200, { hello: "voidbase" }));\n`);
    console.log("pb_hooks/, pb_migrations/ and pb_secrets/ ready (.gitignore covers pb_data/, pb_secrets/secrets.json and .cloud/)");
    await run("bun", ["scripts/sync-panel.ts"]).catch(() => undefined);
    console.log("\nnext: voidbase serve   (the API on 8090, the admin panel at /_/; docs/setup.md)");
    break;
  }
  case "dev": await run("./node_modules/.bin/vp", ["dev", "--port", flags.port ?? "5180", "--host", flags.host ?? "127.0.0.1"]); break;
  case "build": await run("./node_modules/.bin/vp", ["build"]); break;
  case "preview": await run("./node_modules/.bin/vp", ["preview", "--port", flags.port ?? "5181", "--host", flags.host ?? "127.0.0.1"]); break;
  case "sync": {
    // the instance and its pipeline in one go (src/node/sync.ts): deploy, then connect the repository to Workers Builds
    const { sync } = await import("../src/node/sync");
    await sync({ dir: sub, name: flags.name, account: flags.account, domain: flags.domain, dryRun: !!flags["dry-run"], build: !flags["no-build"], ci: flags["no-ci"] ? false : flags.ci ? true : undefined, repo: flags.repo, branch: flags.branch });
    break;
  }
  case "deploy": {
    if (flags.void) { await run("./node_modules/.bin/void", ["deploy"]); break; } // the Void platform (void auth login first)
    const { deployToCloudflare } = await import("../src/node/deploy-cf");
    await deployToCloudflare({ name: flags.name, account: flags.account, dir: flags.dir, publicDir: flags["public-dir"] ?? flags.publicDir, dryRun: !!flags["dry-run"], regenerate: !!flags.regenerate, queue: flags["no-queue"] ? false : undefined, cron: flags["no-cron"] ? false : undefined, domain: flags.domain as string | undefined, analytics: flags.analytics ? true : undefined, rateLimit: flags["rate-limit"], hub: flags["no-hub"] ? false : undefined });
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
