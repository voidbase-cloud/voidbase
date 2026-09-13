// lemonsqueezy, a tier 2 plugin, as the tests load it. The core defines the interface it implements and does not import
// it (voidbase-stories plugin-kinds.feature), so a test puts the package's behaviour and its manifest.json together
// itself, the way an instance does for an installed pb_ files plugin (src/platform/node/plugins.ts).
import behaviour from "@voidbase-cloud/plugin-lemonsqueezy";
import { lemonsqueezyWith as behaviourWith } from "@voidbase-cloud/plugin-lemonsqueezy";
import declared from "@voidbase-cloud/plugin-lemonsqueezy/manifest.json" with { type: "json" };
import type { Plugin, PluginManifest } from "../../../src/server/plugins/manifest";

export * from "@voidbase-cloud/plugin-lemonsqueezy";
export const lemonsqueezy = Object.assign(behaviour, { manifest: declared as PluginManifest }) as typeof behaviour & Plugin;
export const lemonsqueezyWith = (...args: Parameters<typeof behaviourWith>) => Object.assign(behaviourWith(...args), { manifest: declared as PluginManifest }) as ReturnType<typeof behaviourWith> & Plugin;
