// `voidbase serve --entry index.ts`: an extended project's own entry file, run by this process. The entry imports
// `@voidbase-cloud/voidbase` and hands it the pb_ folders. A project that installed the package resolves the name
// itself; one that has only the voidbase binary has no node_modules to resolve it from, so the name, and every entry
// point the package publishes, is mapped to the modules this process is made of. That is what lets the binary be
// extended with nothing installed, and it is the same library the npm package is.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** whether `dir` can resolve the package on its own (an npm project), rather than needing this process's copy */
function resolvesItself(dir: string): boolean {
  try { Bun.resolveSync("@voidbase-cloud/voidbase", dir); return true; } catch { return false; }
}

export async function runEntry(file: string, args: string[] = []): Promise<void> {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`no entry file at ${path}`);
  if (!resolvesItself(dirname(path))) {
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
