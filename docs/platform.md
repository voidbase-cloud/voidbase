# Scaling voidbase on Cloudflare: from one app to millions

How voidbase should use Cloudflare's primitives when the goal is a hosted platform where one customer creates
thousands of voidbase apps and pays only for the ones that see traffic. Numbers come from Cloudflare's pricing
and limits pages (Workers Paid plan, 2026); the Void guides for live, WebSockets, queues, KV and SSE frame what
Void exposes today.

## Where the current design stops scaling

Today one voidbase app is one Worker, one D1 database and one R2 bucket, deployed with `voidbase deploy`. That is
right for "my backend on my account" and wrong for "thousands of apps":

| Piece | Today | Why it does not reach thousands of apps |
| --- | --- | --- |
| Compute | one Worker per app | 500 Workers per account; a deploy per app; hooks are baked per Worker (good isolation, expensive fleet) |
| Database | one D1 per app | fine for data (D1 allows 50,000 databases, raisable to millions) but each needs an API call to create and a static binding to reach |
| Realtime | SSE polls the `_changes` table about once a second per isolate | one D1 read per second per app while anyone is connected; latency bounded by the poll |
| Crons | a cron trigger per Worker, every minute | runs for idle apps too; 5 triggers per Worker; Workers for Platforms user Workers cannot have triggers at all |
| Files | one R2 bucket per app | works, but a bucket per app is provisioning noise; keys are already `collection/record/file` |
| Config | worker vars and secrets | per-Worker, not per-tenant |

Idle cost is already near zero (a Worker costs nothing when idle, D1 bills rows and storage, R2 bills storage), so
the problem is not the bill for idle apps; it is provisioning, fleet size, isolation and the always-on pieces
(polling realtime, every-minute crons).

## Target shape: a data plane of Durable Objects, a thin edge, queues behind

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

## What about tenant hooks

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

## Cost sketch

Per tenant, idle: storage only. A 100 MB app is $0.02 per month of Durable Object storage and less of R2; the
account's first 5 GB are included. One thousand idle apps: the fixed $5 Workers Paid minimum (plus $25 if the
dispatch namespace is used) and cents of storage.

Per tenant, active (100,000 requests, 1 million rows read, 50,000 rows written, 20 users on realtime all day):
requests are inside the included 10 million; rows read $0.001; rows written $0.05; the realtime hub wakes for
each write (100,000 object requests, $0.015) and hibernates otherwise. Under a dime. The platform's bill is
proportional to activity, which is what lets the customer be charged that way too.

## Fit with Void, and the honest gaps

Void exposes Durable Objects only through `.ws.ts` rooms (key-value storage) and `void/live` (SSE fanout,
256 subscribers per topic), infers no dispatch namespace binding, and `void deploy --backend cloudflare` refuses
apps that declare Durable Object classes. So the data plane described here is deployed with wrangler (the
generated project already tolerates a custom `wrangler.jsonc`: add `durable_objects` bindings and a
`new_sqlite_classes` migration), while Void keeps doing what it does well: the control plane app, the dev loop,
queues, KV, crons, the managed deploy for single-tenant apps. `void/live` is usable as the realtime hub for
small apps, but PocketBase topics are per collection, so a busy app exceeds 256 subscribers on one topic; the
tenant object's own hub has no such limit. If Void adds custom SQLite-backed Durable Object classes and a
dispatch binding, the wrangler step goes away.

## The order to build it

Each step is independently useful and keeps every existing suite green.

1. **`src/platform/do/`**: a D1-interface adapter over `ctx.storage.sql` (batch = `transactionSync`, cursors
   consumed synchronously), an R2 prefix view for `tenant/`, and a `TenantObject` class that runs the existing
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
