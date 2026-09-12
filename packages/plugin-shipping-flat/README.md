# @voidbase-cloud/plugin-shipping-flat

The flat-rate shipping plugin of [voidbase](https://github.com/voidbase-cloud/voidbase), as a package of its own.
It provides `shipping@1`: one rate from two knobs — `VOIDBASE_SHIPPING_FLAT`, the amount in the currency's minor
unit, and `VOIDBASE_SHIPPING_FREE_OVER`, the subtotal at or above which that amount becomes zero. Neither set is a
shop that ships free, which is a working shop and not an error.

It ships with voidbase and is on by default — `@voidbase-cloud/voidbase` depends on this package and loads it —
so an instance needs nothing here. Install it yourself only to load it into an app that builds its own plugin
graph.

## The shape

- **It is the default behind an interface, not the behaviour itself.** `commerce` requires `shipping@1`, not this
  plugin. A shop that needs real rates installs something that calls EasyPost, Shippo or a carrier's own API, and
  commerce does not change — which is why this one can be small enough to read in a sitting.
- **It imports the core by name and only by name**: `@voidbase-cloud/voidbase/platform` (the `#platform/env` pick,
  both conditions kept), `/types`, `/interfaces`, `/kernel` and `/plugins`. No new entry point: every name it needs
  was published in 7.2.
- **`@voidbase-cloud/voidbase/plugins/shipping-flat` stays published forever**, as a re-export of this package.

The rest of the shape — the lockstep version, the peer edge back on the core, `hono` declared at the core's own
range, npm as the only registry this name is published to — is the template `packages/plugin-realtime/README.md`
describes, and `packages/voidbase/test/unit/plugin-extraction.test.ts` asserts it over every
`@voidbase-cloud/plugin-*` package in the workspace rather than over any one of them.

## Licence

MIT, with voidbase.
