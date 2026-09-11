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
| `src/server/plugins/*.ts` | the plugins voidbase ships with today: `auth`, `realtime`, `hardening`, `backups`, `installer`, `openapi`, `mcp`. |
| `GET /api/plugins` | what this instance loaded: names, providers, tiers, and any core interface nobody provides. Superuser only. |

## The entry points a plugin package uses

The package exposes the plugin API and the plugins it ships, so a plugin can live in its own package and be typed
against this voidbase: `@voidbase-cloud/voidbase/kernel` (`createKernel`, `load`, `serve`, `using`, `whatLoaded`,
`Kernel`), `@voidbase-cloud/voidbase/plugins` (`Plugin`, `PluginManifest`, `checkManifest`),
`@voidbase-cloud/voidbase/interfaces` (the interface types and `KNOWN`), and `@voidbase-cloud/voidbase/plugins/backups`,
`/plugins/auth`, `/plugins/realtime`, `/plugins/hardening`, `/plugins/openapi`, `/plugins/mcp` (the shipped plugin objects). `test/unit/plugin-entry-points.test.ts` keeps
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

## Owning collections

A manifest names the collections a plugin owns (`collections`), which is what lets the loader refuse a second owner
at install. Owning one also means creating it: in `apply`, the plugin asks for the work to be done once per isolate
with the bindings, because `apply` runs at module scope and the database arrives with the request:

```ts
import { onBootstrap } from "@voidbase-cloud/voidbase/kernel";
import { ensureCollections } from "@voidbase-cloud/voidbase/plugins/collections";

const plugin = {
  manifest: { name: "shop", version: "1.0.0", tier: "community", voidbase: ">=0.9.0-beta.15", collections: ["orders"] },
  apply(ctx) {
    onBootstrap(ctx, (env) => ensureCollections(plugin, env.DB, [
      { name: "orders", type: "base", fields: [{ name: "total", type: "number" }] },
    ]));
    ctx.app.get("/api/shop/orders", ...);
  },
};
```

The definition is what `POST /api/collections` takes, and the collection is created through the same service the
panel uses, table and all, once, when it is missing. The kernel runs every plugin's bootstrap after voidbase's own
(the system collections, the settings row, the superuser), in load order, so a plugin that extends a collection
another one owns runs after the owner created it; a failure is retried by the next request. A name the manifest
does not own is refused before the database is touched. The auth plugin's five collections predate this: they are
system tables voidbase's own schema creates, and the manifest owns them so nothing else can.

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

## Changing an instance's plugins: the installer

`installer` is a shipped plugin, and it is how an instance changes its own plugins: `POST /api/plugins/install`
`{ name, version?, marketplace? }`, `POST /api/plugins/remove { name }`, `POST /api/plugins/update { name? }`,
and `GET /api/plugins/available?marketplace=` for what a marketplace serves (superusers, like `/api/plugins`, which
now says where the plugins live under `installer`). Three places they can live, and the installer knows which:

| mode | where | what a change is |
| --- | --- | --- |
| `filesystem` | Bun: `voidbase serve`, the executable | `pb_plugins/` and `voidbase.lock` changed in place, as the CLI does; the instance loads them when it restarts |
| `repository` | a project deployed from a repository: `VOIDBASE_PROJECT_REPO` (owner/name, `VOIDBASE_PROJECT_BRANCH` if not master) and `VOIDBASE_GH_TOKEN` on the Worker | one commit to the repository (`src/server/project-sync.ts`: the bundle downloaded and verified in the instance, `pb_plugins/<name>/{bundle.js,release.json}` written or deleted, the lockfile entry added or removed, through GitHub's Git Data API), which the repository's own build deploys |
| `fixed` | a Worker built without either | nothing: the answer says what to connect |

That is the whole cloud story. A cloud instance is the user's Worker in the user's account, deployed from a
repository in the user's GitHub by the user's own Workers Build; voidbase.cloud creates the repository from a
template, sets the two keys on the Worker, and its plugin page is a client of the instance's installer. Nothing is
built for an instance by anyone but its own pipeline. `voidbase-demo` is such a project, which is how the demo is the
live testbed for install, uninstall and update (`bun run live` in voidbase-site). An upgrade of voidbase on a project
instance is a change to the repository's dependency, not a re-provision.

## Describing the API: openapi

`openapi` is a shipped plugin (tier `official`, `src/server/plugins/openapi.ts`) that answers the roadmap's "a
description of the API, generated and scoped". Every instance knows its own shape, the collections, their fields and
the rules that decide who may read and write each one, and this puts that in a form other tools consume:

- `GET /api/openapi.json` is an OpenAPI 3.1 document generated at request time from the instance's collections,
  scoped to the token that asked. With no token it describes what an anonymous request may do; as a signed-in user,
  what that user may do; as a superuser, everything, the superuser-only operations and the system routes
  (`/api/collections`, `/api/settings`, `/api/logs`, `/api/backups`, `/api/plugins`) included. A collection's
  list, view, create, update and delete operations appear by their rule: the empty rule is public and appears for
  everyone; a rule with text needs a signed-in record to be judged against, so it appears for a signed-in caller with
  the rule quoted in the operation's description; a rule that is `null` is locked, superusers only. A view has no
  writes. Per collection the document carries the PocketBase record routes, a record schema built from the fields
  (`select` as an enum, `relation` as an id with its target collection in `x-collection`, `file` as a name,
  `autodate` read-only, `id`, `created`, `updated`, every answered field required since a record always carries
  all of them and only `expand` comes when asked for),
  the create and update bodies, the list shape (`page`, `perPage`, `totalItems`, `totalPages`, `items`) and the list
  query (`page`, `perPage`, `sort`, `filter`, `expand`, `fields`, `skipTotal`); an auth collection adds
  `auth-with-password`, `auth-methods` and, for a token of that collection, `auth-refresh`. `info.title` is the
  instance's name from its settings (`voidbase` when it has none), `servers[0].url` is the request's origin, and the
  security scheme is the `Authorization: <token>` header the PocketBase SDKs send. `info["x-voidbase"]` says which
  scope the document is, so a client can tell.
- `GET /api/docs` is Scalar's API reference over that document, loaded from
  `https://cdn.jsdelivr.net/npm/@scalar/api-reference` with no build step. The page says what the caller's token may
  call, and because a browser cannot put a token on the navigation that opens it, the page fetches the document
  itself with a token pasted into it (kept in `sessionStorage`), else the panel's session on the same origin, else
  none.

The plugin reads the collections and settings through the same functions the routes do, and takes a source of its own
for tests (`openapiWith({ collections, appName })`, `test/unit/openapi.test.ts`). Two things generate from this
document: the typed client, `voidbase types` (docs/setup.md), which fetches it as a superuser and writes the record
interfaces and the `TypedPocketBase` type from its schemas, so the client and the documentation cannot disagree; and
the stateless MCP server, the `mcp` plugin below, whose tools are derived from it.

## An agent's view of the instance: mcp

`mcp` is a shipped plugin (tier `official`, `src/server/plugins/mcp.ts`) that serves the Model Context Protocol over
the same scoping, so an agent discovers an instance rather than being told about it. `POST /api/mcp` speaks the
Streamable HTTP transport in its stateless form: one JSON-RPC 2.0 request in, one JSON response out, no session id
issued or read (`GET` and `DELETE /api/mcp`, which the transport uses to open and close a session, answer 405 and say
the server is stateless). Stateless because an instance is a Worker: there is no process to keep a session in, so
each call carries its own auth, the `Authorization: <token>` header the REST API reads, and the caller's scope is
what the openapi plugin computes for the same token. The methods are `initialize` (protocol version `2025-03-26`, or
the client's when it is one the server knows; `capabilities.tools`; `serverInfo` `voidbase` and the version),
`notifications/initialized` (202, no body), `ping`, `tools/list` and `tools/call`. Unknown methods are JSON-RPC
`-32601`, a body that is not JSON `-32700`, a batch or a non-request `-32600`, a tool the token cannot see or a
missing argument `-32602`.

The tools are built at request time from the caller's OpenAPI document, so they are exactly the routes the token
may call: per collection `<collection>_list` (`page`, `perPage`, `sort`, `filter`, `expand`, `fields`, `skipTotal`),
`<collection>_get` (`id`, `expand`, `fields`) and, where the rule allows, `<collection>_create` (`data`, an object
shaped by the create body), `<collection>_update` (`id`, `data`) and `<collection>_delete` (`id`); for an auth
collection `<collection>_auth_with_password` (`identity`, `password`), which answers the token to send on the calls
that follow; plus `voidbase_describe`, the scoped document itself, and `voidbase_health`. Each tool's `inputSchema`
is JSON Schema from the operation's parameters and body with the `$ref`s inlined, and its one-line description is
the operation's summary and its rule note, so a gated tool says the rule it is judged by. `tools/call` runs the
operation by calling the instance's own route in process, on the same Hono app, with the caller's token forwarded:
the rules judge the call the way they judge any request, and nothing in the plugin decides access on its own. The
answer is `content: [{ type: "text", text: <the route's JSON> }]`, with `isError: true` on a non-2xx.

To point an MCP client at an instance, give it the URL and the token as a header:

```json
{ "url": "https://<instance>/api/mcp", "headers": { "Authorization": "<token>" } }
```

A token from `auth-with-password` on `_superusers` sees every collection and every write; a user's token sees what
that user may call; no header at all sees the public API. The plugin takes the same injectable source as openapi
(`mcpWith({ collections, appName }, version)`, `test/unit/mcp.test.ts`).

## Auth is the core plugin

Auth left the core on 2026-09-09 (plan.md, decision 0.3): `src/server/plugins/auth.ts` is a plugin of tier `core`
that provides `auth@1`, owns `_superusers`, `_externalAuths`, `_authOrigins`, `_otps` and `_mfas`, and mounts every
auth route (password, OAuth2, refresh, methods, the flows, passkeys). The interface has three parts, because the
core knows auth's shape and not only its result: `authenticate` (a request in, a record or null out) and
`fromToken` (the record behind a token the provider issued, of a given kind), `schema` (the fields every auth record
answers to in a rule, which `filter/compile.ts` asks for instead of keeping a list of its own) and `collections`
(which collections hold accounts), plus `isSuperuser`, which the core asks and does not decide. The core reaches
the provider through `src/server/auth-slot.ts` and imports none of the implementation, so replacing auth is
providing `auth@1` from another plugin. `CORE` lists `auth@1`: an instance running without a provider loads, runs
with nobody signed in and every superuser route answering 401, and says what it is missing at boot and on
`/api/plugins`. `voidbase plugins remove auth` is that instance. Still in the core: the bootstrap creates the auth
collections; the manifest owns them, and handing their creation over is next.

## What is not built

A marketplace's audit is a first pass and not a sandbox: a bundle runs inside the instance with everything the
instance has, the way `pb_hooks` does. A second auth provider (Better Auth) does not exist yet; the seam does.
