// `@voidbase-cloud/voidbase/plugins/realtime`, which since 7.5 is a re-export of `@voidbase-cloud/plugin-realtime`.
//
// The plugin itself moved out of the core; this entry stays where it was, published under the same name, forever. A
// marketplace bundle is audited, bundled and hashed against the names it imports and is then immutable, so a bundle
// that imports this name goes on importing it for as long as the bundle exists. Withdrawing the entry would break
// those installs at load on Bun and at build on Workers, over a module that is one line.
//
// app.ts loads the plugin through this file rather than reaching past it to the package, which is the point: the
// path a marketplace bundle takes is the path every instance takes, so a mistake in it stops a boot rather than
// waiting for somebody's bundle to find it. And it is a re-export and not an alias, so the `realtime` a bundle
// imports here is the same object the core loaded -- one plugin, one `realtime@1` registration, not a second copy
// of each.
export { realtime } from "@voidbase-cloud/plugin-realtime";
