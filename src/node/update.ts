// `voidbase update`: one command for every shape voidbase comes in.
//
// The prebuilt executable replaces itself, which is PocketBase's `pocketbase update`: the latest GitHub release, the
// asset for this platform (voidbase_<version>_<os>_<arch>.zip), its sha256 against checksums.txt, then the running
// executable replaced in place (the old one kept as `.old` until the end), optionally a pb_data backup first.
//
// An npm install is a package instead, so the second half of this file answers the same question against the
// registry and installs over the top: globally for the CLI, or as the dependency of a project that deploys it. The
// point of putting both here is that the caller does not have to know which one they have.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { home } from "./local";

export const REPO = "voidbase-cloud/voidbase";
export const EXECUTABLE = "voidbase";

// the archive name PocketBase uses, per Go's GOOS/GOARCH names, for the platforms Bun can build for
export function archiveSuffix(platform: string = process.platform, arch: string = process.arch): string | null {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  return os && cpu ? `_${os}_${cpu}.zip` : null;
}
// "0.1.0" vs "0.2.0-rc.1": numeric parts first, a pre-release tag sorts before the plain version
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => { const [core, pre] = v.replace(/^v/, "").split("-", 2); return { nums: core!.split(".").map((n) => Number(n) || 0), pre: pre ?? "" }; };
  const x = split(a), y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) { const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; if (!y.pre) return -1;
  return comparePre(x.pre, y.pre);
}

/**
 * Prerelease tags, by semver's rules rather than as strings.
 *
 * Comparing them as text says beta.2 is newer than beta.10, because "2" sorts after "1". That is wrong the moment a
 * tenth beta exists, and it is wrong in the direction that matters: whichever of them is picked as the newest is
 * what every install is offered.
 */
function comparePre(a: string, b: string): number {
  const left = a.split("."), right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i], r = right[i];
    // a shorter set of identifiers is the lower precedence, when everything before it is equal
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
    if (ln && rn) { const d = Number(l) - Number(r); if (d) return d < 0 ? -1 : 1; continue; }
    // numeric identifiers always rank below alphanumeric ones
    if (ln !== rn) return ln ? -1 : 1;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

// goreleaser's checksums.txt: "<sha256>  <file>" per line
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) { const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim()); if (m) out.set(m[2]!.trim(), m[1]!); }
  return out;
}
export async function sha256(bytes: Uint8Array): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join(""); }

export interface Release { tag: string; body: string; assets: { name: string; url: string }[] }
interface GhRelease { tag_name: string; body?: string; draft?: boolean; assets?: { name: string; browser_download_url: string }[] }
const shapeRelease = (r: GhRelease): Release => ({ tag: r.tag_name, body: r.body ?? "", assets: (r.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url })) });

/**
 * The newest release, prereleases included.
 *
 * GitHub's /releases/latest deliberately hides anything marked as a prerelease, and while voidbase is in beta the
 * prerelease is the thing we are asking people to run, so the list decides and /releases/latest is only the
 * fallback for when the list cannot be read. Drafts are never offered: they are not published.
 */
export async function fetchLatestRelease(api = process.env.VOIDBASE_UPDATE_API || "https://api.github.com"): Promise<Release> {
  const base = api.replace(/\/$/, "");
  const headers = { accept: "application/vnd.github+json", "user-agent": "voidbase-update" };
  const listed = await fetch(`${base}/repos/${REPO}/releases?per_page=20`, { headers }).catch(() => null);
  if (listed?.ok) {
    const rows = ((await listed.json().catch(() => [])) as GhRelease[]).filter((r) => r && !r.draft && typeof r.tag_name === "string");
    const best = rows.sort((a, b) => compareVersions(a.tag_name, b.tag_name)).at(-1);
    if (best) return shapeRelease(best);
  }
  const res = await fetch(`${base}/repos/${REPO}/releases/latest`, { headers });
  if (!res.ok) throw new Error(`fetching the latest release: HTTP ${res.status}`);
  return shapeRelease((await res.json()) as GhRelease);
}

export interface UpdateOptions { currentVersion: string; dataDir: string; backup?: boolean; api?: string; execPath?: string; log?: (line: string) => void }
export async function update(o: UpdateOptions): Promise<{ updated: boolean; version: string }> {
  const log = o.log ?? ((l: string) => console.log(l));
  log("Fetching release information...");
  const latest = await fetchLatestRelease(o.api);
  if (compareVersions(o.currentVersion, latest.tag) >= 0) { log(`You already have the latest version ${o.currentVersion}.`); return { updated: false, version: o.currentVersion }; }
  const suffix = archiveSuffix();
  if (!suffix) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
  const asset = latest.assets.find((a) => a.name.startsWith(`${EXECUTABLE}_`) && a.name.endsWith(suffix));
  if (!asset) throw new Error(`release ${latest.tag} has no asset for this platform (${EXECUTABLE}_*${suffix})`);
  const tmp = resolve(o.dataDir, ".tmp", `update-${latest.tag}`); rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
  try {
    log(`Downloading ${asset.name}...`);
    const zip = new Uint8Array(await (await fetchOk(asset.url)).arrayBuffer());
    const sums = latest.assets.find((a) => a.name === "checksums.txt");
    if (sums) {
      const expected = parseChecksums(await (await fetchOk(sums.url)).text()).get(asset.name);
      if (!expected) throw new Error(`checksums.txt has no entry for ${asset.name}`);
      const actual = await sha256(zip);
      if (actual !== expected) throw new Error(`checksum mismatch for ${asset.name}: expected ${expected}, got ${actual}`);
      log("Checksum verified.");
    } else log("No checksums.txt in the release; skipping the checksum check.");
    log(`Extracting ${asset.name}...`);
    const files = unzipSync(zip);
    const name = [EXECUTABLE, `${EXECUTABLE}.exe`].find((n) => files[n]);
    if (!name) throw new Error("the archive has no executable in it");
    const extracted = join(tmp, name); writeFileSync(extracted, files[name]!); if (process.platform !== "win32") chmodSync(extracted, 0o755);
    if (o.backup) {
      log("Creating pb_data backup...");
      const { openLocal } = await import("./serve"); const { createBackup } = await import("../server/backups");
      const { env } = await openLocal({ dir: o.dataDir });
      await createBackup(env as never, `@update_${latest.tag}.zip`);
    }
    log("Replacing the executable...");
    const oldExec = o.execPath ?? process.execPath;
    const renamedOld = `${oldExec}.old`;
    renameSync(oldExec, renamedOld);
    try { renameSync(extracted, oldExec); } catch (err) { renameSync(renamedOld, oldExec); throw new Error(`failed replacing the executable: ${err instanceof Error ? err.message : err}`); }
    try { rmSync(renamedOld, { force: true }); } catch { /* Windows keeps a running executable's file; it goes on the next update */ }
    log("---\nUpdate completed successfully! You can start the executable as usual.");
    const notes = latest.body.replace(/^> _To update the prebuilt executable you can run `\.\/voidbase update`\._\s*/m, "").trim();
    if (notes) log(`\nHere is a list with some of the ${latest.tag} changes:\n${notes}`);
    return { updated: true, version: latest.tag.replace(/^v/, "") };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { "user-agent": "voidbase-update" }, redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  return res;
}

// ---- Updating an install that is not the prebuilt executable ---------------------------------------------------
//
// The binary replaces itself (above). Every other shape is a package: installed globally, or a dependency of a
// project that deploys it. Those need a different question answered ("what is the newest published version") and a
// different action ("install it"), but the same command, because someone who wants a newer voidbase should not have
// to know which of the four shapes they are standing in.

export const PACKAGE = "@voidbase-cloud/voidbase";

/** How this copy of voidbase is installed, which decides what updating it means. */
export type Shape = "executable" | "global" | "project" | "checkout";
export type Manager = "bun" | "npm" | "pnpm" | "yarn";

export interface Install {
  shape: Shape;
  /** the package.json an update would edit, for the project shape */
  manifest: string | null;
  /** what that manifest currently asks for, e.g. "^0.8.0" */
  range: string | null;
  manager: Manager;
}

const LOCKFILES: [string, Manager][] = [["bun.lock", "bun"], ["bun.lockb", "bun"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["package-lock.json", "npm"]];

/** The package manager a directory is managed by, read from its lockfile. Bun is the default because we ship for it. */
export function managerFor(dir: string): Manager {
  for (const [file, manager] of LOCKFILES) if (existsSync(join(dir, file))) return manager;
  return "bun";
}

/** The nearest package.json above `from` that depends on voidbase, which is what "a project" means here. */
export function findManifest(from: string): string | null {
  let at = resolve(from);
  for (;;) {
    const p = join(at, "package.json");
    if (existsSync(p)) {
      try {
        const pkg = JSON.parse(readFileSync(p, "utf8")) as { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        if (pkg.name !== PACKAGE && (pkg.dependencies?.[PACKAGE] ?? pkg.devDependencies?.[PACKAGE])) return p;
      } catch { /* an unreadable package.json is not a project we can update */ }
    }
    const up = resolve(at, "..");
    if (up === at) return null;
    at = up;
  }
}

/**
 * Which shape this is. The question is answered from where the caller is standing rather than from where the package
 * lives, because "update voidbase" inside a project means the project's dependency even when a global copy is what
 * put the command on the PATH.
 */
export function detectInstall(o: { executable: boolean; cwd?: string; packageRoot: string }): Install {
  if (o.executable) return { shape: "executable", manifest: null, range: null, manager: "bun" };
  const manifest = findManifest(o.cwd ?? process.cwd());
  if (manifest) {
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const range = pkg.dependencies?.[PACKAGE] ?? pkg.devDependencies?.[PACKAGE] ?? null;
    return { shape: "project", manifest, range, manager: managerFor(resolve(manifest, "..")) };
  }
  // the repository itself: the package root is not inside a node_modules, so there is nothing to install over it
  const inModules = /[\\/]node_modules[\\/]/.test(o.packageRoot);
  if (!inModules) return { shape: "checkout", manifest: null, range: null, manager: managerFor(o.packageRoot) };
  return { shape: "global", manifest: null, range: null, manager: /[\\/]\.bun[\\/]/.test(o.packageRoot) ? "bun" : "npm" };
}

/**
 * The version a project is actually on: what is installed in its node_modules, or failing that the floor of the
 * range it declares. Without this, `update --check` inside a project would report the version of whichever CLI
 * happened to run it, which is the one number nobody is asking about.
 */
export function installedVersion(i: Install): string | null {
  if (!i.manifest) return null;
  const dir = resolve(i.manifest, "..");
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "node_modules", ...PACKAGE.split("/"), "package.json"), "utf8")) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch { /* not installed here: fall back to what the manifest asks for */ }
  const floor = (i.range ?? "").replace(/^[\^~>=<\s]*/, "").trim();
  return /^\d+\.\d+/.test(floor) ? floor : null;
}

/** The newest version on the registry. Separate from the GitHub release because the npm package is published first. */
export async function latestPublished(registry = process.env.VOIDBASE_REGISTRY || "https://registry.npmjs.org"): Promise<string> {
  const res = await fetch(`${registry.replace(/\/$/, "")}/${PACKAGE}/latest`, { headers: { accept: "application/json", "user-agent": "voidbase-update" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`asking ${registry} for the latest ${PACKAGE}: HTTP ${res.status}`);
  const body = (await res.json()) as { version?: string };
  if (!body.version) throw new Error(`${registry} returned no version for ${PACKAGE}`);
  return body.version;
}

/**
 * The argv that installs `version` for this shape. Printed by --dry-run, so it has to be the real thing.
 *
 * A project that pinned an exact version stays pinned and one that wrote a caret keeps its caret: updating is not
 * the moment to change a policy somebody chose on purpose.
 */
export function updateCommand(i: Install, version: string): string[] {
  const prefix = /^[\^~]/.exec(i.range ?? "")?.[0] ?? "";
  const spec = `${PACKAGE}@${prefix}${version}`;
  if (i.shape === "global")
    return i.manager === "npm" ? ["npm", "install", "-g", spec] : i.manager === "pnpm" ? ["pnpm", "add", "-g", spec] : i.manager === "yarn" ? ["yarn", "global", "add", spec] : ["bun", "add", "-g", spec];
  return i.manager === "npm" ? ["npm", "install", spec] : i.manager === "pnpm" ? ["pnpm", "add", spec] : i.manager === "yarn" ? ["yarn", "add", spec] : ["bun", "add", spec];
}

// ---- The notice ------------------------------------------------------------------------------------------------
//
// Knowing a release exists is most of the problem: nobody runs `update` for a version they have not heard of. So any
// command mentions it once a day, from a cached answer, and never waits on the network to do it.

interface Cache { checked: string; latest: string }
const cachePath = (): string => join(home(), "update-check.json");

/** Reads the cached answer if it is fresh enough to use. */
export function cachedLatest(maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now()): string | null {
  try {
    const c = JSON.parse(readFileSync(cachePath(), "utf8")) as Cache;
    return now - Date.parse(c.checked) < maxAgeMs ? c.latest : null;
  } catch { return null; }
}

export function writeCache(latest: string, now = new Date()): void {
  try { mkdirSync(home(), { recursive: true }); writeFileSync(cachePath(), `${JSON.stringify({ checked: now.toISOString(), latest } satisfies Cache)}\n`); } catch { /* a cache that cannot be written just means checking again tomorrow */ }
}

/** Whether to say anything at all: never in CI, never when told not to, never when the output is not a terminal. */
export function noticeWanted(env: Record<string, string | undefined> = process.env, tty = !!process.stdout.isTTY): boolean {
  if (env.VOIDBASE_NO_UPDATE_CHECK === "1" || env.NO_UPDATE_NOTIFIER === "1") return false;
  if (env.CI || env.VOIDBASE_CI_INNER) return false;
  return tty;
}

/** The one line a command prints when a newer version exists, or null. Uses the cache; refreshes it in the background. */
export function noticeFor(current: string, latest: string | null, i: Install): string | null {
  if (!latest || compareVersions(current, latest) >= 0) return null;
  const how = i.shape === "checkout" ? "git pull" : "voidbase update";
  return `\nvoidbase ${latest} is out (you have ${current}). Run \`${how}\`.`;
}
