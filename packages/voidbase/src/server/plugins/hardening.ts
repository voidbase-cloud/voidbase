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
export * from "@voidbase-cloud/plugin-hardening";
