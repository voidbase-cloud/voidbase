// `@voidbase-cloud/voidbase/plugins/observability`, a re-export of `@voidbase-cloud/plugin-observability` since 7.6.
//
// The plugin itself moved out of the core; this entry stays where it was, published under the same name, forever. A
// marketplace bundle is audited, bundled and hashed against the names it imports and is then immutable, so a bundle
// that imports this name goes on importing it for as long as the bundle exists.
//
// This is the second plugin of tier `core` and the only one of the nine 7.6 extracts, and core is a statement about
// what an instance is without it rather than about where the code lives: an instance you cannot see into is one you
// cannot operate. A package of its own does not weaken that -- the core depends on it, loads it through this file,
// and app.ts holds a place in its middleware chain for the `sample` it provides as `observability@1`.
//
// `./observability-binding.ts` stays here and is published as `/plugins/observability-binding` since 7.6: the names
// this plugin and src/node/deploy-cf.ts agree on, data so that the deploy can turn the Worker's own logs on and
// bake the knobs without importing what the plugin does.
//
// app.ts loads the plugin through this file rather than reaching past it to the package, which is the point: the
// path a marketplace bundle takes is the path every instance takes. It is a re-export and not an alias, so the
// `observability` a bundle imports here is the same object the core loaded -- one plugin, one sampler.
//
// Since the plugin packages became pb_ files plugins, the package is `manifest.json` beside `main.js`, loaded as it
// is: `main.js` exports what the plugin does and the manifest stays a file, the way an instance reads any installed
// plugin. This entry puts the two together into the one plugin object app.ts loads and a bundle imports by name.
import behaviour from "@voidbase-cloud/plugin-observability";
import { observabilityWith as behaviourWith } from "@voidbase-cloud/plugin-observability";
import declared from "@voidbase-cloud/plugin-observability/manifest.json" with { type: "json" };
import type { Plugin, PluginManifest } from "./manifest";

export * from "@voidbase-cloud/plugin-observability";
export const observability: Plugin = Object.assign(behaviour, { manifest: declared as PluginManifest });

/** the plugin with its dependencies swapped, for a test or an embedding: the package's factory, with the same manifest */
export const observabilityWith = (...args: Parameters<typeof behaviourWith>): Plugin => Object.assign(behaviourWith(...args), { manifest: declared as PluginManifest });
