// pb_hooks on Bun, as the admin panel uploads into it on an instance that holds its own files: the folder
// `voidbase serve` loads hooks from (VOIDBASE_HOOKS_DIR). Hooks are loaded when the instance starts, so a written file
// takes effect on the next start. A binary squashed from an extended project carries its hooks, which are the
// project's, so it has none to change (src/server/public-files.ts is the same shape for pb_public).
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { publicPath, type PublicFiles } from "../server/public-files";

const root = () => resolve(process.env.VOIDBASE_HOOKS_DIR ?? "pb_hooks");

export const hookFiles: PublicFiles | null = process.env.VOIDBASE_PROJECT_BAKED ? null : {
  list() {
    const base = root(); const out: { path: string; size: number }[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir).sort()) {
        const file = join(dir, name); const s = statSync(file);
        if (s.isDirectory()) walk(file); else out.push({ path: relative(base, file).split("\\").join("/"), size: s.size });
      }
    };
    walk(base);
    return out;
  },
  write(path, bytes) {
    const rel = publicPath(path);
    if (!rel) throw new Error(`${JSON.stringify(path)} is not a path inside pb_hooks`);
    const file = join(root(), rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  },
};
