// The Worker's view of pb_plugins: generated at build time by hooks-plugin.ts from voidbase.lock and the verified
// bundles (src/node/installed.ts, pluginsModuleSource). On Bun the same names come from src/platform/node/plugins.ts.
declare module "virtual:voidbase-plugins" {
  import type { Plugin } from "./manifest";
  export const installed: { plugin: Plugin; name: string; version: string; marketplace: string }[];
  export const disabled: string[];
}
