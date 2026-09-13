// tax-flat, a tier 2 plugin, as the tests load it. The core defines the interface it implements and does not import
// it (voidbase-stories plugin-kinds.feature), so a test puts the package's behaviour and its manifest.json together
// itself, the way an instance does for an installed pb_ files plugin (src/platform/node/plugins.ts).
import behaviour from "@voidbase-cloud/plugin-tax-flat";
import declared from "@voidbase-cloud/plugin-tax-flat/manifest.json" with { type: "json" };
import type { Plugin, PluginManifest } from "../../../src/server/plugins/manifest";

export * from "@voidbase-cloud/plugin-tax-flat";
export const taxFlat = Object.assign(behaviour, { manifest: declared as PluginManifest }) as typeof behaviour & Plugin;
