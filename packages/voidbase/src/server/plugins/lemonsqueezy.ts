// `@voidbase-cloud/voidbase/plugins/lemonsqueezy`, a re-export of `@voidbase-cloud/plugin-lemonsqueezy` since 3.7.
//
// The plugin moved out of the core; this entry stays where it was, published under the same name. A marketplace
// bundle is audited, bundled and hashed against the names it imports and is then immutable, so a bundle that imports
// this name goes on importing it for as long as the bundle exists. app.ts loads the plugin through this file, which
// is the path a bundle takes too, so both get the same object.
//
// `export *` and not a list: the knob names, the signature helpers and the provider factory are this module's
// published surface, and the unit suites import them through this path.
export * from "@voidbase-cloud/plugin-lemonsqueezy";
