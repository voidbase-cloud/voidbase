// An extended project squashed into one binary (`voidbase build --compile`, ./compile-project.ts) carries its pb_
// folders and voidbase.lock inside it. Everything that reads them reads a directory: the hooks and migrations are
// compiled from one, a plugin bundle is imported from a file, pb_public is served from one. So the files are written
// out once, under the cache and named by their content, and each folder the instance asks for is that copy whenever
// the folder is not on disk where the binary runs. A folder that is on disk wins, which is how a squashed binary is
// still pointed at other pb_ folders by flag.
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** what ./compile-project.ts writes to project-files.generated.json: an id from the content, files by relative path */
export interface BakedProject { id: string; files: Record<string, string> }

let cached: string | null | undefined;

/** where this binary's baked project is on disk, written out on first use, or null when it carries none */
export async function bakedProjectDir(): Promise<string | null> {
  if (cached !== undefined) return cached;
  let baked: BakedProject | null = null;
  // the file exists only while a project is being compiled; everything else runs without it
  // @ts-ignore
  try { baked = ((await import("./project-files.generated.json", { with: { type: "json" } })) as { default: BakedProject }).default; } catch { baked = null; }
  if (!baked?.id) return (cached = null);
  const root = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "voidbase", "project", baked.id);
  if (!existsSync(join(root, ".ready"))) {
    const tmp = `${root}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    for (const [rel, b64] of Object.entries(baked.files)) {
      const file = join(tmp, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(b64, "base64"));
    }
    writeFileSync(join(tmp, ".ready"), "");
    rmSync(root, { recursive: true, force: true });
    renameSync(tmp, root);
  }
  return (cached = root);
}

/** the folder `path` names: the one on disk when it is there, otherwise the copy baked into this binary */
export function projectFolder(path: string, baked: string | null): string {
  const onDisk = resolve(path);
  if (!baked || existsSync(onDisk)) return onDisk;
  const inside = join(baked, basename(onDisk));
  return existsSync(inside) ? inside : onDisk;
}
