# @voidbase-cloud/plugin-tax-flat

The flat-rate tax plugin of [voidbase](https://github.com/voidbase-cloud/voidbase), as a package of its own. It
provides `tax@1`: one percentage, `VOIDBASE_TAX_RATE`, on the order's subtotal, as one line labelled with the rate.
Unset or zero is a shop that charges no tax, which is a valid shop and not an error.

It ships with voidbase and is on by default — `@voidbase-cloud/voidbase` depends on this package and loads it —
so an instance needs nothing here. Install it yourself only to load it into an app that builds its own plugin
graph.

## The shape

- **It is the default behind an interface, not the behaviour itself.** `commerce` requires `tax@1`, not this
  plugin. A shop that owes VAT per country, or that has to call Avalara or TaxJar, installs something else that
  provides `tax@1`, and commerce never learns that anything changed.
- **The rounding is the part worth reading.** Amounts are integers in the currency's minor unit, and the rate is
  applied to the subtotal, half away from zero — rounding each line and adding them up is how a total ends up a
  penny away from what the customer was shown.
- **It imports the core by name and only by name**: `@voidbase-cloud/voidbase/platform` (the `#platform/env` pick,
  both conditions kept), `/types`, `/interfaces`, `/kernel` and `/plugins`. No new entry point.
- **`@voidbase-cloud/voidbase/plugins/tax-flat` stays published forever**, as a re-export of this package.

The rest of the shape — the lockstep version, the peer edge back on the core, `hono` declared at the core's own
range, npm as the only registry this name is published to — is the template `packages/plugin-realtime/README.md`
describes, and `packages/voidbase/test/unit/plugin-extraction.test.ts` asserts it over every
`@voidbase-cloud/plugin-*` package in the workspace rather than over any one of them.

## Licence

MIT, with voidbase.
