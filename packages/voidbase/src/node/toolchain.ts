// The Cloudflare toolchain inside the prebuilt executable: Void, Vite and wrangler, so the binary deploys.
//
// The executable used to refuse every command that builds a Worker -- dev, build, preview, deploy, sync, bundle,
// release, panel, app, init, seed-user, `serve --workers` and `cloud init` -- with "needs the Cloudflare toolchain,
// which comes with the npm package". So the one download that needed nothing else could run an instance but could
// not put it on Cloudflare, and anyone who wanted to deploy needed npm after all.
//
// scripts/build-exe.ts now installs, for each target, what `npm i @voidbase-cloud/voidbase` would install on that
// platform, and embeds it as src/node/toolchain.generated.tar.gz. On the first command that needs it the archive is
// unpacked once under the cache directory, and the command is handed to the unpacked voidbase CLI, run by this same
// executable. Two things make that work with nothing installed:
//
//   - A Bun-compiled executable run with BUN_BE_BUN=1 is Bun itself, so the unpacked CLI (TypeScript) needs no
//     other runtime.
//   - The toolchain shells out to `node` (Void runs project code with it, and vp, void and wrangler are node
//     scripts) and to `bun`. Both are shims in the cache's bin/, and both are this executable as Bun. Measured
//     before this was written: `void --version`, `wrangler --version`, `vp build` and a whole `voidbase bundle`
//     ran that way with no real Bun or Node on PATH.
//
// The cache is keyed by version and platform, and a partly written one is never used: the archive is unpacked into a
// directory of its own and renamed into place, so two commands racing to unpack it leave one complete copy.
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { embedded } from "./embedded";

/** the embedded archive, or null when this executable was built without one (a checkout never has one) */
async function payload(): Promise<string | null> {
  try {
    // exists only while scripts/build-exe.ts compiles; a checkout typechecks this module without it
    // @ts-ignore
    return ((await import("./toolchain.generated.tar.gz", { with: { type: "file" } })) as { default: string }).default;
  } catch { return null; }
}

/** where the toolchain for this executable's version and platform is unpacked */
export function toolchainDir(version: string, platform = process.platform, arch = process.arch): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return resolve(base, "voidbase", "toolchain", `${version}-${platform}-${arch}`);
}

/**
 * `node` and `bun` in the toolchain's bin/: `bun` is this executable acting as Bun, and `node` is the real Node given
 * (src/node/node-runtime.ts), or this executable as Bun when there is none
 */
export function writeShims(bin: string, exe = process.execPath, node: string | null = null): void {
  mkdirSync(bin, { recursive: true });
  for (const name of ["node", "bun"]) {
    const real = name === "node" ? node : null;
    if (process.platform === "win32") writeFileSync(join(bin, `${name}.cmd`), real ? `@echo off\r\n"${real}" %*\r\n` : `@echo off\r\nset BUN_BE_BUN=1\r\n"${exe}" %*\r\n`);
    else { const file = join(bin, name); writeFileSync(file, real ? `#!/bin/sh\nexec "${real}" "$@"\n` : `#!/bin/sh\nBUN_BE_BUN=1 exec "${exe}" "$@"\n`); chmodSync(file, 0o755); }
  }
}

/** unpack the archive into `dir`, whole or not at all */
async function unpack(archive: string, dir: string): Promise<void> {
  const staging = `${dir}.unpacking-${process.pid}`;
  rmSync(staging, { recursive: true, force: true }); mkdirSync(staging, { recursive: true });
  // tar reads a file on disk, and the embedded archive lives in the executable's virtual filesystem
  const copy = join(tmpdir(), `voidbase-toolchain-${process.pid}.tar.gz`);
  try {
    await Bun.write(copy, Bun.file(archive));
    const r = Bun.spawnSync(["tar", "-xzf", copy, "-C", staging], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`tar could not unpack the toolchain: ${new TextDecoder().decode(r.stderr).trim() || `exit ${r.exitCode}`}`);
    writeFileSync(join(staging, ".ready"), "");
    try { renameSync(staging, dir); }
    catch (err) { if (!existsSync(join(dir, ".ready"))) throw err; }   // another command finished first: use its copy
  } finally {
    rmSync(copy, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Run a command that needs the toolchain: unpack it once, then hand the command to the unpacked voidbase CLI, run by
 * this executable as Bun, with `node` and `bun` on PATH being this executable too. Exits with the command's code.
 */
export async function runWithToolchain(argv: string[]): Promise<never> {
  const archive = await payload();
  if (!archive) {
    console.error("this executable was built without the Cloudflare toolchain, so it cannot build or deploy a Worker");
    process.exit(1);
  }
  const version = (await embedded())?.version ?? "0.0.0";
  const dir = toolchainDir(version);
  if (!existsSync(join(dir, ".ready"))) {
    console.error(`voidbase: unpacking the Cloudflare toolchain into ${dir} (once per version)`);
    mkdirSync(resolve(dir, ".."), { recursive: true });
    await unpack(archive, dir);
  }
  const bin = join(dir, "bin");
  // Void, Vite and wrangler are Node programs: a real Node when one can be had, this executable as Bun otherwise
  const { ensureNode } = await import("./node-runtime");
  const node = await ensureNode({ exclude: [bin, join(dir, "node_modules", ".bin")] }).catch((err: unknown) => {
    console.error(`voidbase: ${err instanceof Error ? err.message : String(err)}; the toolchain runs on this executable instead, where a deploy can fail`);
    return null;
  });
  writeShims(bin, process.execPath, node);
  const cli = join(dir, "node_modules", "@voidbase-cloud", "voidbase", "bin", "voidbase.ts");
  if (!existsSync(cli)) { console.error(`voidbase: the toolchain in ${dir} has no voidbase CLI; delete the directory and run again`); process.exit(1); }
  const env = { ...process.env, BUN_BE_BUN: "1", PATH: [bin, join(dir, "node_modules", ".bin"), process.env.PATH ?? ""].join(delimiter) };
  const child = Bun.spawn([process.execPath, cli, ...argv], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const forward = (signal: NodeJS.Signals) => () => { try { child.kill(signal); } catch { /* already gone */ } };
  process.on("SIGINT", forward("SIGINT")); process.on("SIGTERM", forward("SIGTERM"));
  process.exit(await child.exited);
}
