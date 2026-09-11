# Cheap, fast, idle-free: how voidbase should use Cloudflare

One voidbase app is one Worker, one D1 database and one R2 bucket, deployed with `voidbase deploy`. That shape is
right and stays: Cloudflare bills Workers per request, D1 per row and R2 per byte, so an app nobody uses costs
its storage and nothing else, and the account limit of 500 Workers (raisable) is where "thousands of apps" is
bounded. The improvements below make each app cheaper per request and faster, in the order of their effect.
Numbers come from Cloudflare's pricing and limits pages (Workers Paid plan, 2026); the Void guides for static
assets, live, WebSockets, queues, KV and SSE frame what Void exposes today.

## Where the money and the milliseconds go today

| Per request or per event | Cost driver | Today |
| --- | --- | --- |
| Every asset request (panel, app bundle, images) | a Worker invocation ($0.30 per million beyond 10 million) plus CPU | was: `middleware/` made Void route **everything** worker-first (`run_worker_first: ['/**']`); now asset-first, the Worker runs for `/api` only (item 1) |
| Every API request | one `_logs` row written ($1 per million rows) | request logging at `minLevel: 0` writes a row per request; on a 10 million-request app that is $10 of log writes, more than the requests themselves |
| Every record write | one extra `_changes` row for realtime | written whether or not anyone is subscribed |
| Every minute, every app | a cron invocation (a billable request + CPU) | 43,200 invocations per app per month even when idle; 500 apps make 21.6 million, above the included 10 million |
| Every request | several D1 round trips from wherever the Worker runs | D1 lives in one region; a Worker far from it pays 50 to 150 ms per query |
| Every cold start | the Photon wasm is imported at module load | paid on requests that never touch an image |
| While a client is connected | one D1 read per second per isolate (realtime poll) | $0.003 per isolate-month of reads: already cheap, but ~1 s latency |

## Improvements, ranked by effect

1. **Assets off the Worker.** Serve the panel, the frontend build and the app's deep links from Cloudflare's asset
   layer with the Worker scoped to `/api`. Void does this for apps with only `/api` routes (`run_worker_first` on `/api`
   and `/api/*`), so the `middleware/` file that emulated PocketBase's `--publicDir` fallback is gone. The catch: Void's
   generated Worker entry passes every GET 404 through `env.ASSETS.fetch`, and Cloudflare applies `not_found_handling`
   to binding fetches too, so with the inferred `single-page-application` mode an unknown `/api/...` path came back as
   `index.html` with status 200 (in `vp preview` and on a deployed probe). A `_redirects` `/* / 200` rule is worse: it
   shadows real assets. The shape that works is `routing.notFound: "404-page"` with `404.html` copies of the SPA shell
   and of the panel's index (written by `hooks-plugin.ts` at build time and by the sync scripts for dev): the asset
   layer answers deep links itself with the shell (status 404, the pattern SvelteKit documents for Cloudflare), the
   binding returns a real 404 for `/api` misses so API clients keep PocketBase's JSON 404, and browser navigations to
   an unknown `/api` URL get the HTML page. Verified on a deployed probe: misses never invoke the Worker, real assets
   keep their ETags, nested `_/404.html` wins for `/_/...`. docs/differences.md records the status-code difference.
2. **Log writes are the biggest D1 cost.** Default `settings.logs.minLevel` to warnings on Cloudflare (4xx, 5xx,
   slow requests), keep the full log opt-in from the panel, and offer a sink that is built for this volume:
   Workers Logs or Analytics Engine ($0.25 per million data points, queryable in the dashboard) instead of D1 rows.
   PocketBase writes every request to its own SQLite file; on D1 every one of those is a billed row.
3. **Change-feed rows only when someone listens.** Skip the `_changes` insert when `_realtime_clients` is empty
   (cached per isolate for a few seconds). Idle apps and batch imports halve their write rows.
4. **Crons only when needed.** The hooks bundle is built at deploy time, so the plugin knows every `cronAdd`
   expression: register those as the Worker's triggers (PocketBase's cron syntax is Cloudflare's; up to 5 per
   Worker, else fall back to every minute) plus one hourly trigger for PocketBase's maintenance jobs. Better still,
   make the maintenance lazy (run on the next request when overdue) so an app with no `cronAdd` has no trigger.
5. **Latency: put the Worker next to D1, or replicate reads.** Smart Placement (`placement: { mode: "smart" }`)
   moves each app's Worker beside its database, turning five sequential queries from 500 ms into 25 ms for far
   users; D1's Sessions API (`withSession("first-unconstrained")`) instead serves reads from replicas near the user
   and sends writes to the primary. Smart Placement is the safer default for PocketBase-shaped traffic (a list
   request runs several dependent queries); replication suits read-heavy global apps.
6. **Lazy wasm.** Import Photon on the first thumbnail request rather than at module load: smaller cold start on
   every other request.
7. **Queues for the slow and the retryable.** Outbound mail and the automatic backups go through a `queues/`
   consumer in the generated Void project (`src/server/jobs.ts`): the request returns as soon as the message is
   queued, Cloudflare retries failures with backoff, and a message dropped after its last retry is posted to the
   alert webhook. Delivery is at-least-once, so a mail whose SMTP session failed after the server accepted it can
   arrive twice; hooks (`onMailerSend` and friends) run in the request on the final message, the panel's test email
   and `$app.newMailClient()` stay synchronous. Thumbnail pre-generation was tried and dropped: PocketBase renders
   thumbs on demand and a storage listing would show thumbs nobody asked for (the S3 suite compares listings).
   Reliability more than cost ($0.40 per million operations).
8. **KV for what the edge reads on every request and tolerates 60 s of staleness**: the public `auth-methods`
   answer, the settings snapshot, hostname-to-app when several apps share a Worker. Reads $0.50 per million;
   D1 stays the source of truth.
9. **Rate limits shared across isolates.** Cloudflare's rate-limiting binding is free and counts per location;
   voidbase's counters are per isolate (documented as approximate). The deploy declares one (`RATE_LIMITER`, a
   ceiling per IP on `/api`, PocketBase's default 300 per 10 s) and the middleware consults it while rate limits are
   enabled. Cloudflare's own docs call the binding permissive and eventually consistent, so it is a shared ceiling,
   not an exact counter; the settings' rules keep their per-isolate windows.
10. **Realtime as push instead of poll (later).** A per-app Durable Object hub with hibernating WebSockets from
    the edge Workers that hold the SSE streams (Workers bill per request, not wall-clock; the object sleeps between
    pushes: Cloudflare's own example is 100 objects × 100 connections for about $10 per month). It removes the
    poll and its latency. Void exposes Durable Objects only through `.ws.ts` rooms and `void/live` (256 subscribers
    per topic, which a busy collection exceeds), and `void deploy --backend cloudflare` refuses custom Durable
    Object classes, so this waits for Void support or a wrangler-deployed hub. The current poll costs $0.003 per
    isolate-month, so this is a latency improvement, not a cost one.

Applying 1 to 4 changes the bill of a typical app from "every request and every minute" to "API requests and
rows actually written", and 5 and 6 are the two latency wins visible to users.

### Status (implemented 2026-09-06)

| Item | State | Where |
| --- | --- | --- |
| 1 assets off the Worker | done: asset-first with `routing.notFound: "404-page"` and 404.html shells; deep links carry status 404 (docs/differences.md) | `void.json`, `hooks-plugin.ts` `writeNotFoundShells`, `scripts/sync-*.ts` |
| 2 log threshold | done: request rows are written only at or above `max(settings.logs.minLevel, VOIDBASE_LOG_MIN_LEVEL)`; the Workers default is 4 (warnings: 4xx, 5xx, slow requests), the Bun runtime and the test suites keep 0 | `src/server/logs.ts`, `#platform/env` `defaultLogMinLevel`, `env.ts` |
| 3 change feed only with listeners | done: the `_changes` insert is a conditional `INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM _realtime_clients)` inside the same write batch, so it costs no extra round trip and writes no row when nobody is subscribed | `src/server/records/service.ts` |
| 4 crons only when needed | done: the hooks plugin reads every `cronAdd` expression at build time and registers them as the Worker's triggers (macros expanded; more than 4 falls back to every minute), plus one hourly tick; PocketBase's maintenance jobs (log and file cleanup, token purge, backups) also run lazily on the next request when overdue, and a tick catches every job due since the last one | `hooks-plugin.ts` `cronTriggers`, `crons/every-minute.ts`, `src/server/crons.ts` |
| 5 Smart Placement | done for `voidbase deploy` (`placement: { mode: "smart" }` in the generated wrangler config). Caveat from Cloudflare: with `run_worker_first` the whole Worker is placed as one unit, so asset requests from far users travel to the placed region as well; browsers cache those, API latency wins | `src/node/deploy-cf.ts` |
| 6 lazy wasm | done: Photon is imported on the first thumbnail request, and resvg on the first share card asked for as a PNG; both are dynamic imports, so a request that touches neither pays for neither | `src/server/records/thumbs.ts`, `src/platform/*/raster.ts` |
| 7 queues | done (2026-09-06): mail and automatic backups through the `<name>-jobs` queue with retries and an alert on drop; inline without the queue. Verified in dev, in `vp preview` (mail-http) and on a deployed probe | `src/server/jobs.ts`, `queues/jobs.ts`, `src/server/mail/index.ts`, `src/server/backups.ts` |
| 2b log sink | done, opt-in: Analytics Engine data point per request (`--analytics`); the account must enable Analytics Engine once, which is why it is not the default | `src/server/logs.ts`, `src/node/deploy-cf.ts` |
| 8 KV | skipped: settings are cached per isolate and Smart Placement makes the remaining D1 read cheap | |
| 9 rate limits | done: the rate-limit binding as a per-location ceiling per IP while rate limits are enabled (`--rate-limit`); eventually consistent by Cloudflare's design | `src/server/hardening.ts`, `src/node/deploy-cf.ts` |
| 10 Durable Object hub | done: one SQLite-backed `VoidbaseHub` per instance, exported from the instance's own Worker (the plugin appends it to Void's generated entry; wrangler.jsonc declares the binding and the `new_sqlite_classes` migration, which Void's Cloudflare backend accepts). Each SSE connection holds one hibernatable socket to it, writes publish after their D1 batch commits, subscription changes are relayed through it, and the object sweeps sockets that stopped pinging. Without the binding (Bun, `--no-hub`) the D1 poll stays. Local fan-out to 100 clients: p50 346 ms (poll: 587 ms), one client: about 50 ms. Void itself neither promises custom Durable Objects nor offers a cheaper primitive: `void/live` keeps one active object per open stream and caps a topic at 256 subscribers | `src/server/hub.ts`, `src/server/realtime/`, `hooks-plugin.ts` `hubEntry` |
| 11 Durable Object database | done (2026-09-11), behind `VOIDBASE_DATABASE=durable`: the instance's data in its own SQLite-backed `VoidbaseDatabase` through the same D1 interface, `batch` a real transaction; the 100-column and 100-parameter ceilings stay (measured on workerd). Section below | `src/server/durable-db.ts`, `src/server/durable-d1.ts`, `test/workers-durable.ts` |


### The Worker bundle, and the wasm in it (2026-09-11)

The Rust-compiled-to-wasm parts of voidbase are most of the deployed Worker, so what is in the bundle is a
decision, not a detail. Cloudflare's limit is on the **compressed** size: 3 MB on the free plan, 10 MB on Workers
Paid. Measured with `vp build` on this repo's own Void app plus `gzip -9` per file:

| | raw | gzipped |
| --- | --- | --- |
| Everything else (the app, the panel's API, hono, the plugins) | 1.57 MB | 0.39 MB |
| Photon, for thumbnails (`@cf-wasm/photon`) | 1.57 MB | 0.62 MB |
| **Default total `dist/ssr`** | **3.14 MB** | **1.01 MB** |
| resvg, for PNG share cards (`@resvg/resvg-wasm`), with `VOIDBASE_SEO_PNG=1` | +2.48 MB | +0.95 MB |
| the chunk it loads with (its glue and the card's two font faces, base64) | +0.24 MB | +0.09 MB |
| **Total with `VOIDBASE_SEO_PNG=1`** | **5.85 MB** | **2.05 MB** |

The PNG share cards were built as an always-on feature first, and the measurement is what made them a knob: 1.01
to 2.05 MB gzipped is roughly double, and two thirds of the free plan's headroom, charged to every instance
whether or not it ever serves a card. So `VOIDBASE_SEO_PNG` (docs/plugins.md, docs/deploy.md) is read at build
time as well as at runtime: off, which is its default, the hooks plugin aliases `#platform/raster` to a stub and
neither the wasm nor the font is in the build at all (measured at 3.14 MB raw / 1.01 MB gzipped, what it was
before the feature existed, within 2 KB). The ceiling is only at risk with the knob on, and only on the free
plan. Neither wasm module is imported at module load (item 6), so all of this is bundle size and Worker startup,
not per-request CPU.

## The database as a Durable Object: `VOIDBASE_DATABASE=durable` (2026-09-11)

The roadmap's transactions entry, shipped behind a knob. With `VOIDBASE_DATABASE=durable` (the environment or
`pb_secrets/secrets.json`; `--database durable` on `voidbase deploy` and on `voidbase serve --workers`) an instance's
data lives in its own SQLite-backed Durable Object, `VoidbaseDatabase` (`src/server/durable-db.ts`), exported from
the instance's Worker beside the realtime hub and bound as `DB_OBJECT` under its own `new_sqlite_classes` migration
tag (`voidbase-database-v1`); no D1 is created or bound. Without the knob nothing changes.

**What changes in the code: one seam.** Every query already goes through the D1 interface (`src/server/db.ts`), and
`src/node/d1.ts` is the proof it is swappable (the Bun runtime over `bun:sqlite`). `src/server/durable-d1.ts` is the
second implementation: `d1OverDurable(stub)` gives `prepare`/`bind`/`first`/`all`/`run`/`raw`, `batch` and `exec` over
four RPC methods on the object (`query`, `raw`, `exec`, `batch`: one RPC per statement, one per batch), and
`bindDatabase(env)` rebinds `env.DB` to it when no D1 is bound and the namespace is, at the four entry points (the
request middleware in `app.ts`, `runDue` for cron ticks, `consumeJobs` for the queue, `withApp` for Workflow steps), so
nothing else in the server knows. Results are shaped like D1's (`results`, `success`, `meta.changes`,
`meta.last_row_id`, `meta.rows_read`, `meta.rows_written`); errors carry SQLite's own message
(`UNIQUE constraint failed: table.column`), which is what the record and collection services match on. The system
tables come from the same `db/migrations/*.sql` Void applies to a D1, carried as `src/server/schema-sql.ts` (written by
`scripts/schema-sql.ts`, kept current by a unit test) and applied once by the object's constructor, recorded in
`_void_migrations`, so the first request after a deploy finds the schema as it would on D1.

**What goes away: D1's batch as an approximation of a transaction.** The object is a single writer over its own SQLite
file, so `batch` runs inside `ctx.storage.transactionSync`: all or nothing, rolled back on the first error.
`test/workers-durable.ts` runs it on workerd: two inserts in one batch, the second violating a unique index, leave no
row; the same two statements outside a batch leave the first. Hook code still has no interactive transaction (a
`transaction(steps)` RPC where a step reads an earlier result is the next step, not this one), and `POST /api/batch`
keeps its emulated rollback, which holds on the object too.

**What does not go away: the ceilings.** The roadmap entry expected D1's 100 bound parameters and 100 columns to stop
applying. They do not: workerd enforces the same limits on a Durable Object's SQLite storage (Cloudflare documents
both at 100 for SQLite-backed objects), and the test measures it rather than assuming: a table of 100 columns and a
statement binding 100 parameters pass, 101 of either fails with SQLite's `too many columns` and `too many SQL
variables` (workerd 1.20260903.1). A collection is still at most 97 user fields beside `id`, `created` and `updated`.
The 100 KB statement, the 2 MB row and the 10 GB per object apply as well (D1 allows 10 GB per database).

**What stays the same.** The REST API, the panel, hooks, `pb_migrations`, the backups (an archive is the same file
whichever side holds the data, which is what makes `voidbase migrate` the migration path), the realtime hub (its own
object), the queue, R2, the Bun runtime (`src/node/d1.ts`, untouched) and every deploy without the knob.

**Costs, roughly, from Cloudflare's published rates.** D1 bills rows read and written (about $0.001 per million reads
and $1 per million writes past the included amounts) plus storage. A Durable Object bills requests ($0.15 per million
past the first million), duration (GB-seconds while it is active) and its SQLite storage at the same per-row rates
as D1 plus $0.20 per GB-month. So a request that was N D1 round trips is now N RPCs to one object, each an object
request, and the object is active while it answers: cheaper for chatty requests placed near the object, not free.
Check the pricing page before promising numbers to anyone.

**Single writer, one location.** A Durable Object lives in one place (created near the first request that named it)
and serializes its work: that is what makes the transaction real, and what caps throughput at one object's, since
every write in the instance goes through it. Smart Placement stays on, so the Worker moves toward what it calls;
D1's read replicas (the Sessions API) do not apply. The per-isolate caches (settings, collections) live in the Worker,
not the object, and invalidate as before.

**Migration path.** Two steps, both existing commands: deploy the durable-backed Worker (under a new name, or the same
name with the knob flipped, which rebinds the Worker away from its D1 and leaves the D1 database on the account,
untouched), then `voidbase migrate <old-url> <new-url>` moves the data through the backups API. A same-name flip that
imports the D1 into the object on the first boot was not built: it would mean keeping D1 bound for one deploy and
copying every table inside a request, and the two-step path is the command the roadmap already promised.

## Beyond 500 apps per account: one Worker, one Durable Object per app

Kept here for when the account limit becomes the constraint rather than something to raise.

### A data plane of Durable Objects, a thin edge, queues behind

```
browser / SDK ──► edge Worker (router)  ──► TenantObject (SQLite-backed Durable Object, one per app)
                    │  hostname → tenant (KV)         │  SQLite: the PocketBase tables (10 GB per object)
                    │  SSE held here (cheap)          │  in-memory realtime hub, alarms for crons
                    │  hibernating WebSocket ◄────────┘  publishes changes to connected edge Workers
                    ▼
                  R2 (one bucket, tenant/ prefix)   Queues (mail, thumbs, webhooks, backups)   KV (tenant map, snapshots)
```

**Why a Durable Object per app.** SQLite-backed Durable Objects are unlimited in number, created on first use by
name (no provisioning step, no binding per tenant), hold up to 10 GB each, bill rows read at $0.001 per million,
rows written at $1 per million and storage at $0.20 per GB-month, and cost nothing while inactive. voidbase's
database access already goes through the D1 interface with a swappable implementation (`src/node/d1.ts` for
bun:sqlite); a `ctx.storage.sql` adapter is the same size. Two things get better than D1: transactions are real
(`transactionSync`), and the object is a single writer, so the settings and collections caches never need
invalidation.

**Why the edge holds the SSE connections.** Workers bill per request and CPU time, never wall-clock, so an
EventSource that stays open for an hour costs one request plus the CPU spent writing frames. A Durable Object
holding that same stream would bill duration (128 MB × seconds, $12.50 per million GB-s: about $4 per month per
permanently connected app). So the router Worker terminates SSE (the PocketBase SDK keeps using SSE unchanged),
and holds one hibernating WebSocket to the app's object. The object sleeps between writes and wakes only to fan
out; Cloudflare's own pricing example for this pattern is 100 objects × 100 connections at roughly $10 per month.
The D1 polling loop disappears, along with its one read per second per app.

**Why alarms instead of cron triggers.** A Durable Object alarm is scheduled by the object itself only when the app
has a job due (`cronAdd` from hooks, a backups cron, a scheduled cleanup). An app without connections, jobs or
writes has no alarm and no cost. PocketBase's built-in maintenance (OTP/MFA/log cleanup) becomes lazy: run on
the next request when overdue, which is what an idle app deserves.

**Queues** take everything that does not belong in the request: outbound mail (with retries and a dead letter),
thumbnail generation, hooks' HTTP and email actions, backup archives, audit rows. Batching keeps it at $0.40 per
million operations; idempotency keys (message id = record id + action) make at-least-once delivery safe.

**KV** caches only what tolerates 60 seconds of staleness and is read on every request at the edge: hostname to
tenant id, the public `auth-methods` answer, the collections snapshot used by the edge for static-asset decisions.
Reads are $0.50 per million; the object itself is the source of truth.

**R2** stays one bucket per platform with keys `tenant/collectionId/recordId/filename` (voidbase already keys
files by collection and record). Thumbnails are cached under the same prefix; protected files keep the token
flow; egress is free.

**Frontends** of tenant apps are static assets: serve them from R2 by hostname through the router, or, for
tenants with their own code, through their Workers for Platforms user Worker.

### Tenant hooks

`pb_hooks` are arbitrary JavaScript. Running many tenants' hooks inside one Worker is not acceptable isolation.
Three tiers, cheapest first:

1. **Data-only apps** (the majority): no custom hooks; the shared core serves them. Rules, auth, files, realtime,
   the `hooks` collection's declarative actions and everything the panel configures still work.
2. **Apps with hooks**: a Workers for Platforms user Worker per tenant, containing voidbase core plus that
   tenant's compiled `pb_hooks`, bound to the tenant's object through a service binding. Workers for Platforms
   allows unlimited user Workers in a dispatch namespace ($25 per month for the namespace, $0.30 per million
   requests beyond the included 20 million), and an idle user Worker costs nothing. This is exactly the bundle
   `voidbase deploy` builds today, uploaded through the dispatch API instead of `void deploy`.
3. **Apps with heavy custom code**: the tenant's own account with `voidbase deploy`, which already works.

### Cost sketch

Per tenant, idle: storage only. A 100 MB app is $0.02 per month of Durable Object storage and less of R2; the
account's first 5 GB are included. One thousand idle apps: the fixed $5 Workers Paid minimum (plus $25 if the
dispatch namespace is used) and cents of storage.

Per tenant, active (100,000 requests, 1 million rows read, 50,000 rows written, 20 users on realtime all day):
requests are inside the included 10 million; rows read $0.001; rows written $0.05; the realtime hub wakes for
each write (100,000 object requests, $0.015) and hibernates otherwise. Under a dime. The platform's bill is
proportional to activity, which is what lets the customer be charged that way too.

### Fit with Void, and the honest gaps

Void exposes Durable Objects only through `.ws.ts` rooms (key-value storage) and `void/live` (SSE fanout,
256 subscribers per topic), infers no dispatch namespace binding, and `void deploy --backend cloudflare` refuses
apps that declare Durable Object classes. So the data plane described here is deployed with wrangler (the
generated project already tolerates a custom `wrangler.jsonc`: add `durable_objects` bindings and a
`new_sqlite_classes` migration), while Void keeps doing what it does well: the control plane app, the dev loop,
queues, KV, crons, the managed deploy for single-tenant apps. `void/live` is usable as the realtime hub for
small apps, but PocketBase topics are per collection, so a busy app exceeds 256 subscribers on one topic; the
tenant object's own hub has no such limit. If Void adds custom SQLite-backed Durable Object classes and a
dispatch binding, the wrangler step goes away.

### The order to build it

Each step is independently useful and keeps every existing suite green.

1. **`src/platform/do/`**: a D1-interface adapter over `ctx.storage.sql` (batch = `transactionSync`, cursors
   consumed synchronously; done for the single-tenant case as `src/server/durable-db.ts` + `durable-d1.ts`, behind
   `VOIDBASE_DATABASE=durable`, see the section above), an R2 prefix view for `tenant/`, and a `TenantObject` class that runs the existing
   Hono app with those bindings. Verified by the same differential suites through a wrangler-deployed dev
   Worker (miniflare runs SQLite objects locally).
2. **Realtime hub in the object**: writes publish in-process; the router Worker terminates SSE and subscribes over
   a hibernating WebSocket. Remove the `_changes` polling on this path; keep it for single-tenant D1 deploys.
3. **Alarms for crons** and lazy built-ins; delete the per-Worker cron trigger on the platform path.
4. **Queues** for mail, thumbnails and hooks actions (`queues/` files in the Void control plane, the object
   produces). Idempotency keys first.
5. **Router Worker + KV tenant map**, static assets from R2 by hostname, per-tenant metering with Analytics
   Engine (requests, rows, bytes) so customers can be billed for activity.
6. **Control plane** (`voidbase cloud`): create/delete apps, domains, tokens; a tenant is a name, nothing is
   provisioned until the first request.
7. **Workers for Platforms** for tenants with hooks: the existing deploy bundle uploaded to the dispatch
   namespace with a service binding to the tenant object.

Things to keep in view: a Durable Object lives in one location (place it with `locationHint` near the app's
owner; the edge already serves assets and SSE close to users), the 10 GB cap per object (shard or move very large
tenants to D1), WebSocket hibernation drops in-memory state (subscriptions are re-sent on wake), and Queues are
at-least-once.
