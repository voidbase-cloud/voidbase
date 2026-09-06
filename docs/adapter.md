# Running a Void app on voidbase

A [Void](https://void.cloud) app and a voidbase app are shaped differently. Void puts server code in `routes/`,
`middleware/`, `crons/` and `queues/` and builds a Cloudflare Worker; voidbase is a PocketBase project, with the
site in `pb_public/`, JS hooks in `pb_hooks/` and migrations in `pb_migrations/`. The adapter keeps the project a
plain Void app and *generates* the voidbase one from it, whole, into a git-ignored `.voidbase/`.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidbaseAdapter } from "@voidbase-cloud/voidbase/adapter/plugin";

export default defineConfig({ plugins: [voidPlugin(), voidbaseAdapter()] });
```

`vite build` then writes [PocketBase's minimal layout](https://pocketbase.io/docs/going-to-production/#minimal-setup):

```
.voidbase/            generated; add it to .gitignore
  main.ts             voidbase composed with the project's server code
  package.json
  .gitignore          pb_data/
  pb_hooks/           copied from the project's vb_hooks/
  pb_migrations/      the project's vb_migrations/, plus one file per Drizzle migration
  pb_public/          the client build, served at /
  pb_data/            created on first run
  void-app.ts         the glue: imports routes/, middleware/, crons/, queues/
  tsconfig.json       the fragment the project's tsconfig extends
  shim-db.ts          void/db and void/queues at runtime (see below)
  shim-queues.ts
```

`voidbase adapt` does the same pass without Vite, which is what CI and a pure-API project need.

```bash
bun run build                              # or: bunx voidbase adapt
bun .voidbase/main.ts --http 127.0.0.1:8090   # the site, /api, and the panel at /_/
cd .voidbase && bunx voidbase deploy          # one Cloudflare Worker with all three
```

## What the project owns

The project root is Void's, with two additions that are the voidbase counterpart of Void's own `db/`: source
directories the adapter compiles into the generated app. All three are optional.

| path | what it does |
| --- | --- |
| `vb_migrations/` | PocketBase JS migrations, copied into the generated `pb_migrations/` beside the ones generated from `db/migrations` |
| `vb_hooks/` | PocketBase JS hooks, copied into the generated `pb_hooks/` as they are |
| `src/voidbase/register.ts` | `export function register(app)`: extensions in TypeScript (anything that needs npm), composed into the generated `main.ts` |

The naming is deliberate: `vb_*` at the root is *source*, the way `db/migrations` is source; `pb_*` inside
`.voidbase/` is what gets generated from it, the way `dist/` is.

### Why routes and middleware are not compiled into pb_hooks

`routes/` and `middleware/` become registrations on the same router that `pb_hooks` feed, but through the generated
`void-app.ts` that `main.ts` imports, not as files under `pb_hooks/`. That is a limit of PocketBase's hook model,
not a shortcut:

- A hook file runs in a sandbox with PocketBase's globals, `module`/`exports`, and a `require` that resolves only
  its sibling files in `pb_hooks`. It cannot import from npm.
- A Void route can. `defineHandler`, `void/db`, `void/storage` and `void/env` are npm modules, and `void/_env` — the
  binding context every one of them reads — imports `AsyncLocalStorage` from `node:async_hooks` at module scope.
- Bundling them into a hook file does not get around it. voidbase embeds each hook's source as a function body, so
  a `require("node:async_hooks")` inside it is a call to the sandbox's `require` at runtime, with nothing to
  resolve; and every hook file goes through the await-insertion transform, which rewrites calls by method name
  (`delete`, `next`, `send`) and would corrupt bundled code.

So the split follows what each side can express: hand-written PocketBase hooks in `vb_hooks/`, and Void's own
routing through the generated module. Both end up in the same registry, and both serve on the same paths.

## What maps to what

| Void | voidbase | notes |
| --- | --- | --- |
| `index.html`, `public/`, the client build | `.voidbase/pb_public/` | served at `/`; `404.html` is copied from `index.html` so a deep link behaves the same on Bun and on the asset layer |
| `routes/**/*.ts` | Hono routes on the running app | `[id]` → `:id`, `[...rest]` → catch-all, `(group)/` stripped, `_file.ts` ignored, `.dev.ts` / `.prod.ts` honoured |
| `middleware/*.ts` | the same chain, in file order | scoped to the app's own routes (see below) |
| `crons/*.ts` | `cronAdd(<file name>, cron, handler)` | listed by `GET /api/crons`, runnable with `POST /api/crons/<name>` |
| `queues/*.ts` | a voidbase job per message | `void/queues` and `c.env.QUEUE_<NAME>` produce; the consumer runs on the jobs queue, or inline where there is none |
| `db/schema.ts` + `void/db` | Drizzle over voidbase's D1 | the same database PocketBase's collections live in |
| `db/migrations/*.sql` | `.voidbase/pb_migrations/<name>.void.js` | applied and recorded like any other migration, on both runtimes |

Point the project's `tsconfig.json` at the adapter's fragment so the editor and Bun agree:

```jsonc
{ "extends": "./.voidbase/tsconfig.json" }   // instead of "./.void/tsconfig.json"
```

Void's own fragment maps `void/db` and `void/queues` to declaration files. That is right for `tsc` and wrong for
Bun, which honours `paths` at runtime and would resolve those imports to a `.d.ts` that exports nothing. The
adapter's fragment repoints those two at shims that take the values from Void's published runtime and the types
from Void's declarations, and passes every other mapping (`@schema`, `void/routes`) through unchanged.

## Two shapes of app

The adapter looks at what the project actually has:

- **Static.** No `routes/`, `middleware/`, `crons/`, `queues/`, `vb_hooks/` or `src/voidbase/register.ts`. The generated app is
  `main.ts` plus `pb_public`, and `main.ts` registers nothing.
- **Server.** Anything else. `void-app.ts` is generated and `main.ts` registers it along with
  `src/voidbase/register.ts`. `voidbase deploy`, run from `.voidbase/`, composes that `main.ts` into the Worker, so
  the same code serves on Cloudflare.

Pages are prerendered when `void.json` sets `"output": "static"`; they land in `pb_public` as plain HTML and need no
runtime. Pages that still render per request have nowhere to run here, and the build says so.

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
| `pages/` that render per request | prerender them with `"output": "static"` and they land in `pb_public`; there is no page renderer at runtime |
| `routes/**/*.ws.ts` | document WebSockets are Durable Objects, and voidbase's realtime hub owns that binding |
| `void/kv` | voidbase binds D1 and R2 only; a collection is the place for that data |
| `void/isr` | ISR runs in the Void platform's dispatch worker, which a self-hosted app does not have |

**Build with Bun.** voidbase ships TypeScript sources, and Vite loads its config through the runtime, so use
`bunx --bun vite build` (or `bun run build` with Bun as the package manager). `voidbase adapt` has no such
constraint.

**Nothing is written outside `.voidbase/`.** Delete the directory and the next build makes it again, so it belongs
in `.gitignore` and never in review.

## Testing it

`test/adapter.ts` converts `test/fixtures/void-app`, boots it with the generated `main.ts` and exercises the whole
surface: the generated layout, route paths and parameters, literal-beats-parameter ordering, middleware order,
`void/db` through the shim, `void/storage`, a queue round trip, a cron run, both kinds of migration, the project's
own `register()` and pb_hooks, and that nothing is written outside `.voidbase/`. Run it with
`bun test/adapter.ts`, or as part of `bash scripts/ci.sh` (step `adapter`).
