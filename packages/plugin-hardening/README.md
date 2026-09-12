# @voidbase-cloud/plugin-hardening

The hardening plugin of [voidbase](https://github.com/voidbase-cloud/voidbase), as a package of its own. It provides
`hardening@1`: PocketBase's body limit and its rate limit rules, and the response policy — the headers on every
response, the files' `Content-Security-Policy`, CORS and the CSRF check — plus `GET /api/csrf`, the double-submit
token.

It ships with voidbase and is on by default — `@voidbase-cloud/voidbase` depends on this package and loads it —
so an instance needs nothing here. Install it yourself only to load it into an app that builds its own plugin
graph.

## The shape

- **It provides middleware rather than mounting it.** Hono composes handlers in the order they were registered and
  the kernel loads after the routes are mounted, so a `use("*")` from a plugin would sit behind every route and
  never run. The three handlers are provided as `hardening@1`; the core holds their place in the chain with slots
  that ask the provider per request. Turn this plugin off and the limits and the policy go with it, CORS included;
  provide `hardening@1` from another plugin and yours runs instead.
- **The one route is a route because it hands something back.** `GET /api/csrf` is mounted whatever the knob says
  and answers 404 while it is off: the knob is read per request, the routes are fixed when the app is built.
- **It imports the core by name and only by name**: `@voidbase-cloud/voidbase/hardening-middleware` (the five calls
  this plugin makes, published for it in 7.2 — not the three core modules behind them), `/interfaces`, `/kernel`
  and `/plugins`.
- **`@voidbase-cloud/voidbase/plugins/hardening` stays published forever**, as a re-export of this package.

The rest of the shape — the lockstep version, the peer edge back on the core, `hono` declared at the core's own
range, npm as the only registry this name is published to — is the template `packages/plugin-realtime/README.md`
describes, and `packages/voidbase/test/unit/plugin-extraction.test.ts` asserts it over every
`@voidbase-cloud/plugin-*` package in the workspace rather than over any one of them.

## Licence

MIT, with voidbase.
