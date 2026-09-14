// The project a deploy generates (<consumer>/.cloud/<slug>) resolves `vite`, `void` and this package by walking up to a
// node_modules. From npm that is the consumer's own; from the prebuilt executable there is none, because the toolchain
// lives in the executable's cache (src/node/toolchain.ts), so Void's env-schema probe and `vite build` could not load
// the project's vite.config.ts (voidbase-stories b-binary-extended.feature, "Deploying to the cloud"). Such a project
// gets a link to the toolchain's node_modules; one that already resolves `vite` is left as it is.
import { existsSync, lstatSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * whether a node_modules on the way up from `dir` holds vite. Looked for on disk rather than with Bun.resolveSync: with
 * no node_modules above, Bun resolves a bare name from its global install cache, which Vite's config loader never sees
 */
export function hasViteAbove(dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, "node_modules", "vite", "package.json"))) return true;
    if (dirname(d) === d) return false;
  }
}

/** link `modules` into `project` as its node_modules when the project cannot resolve vite; whether a link was made */
export function linkToolchainModules(project: string, modules: string): boolean {
  if (hasViteAbove(project)) return false;
  const link = join(project, "node_modules");
  try { lstatSync(link); return false; } catch { /* no entry there yet */ }
  symlinkSync(modules, link, process.platform === "win32" ? "junction" : "dir");
  return true;
}
