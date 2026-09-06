// `voidbase update`: PocketBase's `pocketbase update` for the prebuilt executable. The latest GitHub release, the
// asset for this platform (voidbase_<version>_<os>_<arch>.zip), its sha256 against checksums.txt, then the running
// executable replaced in place (the old one kept as `.old` until the end), optionally a pb_data backup first.
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";

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
  return x.pre < y.pre ? -1 : 1;
}
// goreleaser's checksums.txt: "<sha256>  <file>" per line
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) { const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim()); if (m) out.set(m[2]!.trim(), m[1]!); }
  return out;
}
export async function sha256(bytes: Uint8Array): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join(""); }

export interface Release { tag: string; body: string; assets: { name: string; url: string }[] }
export async function fetchLatestRelease(api = process.env.VOIDBASE_UPDATE_API || "https://api.github.com"): Promise<Release> {
  const res = await fetch(`${api.replace(/\/$/, "")}/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "voidbase-update" } });
  if (!res.ok) throw new Error(`fetching the latest release: HTTP ${res.status}`);
  const r = (await res.json()) as { tag_name: string; body?: string; assets?: { name: string; browser_download_url: string }[] };
  return { tag: r.tag_name, body: r.body ?? "", assets: (r.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url })) };
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
