# @voidbase-cloud/plugin-stripe

The stripe plugin of [voidbase](https://github.com/voidbase-cloud/voidbase), as a package of its own. Taking money through Stripe: provides payments@1 with Stripe's REST API, its signed webhooks and the shared payment rows.

It is a tier 2 plugin (decision 9): core defines `payments@1` and the plugin is added by hand. Until the packages
that give a tier 2 plugin its way into an instance exist, `@voidbase-cloud/voidbase` still depends on this package
and loads it, so an instance needs nothing here.

## The shape

- **It is one provider of an interface, not the payments feature.** `commerce` and the app require `payments@1`,
  not this plugin; what every provider shares (the collections, the rows, the routes) stays in the core, published
  as `@voidbase-cloud/voidbase/plugins/payments-shared`.
- **It imports the core by name and only by name**: `/sdk`, `/interfaces`, `/types`, `/plugins` and
  `/plugins/payments-shared`. No new entry point.
- **`@voidbase-cloud/voidbase/plugins/stripe` stays published**, as a re-export of this package.

The rest of the shape is the template `packages/plugin-realtime/README.md` describes, and
`packages/voidbase/test/unit/plugin-extraction.test.ts` asserts it over every `@voidbase-cloud/plugin-*` package.

## Licence

MIT, with voidbase.
