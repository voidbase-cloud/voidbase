// `@voidbase-cloud/voidbase/plugins/tax-flat`, which since 7.6 is a re-export of `@voidbase-cloud/plugin-tax-flat`.
//
// The plugin itself moved out of the core; this entry stays where it was, published under the same name, forever. A
// marketplace bundle is audited, bundled and hashed against the names it imports and is then immutable, so a bundle
// that imports this name goes on importing it for as long as the bundle exists.
//
// app.ts loads the plugin through this file rather than reaching past it to the package, which is the point: the
// path a marketplace bundle takes is the path every instance takes. It is a re-export and not an alias, so the
// `taxFlat` a bundle imports here is the same object the core loaded -- one plugin, one `tax@1` provider, and the
// commerce plugin's `using(ctx, "tax@1")` finds this one.
//
// `export *` and not a list: `TAX_RATE_VAR`, `taxRate` and `taxQuote` are this module's published surface too, and
// test/unit/commerce.test.ts imports them through this path.
export * from "@voidbase-cloud/plugin-tax-flat";
