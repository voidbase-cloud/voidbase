# @voidbase-cloud/plugin-observability

The observability plugin of [voidbase](https://github.com/voidbase-cloud/voidbase), as a package of its own. It is
tier `core`, for the reason the roadmap gives: an instance you cannot see into is one you cannot operate.

It ships with voidbase and is on by default — `@voidbase-cloud/voidbase` depends on this package and loads it —
so an instance needs nothing here. Install it yourself only to load it into an app that builds its own plugin
graph.

## The shape

Three things, and they are deliberately three rather than one.

- **The Worker's own logs, turned on at deploy.** `VOIDBASE_OBSERVABILITY` (on unless it says off) writes
  `observability: { enabled: true, head_sampling_rate: … }` into the generated config, so Workers Logs retains this
  Worker's logs without anybody asking. That half runs in `voidbase deploy` and stays in the core; the names the two
  halves agree on are `@voidbase-cloud/voidbase/plugins/observability-binding`, published in 7.6 when the plugin
  left the core and the sibling import that carried the agreement stopped resolving.
- **The request path, sampled.** This plugin provides `observability@1`, whose `sample` is middleware the core holds
  a place for — the kernel loads after the routes are mounted, so a plugin cannot `use("*")` for itself. One
  Analytics Engine data point per request when `LOGS_ANALYTICS` is bound: the *matched route* as a blob rather than
  the raw path, so ids do not explode the cardinality. Writing one never fails a request.
- **The numbers, behind the superuser.** `GET /api/observability/summary`, `/errors` and `/logs`. The summary
  queries Analytics Engine's SQL API when an account id and a token are set, and otherwise answers from the D1
  request log voidbase already keeps; the answer says which it used. That fallback is why the plugin is useful on an
  instance deployed without `--analytics`, which is every instance by default.

What is deliberately not here is hook CPU: Cloudflare freezes the clock inside a Worker, so any in-isolate timing
around a hook measures how long it waited for I/O rather than what it cost the CPU. `hooks` stays an optional field
of the summary that nothing fills, rather than a number that looks like an answer.

**`@voidbase-cloud/voidbase/plugins/observability` stays published forever**, as a re-export of this package. The
rest of the shape — the lockstep version, the peer edge back on the core, `hono` at the core's own range for the
three routes, npm as the only registry this name is published to — is the template
`packages/plugin-realtime/README.md` describes, and `packages/voidbase/test/unit/plugin-extraction.test.ts` asserts
it over every `@voidbase-cloud/plugin-*` package in the workspace rather than over any one of them.

## Licence

MIT, with voidbase.
