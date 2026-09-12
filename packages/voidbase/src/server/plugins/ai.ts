// `@voidbase-cloud/voidbase/plugins/ai`, which since 7.7 is a re-export of `@voidbase-cloud/plugin-ai`.
//
// The plugin itself moved out of the core; this entry stays where it was, published under the same name, forever. A
// marketplace bundle is audited, bundled and hashed against the names it imports and is then immutable, so a bundle
// that imports this name goes on importing it for as long as the bundle exists.
//
// The package reads the tools it calls from `@voidbase-cloud/plugin-mcp` and the document's type from
// `@voidbase-cloud/plugin-openapi`, which is the chain this plugin sits at the end of: openapi writes the document,
// mcp turns it into tools, this answers with them. The release publishes them in that order.
export * from "@voidbase-cloud/plugin-ai";
