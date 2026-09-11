// Installed plugins: what voidbase.lock says, what pb_plugins holds, and what `voidbase plugins` does to them.
//
// The lockfile is the truth an instance checks against: for every plugin, the marketplace it came from, the version,
// the integrity of the bundle and the commit it was built from. pb_plugins/<name>/bundle.js is the bytes, and
// release.json beside it is the marketplace's record (manifest, audit) for a person to read. A shipped plugin can be
// turned off here too, and an installed plugin with a shipped plugin's name takes its place: that is what keeps an
// instance free of our own plugins, not only of our marketplace. Nothing in this file runs a plugin.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { refusal, removalCost, satisfies, type PluginFacts, type RemovalCost } from "../server/plugins/resolve";
import { SHIPPED, SHIPPED_FACTS } from "../server/plugins/shipped";
import { compareVersions, download, fetchIndex, integrityOf, pick, type PluginVersion, type RegistryIndex } from "./registry";

export const DEFAULT_MARKETPLACES = ["https://marketplace.voidbase.cloud"];
export const LOCKFILE = "voidbase.lock";
const NAME = /^[a-z][a-z0-9-]*$/;

export interface LockEntry {
  version: string;
  /** SRI of pb_plugins/<name>/bundle.js, recomputed before anything loads */
  integrity: string;
  /** SRI of pb_plugins/<name>/deploy.js, the plugin's deploy-time half, when it has one (docs/plugins.md) */
  deploy?: string;
  /** the marketplace it came from, which is where `update` looks */
  marketplace: string;
  source: { repository: string; commit: string };
  installedOn: string;
}
export interface Lock {
  lockfileVersion: 1;
  /** the marketplaces this project installs from; ours is a default that can be removed */
  marketplaces: string[];
  plugins: Record<string, LockEntry>;
  /** shipped plugins turned off */
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

export interface Installed { name: string; version: string; marketplace: string; integrity: string; file: string; record?: PluginVersion;
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
  const lines = installed.map((p, i) => `import p${i} from ${JSON.stringify(p.file)};`);
  lines.push(`export const installed = [${installed.map((p, i) => `{ plugin: p${i}, name: ${JSON.stringify(p.name)}, version: ${JSON.stringify(p.version)}, marketplace: ${JSON.stringify(p.marketplace)} }`).join(", ")}];`);
  lines.push(`export const disabled = ${JSON.stringify(disabled)};`);
  return `${lines.join("\n")}\n`;
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

export interface AddOptions { marketplace?: string; force?: boolean; voidbaseVersion: string; fetchImpl?: typeof fetch; env?: Record<string, string | undefined> }
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
  lock.plugins[name] = { version: v.version, integrity: v.integrity, ...(v.deploy ? { deploy: v.deploy.integrity } : {}), marketplace: found.marketplace, source: v.source, installedOn: new Date().toISOString().slice(0, 10) };
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
export function removePlugin(root: string, name: string, o: { force?: boolean } = {}): "removed" | "disabled" | "already-disabled" {
  if (!o.force) {
    const cost = removalCostFor(root, name);
    if (cost) throw new Error(refusal(cost, `To go ahead: voidbase plugins remove ${name} --yes`));
  }
  const lock = readLock(root);
  if (lock.plugins[name]) {
    delete lock.plugins[name];
    rmSync(join(pluginsDirOf(root), name), { recursive: true, force: true });
    writeLock(root, lock);
    return "removed";
  }
  if (isShipped(name)) {
    if (lock.disabled.includes(name)) return "already-disabled";
    lock.disabled.push(name);
    writeLock(root, lock);
    return "disabled";
  }
  throw new Error(`${name} is not installed and does not ship with voidbase`);
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

export interface Listing { shipped: { name: string; state: "active" | "disabled" | "shadowed" }[]; installed: (LockEntry & { name: string })[]; marketplaces: string[] }

export function listPlugins(root: string, env: Record<string, string | undefined> = process.env): Listing {
  const lock = readLock(root);
  return {
    shipped: SHIPPED.map((name) => ({ name, state: lock.plugins[name] ? "shadowed" : lock.disabled.includes(name) ? "disabled" : "active" })),
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
 */
export function providedImport(id: string, packageDir: string, exportsMap: Record<string, string>): { file: string } | { from: string } | null {
  const m = /^@voidbase-cloud\/voidbase(\/.*)?$/.exec(id);
  if (m) {
    const target = exportsMap[m[1] ? `.${m[1]}` : "."];
    return target ? { file: join(packageDir, target) } : null;
  }
  if (id === "hono" || id.startsWith("hono/")) return { from: join(packageDir, "package.json") };
  return null;
}
