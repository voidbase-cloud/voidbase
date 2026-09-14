// The Node the prebuilt executable's toolchain runs Void, Vite and wrangler with (src/node/toolchain.ts). They are Node
// programs, and the executable acting as Bun is not Node enough for them: Void's env-schema probe never got its child's
// answer, Vite could not load vite.config.ts, and `wrangler d1 migrations list` printed nothing and exited 0, so a deploy
// from the executable stopped (voidbase-stories b-binary-extended.feature, "Deploying to the cloud"). With a real Node
// the same deploy went through. Which Node, in order: VOIDBASE_NODE, a Node 20 or newer already on PATH, or the pinned
// release below, downloaded once into the cache and checked against the checksum written here before it is used.
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export const NODE_VERSION = "22.23.2";

/** the archive of the pinned Node for each platform the executable is built for, and its sha256 from SHASUMS256.txt */
export const NODE_ARCHIVES: Record<string, { url: string; sha256: string; bin: string }> = {
  "linux-x64": { url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz`, sha256: "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a", bin: "bin/node" },
  "linux-arm64": { url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.gz`, sha256: "013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30", bin: "bin/node" },
  "linux-x64-musl": { url: `https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64-musl.tar.gz`, sha256: "396e11ee609eb2e5cb990f045c4d037aa47b2c247f3cecb01c5c162e33ffa9af", bin: "bin/node" },
  "linux-arm64-musl": { url: `https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64-musl.tar.gz`, sha256: "b7a1a2b1c7c76e47550f17764676939840e0a64b4d04bdd375a4ac14bccaa8d8", bin: "bin/node" },
  "darwin-x64": { url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-x64.tar.gz`, sha256: "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026", bin: "bin/node" },
  "darwin-arm64": { url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`, sha256: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6", bin: "bin/node" },
  "win32-x64": { url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`, sha256: "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97", bin: "node.exe" },
};

/** this machine's key in NODE_ARCHIVES */
export function nodeTarget(platform = process.platform, arch = process.arch, musl = isMusl()): string {
  return `${platform}-${arch}${platform === "linux" && musl ? "-musl" : ""}`;
}
function isMusl(): boolean {
  return process.platform === "linux" && ["/lib/ld-musl-x86_64.so.1", "/lib/ld-musl-aarch64.so.1"].some((f) => existsSync(f));
}

const MIN_MAJOR = 20;
/** a Node of at least MIN_MAJOR on `path`, leaving out the directories in `exclude` (the toolchain's own shims) */
export function systemNode(path = process.env.PATH ?? "", exclude: string[] = []): string | null {
  const dirs = path.split(delimiter).filter((d) => d && !exclude.some((x) => resolve(d) === resolve(x)));
  const found = Bun.which("node", { PATH: dirs.join(delimiter) });
  if (!found) return null;
  const r = Bun.spawnSync([found, "--version"], { stdout: "pipe", stderr: "ignore", env: { ...process.env, BUN_BE_BUN: undefined } });
  const major = Number(/^v(\d+)\./.exec(r.stdout.toString().trim())?.[1] ?? 0);
  // a `node` that answers with Bun's version is Bun (a shim, or bun's own node alias), not the Node the toolchain needs
  return r.exitCode === 0 && major >= MIN_MAJOR && !r.stdout.toString().includes("bun") ? found : null;
}

export interface EnsureNodeOptions {
  cacheBase?: string; log?: (line: string) => void; exclude?: string[];
  /** seams for the tests */
  fetchImpl?: typeof fetch; archives?: typeof NODE_ARCHIVES; target?: string; path?: string; env?: Record<string, string | undefined>;
}

/** the Node to run the toolchain with: VOIDBASE_NODE, a Node on PATH, or the pinned release, downloaded and verified once */
export async function ensureNode(o: EnsureNodeOptions = {}): Promise<string> {
  const env = o.env ?? process.env;
  if (env.VOIDBASE_NODE) { if (!existsSync(env.VOIDBASE_NODE)) throw new Error(`VOIDBASE_NODE is ${env.VOIDBASE_NODE}, which does not exist`); return env.VOIDBASE_NODE; }
  const onPath = systemNode(o.path ?? env.PATH ?? "", o.exclude ?? []);
  if (onPath) return onPath;
  const target = o.target ?? nodeTarget();
  const archive = (o.archives ?? NODE_ARCHIVES)[target];
  if (!archive) throw new Error(`no Node ${NODE_VERSION} is pinned for ${target}: install Node ${MIN_MAJOR} or newer, or set VOIDBASE_NODE`);
  const base = o.cacheBase ?? env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const dir = resolve(base, "voidbase", "node", `v${NODE_VERSION}-${target}`);
  const bin = join(dir, archive.bin);
  if (existsSync(join(dir, ".ready")) && existsSync(bin)) return bin;
  const log = o.log ?? ((l: string) => console.error(l));
  log(`voidbase: downloading Node ${NODE_VERSION} for the Cloudflare toolchain into ${dir} (once)`);
  const res = await (o.fetchImpl ?? fetch)(archive.url);
  if (!res.ok) throw new Error(`downloading ${archive.url} answered ${res.status}: install Node ${MIN_MAJOR} or newer, or set VOIDBASE_NODE`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sum = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (sum !== archive.sha256) throw new Error(`${archive.url} does not match the checksum voidbase pins (${archive.sha256}, downloaded ${sum}): nothing was installed`);
  const staging = `${dir}.unpacking-${process.pid}`; const file = join(tmpdir(), `voidbase-node-${process.pid}${archive.url.endsWith(".zip") ? ".zip" : ".tar.gz"}`);
  rmSync(staging, { recursive: true, force: true }); mkdirSync(staging, { recursive: true });
  try {
    await Bun.write(file, bytes);
    // the archive holds one top directory (node-v<version>-<platform>); it is stripped so the binary sits at archive.bin
    const r = archive.url.endsWith(".zip") ? Bun.spawnSync(["tar", "-xf", file, "-C", staging], { stdout: "pipe", stderr: "pipe" }) : Bun.spawnSync(["tar", "-xzf", file, "-C", staging, "--strip-components=1"], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`tar could not unpack ${archive.url}: ${r.stderr.toString().trim() || `exit ${r.exitCode}`}`);
    if (archive.url.endsWith(".zip")) { const top = join(staging, `node-v${NODE_VERSION}-win-x64`); if (existsSync(top)) { const moved = `${staging}.flat`; renameSync(top, moved); rmSync(staging, { recursive: true, force: true }); renameSync(moved, staging); } }
    if (!existsSync(join(staging, archive.bin))) throw new Error(`${archive.url} has no ${archive.bin}`);
    if (process.platform !== "win32") chmodSync(join(staging, archive.bin), 0o755);
    await Bun.write(join(staging, ".ready"), "");
    mkdirSync(resolve(dir, ".."), { recursive: true });
    try { renameSync(staging, dir); } catch (err) { if (!existsSync(join(dir, ".ready"))) throw err; }
  } finally { rmSync(file, { force: true }); rmSync(staging, { recursive: true, force: true }); }
  return bin;
}
