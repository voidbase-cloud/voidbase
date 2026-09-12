// `@voidbase-cloud/voidbase/plugins/translations`, a re-export of `@voidbase-cloud/plugin-translations` since 7.6.
//
// The plugin itself moved out of the core; this entry stays where it was, published under the same name, forever. A
// marketplace bundle is audited, bundled and hashed against the names it imports and is then immutable, so a bundle
// that imports this name goes on importing it for as long as the bundle exists.
//
// The package is the first extracted plugin that owns a collection, and it declares it the way any other plugin
// does: `ensureCollections` from `./collections`, which it imports by its published name
// `@voidbase-cloud/voidbase/plugins/collections`. That entry is not a plugin and does not move; it is how a plugin
// asks the instance for its own schema at bootstrap, and it is the one place in this phase where a plugin package
// imports a module that lives in this directory.
//
// app.ts loads the plugin through this file rather than reaching past it to the package, which is the point: the
// path a marketplace bundle takes is the path every instance takes. It is a re-export and not an alias, so the
// `translations` a bundle imports here is the same object the core loaded -- one plugin, one after-read seam.
export * from "@voidbase-cloud/plugin-translations";
