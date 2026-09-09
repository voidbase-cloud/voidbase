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

**Decide:** the auth interface has three parts, not one.

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

## Phase 4 — Tiers, and a bare instance — **partly done**

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

1. `docs/registry.md`, the protocol, and a fixture marketplace under `test/` that serves it, so the instance side is
   developed against something that is not ours.
2. The marketplace pipeline: audit source, bundle, re-audit, hash, store, serve `/registry/v1/*` from the vb backend
   over R2 and the registry files; run it from the submission workflow on `approved`, and as `bun scripts/bundle.ts
   <repo> <commit>` by hand.
3. The instance: bundles in `pb_plugins`, the four CLI verbs, the lockfile with integrity, multi-marketplace rules,
   `voidbase update` saying which installed plugins will not survive a jump before performing it.
4. The three official plugins re-listed through the pipeline (bundle, audit, hash), and installed into the demo from
   the official marketplace to prove the loop; then one of them installed from a second, throwaway marketplace to
   prove there is no lock-in.
5. The site's plugins page, `PluginsSoon`, the marketplace README and SUBMISSION corrected as each step makes them
   true, not after.

---

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
                                 5a auth ───────────┘  (only if 0.3 resolved)
```

The two that decide whether the rest is worth starting are 0.1 and 0.2. Neither is a coding problem.
