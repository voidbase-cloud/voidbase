# Plugins: an implementation plan

What it would take to build what `voidbase-site/pages/docs/roadmap.tsx` and
`voidbase-site/src/components/PluginsSoon.tsx` describe. Those two files are the specification; this one is the
route to them, in the order the decisions have to be made rather than the order the page lists them.

Everything marked **measured** was run against this codebase on 8 September 2026. The work lives on the `plugins`
branch: `src/server/kernel.ts`, `src/server/plugins/`, `src/server/interfaces/`, `scripts/kernel-bench.ts`, the
kernel block at the end of `src/server/app.ts`, and `test/unit/plugins.test.ts` and `kernel-invariant.test.ts`.

---

## What is already known

Findings that constrain the design, each with the thing that proved it.

| | |
|---|---|
| A cordis service name is an interface, and swapping providers is invisible to dependents | **measured**: two services both named `payments`, dependent injected `payments`, could not tell which it got |
| A plugin whose required service is missing does not run | **measured** |
| Composition is cheap: 0.62ms for 12 plugins, 1.31ms for 40, once per isolate | **measured**, `scripts/kernel-bench.ts` |
| cordis has no optional dependency. `Inject` maps a name to that service's *config*, so every entry is required | `cordis/packages/core/src/registry.ts`, `export type Inject<M> = (keyof M)[] \| { [K in keyof M]?: M[K] }` |
| Two providers of one interface: first wins, second discarded, **no error** | **measured** |
| A dependency cycle deadlocks silently, **no error** | **measured** |
| Hono's default SmartRouter refuses routes after its first match | **measured**; TrieRouter and LinearRouter allow it, RegExpRouter does not |
| Top-level await and the JSON version import survive both builds | **measured**: Worker bundle clean; the standalone executable builds and passes its end-to-end smoke test |
| Backups arrives through the kernel and still meets PocketBase's contract | **measured**: 17/17 backups conformance cases against a live dev server, restore round trip included |
| A dependent is torn down when its provider goes, and re-applied when a replacement arrives | **measured**: fiber state 2 → 0 → 2, apply count 1 → 2; `test/unit/plugins.test.ts` |
| Bindings arrive per request, not at module scope | `src/server/app.ts:74`, `attachHub(c.env)` in the request middleware |
| The standalone binary compiles a hooks directory at startup and imports it | `src/platform/node/hooks.ts` |
| On Workers hooks are a build-time virtual module: no filesystem, no eval | `src/platform/workers/hooks.ts` |
| The admin panel is PocketBase's prebuilt `ui/dist`, pinned at 0.40.2, copied unmodified | `scripts/sync-panel.ts` |
| The rule language embeds auth's schema, it does not merely call auth | `src/server/filter/compile.ts:218`, `requestAuth` resolves `@request.auth.*` against the record's fields |

---

## Phase 0 — Four decisions, before any code

Each of these is inherited by everything downstream and none can be retrofitted. Phase 1 cannot start without 0.1
and 0.2.

### 0.1 Who owns a collection

**The hole.** The roadmap says a plugin "adds routes, hooks, collections and panel screens". Nothing says what
happens when two plugins add `users`, or when one plugin's migration must run before another's. cordis orders code
by `inject`; migrations are ordered by filename timestamp. Those are two orderings that have to agree and currently
cannot even see each other.

**Decide:**

- A plugin's collections live in its own namespace (`stripe__customers`, or a manifest-declared prefix). Names
  collide at install, not at boot.
- Extending a collection somebody else owns is a declared operation, not a migration. A plugin says
  `extends: { users: [{ name: "stripeCustomerId", type: "text" }] }` and the loader applies it after the owner's
  migrations, or refuses if the owner is absent.
- Migration order derives from the plugin graph, not from filenames: a plugin's migrations run after those of
  everything it injects. Within a plugin, filenames still order.
- Uninstall has to answer what happens to the data. Proposal: collections are kept and orphaned, removal is a
  separate explicit command, because a plugin uninstall that drops a table is a plugin uninstall nobody will run.

### 0.2 Where plugin UI goes

**The blocker.** `scripts/sync-panel.ts` copies PocketBase's prebuilt panel and its own header says "The panel is
used unmodified". Only images and a title/docsUrl string are rewritten. A plugin cannot add a screen to a bundle
this project does not build. "Panel screens" as written in the roadmap is not implementable.

**The options, in order of what they cost:**

1. **Plugins get no panel UI.** They get routes, hooks, collections, config. Settings are collection records and
   the stock panel already edits those. Costs nothing, delivers less than the page promises. Change the page.
2. **A second surface at `/_plugins/`,** served by voidbase, its own small app, linked from the panel by a
   branding string. Keeps the panel unmodified and the version pin intact. Costs a UI to build and a second place
   for users to look.
3. **Fork the panel.** Delivers what the page says. Costs the "unmodified" property, the pinned upgrade path, and
   the compatibility promise the whole product rests on. Not recommended.

Take (1) now and leave (2) open. Whatever is chosen, `PluginsSoon.tsx` and the roadmap item must be corrected in
the same commit, because they currently promise (3).

### 0.3 What auth's contract actually is

The roadmap's contract — "a request goes in, a record or null comes out, and a record from `_superusers` is a
superuser" — is too small. `filter/compile.ts` resolves `@request.auth.<field>` against the auth record's fields
when compiling rules to SQL. The core knows auth's *shape*, not just its result.

**Decided 2026-09-09 (Mahmood: "okay sounds good, go"):** the auth interface has three parts, not one, and auth is
the core plugin providing it (`src/server/plugins/auth.ts`; the core asks through `src/server/auth-slot.ts`). The
two lookups take the request's bindings, `fromToken` joined the contract because files, backups and realtime verify
tokens of other kinds, `schema` returns name and type of the fields every auth record answers to (what
`filter/compile.ts` kept as a static set), and `collections` reads the auth collections from the schema, since an
auth collection is a type any collection can have. `isSuperuser` is the provider's. What was proposed:

- `authenticate(request) -> record | null` — the part the roadmap already has.
- `schema() -> Field[]` — what `@request.auth.*` may name, so the rule compiler can keep validating rules at
  compile time instead of failing at query time.
- `collections` — which collections are auth collections, since `listRule` and friends resolve against them.

If the second and third cannot be made clean, auth stays in the core and the roadmap item is rewritten. Better to
find that out in a design note than four phases in.

### 0.4 Which failures the loader owns

cordis provides none of these; they are ours to build on top of it.

- Two providers of one interface → refuse at install, name both, require the manifest to pick.
- A cycle → refuse at install, print the cycle.
- Missing required interface → the dependent does not load and the instance says which interface and who wanted it.
- Version mismatch → refuse at install, not at boot.

---

## What building it changed

Four things the code said that the plan did not. Recorded here rather than quietly fixed, because the plan is what
the next phase is argued from.

1. **A plugin provides its own interface; the kernel cannot open a slot for it.** cordis refuses an assignment to a
   service owned by another fiber. This is better than the plan assumed: a service registered by the plugin's own
   fiber is removed with that fiber, and every plugin that required it drops back to waiting and is re-applied when
   a replacement provider arrives. Measured, not inferred — and an earlier version of this claim was wrong about
   *how* to observe it: cordis's `on("dispose")` is not the signal, the fiber's `state` is.
2. **There is no second phase for binding-backed services.** The plan called for one, it was written, and it had no
   callers. voidbase already threads a `RecordContext` carrying db, storage, auth and collections through the write
   path — a container by another name — so a binding-backed thing needs to be *reachable from the request*, not
   built in a phase of its own. The kernel composes what is fixed at deploy; the request carries what arrives with
   it.
3. **The interface list has to be closed.** An unknown interface in a manifest is a typo, and a typo is a plugin
   that never loads for a reason nobody can see. `src/server/interfaces/index.ts` is the list, and a name outside
   it is refused at install.
4. **Hardening is not a leaf, and middleware is its own shape.** The plan listed it after backups as "leaf-shaped".
   It is middleware, `app.use("*")` for the body limit and the rate limit at the top of `app.ts`, and Hono composes
   handlers in registration order: middleware registered after a route never runs before it. The kernel loads at
   the end of `app.ts`, after every route, so a plugin cannot `use("*")` for itself. Loading the kernel before the
   routes instead would take plugin *routes* out from under `globalHookMiddleware`, the app's own `routerUse`
   middleware, which has to wrap every request. So middleware moves out as an interface rather than a mount: the
   plugin provides `hardening@1`, two handlers, and `app.ts` holds their place in the chain with a slot that asks
   the provider at request time, the same way the per-request middleware asks `realtime@1` for its client. No
   provider, no limits, which is the "gutted" semantics; another limiter is another provider. The general form, a
   kernel-owned middleware chain in load order, waits until the built-in middleware itself moves out.

5. **Realtime is not two plugins.** The plan said hub fanout and the change feed become two providers of
   `realtime@1` chosen by composition. Nobody *installs* one of those: the hub is a deployment detail, not a user's
   choice. The two-provider pattern is right for payments, where a person picks Stripe or Polar, and wrong here.
   Realtime is one plugin whose implementation follows the binding, and if that selection should happen at build
   time it belongs with the adapter in Phase 6, not with the loader.

---

## Phase 1 — The kernel — **done**

`src/server/kernel.ts` (`createKernel`, `load`, `serve`, `using`, `whatLoaded`), `src/server/plugins/manifest.ts`,
`src/server/plugins/resolve.ts`, and `src/server/version.ts` baking the version from package.json so the loader
knows what it is running against.

**What was built:**

- One composition phase, not two. Everything mounts at module scope under a top-level await, because Hono's default
  router refuses routes after its first match and cordis applies a plugin on a later tick. The planned second phase
  for binding-backed services was written, had no callers, and was removed (finding 2 above): a binding travels on
  the request, which voidbase's `RecordContext` already does.
- `PluginManifest`: name, version, tier, voidbase range, provides, requires, collections, extends.
- The four checks from 0.4, over the whole graph, before anything reaches cordis. Nothing is applied if anything is
  wrong, and everything wrong is reported at once.
- A plugin provides its interface with `serve(ctx, "payments@1", impl)` from inside its own `apply`, and reads one it
  required with `using(ctx, "payments@1")`.
- `/api/plugins`, superuser only, says what an instance is running and which core interfaces nothing provides.

**Verified:** 84 unit tests; Worker bundle clean; standalone executable builds and passes its smoke test end to end
(top-level await and the JSON import both survive `bun build --compile`); backups conformance 17/17 against a live
dev server with the routes arriving through the kernel.

**Risk:** `cordis@4.0.0-rc.9` says in its own README that the API "may change without notice". Everything hangs off
it. Either pin exactly and accept the upgrade work, or wrap it behind `kernel.ts` so the surface we depend on is
ours — the spike already does the latter, and it should stay that way.

---

## Phase 2 — Interfaces — **done**

`src/server/interfaces/index.ts` holds them, versioned in the name (`auth@1`, `payments@1`, `realtime@1`,
`mail@1`), and the list is closed: a manifest naming an interface outside it is refused at install. Auth is defined
with three parts rather than one, per 0.3. Nothing provides any of them yet; the registry exists so the first
provider has a contract to meet rather than a contract to invent.

Who may define one is the governance question the roadmap flags as unresolved. For now we do, here, and a community
plugin consumes rather than defines. That needs saying on the page.

**Verified, each as a test:** two providers of one interface are refused at install and both are named; a missing
provider names the interface and who wanted it; removing a provider drops its dependents to waiting and a
replacement re-applies them without the dependents changing; swapping Stripe for Polar leaves `checkout`'s load
position and behaviour unchanged.

---

## Phase 3 — Formats and shapes

`PluginsSoon.tsx` claims two formats across five shapes. One of its claims is wrong in our favour.

- **Unpackaged**: source in `pb_plugins/` (`vb_plugins/` for a stack app), committed, built by your build.
- **Packaged**: a prebuilt JS bundle plus its manifest. Not a recompiled binary — the standalone executable cannot
  rebuild itself, and it does not need to: `src/platform/node/hooks.ts` already compiles and imports a directory at
  startup, so a packaged plugin is evaluated the same way a hook file is.

**Correction to the page:** PluginsSoon says standalone and npm are "packaged only" because there is no build of
yours. That is not true of unpackaged plugins — the standalone binary loads source from a directory today, exactly
as `pb_hooks` does. Both shapes can take both formats. Only `cloud` is genuinely packaged-only, because you do not
hold the filesystem.

**Also worth saying on the page:** on Workers the plugin set is fixed at deploy, so a cloud install is a rebuild
and redeploy — minutes, and a deployment event rather than a toggle.

---

## Phase 4 — Tiers, and a bare instance — **done** (auth left the core 2026-09-09; `CORE = ["auth@1"]`)

- Three tiers as a manifest field: `core`, `official`, `community`. **Done.**
- The `CORE` list of interfaces an instance is not usable without is **empty until something actually leaves the
  core**. Listing `auth@1` before auth had moved out made every instance warn that it was running without auth
  while auth was running fine — caught before release. An interface joins the list in the commit that removes its
  built-in implementation, not before.
- An instance missing a core interface is not refused; it reports the gap on `/api/plugins` (superuser) and warns
  once in the log. **Done.** The "confirmation" the roadmap wants belongs to the CLI in Phase 6, and surfacing it on
  `/api/health` for the panel is open — `/api/health` is public, and an inventory of what is missing is a map of
  the attack surface, so that needs deciding rather than doing.
- **The "completely gutted" instance is an invariant, not a shipping mode.** Enforce it with a test — the loader
  imports nothing but the kernel and the manifest, every route is mounted by a plugin — and never ship it as a
  configuration. An instance with no auth answers 404 to everything the SDK and panel know how to ask; that is a
  build stage, not a product. The invariant is what stops the core quietly reabsorbing features, which is how every
  microkernel dies.

---

## Phase 5 — Moving features out

In this order, because it runs from proven to hardest.

1. **Backups.** **Done**, with a manifest (`official`, `voidbase: "*"`) and the full conformance suite passing
   through the kernel. It is the right first one: two dependents (`crons`, `app.ts`) and it provides nothing.
2. **Hardening.** **Done**, as the plugin providing `hardening@1` (finding 4): `src/server/plugins/hardening.ts`
   serves the body limit and the rate limit, `app.ts` keeps their place in the chain with a per-request slot, and
   `test/unit/hardening-plugin.test.ts` measures both halves, 413 with the plugin and pass-through without it. The
   IP helpers (`realIP`, `ipInList`) stay in `src/server/hardening.ts`: backups, files and auth use them, and they
   are request identity rather than a limit. Gated by the full CI like realtime.
   **Domains** and **email** are not extractions and not leaf-shaped, which an earlier version of this line claimed.
   The roadmap is explicit: attaching a hostname is an account-level action taken around a deploy rather than during
   a request, so domains want a deploy-time plugin surface that does not exist yet, and email is its pair (the
   `send_email` binding is the deploy's to declare; the instance half is a `mail@1` provider, the realtime shape
   again, a factory over the request's bindings). They move to Phase 5b as new work, with that surface first.
3. **Realtime.** **Done**, as *one* plugin providing `realtime@1` (finding 5; the two-provider shape is for choices
   a person makes, and nobody installs the hub). The interface is a factory over the request's bindings,
   `Realtime.for(env): RealtimeClient`, because on Workers the HUB binding arrives per request and not per isolate;
   the per-request middleware puts the client on the context (`c.get("realtime")`) and `RecordContext` carries it
   to the write path, so `records/service.ts`, `realtime/index.ts`, `oauth2/index.ts` and `hooks/migrations.ts` no
   longer import the hub module. Without a HUB binding the client is a `NoHub` whose `active()` is false, which is
   what the dev server and the standalone executable run. Passed the full `bun run ci` (56 suites, the realtime
   suite and the starter's hub delivery test among them) before it was committed.
4. **Auth**, last, and only if 0.3 resolved cleanly. It is the first core plugin and the one that proves the tier
   exists, but it is also the one whose schema the rule compiler embeds.
4. **Auth.** **Done** (2026-09-09), as the core plugin providing `auth@1`, with the three-part contract of 0.3 plus
   `fromToken` and `isSuperuser`. The implementation is unchanged in `auth.ts`, `auth-flows.ts`, `auth-extra.ts`,
   `oauth2/` and `webauthn.ts`; the plugin mounts the routes and serves the interface, `app.ts` imports none of it
   and asks `auth-slot.ts` who is signed in and what a superuser is, `filter/compile.ts` asks the provider for the
   fields an auth record answers to, and an instance without a provider loads with nobody signed in and reports
   `auth@1` missing. Measured by `test/unit/auth-plugin.test.ts` (the seam), the adapter boot and the conformance
   suites (the behaviour). Released as 0.9.0-beta.14; on the testbeds the same day: the demo's smoke and the full
   cloud loop (12 checks, an instance built with a plugin by the builder) pass with auth as the plugin, and a
   project with `disabled: ["auth"]` boots with nobody signed in, 404 on the auth routes, 401 on the inventory and
   the warning in its log. `@voidbase-cloud/plugin-auth` (its own repository, published on the tag) is listed on the
   marketplace as `auth` 0.1.0, and the demo installs it by name, so `/api/plugins` there names the marketplace as
   auth's origin: a core plugin replaced by a release of the same code, which is the road a different provider
   takes. Not moved: the bootstrap still creates the auth collections the manifest owns.


Each step: the feature moves behind an interface, the old module keeps its exports until the last call site is
converted, then the module goes. `bun test` and the conformance suite gate every step — plugin work that breaks
PocketBase compatibility has failed regardless of how clean the graph looks.

---

## Phase 5b — The official plugins that are new features

Twelve more official plugins on the roadmap are not extractions. They are built *on* the system and are what the
system is for, so they are also the only real proof it works. They do not block each other and can run in parallel
once Phase 2 lands, but three of them earn priority for what they prove rather than what they do.

**Build these three first, in this order, because each one tests a different claim:**

1. **Payment providers** — Stripe, Polar and Lemon Squeezy over one `payments@1` interface. This is the proof of
   Phase 2 and the roadmap's own worked example. Nothing else exercises multiple providers of one interface against
   real code, and if the interface is wrong this is where it shows. Also the only one with a webhook route per
   provider, which tests that two plugins can own different routes under a shared contract.
2. **OpenAPI, Scalar and a stateless MCP server** — generated from the collections an instance has, scoped to the
   caller. Worth early not for itself but for what it feeds: the typed client and the AI plugins both consume it
   instead of inventing their own view of the schema. It also tests a plugin reading the *whole* instance's schema,
   which is the read-side of the ownership question 0.1 answers for writes.
3. **Enterprise backup** — the archive format already exists in `src/server/backups.ts`; the work is completeness,
   verification and a tested restore. It tests a plugin that must see every other plugin's collections and files,
   which is the hardest read a plugin can make and the one most likely to expose a namespace mistake.

**Then, in any order:** preview environments (the roadmap notes it exercises every part of the loader, so it is a
good late integration test rather than an early one), Workers AI and Think, rich text, SEO, a progressive web app
and its service worker, translations, and the shop the other plugins plug into.

**Domains and email** belong here too, and share a prerequisite: a deploy-time plugin surface. A plugin today runs
inside an instance; attaching a hostname, waiting for its certificate and redirecting the rest to the canonical one
happen around a deploy, on the account, and so do onboarding a domain to Cloudflare Email Service and declaring the
Worker's `send_email` binding. The roadmap already names that surface as the general thing (backups want to
schedule, previews want to create and destroy instances). So the order is the surface first, domains as its first
plugin, then email as the pair whose instance half provides `mail@1`. Its consumer is `deliverMail` in
`src/server/mail/index.ts`, the one transport step under the templates, hooks and queue, and it already runs with the
bindings (the queue consumer hands them over), so `Mail.for(env).send(...)` reaches a provider from outside a request
the way realtime does. Check Email Service's availability on the account before promising the second.

**One thing to check before starting any of them:** several want panel UI — the AI chat in the admin panel, rich
text editing where it renders, the shop. They are blocked on decision 0.2 exactly as the format is. If 0.2 lands on
"plugins get no panel UI", those items need rewriting on the roadmap before they are built, not after.

---

## Phase 6 and 7 — Installing and the marketplace, as one system (direction of 2026-09-09)

Mahmood's direction, recorded verbatim in intent: auditing a plugin's source, bundling and packaging it, re-auditing
the packaged bundle and serving it are the **marketplace's** responsibility, so that contributing a plugin to the
official marketplace is simple. Anyone can run a competing, non-official marketplace for templates and plugins. An
instance connects to several marketplaces, installs plugins from any of them, and is not locked to the official
marketplace or to our official plugins.

What that settles, and what it changes from the earlier version of these two phases:

- **A plugin is a source repository with a `plugin.json`.** The contributor never builds or publishes an artifact.
  The three official plugins already have that shape (`voidbase-cloud/voidbase-plugin-backups`, `-realtime`,
  `-hardening`, listed on the marketplace through its own form on 2026-09-09). Their GitHub Packages publishing
  (`@voidbase-cloud/plugin-*`) is not the install path; the marketplace's bundle is. Keep the workflow while it costs
  nothing, retire it when bundles are served.
- **The marketplace is a pipeline, not only a list.** On approval it fetches the repository at a commit, audits the
  source (the deterministic checks it already runs for templates, plus `checkManifest` from voidbase and the
  interface names against `KNOWN`), bundles the plugin into one file with Bun's bundler (voidbase's entry points
  external, everything else inlined), re-audits the bundle (what it imports, that it reaches no network, `eval`,
  process or credential-shaped thing, and that its manifest matches the source's), hashes it (sha256), stores it in
  its own R2 and records the audit beside the entry. The marketplace is a voidbase stack app with an instance that
  "holds nothing yet, it is here for what comes after listing": this is what comes after listing.
- **The registry protocol is open and small**, so a competing marketplace is another server implementing it, and a
  static site with object storage is enough: `GET /registry/v1/index.json` (kinds; for each plugin its name,
  versions, manifest, integrity, bundle URL, audit summary, source repository and commit),
  `GET /registry/v1/plugins/<name>/<version>.json`, `GET /registry/v1/plugins/<name>/<version>/bundle.js`.
  Versioned, cacheable, no accounts. The spec lives in voidbase (`docs/registry.md`), because voidbase is the
  consumer and the spec is what stops the official marketplace being privileged.
- **The instance side.** `voidbase plugins ls|add|remove|update` take a marketplace URL (`--marketplace`, and
  `VOIDBASE_PLUGIN_MARKETPLACES` as the configured list; ours is a default that can be removed). `voidbase.lock`
  records, per plugin, the marketplace it came from, the version, the integrity hash and the source commit.
  `pb_plugins/` holds the downloaded bundles; on Cloudflare the set is fixed at deploy, so an install is a download
  plus a redeploy, as `PluginsSoon` already says. The loader loads `pb_plugins/*/bundle.js` beside the built-in
  list and resolves the whole graph as it does now. Two marketplaces offering one plugin name is refused unless the
  lockfile qualifies it (`<marketplace>/<name>`), the same rule as two providers of one interface. An instance with no
  marketplace configured runs its built-ins and nothing else changes.
- **Trust is the hash and the audit, not the marketplace's name.** An instance verifies the integrity hash on every
  install and build; a bundle is evaluated inside the instance the way `pb_hooks` is; a marketplace never runs a
  plugin. The official plugins go through the same pipeline as anyone's, which is the proof that nothing about our
  path is privileged.

Order of work:

1. **Done** (2026-09-09): `docs/registry.md`, the protocol; `src/node/registry.ts` (validator, integrity, fetch, pick,
   download, exported as `@voidbase-cloud/voidbase/registry`); the fixture marketplace under `test/fixtures/registry`,
   served by Bun in `test/unit/registry.test.ts`, whose bundle loads through the kernel and answers its route.
2. **Done** (2026-09-09): `voidbase-marketplace/scripts/bundle.ts` audits the source (checkManifest, the interface
   list, an entry point, the smell list), installs without scripts, bundles with Bun (voidbase's entry points and
   hono stay imports), audits the bundle, hashes it and writes `registry/v1/plugins/<name>/<version>{.json,/bundle.js}`
   plus the index; runs on `approved` and from the `bundle` workflow by hand. One deliberate difference from the line
   above: the served files are committed to the repository and emitted into the static build rather than put in R2
   behind the vb backend, because a release that arrives as a commit can be read, reviewed and reverted, and the
   bundles are hundreds of bytes; R2 is the step to take when they are not. `registry:check` validates the served
   registry with voidbase's own `problemsWithIndex` and every bundle against its record. Proof: voidbase's client read
   marketplace.voidbase.cloud, downloaded the three official releases and verified their integrity.
3. **Done** (2026-09-09): `src/node/installed.ts` (the lockfile, add/remove/enable/update/ls, the collision rule,
   `outsideRange` for `voidbase update`), `src/platform/node/plugins.ts` (verify every bundle against the lockfile and
   import it with its bare imports resolved to the running instance's modules, via Bun's `build.module`, so the
   executable loads bundles too) and `virtual:voidbase-plugins` from `hooks-plugin.ts` for Workers (verified at
   build). `app.ts` loads shipped minus disabled minus shadowed, plus installed; `/api/plugins` reports origins.
   `test/unit/installed.test.ts` measures all of it against the fixture marketplace, including a bundle importing the
   kernel entry point.
4. **Done** (2026-09-09): the three official plugins are releases on the marketplace; the demo (voidbase 0.9.0-beta.7)
   installed `backups` from it, which takes the place of the shipped one, and `echo` from a throwaway marketplace
   made of static files on GitHub (`voidbase-cloud/voidbase-throwaway-marketplace`, served by raw.githubusercontent.com).
   Live on demo.voidbase.cloud: `/api/echo` answers, `/api/plugins` reports both origins, backups still works. The
   same files served locally with `voidbase serve` load through the Bun path. Then (0.9.0-beta.8) the two shapes
   that were missing: the adapter carries `pb_plugins` and `voidbase.lock` into a stack app's generated app
   (`test/adapter.ts` boots one and gets the plugin's route), and a cloud instance installs from its page: the
   control plane records the set and queues a build, `scripts/instance-build.ts` (the `instance-build` workflow,
   every five minutes when the repository variable `VB_CLOUD_URL` is set, with `VB_BUILD_EMAIL`/`VB_BUILD_PASSWORD`
   as a superuser there) builds a release with `voidbase bundle --plugins-dir` from the base release's tag, pushes
   it without activating, and the control plane deploys the instance from it; an upgrade with plugins is that
   rebuild. Measured by the site's cloud e2e (12 checks) and then for real on voidbase.cloud, which is what the site
   and the demo are for: a user with a Cloudflare connection (a superuser can mint one through PocketBase's
   impersonation endpoint, with the org's deploy key sealed the way the OAuth callback seals a token) created an
   instance in the org account, installed `echo` from the throwaway marketplace, the builder workflow built
   `0.9.0-beta.8-vb-plugin-test.<id>` and the control plane deployed it, `/api/echo` answered on the instance and
   `/api/plugins` named the origin, all in under three minutes; then the instance and the user were deleted. The
   first real run found what the mock had hidden: the Worker upload sent its Durable Object migration as an array
   (Cloudflare 10021), so no cloud instance could have been created on a real account; fixed in 0.9.0-beta.9,
   and the mock now answers the way Cloudflare did. voidbase.cloud also had no active release at all until
   0.9.0-beta.8 was pushed to it. Not built: the unpackaged way.
5. **Done** with each step: the site's plugins page and `PluginsSoon`, the marketplace README, SUBMISSION, form and
   cards, and the plugin packages' READMEs say what exists and what does not. The plugins page is now the
   reference (what one is, how it arrives, decided, not, write one) rather than the design it was built from.
6. **Done** (2026-09-09), the testbeds run themselves: `voidbase-site/.github/workflows/live.yml` runs
   `test/cloud-live.ts --no-dispatch` (a throwaway instance on the account, a plugin installed, the builder's
   rebuild deployed, everything deleted) and `test/demo-live.ts` every night; `track-voidbase.yml` in the demo,
   the marketplace and the site bumps each to the latest published voidbase every hour and deploys it (the
   site starts its own Cloudflare build through `scripts/cf-build.sh`, because a push by the workflow token
   starts no workflow). Mahmood's rule, recorded in memory: the testbeds exist to break before voidbase ships
   something broken; mocks prove the wiring, only they prove the product.
7. **Done** (2026-09-09), and what rolling for real found: 0.9.0-beta.10 stores a redeployed Worker's secrets
   through the Workers API instead of one `wrangler secret put` at a time, because the demo's build hung on the
   second put twice, and an account that runs one build at a time queues every other build behind a hung one
   until Cloudflare gives up on it half an hour later. 0.9.0-beta.11 lets a deploy through when a secret declared
   `.optional()` has no value, because the site's deploy failed on its declared, valueless builder token. The
   trackers, dispatched by hand rather than waited an hour for, put beta.11 on the demo (`test/demo-live.ts`,
   10 of 10, sixteen seconds after the build), on the marketplace (its Cloudflare build runs the registry check,
   the site build and the typecheck, which matters because a push by the workflow token starts no GitHub
   workflow) and on the site, whose deploy with the builder token declared `.optional()` and absent (8 secrets
   declared, none valued, deployed) is the live proof of beta.11. The site had also been building every commit twice, once from Cloudflare's
   repository connection and once from its workflow, on that one-build account; `scripts/cf-build.sh` now adopts
   the build the connection started and starts one only when none appears, and stays the fallback for a trigger
   that stopped listening.
8. **Done** (2026-09-09), no GitHub Actions anywhere: Mahmood's direction, every repository is connected to its
   Worker and Cloudflare is the CI. The master trigger builds every push to master; the Worker's second trigger (a Worker takes
   two at most, so other branches build nowhere; 2026-09-10, Mahmood: four Workers on the account and no more)
   is `voidbase-ci (instance-build)`, which runs `scripts/instance-build.ts` and is started by the control plane
   through the Builds API (the site's Workflow watches the build and restarts a dead one), and the release
   build moves the testbeds onto a published version itself (`scripts/testbeds.ts`, which waits for the registry to
   serve the version and pushes with its own token: a build image pushes as Cloudflare's GitHub App otherwise). The
   marketplace's approval is a maintainer's command. GitHub holds no secrets or variables any more. Then Mahmood cut
   the three apps' pipelines to the bone ("this is insane, they are low importance apps"): a push to master is
   `bun run build` (Vite) and `bun run deploy` (`voidbase sync`), nothing else, no branch builds; the live proof is
   `bun run live` on the site by hand, the demo's smoke is `bun test` by hand. Found on the way and fixed in
   voidbase: a Void app's `crons/` schedule never reached the Worker's cron triggers (0.9.0-beta.13), and the
   request-log suite compared rows by an equal timestamp.

---

9. **Done** (2026-09-09): a plugin creates the collections it owns. `onBootstrap(ctx, fn)` in the kernel registers
   work done once per isolate with the bindings, run by `app.ts` after voidbase's own bootstrap in load order;
   `ensureCollections(plugin, db, definitions)` (`@voidbase-cloud/voidbase/plugins/collections`) creates the
   missing ones through the collections service and refuses a name the manifest does not own before touching the
   database. Measured in `test/unit/plugin-collections.test.ts` and by the adapter boot, whose carried plugin owns
   and creates `carried_notes`; proven on the demo by echo 0.2.0 from the throwaway marketplace owning `echoes`.
   The first cloud run found what the demo could not: the builder builds a release from voidbase's own checkout,
   where the package is not in its own node_modules, so a bundle importing `@voidbase-cloud/voidbase/kernel` had
   nothing to resolve to and Rolldown refused the build (a project's Vite finds the package installed). Fixed in
   the hooks plugin, which maps a bundle's bare imports to voidbase's files through its exports map and hono to
   its own copy (`providedImport`, unit-tested); the cloud loop with echo 0.2.0 is the proof.

10. **Done** (2026-09-10), Cloudflare's own products for what voidbase already has (Mahmood: "we are not using
    Secrets Store, Workflows or Flagship even though our instance already has these concepts"). *Secrets Store*:
    `VOIDBASE_SECRETS_STORE=<store id>` makes a deploy store every declared `secret()` in the account's store as
    `<worker>__KEY`, bind each as `secrets_store_secrets`, and retire the Worker's own of those names; the runtime
    resolves every such binding's async `get()` once per isolate (`src/server/secrets-store.ts`) before anything
    reads env; `voidbase secrets push` and the listing follow. *Flagship*: a `flag()` tier (booleans) that the
    deploy creates in a Flagship app named after the Worker with its default (the dashboard's word wins after),
    binds as `FLAGS` and bakes as `VOIDBASE_FLAGS`; `src/server/flags.ts` evaluates the declared flags per request
    with a targeting key and writes them onto the request's env, so every reader of a boolean knob sees the flag.
    *Workflows*: `workflows/<name>.ts` in a Void app is bundled beside the app, exported from the Worker and bound
    as `WORKFLOW_<NAME>`; `withApp(env, fn)` (`@voidbase-cloud/voidbase/workflows`) opens the app inside a step.
    voidbase.cloud's instance builds are such a run (start the builder, wait for its report, fail with a reason
    after 45 minutes), which retires the keeper cron; the site's presence and self-delete knobs and the demo's
    uploads are flags. Left to Mahmood: the deploy token lacks "Account Secrets Store Edit" and "Flagship Write",
    so the store and the flags stay at their fallbacks on the three apps until it has them.

## Where it is going: three ways to run, two modes, one CLI (Mahmood, 2026-09-09)

The picture to work towards, now on the site's roadmap too. An instance runs three ways: the standalone
executable on your own machine, the npm package on your own machine (on miniflare, so the Workers code runs as it
runs deployed; today it runs on Bun), and on Cloudflare through wrangler, the voidbase CLI or voidbase cloud. A
machine is put on the internet in a minute with a try.cloudflare.com quick tunnel (`voidbase serve --tunnel`, for
the executable and the npm package alike). All three run in two modes: a vanilla instance (no repository, no
project, no directory layout: download the executable or install the package globally and run it, or make a cloud
instance) or a voidbase project, which wraps the instance in the `pb_` folders you version on GitHub and deploy
from CI/CD. A GitHub voidbase project and a Cloudflare voidbase project are synced with one CLI command, which is
how CI/CD gets set up. The CLI moves data between all three ways in either direction. And the adapter builds
voidbase stack semantics into voidbase project semantics, so a stack app is hosted on a machine or on Cloudflare
like any project. What exists: the executable, the package on Bun, Cloudflare all three ways, both modes in shape,
`voidbase sync`, the adapter, and (2026-09-10) the installer: an instance changes its own plugins (`installer`, a
shipped plugin: on disk on Bun, as a commit to the repository it deploys from on Workers), so nobody builds a
release for a customer's instance; voidbase.cloud wraps voidbase and the user's Cloudflare account, plus the
GitHub connection for templates and pipelines (Mahmood, 2026-09-10: "that shouldn't be us, it should be the user
themselves through their cloudflare account, ideally from within the instance itself as a core plugin"). The
builder trigger, the instance-build workflow and the per-instance releases went with it. And voidbase.cloud itself
does its work in the browser (Mahmood, 2026-09-10: "voidbase cloud does not need any server capabilities really"):
the site keeps sign-in, sealed tokens, rows and two pass-throughs to Cloudflare's and GitHub's APIs; the page
provisions, upgrades and deletes in the user's account with voidbase's REST code, links repositories, and changes
plugins through the instance's installer. And (2026-09-11) two of the CLI promises: `voidbase migrate <from> <to>` is
a backup on the source restored on the target through the backups API over HTTP, so it moves data between any two
running instances in either direction; `voidbase serve --tunnel` runs cloudflared (configured, on PATH, or
downloaded once into the cache) and prints the trycloudflare address in the banner. What does not exist: miniflare
for the package.

## What to correct on the site when this lands

Both files are promises, and some are now wrong in each direction:

- `PluginsSoon.tsx` says "There is no manifest format, no loader, and nothing to install." After this release the
  first two exist inside voidbase; the third is still true, and it is the one a reader cares about. Rephrase to say
  the loader exists and nothing is installable yet, rather than leave a sentence that is half false.
- `PluginsSoon.tsx`: panel screens (0.2), standalone/npm being packaged-only (Phase 3), and cloud installs being a
  button rather than a redeploy (Phase 3).
- `roadmap.tsx`: the interfaces item promises that ambiguity and cycles are refused. That is **now true**; the
  item can stop being a plan. The auth item's contract is too narrow (0.3).
- The acknowledgments page lists runtime dependencies "taken from the package's NOTICE file". NOTICE now lists
  cordis, cosmokit and @standard-schema/spec (all MIT); the page should too.

Correcting the page is part of the phase that makes it true, not a follow-up.

---

## The order, condensed

```
0.1 collection ownership ─┐
0.2 panel UI decision     ├─→ 1 kernel ─→ 2 interfaces ─┬─→ 5a backups ─→ hardening
0.3 auth contract         │                  │          │        │
0.4 loader failures ──────┘                  │          │        └─→ 6 lockfile + CLI ─→ 7 marketplace
                                             │          │
                                             │          └─→ 5b payments ─→ openapi/mcp ─→ enterprise backup
                                             │                                  └─→ the other nine; domains and email once a deploy-time surface exists
                                             └─→ 4 tiers
                                                    │
                     5a realtime, one plugin ──┤   (needs a full ci run beside it)
                                 5a auth ───────────┘  (done: 0.3 decided, auth@1 is core)
```

The two that decide whether the rest is worth starting are 0.1 and 0.2. Neither is a coding problem.
