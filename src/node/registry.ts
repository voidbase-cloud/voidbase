// The registry protocol, from the instance's side: what a marketplace serves, and what an instance checks before it
// trusts a bundle (docs/registry.md).
//
// A marketplace is a server that answers three GETs, two of them JSON and one a file, and nothing here cares whose
// server it is: the official one, a competitor's, or a directory on disk behind Bun.serve in a test. Trust comes from
// the integrity hash and the recorded audit rather than from the host name, which is what keeps an instance free to
// connect to several marketplaces and to leave any of them.
import { checkManifest, type PluginManifest } from "../server/plugins/manifest";

/** the protocol version this voidbase reads; a marketplace serving another is refused, not guessed at */
export const PROTOCOL = 1;
/** where the index lives under a marketplace's base URL */
export const INDEX_PATH = "registry/v1/index.json";

export interface RegistryIndex {
  schemaVersion: number;
  marketplace: { name: string; url: string };
  generatedOn: string;
  plugins: PluginListing[];
  templates?: TemplateListing[];
}

export interface PluginListing {
  /** the manifest name, unique within one marketplace; an instance qualifies collisions as <marketplace>/<name> */
  name: string;
  /** owner/name on GitHub, lower case: where the source is */
  repository: string;
  title: string;
  summary: string;
  latest: string;
  versions: PluginVersion[];
}

export interface PluginVersion {
  version: string;
  /** the manifest as the source declares it; the instance checks the loaded bundle says the same */
  manifest: PluginManifest;
  /** SRI: `sha256-<base64>` of the bundle's bytes */
  integrity: string;
  /** the bundle's URL, absolute or relative to the index */
  bundle: string;
  bytes: number;
  source: { repository: string; commit: string };
  publishedOn: string;
  /** what the marketplace checked, so a reader can disagree with any single check */
  audit?: AuditRecord;
}

export interface AuditRecord {
  ranOn: string;
  checks: { name: string; passed: boolean; detail: string }[];
}

export interface TemplateListing {
  /** what `voidbase init --template <name>` asks for; the repository's own name when absent */
  name?: string;
  repository: string;
  title: string;
  summary: string;
  commit?: string;
}

const NAME = /^[a-z][a-z0-9-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INTEGRITY = /^sha256-[A-Za-z0-9+/]+={0,2}$/;
const REPOSITORY = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Everything wrong with an index, named, before an instance reads a single version out of it. An index that fails
 * here is not "a marketplace with a problem", it is not a marketplace, and the reasons are what its operator needs.
 */
export function problemsWithIndex(index: unknown): string[] {
  const out: string[] = [];
  if (!isRecord(index)) return ["the index is not a JSON object"];
  if (index.schemaVersion !== PROTOCOL) out.push(`schemaVersion is ${JSON.stringify(index.schemaVersion)}; this voidbase reads ${PROTOCOL}`);
  const m = index.marketplace;
  if (!isRecord(m) || !isString(m.name) || !isString(m.url)) out.push("marketplace needs a name and a url");
  else if (!URL.canParse(m.url)) out.push(`marketplace.url ${JSON.stringify(m.url)} is not a URL`);
  if (!isString(index.generatedOn)) out.push("generatedOn is required");
  if (!Array.isArray(index.plugins)) { out.push("plugins has to be an array"); return out; }
  const seen = new Set<string>();
  index.plugins.forEach((p, i) => {
    const at = `plugins[${i}]`;
    if (!isRecord(p)) { out.push(`${at} is not an object`); return; }
    const name = isString(p.name) ? p.name : "";
    if (!NAME.test(name)) out.push(`${at}.name ${JSON.stringify(p.name)} is not a plugin name (lowercase, digits and dashes)`);
    else if (seen.has(name)) out.push(`${name} is listed twice; a marketplace serves each name once`);
    seen.add(name);
    if (!isString(p.repository) || !REPOSITORY.test(p.repository)) out.push(`${name || at}.repository has to be owner/name, lower case`);
    if (!isString(p.title)) out.push(`${name || at}.title is required`);
    if (!isString(p.summary)) out.push(`${name || at}.summary is required`);
    if (!Array.isArray(p.versions) || !p.versions.length) { out.push(`${name || at} lists no versions`); return; }
    const versions = new Set<string>();
    p.versions.forEach((v, j) => {
      const vat = `${name || at}.versions[${j}]`;
      if (!isRecord(v)) { out.push(`${vat} is not an object`); return; }
      const version = isString(v.version) ? v.version : "";
      if (!VERSION.test(version)) out.push(`${vat}.version ${JSON.stringify(v.version)} is not a version`);
      else if (versions.has(version)) out.push(`${name} ${version} is listed twice`);
      versions.add(version);
      if (!isRecord(v.manifest)) out.push(`${vat}.manifest is required`);
      else {
        for (const problem of checkManifest(v.manifest as unknown as PluginManifest)) out.push(`${vat}.manifest: ${problem}`);
        if (v.manifest.name !== name) out.push(`${vat}.manifest is called ${JSON.stringify(v.manifest.name)}, and the listing ${JSON.stringify(name)}`);
        if (v.manifest.version !== version) out.push(`${vat}.manifest says version ${JSON.stringify(v.manifest.version)}, and the record ${JSON.stringify(version)}`);
      }
      if (!isString(v.integrity) || !INTEGRITY.test(v.integrity)) out.push(`${vat}.integrity has to be sha256-<base64>`);
      if (!isString(v.bundle)) out.push(`${vat}.bundle (the bundle's URL) is required`);
      if (!Number.isInteger(v.bytes) || (v.bytes as number) <= 0) out.push(`${vat}.bytes has to be the bundle's size`);
      const s = v.source;
      if (!isRecord(s) || !isString(s.repository) || !REPOSITORY.test(s.repository) || !isString(s.commit) || !COMMIT.test(s.commit)) out.push(`${vat}.source needs the repository (owner/name) and the commit it was built from`);
      if (!isString(v.publishedOn)) out.push(`${vat}.publishedOn is required`);
    });
    if (!isString(p.latest) || !versions.has(p.latest)) out.push(`${name || at}.latest has to be one of its versions`);
  });
  if (index.templates !== undefined) {
    if (!Array.isArray(index.templates)) out.push("templates, when present, has to be an array");
    else index.templates.forEach((t, i) => {
      if (!isRecord(t) || !isString(t.repository) || !REPOSITORY.test(t.repository) || !isString(t.title) || !isString(t.summary)) out.push(`templates[${i}] needs repository (owner/name), title and summary`);
      else if (t.name !== undefined && (!isString(t.name) || !NAME.test(t.name))) out.push(`templates[${i}].name ${JSON.stringify(t.name)} is not a template name (lowercase, digits and dashes)`);
    });
  }
  return out;
}

/**
 * Versions, compared the way a marketplace's `latest` and a lockfile's pin need them: numbers as numbers, and a
 * prerelease before the release it precedes (0.9.0-beta.6 < 0.9.0), identifiers numeric before alphabetic.
 */
export function compareVersions(a: string, b: string): number {
  const [ac = "", ap = ""] = a.split("-", 2); const [bc = "", bp = ""] = b.split("-", 2);
  const an = ac.split(".").map(Number), bn = bc.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((an[i] ?? 0) !== (bn[i] ?? 0)) return (an[i] ?? 0) - (bn[i] ?? 0);
  if (!ap && !bp) return 0; if (!ap) return 1; if (!bp) return -1;
  const x = ap.split("."), y = bp.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const s = x[i], t = y[i];
    if (s === undefined) return -1; if (t === undefined) return 1; if (s === t) continue;
    const ns = Number(s), nt = Number(t);
    if (!Number.isNaN(ns) && !Number.isNaN(nt)) return ns - nt;
    if (!Number.isNaN(ns)) return -1; if (!Number.isNaN(nt)) return 1;
    return s < t ? -1 : 1;
  }
  return 0;
}

/** SRI over the bundle's bytes, the form the index carries and the instance recomputes */
export async function integrityOf(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))); // a copy: the digest wants a plain ArrayBuffer view
  let s = ""; for (const b of digest) s += String.fromCharCode(b);
  return `sha256-${btoa(s)}`;
}

export const verifyIntegrity = async (bytes: Uint8Array, expected: string): Promise<boolean> => (await integrityOf(bytes)) === expected;

/** a marketplace is named by its base URL; the index is at a fixed path under it */
export const indexUrl = (base: string): string => (base.endsWith("index.json") ? base : `${base.replace(/\/+$/, "")}/${INDEX_PATH}`);

/** a bundle URL is absolute or relative to the index that named it */
export const bundleUrl = (index: string, v: PluginVersion): string => new URL(v.bundle, index).toString();

export async function fetchIndex(base: string, fetchImpl: typeof fetch = fetch): Promise<{ url: string; index: RegistryIndex }> {
  const url = indexUrl(base);
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const body: unknown = await res.json();
  const problems = problemsWithIndex(body);
  if (problems.length) throw new Error(`${url} is not a registry this voidbase can read:\n  - ${problems.join("\n  - ")}`);
  return { url, index: body as RegistryIndex };
}

/** the version to install: the one asked for, else the listing's latest */
export function pick(index: RegistryIndex, name: string, version?: string): PluginVersion | null {
  const listing = index.plugins.find((p) => p.name === name);
  if (!listing) return null;
  return listing.versions.find((v) => v.version === (version ?? listing.latest)) ?? null;
}

/** the bundle's bytes, and whether they are the bytes the index promised */
export async function download(index: string, v: PluginVersion, fetchImpl: typeof fetch = fetch): Promise<{ url: string; bytes: Uint8Array; verified: boolean }> {
  const url = bundleUrl(index, v);
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { url, bytes, verified: await verifyIntegrity(bytes, v.integrity) };
}
