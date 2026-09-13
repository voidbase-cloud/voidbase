// pb_public on Bun: the folder `voidbase serve` serves (VOIDBASE_PUBLIC_DIR, set by src/node/serve.ts), read and
// written where it is. The fetcher looks on every request (src/node/assets.ts), so a file written here is served by
// the next one. A binary squashed from an extended project carries its pb_public, which is the project's, so it has
// none to change (src/server/public-files.ts).
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { publicPath, type PublicFiles } from "../server/public-files";

const root = () => resolve(process.env.VOIDBASE_PUBLIC_DIR ?? "pb_public");

export const publicFiles: PublicFiles | null = process.env.VOIDBASE_PROJECT_BAKED ? null : {
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
    if (!rel) throw new Error(`${JSON.stringify(path)} is not a path inside pb_public`);
    const file = join(root(), rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  },
};
