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

## What is not built

There is nothing to install. `pb_plugins/`, `voidbase plugins add`, the lockfile, the registry and the marketplace
are proposals on the site, not code; the set of plugins an instance runs is the list in `app.ts`. Auth, the
first core plugin, is still built in, which is why `CORE` is empty.
