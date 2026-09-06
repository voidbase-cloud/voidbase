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
  pb_hooks/           routes/, middleware/, crons/ and queues/, compiled
  pb_migrations/      the project's vb_migrations/, plus one file per Drizzle migration
  pb_public/          the client build, served at /
  pb_data/            created on first run
  void-entry.ts       what the bundler builds into pb_hooks/void-app.js
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

The project root is Void's, with one addition that is the voidbase counterpart of Void's `db/`, plus one place for
extensions that need npm. Both are optional.

| path | what it does |
| --- | --- |
| `vb_migrations/` | PocketBase JS migrations, copied into the generated `pb_migrations/` beside the ones generated from `db/migrations` |
| `src/voidbase/register.ts` | `export function register(app)`: PocketBase event hooks and anything else in TypeScript, composed into the generated `main.ts` |

There is no hooks directory to write by hand: `routes/`, `middleware/`, `crons/` and `queues/` **are** the hooks.
The adapter compiles them into `.voidbase/pb_hooks/`, so the generated app carries its whole route surface where a
PocketBase app carries it.

### How Void code becomes a hook

A pb_hooks file runs in a sandbox with PocketBase's globals and a `require` that reaches only its sibling hook
files. A Void route imports from npm. Three things close that gap:

1. **One bundle.** `routes/`, `middleware/`, `crons/` and `queues/` are built into a single CommonJS file,
   `pb_hooks/void-app.js`, with everything they import (Void's runtime, Drizzle, the app's own modules) inlined.
   The `void` specifier is rewritten to `void/handler` so the Vite plugin does not come with it, and the tsconfig
   aliases Void generates (`@schema`, and the `void/db` / `void/queues` shims) are applied by the bundler.
2. **No node builtins.** `node:async_hooks`, which Void's binding context needs, is rewritten to read
   `globalThis.AsyncLocalStorage`; voidbase's hook runtime publishes it there on both runtimes. Any other builtin
   fails the build with the name of the file that imported it.
3. **No rewriting of the bundle.** Every hook file normally goes through an await-insertion pass that rewrites
   calls by method name (`delete`, `next`, `send`), which would corrupt bundled code. The generated file opens with
   `// voidbase:raw`, and the compiler leaves it alone.

`pb_hooks/void-app.pb.js` is the small hook beside it: the one place the hook globals are in scope. It requires the
bundle and hands it `routerAdd`, `cronAdd`, `$env` (the bindings of the request or cron tick running now) and
`$jobs` (voidbase's background queue).

`main.ts` is left with the project's own `register()`, if it has one.

### Writing API logic

`defineHandler` and `defineMiddleware` are how a voidbase app writes its API. A route that only needs Void's own
runtime (`void/db`, `void/storage`) needs nothing else; one that reads or writes PocketBase collections imports
PocketBase's API from the adapter, because a bundled route cannot import voidbase directly:

```ts
// routes/api/posts/[id].ts  ->  GET /api/posts/:id
import { defineHandler } from "void";
import { authOf, pb, requireAuth } from "@voidbase-cloud/voidbase/adapter";

export const GET = defineHandler(requireAuth("users"), async (c) => {
  const post = await pb.$app.findRecordById("posts", c.req.param("id"));
  if (!post) throw new pb.NotFoundError("No such post.");
  if (post.getString("owner") !== authOf(c)?.id) throw new pb.ForbiddenError();
  return { post: post.publicExport() };
});
```

| import | what it is |
| --- | --- |
| `pb.$app` | the data API: `findRecordById`, `findRecordsByFilter`, `save`, `delete`, `settings`, ... |
| `pb.Record`, `pb.$apis`, `pb.$os` | the rest of the hook surface a route is likely to want |
| `pb.BadRequestError` and friends | PocketBase's error classes, so a thrown error becomes the right HTTP response |
| `authOf(c)` | the authenticated record, exactly as a hook's `e.auth` |
| `requireAuth(...)`, `requireSuperuser()` | the Void-shaped counterparts of `$apis.requireAuth` and `requireSuperuserAuth` |

PocketBase's *event* hooks (`onBootstrap`, `onRecordCreate`, the mailer hooks) have no `routes/` equivalent. They
go in `src/voidbase/register.ts`, which `main.ts` imports normally and which can import anything.


## What maps to what

| Void | voidbase | notes |
| --- | --- | --- |
| `index.html`, `public/`, the client build | `.voidbase/pb_public/` | served at `/`; `404.html` is copied from `index.html` so a deep link behaves the same on Bun and on the asset layer |
| `routes/**/*.ts` | `.voidbase/pb_hooks/void-app.js` | `[id]` → `:id`, `[...rest]` → catch-all, `(group)/` stripped, `_file.ts` ignored, `.dev.ts` / `.prod.ts` honoured |
| `middleware/*.ts` | the same bundle, chained in file order | scoped to the app's own routes (see below) |
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

- **Static.** No `routes/`, `middleware/`, `crons/`, `queues/` or `src/voidbase/register.ts`. The generated app is
  `main.ts` plus `pb_public`, and `main.ts` registers nothing.
- **Server.** Anything else. The bundle and its hook go into `pb_hooks/`, and `main.ts` registers
  `src/voidbase/register.ts`. `voidbase deploy`, run from `.voidbase/`, composes that `main.ts` into the Worker, so
  the same code serves on Cloudflare.

Pages are prerendered when `void.json` sets `"output": "static"`; they land in `pb_public` as plain HTML and need no
runtime. Pages that still render per request have nowhere to run here, and the build says so.

## How the server code runs

Void's `defineHandler` returns a plain Hono handler, and voidbase's app is Hono, so handlers run unchanged. Two
details make that true rather than nearly true:

- Routes register through `routerAdd`, the registry every pb_hooks route uses. The RequestEvent it hands the
  handler carries `.c`, the real Hono context, and the adapter overlays the route's own parameters on
  `c.req.param()`, since the hook router matched a pattern rather than Hono's own.
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
