// stripe, a tier 2 plugin, as the tests load it. The core defines the interface it implements and does not import
// it (voidbase-stories plugin-kinds.feature), so a test puts the package's behaviour and its manifest.json together
// itself, the way an instance does for an installed pb_ files plugin (src/platform/node/plugins.ts).
import behaviour from "@voidbase-cloud/plugin-stripe";
import { stripeWith as behaviourWith } from "@voidbase-cloud/plugin-stripe";
import declared from "@voidbase-cloud/plugin-stripe/manifest.json" with { type: "json" };
import type { Plugin, PluginManifest } from "../../../src/server/plugins/manifest";

export * from "@voidbase-cloud/plugin-stripe";
export const stripe = Object.assign(behaviour, { manifest: declared as PluginManifest }) as typeof behaviour & Plugin;
export const stripeWith = (...args: Parameters<typeof behaviourWith>) => Object.assign(behaviourWith(...args), { manifest: declared as PluginManifest }) as ReturnType<typeof behaviourWith> & Plugin;
