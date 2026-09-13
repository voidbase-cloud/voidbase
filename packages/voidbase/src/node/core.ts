// The core an instance runs on (voidbase-stories voidbase/updating-core.feature): a local version pins the voidbase it
// was assembled with, so taking a new version of voidbase is a rebuild that brings one in, and a rollback brings the
// old one back rather than being a repair job.
//
// A core lives once per version under pb_data/cores/<version>, with core.json saying how to run it: the release's
// executable for an instance the prebuilt binary serves, the npm package installed there for one the package serves,
// or, the first time a version is pinned, the voidbase that was already running. A version under pb_data/versions/<n>
// records its core in its own core.json, and pb_data/active carries the one in place. When an instance starts, the CLI
// hands over to the active version's core if the running one is another (bin/voidbase.ts).
//
// A running instance takes an update or a rollback from the CLI through a request file and a signal: it owns its
// rebuilds and its restart, so the CLI asks rather than acting under it.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { archiveSuffix, EXECUTABLE, PACKAGE, parseChecksums, REPO, sha256 } from "./update";

export interface CoreRecord { version: string; argv: string[] }
export const coreDir = (dataDir: string, version: string): string => join(dataDir, "cores", version);

const readJson = <T>(path: string): T | null => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; } };
const writeAtomic = (path: string, text: string): void => { writeFileSync(`${path}.next`, text); renameSync(`${path}.next`, path); };

/** how to run a core this instance has, or null */
export function coreRecord(dataDir: string, version: string): CoreRecord | null {
  const r = readJson<CoreRecord>(join(coreDir(dataDir, version), "core.json"));
  return r && r.version === version && Array.isArray(r.argv) && r.argv.length > 0 ? r : null;
}

/** record a core that is already on this machine (the voidbase serving the instance when a version is first pinned) */
export function writeCoreRecord(dataDir: string, record: CoreRecord): void {
  const dir = coreDir(dataDir, record.version);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, "core.json"), `${JSON.stringify(record, null, 2)}\n`);
}

/** the voidbase version the version in place runs on, or null when none is pinned (it runs whatever starts it) */
export const activeCoreVersion = (dataDir: string): string | null => readJson<{ version?: string }>(join(dataDir, "active", "core.json"))?.version ?? null;

/** the core a start has to hand over to: null when the running voidbase is the pinned one, or nothing is pinned */
export function handoffFor(dataDir: string, running: string): CoreRecord | null {
  const pinned = activeCoreVersion(dataDir);
  if (!pinned || pinned === running) return null;
  const r = coreRecord(dataDir, pinned);
  if (!r) throw new Error(`the version in place runs voidbase ${pinned}, and ${coreDir(dataDir, pinned)} is missing: roll back with voidbase rollback, or update again`);
  return r;
}

export interface FetchCoreOptions { dataDir: string; version: string; shape: "executable" | "package"; api?: string; log?: (line: string) => void }

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { "user-agent": "voidbase-update" }, redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

/** bring a core into pb_data/cores/<version>: the release's executable for this platform, checked, or the npm package */
export async function fetchCore(o: FetchCoreOptions): Promise<CoreRecord> {
  const log = o.log ?? (() => undefined);
  const dir = coreDir(o.dataDir, o.version); const partial = `${dir}.partial`;
  rmSync(partial, { recursive: true, force: true }); mkdirSync(partial, { recursive: true });
  let argv: string[];
  if (o.shape === "executable") {
    const base = (o.api ?? process.env.VOIDBASE_UPDATE_API ?? "https://api.github.com").replace(/\/$/, "");
    const res = await fetch(`${base}/repos/${REPO}/releases/tags/v${o.version}`, { headers: { accept: "application/vnd.github+json", "user-agent": "voidbase-update" } });
    if (!res.ok) throw new Error(`voidbase ${o.version}: no such release (HTTP ${res.status})`);
    const release = (await res.json()) as { assets?: { name: string; browser_download_url: string }[] };
    const suffix = archiveSuffix();
    const asset = (release.assets ?? []).find((a) => !!suffix && a.name.startsWith(`${EXECUTABLE}_`) && a.name.endsWith(suffix));
    if (!asset) throw new Error(`voidbase ${o.version} has no executable for this platform (${EXECUTABLE}_*${suffix ?? ""})`);
    log(`downloading ${asset.name}`);
    const zip = new Uint8Array(await (await fetchOk(asset.browser_download_url)).arrayBuffer());
    const sums = (release.assets ?? []).find((a) => a.name === "checksums.txt");
    if (sums) {
      const expected = parseChecksums(await (await fetchOk(sums.browser_download_url)).text()).get(asset.name);
      if (!expected || expected !== (await sha256(zip))) throw new Error(`${asset.name} does not match the release's checksums.txt`);
    }
    const files = unzipSync(zip);
    const name = [EXECUTABLE, `${EXECUTABLE}.exe`].find((n) => files[n]);
    if (!name) throw new Error(`${asset.name} holds no executable`);
    writeFileSync(join(partial, name), files[name]!);
    if (process.platform !== "win32") chmodSync(join(partial, name), 0o755);
    argv = [join(dir, name)];
  } else {
    writeFileSync(join(partial, "package.json"), `${JSON.stringify({ private: true, dependencies: { [PACKAGE]: o.version } }, null, 2)}\n`);
    log(`installing ${PACKAGE}@${o.version}`);
    const bun = process.versions.bun && !/[\\/]\$bunfs[\\/]|~BUN/.test(import.meta.path) ? process.execPath : "bun";
    const r = Bun.spawnSync([bun, "install"], { cwd: partial, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`installing ${PACKAGE}@${o.version}: ${r.stderr.toString().trim().split("\n").slice(-3).join(" ")}`);
    const installed = readJson<{ version?: string }>(join(partial, "node_modules", ...PACKAGE.split("/"), "package.json"))?.version;
    if (installed !== o.version) throw new Error(`installing ${PACKAGE}@${o.version} put ${installed ?? "nothing"} in place`);
    argv = [bun, join(dir, "node_modules", ...PACKAGE.split("/"), "bin", "voidbase.ts")];
  }
  const record = { version: o.version, argv };
  writeFileSync(join(partial, "core.json"), `${JSON.stringify(record, null, 2)}\n`);
  rmSync(dir, { recursive: true, force: true });
  renameSync(partial, dir);
  return record;
}

// ---- asking a running instance ----------------------------------------------------------------------------------

export interface ServeInfo { pid: number; http: string; version: string }
export const writeServeInfo = (dataDir: string, info: ServeInfo): void => writeAtomic(join(dataDir, ".serve.json"), `${JSON.stringify(info)}\n`);

/** the instance serving this pb_data, when one is: its process is alive */
export function runningInstance(dataDir: string): ServeInfo | null {
  const info = readJson<ServeInfo>(join(dataDir, ".serve.json"));
  if (!info || !info.pid) return null;
  try { process.kill(info.pid, 0); return info; } catch { return null; }
}

export type RebuildRequest = { update: string } | { rollback: number };
export const writeRequest = (dataDir: string, request: RebuildRequest): void => writeAtomic(join(dataDir, "rebuild-request.json"), JSON.stringify(request));

/** the request the CLI left, removed as it is read */
export function takeRequest(dataDir: string): RebuildRequest | null {
  const path = join(dataDir, "rebuild-request.json");
  if (!existsSync(path)) return null;
  const request = readJson<RebuildRequest>(path);
  rmSync(path, { force: true });
  return request;
}
