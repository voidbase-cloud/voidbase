// `@voidbase-cloud/voidbase/plugins/openapi`, which since 7.7 is a re-export of `@voidbase-cloud/plugin-openapi`.
//
// The plugin itself moved out of the core; this entry stays where it was, published under the same name, forever. A
// marketplace bundle is audited, bundled and hashed against the names it imports and is then immutable, so a bundle
// that imports this name goes on importing it for as long as the bundle exists.
//
// The two plugins built on the document -- mcp and ai -- do NOT read it through here. They depend on
// `@voidbase-cloud/plugin-openapi` directly, because that is the package whose types and functions they use, and a
// hop through the core would put the core's own module in their closure for nothing.
//
// app.ts loads the plugin through this file rather than reaching past it to the package, which is the point: the
// path a marketplace bundle takes is the path every instance takes. It is a re-export and not an alias, so the
// `openapi` a bundle imports here is the same object the core loaded -- one plugin, one document.
export * from "@voidbase-cloud/plugin-openapi";
