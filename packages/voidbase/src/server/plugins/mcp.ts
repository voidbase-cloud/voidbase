// `@voidbase-cloud/voidbase/plugins/mcp`, which since 7.7 is a re-export of `@voidbase-cloud/plugin-mcp`.
//
// The plugin itself moved out of the core; this entry stays where it was, published under the same name, forever. A
// marketplace bundle is audited, bundled and hashed against the names it imports and is then immutable, so a bundle
// that imports this name goes on importing it for as long as the bundle exists.
//
// The ai plugin reads `defaultSource`, `documentFor`, `runTool` and `toolsOf` from `@voidbase-cloud/plugin-mcp`
// rather than from here, for the same reason this package reads openapi's from its package: the package is what it
// uses, and the hop through the core would only add the core's own module to its closure.
export * from "@voidbase-cloud/plugin-mcp";
