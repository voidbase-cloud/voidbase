// What a vanilla instance on Cloudflare declares: its plugins, pinned to approved commits, kept in its own database
// (voidbase-stories vanilla-rebuild.feature: "The admin panel defines the deployment", "A plugin survives a redeploy").
//
// On Bun the declaration is the project's voidbase.lock and pb_plugins (src/node/installed.ts). A Worker has no files, so
// the same facts live in D1, one row, and the panel's install, update and remove change that row the way the CLI changes
// the lockfile: the version is resolved against the marketplaces, the commit's files are fetched and hashed, and the
// entry pins both. Nothing here loads a plugin; a rebuild (./run.ts) is what turns the declaration into a version.
import { fetchIndex, isFilesVersion, pick } from "../../node/registry";
import { run as runSql, one } from "../db";
import { satisfies } from "../plugins/resolve";
import { SHIPPED } from "../plugins/shipped";
import { integrityOfFiles, pluginFilesFrom, untarGz } from "./assemble";

export const OFFICIAL_MARKETPLACE = "https://marketplace.voidbase.cloud";
const TABLE = "_voidbase_rebuild";

export interface DeclaredEntry {
  version: string; shape: "files"; integrity: string; marketplace: string;
  source: { repository: string; commit: string; directory?: string }; installedOn: string;
}
export interface Declaration { marketplaces: string[]; plugins: Record<string, DeclaredEntry>; disabled: string[] }

export const emptyDeclaration = (): Declaration => ({ marketplaces: [OFFICIAL_MARKETPLACE], plugins: {}, disabled: [] });

/** one value of the rebuild's own table (the declaration, the rebuild state), created the first time it is asked for */
export async function readValue<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  await runSql(db, `CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = await one<{ value: string }>(db, `SELECT value FROM ${TABLE} WHERE key = ?`, [key]);
  return row ? (JSON.parse(row.value) as T) : fallback;
}
export async function writeValue(db: D1Database, key: string, value: unknown): Promise<void> {
  await runSql(db, `CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  await runSql(db, `INSERT INTO ${TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, JSON.stringify(value)]);
}
export const readDeclaration = (db: D1Database): Promise<Declaration> => readValue(db, "declaration", emptyDeclaration());

/**
 * What a declaration amounts to, as twelve hex characters: each plugin's name, version and commit, and the removed
 * shipped names, in a fixed order. A version is uploaded tagged with it, so a deployment can be compared with what the
 * panel declares now (./drift.ts).
 */
export async function declarationHash(d: Declaration): Promise<string> {
  const canonical = JSON.stringify({ plugins: Object.keys(d.plugins).sort().map((n) => [n, d.plugins[n]!.version, d.plugins[n]!.source.commit]), disabled: [...d.disabled].sort() });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const writeDeclaration = (db: D1Database, d: Declaration): Promise<void> => writeValue(db, "declaration", d);

export interface FetchOptions { fetchImpl?: typeof fetch; tarballBase?: string }

/** an approved commit as GitHub serves it: the repository's tarball, whole, for the plugin's files to be read out of */
export async function fetchCommit(source: DeclaredEntry["source"], o: FetchOptions = {}): Promise<Uint8Array> {
  const url = `${(o.tarballBase ?? "https://codeload.github.com").replace(/\/+$/, "")}/${source.repository}/tar.gz/${source.commit}`;
  const res = await (o.fetchImpl ?? fetch)(url, { headers: { "user-agent": "voidbase-rebuild" }, redirect: "follow" });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export interface ChangeOptions extends FetchOptions { voidbaseVersion: string; now?: () => Date }
export interface Added { name: string; version: string; marketplace: string; previous?: string; unchanged?: boolean }

/** install a plugin into the declaration: resolved, fetched, hashed and pinned; the instance runs it after the next rebuild */
export async function declareAdd(db: D1Database, spec: { name: string; version?: string; marketplace?: string }, o: ChangeOptions): Promise<Added> {
  const d = await readDeclaration(db);
  const { name, version } = spec;
  const marketplaces = spec.marketplace ? [spec.marketplace] : d.plugins[name]?.marketplace ? [d.plugins[name]!.marketplace] : d.marketplaces;
  let found: { marketplace: string; v: NonNullable<ReturnType<typeof pick>> } | null = null;
  for (const m of marketplaces) {
    try {
      const { index } = await fetchIndex(m, o.fetchImpl ?? fetch);
      const v = pick(index, name, version);
      if (v) { if (found) throw new Error(`${name} is served by ${found.marketplace} and ${m}; say which marketplace`); found = { marketplace: m, v }; }
    } catch (err) { if (err instanceof Error && /say which/.test(err.message)) throw err; }
  }
  if (!found) throw new Error(`${name}${version ? `@${version}` : ""} is not served by ${marketplaces.join(", ") || "any marketplace"}`);
  const v = found.v;
  if (v.manifest.name !== name) throw new Error(`${found.marketplace} serves ${name} with a manifest called ${JSON.stringify(v.manifest.name)}; nothing was changed`);
  if (!satisfies(o.voidbaseVersion, v.manifest.voidbase)) throw new Error(`${name} ${v.version} works against voidbase ${v.manifest.voidbase}, and this instance runs ${o.voidbaseVersion}; nothing was changed`);
  if (!isFilesVersion(v)) throw new Error(`${name} ${v.version} is a bundle a marketplace built, and an instance on Cloudflare rebuilds from pb_ files at a commit; nothing was changed`);
  const have = d.plugins[name];
  if (have && have.version === v.version && have.source.commit === v.source.commit) return { name, version: have.version, marketplace: have.marketplace, unchanged: true };
  const files = pluginFilesFrom(await untarGz(await fetchCommit(v.source, o)), v.source.directory);
  const manifest = files.get("manifest.json") ? (JSON.parse(new TextDecoder().decode(files.get("manifest.json")!)) as { name?: string; version?: string }) : null;
  if (!manifest) throw new Error(`${v.source.repository}@${v.source.commit}${v.source.directory ? ` under ${v.source.directory}` : ""} has no manifest.json, so it is not a pb_ files plugin`);
  if (manifest.name !== name || manifest.version !== v.version) throw new Error(`${v.source.repository}@${v.source.commit} declares ${manifest.name} ${manifest.version}, and the marketplace approved ${name} ${v.version}; nothing was changed`);
  d.plugins[name] = { version: v.version, shape: "files", integrity: await integrityOfFiles(files), marketplace: found.marketplace, source: v.source, installedOn: (o.now ? o.now() : new Date()).toISOString().slice(0, 10) };
  d.disabled = d.disabled.filter((x) => x !== name);
  await writeDeclaration(db, d);
  return { name, version: v.version, marketplace: found.marketplace, previous: have?.version };
}

/** remove a plugin from the declaration, a shipped one too (voidbase-stories removing-a-plugin.feature) */
export async function declareRemove(db: D1Database, name: string): Promise<"removed" | "already-removed"> {
  const d = await readDeclaration(db);
  const shipped = (SHIPPED as readonly string[]).includes(name);
  if (!d.plugins[name] && !shipped) throw new Error(`${name} is not installed and does not ship with voidbase`);
  if (!d.plugins[name] && d.disabled.includes(name)) return "already-removed";
  delete d.plugins[name];
  if (shipped && !d.disabled.includes(name)) d.disabled.push(name);
  await writeDeclaration(db, d);
  return "removed";
}

/** take the newer approved version of one plugin, or of every one, from the marketplace each came from */
export async function declareUpdate(db: D1Database, only: string | undefined, o: ChangeOptions): Promise<{ updated: { name: string; from: string; to: string; marketplace: string }[]; current: string[] }> {
  const d = await readDeclaration(db);
  const names = only ? [only] : Object.keys(d.plugins);
  const updated: { name: string; from: string; to: string; marketplace: string }[] = []; const current: string[] = [];
  for (const name of names) {
    const have = d.plugins[name];
    if (!have) throw new Error(`${name} is not installed`);
    const { index } = await fetchIndex(have.marketplace, o.fetchImpl ?? fetch);
    const latest = pick(index, name);
    if (!latest) throw new Error(`${have.marketplace} no longer serves ${name}; it stays at ${have.version}`);
    if (latest.version === have.version && latest.source.commit === have.source.commit) { current.push(name); continue; }
    const added = await declareAdd(db, { name, version: latest.version, marketplace: have.marketplace }, o);
    updated.push({ name, from: have.version, to: added.version, marketplace: have.marketplace });
  }
  return { updated, current };
}
