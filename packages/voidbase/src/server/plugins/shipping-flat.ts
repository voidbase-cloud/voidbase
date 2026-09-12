// `@voidbase-cloud/voidbase/plugins/shipping-flat`, a re-export of `@voidbase-cloud/plugin-shipping-flat` since 7.6.
//
// The plugin itself moved out of the core; this entry stays where it was, published under the same name, forever. A
// marketplace bundle is audited, bundled and hashed against the names it imports and is then immutable, so a bundle
// that imports this name goes on importing it for as long as the bundle exists.
//
// app.ts loads the plugin through this file rather than reaching past it to the package, which is the point: the
// path a marketplace bundle takes is the path every instance takes. It is a re-export and not an alias, so the
// `shippingFlat` a bundle imports here is the same object the core loaded -- one plugin, one `shipping@1` provider,
// and the commerce plugin's `using(ctx, "shipping@1")` finds this one.
//
// `export *` and not a list: the knob names and `flatRates` are this module's published surface too, and
// test/unit/commerce.test.ts and the conformance suites import them through this path.
export * from "@voidbase-cloud/plugin-shipping-flat";
