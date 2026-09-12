// `@voidbase-cloud/voidbase/plugins/seo`, which since 7.7 is a re-export of `@voidbase-cloud/plugin-seo`.
//
// The plugin itself moved out of the core; this entry stays where it was, published under the same name, forever. A
// marketplace bundle is audited, bundled and hashed against the names it imports and is then immutable, so a bundle
// that imports this name goes on importing it for as long as the bundle exists.
//
// Two of seo's own modules stayed behind, and are published for the package rather than moved with it, because the
// core reads them itself: `seo-paths` holds the knob names and the redirect lines that hooks-plugin.ts,
// src/node/bundle.ts, src/node/deploy-cf.ts and src/adapter/seo-redirects.ts write into a deploy, and `seo-locales`
// holds the locale maths src/adapter/locales.ts shares with the share card. `seo-meta`, which nothing outside the
// plugin reads, went with it as `src/meta.ts`.
export * from "@voidbase-cloud/plugin-seo";
