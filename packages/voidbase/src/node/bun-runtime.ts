// The Bun runtime `voidbase build --compile` compiles a project onto when it runs from the prebuilt executable
// (src/node/compile-project.ts). Bun compiles onto the binary it is running as, and there that binary is the voidbase
// executable acting as Bun: the result crashed on start with a segmentation fault in Bun (voidbase-stories
// b-binary-extended.feature, "Building the project into one binary"). Naming the host as `--target` changes nothing,
// since a target that matches the host still uses the running binary; `--compile-executable-path` pointing at a plain
// Bun of the same version produced a binary that started. Which Bun, in order: VOIDBASE_BUN, a `bun` of this version on
// PATH (never one in the toolchain's own directories, whose `bun` is the executable again), or that exact release,
// downloaded once from GitHub, checked against the release's SHASUMS256.txt and unzipped in this process.
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { unzipSync } from "fflate";

/** the name of Bun's release asset for a platform: bun-<os>-<arch>, aarch64 for arm64, -musl on a musl Linux */
export function bunAsset(platform = process.platform, arch = process.arch, musl = isMusl()): string {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "arm64" ? "aarch64" : arch;
  return `bun-${os}-${cpu}${platform === "linux" && musl ? "-musl" : ""}`;
}
function isMusl(): boolean {
  return process.platform === "linux" && ["/lib/ld-musl-x86_64.so.1", "/lib/ld-musl-aarch64.so.1"].some((f) => existsSync(f));
}

/** a `bun` of `version` on `path`, leaving out the toolchain's own directories (where `bun` is the voidbase executable) */
export function systemBun(path = process.env.PATH ?? "", version = Bun.version, exclude: (dir: string) => boolean = (d) => /[\\/]voidbase[\\/]toolchain[\\/]/.test(d)): string | null {
  const dirs = path.split(delimiter).filter((d) => d && !exclude(d));
  const found = Bun.which("bun", { PATH: dirs.join(delimiter) });
  if (!found) return null;
  const env = { ...process.env }; delete env.BUN_BE_BUN;
  const r = Bun.spawnSync([found, "--version"], { stdout: "pipe", stderr: "ignore", env });
  return r.exitCode === 0 && r.stdout.toString().trim() === version ? found : null;
}

export interface EnsureBunOptions {
  version?: string; cacheBase?: string; log?: (line: string) => void;
  /** seams for the tests */
  fetchImpl?: typeof fetch; asset?: string; path?: string; env?: Record<string, string | undefined>;
}

/** the plain Bun to compile onto: VOIDBASE_BUN, this version's `bun` on PATH, or this version's release, downloaded and verified once */
export async function ensureBun(o: EnsureBunOptions = {}): Promise<string> {
  const env = o.env ?? process.env;
  const version = o.version ?? Bun.version;
  if (env.VOIDBASE_BUN) { if (!existsSync(env.VOIDBASE_BUN)) throw new Error(`VOIDBASE_BUN is ${env.VOIDBASE_BUN}, which does not exist`); return env.VOIDBASE_BUN; }
  const onPath = systemBun(o.path ?? env.PATH ?? "", version);
  if (onPath) return onPath;
  const asset = o.asset ?? bunAsset();
  const exe = asset.startsWith("bun-windows-") ? "bun.exe" : "bun";
  const base = o.cacheBase ?? env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const dir = resolve(base, "voidbase", "bun", `v${version}-${asset}`);
  const bin = join(dir, exe);
  if (existsSync(join(dir, ".ready")) && existsSync(bin)) return bin;
  const log = o.log ?? ((l: string) => console.error(l));
  const fetchImpl = o.fetchImpl ?? fetch;
  const release = `https://github.com/oven-sh/bun/releases/download/bun-v${version}`;
  log(`voidbase: downloading Bun ${version} (${asset}) to compile onto, into ${dir} (once)`);
  const sums = await fetchImpl(`${release}/SHASUMS256.txt`);
  if (!sums.ok) throw new Error(`reading ${release}/SHASUMS256.txt answered ${sums.status}: install Bun ${version}, or set VOIDBASE_BUN`);
  const expected = (await sums.text()).split("\n").map((l) => l.trim().split(/\s+/)).find(([, name]) => name === `${asset}.zip`)?.[0];
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new Error(`${release}/SHASUMS256.txt lists no ${asset}.zip: install Bun ${version}, or set VOIDBASE_BUN`);
  const res = await fetchImpl(`${release}/${asset}.zip`);
  if (!res.ok) throw new Error(`downloading ${release}/${asset}.zip answered ${res.status}: install Bun ${version}, or set VOIDBASE_BUN`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sum = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (sum !== expected) throw new Error(`${release}/${asset}.zip does not match its checksum (${expected}, downloaded ${sum}): nothing was installed`);
  // the archive holds one top directory named after the asset, with the binary inside
  const inside = Object.entries(unzipSync(bytes)).find(([name]) => name === `${asset}/${exe}` || name.endsWith(`/${exe}`) || name === exe);
  if (!inside) throw new Error(`${release}/${asset}.zip has no ${exe}`);
  const staging = `${dir}.unpacking-${process.pid}`;
  rmSync(staging, { recursive: true, force: true }); mkdirSync(staging, { recursive: true });
  try {
    writeFileSync(join(staging, exe), inside[1]);
    if (process.platform !== "win32") chmodSync(join(staging, exe), 0o755);
    writeFileSync(join(staging, ".ready"), "");
    mkdirSync(dirname(dir), { recursive: true });
    try { renameSync(staging, dir); } catch (err) { if (!existsSync(join(dir, ".ready"))) throw err; }
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return bin;
}
