// `@voidbase-cloud/voidbase/plugins/mail`, which since 7.6 is a re-export of `@voidbase-cloud/plugin-mail`.
//
// The plugin itself moved out of the core; this entry stays where it was, published under the same name, forever. A
// marketplace bundle is audited, bundled and hashed against the names it imports and is then immutable, so a bundle
// that imports this name goes on importing it for as long as the bundle exists.
//
// The mail did not move with the carrier. `../mail/` still builds every message and decides when it goes -- the
// auth flows, the settings API and the OTP route all send through it -- and this plugin only answers for where a
// message can leave from. `./mail-binding.ts` stays here too, and is published as `/plugins/mail-binding` since 7.6: it is
// the two names the plugin and src/node/deploy-cf.ts agree on, and it is data so that the deploy can write the
// binding without importing what the plugin does.
//
// app.ts loads the plugin through this file rather than reaching past it to the package, which is the point: the
// path a marketplace bundle takes is the path every instance takes. It is a re-export and not an alias, so the
// `mail` a bundle imports here is the same object the core loaded -- one plugin, one `mail@1` provider.
export * from "@voidbase-cloud/plugin-mail";
