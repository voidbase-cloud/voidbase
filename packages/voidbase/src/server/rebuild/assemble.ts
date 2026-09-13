// A new version of a vanilla instance, put together from its release and the plugins its admin panel declares, inside
// the instance (voidbase-stories vanilla-rebuild.feature: "The instance assembles itself", "There is nothing to compile").
//
// Nothing here compiles. A release built rebuildable (hooks-plugin.ts, VOIDBASE_REBUILDABLE) carries every name a plugin
// may import as a module of its own, `provided/voidbase/<entry>.js` and `provided/hono.js`, each re-exporting the chunks
// the core itself runs on, and its plugin list as one small chunk that `voidbase-plugins.js` names. A version is that
// release's modules with three changes:
//   the plugins chunk      replaced by one that imports each declared plugin, keeping the export names the core imports
//   plugins/<name>/...     each plugin's main.js and lib/, as the approved commit has them
//   their imports          `@voidbase-cloud/voidbase/<entry>` and `hono` pointed at the provided modules by relative path,
//                          which is how modules of one upload reach each other
// Everything runs where the instance runs: plain bytes in, plain bytes out, no filesystem and no Node.
import { integrityOf } from "../../node/registry";

/**
 * what a pb_ files plugin is made of: its declaration, the directories an instance reads, and the plain JavaScript
 * cordis applies (`main.js`, and the modules it imports from `lib/`), nothing else
 */
export const FILES_ENTRIES = ["manifest.json", "pb_hooks", "pb_migrations", "pb_public", "main.js", "lib"] as const;

export interface ModuleFile { type: "esm" | "wasm" | "data" | "text"; bytes: Uint8Array }
export interface PluginFiles { name: string; version: string; marketplace: string; files: Map<string, Uint8Array> }

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** a tar.gz as GitHub serves a commit: every regular file, its path without the top-level directory */
export async function untarGz(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  const tar = new Uint8Array(await new Response(stream).arrayBuffer());
  const text = (a: Uint8Array, from: number, len: number) => { const s = a.subarray(from, from + len); const end = s.indexOf(0); return decoder.decode(end < 0 ? s : s.subarray(0, end)); };
  const out = new Map<string, Uint8Array>();
  let long: string | null = null;
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(text(h, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(h[156]!);
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "g") continue; // pax global header: GitHub's commit comment
    if (type === "x") { const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(decoder.decode(data)); long = m ? m[1]! : long; continue; }
    if (type === "L") { long = text(data, 0, size); continue; }
    const prefix = text(h, 345, 155);
    const name = long ?? (prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100));
    long = null;
    if (type !== "0" && type !== "\0" && type !== "7") continue;
    const rel = name.split("/").slice(1).join("/");
    if (rel) out.set(rel, data.slice());
  }
  return out;
}

/** the files of a pb_ files plugin out of its repository's files, from `directory` when the repository holds more than one */
export function pluginFilesFrom(repo: Map<string, Uint8Array>, directory?: string): Map<string, Uint8Array> {
  const base = directory ? `${directory.replace(/^\/+|\/+$/g, "")}/` : "";
  const out = new Map<string, Uint8Array>();
  for (const [path, bytes] of repo) {
    if (!path.startsWith(base)) continue;
    const rel = path.slice(base.length);
    if (FILES_ENTRIES.some((e) => rel === e || rel.startsWith(`${e}/`))) out.set(rel, bytes);
  }
  return out;
}

/** one hash over a pb_ files plugin, the same as src/node/installed.ts integrityOfDir computes over the same files on disk */
export async function integrityOfFiles(files: Map<string, Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = [];
  for (const path of [...files.keys()].filter((p) => FILES_ENTRIES.some((e) => p === e || p.startsWith(`${e}/`))).sort()) {
    parts.push(encoder.encode(`${path}\0`), files.get(path)!, encoder.encode("\0"));
  }
  const all = new Uint8Array(parts.reduce((n, b) => n + b.length, 0)); let at = 0;
  for (const b of parts) { all.set(b, at); at += b.length; }
  return integrityOf(all);
}

/** `to` from the directory of the module at `from`, both paths inside one upload */
function relativeTo(from: string, to: string): string {
  const a = from.split("/").slice(0, -1); const b = to.split("/");
  let i = 0; while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  return `${up ? "../".repeat(up) : "./"}${b.slice(i).join("/")}`;
}

/**
 * A plugin module's imports, pointed at the modules of the upload: a relative import stays as it is (the plugin's own
 * lib/, checked to stay inside the plugin when it was installed), and a name an instance provides becomes the relative
 * path to its provided module. Anything else is refused with the reason, before anything is uploaded.
 */
export function rewriteImports(source: string, modulePath: string, has: (path: string) => boolean, plugin = "the plugin"): string {
  const target = (spec: string): string => {
    if (spec.startsWith(".")) return spec;
    const provided = spec === "hono" ? "provided/hono.js" : spec.startsWith("hono/") ? `provided/${spec}.js` : spec.startsWith("@voidbase-cloud/voidbase/") ? `provided/voidbase/${spec.slice("@voidbase-cloud/voidbase/".length)}.js` : null;
    if (!provided || !has(provided)) throw new Error(`${plugin}: ${modulePath} imports ${spec}, which this instance's release does not provide to a plugin`);
    return relativeTo(modulePath, provided);
  };
  return source
    .replace(/(\b(?:import|export)\b[^;"'`]*?\bfrom\s*)(["'])([^"'\n]+)\2/g, (_m, head: string, q: string, spec: string) => `${head}${q}${target(spec)}${q}`)
    .replace(/(\bimport\s*)(["'])([^"'\n]+)\2/g, (_m, head: string, q: string, spec: string) => `${head}${q}${target(spec)}${q}`)
    .replace(/(\bimport\s*\(\s*)(["'])([^"'\n]+)\2(\s*\))/g, (_m, head: string, q: string, spec: string, tail: string) => `${head}${q}${target(spec)}${q}${tail}`);
}

/** where the release keeps its plugin list: the chunk `voidbase-plugins.js` re-exports, and the names the core imports it by */
export function pluginsChunkOf(modules: Map<string, ModuleFile>): { path: string; exportsAs: { installed: string; disabled: string; projectConfig: string } } {
  const entry = modules.get("voidbase-plugins.js");
  if (!entry) throw new Error("this release was not built to be rebuilt: it has no voidbase-plugins.js (VOIDBASE_REBUILDABLE)");
  const m = /import\s*\{([^}]*)\}\s*from\s*["']\.\/([^"']+)["']/.exec(decoder.decode(entry.bytes));
  if (!m) throw new Error("voidbase-plugins.js does not re-export a plugins chunk");
  const names: Record<string, string> = {};
  for (const part of m[1]!.split(",")) { const [alias, as] = part.trim().split(/\s+as\s+/); if (alias && as) names[as] = alias; else if (alias) names[alias] = alias; }
  const exportsAs = { installed: names.installed!, disabled: names.disabled!, projectConfig: names.projectConfig! };
  if (!exportsAs.installed || !exportsAs.disabled || !exportsAs.projectConfig || !modules.has(m[2]!)) throw new Error("voidbase-plugins.js does not name the plugins chunk the core imports");
  return { path: m[2]!, exportsAs };
}

/** the release's modules with the declared plugins in them: what a rebuild uploads as the next version */
export function assemble(o: { release: Map<string, ModuleFile>; plugins: PluginFiles[]; disabled?: string[]; projectConfig?: Record<string, unknown> }): Map<string, ModuleFile> {
  const out = new Map(o.release);
  const chunk = pluginsChunkOf(o.release);
  const has = (p: string) => o.release.has(p);
  const imports: string[] = []; const entries: string[] = [];
  o.plugins.forEach((p, i) => {
    const manifestBytes = p.files.get("manifest.json");
    if (!manifestBytes) throw new Error(`${p.name} ${p.version} has no manifest.json, so it is not a pb_ files plugin`);
    const manifest = JSON.parse(decoder.decode(manifestBytes)) as { name?: string; version?: string };
    if (manifest.name !== p.name || manifest.version !== p.version) throw new Error(`${p.name} ${p.version}: its manifest.json says ${manifest.name} ${manifest.version}`);
    const compiled = [...p.files.keys()].find((f) => /^(pb_hooks|pb_migrations|pb_public)\//.test(f));
    if (compiled) throw new Error(`${p.name} ${p.version} carries ${compiled.split("/")[0]}, which a Worker build compiles or uploads as assets; a rebuild inside the instance runs neither, so it cannot take this plugin`);
    const base = `plugins/${p.name}`;
    for (const [path, bytes] of p.files) {
      if (path === "manifest.json") continue;
      if (!/\.m?js$/.test(path)) throw new Error(`${p.name} ${p.version}: ${path} is not JavaScript, and a plugin's main.js and lib/ are plain JavaScript`);
      const modulePath = `${base}/${path}`;
      out.set(modulePath, { type: "esm", bytes: encoder.encode(rewriteImports(decoder.decode(bytes), modulePath, has, `${p.name} ${p.version}`)) });
    }
    const common = `name: ${JSON.stringify(p.name)}, version: ${JSON.stringify(p.version)}, marketplace: ${JSON.stringify(p.marketplace)}, hooks: noHooks`;
    const declared = decoder.decode(manifestBytes).trim();
    if (p.files.has("main.js")) {
      imports.push(`import m${i} from ${JSON.stringify(relativeTo(chunk.path, `${base}/main.js`))};`);
      entries.push(`{ plugin: Object.assign(m${i}, { manifest: ${declared} }), ${common} }`);
    } else entries.push(`{ plugin: { manifest: ${declared} }, ${common} }`);
  });
  const source = [
    "//#region voidbase rebuild: the plugins this instance's admin panel declares (src/server/rebuild/assemble.ts)",
    ...imports,
    "const noHooks = { hooks: [], modules: {}, files: {}, routeDocs: [] };",
    `var installed = [${entries.join(", ")}];`,
    `var disabled = ${JSON.stringify(o.disabled ?? [])};`,
    `var projectConfig = ${JSON.stringify(o.projectConfig ?? {})};`,
    "//#endregion",
    `export { installed as ${chunk.exportsAs.installed}, projectConfig as ${chunk.exportsAs.projectConfig}, disabled as ${chunk.exportsAs.disabled} };`,
    "",
  ].join("\n");
  out.set(chunk.path, { type: "esm", bytes: encoder.encode(source) });
  return out;
}
