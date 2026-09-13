// The Worker's view of pb_plugins: generated at build time by hooks-plugin.ts from voidbase.lock and the verified
// bundles (src/node/installed.ts, pluginsModuleSource). On Bun the same names come from src/platform/node/plugins.ts.
declare module "virtual:voidbase-plugins" {
  import type { Plugin } from "./manifest";
  /** `hooks` is a pb_ files plugin's compiled pb_hooks (3.6), from its own virtual:voidbase-plugin-hooks/<name> module */
  export const installed: { plugin: Plugin; name: string; version: string; marketplace: string; hooks?: import("../hooks").CompiledHooks }[];
  export const disabled: string[];
  /** pb_plugins/<name>/config.json as the build found them (./config.ts) */
  export const projectConfig: Record<string, Record<string, string | number | boolean>>;
}
