// `@voidbase-cloud/voidbase/plugins/hardening`, which since 7.6 is a re-export of `@voidbase-cloud/plugin-hardening`.
//
// The plugin itself moved out of the core; this entry stays where it was, published under the same name, forever. A
// marketplace bundle is audited, bundled and hashed against the names it imports and is then immutable, so a bundle
// that imports this name goes on importing it for as long as the bundle exists.
//
// The middleware did not move with the plugin, and could not: `../csrf.ts`, `../hardening.ts` and
// `../response-policy.ts` are the core's, read by files-api.ts, backups.ts and auth-response.ts as well. The package
// reaches the five calls the plugin makes through `/hardening-middleware`, the entry published for it.
//
// app.ts loads the plugin through this file rather than reaching past it to the package, which is the point: the
// path a marketplace bundle takes is the path every instance takes. It is a re-export and not an alias, so the
// `hardening` a bundle imports here is the same object the core loaded -- one plugin, one `hardening@1` provider,
// and the slots in app.ts's middleware chain find the handlers this one served.
//
// Since the plugin packages became pb_ files plugins, the package is `manifest.json` beside `main.js`, loaded as it
// is: `main.js` exports what the plugin does and the manifest stays a file, the way an instance reads any installed
// plugin. This entry puts the two together into the one plugin object app.ts loads and a bundle imports by name.
import behaviour from "@voidbase-cloud/plugin-hardening";
import declared from "@voidbase-cloud/plugin-hardening/manifest.json" with { type: "json" };
import type { Plugin, PluginManifest } from "./manifest";

export * from "@voidbase-cloud/plugin-hardening";
export const hardening: Plugin = Object.assign(behaviour, { manifest: declared as PluginManifest });
