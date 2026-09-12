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
export * from "@voidbase-cloud/plugin-backups";
