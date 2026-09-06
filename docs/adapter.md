# Running a Void app on voidbase

A [Void](https://void.cloud) app and a voidbase app are shaped differently: Void puts server code in `routes/`,
`middleware/`, `crons/` and `queues/` and builds a Cloudflare Worker; voidbase is a PocketBase project, with the
site in `pb_public/`, JS hooks in `pb_hooks/` and migrations in `pb_migrations/`. The adapter builds the first into
the second, so the app keeps Void's file conventions and gains PocketBase's API, admin panel and collections.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidbaseAdapter } from "@voidbase-cloud/voidbase/adapter/plugin";

export default defineConfig({ plugins: [voidPlugin(), voidbaseAdapter()] });
```

`vite build` then produces a voidbase app in place. `voidbase adapt` does the same pass without Vite, which is what
CI and `voidbase serve` need when there is no client to build.

```bash
bun run build            # or: bunx voidbase adapt
bunx voidbase serve --entry main.ts    # http://127.0.0.1:8090: the site, /api, and the panel at /_/
bunx voidbase deploy                   # one Cloudflare Worker with all three
```

## What maps to what

| Void | voidbase | notes |
| --- | --- | --- |
| `index.html`, `public/`, the client build | `pb_public/` | served at `/`; `404.html` is copied from `index.html` so a deep link behaves the same on Bun and on the asset layer |
| `routes/**/*.ts` | Hono routes on the running app | `[id]` → `:id`, `[...rest]` → catch-all, `(group)/` stripped, `_file.ts` ignored, `.dev.ts` / `.prod.ts` honoured |
| `middleware/*.ts` | the same chain, in file order | scoped to the app's own routes (see below) |
| `crons/*.ts` | `cronAdd(<file name>, cron, handler)` | listed by `GET /api/crons`, runnable with `POST /api/crons/<name>` |
| `queues/*.ts` | a voidbase job per message | `void/queues` and `c.env.QUEUE_<NAME>` produce; the consumer runs on the jobs queue, or inline where there is none |
| `db/schema.ts` + `void/db` | Drizzle over voidbase's D1 | the same database PocketBase's collections live in |
| `db/migrations/*.sql` | `pb_migrations/<name>.void.js` | applied and recorded like any other migration, on both runtimes |

Generated files live in `.voidbase/` (git-ignore it, like `.void/`). `main.ts` is written once, on the first run,
and never touched again: it is where your own hooks go.

```
.voidbase/void-app.ts     the glue: imports your modules, mounts them
.voidbase/tsconfig.json   Void's tsconfig fragment, with two mappings repointed (see below)
.voidbase/shim-db.ts      void/db at runtime, with Void's schema-aware types
.voidbase/shim-queues.ts  void/queues at runtime
.voidbase/manifest.json   what the last build found
main.ts                   your composition entry, generated once
```

Point the app's `tsconfig.json` at the adapter's fragment so the editor and Bun agree:

```jsonc
{ "extends": "./.voidbase/tsconfig.json" }   // instead of "./.void/tsconfig.json"
```

Void's own fragment maps `void/db` and `void/queues` to declaration files. That is right for `tsc` and wrong for
Bun, which honours `paths` at runtime and would resolve those imports to a `.d.ts` that exports nothing. The
adapter's fragment repoints those two at shims that take the values from Void's published runtime and the types
from Void's declarations, and passes every other mapping (`@schema`, `void/routes`) through unchanged.

## Two shapes of app

The adapter looks at what the app actually has:

- **Static.** No `routes/`, `middleware/`, `crons/` or `queues/`. The build is copied to `pb_public/` and nothing
  else is generated: run it with plain `voidbase serve`, which picks `./pb_public` up on its own.
- **Server.** Anything else. `.voidbase/void-app.ts` and `main.ts` are written too, and the app runs with
  `voidbase serve --entry main.ts`. `voidbase deploy` composes `main.ts` into the Worker, so the same code serves
  on Cloudflare.

## How the server code runs

Void's `defineHandler` returns a plain Hono handler, and voidbase's app is Hono, so handlers run unchanged. Two
details make that true rather than nearly true:

- Routes register through `routerAdd`, the registry PocketBase's JS hooks use. voidbase mounts a catch-all
  dispatcher for it, so anything added to the Hono app after boot would sit behind that catch-all and never match.
  The dispatcher hands the handler the real Hono context, and the adapter overlays the route's own parameters on
  `c.req.param()`.
- Every handler, cron and queue consumer runs inside `withRuntimeEnv`, Void's binding context. That is why
  `void/db`, `void/storage`, `void/env` and `void/queues` resolve against voidbase's D1 and R2 with no shim of
  their own, and why `c.env` carries the app's queue producers.

Return values convert exactly as Void converts them (object → JSON, string → HTML, `null` → 204, `Response` as-is),
because the adapter calls Void's own `convertReturnValue`.

## Things to know

**voidbase's API wins.** `/api/collections`, `/api/files`, `/api/realtime`, `/api/settings`, `/api/logs`,
`/api/backups`, `/api/crons`, `/api/batch`, `/api/health` and `/_/` are PocketBase's. An app route on one of those
paths never runs; the build warns and names it. Everything else under `/api` is yours.

**Middleware is scoped to the app's routes.** In a Void app `middleware/` runs on every request. Here it would
otherwise also wrap PocketBase's own endpoints and the admin panel, which is not what anyone means by it, so it
runs around the app's routes only.

**Queues are one queue.** Cloudflare Queues are provisioned per instance, so every app queue rides voidbase's own
jobs queue as a `{ type: "queue", queue, body }` message and is fanned back out to the right consumer. Without a
queue binding (the Bun runtime, or a deploy whose token could not create one) `send` runs the consumer inline. A
consumer that throws, or calls `retry()`, is retried by voidbase's job runner.

**Not carried over.** The build warns and keeps going:

| what | why |
| --- | --- |
| `pages/` | server-rendered pages need Void's render pipeline; prerender them and they land in `pb_public` |
| `routes/**/*.ws.ts` | document WebSockets are Durable Objects, and voidbase's realtime hub owns that binding |
| `void/kv` | voidbase binds D1 and R2 only; a collection is the place for that data |
| `void/isr` | ISR runs in the Void platform's dispatch worker, which a self-hosted app does not have |

**Build with Bun.** voidbase ships TypeScript sources, and Vite loads its config through the runtime, so use
`bunx --bun vite build` (or `bun run build` with Bun as the package manager). `voidbase adapt` has no such
constraint.

## Testing it

`test/adapter.ts` converts `test/fixtures/void-app`, boots it with the generated `main.ts` and exercises the whole
surface: route paths and parameters, literal-beats-parameter ordering, middleware order, `void/db` through the
shim, `void/storage`, a queue round trip, a cron run, the Drizzle migration and the static build. Run it with
`bun test/adapter.ts`, or as part of `bash scripts/ci.sh` (step `adapter`).
