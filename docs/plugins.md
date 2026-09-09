# The plugin kernel: what exists, what a plugin is, what is not built

voidbase composes its server from plugins over [cordis](https://github.com/cordiverse/cordis) (MIT, see NOTICE).
This is the state of it inside the package; the user-facing design and the install story are on the site
(`/docs/plugins`, the roadmap, and the "Plugins" section of the run docs), and `plan.md` in this repository is the
working plan. What is here is what a contributor needs to touch it.

## The pieces

| File | What it is |
| --- | --- |
| `src/server/kernel.ts` | the composition root: `createKernel(app)`, `load(kernel, plugins, VERSION)`, `serve()` / `using()` for interfaces, `whatLoaded()`. May import only cordis, hono, the platform log, its own types and the manifest/resolver; `test/unit/kernel-invariant.test.ts` fails when a feature leaks in. |
| `src/server/plugins/manifest.ts` | the manifest format (`name`, `version`, `tier`, `voidbase` range, `provides`, `requires`, `collections`, `extends`) and `checkManifest()`. Data only. |
| `src/server/plugins/resolve.ts` | the whole graph checked before a single plugin is applied: unknown interface names, version ranges, two providers of one interface, collection ownership, missing requirements, cycles. Everything wrong is reported at once. |
| `src/server/interfaces/index.ts` | the interfaces a plugin may provide or require, versioned in the name (`auth@1`, `payments@1`, `realtime@1`, `hardening@1`, `mail@1`) and the closed `KNOWN` list. |
| `src/server/plugins/*.ts` | the plugins voidbase ships with today: `backups`, `realtime`, `hardening`. |
| `GET /api/plugins` | what this instance loaded: names, providers, tiers, and any core interface nobody provides. Superuser only. |

## The entry points a plugin package uses

The package exposes the plugin API and the plugins it ships, so a plugin can live in its own package and be typed
against this voidbase: `@voidbase-cloud/voidbase/kernel` (`createKernel`, `load`, `serve`, `using`, `whatLoaded`,
`Kernel`), `@voidbase-cloud/voidbase/plugins` (`Plugin`, `PluginManifest`, `checkManifest`),
`@voidbase-cloud/voidbase/interfaces` (the interface types and `KNOWN`), and `@voidbase-cloud/voidbase/plugins/backups`,
`/plugins/realtime`, `/plugins/hardening` (the shipped plugin objects). `test/unit/plugin-entry-points.test.ts` keeps
the map honest. The official plugin packages (`@voidbase-cloud/plugin-*`, one repository each) re-export the shipped
objects through these entry points: the code lives here once, and the package is the plugin's name, manifest and
version as the marketplace lists it.

## What a plugin is

```ts
import type { Plugin } from "./manifest";

export const backups: Plugin = {
  manifest: { name: "backups", version: "0.1.0", tier: "official", voidbase: "*" },
  apply(ctx) { mountBackupsApi(ctx.app); },
};
```

`apply(ctx)` receives the kernel: `ctx.app` is the Hono app, `serve(ctx, "payments@1", impl)` provides an
interface from this plugin's own fiber, and `using<T>(ctx, "auth@1")` reads one. A plugin that lists an interface
in `requires` is applied only once a provider exists, and cordis tears it down when that provider goes and
re-applies it when a replacement arrives (measured in `test/unit/plugins.test.ts`).

The tiers are `core` (the instance is not usable without a provider; the `CORE` list in `resolve.ts` is empty
until something actually leaves the core, so no instance warns today), `official` (ours, versioned with voidbase,
opt-in) and `community`.

## The three shapes a feature has taken so far

- **Routes.** `backups` mounts its API on `ctx.app`. Plugins load at module scope under top-level `await` in
  `app.ts`, after the built-in routes and before `pb_hooks` routes, because Hono's default router refuses routes once
  it has matched and cordis applies a plugin on a later tick.
- **A factory over the request's bindings.** `realtime` provides `realtime@1` as `for(env): RealtimeClient`. On
  Workers the HUB binding arrives with each request and not once per isolate, so a service built at load time would
  hold nothing. The per-request middleware puts the client on the context (`c.get("realtime")`), and it answers
  `active()` so the write path knows whether a change has anywhere to go.
- **Middleware, through a slot.** `hardening` provides `hardening@1`, the body limit and the rate limit. Middleware
  runs in registration order and the kernel loads after the routes, so a plugin cannot `use("*")` for itself; instead
  `app.ts` keeps the two handlers' place in the chain with a slot that asks the provider at request time. No
  provider, no limits; another limiter is another provider.

## The rules

- The kernel imports no feature. If a plugin needs something the kernel has, the kernel gains a service; if the
  kernel needs something a plugin has, that is the bug.
- One interface, one provider, chosen on purpose: two providers of one interface is refused at load with both named,
  because cordis would otherwise keep the first silently.
- A cycle is refused with the circle printed, because cordis would otherwise wait forever with nothing thrown.
- A plugin names its voidbase range; a plugin that does not fit this version is refused before it runs.
- Every step is gated by `bun test` and the full conformance suite (`bun run ci`): a plugin change that breaks
  PocketBase compatibility has failed regardless of how clean the graph is.

## Installing

`voidbase plugins add <name>[@version]` installs a plugin from a marketplace (docs/registry.md): the bundle is
downloaded into `pb_plugins/<name>/bundle.js` with the marketplace's record beside it as `release.json`, its bytes are
verified against the integrity the marketplace promised, and `voidbase.lock` pins the marketplace, the version, the
integrity and the source commit. `plugins remove`, `plugins enable`, `plugins update` and `plugins ls` are the rest
of it (`bin/voidbase.ts`, `src/node/installed.ts`). The marketplaces a project uses are the lockfile's list (ours is
the default and can be removed) or `VOIDBASE_PLUGIN_MARKETPLACES`; one name served by two marketplaces is refused
until `--marketplace` says which, the same rule the loader applies to two providers of one interface.

An instance reads the same files when it starts. On Bun (`voidbase serve`, a local instance, the executable)
`src/platform/node/plugins.ts` verifies every bundle against the lockfile, refuses a changed byte by name, and imports
the bundles with their bare imports (`@voidbase-cloud/voidbase/*`, `hono`) resolved to the modules the process is
already running, which is what lets a bundle load inside the executable, where there is no node_modules. On Workers
`hooks-plugin.ts` generates `virtual:voidbase-plugins` at build time from the same verification, so a mismatch fails
the build rather than the instance. `app.ts` then loads what ships minus what the lockfile turned off minus what an
installed plugin shadows by name, plus the installed ones, as one graph, and `/api/plugins` says where each came
from (`origins`) and what is turned off.

Removing a shipped plugin turns it off for the project (`disabled` in the lockfile); installing one with a shipped
plugin's name replaces it. That, and the open registry protocol, is what keeps an instance free of our marketplace
and of our plugins. `voidbase update` names the installed plugins whose range excludes the target before it changes
anything.

## Cloud instances

A cloud instance's owner holds no filesystem, and the control plane is a Worker with no bun and no Vite, so the set
of plugins is fixed when the instance's Worker is built. Installing one is therefore a rebuild: the control plane
records the plugin set on the instance (`POST /api/vbcloud/instances/:id/plugins`) and queues a build;
`scripts/instance-build.ts`, run by the `instance-build` workflow every few minutes, claims the build
(`GET /api/vbcloud/builds/next`), installs the plugins with the instance's own released voidbase (checked out at its
tag, so the code is exactly the release's), verifies each bundle against the hash the control plane recorded, builds
a release with `voidbase bundle --plugins-dir`, pushes it without making it the default, and the control plane
re-provisions the instance from it (`POST /api/vbcloud/builds/:id/done`). An upgrade of an instance that has
plugins is the same build on the new base rather than a plain re-provision, which would drop them.

## What is not built

Auth, the first core plugin, is still built in, which is why `CORE` is empty. A marketplace's audit is a first pass
and not a sandbox: a bundle runs inside the instance with everything the instance has, the way `pb_hooks` does.
