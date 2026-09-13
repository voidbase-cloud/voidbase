// `@voidbase-cloud/voidbase/plugins/backups`, which since 7.6 is a re-export of `@voidbase-cloud/plugin-backups`.
//
// The plugin itself moved out of the core; this entry stays where it was, published under the same name, forever. A
// marketplace bundle is audited, bundled and hashed against the names it imports and is then immutable, so a bundle
// that imports this name goes on importing it for as long as the bundle exists.
//
// The feature did not move with the plugin. `../backups.ts` still writes, verifies, prunes and restores the
// archives -- the scheduled job (crons.ts) and the CLI read it directly, and app.ts asks it whether backups are
// active -- and the plugin package reaches the one call it mounts through `/backups-api`, the entry published for
// it. What left the core is the manifest and the `apply()`, which is all the plugin ever was.
//
// app.ts loads the plugin through this file rather than reaching past it to the package, which is the point: the
// path a marketplace bundle takes is the path every instance takes. It is a re-export and not an alias, so the
// `backups` a bundle imports here is the same object the core loaded -- one plugin, one set of routes.
//
// Since the plugin packages became pb_ files plugins, the package is `manifest.json` beside `main.js`, loaded as it
// is: `main.js` exports what the plugin does and the manifest stays a file, the way an instance reads any installed
// plugin. This entry puts the two together into the one plugin object app.ts loads and a bundle imports by name.
import behaviour from "@voidbase-cloud/plugin-backups";
import declared from "@voidbase-cloud/plugin-backups/manifest.json" with { type: "json" };
import type { Plugin, PluginManifest } from "./manifest";

export * from "@voidbase-cloud/plugin-backups";
export const backups: Plugin = Object.assign(behaviour, { manifest: declared as PluginManifest });
