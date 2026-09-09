// `voidbase bundle`: build the generic voidbase Worker once (no project hooks, the stock admin panel) and lay it out
// as a release directory that `voidbase/cloud` can upload over the REST API from anywhere, including from inside
// another voidbase instance (the site's control plane creates instances from the release stored in its own R2).
//   <out>/manifest.json         ReleaseManifest (compat date/flags, modules, assets with hashes, migrations, crons, hub)
//   <out>/worker/<module>       dist/ssr/* of the Void build (index.js + chunks + wasm)
//   <out>/assets/<path>         dist/client/* (panel under _/, 404 shells)
//   <out>/migrations/<file>.sql db/migrations (Drizzle SQL with statement-breakpoint markers)
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { writeCloudProject } from "./cloud-init";
import { assetHash, contentTypeFor, type ReleaseManifest, type ReleaseSource } from "../cloud/rest";

const PKG = resolve(import.meta.dir, "../..");
export interface BundleOptions {
  out?: string; version?: string; hub?: boolean; queue?: boolean; log?: (line: string) => void; keepProject?: boolean;
  /** a project's pb_plugins (voidbase.lock beside it): the installed plugins are baked into the release's Worker, verified against the lockfile at build */
  pluginsDir?: string;
}

const walk = (dir: string, base = dir): string[] => readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? walk(f, base) : [relative(base, f).replace(/\\/g, "/")]; });
const sh = async (cmd: string[], cwd: string) => { const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env }); const [out, errText, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); if (code !== 0) throw new Error(`${cmd.join(" ")} exited with ${code}\n${out.slice(-2000)}\n${errText.slice(-2000)}`); return out; };

export async function buildRelease(o: BundleOptions = {}): Promise<{ dir: string; manifest: ReleaseManifest }> {
  const log = o.log ?? ((l: string) => console.log(l));
  const pkg = JSON.parse(readFileSync(`${PKG}/package.json`, "utf8")) as { version: string };
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", ".").slice(0, 13); // 20260906.1102
  const version = (o.version || `${pkg.version}-${stamp}`).replace(/[^A-Za-z0-9._-]/g, "-");
  const src = resolve(PKG, ".cloud/_release-src"); mkdirSync(`${src}/pb_hooks`, { recursive: true }); mkdirSync(`${src}/pb_migrations`, { recursive: true });
  const cloud = resolve(PKG, ".cloud/_release"); rmSync(cloud, { recursive: true, force: true });
  const hub = o.hub !== false; const queue = o.queue !== false;
  const pluginsDir = o.pluginsDir ? resolve(o.pluginsDir) : `${src}/pb_plugins`; mkdirSync(pluginsDir, { recursive: true });
  writeCloudProject(cloud, "internal", { hooksDir: `${src}/pb_hooks`, migrationsDir: `${src}/pb_migrations`, pluginsDir, queue: queue ? "jobs" : false, hub });
  if (o.pluginsDir) log(`plugins: ${pluginsDir} (voidbase.lock beside it decides what is baked in)`);
  // placeholder ids: the real bindings are set at upload time from the manifest
  writeFileSync(`${cloud}/wrangler.jsonc`, JSON.stringify({
    name: "voidbase", placement: { mode: "smart" },
    d1_databases: [{ binding: "DB", database_name: "voidbase-db", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "./db/migrations" }],
    r2_buckets: [{ binding: "STORAGE", bucket_name: "voidbase-storage" }],
    ...(hub ? { durable_objects: { bindings: [{ name: "HUB", class_name: "VoidbaseHub" }] }, migrations: [{ tag: "voidbase-hub-v1", new_sqlite_classes: ["VoidbaseHub"] }] } : {}),
  }, null, 2));
  writeFileSync(`${cloud}/.env`, "");
  mkdirSync(`${cloud}/public`, { recursive: true });
  log(`building release ${version} in ${cloud}`);
  await sh(["bun", resolve(PKG, "scripts/sync-panel.ts"), "--dest", `${cloud}/public/_`], cloud);
  await sh(["bun", resolve(PKG, "node_modules/.bin/vp"), "build"], cloud);
  const W = JSON.parse(readFileSync(`${cloud}/dist/ssr/wrangler.json`, "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const ssr = `${cloud}/dist/ssr`, client = `${cloud}/dist/client`;
  const modules = walk(ssr).filter((f) => f !== "wrangler.json" && !f.startsWith(".vite/")).map((path) => ({ path, type: /\.(m?js)$/.test(path) ? "esm" as const : path.endsWith(".wasm") ? "wasm" as const : "data" as const, size: statSync(join(ssr, path)).size }));
  const ignore = new Set([".assetsignore", "wrangler.json", ".dev.vars", ...(existsSync(`${client}/.assetsignore`) ? readFileSync(`${client}/.assetsignore`, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [])]);
  const assets: ReleaseManifest["assets"] = [];
  for (const path of walk(client)) { if (ignore.has(path) || ignore.has(path.split("/")[0]!)) continue; const bytes = new Uint8Array(readFileSync(join(client, path))); assets.push({ path, size: bytes.length, hash: await assetHash(bytes), contentType: contentTypeFor(path) }); }
  const migrations = readdirSync(`${PKG}/db/migrations`).filter((f) => f.endsWith(".sql")).sort().map((name) => ({ name, size: statSync(`${PKG}/db/migrations/${name}`).size }));
  const doBindings = ((W.durable_objects?.bindings ?? []) as { name: string; class_name: string }[]).map((b) => ({ binding: b.name, className: b.class_name, tag: String(((W.migrations ?? []) as { tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }[]).find((m) => (m.new_sqlite_classes ?? m.new_classes ?? []).includes(b.class_name))?.tag ?? "voidbase-hub-v1") }));
  const manifest: ReleaseManifest = {
    version, voidbase: pkg.version, builtAt: new Date().toISOString(),
    compatibilityDate: String(W.compatibility_date), compatibilityFlags: (W.compatibility_flags ?? []) as string[], mainModule: String(W.main ?? "index.js"),
    modules, assets, migrations, crons: ((W.triggers?.crons ?? []) as string[]), durableObjects: hub ? doBindings : [],
    queueBinding: queue ? String(W.queues?.producers?.[0]?.binding ?? "QUEUE_JOBS") : null,
    assetsConfig: { ...(W.assets?.html_handling ? { html_handling: W.assets.html_handling } : {}), ...(W.assets?.not_found_handling ? { not_found_handling: W.assets.not_found_handling } : {}), ...(W.assets?.run_worker_first ? { run_worker_first: W.assets.run_worker_first } : {}) },
  };
  const dir = resolve(o.out ?? resolve(PKG, ".cloud/releases", version)); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  for (const m of modules) { mkdirSync(resolve(dir, "worker", m.path, ".."), { recursive: true }); cpSync(join(ssr, m.path), resolve(dir, "worker", m.path)); }
  for (const a of assets) { mkdirSync(resolve(dir, "assets", a.path, ".."), { recursive: true }); cpSync(join(client, a.path), resolve(dir, "assets", a.path)); }
  mkdirSync(resolve(dir, "migrations"), { recursive: true });
  for (const m of migrations) cpSync(`${PKG}/db/migrations/${m.name}`, resolve(dir, "migrations", m.name));
  writeFileSync(resolve(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const total = modules.reduce((n, m) => n + m.size, 0) + assets.reduce((n, a) => n + a.size, 0);
  log(`release ${version}: ${modules.length} modules, ${assets.length} assets, ${migrations.length} migrations, ${(total / 1024 / 1024).toFixed(1)} MB -> ${dir}`);
  if (!o.keepProject) rmSync(cloud, { recursive: true, force: true });
  return { dir, manifest };
}

/** a release directory as a ReleaseSource (Bun/Node side) */
export function releaseFromDir(dir: string): ReleaseSource {
  const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8")) as ReleaseManifest;
  return { manifest, read: async (path) => new Uint8Array(readFileSync(resolve(dir, path))) };
}

/** upload a release directory into a voidbase instance that runs the site's control plane (superuser token) */
export async function pushRelease(o: { dir: string; url: string; token: string; activate?: boolean; log?: (line: string) => void }): Promise<{ version: string; files: number }> {
  const log = o.log ?? ((l: string) => console.log(l)); const base = o.url.replace(/\/$/, "");
  const manifest = JSON.parse(readFileSync(resolve(o.dir, "manifest.json"), "utf8")) as ReleaseManifest;
  if (!o.token) throw new Error("a superuser token is required (voidbase release push --token, or VOIDBASE_RELEASE_TOKEN)");
  const files = walk(o.dir).filter((f) => f !== "manifest.json"); files.push("manifest.json"); // the manifest last: it makes the release visible
  let n = 0;
  for (const f of files) {
    const res = await fetch(`${base}/api/vbcloud/releases/${encodeURIComponent(manifest.version)}/files?path=${encodeURIComponent(f)}`, { method: "POST", headers: { authorization: o.token, "content-type": "application/octet-stream" }, body: readFileSync(resolve(o.dir, f)) });
    if (!res.ok) throw new Error(`push ${f}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    n++;
  }
  if (o.activate !== false) { const res = await fetch(`${base}/api/vbcloud/releases/${encodeURIComponent(manifest.version)}/activate`, { method: "POST", headers: { authorization: o.token } }); if (!res.ok) throw new Error(`activate: ${res.status} ${(await res.text()).slice(0, 200)}`); }
  log(`pushed release ${manifest.version} (${n} files) to ${base}${o.activate !== false ? " and activated it" : ""}`);
  return { version: manifest.version, files: n };
}
