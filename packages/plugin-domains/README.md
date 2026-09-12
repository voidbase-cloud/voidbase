# @voidbase-cloud/plugin-domains

The domains plugin of [voidbase](https://github.com/voidbase-cloud/voidbase), as a package of its own. It reports
where an instance answers: `VOIDBASE_DOMAINS`, the hostnames a deploy attached to the Worker, and
`VOIDBASE_CANONICAL_DOMAIN`, the one every other attached hostname redirects to.

It ships with voidbase and is on by default — `@voidbase-cloud/voidbase` depends on this package and loads it —
so an instance needs nothing here. Install it yourself only to load it into an app that builds its own plugin
graph.

## The shape

Twenty-eight lines, no interface, no routes, no collections: one `info()` that reads two vars. It is the first of
the nine leaf extractions (7.6) because it is the only shipped plugin whose whole reach into the core is the plugin
type and the runtime env, so it needed no new entry point and is the extraction with nothing else in it.

- **It imports the core by name and only by name**, the rule 7.5 set: `@voidbase-cloud/voidbase/platform` (the
  `#platform/env` pick, published under a name that resolves outside the core too, both conditions kept) and
  `@voidbase-cloud/voidbase/plugins` (the `Plugin` type).
- **Its deploy-time half stays in the core.** A deploy plugin runs inside `voidbase deploy`, in the CLI's process,
  and talks to the Cloudflare API; `src/node/plugins/domains.ts` is where the hostnames are attached, the
  certificate waited on and the redirect written, and it reads `DOMAINS_VAR` and `CANONICAL_DOMAIN_VAR` from here
  through `@voidbase-cloud/voidbase/plugins/domains`, the entry the core keeps.
- **`@voidbase-cloud/voidbase/plugins/domains` stays published forever**, as a re-export of this package: a
  marketplace bundle is audited, bundled and hashed against the names it imports, and those bundles are immutable.

The rest of the shape — the lockstep version, the peer edge back on the core, `hono` declared at the core's own
range, npm as the only registry this name is published to — is the template `packages/plugin-realtime/README.md`
describes, and `packages/voidbase/test/unit/plugin-extraction.test.ts` asserts it over every
`@voidbase-cloud/plugin-*` package in the workspace rather than over any one of them.

## Licence

MIT, with voidbase.
