// Prebuilt executables laid out like PocketBase's release assets: voidbase_<version>_<os>_<arch>.zip holding the
// executable, CHANGELOG.md and LICENSE, plus checksums.txt (sha256, goreleaser's format). Bun cross-compiles every
// target from one machine; the admin panel, the system migrations and the hooks typings are embedded
// (src/node/embedded.ts), so `voidbase serve` works offline from the single file.
// The Cloudflare toolchain (Void, Vite, wrangler) is embedded too, so the executable deploys (src/node/toolchain.ts);
// --no-toolchain leaves it out, for a quick local build that only needs to serve.
//   bun scripts/build-exe.ts [--targets host|all|linux-x64,darwin-arm64,...] [--out dist/release] [--version X.Y.Z] [--keep-embedded] [--no-toolchain]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { zipSync, type Zippable } from "fflate";

// the published package: this script is the repository's release tooling and lives in the workspace root's scripts/
const PKG = resolve(import.meta.dir, "../packages/voidbase");
export const TARGETS: Record<string, { bun: string; os: string; arch: string; exe: string }> = {
  "linux-x64": { bun: "bun-linux-x64", os: "linux", arch: "amd64", exe: "voidbase" },
  "linux-arm64": { bun: "bun-linux-arm64", os: "linux", arch: "arm64", exe: "voidbase" },
  "linux-x64-musl": { bun: "bun-linux-x64-musl", os: "linux", arch: "amd64_musl", exe: "voidbase" },
  "linux-arm64-musl": { bun: "bun-linux-arm64-musl", os: "linux", arch: "arm64_musl", exe: "voidbase" },
  "darwin-x64": { bun: "bun-darwin-x64", os: "darwin", arch: "amd64", exe: "voidbase" },
  "darwin-arm64": { bun: "bun-darwin-arm64", os: "darwin", arch: "arm64", exe: "voidbase" },
  "windows-x64": { bun: "bun-windows-x64", os: "windows", arch: "amd64", exe: "voidbase.exe" },
};
export const hostTarget = () => `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;

const walk = (dir: string, base = dir): string[] => readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? walk(f, base) : [relative(base, f).replace(/\\/g, "/")]; });
const b64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const sha256 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join("");
const UNIX_EXEC = { os: 3, attrs: 0o100755 << 16 }; // zip external attributes: a regular file, mode 0755

export interface BuildOptions { targets?: string[]; out?: string; version?: string; keepEmbedded?: boolean; log?: (line: string) => void; toolchain?: boolean }

// Bun's names for the platforms it installs optional dependencies for, per target
const INSTALL: Record<string, { os: string; cpu: string; libc?: "gnu" | "musl" }> = {
  "linux-x64": { os: "linux", cpu: "x64", libc: "gnu" }, "linux-arm64": { os: "linux", cpu: "arm64", libc: "gnu" },
  "linux-x64-musl": { os: "linux", cpu: "x64", libc: "musl" }, "linux-arm64-musl": { os: "linux", cpu: "arm64", libc: "musl" },
  "darwin-x64": { os: "darwin", cpu: "x64" }, "darwin-arm64": { os: "darwin", cpu: "arm64" }, "windows-x64": { os: "win32", cpu: "x64" },
};

/**
 * What `npm i @voidbase-cloud/voidbase` installs on one target, as a tar.gz the executable embeds (src/node/toolchain.ts).
 *
 * The packages are this workspace's own, packed as the release would pack them, so the toolchain inside an executable
 * is the voidbase it was built from and not whatever npm had last. `--os` and `--cpu` fetch the target's native
 * packages (workerd, rolldown, vite-plus) from any machine. Bun installs both libc builds of a linux binding, and an
 * executable only ever loads its own, so the other is removed: about 73 MB of 667 on linux-x64.
 */
async function stageToolchain(target: string, packs: string, stageRoot: string, log: (line: string) => void): Promise<string> {
  const I = INSTALL[target]!;
  const dir = `${stageRoot}/${target}`; rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const tarballs = readdirSync(packs).filter((f) => f.endsWith(".tgz"));
  const nameOf = (f: string) => `@voidbase-cloud/${f.slice("voidbase-cloud-".length).replace(/-\d+\.\d+\.\d+(-[\w.]+)?\.tgz$/, "")}`;
  const refs = Object.fromEntries(tarballs.map((f) => [nameOf(f), `file:${packs}/${f}`]));
  writeFileSync(`${dir}/package.json`, JSON.stringify({ name: "voidbase-toolchain", private: true, dependencies: { "@voidbase-cloud/voidbase": refs["@voidbase-cloud/voidbase"] }, overrides: refs }, null, 2));
  const r = Bun.spawnSync(["bun", "install", "--production", `--os=${I.os}`, `--cpu=${I.cpu}`], { cwd: dir, stdout: "pipe", stderr: "pipe", env: process.env });
  if (r.exitCode !== 0) throw new Error(`installing the toolchain for ${target} failed:\n${new TextDecoder().decode(r.stderr)}`);
  if (I.libc) {
    const other = I.libc === "gnu" ? "-musl" : "-gnu";
    for (const scope of readdirSync(`${dir}/node_modules`).filter((d) => d.startsWith("@"))) {
      for (const pkg of readdirSync(`${dir}/node_modules/${scope}`)) if (pkg.endsWith(other)) rmSync(`${dir}/node_modules/${scope}/${pkg}`, { recursive: true, force: true });
    }
  }
  const archive = `${stageRoot}/${target}.tar.gz`;
  const t = Bun.spawnSync(["tar", "-czf", archive, "-C", dir, "node_modules"], { stdout: "pipe", stderr: "pipe" });
  if (t.exitCode !== 0) throw new Error(`archiving the toolchain for ${target} failed: ${new TextDecoder().decode(t.stderr)}`);
  log(`  toolchain for ${target}: ${(statSync(archive).size / 1024 / 1024).toFixed(0)} MB`);
  return archive;
}
export async function buildExecutables(o: BuildOptions = {}): Promise<{ version: string; out: string; archives: { target: string; file: string; bytes: number; sha256: string }[] }> {
  const log = o.log ?? ((l: string) => console.log(l));
  const version = o.version ?? (JSON.parse(readFileSync(`${PKG}/package.json`, "utf8")) as { version: string }).version;
  const targets = (o.targets ?? ["host"]).flatMap((t) => (t === "all" ? Object.keys(TARGETS) : t === "host" ? [hostTarget()] : [t]));
  for (const t of targets) if (!TARGETS[t]) throw new Error(`unknown target ${t} (known: ${Object.keys(TARGETS).join(", ")})`);
  const out = resolve(o.out ?? `${PKG}/dist/release`); mkdirSync(out, { recursive: true });

  // what the executable must carry: the panel (zipped), the system migrations, the typings, the version
  const panelDir = `${PKG}/public/_`;
  if (!existsSync(`${panelDir}/index.html`)) { log("syncing the admin panel into public/_"); const r = Bun.spawnSync(["bun", `${PKG}/scripts/sync-panel.ts`], { cwd: PKG, stdout: "inherit", stderr: "inherit" }); if (r.exitCode !== 0) throw new Error("panel sync failed"); }
  const panelFiles: Zippable = {}; for (const f of walk(panelDir)) panelFiles[f] = [new Uint8Array(readFileSync(join(panelDir, f))), { level: 6 }];
  const panelVersion = (() => { try { return (JSON.parse(readFileSync(`${panelDir}/../../pocketbase-panel.json`, "utf8")) as { version: string }).version; } catch { return process.env.POCKETBASE_PANEL_VERSION ?? "0.40.2"; } })();
  const migrations: Record<string, string> = {}; for (const f of readdirSync(`${PKG}/db/migrations`).filter((f) => f.endsWith(".sql")).sort()) migrations[f] = readFileSync(`${PKG}/db/migrations/${f}`, "utf8");
  const embeddedPath = `${PKG}/src/node/embedded.generated.json`;
  writeFileSync(embeddedPath, JSON.stringify({ version, migrations, typesDts: readFileSync(`${PKG}/types/pb_data.d.ts`, "utf8"), panel: { version: panelVersion, zipBase64: b64(zipSync(panelFiles)) } }));
  log(`embedded: ${Object.keys(migrations).length} migrations, the typings, the ${panelVersion} panel (${Object.keys(panelFiles).length} files)`);

  const archives: { target: string; file: string; bytes: number; sha256: string }[] = [];
  const changelog = new Uint8Array(readFileSync(`${PKG}/CHANGELOG.md`)), license = new Uint8Array(readFileSync(`${PKG}/LICENSE`));
  // the toolchain every target embeds (src/node/toolchain.ts): this workspace's packages, packed once
  const toolchainPath = `${PKG}/src/node/toolchain.generated.tar.gz`;
  const withToolchain = o.toolchain ?? true;
  // never inside the workspace: the staged tree is every dependency with its own test files, which `bun test` at the
  // root would find and run, and a node_modules tree that tsc and the packer have no business walking
  const stageRoot = resolve(process.env.CI_CACHE_DIR ? `${process.env.CI_CACHE_DIR}/toolchain-stage` : join(tmpdir(), "voidbase-toolchain-stage"));
  const packs = `${stageRoot}/packs`;
  if (withToolchain) {
    rmSync(packs, { recursive: true, force: true }); mkdirSync(packs, { recursive: true });
    const root = resolve(PKG, "..");
    for (const d of [PKG, ...readdirSync(root).filter((n) => n.startsWith("plugin-")).map((n) => `${root}/${n}`)]) {
      const r = Bun.spawnSync(["bun", "pm", "pack", "--destination", packs], { cwd: d, stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`packing ${d} for the toolchain failed: ${new TextDecoder().decode(r.stderr)}`);
    }
    log(`toolchain: ${readdirSync(packs).length} packages packed`);
  }
  try {
    for (const t of targets) {
      const T = TARGETS[t]!; const exeDir = `${PKG}/dist/exe/${t}`; mkdirSync(exeDir, { recursive: true });
      const exe = `${exeDir}/${T.exe}`;
      if (withToolchain) { const archive = await stageToolchain(t, packs, stageRoot, log); writeFileSync(toolchainPath, readFileSync(archive)); }
      log(`compiling ${t} (${T.bun})`);
      const r = Bun.spawnSync(["bun", "build", "--compile", `--target=${T.bun}`, `${PKG}/bin/voidbase.ts`, "--outfile", exe], { cwd: PKG, stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`bun build --compile failed for ${t}:\n${new TextDecoder().decode(r.stderr)}`);
      const name = `voidbase_${version}_${T.os}_${T.arch}.zip`;
      const entries: Zippable = { [T.exe]: [new Uint8Array(readFileSync(exe)), { level: 6, ...(T.os === "windows" ? {} : UNIX_EXEC) }], "CHANGELOG.md": [changelog, { level: 6 }], LICENSE: [license, { level: 6 }] };
      const zip = zipSync(entries);
      writeFileSync(`${out}/${name}`, zip);
      archives.push({ target: t, file: name, bytes: zip.length, sha256: await sha256(zip) });
      log(`  ${name}: ${(zip.length / 1024 / 1024).toFixed(1)} MB`);
    }
    writeFileSync(`${out}/checksums.txt`, archives.map((a) => `${a.sha256}  ${a.file}`).join("\n") + "\n");
    log(`checksums.txt: ${archives.length} archives in ${out}`);
  } finally { if (!o.keepEmbedded) rmSync(embeddedPath, { force: true }); rmSync(toolchainPath, { force: true }); }
  return { version, out, archives };
}

if (import.meta.main) {
  const flags: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) { const a = argv[i]!; if (a.startsWith("--")) { const [k, v] = a.slice(2).split("="); flags[k!] = v ?? (argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "1"); } }
  await buildExecutables({ targets: (flags.targets ?? "host").split(","), out: flags.out, version: flags.version, keepEmbedded: !!flags["keep-embedded"], toolchain: !flags["no-toolchain"] });
}
