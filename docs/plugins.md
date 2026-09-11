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
| `src/server/interfaces/index.ts` | the interfaces a plugin may provide or require, versioned in the name (`auth@1`, `payments@1`, `tax@1`, `shipping@1`, `realtime@1`, `hardening@1`, `mail@1`, `observability@1`) and the closed `KNOWN` list. |
| `src/server/plugins/*.ts` | the plugins voidbase ships with today: `auth`, `observability`, `realtime`, `hardening`, `backups`, `installer`, `openapi`, `mcp`, `seo`, `mail`, `ai`, `translations`, `stripe`, `polar`, `lemonsqueezy`, `tax-flat`, `shipping-flat`, `commerce`, `previews`, `domains`. |
| `src/server/plugins/report.ts` | what `GET /api/plugins` answers: the graph the kernel resolved, then what each loaded plugin says about itself through its own `info(env)`, by name. |
| `src/server/record-slot.ts` | how a plugin asks the core to build the `RecordContext` of a request it is answering, the way `auth-slot.ts` is how the core asks a plugin about auth. |
| `src/server/realtime-slot.ts` | the guard on the `realtime@1` slot: the client for this request's bindings, or one that says realtime is off when nothing provides the interface. |
| `GET /api/plugins` | what this instance loaded: names, providers, tiers, `plugins` (each with its tier, a `core` flag and its `provides`/`requires`), any core interface nobody provides, then a field per loaded plugin that declares `info(env)`, under that plugin's own name. `installer`, `mail`, `payments` and `observability` are always answered; the rest are there only while a plugin answers for them, which is a change from what every instance through 0.9.0-beta.48 reported (below). Superuser only. |

## The entry points a plugin package uses

The package exposes the plugin API and the plugins it ships, so a plugin can live in its own package and be typed
against this voidbase: `@voidbase-cloud/voidbase/kernel` (`createKernel`, `load`, `serve`, `using`, `whatLoaded`,
`Kernel`), `@voidbase-cloud/voidbase/plugins` (`Plugin`, `PluginManifest`, `checkManifest`),
`@voidbase-cloud/voidbase/interfaces` (the interface types and `KNOWN`), the three slots
(`@voidbase-cloud/voidbase/auth-slot`, `/record-slot`, `/realtime-slot`, below), and `@voidbase-cloud/voidbase/plugins/backups`,
`/plugins/auth`, `/plugins/realtime`, `/plugins/hardening`, `/plugins/openapi`, `/plugins/mcp`, `/plugins/seo`, `/plugins/mail`, `/plugins/translations`, `/plugins/commerce`, `/plugins/tax-flat`, `/plugins/shipping-flat` (the shipped plugin objects). `test/unit/plugin-entry-points.test.ts` keeps
the map honest, and keeps it the same map twice: a bundle installed from a marketplace imports these names at
runtime too, where `src/platform/node/plugins.ts` resolves them to the modules this process is already running, so
a name in one list and not the other type-checks and then fails to load. `./passkeys` was one of these and is not
one any more: `mountWebAuthn` needs the record context slot that only the application fills, so it cannot stand on
a consumer's own router; voidbase's own app mounts the four passkey routes, which is how an instance has them. The official plugin packages (`@voidbase-cloud/plugin-*`, one repository each) re-export the shipped
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

`info(env)` is the other half of the object, and it is optional: what this plugin says about itself on
`GET /api/plugins` under its own name, per env because a binding arrives with the request. It exists because the
answer has to describe what is running. `app.ts` used to call the shipped modules' own functions for those fields,
so a plugin installed under a shipped name shadowed the shipped one at load and the answer went on describing the
module that was not running: the swap was cosmetic. Now the answer is assembled from the plugins that loaded, by
name (`plugins/report.ts`), and a name nothing loaded — or a plugin that says nothing about itself — is simply not
in that part of the answer. The offer is to any plugin: the shipped `installer`, `mail`, `ai`, `translations`,
`domains`, `previews`, `commerce`, `tax-flat` and `shipping-flat` each declare one, and a community plugin under a
name of its own is asked the same way and answers under that name, after those fields and in load order. Two kinds
of plugin are not asked under their own name: one whose `info()` already answers somewhere else in the object (the
`tax@1` and `shipping@1` providers, inside `commerce`), and one whose name is a key of the graph half (`names`,
`providers`, `tiers`, `plugins`, `missingCore`, `origins`, `disabled`), which is left out with a warning rather
than allowed to overwrite it. `payments@1` and `observability@1` answer through their interfaces instead, which is
the older seam and the better one, since what is reported is the provider's whatever the plugin providing it is
called.

Which fields are always in the answer, and which depend on a plugin. **This is a change to what an instance
reports about itself, the first one this route has made, and it lands in the release after 0.9.0-beta.48.** Four
fields are always there. `installer` (where this instance's plugins live) and `mail` (where its mail goes) are the core's own answers: a
plugin loaded under either name answers for it, and when none does — turned off in `voidbase.lock`, or shadowed by
a plugin with no `info()` — the core answers instead, because both are facts about the instance rather than about a
plugin, and our own clients read into them (`voidbase cloud plugins <instance> ls` prints `installer.mode`).
`payments` and `observability` are always there for the older reason: they are answered through an interface, and
an instance with no provider says `{"via":"none"}` and `null` rather than leaving the field out.

Every other field is a plugin's to answer, and is in the answer only while one does. `ai`, `translations`,
`domains`, `previews` and `commerce` were each in the answer of every instance through 0.9.0-beta.48, because
`app.ts` called the shipped module's own function whatever was loaded; now they are there only while a plugin of
that name is loaded **and** declares an `info()`. Turn one off in `voidbase.lock`, or install a plugin over its
name that says nothing about itself, and the field is gone. That is deliberate, and it is what keeps the core from
importing a plugin module to answer for a plugin that is not running, which is the point of the whole seam. Read a
missing field as "no plugin here says", never as "the feature is off": what is loaded is `names` and `origins`,
which is the graph half and is unchanged. A client reading one of these fields has to handle its absence
(`src/cloud/client.ts` types them optional, and the cloud page and `voidbase cloud plugins … ls` each test the
field before reading into it).

Inside `commerce`, `tax` and `shipping` follow the interface instead: the key is there whenever something provides
`tax@1` or `shipping@1`, and a provider with nothing to say about itself is `null`, so replacing the flat-rate pair
— which is what the interfaces are for — cannot quietly change the shape of the answer. Those two providers answer
inside `commerce` rather than under their own names; with no `commerce` loaded to answer inside, they answer under
their own names instead, because every loaded plugin that declares an `info()` answers somewhere in the object,
exactly once.

An `info()` is a plugin's code running inside a superuser's route, and on an instance that installed one it is
community code. So each call is held at arm's length, and so is its answer: one that throws, that rejects, that
does not answer within a second, that answers with something which is not an object, or that answers with
something the route could not have sent — a cycle, a getter or a `toJSON` that throws — becomes `{"error": "..."}`
in that one field and is logged, and the graph half and every other plugin still answer. Each answer is put
through JSON here, on its own, rather than left for the one `c.json()` that serialises the whole object: a value
JSON cannot take would otherwise fail the entire route with a 500 long after the plugin that produced it returned.
What the field holds is the value that came back through JSON, so it is exactly what a reader will be sent.

The tiers are `core` (the instance is not usable without a provider; `CORE` in `resolve.ts` lists `auth@1` since
auth left the core), `official` (ours, versioned with voidbase, opt-in) and `community`.

Removing a core plugin stays possible and is now deliberate rather than accidental. `voidbase plugins remove auth`
refuses without `--yes` and prints what stops working: the core interface it provides, what the instance does
without a provider (it loads, and runs with nobody signed in), and that it reports the gap on `/api/plugins` and
warns once in its log at boot. With `--yes` it goes through and prints the same warning as a line.
`POST /api/plugins/remove` answers `409` with `{ message, core, provides, dependents }` carrying that text, and
proceeds when the body says `"force": true`. The same refusal guards a plugin whose interface another installed
plugin requires (`polar requires payments@1, and only stripe provides it`), naming the dependents. What the check
reads is the graph itself: `/api/plugins` carries `plugins`, each with its `name`, `tier`, a `core` flag and its
`provides` and `requires`, so a panel can say so before it asks. On disk the same answer comes from
`SHIPPED_FACTS` in `plugins/shipped.ts` (the shipped manifests as data, checked against the real ones at boot) and
from each installed plugin's `release.json`.

## The three shapes a feature has taken so far

- **Routes.** `backups` mounts its API on `ctx.app`. Plugins load at module scope under top-level `await` in
  `app.ts`, after the built-in routes and before `pb_hooks` routes, because Hono's default router refuses routes once
  it has matched and cordis applies a plugin on a later tick.
- **A factory over the request's bindings.** `realtime` provides `realtime@1` as `for(env): RealtimeClient`. On
  Workers the HUB binding arrives with each request and not once per isolate, so a service built at load time would
  hold nothing. The per-request middleware puts the client on the context (`c.get("realtime")`), and it answers
  `active()` so the write path knows whether a change has anywhere to go. The slot is guarded like the two below
  (`src/server/realtime-slot.ts`): `using()` answers `undefined` when nothing provides an interface, and this one
  is read on every request, so an instance whose realtime plugin is turned off in `voidbase.lock` or replaced by a
  plugin that does not provide `realtime@1` gets a client that answers `active()` false. Every request is served,
  a write falls back to the D1 change feed as it does without a hub, and `/api/presence` says realtime is off.
  `realtime@1` is deliberately not in `CORE`: an instance without it is a working instance, not a gap to report.
- **Middleware, through a slot.** `hardening` provides `hardening@1`: the body limit, the rate limit and the
  response policy (below). Middleware runs in registration order and the kernel loads after the routes, so a plugin
  cannot `use("*")` for itself; instead `app.ts` keeps the handlers' place in the chain with slots that ask the
  provider at request time, the policy first of all so it lands on every response, errors and files included. No
  provider, no limits and no policy (CORS included); another limiter or another policy is another provider. It
  mounts one route of its own, `GET /api/csrf`, because a token has to be handed back; that one is an ordinary
  plugin route and leaves through the slot like everything else.

### What the core hands a plugin: the slots

The three shapes above are a plugin handing something to the core. The other direction is a slot too, and for the
same reason. `src/server/auth-slot.ts` is how the core asks whoever provides `auth@1` who is signed in;
`src/server/record-slot.ts` is how a plugin asks the core to build the `RecordContext` of a request it is
answering — the database, the storage, who is asking, the collections — which `plugins/auth.ts` needs for the
OAuth2 and flow routes, `src/server/auth.ts` and `src/server/webauthn.ts` for the sessions that same plugin
mounts, and `plugins/seo.ts` for the record behind a page. They all used to reach it with
`await import("../app")` at request time: inside one package a cycle the bundler tolerates, and in a package of
its own a plugin importing the whole application that loads it. `app.ts` fills the slot beside
`provideAuthLookup`, and a context is built per request and never held, because a context is the request's.
`src/server/hooks/index.ts` still imports the app for one and stays as it is: that is the application's own use of
its own module, not a plugin reaching past its package.

All three are published entry points (`@voidbase-cloud/voidbase/auth-slot`, `/record-slot`, `/realtime-slot`) and
all three are in the provided-module list a bundle imports through on Bun, because a plugin in a package of its own
can reach them no other way. The one thing that cannot be packaged is a route that needs the record context and is
mounted outside the application: `src/server/webauthn.ts` is that, which is why `./passkeys` is no longer an entry
point.

### The response policy, hardening's other half

What an instance sends back is a security decision, so it is the plugin's rather than a list of headers in `app.ts`
(`src/server/response-policy.ts`; `hardening@1` exposes it as the `responsePolicy` middleware and `policy(env)`, the
knobs as an env resolves them). Every knob is read from the instance's env on each request, like `VOIDBASE_PRESENCE`,
and every one is off unless set: an instance that sets nothing answers exactly as before. The defaults are
PocketBase's: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `X-Xss-Protection: 1; mode=block`
and `Cross-Origin-Opener-Policy: same-origin` on every response, the strict
`Content-Security-Policy: default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox` on a served
file, CORS at origin `*` with `Authorization` and `Content-Type` allowed, and no CSRF check.

As of 0.9.0-beta.37 the roadmap's list of what was left here is empty: the per-route `Content-Security-Policy`, the
double-submit token for the flows that need one, and the check that reports what an instance is missing rather than
quietly defaulting it are all below.

| Variable | Default | Effect when set |
| --- | --- | --- |
| `VOIDBASE_CORS_ORIGINS` | `*` (unset means `*`) | comma-separated origins. Only a listed origin gets `Access-Control-Allow-Origin` (the matching origin echoed, with `Vary: Origin`); a request from any other origin gets no CORS headers at all. Naming the origins also turns on the CSRF rule below |
| `VOIDBASE_HSTS` | unset | `1` or `true` for one year, or a max-age in seconds: `Strict-Transport-Security: max-age=<n>; includeSubDomains`, on https requests only |
| `VOIDBASE_REFERRER_POLICY` | unset | the `Referrer-Policy` value to send, as given |
| `VOIDBASE_PERMISSIONS_POLICY` | unset | the `Permissions-Policy` value to send, as given |
| `VOIDBASE_CSP` | unset | a `Content-Security-Policy` for every response that is not a served file; a route that set its own (the backups download) keeps it |
| `VOIDBASE_CSP_FILES` | the strict policy above | replaces the `Content-Security-Policy` on served files |
| `VOIDBASE_CSP_ROUTES` | unset | a `Content-Security-Policy` per route: `<path glob>:<policy>` entries separated by `;`, first match wins |
| `VOIDBASE_CSRF` | unset (off) | `double-submit` turns the token on: `GET /api/csrf` answers one, and a cookie request that changes something must repeat it in `X-CSRF-Token` |
| `VOIDBASE_CROSS_ORIGIN` | unset | `1` or `true` adds `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin` beside the Opener-Policy |

**A policy per route.** `VOIDBASE_CSP_ROUTES` is a list of `<path glob>:<policy>` entries. A policy contains commas
and spaces, so `;` separates the entries and `\;` is a literal `;` inside one; the first `:` in an entry splits the
glob from the policy, which is unambiguous because a path never contains one. The glob is matched the way every
other path pattern in voidbase is (`src/server/path-glob.ts`, shared with the hook router's `routerAdd` patterns):
segment by segment, a literal segment matching itself, `:name` one segment, `*` the rest of the path, and a
trailing slash optional. So `/api/files/*` means here what it means in a `_redirects` source or a
`run_worker_first` glob.

```
VOIDBASE_CSP_ROUTES=/api/files/*:default-src 'none'\; sandbox;/admin/*:default-src 'self'
```

**The order a `Content-Security-Policy` is decided in: routes, then files, then the global one.** The first
`VOIDBASE_CSP_ROUTES` glob that matches the path wins, and it wins over both defaults, because naming a path was
the operator's decision and the defaults are not; a served file with no glob naming it gets `VOIDBASE_CSP_FILES`
(the strict policy unless replaced); anything else gets `VOIDBASE_CSP`, and that one alone yields to a policy the
route set for itself. An instance that names no routes behaves exactly as it did before the knob existed.

**The CSRF rule.** Origin `*` is safe while authentication is a bearer token, because nothing a browser sends on
its own carries one; a cookie is sent on its own, which is what a cookie-based auth plugin would expose. So the
check exists exactly when `VOIDBASE_CORS_ORIGINS` is set: a state-changing request (`POST`, `PATCH`, `PUT`,
`DELETE`) that carries a `Cookie` header and whose `Origin` is neither the instance's own origin nor one of the
named ones is refused with 403 and a message naming `Origin` and `VOIDBASE_CORS_ORIGINS`. Without an `Origin`
header, `Sec-Fetch-Site` decides: `same-origin` and `none` pass, `same-site` and `cross-site` are refused, naming
`Sec-Fetch-Site`. A request with neither header passes, since no browser makes a cross-site request without both.
A request without a cookie is never touched, so a bearer-only client is never affected, and neither is any `GET`,
`HEAD` or `OPTIONS`.

**The double-submit token** (`src/server/csrf.ts`), off unless `VOIDBASE_CSRF=double-submit`, is the second line.
The origin rule reads what the browser says about itself, which is the right first line and everything an operator
gets for free; the token is something a cross-site page cannot have. `GET /api/csrf` answers `{ token }` (32 random
bytes, base64url) and sets a cookie holding the same value: `__Host-vb_csrf` on https, `vb_csrf` on http where a
`__Host-` cookie would need `Secure` and no browser would keep it, with `Path=/`, `SameSite=Lax` and deliberately
**not** `HttpOnly`, since the page has to read it to send it back. Every call is a fresh token and a fresh cookie,
so a page that asks twice has rotated its own. A state-changing request (`POST`, `PATCH`, `PUT`, `DELETE`) that
carries cookies must then send that value in `X-CSRF-Token`, compared in constant time; a missing header, a
mismatched one, or cookies with no token cookie at all is refused 403 with a reason naming the header. While the
knob is off the route answers 404, since the knob is read per request and the routes are fixed when the app is
built.

**What is exempt, and why.** A request authenticated with an `Authorization` header is never subject to the token
rule: a browser attaches cookies on its own and never attaches a bearer token on its own, so a header-authenticated
request cannot be forged cross-site. That is what the SDK sends, so turning the knob on changes nothing for an SDK
client and everything for a cookie one. Neither is a request with no `Cookie` header at all (there is no session to
forge against), nor any `GET`, `HEAD` or `OPTIONS`.

**And what makes it necessary: `VOIDBASE_AUTH_COOKIE`.** Everything above is written as a defence a
bearer-only instance does not need. The knob that changes that is the Void adapter's (`docs/adapter.md`,
"One session across the pages and the API"): with it, voidbase sets the auth token as a cookie and accepts
that cookie as the token, so a page rendered on the same Worker knows who is asking. It refuses to take
effect unless one of the two rules above is on — `VOIDBASE_CORS_ORIGINS` naming the origins, or
`VOIDBASE_CSRF=double-submit` — failing the deploy and, on an instance configured some other way, refusing
at request time with the reason rather than opening the hole quietly.

**Reading an instance from outside: `voidbase check --security <url>`** (`src/node/security-check.ts`). A handful
of reads against a running instance, one line each, `pass` / `warn` / `fail` with the one thing to set: the
security headers (`X-Content-Type-Options`, the frame and opener policies, HSTS on https, `Referrer-Policy`,
`Permissions-Policy`, the cross-origin trio), the `Content-Security-Policy` and, with `--file <a served file>`,
whether the files' one is `default-src 'none'`, the CORS answer an unlisted origin gets and whether credentials
ride a wildcard (which is the dangerous combination, and the one that fails), the attributes of any cookie it saw
set, a rate-limit spot check (a small burst to one cheap route, looking for a 429: a spot check, not proof), what
`/api/health` tells a stranger, and whether either CSRF rule is on. It exits 1 when anything failed, `--json`
prints the same as data, and it only ever reads: `GET`, `HEAD` and `OPTIONS`, no credentials, no sign-in.

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
panel uses, table and all, once, when it is missing; when it exists, a newer definition is reconciled forward (a
field, an index or a rule the plugin now declares is added; nothing the instance has is dropped, so a column with
data in it survives a plugin update: `reconcileDefinition`). The kernel runs every plugin's bootstrap after voidbase's own
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
until `--marketplace` says which, the same rule the loader applies to two providers of one interface. `--marketplace`
may also name a marketplace the project has never used: the command runs on the owner's own checkout, and the
marketplace it records on the plugin's entry is one the instance's installer then trusts for that plugin (the installer, below).

An instance reads the same files when it starts. On Bun (`voidbase serve`, a local instance, the executable)
`src/platform/node/plugins.ts` verifies every bundle against the lockfile, refuses a changed byte by name, and imports
the bundles with their bare imports (`@voidbase-cloud/voidbase/*`, `hono`) resolved to the modules the process is
already running, which is what lets a bundle load inside the executable, where there is no node_modules. On Workers
`hooks-plugin.ts` generates `virtual:voidbase-plugins` at build time from the same verification, so a mismatch fails
the build rather than the instance. `app.ts` then loads what ships minus what the lockfile turned off minus what an
installed plugin shadows by name, plus the installed ones, as one graph, and `/api/plugins` says where each came
from (`origins`) and what is turned off. That name filter is the whole swap path, and it now reaches the answer
too: the per-plugin fields of `/api/plugins` are each loaded plugin's own `info(env)`, so a plugin installed over a
shipped name answers for that name instead of being described by the module it replaced.

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
and `GET /api/plugins/available?marketplace=` for what the official marketplace, or another named by URL, serves
(superusers, like `/api/plugins`, which now says where the plugins live under `installer`). Three places they can
live, and the installer knows which:

| mode | where | what a change is |
| --- | --- | --- |
| `filesystem` | Bun: `voidbase serve`, the executable | `pb_plugins/` and `voidbase.lock` changed in place, as the CLI does; the instance loads them when it restarts |
| `repository` | a project deployed from a repository: `VOIDBASE_PROJECT_REPO` (owner/name, `VOIDBASE_PROJECT_BRANCH` if not master) and `VOIDBASE_GH_TOKEN` on the Worker | one commit to the repository (`src/server/project-sync.ts`: the bundle downloaded and verified in the instance, `pb_plugins/<name>/{bundle.js,release.json}` written or deleted, the lockfile entry added or removed, through GitHub's Git Data API), which the repository's own build deploys |
| `fixed` | a Worker built without either | nothing: the answer says what to connect |

A marketplace named in a request has to be one the project already trusts: one its `voidbase.lock` lists under
`marketplaces`, or, for a plugin already installed, the one it came from (the `marketplace` on its own lock entry,
which is also where `update` looks); a marketplace on one plugin's entry does not cover a plugin of another name. Anything else is a 400 before the marketplace is asked for anything and before a commit is made or
a file is written, and the answer names the lockfile and the two ways to trust it. In `filesystem` mode the list is
the one `voidbase plugins ls` prints, which `VOIDBASE_PLUGIN_MARKETPLACES` replaces when it is set. URLs are compared
whole, after trimming and dropping trailing slashes, so `https://listed.example/x`,
`https://listed.example.evil.example` and `https://listed.example@evil.example` are not `https://listed.example`.

The rule is there because of what an installed plugin is. The integrity hash comes from the same index as the
bundle, so it proves the bytes are the ones that marketplace promised and says nothing about whether the project
wanted that marketplace; the plugin runs with the Worker's env, which holds every secret, and its `deploy.js` runs
in the build with the deploy token. A superuser session is not the project's owner (the demo publishes its login),
so a marketplace is trusted where the owner works, and no command edits the `marketplaces` list. Either add the URL
to it in `voidbase.lock` and commit that (on disk, save the file), or install a plugin from it on a checkout with
`voidbase plugins add <name> --marketplace <url>`, then commit `pb_plugins/<name>` and the lockfile and push, which
records the marketplace on that plugin's entry. That trusts it for that plugin alone, and only until the plugin is removed. `voidbase cloud plugins
<instance> install --marketplace` reaches this route and is held to the rule; `voidbase plugins add` on the owner's
own checkout is not, which is what makes it one of the two ways in.

`GET /api/plugins/available` lists the official marketplace, and `?marketplace=` reads another by URL, so the /cloud
panel can show what a marketplace serves before its owner trusts it. Reading installs nothing, and an install from
that marketplace is still held to the rule above.

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
one). Served `Cache-Control: public, max-age=3600`. The record is found the way the meta route finds it, through
the first sitemap entry naming the collection, its filter, and the caller's list rule. `image` in the meta answer
(so `og:image` and `twitter:image`) is this URL whenever no image field is mapped or the record has no file in it,
so every page has a share image without one being uploaded.

**`VOIDBASE_SEO_PNG=1`: the card as a PNG.** No social scraper renders SVG. Slack, Twitter/X, LinkedIn, Discord
and Facebook all drop an `og:image` they cannot decode, so an SVG card is a card nobody sees. `<id>.png` hands the
same SVG to resvg (`@resvg/resvg-wasm`, the Rust rasteriser, pinned at 2.6.2) behind `#platform/raster`: a wasm
module import the Workers build bundles on Cloudflare, the same wasm read off disk on Bun, imported on the first
`.png` and instantiated once per isolate.

It is **off by default**, because that rasteriser is 2.4 MB of wasm and adds about 1.04 MB to the *gzipped* Worker
(1.01 MB to 2.05 MB, against Cloudflare's 3 MB free-plan ceiling), which is not a bill to hand an instance that
serves no share card, or a third of the free plan's room to take from the app next to it. The knob is read at
build time and at runtime, and both halves have to agree:

- **build:** the hooks plugin (`pbHooksPlugin`, `hooks-plugin.ts`) aliases `#platform/raster` to a stub that
  answers `null` unless `VOIDBASE_SEO_PNG` is on, so with the knob off neither resvg's wasm nor the card's font is
  in the bundle at all. `voidbase deploy` reads the knob from the environment or `pb_secrets/secrets.json` (the
  way it reads `VOIDBASE_AI` and `VOIDBASE_MAIL_DOMAIN`), writes `seoPng: true` into the generated project's
  `vite.config.ts`, and says in the plan which of the two you are getting. A project that calls `pbHooksPlugin`
  itself gets the same from `VOIDBASE_SEO_PNG` in the build's environment, or the `seoPng` option.
- **runtime:** the same deploy bakes `VOIDBASE_SEO_PNG=1` as a Worker var, and the plugin reads it from the
  request's env then the runtime's, like every other seo knob. On it rasterises and `og:image` names the `.png`;
  off it does not even ask the rasteriser, and `og:image` and `twitter:image` name the `.svg`, because pointing a
  scraper at a PNG this build cannot render would be worse than naming the SVG.

Either way `.png` is a real URL: when the knob is off, or the rasteriser cannot load, or it will not parse the
SVG, it answers the **SVG body** with `Content-Type: image/svg+xml` and `X-Voidbase-Card: svg-fallback`, and logs
a warning. One URL is right on every platform, and a share image is never worth a 5xx. It answered 406 before
this, which put the failure in front of the crawler instead of behind a header. On Bun nothing is bundled or
stripped, so the knob there is only the runtime half: set it and `voidbase serve` answers PNG.

**The card's fonts.** A Worker has no system fonts, and resvg with no font renders blank text, so the card carries
its own: Inter (SIL Open Font License 1.1), subset to ASCII, Latin-1's printable half and the punctuation the card
itself emits, pinned to two static weights (400 for the app name and the description, 700 for the title). The two
faces are 80 KB each and live base64-encoded in `src/server/plugins/og-font.ts`, which is **generated and
committed**: `bun scripts/og-font.ts` rewrites it from google/fonts at one pinned commit, and
`bun scripts/og-font.ts --check` fails when the committed file is not what the script produces. No build reaches
the network for it. They ride in the same lazy chunk as the rasteriser, so the knob leaves them out too. The SVG
names `Inter` first and keeps the generic system stack behind it, so a browser that fetches the `.svg` still gets
something.

**What a card costs.** One rasterisation is about 20 ms of CPU on workerd, and about 60 ms the first time in an
isolate (the wasm instantiation and building the font database, paid once). That is inside a Worker's CPU budget
but it is not free, which is what `Cache-Control: public, max-age=3600` and the `ETag` are for: a crawler that
comes back within the hour, or with the right `If-None-Match`, costs nothing. The bundle is the other half of the
price, and the table in docs/platform.md is the one to decide on.

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
`rasterize(svg)` is the seam the PNG goes through: the default one calls `#platform/raster` at 1200x630, a test
hands in one that returns bytes, or `null` to exercise the SVG fallback. The real rasteriser runs under
`bun test` too, so the PNG route is measured against an actual PNG (its signature and the width and height in its
IHDR chunk), not a stand-in. Both states of `VOIDBASE_SEO_PNG` are tested there, and the deploy's half of it in
`test/deploy-cf.ts`.

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
scoped to whoever is asking. It is the roadmap's "Workers AI and Think, as official plugins" in voidbase's own
terms: the chat, and its memory as records rather than as a Durable Object. `POST /api/ai/chat` takes
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
steps have run, after which the answer says it stopped. This route does not stream: Workers AI streams a call's
text, but a call that streams cannot also hand back `tool_calls` to act on, so `stream: true` is refused here with
that reason and points at the conversation route below, which streams the final answer the way Cloudflare's helper
does.

**The cap.** 30 requests per minute per caller (the signed-in record, else the client IP), counted in memory, so per
isolate: the hardening plugin's rate limits are the settings' rules keyed by path, which a superuser can add one for
(`POST /api/ai/chat`), and the deploy's `RATE_LIMITER` ceiling applies on top; this cap is the floor that is there
without any settings, because every call is metered. `test/unit/ai.test.ts` scripts a fake `AI` binding per test:
the tool list per caller, the loop feeding a result back, the runaway stopped, the 503, the plugins field, the cap.

**A conversation is a record.** The plugin owns two collections, created at bootstrap on the first request that
carries the binding (the way the payment plugins create theirs), so an instance without the knob never sees them:
`ai_conversations` (`user` relation to `users`, optional, `title`, `model`, `system` text, `tools` bool,
`lastMessageAt` date) and `ai_messages` (`conversation` relation, required, cascade, `role` select user, assistant,
tool or system, `content` text, `steps` json, `tokens` number). Their rules are the owner's: a signed-in user lists,
views and deletes their own conversations (`owner = @request.auth.id`: the auth record's id whichever auth collection it is in, so a superuser owns conversations too; `user` is the relation to `users` when the owner is one) and their messages
(`conversation.owner = @request.auth.id`) through the records API like any collection, in the panel included; create
and update rules are superuser-only, so the routes below are the way in. Anonymous callers keep `POST /api/ai/chat`
and get no persistence. Every write goes through the records service as a superuser, so hooks fire and realtime
publishes: a client subscribed to `ai_messages` (or to one conversation's messages by filter) sees the user message
land, then the reply, without polling, which is what the SDK's conversation helper should do instead of asking
again. `GET /api/plugins` says `ai: { via: "workers-ai", model, conversations: true }` once the collections exist.

**The routes**, all for a signed-in caller (anonymous is 401):

- `POST /api/ai/conversations` `{ title?, model?, system?, tools? }` answers the conversation record; `tools`
  defaults to true, `model` to the binding's, the title is cut to 60 characters and may be left empty.
- `GET /api/ai/conversations` lists the caller's, newest first by last message, paginated like records
  (`?page=&perPage=`, answering `{ page, perPage, totalItems, totalPages, items }`).
- `GET /api/ai/conversations/:id` answers the conversation with its `messages`, oldest first. Somebody else's is a
  404, not a 403.
- `POST /api/ai/conversations/:id/messages` `{ content, maxSteps?, stream? }` stores the user message, runs the
  same loop as `/api/ai/chat` over the conversation's history (the system prompt, the conversation's own `system`,
  then its last 40 stored messages, the new one included, with the conversation's `model` and `tools`), stores the
  assistant reply with its `steps` and, when the model reports usage, its `tokens`, sets `lastMessageAt` and, when
  the title is empty, the title from the first user message, and answers `{ message, steps, model, conversation }`
  where `message` and `conversation` are the records as stored.
- `DELETE /api/ai/conversations/:id` removes it and its messages (204).

The cap is the chat's, 30 a minute per caller across both routes. `test/unit/ai-conversations.test.ts` runs the
routes over in-memory rows and one instance on bun:sqlite, where the bootstrap creates the two collections, a turn
is two rows through the records service and a delete takes the messages with the conversation.

**Streaming.** `stream: true` on the messages route answers `text/event-stream`. The loop runs the tool steps first,
each call answered whole, then one last call is made with `stream: true` and no tools, which is what Cloudflare's
`runWithTools` does with `streamFinalResponse` (the overload `@cloudflare/workers-types` declares as answering a
`ReadableStream`; without tools that one call is the only one). Workers AI's chunks (`data: {"response": "..."}`,
then `data: [DONE]`, read the way Cloudflare's `workers-ai-provider` reads them) are forwarded as
`data: {"delta": "..."}` events, and when the stream ends the full text is stored as the assistant message (the
store is also handed to `waitUntil` on Workers, so a client that leaves early does not lose it), followed by one
`data: {"done": true, "message", "steps", "model", "conversation"}` event. A failure mid-way is a
`data: {"error": "..."}` event and nothing is stored.

**What Think is today (checked 2026-09-11).** Cloudflare ships Think as part of the Agents SDK: the docs live at
https://developers.cloudflare.com/agents/harnesses/think/ ("Opinionated chat agent framework with built-in tools,
persistent memory, lifecycle hooks, streaming, messengers, scheduled tasks, Workflows, and sub-agent RPC"), the
package is `@cloudflare/think` on npm (0.17.0 at the time of writing, from github.com/cloudflare/agents, with
`npm create think` to scaffold one). A Think agent is a Durable Object class that extends `Agent`, keeps its messages
in the object's SQLite, speaks the `cf_agent_chat_*` WebSocket protocol to `useAgentChat`, runs the model through the
AI SDK (Workers AI via `workers-ai-provider`, or any provider), and can be driven as a sub-agent over RPC. That is a
different persistence from this plugin's, by design: a conversation here is a record, gated by the rules, expanded,
filtered, subscribed to and backed up like any other, and the tool list is the MCP server's for the caller's token.
A Think-based plugin (the panel chat, the preview chat, the app-mounted one the roadmap names) would sit on the same
loop and the same tool list; it is not built, and the Durable Object it needs is not part of this package.

## Seeing what the instance is doing: observability

`observability` is a shipped plugin (tier `core`, `src/server/plugins/observability.ts`) and the second core plugin
after auth. Core for the roadmap's reason: an instance you cannot see into is one you cannot operate. A plugin for
the other half of that reason: somebody who would rather send all of this somewhere else removes ours and provides
`observability@1` from theirs, rather than forking the server.

It is three things, and they stay three.

**The Worker's own logs, turned on at deploy.** `VOIDBASE_OBSERVABILITY=1` is the default (unset means on; `0`,
`false`, `off` and `no` mean off), so `voidbase deploy` writes `observability: { enabled: true,
head_sampling_rate: <VOIDBASE_OBSERVABILITY_SAMPLE, default 1> }` into the generated `wrangler.jsonc`. Those are
the two fields Cloudflare's configuration documents today (checked 2026-09-11,
https://developers.cloudflare.com/workers/wrangler/configuration/): `enabled` persists this Worker's logs, and
`head_sampling_rate` is a number between 0 and 1. Invocation logs, which carry the request and the response of
every invocation, are on by default and only need `observability.logs.invocation_logs: false` to turn off
(https://developers.cloudflare.com/workers/observability/logs/workers-logs/), so nothing is written for them. The
names both halves agree on live in `src/server/plugins/observability-binding.ts`, the way the ai plugin's do, so
the deploy imports no kernel to write the field.

**The request path, sampled.** The plugin provides `observability@1`, whose `sample` is middleware `app.ts` holds a
place for: the kernel loads after the routes are mounted, so a plugin cannot `use("*")` for itself (the same slot
hardening's three handlers go through). When `LOGS_ANALYTICS` is bound (`voidbase deploy --analytics`) it writes one
Analytics Engine data point per request:

| | |
| --- | --- |
| `blobs` | the matched route (`/api/collections/:collection/records/:id`, taken from Hono's matched routes, so a million record ids are one row rather than a million), the method, the status class (`2xx`, `4xx`, `5xx`), and the collection when the route names one |
| `doubles` | the duration in milliseconds, and the response size in bytes when the answer declares a `Content-Length` (0 when it does not: nothing is cloned or buffered to find out) |
| `indexes` | the route, which is Analytics Engine's sampling key and the one index it accepts |

A path that matched no route, and a `pb_hooks` route (they are all dispatched from one `all("*")`), is recorded as
the request path with its ids collapsed: `/orders/8f14e45fceea167` becomes `/orders/:id`. `VOIDBASE_OBSERVABILITY_SAMPLE=0.1`
records a tenth of requests, and the same number is the Worker's `head_sampling_rate`, so one knob lowers both.
Writing a data point can never fail a request: a binding that throws is caught, logged once per isolate, and the
request answers as if nothing happened.

The duration is elapsed time as the Worker can observe it, and Cloudflare freezes the clock inside one: "the value
returned by `Date.now()` is locked in place while code is executing... `Date.now()` returns the time of the last
I/O" (https://developers.cloudflare.com/workers/reference/security-model/). So it measures a slow endpoint, which
is I/O, and does not measure CPU.

**The numbers, behind the superuser.** Three routes, all superuser-only (401 for anonymous, 403 for a signed-in
record):

- `GET /api/observability/summary?window=hour|day` answers `{ source, window, requests, errors, rate, p50, p95,
  p99, slowest: [{ route, p95, count }], statuses: { "2xx": n, ... } }`, where `rate` is the share of requests that
  answered 5xx and `slowest` is the five routes with the highest p95.
- `GET /api/observability/errors?since=<ISO date>&window=hour|day` answers `{ source, since, items, totalItems }`:
  the request log filtered to 5xx answers and to the exceptions the instance recorded, newest first, up to 200.
- `GET /api/observability/logs?since=<ISO date>&level=<-4|0|4|8>&window=hour|day` answers `{ source, since, level,
  items, totalItems }`: the same log, filtered by level, `data` parsed the way `/api/logs` parses it.

**The two sources, and why the answer says which one it used.** The summary queries Analytics Engine's SQL API,
`POST https://api.cloudflare.com/client/v4/accounts/<account_id>/analytics_engine/sql` with the SQL as the request
body and `Authorization: Bearer <token>` (https://developers.cloudflare.com/analytics/analytics-engine/sql-api/,
checked 2026-09-11), when both `VOIDBASE_OBSERVABILITY_ACCOUNT_ID` (or the `VOIDBASE_ACCOUNT_ID` the deploy already
bakes) and `VOIDBASE_OBSERVABILITY_TOKEN` are set. The token needs Account Analytics | Read, and it is a secret. Give it a token that has only that permission, not the deploy token: this token lives in the Worker's env at runtime, where every plugin the instance runs can read it, and a deploy token in that place can rewrite every Worker, database and secret on the account:
declare it in `pb_secrets` or push it with `VOIDBASE_DEPLOY_SECRETS`, never as a var. Counts are
`SUM(_sample_interval)` and percentiles are `quantileWeighted(q, double1, _sample_interval)`, which is how that page
and the aggregate functions page say to read a downsampled dataset; our own sampling is a second factor the dataset
knows nothing about, so counts are scaled by `1/rate` here, exactly right while the rate has not changed inside the
window. Then `source: "analytics-engine"`.

Without those two, or when the SQL API refuses, the summary answers from the D1 request log voidbase already keeps
(`_logs`, `src/server/logs.ts`) and says `source: "request-log"`. That is the honest half of the design: the
fallback is always there, and it is not the same population. `_logs` keeps a row per request only at or above
`max(settings.logs.minLevel, VOIDBASE_LOG_MIN_LEVEL)`, and the Workers default is 4, which is warnings and errors.
So on an instance deployed without `--analytics` the summary is about what went wrong rather than about everything
that happened, and `source` is how a caller knows. The `/errors` and `/logs` routes read only that log.

Workers Logs does have a public read API, and it is not one a Worker can use on itself: the account-scoped `POST
/accounts/{account_id}/workers/observability/telemetry/query`
(https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/),
which needs the same kind of account id and token the summary treats as optional. It is the natural second source
for `/logs` and it is not wired up: the request body was not pinned from the docs, and a guessed query shape would
be worse than not having one.

**Hook CPU is not measured, and that is a decision.** The roadmap's fourth number is "which hooks are costing the
CPU". The hooks run in the same isolate and `src/server/hooks/runtime.ts` `trigger` is the single place every
`pb_hooks` handler is dispatched from, so timing around it is reachable. The number would be a lie: the clock is
frozen between I/O (the link above) and there is no CPU-time API inside a Worker, so any in-isolate timing around a
hook measures how long it waited rather than what it cost. So `hooks` stays an optional field of the summary that
nothing fills, rather than a number that looks like an answer. Cloudflare's own dashboard has per-invocation CPU
time; attributing it to a hook needs something the runtime does not expose today.

**Without anything bound** the plugin still loads, because it is core and an instance must not fail to start over
it: nothing is sampled, the summary answers from the request log, and `GET /api/plugins` reports
`observability: { via: "analytics-engine" | "request-log", sampling: <0..1>, logs: <whether the request log is
being written at all> }`. `test/unit/observability.test.ts` runs the sampler through the same slot `app.ts` holds,
with a `writeDataPoint` spy, a stubbed SQL API and the bun:sqlite request log; `test/deploy-cf.ts` checks the
generated config with the knob, with a lowered rate and with the knob off.

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
instance").

**The two halves around it, neither of them this plugin's.** Interface strings, the text written in the app rather
than stored in a collection, are `voidbase i18n extract`: it scans the project's source for `t("key")` (and
`i18n.t("key")`, and a default as the second argument), writes `i18n/<locale>.json` per locale and `i18n/keys.d.ts`,
the union of the keys, so a client typed against it turns an unknown key into a compile error instead of showing a
key to a reader, and `--check` exits 1 when a key has no text in some locale, which is the build gate the roadmap
asked for ([setup.md](setup.md)). A locale in the route is the Void adapter's `locales` option: the `hreflang`
links and `<html lang>` on every prerendered page, built from the same functions the sitemap's alternates are so
the two cannot disagree, and with `path: "prefix"` the `_redirects` rules that send `/<code>/<path>` to the same
page with `?locale=<code>`, which is the address this plugin negotiates on first. Both are build time and add no
runtime at all, and the codes have to be `VOIDBASE_LOCALES` when both are set or the build stops with both lists
([adapter.md](adapter.md)). What is left is the panel screen over the reports.

## Taking money: stripe, polar, lemonsqueezy

Three shipped plugins (tier `official`) take money through `payments@1`: `stripe` (`src/server/plugins/stripe.ts`),
`polar` (`polar.ts`) and `lemonsqueezy` (`lemonsqueezy.ts`). They are the roadmap's "Payment providers, as official
plugins": one plugin per provider, all providing the same interface, each owning its webhook route, verifying
signatures, and writing customers, subscriptions and payments into collections the app queries like any other.
Each talks to its provider with `fetch` alone, no SDK, and each file holds only what differs: its knobs, its API
calls, its signature check, and its event names read into the same rows. Everything else is
`src/server/plugins/payments-shared.ts`.

**What is shared** (`payments-shared.ts`). The three collections and their rules, created by `ensureCollections`
at kernel bootstrap on the first request that carries a provider's key, each with `created` and `updated`
autodates and a unique index on the provider id:

- `customers`: `user` (relation to `users`, optional), `provider` (text: `stripe`, `polar` or `lemonsqueezy`),
  `providerId` (text, the provider's customer id), `email` (text). Rules: list and view `user = @request.auth.id`;
  create, update and delete superuser only.
- `subscriptions`: `customer` (relation), `providerId`, `status` (select: `incomplete`, `incomplete_expired`,
  `trialing`, `active`, `past_due`, `canceled`, `unpaid`, `paused`), `price` (text: the price, product or variant
  the subscription is for), `currentPeriodEnd` (date), `cancelAtPeriodEnd` (bool). Rules: list and view
  `customer.user = @request.auth.id`; writes superuser only.
- `payments`: `customer` (relation), `providerId`, `amount` (number, the minor unit), `currency` (text), `status`
  (select: `pending`, `succeeded`, `failed`, `refunded`, `canceled`), `subscription` (relation, optional), `raw`
  (json, the provider's object). Same rules as subscriptions.

So a signed-in user reads their own rows through the records API and realtime like any other collection, and
nothing writes them but the plugins, through the records service as a superuser (`d1Rows`), so hooks fire and the
rows look like the panel wrote them. Every write is an upsert by `providerId` (`ensureCustomer`, `upsert`), which
is what makes a provider's retries and a replayed webhook a no-op rather than a duplicate. Also shared: the
customers row behind a signed-in user (`customerForUser`: found by `provider` and `user`, or created at the
provider on the first contact), the four routes under `/api/payments/<provider>/` and their checks (`paymentsPlugin`
mounts them given a `PaymentProvider`), the `Payments` implementation served as `payments@1`, and the `payments`
field of `GET /api/plugins`. A fourth provider is a `PaymentProvider` and a call to `paymentsPlugin`; the package
exports `./plugins/payments-shared` for one written outside voidbase.

**The interface.** `payments@1` takes the env on every method, because the keys arrive with the request:
`route(env)`, `checkout(env, { customer, items, amounts?, currency?, success, cancel?, mode?, reference? })`,
`checkCheckout(env, { items, amounts?, currency?, success, cancel?, mode?, reference? })`, `portal(env, { customer, return })`,
`webhook(env, request)` and `cancel(env, subscription, { now?, resume? })`. `customer` and `subscription` are ids
of the plugin's own rows, never the provider's ids: the app talks about its rows and the plugin translates. The
routes below call the same code.

**What a checkout charges.** `items` are prices the provider already knows, by its own id. `amounts` are lines
`{ name, amount, currency }` that carry their own amount in the currency's minor unit, for what has no price at the
provider because it was computed a second ago: commerce's tax and shipping. A checkout with a `reference` is charged in
full or refused: every item at its quantity and every amount line, or a 400 before anything is created at the
provider. A checkout without one is charged in full or refused as well, but at Polar, which lists the products it is
given for the buyer to pick among and charges the one picked, once, whatever quantity it was sent; such a checkout
names no order, so it moves no order of commerce's. Stripe charges amount lines. Polar and Lemon Squeezy, as
implemented, refuse them, with a reference or without one. Lemon Squeezy takes one item, a numeric variant with its
quantity, and Polar, for a checkout with a `reference`, one product with a quantity of 1. An amount line that is not
a name, a whole number above zero and a three-letter currency is 400 whichever provider is active. `currency` is the
currency the caller priced the checkout in (commerce passes its cart's): Polar is sent it, lower-cased, for a checkout
with a reference, so that it does not show the buyer a price in their own currency, and Stripe and Lemon Squeezy
ignore it. `reference` is the caller's own id for what is being paid for (commerce's order id). The provider carries it
in its metadata as `voidbase_order`, it comes back on the object the webhook writes into the `payments` row's `raw`,
and `paymentReference(raw)` in `payments-shared.ts` reads it back whichever provider wrote the row. Any plugin
calling `payments@1` can give a reference, so it says which order a payment claims to pay and proves nothing;
commerce holds it against the amount paid (below). A checkout with a reference is paid only by its whole total, so
Polar refuses a second product or a quantity above 1 for it, and Polar and Lemon Squeezy offer its buyer no discount
code. The routes never read `amounts` or `reference` from a request body: a browser that names its own amounts sets
its own price, and one that names an order could pay somebody else's.

**What a payment charged before the provider's tax.** Polar and Lemon Squeezy are merchants of record: they add their
own tax to what a checkout asks for, and the `payments` row's `amount` includes it (Polar's `total_amount`, Lemon
Squeezy's `attributes.total`). `chargedBeforeProviderTax(payment)` in `payments-shared.ts` reads what the provider
charged before that tax off the row's `raw`, whichever provider wrote it: Polar's `net_amount` ("after discounts but
before taxes"), which is the price only when the price was tax-exclusive (see polar), or its `total_amount` when the
object says `tax_behavior: "inclusive"` (a Polar order carries no `tax_behavior` in the 2026-04 document; a checkout
does, and it is read when a payload has it), and never whichever of the two matches; Lemon Squeezy's `total` less its
`tax`, or the `total` when `tax_inclusive` is true; and otherwise the row's `amount`, which for Stripe is what it was
asked to charge, since nothing asks Stripe to add a tax of its own. An object of a shape it reads whose figure cannot
be read is `NaN`, which is no order's total, rather than the row's `amount`, which holds the provider's tax: a Polar
object with `total_amount` or `tax_amount` and no number for the figure it is compared by, a Lemon Squeezy `total`
that is not a number, or a `tax` beside it that is there and not a number while `tax_inclusive` is not true.

**What a payment bought.** A reference says which order a payment claims to pay and proves nothing: at Lemon Squeezy
any checkout URL takes `?checkout[custom][voidbase_order]=...`, and it comes back on the webhook as
`meta.custom_data`, so a buyer can name somebody's pending order on an order of their own for another variant.
`purchasedItems(payment)` in `payments-shared.ts` reads what a payment bought off the row's `raw`, each item by the id
a checkout names it by at that provider, and its quantity where the provider reported one: Lemon Squeezy's
`attributes.first_order_item` (`variant_id`, and `quantity` only when it is there and a whole number above zero, since
the docs' own order object lists no `quantity` at all and Lemon Squeezy's SDK types one as "Not in the documentation,
but in the response"), and Polar's order `product_id`, once, since Polar charges a product once whatever quantity it is
sent; that field is nullable at Polar, and when it is null the products the order's `items` name are read instead. It
is `null` at Stripe, which reports no purchase on a payment: a session's line items are a call of their own, neither
`checkout.session.completed` nor a `payment_intent.*` event carries them, and a session's metadata is set only by
whoever creates it with the secret key, so no buyer can name an order on money of their own. It is `null` at Polar as
well for an order that names a product nowhere, since a line item in the 2026-04 document carries `product_price_id`
and no `product_id`. `null` is not `[]`: an object of a provider that does report purchases and in which none could be
read is `[]`, which is no order's lines; and a quantity nobody reported is left off the item rather than reported as
`NaN`, which was no order's line either and left a fully paid Lemon Squeezy order pending for good.

**Two checks, and only one of them is the interface's.** A `PaymentProvider` refuses what it cannot take through two
optional hooks. `checkCharge(o)` is what the provider cannot charge in full (an amount line; a second item at Lemon
Squeezy; at Polar, when the checkout has a `reference`, a second item or a quantity above 1); the provider's route and
`payments@1` both make it, through `checkChargeFor`, which checks the amount lines' shape first. `checkCheckout(o)`
is the route's own rule about the body it was posted, such as Stripe's that `cancel` is given, and only
`POST /api/payments/<provider>/checkout` makes it: a plugin calling `payments@1` did not use the route and is not
held to its rules (they were split on 2026-09-11, when making both through the interface turned a commerce checkout
on Stripe without `cancel` from a 200 into a 400).
`payments@1`'s optional `checkCheckout(env, o)` is the charge check on its own, the one `checkout` makes first,
without starting anything, so a caller can refuse before it does work of its own (commerce refuses a cart before it
writes the order). It is optional on the interface, like `refund`.

**The knobs are secrets**: declare them with `secret(...)` in `env.ts` so they live in `pb_secrets`/`vb_secrets`
and reach the Worker as encrypted secrets, never as vars. A plugin reads them from the request env first and the
runtime env second, like mail's domain. Without its key a plugin is loaded and idle: `route(env)` is null, every
route answers 503 naming the knob, and the collections are not created.

**One active provider.** The loader refuses two plugins providing one interface, and it checks at load, when the
keys are not known: on Workers they arrive with the request. So the three cannot each claim `payments@1`, and none
can claim it only when its key is set. They are one provider from the loader's point of view instead: `stripe`,
first in the shipped order, claims `payments@1` and owns the three collections (the loader refuses two owners as
well); `polar` and `lemonsqueezy` require `payments@1` and join stripe's family when they are applied. The
`Payments` served is a dispatcher over the family: per request it answers for the first provider in shipped
order (stripe, polar, lemonsqueezy) whose key these bindings carry. With no keys `GET /api/plugins` says
`payments: { via: "none" }`; with one key `{ via: "polar", webhook: "/api/payments/polar/webhook", livemode }`;
with two keys the first wins and `/api/plugins` says which and why:
`{ via: "polar", ..., also: ["lemonsqueezy"], reason: "LEMONSQUEEZY_API_KEY is set too; polar answers because it
comes first in the shipped order ..." }`, and the routes of the provider that lost answer 409 so nothing is taken
through a provider that is not the active one. Changing provider is therefore changing which key is set; the rows
keep their shape, with `provider` saying which. What follows from the family: `whatLoaded().providers` names
`stripe` whatever key is set, and disabling `stripe` in `voidbase.lock` refuses `polar` and `lemonsqueezy` at load
(`polar requires "payments@1" and nothing installed provides it`). To not use Stripe, leave its key unset.

**The routes**, the same four under each `/api/payments/<provider>/`:

- `POST checkout`, signed-in user. Body `{ items: [{ price, quantity }], success, cancel?, mode?: "payment" |
  "subscription" }`; `amounts` and `reference` in a body are not read. Checks the body against the provider first
  (the route's own rules, `checkCheckout`, then what the provider can charge, `checkCharge`), then finds the user's
  `customers` row or creates the customer at the provider and the row, then starts a checkout. Answers `{ url }`.
  What `price` means, and whether `cancel` and `mode` are read, is the provider's (below).
- `POST portal`, signed-in user. Body `{ return }`. Where the user manages their billing. `{ url }`.
- `POST cancel`, the subscription's owner or a superuser. Body `{ subscription, now?, resume? }` (a
  `subscriptions` row id). Cancels at the period's end by default; `now: true` ends it at once where the
  provider offers that; `resume: true` takes a period-end cancellation back. The row follows at once; the webhook
  confirms later. Answers `{ subscription, status, cancelAtPeriodEnd }`.
- `POST webhook`, no auth. Register `https://<instance>/api/payments/<provider>/webhook` at the provider and put
  its signing secret in the plugin's webhook knob. A bad, missing or (where there is a timestamp) stale signature
  is 400 and nothing is read; without the secret the route is 503 rather than accepting anything. An event the
  plugin does not read is 200 and ignored (`{ received: true, handled: false }`).

A provider's error comes back as 400 with its message (`Stripe answered 402: Your card was declined`), an outage
as 502. Each plugin's test (`test/unit/stripe-plugin.test.ts`, `polar-plugin.test.ts`,
`lemonsqueezy-plugin.test.ts`) measures the signature check, the three routes against a fake `fetch` (URL, method,
auth header, body), every event against in-memory rows, the replay, and the no-key state;
`test/unit/payments-shared.test.ts` measures the family, which of a provider's two checks its route and
`payments@1` each make, what `paymentReference`, `chargedBeforeProviderTax` and `purchasedItems` read off each
provider's objects (a Polar `tax_behavior` among them, the `NaN` of a figure that cannot be read, a Lemon Squeezy
variant and quantity, a Polar product, and Stripe's nothing at all), and that what a checkout charges is said the same
way in the interface, in `PaymentProvider` and here. Nothing calls a provider.

### stripe

Stripe's REST API with form-encoded bodies (`line_items[0][price]`), `Authorization: Bearer`, and `Stripe-Version`
pinned to `2025-08-27.basil`, so a change on Stripe's side arrives when that line changes and not before.

- Knobs: `STRIPE_SECRET_KEY` (`sk_test_...` or `sk_live_...`; `livemode` is read off its prefix),
  `STRIPE_WEBHOOK_SECRET` (the `whsec_...` of the endpoint registered in Stripe's dashboard).
- Checkout: `price` is a Stripe price id, `quantity` is sent, `mode` defaults to `payment`. The route requires
  `cancel` (its `checkCheckout`); through `payments@1` it is optional, and a session started without one is sent no
  `cancel_url` at all, rather than an empty one, so Stripe shows no way back. Stripe has no `checkCharge`: it charges
  amount lines. The customer is created with `POST /v1/customers` (email and `metadata[voidbase_user]`), the session
  with `POST /v1/checkout/sessions` (`client_reference_id` and `metadata[voidbase_customer]` set to the row id). An
  amount line follows the prices as a line of its own, `line_items[n][price_data]` with `currency`, `unit_amount`
  and `product_data[name]`, and `quantity` 1. A reference is `metadata[voidbase_order]` on the session and, in
  payment mode, `payment_intent_data[metadata][voidbase_order]` on its payment intent, so
  `checkout.session.completed` and `payment_intent.succeeded` both name the order. Stripe reports no purchase on a
  payment (`purchasedItems` is null), and there is nothing to hold an order's lines against; its metadata is set with
  the secret key alone, so a reference at Stripe is never a buyer's claim. A commerce shop on Stripe needs
  Adaptive Pricing (Stripe's presentment currencies) turned off: commerce compares a payment's amount with the
  order's total in the order's currency, and a buyer who pays in a currency Stripe offered them pays another amount
  in another currency, which pays no order and leaves it pending.
  Portal: `POST /v1/billing_portal/sessions`. Cancel: `POST /v1/subscriptions/{id}` with `cancel_at_period_end`
  (`true`, or `false` to resume); `now: true` is `DELETE /v1/subscriptions/{id}`.
- Webhook: register `https://<instance>/api/payments/stripe/webhook` (Developers > Webhooks). `Stripe-Signature`
  is HMAC SHA-256 over `t.payload` against the secret, a five-minute tolerance on `t`, a constant-time compare.
  Events: `checkout.session.completed` (the customer, and in payment mode the payment),
  `customer.subscription.created|updated|deleted` (the subscription row, `deleted` as status `canceled`),
  `invoice.paid` and `invoice.payment_failed` (a payment linked to its subscription, keyed by the payment intent or
  the invoice id), `payment_intent.succeeded|payment_failed` (the payment). Both invoice shapes are read: the 2025
  versions moved a subscription's period onto its items and an invoice's subscription and payment intent under
  `parent` and `payments`.

### polar

Polar's REST API with JSON bodies and `Authorization: Bearer`, against `https://api.polar.sh` or, with
`POLAR_SANDBOX=1`, `https://sandbox-api.polar.sh`. Pinned to Polar's `2026-04` OpenAPI document as read on
2026-09-11 (`polar.sh/docs/openapi/2026-04.openapi.json`).

- Knobs: `POLAR_ACCESS_TOKEN` (an organization access token), `POLAR_WEBHOOK_SECRET` (the `whsec_...` shown when
  the endpoint is created), optional `POLAR_SANDBOX=1` (`livemode` is false with it).
- Checkout: `price` is a Polar product id; the customer picks among the products listed, so `quantity`, `cancel`
  and `mode` are not read. An amount line is refused with 400 before Polar is called (its `checkCharge`, through the
  route and `payments@1` alike), because there is no line in a Polar checkout for an amount. A checkout with a
  reference is for an order, which is paid only by its whole total, so with one `checkCharge` also refuses more than
  one item and a quantity above 1, which Polar would charge for once. The route sets no reference, so it still lists
  several products for a buyer to pick from (a monthly and a yearly plan). A reference goes in `metadata` as
  `voidbase_order`, which Polar copies onto the order, so `order.paid` carries it back; and a checkout with a
  reference is sent `allow_discount_codes: false` (the document's default is `true`), because a discount code would
  pay less than the order's total and leave the order pending. A checkout with a reference and a `currency` is sent
  that currency lower-cased as `currency` (CheckoutProductsCreate's, a PresentmentCurrency), because Polar shows a
  buyer their local currency when the product has a price in it (the organization's `default_presentment_currency` is
  only the fallback), and a payment in another currency than its order's pays no order. The customer is looked up by email
  (`GET /v1/customers/?email=`; an email is unique in an organization) and otherwise created with
  `POST /v1/customers/` (`external_id` set to the user id), then `POST /v1/checkouts/` with `products`,
  `customer_id`, `customer_email`, `success_url` and `metadata`; the answer is its `url`. Portal:
  `POST /v1/customer-sessions/` with `customer_id` and `return_url`, answering
  `customer_portal_url`. Cancel: `PATCH /v1/subscriptions/{id}` with `cancel_at_period_end` (`true`, or `false`
  to resume); `now: true` is `DELETE /v1/subscriptions/{id}` (revoke).
- For commerce, a product at Polar needs a price in the shop's currency (`VOIDBASE_COMMERCE_CURRENCY`), which the
  checkout names, and that price has to be tax-exclusive. A Polar order carries no `tax_behavior` (in the 2026-04
  document only a checkout and a price do, and a checkout's is null until the tax is calculated), so commerce compares
  the order's `net_amount`, which is before taxes, with the order's total, and `net_amount` is the price only when the
  tax was added on top of it. An order's `product_id` is what was bought, which commerce holds against the product its
  checkout named; it is nullable, and when it is null the products the order's `items` name are read instead, and an
  order that names a product nowhere reports no purchase at all, which leaves its reference and its amount before tax
  to gate it. That is safe here because a buyer cannot set a Polar checkout's metadata (the public checkout update
  carries none), so a reference from Polar is not a claim anybody can make. With an inclusive price, or a location-based one where Polar takes the tax out of the
  price, `net_amount` is less than the price: a buyer who paid in full leaves the order `pending`, and an
  `order.payment_unmatched` row names both amounts, `amount` (Polar's `total_amount`) and `beforeProviderTax` (its
  `net_amount`), against the order's total. A payload that does carry `tax_behavior` is read by it: `total_amount`
  when it is `inclusive`, `net_amount` when it is `exclusive`.
- Webhook: register `https://<instance>/api/payments/polar/webhook` (Settings > Webhooks). Polar signs with
  Standard Webhooks: `webhook-id`, `webhook-timestamp` (unix seconds) and `webhook-signature` (`v1,<base64>`),
  HMAC SHA-256 over `id.timestamp.body`, a five-minute tolerance. Two keys are tried, because Polar changed how a
  secret is meant: secrets generated on or after 8 September 2026 follow Standard Webhooks (the part after `whsec_`
  is base64, the key is its bytes), older ones use Polar HMAC (the key is the UTF-8 bytes of the whole `whsec_...`
  string). Events: `checkout.updated` (once `status` is `succeeded`: the customer, tied to the user through
  `external_customer_id`), `order.created`, `order.paid` and `order.refunded` (a payment keyed by the order id,
  `total_amount`, linked to its subscription; `paid` says succeeded), and every `subscription.*` event
  (`created`, `updated`, `active`, `canceled`, `revoked`, and the others Polar sends, all carrying the whole
  subscription: status as Polar says it, which is the rows' vocabulary; `revoked` as `canceled`; `canceled` keeps
  the status and sets `cancelAtPeriodEnd`).
- Not verified against a live account: whether `POST /v1/customers/` refuses a duplicate email is not stated in
  the document (the email lookup runs first either way), the day Polar switched secret formats is taken from
  its delivery page (both keys are accepted regardless), and what Polar answers to a checkout sent a `currency` its
  product has no price in (a refusal comes back as a 400, and commerce then cancels the order it had just made).

### lemonsqueezy

Lemon Squeezy's JSON:API (`application/vnd.api+json`, `Authorization: Bearer`) at
`https://api.lemonsqueezy.com`, pinned to docs.lemonsqueezy.com as read on 2026-09-11.

- Knobs: `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID` (the numeric store id every checkout and customer belongs
  to; without it the routes answer 503 naming it), `LEMONSQUEEZY_WEBHOOK_SECRET` (the signing secret typed when
  the webhook is created). Test mode is a switch on the store, not a property of the key, so `livemode` is `true`.
- Checkout: one item whose `price` is a numeric variant id; a `quantity` above 1 goes as
  `checkout_data.variant_quantities`; `cancel` and `mode` are not read (the variant decides). An amount line is
  refused with 400 before Lemon Squeezy is called, and so is a second item or a price that is not a variant id (its
  `checkCharge`, which the route and `payments@1` both make): a checkout is one variant at its price. A reference
  goes in `checkout_data.custom` as `voidbase_order`, and a checkout with one is sent
  `checkout_options: { discount: false }`, which hides the discount code field (Lemon Squeezy shows it by default),
  because a code would pay less than the order's total and leave the order pending. An order's
  `attributes.first_order_item` says which variant was bought, and how many only when it carries a `quantity` (the
  docs' order object lists none, and Lemon Squeezy's own SDK types one as "Not in the documentation, but in the
  response"), which commerce holds against the order's line: by the variant always, and by the quantity only when one
  was reported. That is because a checkout URL takes custom data of a buyer's own
  (`?checkout[custom][voidbase_order]=`) and a reference from Lemon Squeezy is therefore a claim anybody can make,
  which is also why a declined Lemon Squeezy purchase cancels the order it names only when it bought that order's
  lines. A variant with a setup fee pays no
  commerce order: the order's `attributes.total` includes the variant's `setup_fee`, which commerce's order does not,
  so what it charged before the tax is more than the order's total, and the order stays `pending` with an
  `order.payment_unmatched` row. A product commerce sells through Lemon Squeezy is a variant without one. The customer is
  looked up by email in the store (`GET /v1/customers?filter[store_id]=&filter[email]=`) and otherwise created
  with `POST /v1/customers` (`name` from the auth record or the email's local part), then `POST /v1/checkouts`
  with `product_options.redirect_url`, `checkout_data.email` and `checkout_data.custom` (`voidbase_user`,
  `voidbase_customer`, which come back on every webhook as `meta.custom_data`) and the `store` and `variant`
  relationships; the answer is `data.attributes.url`. Portal: `GET /v1/customers/{id}` and its
  `urls.customer_portal`, a signed URL Lemon Squeezy issues once the customer has ordered (400 before that;
  `return` has nowhere to go). Cancel: `DELETE /v1/subscriptions/{id}` cancels at the period's end (the
  subscription is `cancelled` and runs until `ends_at`); `resume: true` is `PATCH` with `cancelled: false`;
  `now: true` is 400, Lemon Squeezy does not offer it.
- Webhook: register `https://<instance>/api/payments/lemonsqueezy/webhook` (Settings > Webhooks) and subscribe at
  least `order_created`, `subscription_created`, `subscription_updated` and `subscription_payment_success`.
  `X-Signature` is the hex HMAC SHA-256 of the raw body under the secret, compared in constant time; there is no
  timestamp, so a replay verifies and the upsert makes it a no-op. Events: `order_created` and `order_refunded`
  (a payment keyed `order_<id>`, `total`, the customer from `customer_id` and `user_email`, the user from
  `meta.custom_data`), `subscription_created|updated|cancelled|resumed|expired|paused|unpaused` (one row: `on_trial`
  as `trialing`, `cancelled` as `active` with `cancelAtPeriodEnd` and `ends_at` as the period end, `expired` as
  `canceled`, `price` the variant id; the order that started it is linked as its first payment),
  `subscription_payment_success|failed|recovered|refunded` (a payment keyed `invoice_<id>` linked to its
  subscription; the `initial` invoice is skipped because `order_created` already wrote that money). Ids are
  integers and an order and an invoice can share a number, which is what the prefixes are for.
  A payments row's `raw` is the object with the envelope's custom data kept beside it as `raw.meta.custom_data`,
  because the envelope is the only place the checkout's custom data, and so its reference, comes back.
- Not verified against a live account: whether `POST /v1/customers` refuses an email the store already has (the
  lookup runs first either way), and whether `urls.customer_portal` on a customer is null before the first order
  (the create-customer example shows null, which is how the 400 is decided).

## A shop the other plugins plug into: commerce

`commerce` is a shipped plugin (tier `official`, `src/server/plugins/commerce.ts`) and the roadmap's "A shop the
other plugins plug into": the parts of a shop that are the same everywhere, and none of the parts that are not.
It requires `payments@1`, `tax@1` and `shipping@1` rather than stripe, tax-flat or shipping-flat, so a payment
plugin supplies checkout, a shipping plugin supplies rates, a tax plugin supplies the tax, and commerce never
learns which. `VOIDBASE_COMMERCE=1` turns it on; unset, it is loaded and idle, its ten collections are not created
and every route answers 503 naming the knob, so an instance that does not sell anything never grows a shop.

**The two interfaces beside it**, both new and both deliberately small (`src/server/interfaces/index.ts`):

- `tax@1`: `quote(env, { items, to, customer? })` answers `{ lines: [{ label, amount }], total }`.
- `shipping@1`: `rates(env, { items, to })` answers `[{ id, label, amount, eta? }]`, cheapest first by
  convention; an empty list means this address cannot be shipped to.

They are shaped the way `payments@1` is, and for the same reason: an API key or a rate table arrives with the
request rather than at module scope, so the env is the first argument of every method rather than something the
provider holds. They have no `route(env)` twin, because neither has a webhook to register or a knob a caller has
to be told about, and a provider with nothing configured answers zero rather than refusing. An `item` is
`{ variant?, sku?, title?, quantity, unitPrice, weight? }` and `to` is
`{ line1?, line2?, city?, region?, postcode?, country? }`, the country upper-cased ISO 3166-1 alpha-2. Every
amount is an integer in the currency's minor unit, like the `payments` collection's `amount`.

**The flat-rate defaults**, two tiny shipped plugins (tier `official`) so a shop works out of the box and so that
"requires the interface, not the plugin" is a claim with two implementations behind it:

- `tax-flat` (`tax-flat.ts`) charges one percentage, `VOIDBASE_TAX_RATE` (`20`, `7.5`, `20%`), as one line
  labelled `Tax (20%)`, rounded half away from zero on the subtotal rather than per line. Unset, zero or nonsense
  is a shop that charges no tax, which is a valid shop and not an error.
- `shipping-flat` (`shipping-flat.ts`) offers one rate, `VOIDBASE_SHIPPING_FLAT` in minor units, which becomes
  zero once the subtotal reaches `VOIDBASE_SHIPPING_FREE_OVER`. Its id is `flat` and its label says which of the
  two it is. Neither knob set is a shop that ships free.

Replacing either is installing a plugin that provides the interface and removing ours; nothing in commerce
changes, and `test/unit/commerce.test.ts` measures exactly that by running the whole shop against a tax engine and
a carrier of its own.

**The collections**, ten, owned and created by commerce at kernel bootstrap on the first request once the knob is
set, each with `created` and `updated` autodates:

- `products`: `title`, `slug` (unique), `description` (editor), `images` (file, up to 10), `active` (bool),
  `metadata` (json).
- `variants`: `product` (relation, required), `sku` (unique), `title`, `price` (number, minor units), `currency`,
  `weight` (number, grams), `priceId` (text), `active`. `priceId` is what the payment provider knows this variant
  by (a Stripe price, a Polar product, a Lemon Squeezy variant); the `sku` is sent when it is empty.
- `inventory`: `variant` (relation, unique), `onHand`, `reserved`. A variant with no inventory row is untracked
  and never blocks a sale, which is what lets a shop of downloads skip the table entirely.
- `carts`: `user` (relation, optional), `token` (an anonymous cart's), `currency`, `status`
  (`open` / `ordered` / `abandoned`), `expires` (thirty days), `address` (json: where `POST /cart/address` put it).
- `cart_items`: `cart`, `variant`, `quantity`, `unitPrice` (the price at the moment it was added), unique per
  (cart, variant).
- `orders`: `number` (unique), `customer` (relation to the payments plugin's `customers`), `email`, `status`
  (`pending` / `paid` / `fulfilled` / `cancelled` / `refunded`), `currency`, `subtotal`, `tax`, `shipping`,
  `total`, `address` (json), `payment` (relation to the payments plugin's `payments` row), `placedAt`.
- `order_items`: `order`, `variant`, `sku`, `title`, `quantity`, `unitPrice`, `total`, `priceId` (what the checkout
  named the line by at the payment provider: the variant's `priceId`, or its `sku`). A record of what was bought
  rather than a pointer to it, because a variant's title and price may change tomorrow and the order may not.
- `shipments`: `order`, `carrier`, `tracking`, `shippedAt`, `items` (json).
- `refunds`: `order`, `amount`, `reason`, `providerId`, `refundedAt`.
- `commerce_audit`: `at`, `actor`, `action`, `subject`, `detail` (json). Every state change writes one, it is
  append-only, and it is superuser-read.

**The rules** are the design said out loud. `products`, `variants` and `inventory` are a catalogue, so anyone may
read them and `active = true` (and `product.active = true`, `variant.active = true`) is what hides a draft from
everyone but a superuser. Everything else is somebody's, scoped through the payments plugin's `customers.user`
(`customer.user = @request.auth.id`, `order.customer.user = @request.auth.id`) or through the cart's own user;
`commerce_audit` is superuser-read. Nothing has a create, update or delete rule at all: every write goes through a
route that checks the stock, records the audit row and answers with what happened, and a customer editing their
own order's total through the records API is what that exists to stop. An anonymous cart is reachable by its
token through the routes and not through the records API, because a rule cannot hold a secret.

**The routes**, under `/api/commerce/`:

- `GET|POST /cart`, anybody. The caller's open cart, made when there is none. Signed in it is the session's;
  anonymous it is created with a token, which the answer carries and the caller sends back as `X-Cart-Token` (or
  `?token=`, or `token` in the body). Signing in while carrying a token claims that cart rather than losing it.
  Answers `{ id, token?, currency, status, expires, address, items: [{ id, variant, sku, title, quantity,
  unitPrice, total }], subtotal }`, which is what every cart route answers.
- `POST /cart/items`, body `{ variant, quantity? }` (default 1). Adds the line, or adds to it when the variant is
  already in the cart, recording the variant's price as `unitPrice`. A quantity the stock cannot cover is 409
  naming what is left; an unknown or inactive variant is 404 or 400.
- `PATCH /cart/items/:id`, body `{ quantity }`. `0` takes the line away. Checks the stock again.
- `DELETE /cart/items/:id`.
- `POST /cart/address`, body `{ address: { line1, city, postcode, country, ... } }`. Sets the destination on the
  cart and quotes both interfaces against it. Answers `{ cart, currency, address, subtotal, tax: { lines, total },
  shipping: [rates] }`. An address with nothing recognisable in it is 400.
- `POST /checkout`, signed-in user. Body `{ success, cancel?, shipping?: <rate id> }`. Quotes tax and shipping
  again (a quote an hour old is not a quote), takes the named rate or the first one, and works out what the provider
  is to charge: the variants by `priceId` (or `sku`) and quantity, and the tax and the shipping, when they are not
  zero, as amount lines in the cart's currency (the tax named by its labels, the shipping by its rate's label), so
  the checkout charges the order's `total` and not only its subtotal. A provider that cannot charge all of that
  refuses here with 400, before anything has happened (`payments@1`'s `checkCheckout`, asked about a checkout with a
  reference, since it will have one, with the cart's id standing in for the order's, which does not exist yet):
  Polar and Lemon Squeezy refuse a cart with tax or shipping or of more than one line, and Polar one with a quantity
  above 1. A provider
  route's own rules about its body are not made here, so `cancel` stays optional whichever provider is active (a
  Stripe session without it offers no way back). Then it asks `payments@1` for the caller's `customers` row, reserves
  the stock, writes the `pending` order and its items, marks the cart `ordered`, and hands the lines to
  `payments@1`'s checkout with the order's id as the `reference` and the cart's `currency`. Answers `{ order, url }`.
  If the provider refuses then, the stock goes back, the order is cancelled and the provider's error is the answer.
- `POST /orders/:id/fulfil`, superuser. Body `{ carrier?, tracking? }`. A paid order only (409 otherwise): writes
  a `shipments` row holding what shipped, takes the quantities off `onHand` and off the reservation with them, and
  moves the order to `fulfilled`.
- `POST /orders/:id/refund`, superuser. Body `{ amount?, reason? }`, defaulting to the whole total and refusing
  more than it. A paid or fulfilled order only. Calls `payments@1`'s `refund` when the provider's plugin offers
  one, keeps its id, and writes the `refunds` row either way, so an order refunded from a provider's own dashboard
  is still recorded here. Moves the order to `refunded`. It does not put the stock back: a refunded order is not
  an unsold one and only a person knows which it is.
- `GET /orders` and `GET /orders/:id`, the caller's own (a superuser may read either). The single order carries
  its items, its shipments and its refunds.

**How commerce learns that an order was paid.** The webhook is the payment provider's, and that is the design
rather than an oversight: nothing else may claim the path and nothing else can verify that provider's signature.
Nothing in `payments-shared.ts` offered a seam, so this plugin added the smallest one there is and no more:
`onPaymentWritten(app, watcher)`, a list of callbacks the shared webhook path calls once a provider has verified
an event and upserted its `payments` row, with the env the request arrived with, that request's realtime client,
the result the provider reported and the row it wrote. Watchers belong to one app, the identity the provider
family is already keyed by, so two instances in one process never hear each other's payments. A watcher's error is
the webhook's error on purpose: the provider then retries, every write on that path is an upsert by the provider's
id, and the watcher's own move is idempotent for the same reason.

Commerce's watcher moves only the order a payment names: the reference checkout handed over, read off the row's
`raw` with `paymentReference`.

- A payment that names no order never pays, cancels or revives one, whatever it costs, and is a log line and not an
  audit row. Commerce gives every checkout its order's id as the reference, at all three providers, so money that
  names no order is not a commerce checkout's: a subscription invoice's payment intent at Stripe, which carries
  neither metadata nor a mark of its subscription and whose upsert can replace the invoice in the row's `raw`; a
  Lemon Squeezy subscription's first order; a purchase through a provider's own checkout route. Until 2026-09-11
  such a payment was matched on the `customers` row and the amount, so any of them could pay, cancel or revive a
  pending order of the same total.
- A payment that names one is that order's or nobody's: Stripe tells of one payment twice (the session, then its
  payment intent) and the second telling must not pay a second order of the same total, and a name that points at
  somebody else's order is no reason to pick one of the payer's. The order has to be the payer's (the same
  `customers` row) and still `pending`, or, for a success, cancelled by a failed payment (below).
- A `succeeded` payment has to be the order's `total` in its currency as well (compared in either case, since Lemon
  Squeezy writes `USD`), because the name is a claim and not proof: any plugin calling `payments@1` can give one, a
  variant's `priceId` can cost something else at the provider, and a provider can report less than the total. The
  amount compared is what the provider charged before any tax of its own (`chargedBeforeProviderTax`, above), since
  Polar and Lemon Squeezy add their tax on top of an order's total, which cannot include it. At Stripe it is the
  amount as written, compared in the order's currency, which is why Stripe's Adaptive Pricing has to be off. At Polar
  it is the order's `net_amount`, which is the order's total only when the price is tax-exclusive, and the payment is in
  the currency the checkout named; at Lemon Squeezy it is the `total` less the `tax`, which a variant's setup fee is
  in. What each needs is below.
- A `succeeded` payment has to have bought what the order is, where the provider says what was bought
  (`purchasedItems`, above): every item reported has to be a line of the order and every line has to be bought, held to
  the id the checkout named the line by (the line's `priceId`, and the id its variant names it by now and the line's
  `sku` as well, any one of which matching is the line) and to the quantity only for an item whose
  quantity the provider reported, since a Lemon Squeezy order carries none in the object its own docs print. Stripe
  reports none at all, so there is nothing to hold it against and no buyer can set its metadata anyway. At Lemon Squeezy, where any checkout URL
  takes `?checkout[custom][voidbase_order]=`, an order for another variant at the same price, or a subscription
  variant's first order, names the order and moves it no more than a Polar order for another product does; each leaves
  an `order.payment_unmatched` row naming what was bought against what was ordered.
- A `failed` payment needs no amount: it moves no money, so it cancels the pending order of the payer's that it
  names whatever amount or currency it gives, rather than leave that order's stock reserved for good. It does have to
  have bought that order's lines, the same check a success makes, wherever the provider says what was bought: at Lemon
  Squeezy the reference is a buyer's to set, so a declined one-cent purchase of any variant would otherwise cancel
  somebody's pending order and release its stock. Where the provider reports no purchase there is nothing to check and
  nothing to abuse either, because the reference is not a buyer's to set there, so a Stripe decline that names the
  order still cancels it.
- A subscription's money is not even logged, since commerce starts payment-mode checkouts only: a payments row with
  a `subscription`, or whose `raw` is an invoice or carries a subscription (`object: "invoice"`, `subscription`,
  `parent.subscription_details`, Polar's `subscription_id`, Lemon Squeezy's `attributes.subscription_id`), moves
  nothing and writes nothing. The filter keeps that noise out. It is not what protects an order: it cannot see a
  subscription invoice's payment intent, and a payment that names no order moves none anyway.

A `succeeded` payment moves the order to `paid` and points it at the row; a `failed` one cancels the order, points it
at the row too and releases the reservation, which is the other half of "reserved at checkout, released when an order
is cancelled or its payment fails". Both write a `commerce_audit` row whose actor is `payments:<provider>`, and whose
detail holds `beforeProviderTax` beside `amount` when the provider added a tax of its own (`null` when that figure
could not be read).

Every move is a claim, and every step of a move is written once. The order changes only while its status is still the
one the watcher read, through `updateWhere(collection, id, where, values)` on the commerce rows, which answers whether
it changed the row. At D1 that is the records service's own update held to a precondition (`UpdateOptions.where`), so
the collection's hooks run before anything is written and see the order go from the status it had to the one the move
gives it; a hook that refuses stops the move, as it stops any other update; and an UPDATE that finds the order moved
since it was read writes nothing, fires no hook after it (no after-success hook, and no after-error hook either, since
nothing failed: the update deliberately wrote nothing), announces nothing to realtime, and answers false. Until
2026-09-11 a raw `UPDATE ... WHERE status = ?` claimed the row and the service wrote the same values after it, so a
hook saw the claimed status as the original (`pending` to `paid` was never seen) and one that refused could not stop
the move. Stripe tells of one payment twice at once, the session and its payment intent, and two requests that had both
read the order both moved it: both wrote `order.paid`, and a revived order's stock was reserved twice. Now only the
request whose claim changed the order goes on; a request whose claim finds the order already moved to the status its
own news gives it, with its own payment, finishes the move beside the request that won, which repeats nothing; and a
claim that finds anything else is 409, so the provider's retry decides against the order as it is by then.

What a move leaves is a series of steps, each written once per order, payment and line, because the move and its rows
are separate writes and a watcher's error is the webhook's: the provider retries, and the retry has to finish what the
first attempt left without repeating what it did. Each step's `commerce_audit` id is derived from the order, the
action, the payment and, where it has one, the line or the status (the SHA-256 of them in base 36, cut to the 15
characters of `[a-z0-9]` an id takes), and the row is created only if it is absent; a step that moves stock writes its
row and the `inventory` update as one unit that lands both or neither (`createOnce` on the commerce rows, one D1
batch). So a failure claims `pending` to `cancelled`, releases each line (a `stock.released` row per line) and writes
`order.payment_failed`; a success claims to `paid`, reserves again each line whose release is recorded (a
`stock.reserved` row per line, which only a revived order has), writes `order.paid`, and writes an `order.oversold`
note when a line's stock had gone to somebody else. What that guarantees: an order's stock is released once and
reserved again once per payment however often the news is told or retried, a move's row is written once, and a retry
after any write failed ends with the stock the order should hold and one row per move. What it does not guarantee is
the moment: between one step and the next the order's stock is short by the lines not yet moved, and a delivery that
reads the order before another request's claim can still write a note about what it found.

A payment that has moved an order (that order's `payment` is its id) is that order's for good and is never matched
again, so a failure told after the success of the same payment intent cannot cancel a second pending order of the same
total and release its stock. The same status again, a replay, Stripe's second telling or the provider's retry after a
write failed, moves nothing and finishes the move: the steps it finds undone it does, the ones it finds done it leaves.
A contradicting status leaves the orders alone and writes one `order.payment_contradicted` row, once per payment and
status, whose detail holds the payment, its amount, currency and status, the order's status (`orderStatus`) and the
reason. Two are not noted but acted on: a success after the failure that cancelled the order brings the order back
(below); and a failure told again after a success brought its order back is the same news as before, so it writes its
own `order.payment_failed` row when that is missing, which it is when the write of it failed and the success came
before the provider's retry. What says that this payment is the one that had cancelled the order is the order's own
rows: a line it released, or the revived `order.paid` row's `cancelledBy`.

One contradiction is mended rather than noted: a cancelled order paid after all. Stripe Checkout lets a buyer retry
on the same session after a decline, so the payment intent whose failure cancelled the order can succeed a minute
later, with the money captured for an order that is gone. And the failure need not be that payment's: a failure cancels
the pending order it names whatever it was for, so a `payments@1` caller's own checkout that names the order and is
declined for another amount cancels it, and the order's own payment then succeeds. When a succeeded payment names a
cancelled order of the payer's that carries a payment, pays the order's total in its currency before the provider's own
tax (which a failure did not have to be) and bought what the order is, the order is claimed from `cancelled` to `paid`
with this payment, its lines whose release is recorded are reserved again, and it is audited as `order.paid` with
`revived: true` and `cancelledBy` naming the payment whose failure had cancelled it.

The order row is the witness that a failed payment cancelled it, not the audit trail. A cancelled order that carries a
`payment` was cancelled by that payment's failure: only a failure's claim writes a payment onto an order it cancels, a
refused checkout cancels an order before there is any payment to write (`order.checkout_failed`), and nothing else
moves a cancelled order. The trail was the witness until 2026-09-11, and a failure's `order.payment_failed` row lands
after its claim, so a success read in between saw `order.placed` as the last move, noted a contradiction, answered 200
and was never retried: a fully paid order stayed cancelled for good. An order a refused checkout cancelled carries no
payment, so it stays cancelled and the payment leaves an `order.payment_unmatched` row saying so. (A superuser who
cancels a paid order by hand through the records API leaves its `payment` on it; clear that too, or a success told
again brings the order back.)

Only the lines whose release is recorded are reserved again, which is what keeps a revive from reserving a line twice:
a failure whose release never happened left that line reserved from checkout, and the provider's retry of the failure
is what releases it. If the stock went to somebody else in the meantime the order is paid all the same, since the money
is captured: its lines are still reserved, above what is on hand, which stops those variants selling, and an
`order.oversold` row names each line short (`variant`, `sku`, `quantity`, `available`) for a person to decide what
happens.

A payment that names an order and moves none (the order does not exist, is another customer's, is no longer pending
and cannot be brought back, or a success is not its total, which includes a figure before the provider's tax that
cannot be read, or bought something other than the order's lines) leaves the orders alone and is said out loud: a log
line, and a `commerce_audit` row `order.payment_unmatched`, once per payment and status, whose subject is
`order:<reference>`. Its detail holds the provider, the payment, what was paid (`amount`, `currency`, and
`beforeProviderTax` when the provider added a tax of its own) and its status, the customer, the reference, what was
owed (`owed`: `[{ order, total, currency }]`, the named order), what was bought against what was ordered (`bought` and
`ordered`, `[{ id, quantity }]`, when that is why) and the reason, so a superuser can find the money. A payment that
names no order is a log line and nothing else, as above.

Two smaller additions to `payments@1` came with it: `customer(env, auth)`, which answers the `customers` row id
for a signed-in user (creating it at the provider on the first contact) because the interface previously only took
an id the provider's own route had looked up for itself, and an optional `refund(env, { payment, amount?, reason? })`
that no shipped provider implements yet and that the refund route asks for by name. Amount lines and a `reference`
on checkout, and the optional `checkCheckout(env, o)`, came after it (see the payments section above), so that a
checkout charges the order's total and the payment that comes back names its order.

**What each provider needs for a shop**, since a payment moves its order only when it is the order's total in the
order's currency:

- Stripe: Adaptive Pricing turned off, so that a buyer pays in the order's currency.
- Polar: each product priced in the shop's currency (`VOIDBASE_COMMERCE_CURRENCY`), which commerce's checkout names,
  and priced tax-exclusive. A Polar order does not say how its price was taxed, so commerce compares its `net_amount`,
  which is less than the price when the price held the tax (inclusive, or location-based where Polar takes the tax out
  of it). Otherwise a buyer who paid in full leaves the order `pending`, and an `order.payment_unmatched` row names both
  amounts, `amount` with Polar's tax and `beforeProviderTax` without it.
- Lemon Squeezy: variants without a setup fee, since an order's `total` includes the variant's `setup_fee` and so pays
  more than the order's total; otherwise, again, the order stays `pending` with an `order.payment_unmatched` row.

**Upgrading from 0.9.0-beta.45 or earlier.** Commerce shipped in 0.9.0-beta.42 and gave a checkout no reference until
after 0.9.0-beta.45. Orders still `pending` when a version with references is deployed were checked out without one, so
their payments name no order and will never move them, and nothing in commerce matches a payment to an order by its
amount any more. A superuser matches them by hand. The orders are the `pending` ones placed before the deploy (their
`placedAt`). The payments that may be theirs are the `payments` rows that name no order (`paymentReference(raw)` is
empty: no `voidbase_order` in `raw.metadata`, or at Lemon Squeezy in `raw.meta.custom_data`), of the order's
`customer`, written after it was placed, whose `amount` and `currency` a person holds against the order's `total` and
`currency` (at Polar and Lemon Squeezy with the provider's tax on top). A superuser is not held to the collections'
null rules, so the order is changed in the dashboard or through the records API: for a payment that succeeded,
`status` `paid` and `payment` the row's id; for one that failed, `status` `cancelled`, and each of its lines' `quantity`
taken off its variant's `inventory.reserved`. No `commerce_audit` row is written for a change made that way. Leave
`payment` empty on an order cancelled by hand, since a cancelled order that carries one reads as one a failed payment
cancelled, which a success told again brings back.

`CommerceRows`, which `commerceWith({ rows })` takes and which the package exports through `./plugins/commerce`, gained
two required members in the same version, so an implementation of your own (a test's rows in memory, another database)
has to have both before a payment can move an order: `updateWhere(collection, id, where, values)`, the compare-and-set
every move is claimed with, which answers whether it changed the row and must change it only while the row still has
the values `where` names; and `createOnce(collection, values, alongside?)`, which writes a row of the id the caller
derived unless a row of that id is there, together with the updates in `alongside`, and must land all of them or none
of them and answer whether it wrote the row. Two things to know about `createOnce` at D1, where it is one buffered
transaction sent as one batch: a unit that loses the race writes nothing, but the collections' after-success hooks have
already run for the writes it issued by the time the batch is refused and takes them back, so a hook that hears of a
step's write may be hearing of one that never landed; and `alongside` takes at most one update per collection, because
a second would read a table the transaction has already written, which a buffered transaction refuses rather than
answer a stale row (`src/server/tx-d1.ts`). `order_items` also gained a `priceId`, what the checkout named the line by
at the provider. A line written before it has none, so the id its variant names it by now and the line's `sku` stand
in, and all three are accepted where they disagree, which they can only do once a shop has re-pointed a variant since
an order was placed: either may then be what that checkout sent. Falling back from one to the next, as it did until
2026-09-11, guessed one of them and left an order placed before the field existed pending for good once its variant had
moved on. What no id can witness is a pre-`priceId` line whose variant was re-pointed before the payment came back:
nothing on the order says what its checkout sent, so such an order stays pending with an `order.payment_unmatched` row
and a superuser matches it by hand (above).

**What it deliberately does not do.**

- It does not sell a cart through a provider that cannot charge all of it. The tax and the shipping go to the
  provider as amount lines, which Stripe charges and Polar and Lemon Squeezy, as implemented, cannot, so with those
  a cart with tax or shipping is refused before the order is written, and never charged short; so is a cart of more
  than one line through either, and one with a quantity above 1 through Polar, which charges a product once.
- It does not check a variant's price at the provider, and it does not take a payment's word for which order it
  pays or for what it bought. The items go by `priceId`, and the checkout charges the order's total only when that
  price costs at the provider what `price` says here; any plugin calling `payments@1` can name an order as its
  reference, and at Lemon Squeezy a buyer can name one in a checkout URL. So a successful payment moves the order it
  names only when it is that order's total in its currency before the provider's own tax and bought that order's
  lines where the provider says what was bought, and one that pays or buys anything else moves nothing and leaves an
  `order.payment_unmatched` row saying what was paid against what was owed, and what was bought against what was
  ordered. A failed payment cancels the order it names only when it bought that order's lines too, though it needs no
  amount, since a decline moves no money. Where a provider reports no purchase (Stripe), the amount is all there is to
  hold a payment to, and the reference there is not a buyer's to set.
- It does not count stock atomically. `reserve` and `release` read the `inventory` row and write back a count worked
  out in the Worker, so two checkouts of one variant at the same moment, or a checkout and a payment's move, can lose
  one of the two writes: the reservation is then short (or long) by a line's quantity, and a busy variant can sell one
  more than it has, or refuse a sale it could have made. This predates the payment watcher's claims and steps, which
  keep one order's own moves from doubling each other; it has been so since commerce shipped in 0.9.0-beta.42, and a
  shop that sells several of one variant a second wants a count the database adds up rather than the Worker.
- It does not guess which order a payment is for. A payment that names no order moves none, even when it costs
  exactly what a pending order of the payer's costs.
- It does not take payment in another currency than the order's. A shop on Stripe has Adaptive Pricing turned off,
  since a buyer paying in a presentment currency pays another amount in another currency, which pays no order. At
  Polar the checkout names the cart's currency, and a product needs a price in it.
- It does not read how a Polar price was taxed, which a Polar order does not say. Its Polar prices are tax-exclusive,
  and an inclusive or location-based one leaves a paid order pending, said in an `order.payment_unmatched` row.
- Checkout needs a session. The `customers` row `payments@1` works in terms of belongs to a signed-in user, so an
  anonymous cart has to sign in before it can be paid for. The cart survives that: signing in with its token
  claims it.
- It does not reopen the cart when a payment fails. The order is cancelled and the stock released; starting again
  is a new cart, because a cart that comes back from the dead after a customer has edited nothing is a support
  ticket. What does come back is the order itself, when the payment that failed then succeeds (a buyer retrying on
  the same Stripe session), as above.
- No discounts, coupons, gift cards, tax exemptions, subscriptions-as-products, multi-currency price lists,
  multi-warehouse inventory, backorders, partial shipments (one fulfilment ships the whole order), partial
  refunds beyond the amount on the `refunds` row, or a panel screen. Subscriptions are the payment plugins'
  (`subscriptions`), not this one's.
- It does not sweep abandoned carts. `expires` is written and `abandoned` is a status the schema allows; nothing
  yet sets it.

`test/unit/commerce.test.ts` measures the cart's lifecycle, over-selling and untracked variants, the reservation
and its release on a failed payment and on a refused checkout, both interfaces being asked with the cart's lines,
what Stripe was actually handed at checkout (the tax and shipping lines and the order's reference with it), the
lines a provider is asked to charge adding up to the order's total, a provider that cannot charge them refusing
before the order exists (Polar with tax and shipping, and Polar with neither but two lines or two of one line), a
checkout on Stripe without `cancel`, the paid webhook through the real seam and its replay, a payment matched by
the order it names beside another of the same total, a payment that pays the wrong total or currency (through a
reference any `payments@1` caller can set) or names another customer's order moving nothing and leaving an
`order.payment_unmatched` row, a payment that bought something other than the order's lines moving nothing (a Lemon
Squeezy order for another variant at the same price, a subscription variant's first order, two of the order's own
variant for the price of one, a Polar order for another product) while the order's own purchase pays it, a failure
told after the same payment's success cancelling no second order, payments
that name no order (a Stripe payment intent or session, a subscription invoice's payment intent before and after
`invoice.paid`, a Lemon Squeezy subscription's first order) paying, cancelling and reviving nothing and writing no
audit row, subscription invoices of an order's total moving nothing and not even logged, Polar and Lemon Squeezy
orders with their own tax on top paying the order when the amount before that tax is its total and not when it is
short, a Polar price that held its tax leaving the order pending unless the payment says `tax_behavior: "inclusive"`,
a figure before the provider's tax that cannot be read (a Polar order with no `net_amount`, a Lemon Squeezy `tax` that
is a string) paying nothing, the cart's currency sent to Polar, a failure for another amount cancelling its order all
the same, an order cancelled by a declined payment coming back when that payment succeeds (reserved again, or
oversold and said so), a success read between a failure's claim and that failure's `order.payment_failed` row bringing
the order back all the same, of the same payment or of another, an order a `payments@1`
caller's declined payment cancelled coming back when its own payment succeeds and one a refused checkout cancelled
not, a failure claiming its order before releasing so that a retry never frees another order's stock, a release or a
reservation that failed after the claim finished by the provider's retry and never done twice (a decline whose release
threw, a revive whose reservation or whose row threw, each ending with the stock the order holds and one row per move),
a move's missing audit row written by the retry, two deliveries of one success at once moving the order once (over rows
that yield between reads and writes) and a lagging twin writing no second `order.paid`,
what the docs say each provider needs and an upgrade needs, fulfilment, a refund with and without a provider that can give money back, the audit
trail's rows in order, and one customer kept out of another's order. The payment provider is the real stripe plugin
over a fake `fetch` (with polar or lemonsqueezy as the active provider where a test needs a merchant of record, and a
provider of the test's own where it counts what checkout was handed); the tax engine and the carrier are the test's
own, or the shipped flat-rate pair where a test needs neither to charge anything. Those rows are in memory, where an
inventory row's read and write do not yield, because `reserve` and `release` read and write back a count (above);
`test/unit/commerce-d1.test.ts` measures what depends on the records service over the real D1 adapter on bun:sqlite,
with the migrations and the collections: an `onRecordUpdate` hook on orders seeing a claim move the order from
`pending` to `paid`, a hook that refuses the move leaving the order pending with no audit row and no row backfilled by
the retry, a claim that finds the order moved writing nothing and announcing nothing, and a step whose row and whose
stock land together or not at all.

## Backups worth relying on: backups

`backups` is the shipped plugin over `src/server/backups.ts` and answers the roadmap's "Enterprise backup, as an
official plugin": two kinds of archive, each verified after it is written, each restorable on its own terms, a
schedule with retention, and a copy in a bucket the instance's account does not own. Everything below is the same
routes PocketBase has (list, create, upload, download, delete, restore) plus `verify`; the panel's Backups page and
`voidbase migrate` keep working unchanged.

**Three archive kinds.** `POST /api/backups` takes `{ kind?: "full" | "data" | "schema", name? }`. The default is
`full`, the kind the archives always were (every table and every file) with three entries added:

- `full`: `header.json` first (`{ format, kind, voidbase, created, tables }`, the one entry a restore must read
  before it applies anything), `data.jsonl` (every D1 table as one JSON object per line: a head line, then per
  table a `{ table, columns }` line and one `{ row: [...] }` line for each of its rows, `_collections` first so a
  restore can rebuild the schema before any row of a user table arrives), every file in
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

The manifest's `format` says which layout the archive uses: `voidbase-backup/2` is the one above. Archives written
before it hold `data.json`, one JSON document with every table's columns and rows, and no `header.json`; they are
still read, and still restore, exactly as they did. Archives written before the manifest existed (only `data.json`
and `storage/`) read as `kind: "legacy"` everywhere and restore as they always did too.

Files are streamed into the zip a chunk at a time (fflate's streaming `Zip`), never held whole. The archive itself
streams to R2 as a multipart upload in 10 MiB parts; a backups storage that offers no multipart upload (the S3
backups bucket from the settings, the Bun runtime's local store) takes it as one object, so it is held in memory
first and the write is refused past 256 MiB (`BUFFERED_MAX`) with a message saying so.

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
the same lock `/api/health` reports as `canBackup`, but the archive is prepared first, so a refusal is the answer: an
archive whose `voidbase` major.minor is newer than the instance's is refused with
`written by voidbase X.Y.Z, newer than this instance (A.B.C)`, and so is one that is not a voidbase archive. For a
format 2 archive that check reads `header.json` alone, a few hundred bytes off the front of the stream. A
`full` (or legacy) archive is restored entirely: the settings merged over the current ones (the secrets it never
held stay as they are), every user collection dropped and recreated from the archive's `_collections` rows before
their rows are loaded, the system tables' rows replaced, every file replaced. A `data` archive lands on the existing
schema: for each collection in the archive that the instance has, its rows are replaced (columns the instance's
table lacks are dropped) and its files are replaced under the instance's own collection id; a collection the
instance lacks is skipped and reported, never invented, unless the body is `{ createMissing: true }`, in which case
it is created from the archive's definition first; a system collection or a view in its place is skipped too. The
report `{ at, kind, restored, created, skipped: [{ collection, reason }], settings }` is written to the sidecar and
shown on the listing as `restore`, and the skips are logged.

**A restore is one streaming pass.** A format 2 archive is never read whole: it is pushed through fflate's `Unzip`
a slice at a time and each entry is handled as it arrives, so an archive larger than the isolate's memory restores.
`data.jsonl` is parsed line by line into `INSERT OR REPLACE` batches (200 statements per `db.batch`, or fewer when
256 KB of rows have piled up; one statement per row keeps every statement inside D1's ceiling of 100 bound
parameters), and every `storage/` entry goes straight from the zip into the storage `put` as a stream, never
buffered whole. The slice pushed into the unzipper shrinks when one of them inflates to more than 1 MiB, so the
peak is a slice's output and not the archive: restoring 306 MB of rows adds about 40 MB of RSS, measured by the
unit test, and that figure does not move when the archive grows. An archive in the older `data.json` layout is
read whole, as it always was, so for those the old ceiling still applies.

A streaming restore applies what it reads as it reads it, and D1 has no transaction across batches, so **a restore
that fails part way leaves the instance partly loaded**: the tables the archive had already reached hold the
archive's rows, the rest hold what they held. The error says so (`the backup archive <name> could not be read to
the end (...): the restore stopped part way, so the instance holds what had already been loaded`), no `restore`
record is written to the sidecar, and the lock is released. Restoring a good archive is what puts it right.

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
shape what it writes: `VOIDBASE_BACKUP_KIND=full|data|schema` (default `full`, the kind it always wrote) and
`VOIDBASE_BACKUP_KEEP=<n>`, the number of automatic archives to keep, the oldest beyond it deleted with their
sidecars only after a successful, verified write. Without the knob the settings' `cronMaxKeep` applies as it
always did (3 by default, 0 for unlimited). Named backups are never pruned.

The unit test (`test/unit/backups.test.ts`) measures both archives' contents and manifests over an in-memory D1
and R2, verification catching a corrupted and a missing entry, each restore with its refusals, an archive in the
older `data.json` layout still restoring, a truncated one refused with the message above, a 306 MB archive
restoring inside a measured RSS budget, retention, the
signer against AWS's published SigV4 example, and a failed copy leaving the backup intact; the conformance suite
(`test/conformance/backups.ts`) still runs the PocketBase contract against a live server.

## Where an instance answers: domains

`domains` is the first plugin whose work is at deploy time (the section above): where an instance answers is a
decision about DNS, certificates and which of several names is the real one, and the core has no business holding
an opinion about any of it. The runtime half (`src/server/plugins/domains.ts`) provides nothing and reports
`domains: { hostnames, canonical }` on `/api/plugins` from the two vars the deploy baked; the deploy half
(`src/node/plugins/domains.ts`) does the rest. `VOIDBASE_DOMAINS` (or `VOIDBASE_DEPLOY_DOMAIN`, the older name, or
`voidbase deploy --domain`) lists the hostnames, comma separated, the first canonical. `before`: the hostnames are
validated, workers.dev is turned off, `VOIDBASE_DOMAINS` and `VOIDBASE_CANONICAL_DOMAIN` are baked, and the URL is
claimed, so the deploy reports `https://<canonical>`. `after`: each hostname is attached through the Workers Custom
Domains API (idempotent: one already attached is left alone), its certificate is polled on the zone's certificate
packs until it is active or 90 seconds have passed, the status logged either way (a token without SSL and
Certificates Read is told so and not waited on), then a zone Redirect Rule per non-canonical hostname sends
everything under it, 301, to the same path on the canonical one, tagged `voidbase:<worker>:@domains:<host>` so a
redeploy replaces exactly those and a project's `_redirects` rules on the same zone are untouched (the Rulesets
permission is the one docs/deploy.md names for `_redirects`; without it the rules to create are printed). `remove`
(`voidbase deploy --remove`): every hostname pointing at the Worker is detached and those rules are deleted.
`test/unit/domains-plugin.test.ts` measures the pure parts; `test/deploy-cf.ts` runs `after` and `--remove` against
the mock's domains, certificate packs and rulesets. The deploy itself now knows only whether workers.dev is on and
which URL to report. The control plane (`src/cloud/client.ts`) still attaches domains for the instances it provisions.

## A preview per pull request: previews

`previews` is the second plugin whose work is at deploy time, and the one the roadmap's "Preview environments, as
an official plugin" asked for. It has two shapes, and `--shape` on the deploy chooses between them per branch:

| | `--shape instance` (the default) | `--shape flagged` |
| --- | --- | --- |
| What is made | a Worker of its own, with its own database, bucket and queue | nothing at all |
| Where the branch's rows live | in the preview's database | in production's, marked `_preview = <branch>` |
| The address | `https://<name>-pr-<slug>.<subdomain>.workers.dev` | production's, with `?preview=<branch>` |
| The branch's code | deployed | not deployed: production's code answers |
| Isolation | total | new rows only; a change to a row production has is refused |
| What it costs | a Worker, a D1, an R2 bucket and a queue per open pull request | nothing |
| It goes by | the Worker being deleted | its rows being deleted |

Choose `instance` unless an instance is expensive or the data matters: it is the only one of the two that isolates
everything, and it is the default so that nothing changes for anyone. Choose `flagged` when the thing being
reviewed is content or data rather than code (a batch of records, a migration's output, a seeded catalogue), when
the production database is the only one with the data worth looking at, or when a pull request that opens for an
hour should not spend a Worker. The two shapes do not exclude each other: a branch may have an instance today and a
flagged lane tomorrow, and the flagged lane exists on every instance whether or not anyone has deployed anything.

The runtime half (`src/server/plugins/previews.ts`) reports `previews: { shape, of, branch }` on `/api/plugins`
(`shape: "instance"` with the two vars the deploy baked; `shape: "flagged"` with `branches`, the branches that have
rows here, on every other instance) and mounts the two routes the flagged shape needs; it also holds the naming
rule, because both halves need it. The deploy half (`src/node/plugins/previews.ts`) does the rest.

**The name.** `voidbase deploy --preview <branch>` (or `VOIDBASE_PREVIEW=<branch>`, which a Workers build sets from
`WORKERS_CI_BRANCH`) targets `<name>-pr-<slug>`, where the slug is the branch lowercased, every run of characters
outside `[a-z0-9]` turned into one dash, cut at 20 characters, then a dash and a 4-character base-36 hash of the whole
branch (FNV-1a), so `feature/login` and `feature-login` are two Workers and the same branch is always the same one;
the words are shortened, down to the hash alone, when the whole would pass Cloudflare's 63 characters. The deploy
resolves that name before it names anything else, so the preview's `-db`, `-storage` and `-jobs` are its own, as
every instance's are (docs/deploy.md, "Every instance is isolated"). The production name is never touched: a
preview is a second Worker beside it.

**`before`.** Bakes `VOIDBASE_PREVIEW` and `VOIDBASE_PREVIEW_OF` as vars, keeps `workers_dev` on, and checks the
seed knob. The `domains` plugin runs after it in shipped order and, seeing `VOIDBASE_PREVIEW` in `ctx.vars`, attaches
nothing, claims no URL and detaches nothing on removal: a preview stays on workers.dev whatever `VOIDBASE_DOMAINS`
says, because the production hostnames are production's.

**`after`.** Seeds the preview from production, then comments on the pull request. The seed is a backup taken on
production and restored on the preview through the backups API over HTTP, the way `voidbase migrate` moves data:
`VOIDBASE_PREVIEW_SEED=schema` (the default) takes a `schema` archive, the kind added for this (the non-system
collections' definitions, views included, and a manifest, no rows and no files; restoring one creates the
collections the instance lacks and updates the ones it has, and never touches a system collection), `data` takes a
`data` archive (rows and files too), `none` (or `0`) skips it. Production is `VOIDBASE_PREVIEW_SOURCE_URL` or
`https://<production>.<subdomain>.workers.dev`; both sides are signed into with `VOIDBASE_SUPERUSER_EMAIL` and
`VOIDBASE_SUPERUSER_PASSWORD`, the knobs the deploy already stores on the preview, and the archive is deleted on
both sides afterwards. A seed that fails leaves the preview up and unseeded, says so in the log and in the comment,
and does not fail the deploy. Then, with `VOIDBASE_GH_TOKEN` (a token with pull requests: write) and the repository
(`VOIDBASE_PROJECT_REPO=owner/name`, else the checkout's origin remote; Workers Builds sets no repository variable,
its own are `CI`, `WORKERS_CI`, `WORKERS_CI_BUILD_UUID`, `WORKERS_CI_COMMIT_SHA` and `WORKERS_CI_BRANCH`, per
developers.cloudflare.com/workers/ci-cd/builds/configuration/#environment-variables), the branch's open pull
request gets one comment, marked `<!-- voidbase-preview -->` on its first line: the address, the REST API and the
dashboard under it, what it was seeded with, the voidbase version and the time. A later deploy of the branch finds
the mark and updates that comment rather than adding another. Without a pull request yet, nothing is posted and the
next deploy tries again. On a production deploy (no branch) the hook does one other thing when
`VOIDBASE_PREVIEW_PRUNE=1`: it removes every preview whose pull request is merged or closed, which is how a preview
disappears on merge without anything listening for GitHub events.

**`remove`.** `voidbase deploy --remove --preview <branch>` (or `voidbase previews remove <branch>`) turns the
comment into "removed" with the time, then the deploy deletes the Worker and, because a preview is disposable by
definition, its database, bucket and queue with it (a production `--remove` keeps those; `voidbase destroy` is the
command that removes them there). `voidbase previews` lists the previews of the project's Worker (every
`<name>-pr-*` on the account, with the branch read back from its vars, the address and the creation date), and
`voidbase previews prune --merged` is the prune above from a laptop.

### The flagged shape: a preview as a query

`voidbase deploy --preview <branch> --shape flagged` (or `VOIDBASE_PREVIEW_SHAPE=flagged`) **deploys nothing**. It
resolves production's address, says what a flagged preview is, and posts or updates the pull request comment. That
is the whole deploy-time half, because the lane is not a thing that has to be created: it comes into being on the
branch's first flagged write and it goes when those rows do. A deploy that would upload a Worker with the knob set
is refused in `before` with the reason, rather than quietly putting the branch's build on production.

**The mark.** Every collection a flagged write reaches gains a `_preview` text column, added the first time one does
and never otherwise, through the collections service (`updateCollection`), so the `_collections` row, the table and
the panel are one thing. It is a `system` and `hidden` field: `recordToJSON` drops it from every answer the way it
drops any hidden field, `writableFields` leaves it out of `can-update`, a non-superuser cannot filter or sort by it,
and the write path sets it from the request and overwrites whatever the body said, so no client can put a row in a
lane it is not in, or take one out. A request carrying `X-Voidbase-Preview: <branch>` writes `_preview = <branch>`;
a request without one writes `''`. System collections and views never get the column.

The column is voidbase's, not the schema author's, so a definition that does not name it keeps it.
`PUT /api/collections/import` (with or without `deleteMissing`, and `$app.importCollections`, which the demo's hourly
reset calls with its own list) and `PATCH /api/collections/:id` carry the stored field over, column and marks, when a
definition written before the first flagged write leaves it out; they used to refuse it as deleting a system field.
A definition that names it is judged as before, so renaming or retyping it is refused. The panel sends the column back
on an update anyway, because it sends the collection as it read it. `RUNTIME_SYSTEM_FIELDS` in
`src/server/collections/fields.ts` is the one list of fields treated this way, and a definition that names one of them
has to keep it a system field. An import reads the stored collections fresh rather than from the isolate's cache, so a
column another isolate added a moment ago is carried over too.

**The filter.** `selectSQL` in `src/server/records/service.ts` is where every read's SQL is built: the list, the
list's count, and `fetchRecord`, which is behind the view route, `can-update`, the update and delete path's own
fetch, and the realtime feed's create and update events. The lane condition is added there, so a `filter`, a `sort`,
a page, the total and the feed cannot disagree about which rows exist. The expander runs the only other queries
against a collection's table (`fetchAllowed` and `fetchBackRelated` in `src/server/records/expand.ts`) and carries
the same condition, so an expanded record and a back-relation are judged as the list is. The feed's delete event
carries the row rather than reading it, so `deliver` judges that copy with `visibleInPreview`. The condition is
`_preview = ''` for a request with no branch, and `_preview = '' OR _preview = <branch>` for one with a branch; it
applies to superusers too, because a lane production's own reads can see is not a lane. A collection with no column
gets no condition at all, which is why an instance nobody previews is answered exactly as it was before.

**Where the header comes from.** The header, or `?preview=<branch>`, and the pull request comment hands out the
second. The `<branch>--<host>` form is not what was built: on Cloudflare a hostname that arbitrary needs a wildcard
custom hostname on a zone with an advanced certificate, and `workers.dev` gives a Worker exactly one name, so there
is nothing for the asset layer or a `_redirects` rule to rewrite from. The query parameter needs none of that and
reaches the Worker on every `/api/` request, which is where the records API lives, so the comment's address is
`https://<production>/?preview=<branch>` and its REST line is the same with the parameter or the header. A value
that is not a branch name (`^[A-Za-z0-9][\w./-]{0,99}$`) is read as no branch at all: the request is production's.

**What is not reversible, said plainly.** A flagged write that changes a row production already has *is* a change to
production; there is no copy to change instead. So flagged mode isolates **new** rows and cannot isolate an update
to an existing one, and rather than do it silently the write path refuses: an update or a delete under a preview
header, of a row whose mark is not that branch, is a 400 naming the row and pointing at `--shape instance`. A
production request is refused nothing, and a branch may change and delete its own rows freely. Two more limits worth
saying out loud: a view collection only filters if its query selects `_preview` (one that does not shows both lanes,
because it has no column to judge by); and a flagged write can still hit a unique index, a required relation or a
cascade that a production row is part of, because those are the table's, not the lane's.

**Cleaning up.** `voidbase previews remove <branch> --shape flagged` signs into production and calls
`DELETE /api/previews?branch=<branch>` (superuser), which deletes every row marked with that branch in every
collection that has the column, with the files those rows owned, and nothing else; then the pull request comment
becomes "removed". `voidbase previews prune --merged --shape flagged` does that for every branch `GET /api/previews`
reports whose pull request is merged or closed, and a production deploy with `VOIDBASE_PREVIEW_PRUNE=1` and
`VOIDBASE_PREVIEW_SHAPE=flagged` runs it in `after`. `voidbase previews list --shape flagged` lists the branches with
rows and how many. The delete is straight SQL, so a connected realtime client does not get a delete event for those
rows; its next read is correct.

`test/unit/previews-plugin.test.ts` measures the naming rule, the knobs (the seed kind and the shape), `before`, the
domains plugin standing down, the comment's body for both shapes and its post-once-update-after behaviour against a
fake GitHub, the prune decision against fake pull request states, the seeding sequence against two fake instances,
and the flagged remove and prune against a fake instance. `test/unit/preview-flag.test.ts` is the flagged shape's
records half on a real database: the column added on the first flagged write and on no other write, the filter on a
list, its count, a filter, a sort, the view route, `fetchRecord`, a forward expand, a back-relation expand and a view
collection, the mark that no body can set, the refusal on a production row, the removal taking one branch's rows
only, an import (through the service and through `$app.importCollections`) and an update whose definition leaves the
column out keeping it with its marks, a renamed or retyped mark still refused and so is a missing `id` that
PocketBase's defaults cannot stand in for, and an instance nobody previews being answered exactly as before.
`test/deploy-cf.ts` runs a `--preview` dry run, `after`, the listing, `--remove --preview` and the prune against the mock's Workers, D1, R2, queues, pull
requests and comments.

## The two core plugins: auth and observability

Auth left the core on 2026-09-09 (plan.md, decision 0.3): `src/server/plugins/auth.ts` is a plugin of tier `core`
that provides `auth@1`, owns `_superusers`, `_externalAuths`, `_authOrigins`, `_otps` and `_mfas`, and mounts every
auth route (password, OAuth2, refresh, methods, the flows, passkeys, and `auth-clear`, which ends a cookie
session). The interface has three parts, because the
core knows auth's shape and not only its result: `authenticate` (a request in, a record or null out) and
`fromToken` (the record behind a token the provider issued, of a given kind, which is also what a Void page's
loader reaches through `sessionOf`), `schema` (the fields every auth record
answers to in a rule, which `filter/compile.ts` asks for instead of keeping a list of its own) and `collections`
(which collections hold accounts), plus `isSuperuser`, which the core asks and does not decide. The core reaches
the provider through `src/server/auth-slot.ts` and imports none of the implementation, so replacing auth is
providing `auth@1` from another plugin. `CORE` lists `auth@1`: an instance running without a provider loads, runs
with nobody signed in and every superuser route answering 401, and says what it is missing at boot and on
`/api/plugins`. `voidbase plugins remove auth --yes` is that instance, and the `--yes` is the point: without it the
command prints what stops working and does nothing. Still in the core: the bootstrap creates the auth
collections; the manifest owns them, and handing their creation over is next.

Observability joined it on 2026-09-11, and the list should stay about that short: one because nothing works without
it, the other because an instance you cannot see into is one you cannot operate. `src/server/plugins/observability.ts`
is a plugin of tier `core` that provides `observability@1` (the section above). `CORE` is now `["auth@1",
"observability@1"]`, so `GET /api/plugins` and the boot log name either of them when nothing provides it, and
`voidbase plugins remove observability` prints what stops working and refuses without `--yes` exactly as auth's
does. What an instance does without a provider differs per interface, which is why the loader says it one interface
at a time (`WITHOUT` in `src/server/plugins/resolve.ts`): without auth the instance runs with nobody signed in and
every superuser route answering 401; without observability it still loads and serves every request, unmeasured,
with nothing sampled into Analytics Engine, `/api/observability` answering 404, and what the instance is doing
visible only in the D1 request log and whatever the Cloudflare dashboard happens to show.

Nothing else belongs on the list, and `realtime@1` is the example of why the list is not the only thing holding an
instance up. An instance with no realtime plugin is a working instance: writes are recorded and read, and only the
fanout is gone. So it is not core, nothing warns, and what keeps it up is the guard on the slot
(`src/server/realtime-slot.ts`, the realtime shape above) rather than a line in `CORE`. Every slot the core reads
per request is guarded that way: no provider means no policy, nothing sampled, and realtime off.

## What is not built

A marketplace's audit is a first pass and not a sandbox: a bundle runs inside the instance with everything the
instance has, the way `pb_hooks` does. A second auth provider (Better Auth) does not exist yet; the seam does.
