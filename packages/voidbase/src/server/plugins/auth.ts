// `@voidbase-cloud/voidbase/plugins/auth`, a re-export of `@voidbase-cloud/plugin-auth` since 3.7.
//
// The plugin moved out of the core; this entry stays where it was, published under the same name. A marketplace
// bundle is audited, bundled and hashed against the names it imports and is then immutable, so a bundle that imports
// this name goes on importing it for as long as the bundle exists. app.ts loads the plugin through this file, which
// is the path a bundle takes too, so both get the same object and the same `auth@1` provider.
//
// `export *` and not a list: `provider` and the plugin are this module's published surface, and the unit suites
// import them through this path.
//
// Since the plugin packages became pb_ files plugins, the package is `manifest.json` beside `main.js`, loaded as it
// is: `main.js` exports what the plugin does and the manifest stays a file, the way an instance reads any installed
// plugin. This entry puts the two together into the one plugin object app.ts loads and a bundle imports by name.
import behaviour from "@voidbase-cloud/plugin-auth";
import declared from "@voidbase-cloud/plugin-auth/manifest.json" with { type: "json" };
import type { Plugin, PluginManifest } from "./manifest";

export * from "@voidbase-cloud/plugin-auth";
export const auth: Plugin = Object.assign(behaviour, { manifest: declared as PluginManifest });
