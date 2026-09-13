// Installed plugins: what voidbase.lock says, what pb_plugins holds, and what `voidbase plugins` does to them.
//
// The lockfile is the truth an instance checks against: for every plugin, the marketplace it came from, the version,
// the integrity of the bundle and the commit it was built from. pb_plugins/<name>/bundle.js is the bytes, and
// release.json beside it is the marketplace's record (manifest, audit) for a person to read. A shipped plugin can be
// turned off here too, and an installed plugin with a shipped plugin's name takes its place: that is what keeps an
// instance free of our own plugins, not only of our marketplace. Nothing in this file runs a plugin.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { githubToken } from "./github-token";
import { extractTarball, tarballUrl } from "./template";
import { refusal, removalCost, satisfies, type PluginFacts, type RemovalCost } from "../server/plugins/resolve";
import { SHIPPED, SHIPPED_FACTS } from "../server/plugins/shipped";
import { compareVersions, download, fetchIndex, integrityOf, isFilesVersion, pick, type PluginVersion, type RegistryIndex } from "./registry";
import { PROVIDED_RE, refusalFor } from "./refusals";

export const DEFAULT_MARKETPLACES = ["https://marketplace.voidbase.cloud"];
export const LOCKFILE = "voidbase.lock";
const NAME = /^[a-z][a-z0-9-]*$/;

export interface LockEntry {
  version: string;
  /** `files` for a plugin that is pb_ files at a commit (3.6); absent for a bundle the marketplace built */
  shape?: "files";
  /**
   * SRI recomputed before anything loads: of pb_plugins/<name>/bundle.js for a bundle, and for pb_ files of the
   * plugin's manifest.json and pb_* directories together (`integrityOfDir`)
   */
  integrity: string;
  /** SRI of pb_plugins/<name>/deploy.js, the plugin's deploy-time half, when it has one (docs/plugins.md) */
  deploy?: string;
  /** the marketplace it came from, which is where `update` looks */
  marketplace: string;
  source: { repository: string; commit: string; directory?: string };
  installedOn: string;
}

/**
 * what a pb_ files plugin is made of: its declaration, the directories an instance reads, and the plain JavaScript
 * cordis applies (`main.js`, and the modules it imports from `lib/`), nothing else
 */
export const FILES_ENTRIES = ["manifest.json", "pb_hooks", "pb_migrations", "pb_public", "main.js", "lib"] as const;

/**
 * What a pb_ files plugin's code imports: main.js and every .js under lib/, read without running them. A plugin brings
 * what it needs with it (voidbase-stories plugin-repos.feature), so a bare import has to be something an instance
 * provides (./provided.ts) and a relative one has to stay inside the plugin. Returns the bare imports, or throws with
 * every problem at once; a plugin without main.js imports nothing.
 */
export function filesPluginImports(name: string, dir: string): string[] {
  const main = join(dir, "main.js");
  if (!existsSync(main)) return [];
  const walkJs = (d: string): string[] => (existsSync(d) ? readdirSync(d).sort().flatMap((n) => { const f = join(d, n); return statSync(f).isDirectory() ? walkJs(f) : f.endsWith(".js") ? [f] : []; }) : []);
  const scan = new Bun.Transpiler({ loader: "js" });
  const bare = new Set<string>(); const problems: string[] = [];
  for (const file of [main, ...walkJs(join(dir, "lib"))]) {
    const at = relative(dir, file).replace(/\\/g, "/");
    for (const { path } of scan.scanImports(readFileSync(file, "utf8"))) {
      if (path.startsWith(".")) { if (!resolve(dirname(file), path).startsWith(resolve(dir) + "/")) problems.push(`${at} imports ${path}, which is outside the plugin`); continue; }
      if (!PROVIDED_RE.test(path)) { problems.push(`${at} imports ${path}, which an instance does not provide`); continue; }
      const why = refusalFor(path);
      if (why) problems.push(`${at}: ${why}`); else bare.add(path);
    }
  }
  if (problems.length) throw new Error(`pb_plugins/${name} cannot be loaded as it is: ${problems.join("; ")}`);
  return [...bare];
}

/** one hash over a pb_ files plugin: every file under FILES_ENTRIES, by sorted path, each path beside its bytes */
export async function integrityOfDir(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = (p: string) => { if (!existsSync(p)) return; if (statSync(p).isDirectory()) { for (const n of readdirSync(p)) walk(join(p, n)); } else files.push(relative(dir, p).replace(/\\/g, "/")); };
  for (const e of FILES_ENTRIES) walk(join(dir, e));
  const enc = new TextEncoder(); const parts: Uint8Array[] = [];
  for (const f of files.sort()) parts.push(enc.encode(`${f}\0`), new Uint8Array(readFileSync(join(dir, f))), enc.encode("\0"));
  const all = new Uint8Array(parts.reduce((n, b) => n + b.length, 0)); let at = 0; for (const b of parts) { all.set(b, at); at += b.length; }
  return integrityOf(all);
}

/**
 * A pb_ files version, fetched: GitHub's tarball of the repository at the approved commit (VOIDBASE_TARBALL_URL
 * points it elsewhere, for a mirror or a test), unpacked, and only its manifest.json and pb_* directories copied into
 * `target`, from `source.directory` when the repository holds more than one plugin.
 */
export async function fetchCommitDirectory(v: PluginVersion, target: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const { repository, commit, directory } = v.source;
  const base = (process.env.VOIDBASE_TARBALL_URL ?? "").replace(/\/+$/, "");
  const url = base ? `${base}/${repository}/tar.gz/${commit}` : tarballUrl(repository, commit);
  const token = githubToken();
  const res = await fetchImpl(url, { headers: { "user-agent": "voidbase-plugins", ...(token && !base ? { authorization: `Bearer ${token}` } : {}) }, redirect: "follow" });
  if (!res.ok) throw new Error(`${url} answered ${res.status}: ${v.manifest.name} ${v.version} could not be fetched at ${repository}@${commit}`);
  const scratch = mkdtempSync(join(tmpdir(), "voidbase-plugin-"));
  try {
    const tgz = join(scratch, "plugin.tar.gz"); writeFileSync(tgz, new Uint8Array(await res.arrayBuffer()));
    const unpacked = join(scratch, "unpacked"); await extractTarball(tgz, unpacked);
    const from = join(unpacked, directory ?? "");
    if (!existsSync(join(from, "manifest.json"))) throw new Error(`${repository}@${commit}${directory ? ` under ${directory}` : ""} has no manifest.json, so it is not a pb_ files plugin`);
    rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true });
    for (const e of FILES_ENTRIES) if (existsSync(join(from, e))) cpSync(join(from, e), join(target, e), { recursive: true });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
export interface Lock {
  lockfileVersion: 1;
  /** the marketplaces this project installs from; ours is a default that can be removed */
  marketplaces: string[];
  plugins: Record<string, LockEntry>;
  /** shipped plugins removed from this project (the field's name is lockfileVersion 1's) */
  disabled: string[];
}

export const emptyLock = (): Lock => ({ lockfileVersion: 1, marketplaces: [...DEFAULT_MARKETPLACES], plugins: {}, disabled: [] });
export const lockPath = (root: string): string => join(root, LOCKFILE);
export const pluginsDirOf = (root: string): string => join(root, "pb_plugins");
/** the project root, from the plugins directory an instance was told about: the lockfile sits beside pb_plugins */
export const rootOfPluginsDir = (dir: string): string => dirname(resolve(dir));
export const isShipped = (name: string): boolean => (SHIPPED as readonly string[]).includes(name);

export function readLock(root: string): Lock {
  const p = lockPath(root);
  if (!existsSync(p)) return emptyLock();
  const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<Lock>;
  if (raw.lockfileVersion !== 1) throw new Error(`${p}: lockfileVersion ${JSON.stringify(raw.lockfileVersion)} is not one this voidbase reads`);
  return { lockfileVersion: 1, marketplaces: raw.marketplaces ?? [...DEFAULT_MARKETPLACES], plugins: raw.plugins ?? {}, disabled: raw.disabled ?? [] };
}

export function writeLock(root: string, lock: Lock): void {
  const sorted: Lock = { ...lock, plugins: Object.fromEntries(Object.entries(lock.plugins).sort(([a], [b]) => a.localeCompare(b))), disabled: [...new Set(lock.disabled)].sort() };
  writeFileSync(lockPath(root), `${JSON.stringify(sorted, null, 2)}\n`);
}

/** the marketplaces to ask: one flag outranks the environment, which outranks the lockfile */
export function marketplacesFor(lock: Lock, env: Record<string, string | undefined> = process.env, one?: string): string[] {
  if (one) return [one.replace(/\/+$/, "")];
  const fromEnv = (env.VOIDBASE_PLUGIN_MARKETPLACES ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  return fromEnv.length ? fromEnv : lock.marketplaces;
}

export interface Installed { name: string; version: string; marketplace: string; integrity: string;
  /** pb_plugins/<name>/bundle.js for a bundle; the plugin's directory for pb_ files */
  file: string; record?: PluginVersion;
  shape?: "files";
  /** pb_plugins/<name>/deploy.js, when the lock pins one (src/node/deploy-plugins.ts runs it at deploy time) */
  deploy?: string }

/** every installed plugin, checked against the lockfile: the bytes on disk are the bytes it promised, or nothing loads */
export async function verifyInstalled(root: string): Promise<{ installed: Installed[]; disabled: string[] }> {
  const lock = readLock(root);
  const installed: Installed[] = [];
  const check = async (name: string, e: LockEntry, what: "bundle" | "deploy", locked: string): Promise<string> => {
    const file = join(pluginsDirOf(root), name, `${what}.js`);
    if (!existsSync(file)) throw new Error(`voidbase.lock lists ${name} ${e.version} but pb_plugins/${name}/${what}.js is missing: voidbase plugins update ${name}, or voidbase plugins remove ${name}`);
    const actual = await integrityOf(new Uint8Array(readFileSync(file)));
    if (actual !== locked) throw new Error(`pb_plugins/${name}/${what}.js is not the bytes voidbase.lock promises for ${name} ${e.version} (${actual} on disk, ${locked} locked): reinstall it, or remove it`);
    return file;
  };
  for (const [name, e] of Object.entries(lock.plugins)) {
    if (e.shape === "files") {
      const dir = join(pluginsDirOf(root), name);
      if (!existsSync(join(dir, "manifest.json"))) throw new Error(`voidbase.lock lists ${name} ${e.version} but pb_plugins/${name}/manifest.json is missing: voidbase plugins update ${name}, or voidbase plugins remove ${name}`);
      const actual = await integrityOfDir(dir);
      if (actual !== e.integrity) throw new Error(`pb_plugins/${name} is not the files voidbase.lock promises for ${name} ${e.version} (${actual} on disk, ${e.integrity} locked): reinstall it, or remove it`);
      const recordPath = join(dir, "release.json");
      const record = existsSync(recordPath) ? (JSON.parse(readFileSync(recordPath, "utf8")) as PluginVersion) : undefined;
      installed.push({ name, version: e.version, marketplace: e.marketplace, integrity: e.integrity, file: dir, record, shape: "files" });
      continue;
    }
    const file = await check(name, e, "bundle", e.integrity);
    const deploy = e.deploy ? await check(name, e, "deploy", e.deploy) : undefined;
    const recordPath = join(pluginsDirOf(root), name, "release.json");
    const record = existsSync(recordPath) ? (JSON.parse(readFileSync(recordPath, "utf8")) as PluginVersion) : undefined;
    installed.push({ name, version: e.version, marketplace: e.marketplace, integrity: e.integrity, file, record, ...(deploy ? { deploy } : {}) });
  }
  return { installed, disabled: lock.disabled };
}

/** the Worker's view: one module importing every verified bundle, generated at build time and refused on a mismatch */
export async function pluginsModuleSource(pluginsDir: string): Promise<string> {
  const root = rootOfPluginsDir(pluginsDir);
  const { installed, disabled } = existsSync(lockPath(root)) ? await verifyInstalled(root) : { installed: [], disabled: [] as string[] };
  // a bundle is imported by path; a pb_ files plugin is its manifest.json as the plugin, and its pb_hooks compiled into
  // a virtual module of its own (hooks-plugin.ts), which the hooks loader runs after the project's
  const hasMain = (p: Installed) => p.shape === "files" && existsSync(join(p.file, "main.js"));
  // a files plugin's main.js is imported as it is; its imports are checked first, so a Worker build fails the way Bun does
  for (const p of installed) if (hasMain(p)) filesPluginImports(p.name, p.file);
  const lines = installed.map((p, i) => (p.shape === "files" ? `import * as h${i} from ${JSON.stringify(`virtual:voidbase-plugin-hooks/${p.name}`)};${hasMain(p) ? `\nimport m${i} from ${JSON.stringify(join(p.file, "main.js"))};` : ""}` : `import p${i} from ${JSON.stringify(p.file)};`));
  const entry = (p: Installed, i: number) => {
    const common = `name: ${JSON.stringify(p.name)}, version: ${JSON.stringify(p.version)}, marketplace: ${JSON.stringify(p.marketplace)}`;
    if (p.shape !== "files") return `{ plugin: p${i}, ${common} }`;
    const manifest = readFileSync(join(p.file, "manifest.json"), "utf8").trim();
    return `{ plugin: ${hasMain(p) ? `Object.assign(m${i}, { manifest: ${manifest} })` : `{ manifest: ${manifest} }`}, ${common}, hooks: h${i} }`;
  };
  lines.push(`export const installed = [${installed.map(entry).join(", ")}];`);
  lines.push(`export const disabled = ${JSON.stringify(disabled)};`);
  lines.push(`export const projectConfig = ${JSON.stringify(projectConfigOf(pluginsDir))};`);
  return `${lines.join("\n")}\n`;
}

/**
 * A plugin with a configuration plane gets its configuration file when it is added: pb_plugins/<name>/config.json,
 * each field at its default, for the developer to change and commit. One already there is the project's and is kept,
 * which is also what an update does. It is not part of what voidbase.lock pins (a files plugin's integrity covers its
 * manifest.json and pb_ directories only): it is configuration, not the plugin.
 */
export function writeDefaultConfig(dir: string, plane: Record<string, { default?: unknown }> | undefined): void {
  const file = join(dir, "config.json");
  if (!plane || !Object.keys(plane).length || existsSync(file)) return;
  writeFileSync(file, `${JSON.stringify(Object.fromEntries(Object.entries(plane).map(([f, s]) => [f, s.default ?? null]).filter(([, d]) => d !== null)), null, 2)}\n`);
}

/** every pb_plugins/<name>/config.json in the project, shipped plugins' included: the configuration its build carries */
export function projectConfigOf(pluginsDir: string): Record<string, Record<string, string | number | boolean>> {
  const out: Record<string, Record<string, string | number | boolean>> = {};
  if (!existsSync(pluginsDir)) return out;
  for (const name of readdirSync(pluginsDir).sort()) {
    const file = join(pluginsDir, name, "config.json");
    if (!NAME.test(name) || !existsSync(file)) continue;
    try { out[name] = JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw new Error(`pb_plugins/${name}/config.json is not JSON: ${err instanceof Error ? err.message : String(err)}`); }
  }
  return out;
}

export interface Found { marketplace: string; indexUrl: string; index: RegistryIndex; version: PluginVersion }

/** where a name is served among the marketplaces asked; ambiguity is refused rather than resolved by order */
export async function locate(marketplaces: string[], name: string, version: string | undefined, fetchImpl: typeof fetch = fetch): Promise<Found> {
  const hits: Found[] = []; const misses: string[] = [];
  for (const m of marketplaces) {
    let got: { url: string; index: RegistryIndex };
    try { got = await fetchIndex(m, fetchImpl); } catch (e) { misses.push(`${m}: ${e instanceof Error ? e.message : String(e)}`); continue; }
    const v = pick(got.index, name, version);
    if (v) hits.push({ marketplace: m, indexUrl: got.url, index: got.index, version: v });
  }
  if (!hits.length) throw new Error(`${name}${version ? `@${version}` : ""} is not served by ${marketplaces.join(", ") || "any marketplace"}${misses.length ? `\n  ${misses.join("\n  ")}` : ""}`);
  if (hits.length > 1) throw new Error(`${name} is served by ${hits.map((h) => h.marketplace).join(" and ")}; say which: voidbase plugins add ${name} --marketplace <url>`);
  return hits[0]!;
}

export interface AddOptions {
  marketplace?: string; force?: boolean; voidbaseVersion: string; fetchImpl?: typeof fetch; env?: Record<string, string | undefined>;
  /**
   * write pb_plugins/<name>/config.json at each field's default (the default): a project's configuration, committed with
   * it. The admin panel of a vanilla instance passes false, since that instance keeps what an admin sets in `_params`
   * and a config.json there would read as the project's and turn the plane read only (src/server/plugin-config.ts).
   */
  defaultConfig?: boolean;
}
export interface Added { name: string; version: string; marketplace: string; previous?: string; unchanged?: boolean; shadows: boolean }

/** install a plugin: locate it, download it, verify the bytes, write pb_plugins/<name> and the lockfile */
export async function addPlugin(root: string, spec: string, o: AddOptions): Promise<Added> {
  const [name, version] = spec.split("@", 2) as [string, string?];
  if (!NAME.test(name)) throw new Error(`${JSON.stringify(name)} is not a plugin name (lowercase, digits and dashes)`);
  const lock = readLock(root);
  const found = await locate(marketplacesFor(lock, o.env, o.marketplace), name, version, o.fetchImpl ?? fetch);
  const v = found.version;
  if (v.manifest.name !== name) throw new Error(`${found.marketplace} serves ${name} with a manifest called ${JSON.stringify(v.manifest.name)}; nothing was installed`);
  if (!satisfies(o.voidbaseVersion, v.manifest.voidbase)) throw new Error(`${name} ${v.version} works against voidbase ${v.manifest.voidbase}, and this is ${o.voidbaseVersion}; nothing was installed`);
  const have = lock.plugins[name];
  if (isFilesVersion(v)) {
    if (have && have.shape === "files" && have.version === v.version && have.source.commit === v.source.commit && !o.force) return { name, version: v.version, marketplace: found.marketplace, previous: have.version, unchanged: true, shadows: isShipped(name) };
    const dir = join(pluginsDirOf(root), name);
    await fetchCommitDirectory(v, dir, o.fetchImpl ?? fetch);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { name?: string; version?: string };
    if (manifest.name !== name || manifest.version !== v.version) { rmSync(dir, { recursive: true, force: true }); throw new Error(`${v.source.repository}@${v.source.commit} declares ${manifest.name} ${manifest.version} in manifest.json, and ${found.marketplace} lists ${name} ${v.version}; nothing was installed`); }
    writeFileSync(join(dir, "release.json"), `${JSON.stringify(v, null, 2)}\n`);
    if (o.defaultConfig !== false) writeDefaultConfig(dir, (manifest as PluginVersion["manifest"]).config ?? v.manifest.config);
    lock.plugins[name] = { version: v.version, shape: "files", integrity: await integrityOfDir(dir), marketplace: found.marketplace, source: v.source, installedOn: new Date().toISOString().slice(0, 10) };
    lock.disabled = lock.disabled.filter((d) => d !== name);
    writeLock(root, lock);
    return { name, version: v.version, marketplace: found.marketplace, previous: have?.version, shadows: isShipped(name) };
  }
  if (have && have.version === v.version && have.integrity === v.integrity && !o.force) return { name, version: v.version, marketplace: found.marketplace, previous: have.version, unchanged: true, shadows: isShipped(name) };
  const got = await download(found.indexUrl, v, o.fetchImpl ?? fetch);
  if (!got.verified) throw new Error(`${got.url} is not the bytes ${found.marketplace} promised (${v.integrity}); nothing was installed`);
  const dir = join(pluginsDirOf(root), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bundle.js"), got.bytes);
  // the deploy-time half, when the record names one: beside the bundle, verified and pinned the same way
  if (v.deploy) {
    const d = await download(found.indexUrl, { ...v, bundle: v.deploy.file, integrity: v.deploy.integrity }, o.fetchImpl ?? fetch);
    if (!d.verified) throw new Error(`${d.url} is not the bytes ${found.marketplace} promised for ${name}'s deploy.js (${v.deploy.integrity}); nothing was installed`);
    writeFileSync(join(dir, "deploy.js"), d.bytes);
  } else rmSync(join(dir, "deploy.js"), { force: true });
  writeFileSync(join(dir, "release.json"), `${JSON.stringify(v, null, 2)}\n`);
  if (o.defaultConfig !== false) writeDefaultConfig(dir, v.manifest.config);
  lock.plugins[name] = { version: v.version, integrity: v.integrity ?? "", ...(v.deploy ? { deploy: v.deploy.integrity } : {}), marketplace: found.marketplace, source: v.source, installedOn: new Date().toISOString().slice(0, 10) };
  lock.disabled = lock.disabled.filter((d) => d !== name);
  writeLock(root, lock);
  return { name, version: v.version, marketplace: found.marketplace, previous: have?.version, shadows: isShipped(name) };
}

/**
 * The plugin graph as this project stands: what ships and is still on, minus what an installed plugin shadows by
 * name, plus what is installed. A shipped plugin's manifest is read from the data table rather than by importing
 * it; an installed one's is the release.json the marketplace served, which is beside its bundle.
 */
export function pluginFacts(root: string): PluginFacts[] {
  const lock = readLock(root);
  const installed = Object.keys(lock.plugins);
  const facts: PluginFacts[] = [];
  for (const name of SHIPPED) {
    if (lock.disabled.includes(name) || installed.includes(name)) continue;
    const f = SHIPPED_FACTS[name];
    facts.push({ name, tier: f.tier, provides: [...(f.provides ?? [])], requires: [...(f.requires ?? [])] });
  }
  for (const name of installed) {
    const recordPath = join(pluginsDirOf(root), name, "release.json");
    const m = existsSync(recordPath) ? (JSON.parse(readFileSync(recordPath, "utf8")) as PluginVersion).manifest : undefined;
    facts.push({ name, tier: m?.tier ?? "community", provides: [...(m?.provides ?? [])], requires: [...(m?.requires ?? [])] });
  }
  return facts;
}

/** what removing this plugin costs this project, or null when nothing worth stopping for stops working */
export const removalCostFor = (root: string, name: string): RemovalCost | null => removalCost(pluginFacts(root), name);

/**
 * An installed plugin is deleted; a shipped one is turned off, which is the same thing from the instance's side.
 *
 * Both are the deliberate act the tiers exist for, so a core plugin, or the only provider of something else's
 * requirement, is refused here rather than in the caller: this function is what writes voidbase.lock, and a guard
 * anywhere else is a guard something can be written around. `force` is the caller's `--yes`.
 */
/**
 * Removing a plugin removes it (voidbase-stories, voidbase/removing-a-plugin.feature): its files and configuration go,
 * and a name that ships with voidbase is not loaded from the core either, whether the core's copy or one installed over
 * it was the one running. What it provided goes with it. The lock keeps shipped names removed in `disabled`, its
 * field since lockfileVersion 1; `plugins add <name>` puts one back.
 */
export function removePlugin(root: string, name: string, o: { force?: boolean } = {}): "removed" | "already-removed" {
  if (!o.force) {
    const cost = removalCostFor(root, name);
    if (cost) throw new Error(refusal(cost, `To go ahead: voidbase plugins remove ${name} --yes`));
  }
  const lock = readLock(root);
  const shipped = isShipped(name);
  if (!lock.plugins[name] && !shipped) throw new Error(`${name} is not installed and does not ship with voidbase`);
  if (!lock.plugins[name] && lock.disabled.includes(name)) return "already-removed";
  delete lock.plugins[name];
  rmSync(join(pluginsDirOf(root), name), { recursive: true, force: true });
  if (shipped && !lock.disabled.includes(name)) lock.disabled.push(name);
  writeLock(root, lock);
  return "removed";
}

/** a shipped plugin turned back on */
export function enablePlugin(root: string, name: string): "enabled" | "not-disabled" {
  if (!isShipped(name)) throw new Error(`${name} does not ship with voidbase; install it with voidbase plugins add ${name}`);
  const lock = readLock(root);
  if (!lock.disabled.includes(name)) return "not-disabled";
  lock.disabled = lock.disabled.filter((d) => d !== name);
  writeLock(root, lock);
  return "enabled";
}

export interface Updated { name: string; from: string; to: string; marketplace: string }

/** every installed plugin (or one) brought to the latest its own marketplace serves; each is verified like an install */
export async function updatePlugins(root: string, only: string | undefined, o: Omit<AddOptions, "marketplace" | "force">): Promise<{ updated: Updated[]; current: string[] }> {
  const lock = readLock(root);
  const names = only ? [only] : Object.keys(lock.plugins);
  const updated: Updated[] = []; const current: string[] = [];
  for (const name of names) {
    const have = lock.plugins[name];
    if (!have) throw new Error(`${name} is not installed`);
    const { index } = await fetchIndex(have.marketplace, o.fetchImpl ?? fetch);
    const latest = pick(index, name);
    if (!latest) throw new Error(`${have.marketplace} no longer serves ${name}; it stays at ${have.version}`);
    if (compareVersions(latest.version, have.version) <= 0) { current.push(name); continue; }
    const added = await addPlugin(root, `${name}@${latest.version}`, { ...o, marketplace: have.marketplace, force: true });
    updated.push({ name, from: have.version, to: added.version, marketplace: have.marketplace });
  }
  return { updated, current };
}

export interface Listing { shipped: { name: string; state: "active" | "removed" | "shadowed" }[]; installed: (LockEntry & { name: string })[]; marketplaces: string[] }

export function listPlugins(root: string, env: Record<string, string | undefined> = process.env): Listing {
  const lock = readLock(root);
  return {
    shipped: SHIPPED.map((name) => ({ name, state: lock.plugins[name] ? "shadowed" : lock.disabled.includes(name) ? "removed" : "active" })),
    installed: Object.entries(lock.plugins).map(([name, e]) => ({ name, ...e })),
    marketplaces: marketplacesFor(lock, env),
  };
}

/** before a version jump: the installed plugins whose range excludes the target, by name and range */
export function outsideRange(root: string, target: string): { name: string; range: string }[] {
  const out: { name: string; range: string }[] = [];
  for (const name of Object.keys(readLock(root).plugins)) {
    const recordPath = join(pluginsDirOf(root), name, "release.json");
    if (!existsSync(recordPath)) continue;
    const range = (JSON.parse(readFileSync(recordPath, "utf8")) as PluginVersion).manifest.voidbase;
    if (range && !satisfies(target, range)) out.push({ name, range });
  }
  return out;
}

/**
 * What an installed bundle's bare import means when the Worker is built: voidbase's own files, by the package's
 * own exports map, and hono from voidbase's copy. A bundle may import only those (docs/registry.md), and a
 * project's Vite would find them in node_modules; the builder builds from voidbase's checkout, where the package
 * is not in its own node_modules and a bare self-import has nothing to resolve to. So the plugin maps them itself,
 * the same way the Bun loader provides them (platform/node/plugins.ts), and both shapes see the same modules.
 * Returns the file for a voidbase specifier, "hono" for hono's (the caller resolves it from the package), or null.
 * An entry whose target is a set of conditions is a platform pick (`./platform`, `./platform/email`,
 * `./platform/raster`): this builds a Worker, so the `workerd` half is the answer, the way the resolver would pick
 * it. hooks-plugin.ts aliases the same three names ahead of this, which is how `raster-off` still wins when share
 * cards are off; without the alias this would land on the real rasteriser and its 2.4 MB of wasm.
 *
 * `from` is who is importing, because the two are not owed the same answer. A plugin bundle is refused every entry
 * ./provided.ts's `NOT_PROVIDED` names — the application, the Worker entry points, the build-time tooling — and
 * refused here, while the Worker is built, rather than only on Bun at load: through 0.9.0-beta.49 this half
 * answered with the file for all of them, so a bundle importing `@voidbase-cloud/voidbase/app` built the whole
 * application into the Worker and was refused only by the other runtime. A project's own `workflows/` module is
 * not a plugin and is owed the opposite: `@voidbase-cloud/voidbase/workflows` is the name it is written against
 * (docs/adapter.md), so nothing is refused it.
 */
export function providedImport(id: string, packageDir: string, exportsMap: Record<string, string | Record<string, string>>, from: "plugin-bundle" | "project" = "plugin-bundle"): { file: string } | { from: string } | null {
  const m = /^@voidbase-cloud\/voidbase(\/.*)?$/.exec(id);
  if (m) {
    if (from === "plugin-bundle") { const why = refusalFor(id); if (why) throw new Error(why); }
    const entry = exportsMap[m[1] ? `.${m[1]}` : "."];
    const target = typeof entry === "string" ? entry : (entry?.workerd ?? entry?.default);
    return target ? { file: join(packageDir, target) } : null;
  }
  if (id === "hono" || id.startsWith("hono/")) return { from: join(packageDir, "package.json") };
  return null;
}
