// `@voidbase-cloud/voidbase/plugins/domains`, which since 7.6 is a re-export of `@voidbase-cloud/plugin-domains`.
//
// The plugin itself moved out of the core; this entry stays where it was, published under the same name, forever. A
// marketplace bundle is audited, bundled and hashed against the names it imports and is then immutable, so a bundle
// that imports this name goes on importing it for as long as the bundle exists.
//
// app.ts loads the plugin through this file rather than reaching past it to the package, which is the point: the
// path a marketplace bundle takes is the path every instance takes. It is a re-export and not an alias, so the
// `domains` a bundle imports here is the same object the core loaded -- one plugin, one entry in /api/plugins.
//
// `export *` rather than a list of names: src/node/plugins/domains.ts, the deploy-time half that stays in the core,
// reads `DOMAINS_VAR` and `CANONICAL_DOMAIN_VAR` through this file, and a list would have to be kept in step with
// the package's surface by hand.
export * from "@voidbase-cloud/plugin-domains";
