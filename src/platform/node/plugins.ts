// Installed plugins on Bun: pb_plugins read at startup, each bundle checked against voidbase.lock and imported.
//
// A bundle imports what an instance provides (voidbase's plugin entry points and hono) and nothing else. On Bun those
// imports resolve here, to the modules this process is already running, rather than through node_modules: that is
// what lets the same bundle load inside the standalone executable, which has no node_modules at all, and it means a
// plugin gets the instance's own hono and kernel rather than a second copy.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as hono from "hono";
import { lockPath, rootOfPluginsDir, verifyInstalled } from "../../node/installed";
import * as interfaces from "../../server/interfaces";
import * as kernel from "../../server/kernel";
import * as backups from "../../server/plugins/backups";
import * as hardening from "../../server/plugins/hardening";
import * as auth from "../../server/plugins/auth";
import * as collections from "../../server/plugins/collections";
import * as manifest from "../../server/plugins/manifest";
import * as realtime from "../../server/plugins/realtime";
import type { Plugin } from "../../server/plugins/manifest";

export interface InstalledPlugin { plugin: Plugin; name: string; version: string; marketplace: string }

/** the entry points a bundle may import, as the modules this process runs (package.json exports names the same set) */
const PROVIDED: Record<string, object> = {
  "@voidbase-cloud/voidbase/kernel": kernel,
  "@voidbase-cloud/voidbase/plugins": manifest,
  "@voidbase-cloud/voidbase/interfaces": interfaces,
  "@voidbase-cloud/voidbase/plugins/backups": backups,
  "@voidbase-cloud/voidbase/plugins/realtime": realtime,
  "@voidbase-cloud/voidbase/plugins/hardening": hardening,
  "@voidbase-cloud/voidbase/plugins/auth": auth,
  "@voidbase-cloud/voidbase/plugins/collections": collections,
  hono,
};
const PROVIDED_RE = /^(@voidbase-cloud\/voidbase|hono)(\/|$)/;

/**
 * Bare imports a bundle makes resolve to what this process runs. Bun's runtime plugins define virtual modules by
 * name (`build.module`), so each specifier a verified bundle imports is registered once, as the module already
 * loaded here; a hono subpath the instance has not loaded yet is imported on demand. Only specifiers an instance
 * provides are registered, and only when a bundle actually imports them.
 */
const provided = new Set<string>();
function provide(specifiers: string[]): void {
  const fresh = specifiers.filter((s) => PROVIDED_RE.test(s) && !provided.has(s));
  if (!fresh.length) return;
  for (const s of fresh) provided.add(s);
  Bun.plugin({
    name: "voidbase-provided",
    setup(b) {
      for (const spec of fresh) {
        b.module(spec, async () => {
          const m = PROVIDED[spec] ?? (spec.startsWith("hono/") ? ((await import(spec)) as object) : null);
          if (!m) throw new Error(`${spec} is not something an instance provides to a plugin`);
          return { exports: { ...m }, loader: "object" };
        });
      }
    },
  });
}

/** what a bundle imports, read without running it */
const importsOf = (file: string): string[] => new Bun.Transpiler({ loader: "js" }).scanImports(readFileSync(file, "utf8")).map((i) => i.path);

export async function loadInstalled(dir: string): Promise<{ installed: InstalledPlugin[]; disabled: string[] }> {
  const root = rootOfPluginsDir(dir);
  if (!existsSync(lockPath(root))) return { installed: [], disabled: [] };
  const { installed, disabled } = await verifyInstalled(root);
  for (const p of installed) {
    const foreign = importsOf(p.file).filter((i) => !PROVIDED_RE.test(i));
    if (foreign.length) throw new Error(`pb_plugins/${p.name}/bundle.js imports ${foreign.join(", ")}, which an instance does not provide`);
    provide(importsOf(p.file));
  }
  const out: InstalledPlugin[] = [];
  for (const p of installed) {
    const mod = (await import(pathToFileURL(p.file).href)) as { default?: Plugin };
    const plugin = mod.default;
    if (!plugin?.manifest || typeof plugin.apply !== "function") throw new Error(`pb_plugins/${p.name}/bundle.js does not export a plugin as its default export`);
    if (plugin.manifest.name !== p.name || plugin.manifest.version !== p.version) throw new Error(`pb_plugins/${p.name}/bundle.js says it is ${plugin.manifest.name} ${plugin.manifest.version}, and voidbase.lock says ${p.name} ${p.version}`);
    out.push({ plugin, name: p.name, version: p.version, marketplace: p.marketplace });
  }
  return { installed: out, disabled };
}

const loaded = await loadInstalled(resolve(process.env.VOIDBASE_PLUGINS_DIR ?? "pb_plugins"));
export const installed: InstalledPlugin[] = loaded.installed;
export const disabled: string[] = loaded.disabled;

// ---- the installer's view of the project on disk (src/server/plugins/installer.ts) --------------------------------
import { addPlugin, listPlugins, removePlugin, updatePlugins } from "../../node/installed";
import type { FilesystemInstaller } from "../../server/plugins/installer";
const projectRoot = rootOfPluginsDir(resolve(process.env.VOIDBASE_PLUGINS_DIR ?? "pb_plugins"));
export const filesystem: FilesystemInstaller = {
  root: projectRoot,
  list: () => { const l = listPlugins(projectRoot); return { installed: l.installed.map((p) => ({ name: p.name, version: p.version, marketplace: p.marketplace })), disabled: l.shipped.filter((p) => p.state !== "active").map((p) => p.name), marketplaces: l.marketplaces }; },
  add: (spec, o) => addPlugin(projectRoot, spec, o),
  remove: (name) => removePlugin(projectRoot, name),
  update: (name, o) => updatePlugins(projectRoot, name, o),
};
