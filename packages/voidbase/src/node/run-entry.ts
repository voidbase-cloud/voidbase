// `voidbase serve --entry index.ts`: an extended project's own entry file, run by this process. The entry imports
// `@voidbase-cloud/voidbase` and hands it the pb_ folders. A project that installed the package resolves the name
// itself; one that has only the voidbase binary has no node_modules to resolve it from, so the name, and every entry
// point the package publishes, is mapped to the modules this process is made of. That is what lets the binary be
// extended with nothing installed, and it is the same library the npm package is.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The voidbase a project installed, found the way the bundler finds it (node_modules in the directory or above), or
 * null when it has none and needs this process's copy. Not Bun.resolveSync: with no node_modules at all, Bun
 * auto-installs, and would answer with a published version from its global cache.
 */
export function installedVoidbase(dir: string): string | null {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const pkg = join(d, "node_modules", "@voidbase-cloud", "voidbase");
    if (existsSync(join(pkg, "package.json"))) return realpathSync(pkg);
    if (dirname(d) === d) return null;
  }
}

export async function runEntry(file: string, args: string[] = []): Promise<void> {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`no entry file at ${path}`);
  if (!installedVoidbase(dirname(path))) {
    const { PROVIDED } = await import("./provided");
    const modules: Record<string, () => Promise<object>> = { ...PROVIDED, "@voidbase-cloud/voidbase": () => import("./index") };
    Bun.plugin({
      name: "voidbase-entry",
      setup(b) {
        for (const [spec, load] of Object.entries(modules)) b.module(spec, async () => ({ exports: { ...(await load()) }, loader: "object" }));
      },
    });
  }
  // the entry reads its own flags the way `bun index.ts --http ...` would hand them over
  process.argv = [process.argv[0]!, path, ...args];
  await import(path);
}
