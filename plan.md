# Plugins: an implementation plan

What it would take to build what `voidbase-site/pages/docs/roadmap.tsx` and
`voidbase-site/src/components/PluginsSoon.tsx` describe. Those two files are the specification; this one is the
route to them, in the order the decisions have to be made rather than the order the page lists them.

Everything marked **measured** was run against this codebase on 8 September 2026. The spike that produced those
numbers is currently uncommitted in this working tree: `src/server/kernel.ts`, `src/server/plugins/`,
`src/server/realtime/hub.ts`, `scripts/kernel-bench.ts`, and the kernel block at the end of `src/server/app.ts`.

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
| Top-level await in `app.ts` survives the Worker bundle | **measured**: `bun run build` clean, 57/57 tests pass |
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
   fiber is disposed with that fiber, which is the propagation the whole system rests on, and it comes free.
2. **There is no second phase for binding-backed services.** The plan called for one, it was written, and it had no
   callers. voidbase already threads a `RecordContext` carrying db, storage, auth and collections through the write
   path — a container by another name — so a binding-backed thing needs to be *reachable from the request*, not
   built in a phase of its own. The kernel composes what is fixed at deploy; the request carries what arrives with
   it.
3. **The interface list has to be closed.** An unknown interface in a manifest is a typo, and a typo is a plugin
   that never loads for a reason nobody can see. `src/server/interfaces/index.ts` is the list, and a name outside
   it is refused at install.
4. **Realtime is not two plugins.** The plan said hub fanout and the change feed become two providers of
   `realtime@1` chosen by composition. Nobody *installs* one of those: the hub is a deployment detail, not a user's
   choice. The two-provider pattern is right for payments, where a person picks Stripe or Polar, and wrong here.
   Realtime is one plugin whose implementation follows the binding, and if that selection should happen at build
   time it belongs with the adapter in Phase 6, not with the loader.

---

## Phase 1 — The kernel — **done**

Built on the `plugins` branch: `src/server/kernel.ts`, `src/server/plugins/manifest.ts`,
`src/server/plugins/resolve.ts`, and the version baked from package.json so the loader knows what it is running
against. 83 unit tests, Worker build clean.

**Build:**

- `src/server/kernel.ts` — the cordis context, `use()`, `ready()`. Exists in the spike.
- **Two-phase composition, because of the two constraints together.** Routes must be mounted before the first
  request (SmartRouter), and bindings do not exist at module scope (Workers). So:
  - *Mount phase*, module scope, under top-level await: plugins register routes, hooks and cron handlers. Handlers
    read `c.env` when they run, which is what every existing handler already does.
  - *Service phase*, first request, memoised per isolate: services that wrap a binding are created then.
  - A plugin therefore cannot decide *whether* to mount based on a binding. It mounts and answers 501 at call time.
- `PluginManifest` type: name, version, provides, requires, voidbase range, collections, extends, tier.
- The four checks from 0.4, run over the manifest graph **before** anything reaches cordis.

**Verify:** `bun test` green, `bun run build` clean, `scripts/kernel-bench.ts` under 2ms for the real plugin count.

**Risk:** `cordis@4.0.0-rc.9` says in its own README that the API "may change without notice". Everything hangs off
it. Either pin exactly and accept the upgrade work, or wrap it behind `kernel.ts` so the surface we depend on is
ours — the spike already does the latter, and it should stay that way.

---

## Phase 2 — Interfaces — **done**

`src/server/interfaces/index.ts` holds them, versioned in the name. Auth is defined with three parts rather than
one, per 0.3. The realtime entry is there but nothing provides it yet; see finding 4 above.

**Build:**

- Interfaces are versioned names: `auth@1`, `payments@1`. A provider declares `provides: ["payments@1"]`, a
  consumer `requires: ["payments@1"]`. The version is part of the service name in cordis, so a major bump is a
  different service and nothing silently half-matches.
- An interface registry in this repo: `src/server/interfaces/` holding the TypeScript type for each, versioned.
  Who may define one is a governance question the roadmap flags as unresolved — for now, we do, and community
  plugins consume rather than define. Say so on the page.
- The fallback pattern replaces optional injection. Hub fanout and the D1 change feed are not one plugin with a
  branch; they are two plugins providing `realtime@1`, and composition picks by whether the binding exists.
  **This is a rewrite of the realtime path, not a move**: `if (hubActive())` in `records/service.ts` and
  `realtime/index.ts` becomes a fork.

**Verify:** a test that installs two providers and asserts the install is refused; one that removes a provider and
asserts every dependent unloaded; one that swaps providers and asserts the dependent's behaviour changed without
the dependent changing.

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

## Phase 4 — Tiers, and a bare instance — **done**

- Three tiers as the roadmap describes, as a manifest field: `core`, `official`, `community`.
- Core plugins are installed and enabled by default and ship in the bundle.
- Removing a core plugin is possible and deliberate: a confirmation, and the instance reports what it is missing
  from a `/api/health` field the panel can show.
- **The "completely gutted" instance is an invariant, not a shipping mode.** Enforce it with a test — the loader
  imports nothing but the kernel and the manifest, every route is mounted by a plugin — and never ship it as a
  configuration. An instance with no auth answers 404 to everything the SDK and panel know how to ask; that is a
  build stage, not a product. The invariant is what stops the core quietly reabsorbing features, which is how every
  microkernel dies.

---

## Phase 5 — Moving features out

In this order, because it runs from proven to hardest.

1. **Backups.** Done in the spike, twenty lines. It is the right first one: two dependents (`crons`, `app.ts`) and
   it provides nothing.
2. **Hardening**, then **domains**, then **email**. All leaf-shaped like backups. Domains and email are also the
   pair that gives the marketplace its first real story, since email depends on the domain plugin having run.
3. **Realtime**, as the two-providers fork from Phase 2. First real test of the interface mechanism against
   existing code.
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

**One thing to check before starting any of them:** several want panel UI — the AI chat in the admin panel, rich
text editing where it renders, the shop. They are blocked on decision 0.2 exactly as the format is. If 0.2 lands on
"plugins get no panel UI", those items need rewriting on the roadmap before they are built, not after.

---

## Phase 6 — Installing

- `voidbase.lock`: what is installed, at which version, from which registry, with an integrity hash. An install is
  a commit for the shapes that have a repository.
- CLI: `plugins`, `plugins add`, `plugins remove`, `plugins update`, per the commands already written in
  `PluginsSoon.tsx`. They are the specification; keep them exactly, including `--name` for a local instance and
  `--registry`.
- Registry: a listing served over HTTP, ours as the default via `VOIDBASE_PLUGIN_REGISTRY`, anyone's by URL. The
  page already promises nothing about our path is better than a private one — keep that true by developing against
  a local registry fixture rather than the real one.
- Compatibility: a plugin declares its voidbase range, install refuses outside it, and `voidbase update` says which
  installed plugins will not survive a jump **before** performing it.

---

## Phase 7 — The marketplace

Out of scope for this repository beyond the registry protocol it serves. What this repo owes it: a stable manifest
format, a stable registry API, and the integrity hash. Everything else is the marketplace's own.

---

## What to correct on the site when this lands

Both files are currently promises, and three of them are wrong:

- `PluginsSoon.tsx`: panel screens (0.2), standalone/npm being packaged-only (Phase 3), and cloud installs being a
  button rather than a redeploy (Phase 3).
- `roadmap.tsx`: the interfaces item promises that ambiguity and cycles are refused — true only once we build the
  checks cordis does not have (0.4). The auth item's contract is too narrow (0.3).

Correcting the page is part of the phase that makes it true, not a follow-up.

---

## The order, condensed

```
0.1 collection ownership ─┐
0.2 panel UI decision     ├─→ 1 kernel ─→ 2 interfaces ─┬─→ 5a backups ─→ hardening/domains/email
0.3 auth contract         │                  │          │        │
0.4 loader failures ──────┘                  │          │        └─→ 6 lockfile + CLI ─→ 7 marketplace
                                             │          │
                                             │          └─→ 5b payments ─→ openapi/mcp ─→ enterprise backup
                                             │                                  └─→ the other nine
                                             └─→ 4 tiers
                                                    │
                                 5a realtime fork ──┤
                                 5a auth ───────────┘  (only if 0.3 resolved)
```

The two that decide whether the rest is worth starting are 0.1 and 0.2. Neither is a coding problem.
