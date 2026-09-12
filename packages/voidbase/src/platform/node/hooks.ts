// pb_hooks compiled at startup (the same transform the Vite plugin applies at build time) and imported as a module.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compileHooksDir } from "../../../hooks-plugin";
const dir = resolve(process.env.VOIDBASE_HOOKS_DIR ?? "pb_hooks");
export async function loadCompiled(code: string, tag: string) {
  const out = join(tmpdir(), "voidbase"); mkdirSync(out, { recursive: true });
  const file = join(out, `${tag}-${createHash("sha256").update(code).digest("hex").slice(0, 16)}.mjs`);
  writeFileSync(file, code);
  return import(pathToFileURL(file).href);
}
const mod = await loadCompiled(compileHooksDir(dir), "hooks");
export const hooksDir: string = mod.hooksDir;
export const hooks: { name: string; run: (globals: Record<string, unknown>) => Promise<void> }[] = mod.hooks;
export const modules: Record<string, (globals: Record<string, unknown>) => Promise<unknown>> = mod.modules;
export const files: Record<string, string> = mod.files;
