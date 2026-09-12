# @voidbase-cloud/plugin-realtime

The realtime plugin of [voidbase](https://github.com/voidbase-cloud/voidbase), as a package of its own. It provides
`realtime@1`: `realtimeFor(env)`, the hub client for the bindings a request arrived with, or the client that says
realtime is off when the instance has no `HUB`.

It ships with voidbase and is on by default — `@voidbase-cloud/voidbase` depends on this package and loads it —
so an instance needs nothing here. Install it yourself only to load it into an app that builds its own plugin
graph.

## The shape

Twenty-three lines, one interface, no routes. It is deliberately the smallest plugin in the tree, because it is the
first one extracted and its shape is the template for the rest:

- **It imports the core by name and only by name.** `@voidbase-cloud/voidbase/realtime-client`, `/interfaces`,
  `/kernel`, `/plugins` — the entry points published in 7.2. A relative path out of this directory would land in
  the consumer's `node_modules`, and `#platform/*` is package-private and resolves to nothing from here.
- **It peer-depends on the core; the core depends on it.** That pair is a cycle only if a peer edge is read as
  publish order, which `scripts/publish.ts` deliberately does not do (`ORDER_MAPS`): npm does not resolve peers at
  publish time. The release publishes this package first and the core second.
- **It is in lockstep with the core.** Every published package in the workspace carries one version, which is what
  lets the core name this package at an exact version and this package name the core back — an exact version and
  not a range, because the pair can only ever move together and a range would claim pairs nobody built.
- **`hono` is the other peer.** It is the one name besides `@voidbase-cloud/voidbase/*` a plugin may import, and a
  plugin with routes puts them on the core's own Hono app, so the two have to be holding the same copy. Realtime
  has no routes and does not import it; it is declared because this manifest is the template for the rest.
- **It is published to npm and nowhere else.** On GitHub Packages this name belongs to a different package —
  `voidbase-cloud/voidbase-plugin-realtime`, the standalone repository the marketplace lists — so the release
  refuses to mirror it there (`NEVER_MIRROR` in `scripts/publish.ts`).
- **The core keeps `@voidbase-cloud/voidbase/plugins/realtime` forever**, as a re-export of this package. A
  marketplace bundle is audited, bundled and hashed against the names it imports, and those bundles are immutable.
  The core loads the plugin through that entry rather than reaching past it to this package, so the path a bundle
  takes is the path every instance takes.

## Type-checking a plugin package

`tsconfig.json` here is the template too. `"customConditions": ["workerd"]` is what a plugin resolves under when it
is built into a Worker, which is the flavour that fails first. `"types"` names `@cloudflare/workers-types` and
`node`: the core's published sources are TypeScript, so they join this package's program, and the last fallback in
`response-policy.ts` reads `process.env` — nodejs_compat's `process` on Workers. `@types/node` arrives with the
toolchain (`@types/bun` at the workspace root), the same way it does for the core's own two configs.

It is in `files` and therefore in the tarball: `scripts.check` names it, and a published manifest that names a file
its own tarball does not hold is a manifest lying about itself. Running that script needs the repository's
toolchain, so it is the workspace's command, not a consumer's.

## Licence

MIT, with voidbase.
