// `@voidbase-cloud/voidbase/plugins/previews`, which since 7.6 is a re-export of `@voidbase-cloud/plugin-previews`.
//
// The plugin itself moved out of the core; this entry stays where it was, published under the same name, forever. A
// marketplace bundle is audited, bundled and hashed against the names it imports and is then immutable, so a bundle
// that imports this name goes on importing it for as long as the bundle exists.
//
// Two of the core's own modules read it through this file rather than through the package, which is deliberate:
// src/node/plugins/previews.ts (the deploy-time half, which runs in the CLI against Cloudflare and GitHub) takes
// `PREVIEW_VAR`, `PREVIEW_OF_VAR`, `previewPrefix`, `previewWorkerName`, `branchHash`, `branchSlug` and the
// `PreviewShape` type from here, and src/node/deploy-cf.ts takes three of the same. The naming rule has to be one
// rule -- a preview the deploy names and the instance cannot recognise is a preview nobody can find -- and the
// entry is what keeps it one, inside this repository as much as for a bundle.
//
// app.ts loads the plugin through this file rather than reaching past it to the package, which is the point: the
// path a marketplace bundle takes is the path every instance takes. It is a re-export and not an alias, so the
// `previews` a bundle imports here is the same object the core loaded -- one plugin, one pair of routes.
export * from "@voidbase-cloud/plugin-previews";
