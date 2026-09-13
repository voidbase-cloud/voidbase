# @voidbase-cloud/plugin-commerce

The commerce plugin of [voidbase](https://github.com/voidbase-cloud/voidbase), as a package of its own: products and
variants, inventory, carts, orders, tax and shipping totals, fulfilment, refunds and an audit trail. It provides
`commerce@1` and requires `payments@1`, `tax@1` and `shipping@1`, never a particular plugin behind them.

It is a tier 2 plugin (decision 9): core defines the interfaces and the plugin is added by hand. Until tier 2 plugins
have their way into an instance, `@voidbase-cloud/voidbase` still depends on this package and loads it, idle unless
`VOIDBASE_COMMERCE` is on. Added to an instance where nothing provides one of its interfaces, it loads and waits.

## The shape

- **It requires interfaces rather than plugins.** Checkout is the payment provider's, rates are the shipping
  provider's, tax is the tax provider's; this package learns a payment landed through `onPaymentWritten` in
  `@voidbase-cloud/voidbase/plugins/payments-shared`.
- **It imports the core by name and only by name**: `/platform`, `/sdk`, `/types`, `/interfaces`, `/kernel`,
  `/plugins`, `/plugins/collections` and `/plugins/payments-shared`, plus `hono` at the core's own range.
- **`@voidbase-cloud/voidbase/plugins/commerce` stays published**, as a re-export of this package.

The rest of the shape is the template `packages/plugin-realtime/README.md` describes, and
`packages/voidbase/test/unit/plugin-extraction.test.ts` asserts it over every `@voidbase-cloud/plugin-*` package.

## Licence

MIT, with voidbase.
