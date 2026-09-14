// `voidbase build --compile [index.ts] [--outfile name]`: an extended project squashed into one binary, built with
// Bun's compiler. The binary is the project's entry file and voidbase, like any `bun build --compile`, plus what a
// plain one cannot carry: what the voidbase executable embeds (the system migrations, the typings, the admin panel;
// ./embedded.ts) and the project's pb_hooks, pb_migrations, pb_plugins, pb_public and voidbase.lock
// (./baked-project.ts). Both are generated files in the voidbase package the entry resolves to, written right before
// Bun compiles and removed after, the way scripts/build-exe.ts builds the voidbase executable itself.
//
// Which voidbase: the project's own install when it has one, otherwise this CLI's, linked into the project's
// node_modules for the length of the compile (Bun's bundler does not read NODE_PATH). That is what lets a project
// around the voidbase binary, with nothing installed, be squashed too: the binary runs this through its embedded
// toolchain, which has the package on disk (./toolchain.ts).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { ensurePanelDir } from "./panel";
import { installedVoidbase } from "./run-entry";

const PKG = resolve(import.meta.dir, "../..");
/** the folders an extended project hands voidbase, carried into the binary when they exist */
export const PROJECT_FOLDERS = ["pb_hooks", "pb_migrations", "pb_plugins", "pb_public"] as const;

const walk = (dir: string, base = dir): string[] => readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? walk(f, base) : [relative(base, f).replace(/\\/g, "/")]; });
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** the project's files a squashed binary carries, by path relative to the project, base64 */
export function projectFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const folder of PROJECT_FOLDERS) {
    const d = join(dir, folder);
    if (existsSync(d)) for (const f of walk(d)) files[`${folder}/${f}`] = b64(readFileSync(join(d, f)));
  }
  if (existsSync(join(dir, "voidbase.lock"))) files["voidbase.lock"] = b64(readFileSync(join(dir, "voidbase.lock")));
  return files;
}

export interface CompileOptions { entry?: string; outfile?: string; dir?: string; log?: (line: string) => void }

/** whether the runtime at `execPath` is something other than Bun itself (the voidbase executable), which a binary must not be compiled onto */
export function compilesOntoExecutable(execPath: string): boolean {
  // split on both separators: a Windows path read on another platform is still one name to node:path's basename
  return !/^bun(-debug)?(\.exe)?$/i.test(execPath.split(/[\\/]/).pop() ?? "");
}

export async function compileProject(o: CompileOptions = {}): Promise<{ outfile: string; files: number; bytes: number }> {
  const log = o.log ?? ((l: string) => console.log(l));
  const dir = resolve(o.dir ?? ".");
  const entry = resolve(dir, o.entry ?? "index.ts");
  if (!existsSync(entry)) throw new Error(`no entry file at ${entry}: an extended project is an entry file that loads voidbase and hands it the pb_ folders`);
  const outfile = resolve(dir, o.outfile ?? basename(dir));

  const installed = installedVoidbase(dir);
  const pkgDir = installed ?? PKG; const made: string[] = []; let link: string | undefined;
  if (!installed) {
    // taken away afterwards: the link itself (never what it points at), then only the directories this made
    const modules = join(dir, "node_modules"), scope = join(modules, "@voidbase-cloud");
    for (const d of [modules, scope]) if (!existsSync(d)) { mkdirSync(d); made.unshift(d); }
    link = join(scope, "voidbase");
    symlinkSync(PKG, link, "dir");
  }

  const files = projectFiles(dir);
  const id = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 16);
  const embeddedPath = join(pkgDir, "src/node/embedded.generated.json");
  const projectPath = join(pkgDir, "src/node/project-files.generated.json");
  // a checkout that is mid-way through scripts/build-exe.ts already has the embedded data; it is left as it is
  const hadEmbedded = existsSync(embeddedPath);
  try {
    if (!hadEmbedded) {
      const version = (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version: string }).version;
      const panelDir = await ensurePanelDir();
      const panel: Zippable = {}; for (const f of walk(panelDir)) panel[f] = [new Uint8Array(readFileSync(join(panelDir, f))), { level: 6 }];
      const panelVersion = (() => { try { return (JSON.parse(readFileSync(join(pkgDir, "pocketbase-panel.json"), "utf8")) as { version: string }).version; } catch { return process.env.POCKETBASE_PANEL_VERSION ?? "0.40.2"; } })();
      const migrations: Record<string, string> = {};
      for (const f of readdirSync(join(pkgDir, "db/migrations")).filter((f) => f.endsWith(".sql")).sort()) migrations[f] = readFileSync(join(pkgDir, "db/migrations", f), "utf8");
      writeFileSync(embeddedPath, JSON.stringify({ version, migrations, typesDts: readFileSync(join(pkgDir, "types/pb_data.d.ts"), "utf8"), panel: { version: panelVersion, zipBase64: b64(zipSync(panel)) } }));
    }
    writeFileSync(projectPath, JSON.stringify({ id, files }));
    log(`compiling ${relative(dir, entry)} with ${Object.keys(files).length} project file(s) (${PROJECT_FOLDERS.filter((f) => existsSync(join(dir, f))).join(", ") || "no pb_ folders"})`);
    // process.execPath is Bun, or the voidbase executable acting as Bun (BUN_BE_BUN, set by the toolchain re-exec). Bun
    // compiles onto the binary it is running as, and a binary compiled onto the voidbase executable crashed on start (a
    // segmentation fault in Bun, voidbase-stories b-binary-extended.feature: "Building the project into one binary"); a
    // `--target` matching the host still used the running binary. From the executable the build is given a plain Bun of
    // the same version to compile onto (src/node/bun-runtime.ts). The executable is told by the runtime's own name, since it
    // hands this command to its unpacked toolchain, where nothing embedded is visible.
    const onto = compilesOntoExecutable(process.execPath) ? [`--compile-executable-path=${await (await import("./bun-runtime")).ensureBun()}`] : [];
    const r = Bun.spawnSync([process.execPath, "build", "--compile", ...onto, entry, "--outfile", outfile], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_BE_BUN: "1" } });
    if (r.exitCode !== 0) throw new Error(`bun build --compile failed:\n${new TextDecoder().decode(r.stderr) || new TextDecoder().decode(r.stdout)}`);
  } finally {
    rmSync(projectPath, { force: true });
    if (!hadEmbedded) rmSync(embeddedPath, { force: true });
    if (link) unlinkSync(link);
    for (const d of made) rmdirSync(d);
  }
  return { outfile, files: Object.keys(files).length, bytes: statSync(outfile).size };
}
