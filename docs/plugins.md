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
| `src/server/plugins/*.ts` | the plugins voidbase ships with today: `auth`, `realtime`, `hardening`, `backups`, `installer`, `openapi`, `mcp`, `seo`, `mail`, `translations`. |
| `GET /api/plugins` | what this instance loaded: names, providers, tiers, any core interface nobody provides, `mail`, where this instance's mail goes, and `translations`, the locales and the declared collections. Superuser only. |

## The entry points a plugin package uses

The package exposes the plugin API and the plugins it ships, so a plugin can live in its own package and be typed
against this voidbase: `@voidbase-cloud/voidbase/kernel` (`createKernel`, `load`, `serve`, `using`, `whatLoaded`,
`Kernel`), `@voidbase-cloud/voidbase/plugins` (`Plugin`, `PluginManifest`, `checkManifest`),
`@voidbase-cloud/voidbase/interfaces` (the interface types and `KNOWN`), and `@voidbase-cloud/voidbase/plugins/backups`,
`/plugins/auth`, `/plugins/realtime`, `/plugins/hardening`, `/plugins/openapi`, `/plugins/mcp`, `/plugins/seo`, `/plugins/mail`, `/plugins/translations` (the shipped plugin objects). `test/unit/plugin-entry-points.test.ts` keeps
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
- **Middleware, through a slot.** `hardening` provides `hardening@1`: the body limit, the rate limit and the
  response policy (below). Middleware runs in registration order and the kernel loads after the routes, so a plugin
  cannot `use("*")` for itself; instead `app.ts` keeps the handlers' place in the chain with slots that ask the
  provider at request time, the policy first of all so it lands on every response, errors and files included. No
  provider, no limits and no policy (CORS included); another limiter or another policy is another provider.

### The response policy, hardening's other half

What an instance sends back is a security decision, so it is the plugin's rather than a list of headers in `app.ts`
(`src/server/response-policy.ts`; `hardening@1` exposes it as the `responsePolicy` middleware and `policy(env)`, the
knobs as an env resolves them). Every knob is read from the instance's env on each request, like `VOIDBASE_PRESENCE`,
and every one is off unless set: an instance that sets nothing answers exactly as before. The defaults are
PocketBase's: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `X-Xss-Protection: 1; mode=block`
and `Cross-Origin-Opener-Policy: same-origin` on every response, the strict
`Content-Security-Policy: default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox` on a served
file, CORS at origin `*` with `Authorization` and `Content-Type` allowed, and no CSRF check.

| Variable | Default | Effect when set |
| --- | --- | --- |
| `VOIDBASE_CORS_ORIGINS` | `*` (unset means `*`) | comma-separated origins. Only a listed origin gets `Access-Control-Allow-Origin` (the matching origin echoed, with `Vary: Origin`); a request from any other origin gets no CORS headers at all. Naming the origins also turns on the CSRF rule below |
| `VOIDBASE_HSTS` | unset | `1` or `true` for one year, or a max-age in seconds: `Strict-Transport-Security: max-age=<n>; includeSubDomains`, on https requests only |
| `VOIDBASE_REFERRER_POLICY` | unset | the `Referrer-Policy` value to send, as given |
| `VOIDBASE_PERMISSIONS_POLICY` | unset | the `Permissions-Policy` value to send, as given |
| `VOIDBASE_CSP` | unset | a `Content-Security-Policy` for every response that is not a served file; a route that set its own (the backups download) keeps it |
| `VOIDBASE_CSP_FILES` | the strict policy above | replaces the `Content-Security-Policy` on served files |
| `VOIDBASE_CROSS_ORIGIN` | unset | `1` or `true` adds `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin` beside the Opener-Policy |

**The CSRF rule.** Origin `*` is safe while authentication is a bearer token, because nothing a browser sends on
its own carries one; a cookie is sent on its own, which is what a cookie-based auth plugin would expose. So the
check exists exactly when `VOIDBASE_CORS_ORIGINS` is set: a state-changing request (`POST`, `PATCH`, `PUT`,
`DELETE`) that carries a `Cookie` header and whose `Origin` is neither the instance's own origin nor one of the
named ones is refused with 403 and a message naming `Origin` and `VOIDBASE_CORS_ORIGINS`. Without an `Origin`
header, `Sec-Fetch-Site` decides: `same-origin` and `none` pass, `same-site` and `cross-site` are refused, naming
`Sec-Fetch-Site`. A request with neither header passes, since no browser makes a cross-site request without both.
A request without a cookie is never touched, so a bearer-only client is never affected, and neither is any `GET`,
`HEAD` or `OPTIONS`.

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

A plugin with a deploy-time half (next section) ships it as `deploy.js` beside its `bundle.js`: the marketplace
record names the file and its integrity (`deploy: { file, integrity }`, docs/registry.md), `voidbase plugins add`
downloads it with the bundle, and the lockfile pins its bytes too (`deploy` next to `integrity`), so a changed
`deploy.js` refuses the deploy the way a changed bundle refuses the build.

## What a plugin does at deploy time

A runtime plugin lives inside the instance and answers requests. Some of what a plugin is about happens around a
deploy instead, as an account-level action: attaching a hostname, scheduling a backup, turning an observability
setting on, creating a preview instance. Those are one shape, and the shape is a second object a plugin may export
beside its `Plugin`, typed by `src/node/deploy-plugin.ts`:

```ts
import type { DeployPlugin } from "@voidbase-cloud/voidbase/deploy-plugin";

export const domainsDeploy: DeployPlugin = {
  name: "domains",
  manifest: domains.manifest,
  deploy: {
    async before(ctx) { /* the config and the vars are yours to change; claim ctx.url; throw to refuse the deploy */ },
    async after(ctx) { /* the Worker is up: act on the account with ctx.api */ },
    async remove(ctx) { /* voidbase deploy --remove: undo what after did, before the Worker is deleted */ },
  },
};
```

Every hook gets the same `ctx`: `name` (the Worker), `account: { id }`, `api` (the Cloudflare API client the
deploy uses, `voidbase/cloud`'s `CfApi`, or `null` on `voidbase serve --workers`, where nothing reaches Cloudflare),
`env` (the resolved deploy environment: the shell, the `.env` files and `pb_secrets/secrets.json`, read the way the
deploy's own knobs are), `config` (the Worker config as composed, mutable in `before` and written to
`wrangler.jsonc` once the `before` hooks ran), `vars` (the non-secret vars the deploy bakes into the Worker,
mutable in `before`), `url` (null in `before` unless a plugin claims it, which makes the deploy report that address
instead of workers.dev; the reported URL in `after`), `log`, `local` and `dryRun`. With `dryRun` a hook says what
it would do and touches nothing; the deploy calls the hooks either way, so a dry run shows the whole plan.

`voidbase deploy` finds deploy plugins in two places and runs them in one order: the shipped plugins first, in
`SHIPPED` order, from the static registry in `src/node/deploy-plugins.ts` (a shipped name mapped to its deploy
module under `src/node/plugins/`, imported only when the deploy runs, so the Workers build never sees Node code),
then the installed plugins whose `pb_plugins/<name>/deploy.js` exists, in the lockfile's order. A shipped plugin
the project turned off, or shadowed by installing one of the same name, is skipped here as it is at runtime.
`before` hooks run after the config is composed and before the upload; `after` hooks after the upload and the
deploy's own post-steps (secrets, the `_redirects` zone rules); `remove` hooks on `voidbase deploy --remove`,
before the Worker is deleted. A hook that throws fails the deploy with the plugin, its origin and the phase named,
and the hooks after it do not run. `test/unit/deploy-plugins.test.ts` measures the discovery and the ordering with
fake plugins; `test/deploy-cf.ts` runs an installed `deploy.js` through the CLI against the mock API.

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

## The crawlers' view of the instance: seo

`seo` is a shipped plugin (tier `official`, `src/server/plugins/seo.ts`) that answers the small half of the
roadmap's "SEO, as official plugins": the files every site that serves pages has to answer crawlers with, generated
from what the instance has rather than kept in step by hand. Three routes, three knobs:

- `GET /robots.txt` allows everything by default, keeps crawlers out of the panel and the API (`Disallow: /_/`,
  `Disallow: /api/`), adds one `Disallow:` per path in `VOIDBASE_ROBOTS_DISALLOW` (comma-separated, a leading `/`
  added when missing) and names the sitemap with an absolute URL.
- `GET /sitemap.xml` lists the site root, then one `<url>` per record of each entry `VOIDBASE_SITEMAP` declares:
  comma-separated `collection:/path/{field}` entries, for example `posts:/blog/{slug},pages:/{slug}`, with an
  optional PocketBase filter in brackets, `posts[status="live"]:/blog/{slug}`. Each `{field}` is the record's value,
  URL-encoded; a record whose value is empty makes no `<url>`; `<lastmod>` is the record's `updated` when it has one.
  A collection is read only when it is publicly listable (its list rule is `""`), through the same listing an
  anonymous request gets, so the filter can do nothing a public caller could not; a collection that is locked, gated,
  missing, or whose filter fails is skipped with a warning in the log, never a 500. Capped at 50000 entries, the
  sitemap limit. Without `VOIDBASE_SITEMAP` the sitemap lists only `/`.
- `GET /llms.txt` is a plain-text description for the crawlers that are not search engines: the instance's name
  (settings `meta.appName`, else `voidbase`), the site URL, the public collections with their fields (names and
  types, hidden fields left out), the machine-readable endpoints `/api/openapi.json`, `/api/docs` and `/api/mcp`,
  and one line saying what each token scope sees. `VOIDBASE_LLMS_NOTE` appends a free-text paragraph under `## Notes`.

The site URL in all three is `VOIDBASE_SITE_URL` when set (trailing slash dropped), else the request's origin. Each
answer is served with `Cache-Control: public, max-age=300`. A file in the static files (`pb_public`) wins over the
generated answer: the route asks the static layer (`env.ASSETS`) for its own path first and answers only when there
is no real file there (an HTML shell answering a miss does not count). That check is what makes the file win on Bun,
where the app runs before the static fallback (`src/node/serve.ts`); on Cloudflare the asset layer answers before
the Worker for any path outside `/api`, so a file wins there without the plugin being asked. That same rule is why
the three are also mounted under `/api/seo` (`/api/seo/sitemap.xml` and so on): the Worker Void generates for
voidbase forwards `/api/*` to the Hono app and nothing else, and a Void route outside `/api` would put the Worker
back in front of every asset (`run_worker_first: /**`, docs/platform.md item 1). So the adapter writes, at build
time, a `_redirects` rule per file the static build does not carry (`/robots.txt /api/seo/robots.txt 302`, and the
two others; `writeSeoRedirects` in hooks-plugin.ts, appended to the app's own `_redirects` when it has one). The
asset layer evaluates those at the edge, crawlers follow the redirect (Google follows several hops for robots.txt
and sitemaps), and the Worker answers. The knobs are read from the request's env first, then the
runtime's, like hardening's.

**A record's page metadata.** The roadmap entry's other half is what one page says about itself, answered as data
so the app that renders the page does not compute it again: `GET /api/seo/meta?path=/blog/hello-world` (or
`?collection=posts&id=<record id>`). The path is resolved through the `VOIDBASE_SITEMAP` templates in reverse: the
first entry whose pattern matches the path (`posts:/blog/{slug}` matches `/blog/hello-world`, each `{field}` one
path segment, URL-decoded; a trailing slash is tolerated) names the collection and the field, and the record is
read through the same listing the records API does for the request's caller, with the entry's filter and the
captured value as the filter (`(status="live") && slug = "hello-world"`), so the collection's list rule is judged
for the token that asks: an anonymous caller gets a public record or a 404, a locked collection a 403, a record the
entry's filter leaves out (a draft) a 404. Send the path as a loader would, `encodeURIComponent(location.pathname)`,
so a slug that is itself escaped survives the query string. The answer is
`{ canonical, title, description, image, type, locale, alternates, jsonld, og, twitter, html }`: `canonical` is
`VOIDBASE_SITE_URL` (else the request's origin) plus the template path rebuilt from the record's own values (one
page has one address, whatever spelling asked for it); `type` the schema.org type; `jsonld` the object; `og` the
`og:*` properties as keys (`og:site_name` is the settings' app name, `og:type` is `article` for a type ending in
`Article` or `Posting`, `website` otherwise, `og:image` the image); `twitter` the `twitter:*` names
(`summary_large_image`); `html` the ready fragment, `<title>`, `<link rel="canonical">`, `<meta name="description">`,
the `og:*` and `twitter:*` metas and `<script type="application/ld+json">`, every value escaped (and `<` in the
JSON-LD written as `\u003c`, so no value can close the script). An unknown path, an id the filter leaves out, or
a collection no sitemap entry names is a 404 with a JSON message; no parameter at all is a 400.

Which fields feed which tag is one knob, `VOIDBASE_SEO`, comma-separated entries of `collection:Type{key=field,...}`:

```
VOIDBASE_SEO=posts:Article{title=title,description=summary,image=cover,datePublished=created,dateModified=updated,author=author.name},pages:WebPage
```

`Type` is the schema.org type of that collection's pages. `title`, `description` and `image` are the page-level
keys (the tags and the JSON-LD both use them); every other key lands in the JSON-LD as it is, with a `date*` key
normalised to ISO and `author` and `publisher` written as a `Person` and an `Organization` with that name. A field
path may reach through one relation, `author.name`, which the lookup expands (and the related collection's view
rule judges, like any expand). `image` names a file field: the answer is the file's URL through the files route,
`/api/files/<collection>/<id>/<filename>`, with `?thumb=<size>` appended when `VOIDBASE_SEO_IMAGE_SIZE` names one
of the field's thumb sizes; a `url` field's value is used as is. The title is the field's text with tags stripped,
the description the first 200 characters of it (tags stripped, entities decoded, cut back to a word and closed
with an ellipsis when longer). A collection that is in the sitemap but not in `VOIDBASE_SEO` gets sensible defaults:
type `WebPage`, the title from the first text field named `title`, `name` or `headline`, the description from
`summary`, `description` or `excerpt`, no image field. A malformed entry or mapping is skipped with a warning.

**Share images rendered on request.** `GET /api/seo/og/<collection>/<id>.svg` is a 1200x630 card: the app's name,
the record's title wrapped onto at most three lines of thirty characters (the last one ellipsised), the description
on one line, every string escaped, on the background colour `VOIDBASE_SEO_THEME` names (a hex colour or a CSS
colour name; default a neutral dark, `#1f2430`; the text is white on a dark colour and near-black on a light hex
one). Fonts are the generic system stack only, no font file is shipped or fetched. Served
`Cache-Control: public, max-age=3600`. The record is found the way the meta route finds it, through the first
sitemap entry naming the collection, its filter, and the caller's list rule. `image` in the meta answer (so
`og:image` and `twitter:image`) is this URL whenever no image field is mapped or the record has no file in it, so
every page has a share image without one being uploaded. `<id>.png` exists for the platforms whose image library
can rasterise an SVG; photon (`#platform/photon`, the resizer the thumbnails use) decodes raster formats only, on
Workers and on Node alike, so today `.png` answers 406 with a JSON message saying so and SVG is what is served. A
test or a platform with a rasteriser hands one in through the source (`rasterize(svg)`, below).

**Deployment skew.** A crawler that arrives during a deploy must not get half a page. On Cloudflare that is the
platform's own guarantee: each request is served, start to finish, by one Worker version (a gradual deployment
splits requests between versions, never one request), and the meta answer, the card and the fragment inside it are
computed in that one request from that one version, so no answer mixes two. What is left is the caches: a cache
that stored the answer before the deploy has to learn the answer changed. Every answer from the two routes carries
`ETag: "<voidbase VERSION>-<the record's updated, in ms>"`, so it changes when the record does and when voidbase
does, and honours `If-None-Match` (strong or weak, or `*`) with a bodiless 304 that carries the same headers; the
meta answer also carries `X-Voidbase-Version`, so a page that fetched it can say which version it was rendered
against. A stack app's own assets are Void's to version; the instance's answers are what this covers.

**Locales.** When the translations plugin is configured (`VOIDBASE_LOCALES` set, the first locale the source), the
sitemap carries `xmlns:xhtml` and, per `<url>`, one `<xhtml:link rel="alternate" hreflang="<code>">` per locale plus
`x-default`; the alternate is `?locale=<code>` on the URL or, when `VOIDBASE_SEO_LOCALE_PATH=prefix`, `/<code>` in
front of the path, and the source locale keeps the bare URL either way. Without locales the sitemap is byte for
byte what it was. The meta answer does the same: `locale` is the locale the path asks for (`?locale=ar` in the
path, `/ar/...` in prefix mode, or `&locale=` on the meta request itself, which wins) or the source; `canonical`
is that locale's URL; `alternates` lists them all; `og:locale` and `og:locale:alternate` (with `-` as `_`, the
Open Graph spelling) and the `hreflang` links in `html` follow. The text is translated the way the records API
translates it, through the kernel's after-read seam, so it follows the meta request's own `?locale=` or
`Accept-Language`; put the locale on the meta request when the page is a translated one.

**Using it from a stack app.** A page's loader fetches the answer and its head puts it in place. In a Void app
(the site's own pages do their head this way, `pages/docs/*.server.ts`), `loader` is a `defineHandler` that fetches
`/api/seo/meta?path=` + `encodeURIComponent(<the page's path>)` on the instance and returns the JSON as a prop, and
`head` is a `defineHead` that maps it onto Void's `HeadDescriptor`: `title` from `title`, `meta` from the `og`
entries (`{ property, content }`) and the `twitter` entries (`{ name, content }`) plus the description, `link` from
`canonical` (`rel: "canonical"`) and `alternates` (`rel: "alternate", hreflang`), and `script` from `jsonld`
(`{ type: "application/ld+json", innerHTML: JSON.stringify(jsonld) }`). A framework that takes a raw fragment puts
`html` in the head as it is. Forward `If-None-Match` and the answer's `ETag` when the page is itself cached, and
the loader pays for the meta only when the record or voidbase changed.

The plugin takes an injectable source for tests, `seoWith({ collections, appName, records, record, rasterize })`
(`test/unit/seo.test.ts`, which measures the three files, the path resolution through the template in reverse, the
mapping grammar, the fragment's escaping, the JSON-LD, the defaults, the card, the ETags and the alternates).

## Mail from the instance's domain: mail

`mail` is a shipped plugin (tier `official`, `src/server/plugins/mail.ts`) that provides `mail@1`: outbound mail
from the instance's own domain through Cloudflare's Email Service, with SMTP staying the fallback. It answers the
roadmap's "Email from that domain": the domain the previous item put on the account is the one the mail can now
leave from, with the SPF, DKIM and DMARC records Cloudflare writes when the domain is onboarded, so the deliverability
problem is solved by the thing that has the authority to solve it.

**What Cloudflare offers (checked 2026-09-11 against developers.cloudflare.com, whose Email Service pages were last
updated 2026-06-09).** Email Sending is a beta on the Workers Paid plan; sending to the account's verified destination
addresses is free on every plan. A Worker gets it as a `send_email` binding in its config:
`send_email: [{ name: "SEND_EMAIL" }]`, optionally with `destination_address` (one fixed recipient),
`allowed_destination_addresses` (an allowlist) or `allowed_sender_addresses` (which senders the binding may use).
`env.SEND_EMAIL.send()` takes either the structured message (`{ from, to, subject, html, text, cc, bcc, headers,
attachments }`) or the older `EmailMessage(from, to, raw)` from `cloudflare:email`, where `raw` is the RFC 5322 text;
the older form remains supported and is what this plugin uses. Every sender address must belong to a domain
onboarded to Email Sending on the account (the binding answers `E_SENDER_NOT_VERIFIED` otherwise); before a sending
domain is onboarded a binding may deliver only to the account's verified destination addresses, and once one is
onboarded it may send to any recipient. Onboarding a domain is a dashboard step (Email > Email Sending > add a
domain) or the zone's `email/sending/subdomains` API: Cloudflare writes MX, SPF, DKIM (selector `cf-bounce`) and
DMARC records under a `cf-bounce` subdomain of the zone, so the zone has to be on the account with Cloudflare
running its DNS. Limits: 50 recipients across to, cc and bcc, 32 attachments, 5 MiB per message, a daily quota that
starts conservative and grows with the account's standing. This replaced the earlier route, Email Routing's
"send email from Workers", which could send only to verified destination addresses.

**The knob.** `VOIDBASE_MAIL_DOMAIN=example.com` (a domain, not an address; from the environment or
`pb_secrets/secrets.json`). With it, `voidbase deploy` adds the binding to `workerConfig` as `SEND_EMAIL`, bakes the
domain as a var of the same name, checks that a zone on the account covers the domain, reads the zone's Email
Sending state when the token happens to allow it (the deploy token's permissions do not include it), and prints one
line saying either that the domain is onboarded or what to do in the dashboard. Without the knob nothing changes:
no binding, and mail goes where it went before.

**At run time.** The plugin provides `mail@1` as a factory over the request's bindings, like realtime: `carrier(env)`
names where mail goes when `env.SEND_EMAIL` and the domain are there, and is null otherwise, in which case the core
uses what it had. The core's transport (`deliverMail` in `src/server/mail/index.ts`) asks the provider first: a
message whose From is on `VOIDBASE_MAIL_DOMAIN` is built as the same RFC 5322 text the SMTP path sends
(`multipart/alternative` with a text and an html part, UTF-8, base64 where needed, From, To, Cc, Subject, Date,
Message-ID and MIME-Version; Bcc never in the headers) and handed to the binding as one `EmailMessage(from, to, raw)`
per recipient, to, cc and bcc alike. A From on any other domain is refused with a message naming the sender, the
domain and the knob; if `VOIDBASE_MAIL_HTTP_URL` is set the HTTP provider takes it, else if SMTP is enabled in the
settings the SMTP transport takes it, else the refusal is the error (the panel's test email shows it; a queued job
retries and alerts as any failed job does). The panel's SMTP settings, the HTTP provider and the log line are
untouched. `GET /api/plugins` says where this instance's own mail (the settings' sender) goes in its `mail` field:
`{ via: "plugin", carrier: "Cloudflare Email Service, from example.com", sender }`, or `via: "http"` or `"smtp"` with
the host, or `via: "log"` with `refused` carrying the reason when the sender is off the domain and nothing else can
take it. `test/unit/mail-plugin.test.ts` measures the MIME, the domain rule, the fake binding and the fallback.

## A chat over the instance: ai

`ai` is a shipped plugin (tier `official`, `src/server/plugins/ai.ts`): a chat over the instance on Workers AI,
scoped to whoever is asking. It is the first piece of the roadmap's "Workers AI and Think, as official plugins":
the chat, without the Durable Object memory Think would add. `POST /api/ai/chat` takes
`{ messages: [{ role, content }], model?, tools?: boolean, maxSteps?: number }` from any caller (anonymous, a user,
a superuser) and answers `{ message: { role: "assistant", content }, steps: [{ tool, arguments, result }], model }`,
where each step is one tool call the model made, with the first 500 characters of what the tool answered.

**The knob.** `VOIDBASE_AI=1` (or a model name: `VOIDBASE_AI=@cf/meta/llama-3.3-70b-instruct-fp8-fast`, which is
also what `1` means and the model the route uses when a request names none; from the environment or
`pb_secrets/secrets.json`). With it, `voidbase deploy` adds the Workers AI binding to `workerConfig` as
`ai: { binding: "AI" }` and bakes the model as a var of the knob's name; the binding is configuration only, nothing
on the account to create, and Workers AI is metered per neuron on every plan (a free allowance daily, then paid).
Without the knob nothing changes: no binding, `POST /api/ai/chat` answers 503
`{ message: "Workers AI is not bound; deploy with VOIDBASE_AI=1" }`, and `GET /api/plugins` reports
`ai: { via: "none" }` (with the binding: `{ via: "workers-ai", model }`). A request may name another `model`; the
binding's model is the default.

**The scoping, which is the MCP server's.** The plugin writes no tool list. The tools the model may call are what
`mcp` derives for the same token (`toolsOf` over the caller's OpenAPI document, "An agent's view of the instance"
above), handed to Workers AI in its OpenAI-style `tools` shape, `{ type: "function", function: { name, description,
parameters } }`, with each tool's `inputSchema` as the parameters: anonymous sees the public API, a user what that
user may call, a superuser everything, and a locked collection is not a tool the model can name. A call the model
makes runs exactly as `tools/call` runs it (`runTool`, exported from `mcp.ts`): the instance's own route in
process, with the caller's token forwarded, so the rules judge it and nothing in the plugin decides access. The
system prompt names the instance (the settings' app name), says what the caller is (anonymous, a record of which
collection, or a superuser) and tells the model to use the tools for facts and never to invent an id or a value.
`tools: false` sends none.

**The loop.** Workers AI's traditional function calling (developers.cloudflare.com/workers-ai/features/function-calling/traditional,
and Cloudflare's own `@cloudflare/ai-utils` `runWithTools`, which this follows; the types in
`@cloudflare/workers-types` 4.20260702.1, `AiTextGenerationInput` and `AiTextGenerationOutput`): `env.AI.run(model,
{ messages, tools })` answers `response` and, when it wants a tool, `tool_calls: [{ name, arguments }]`; the
OpenAI-style `{ id, type: "function", function: { name, arguments: "<json>" } }` the types also declare is read
the same way. Each call goes back as an assistant message carrying the call and a `{ role: "tool", name, content }`
message carrying the route's answer (a refusal, a 404 or a missing argument is a result the model sees, not an
error), and the model is asked again, until it answers without a call or `maxSteps` (default 6, at most 20) tool
steps have run, after which the answer says it stopped. No streaming: Workers AI streams a call's text, but a call
that streams cannot also hand back `tool_calls` to act on, and Cloudflare's helper streams only one extra final
call made without tools; `stream: true` is refused with that reason.

**The cap.** 30 requests per minute per caller (the signed-in record, else the client IP), counted in memory, so per
isolate: the hardening plugin's rate limits are the settings' rules keyed by path, which a superuser can add one for
(`POST /api/ai/chat`), and the deploy's `RATE_LIMITER` ceiling applies on top; this cap is the floor that is there
without any settings, because every call is metered. `test/unit/ai.test.ts` scripts a fake `AI` binding per test:
the tool list per caller, the loop feeding a result back, the runaway stopped, the 503, the plugins field, the cap.

**What Think would add, later.** Think is Cloudflare's chat harness over a Durable Object's SQLite with Workers AI
behind it: the conversation persists, an agent can be driven as a sub-agent over RPC, and the panel or a preview
environment can mount it. This plugin is the stateless half, one request in and one answer out, and it is what the
Think plugins would call, because the scoping question they all have is answered here once: the MCP server's tool
list is the instance as the caller may see it, and a Think agent needs nothing more than that list and a token.

## Content in the reader's language: translations

`translations` is a shipped plugin (tier `official`, `src/server/plugins/translations.ts`) that answers the content
half of the roadmap's "Translations, as an official plugin": a field is declared translatable once, and the records
API answers in the language the request asks for, falling back the way you said. Interface strings (the project
half: typed keys that fail the build when one is missing) are not here, and are not this plugin's job.

**The knobs**, read from the request's env first, then the runtime's, like seo's and hardening's:

- `VOIDBASE_TRANSLATABLE=posts:title,body;pages:title` declares which fields have translations: entries separated
  by `;`, each `collection:field,field` (`,` between fields). Whitespace around a name is ignored, a collection
  named twice gets the union of its fields, and an entry with no `:`, an invalid name or no field is skipped with a
  warning in the log.
- `VOIDBASE_LOCALES=en,ar,fr` lists the locales, lowercased and deduplicated. The first is the source locale, the
  one the records' own fields hold; the order is the fallback order.

Both have to be set for anything to happen; with either missing the plugin is loaded and idle.

**Storage.** The plugin owns one collection, `translations`, created at bootstrap through the ownership mechanism
above: `collection`, `record`, `field`, `locale` (text, required) and `value` (text), with one unique index over the
four keys. A translation is written like any record (`POST /api/collections/translations/records` with
`{ collection: "posts", record: "<id>", field: "title", locale: "ar", value: "..." }`); create, update and delete are
superuser only, list and view are public. Public on purpose and said plainly: a translation is as public as its
record, and the cheap rule is the public one, so a translation of a record that is not publicly readable is still
listable through `/api/collections/translations/records`. The read path below never has that problem, because it
only swaps fields on records the caller could already see; if the collection itself has to be tightened, its rules
are edited from the panel like any collection's (the plugin creates it once, when missing, and does not overwrite
what you changed). The source text stays in the record's own field: writes go there as they always did, and
realtime events carry the record as stored. Nothing here touches either.

**Reading.** `GET /api/collections/:c/records` and `/records/:id` go through a kernel seam (`onAfterRead`, below)
after the rules judged the read and `expand` and `fields` were applied. When the response holds a record of a
declared collection (the rows, or a record inside their `expand`), the locale is `?locale=ar` when that is one of
the locales (an unknown one is the source, not an error), else the best `Accept-Language` match among
`VOIDBASE_LOCALES` by q value (a tag matches its locale exactly or by primary subtag, `en-US` finds `en`, `*` is
the source), else the source. The response carries it in `Content-Language`. Each translatable field is replaced
by its translation in that locale, falling back down `VOIDBASE_LOCALES`' order to the source value; an empty
translation is no translation, and an empty source value counts as missing too, so the next locale in the order is
tried. Per record, `translated: { field: locale }` names the fields that were swapped and where each came from
(`{ title: "ar" }`, or `{ title: "ar", body: "fr" }` when the body fell back); the key is absent when nothing was
swapped. A request for the source locale is the records as they are, with the header. All the translations a
response needs, expanded records included, are asked for in one call to the plugin's source (the default source
issues that as one `IN` over the record ids, chunked under D1's bound-parameter limit the way the expander does),
never one query per record. A collection the knob does not name is answered exactly as before, header included.

**The reports**, superuser only:

- `GET /api/translations/missing?collection=posts&locale=ar` lists what has no translation yet: paginated over the
  collection's records with `page` and `perPage` like the records API (`totalItems` is the record count), and
  `items` are the records of that page missing at least one field, each with the fields it lacks:
  `{ collection, locale, page, perPage, totalItems, totalPages, items: [{ id, fields: ["body"] }] }`. An
  undeclared collection, an unknown locale or the source locale is a 400 saying which.
- `GET /api/translations/status` counts, per declared collection and per locale other than the source, the
  `(record, field)` pairs that have a translation out of records times fields:
  `{ source, locales, collections: { posts: { fields, records, locales: { ar: { translated, total } } } } }`. A
  translation whose record is gone is not counted; a declared collection that does not exist is left out with a
  warning.
- `GET /api/plugins` gains a `translations` field: `{ source, locales, collections: { posts: ["title", "body"] } }`.

**The seam.** The kernel gained `onAfterRead(ctx, (c, { collection, rows }) => ...)`: the list and view routes in
app.ts call `runAfterRead` with the collection's name and the rows as the response will carry them, in load order,
and a handler changes the rows in place and may set a header. It is generic on purpose (the kernel still imports no
feature; `test/unit/kernel-invariant.test.ts` holds) and is what any plugin that reshapes what a read answers
would use. The plugin takes an injectable source for tests, `translationsWith({ collections, translations,
recordIds, counts })`; `test/unit/translations.test.ts` measures the knob grammar, the negotiation, the swap and
its fallback, the marker, the single lookup, the reports, the untouched collection, and the default source's SQL
over the table the definition creates. The seo plugin reads `VOIDBASE_LOCALES` too, for `hreflang` alternates in
the sitemap and `og:locale` plus canonical URLs per locale in the page metadata ("The crawlers' view of the
instance"). Not here: a locale in the route, a panel screen over the reports, and the interface strings.

## Taking money: stripe

`stripe` is a shipped plugin (tier `official`, `src/server/plugins/stripe.ts`) that provides `payments@1` against
Stripe's REST API with `fetch` alone: form-encoded bodies (`line_items[0][price]`), `Authorization: Bearer`, and
`Stripe-Version` pinned to `2025-08-27.basil`, so a change on Stripe's side arrives when that line changes and not
before. No Stripe SDK. It is the roadmap's "Payment providers, as official plugins", first of the three it names.

**The knobs.** `STRIPE_SECRET_KEY` (`sk_test_...` or `sk_live_...`) and `STRIPE_WEBHOOK_SECRET` (the `whsec_...`
of the endpoint registered in Stripe's dashboard). Both are secrets: declare them with `secret(...)` in `env.ts`
so they live in `pb_secrets`/`vb_secrets` and reach the Worker as encrypted secrets, never as vars. The plugin reads
them from the request env first and the runtime env second, like mail's domain. Without the key the plugin is
loaded and idle: `payments@1` is provided, `route(env)` is null, every route answers 503 naming the knob, the three
collections are not created, and `GET /api/plugins` says `payments: { via: "none" }`. With it:
`payments: { via: "stripe", webhook: "/api/payments/stripe/webhook", livemode: true|false }`, livemode read off the
key's prefix.

**The interface.** `payments@1` was reshaped for this plugin (2026-09-11) the way mail was: the key arrives with the
request, so every method takes the env. `route(env)`, `checkout(env, { customer, items, success, cancel, mode? })`,
`portal(env, { customer, return })`, `webhook(env, request)` and `cancel(env, subscription, { now? })`. `customer`
and `subscription` are ids of the plugin's own rows, never Stripe's ids: the app talks about its rows and the plugin
translates. The routes below call the same code.

**The collections it owns**, created on the first request that carries the key (`ensureCollections`, kernel
onBootstrap), each with `created` and `updated` autodates and a unique index on the provider id:

- `customers`: `user` (relation to `users`, optional), `provider` (text, `"stripe"`), `providerId` (text, `cus_...`),
  `email` (text). Rules: list and view `user = @request.auth.id`; create, update and delete superuser only.
- `subscriptions`: `customer` (relation), `providerId` (`sub_...`), `status` (select: `incomplete`,
  `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid`, `paused`), `price` (text, the
  price id), `currentPeriodEnd` (date), `cancelAtPeriodEnd` (bool). Rules: list and view
  `customer.user = @request.auth.id`; writes superuser only.
- `payments`: `customer` (relation), `providerId` (`pi_...`, or the invoice id when there is no payment intent yet),
  `amount` (number, the minor unit), `currency` (text), `status` (select: `pending`, `succeeded`, `failed`,
  `refunded`, `canceled`), `subscription` (relation, optional), `raw` (json, the Stripe object). Same rules as
  subscriptions.

So a signed-in user reads their own rows through the records API and realtime like any other collection, and
nothing writes them but the plugin, through the records service as a superuser, so hooks fire and the rows look
like the panel wrote them.

**The routes**, all under `/api/payments/stripe/`:

- `POST checkout`, signed-in user. Body `{ items: [{ price, quantity }], success, cancel, mode?: "payment" |
  "subscription" }` (`mode` defaults to `payment`). Finds the user's `customers` row or creates the customer at
  Stripe (`POST /v1/customers` with the email and `metadata[voidbase_user]`) and the row, then creates a Checkout
  Session with `client_reference_id` and `metadata[voidbase_customer]` set to the row id. Answers `{ url }`.
- `POST portal`, signed-in user. Body `{ return }`. A billing portal session for the user's customer. `{ url }`.
- `POST cancel`, the subscription's owner or a superuser. Body `{ subscription, now? }` (a `subscriptions` row
  id). Cancels at the period's end by default (`cancel_at_period_end=true`); `now: true` deletes the subscription
  at Stripe. The row follows at once; the webhook confirms later. Answers `{ subscription, status,
  cancelAtPeriodEnd }`.
- `POST webhook`, no auth. Register `https://<instance>/api/payments/stripe/webhook` in Stripe's dashboard
  (Developers > Webhooks) and put its signing secret in `STRIPE_WEBHOOK_SECRET`. The `Stripe-Signature` header is
  verified as HMAC SHA-256 over `t.payload` against the secret, with a five-minute tolerance on `t` and a
  constant-time compare; a bad or stale signature is 400 and nothing is read. Then `checkout.session.completed`
  (the customer, and in payment mode the payment), `customer.subscription.created|updated|deleted` (the
  subscription row, `deleted` as status `canceled`), `invoice.paid` and `invoice.payment_failed` (a payment linked
  to its subscription), `payment_intent.succeeded|payment_failed` (the payment) are written as upserts by
  `providerId`, so Stripe's retries and a replay change nothing. Any other event is 200 and ignored
  (`{ received: true, handled: false }`). Both invoice shapes are read: the 2025 versions moved a subscription's
  period onto its items and an invoice's subscription and payment intent under `parent` and `payments`.

A Stripe error comes back as 400 with Stripe's message (`Stripe answered 402: Your card was declined`), a Stripe
outage as 502. `test/unit/stripe-plugin.test.ts` measures the signature check, the encoding, the three routes
against a fake `fetch`, every event against in-memory rows, the replay, and the no-key state; nothing calls Stripe.

**What Polar and Lemon Squeezy would share.** The interface, the three collections and their rules, the
`/api/payments/<provider>/` prefix, the upsert-by-`providerId` discipline, `route(env)` for `/api/plugins`, and
the test shape (a fake fetch, in-memory rows). What each brings: its own signature scheme (Polar signs with
Standard Webhooks, Lemon Squeezy with `X-Signature` HMAC over the raw body), its own event names mapped onto the
same six effects, and its own `customer`/`subscription`/`order` objects read into the same fields. Changing
provider is removing one plugin and installing another; the rows keep their shape, with `provider` saying which.

## Backups worth relying on: backups

`backups` is the shipped plugin over `src/server/backups.ts` and answers the roadmap's "Enterprise backup, as an
official plugin": two kinds of archive, each verified after it is written, each restorable on its own terms, a
schedule with retention, and a copy in a bucket the instance's account does not own. Everything below is the same
routes PocketBase has (list, create, upload, download, delete, restore) plus `verify`; the panel's Backups page and
`voidbase migrate` keep working unchanged.

**Two archive kinds.** `POST /api/backups` takes `{ kind?: "full" | "data", name? }`. The default is `full`, the
kind the archives always were (every table and every file) with three entries added:

- `full`: `data.json` (every D1 table, columns and rows, the `_collections` rows included, as before), every file in
  storage as `storage/<collection id>/<record id>/<file name>`, `settings.json` (the settings as `GET /api/settings`
  answers them: the SMTP password and the S3 secrets left out, so a full archive never holds them),
  `collections.json` (every collection as the collections API exports it, token secrets left out as there too) and
  `manifest.json` last: `{ format, kind, voidbase, created, tables, files: { count, bytes }, checksum, entries }`,
  where `entries` is the sha256 of every other entry and `checksum` the sha256 over `"<name>\n<sha256>\n"` for all
  of them, names sorted. It rebuilds an instance from nothing but a voidbase of the same or a newer version.
- `data`: the rows of every non-system collection (views have no rows), their files, their definitions in
  `collections.json` (so a restore can create one the target lacks, on request) and `manifest.json`. No
  `settings.json`, no `_superusers`, no `_authOrigins`, `_otps`, `_mfas` or `_externalAuths`, no `_params`, no token
  secrets. For moving content between environments or putting rows back after a bad migration. An auth collection's
  own rows travel whole, password hashes and token keys included, because a move that signs every user out is not a
  move; strip them on the target if that is not wanted.

Files are streamed into the zip a chunk at a time (fflate's streaming `Zip`), never held whole. The archive itself
streams to R2 as a multipart upload in 10 MiB parts; a backups storage that offers no multipart upload (the S3
backups bucket from the settings, the Bun runtime's local store) takes it as one object, so it is held in memory
first and the write is refused past 256 MiB (`BUFFERED_MAX`) with a message saying so. Archives written before
this (only `data.json` and `storage/`) read as `kind: "legacy"` everywhere and restore exactly as they did.

**Verification.** After the write the archive is read back as a stream, every entry hashed and the manifest
compared: the checksum, each entry's hash (a corrupted one is named), entries the manifest lists that are gone,
entries it does not list. The outcome lives in a sidecar next to the archive (`__backups__/<name>.meta.json`, never
listed, deleted with it), which is what `GET /api/backups` reads: each item is
`{ key, size, modified, kind, verified, voidbase }` plus `verifyError` when it failed, `offsite`/`offsiteError`
when a copy was attempted (below) and `restore` after one (below). A legacy archive is `kind: "legacy"`,
`verified: false`, `voidbase: null`: there is nothing to compare it to. `POST /api/backups/:key/verify` re-checks on
demand and answers `{ key, kind, verified, voidbase, checksum, entries, corrupted, missing, error? }`, updating the
sidecar; an uploaded archive is verified on arrival, so the listing knows its kind and version at once.

**Restore per kind.** `POST /api/backups/:key/restore` still answers 204 and does the work in the background under
the same lock `/api/health` reports as `canBackup`, but the archive is opened first, so a refusal is the answer: an
archive whose `voidbase` major.minor is newer than the instance's is refused with
`written by voidbase X.Y.Z, newer than this instance (A.B.C)`, and so is one that is not a voidbase archive. A
`full` (or legacy) archive is restored entirely: the settings merged over the current ones (the secrets it never
held stay as they are), every user collection dropped and recreated from the archive's `_collections` rows before
their rows are loaded, the system tables' rows replaced, every file replaced. A `data` archive lands on the existing
schema: for each collection in the archive that the instance has, its rows are replaced (columns the instance's
table lacks are dropped) and its files are replaced under the instance's own collection id; a collection the
instance lacks is skipped and reported, never invented, unless the body is `{ createMissing: true }`, in which case
it is created from the archive's definition first; a system collection or a view in its place is skipped too. The
report `{ at, kind, restored, created, skipped: [{ collection, reason }], settings }` is written to the sidecar and
shown on the listing as `restore`, and the skips are logged.

**The off-site copy.** With `VOIDBASE_BACKUP_S3_ENDPOINT`, `VOIDBASE_BACKUP_S3_BUCKET`,
`VOIDBASE_BACKUP_S3_ACCESS_KEY_ID` and `VOIDBASE_BACKUP_S3_SECRET_ACCESS_KEY` set (`VOIDBASE_BACKUP_S3_REGION` is
optional, `auto` by default; all read from the request's env first, then the runtime's, like the other plugins'
knobs), every archive written is also `PUT` at the root of that bucket, another R2 account, Backblaze B2, AWS S3 or
anything S3-compatible, path-style, with a Signature Version 4 computed here over `fetch` and WebCrypto (no SDK):
the sha256 of the body when the archive was in memory, `UNSIGNED-PAYLOAD` when it streams from the backups
storage after a multipart write. `GET /api/backups` marks the item `offsite: true` when the copy succeeded; a
failed copy is logged and reported as `offsite: false, offsiteError` and never fails the backup, which is written
and verified either way. The sidecar is not copied: the manifest inside the archive is what a restore from that
bucket needs (`POST /api/backups/upload` it on any instance).

**Schedule.** The cron from Settings > Backups runs as before, through the jobs queue on Cloudflare. Two knobs
shape what it writes: `VOIDBASE_BACKUP_KIND=full|data` (default `full`, the kind it always wrote) and
`VOIDBASE_BACKUP_KEEP=<n>`, the number of automatic archives to keep, the oldest beyond it deleted with their
sidecars only after a successful, verified write. Without the knob the settings' `cronMaxKeep` applies as it
always did (3 by default, 0 for unlimited). Named backups are never pruned.

The unit test (`test/unit/backups.test.ts`) measures both archives' contents and manifests over an in-memory D1
and R2, verification catching a corrupted and a missing entry, each restore with its refusals, retention, the
signer against AWS's published SigV4 example, and a failed copy leaving the backup intact; the conformance suite
(`test/conformance/backups.ts`) still runs the PocketBase contract against a live server.

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
