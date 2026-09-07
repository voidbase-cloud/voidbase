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
  pb_hooks/           routes/, middleware/, vb_hooks/, crons/ and queues/, compiled
  pb_migrations/      the project's vb_migrations/, plus one file per Drizzle migration
  pb_secrets/         the project's vb_secrets/: the declaration in PocketBase's shape, the values beside it
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

The project root is Void's, with three additions, all optional and all named for the voidbase thing they are:

| path | what it does |
| --- | --- |
| `vb_hooks/` | PocketBase's hooks, one per file, registered once when the app mounts |
| `vb_migrations/` | PocketBase JS migrations, copied into the generated `pb_migrations/` beside the ones generated from `db/migrations` |
| `vb_secrets/` | `main.ts` declares the app's secrets with `defineSecrets`; `secrets.json` (git-ignored) holds their values |

They sit at the project root beside Void's own `db/`, which `vb_migrations/` is the counterpart of. Everything else
is Void's, and means what Void means by it: `routes/`, `middleware/`, `crons/` and `queues/` are the server code,
`src/` is library code they import, `pages/` and `public/` are the site.

There is no hooks directory to write by hand: `routes/`, `middleware/`, `crons/` and `queues/` **are** the hooks.
The adapter compiles them into `.voidbase/pb_hooks/`, so the generated app carries its whole route surface where a
PocketBase app carries it.

### How Void code becomes a hook

A pb_hooks file runs in a sandbox with PocketBase's globals and a `require` that reaches only its sibling hook
files. A Void route imports from npm. Three things close that gap:

1. **One bundle.** `routes/`, `middleware/`, `vb_hooks/`, `crons/` and `queues/` are built into a single CommonJS file,
   `pb_hooks/void-app.js`, with everything they import (Void's runtime, Drizzle, the app's own modules) inlined.
   The `void` specifier is rewritten to `void/handler` so the Vite plugin does not come with it, and the tsconfig
   aliases (`@schema`, the project's own `@/*`, and the `void/db` / `void/queues` shims) are applied by the
   bundler, an alias pointing at a directory resolving to its index file.
2. **No node builtins.** `node:async_hooks`, which Void's binding context needs, is rewritten to read
   `globalThis.AsyncLocalStorage`; voidbase's hook runtime publishes it there on both runtimes. Any other builtin
   fails the build with the name of the file that imported it.
3. **No rewriting of the bundle.** Every hook file normally goes through an await-insertion pass that rewrites
   calls by method name (`delete`, `next`, `send`), which would corrupt bundled code. The generated file opens with
   `// voidbase:raw`, and the compiler leaves it alone.

`pb_hooks/void-app.pb.js` is the small hook beside it: the one place the hook globals are in scope. It publishes
them on `globalThis` and then requires the bundle, in that order, so `pb` already works while a module is being
imported. `main.ts` is left with nothing but the runner.

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

### Hooks

PocketBase's *event* hooks (`onBootstrap`, `onRecordCreate`, the mailer hooks) fire on a record or a lifecycle
moment rather than on a URL, so they have no `routes/` equivalent. They go in `vb_hooks/`: one file, one hook,
registered once when the app mounts, in file-name order.

A file names its hook where the build can read it, without running anything:

```ts
// vb_hooks/10.audit.ts  ->  onRecordAfterCreateSuccess, limited to `posts`
import { defineHook } from "@voidbase-cloud/voidbase/adapter";

export default defineHook("onRecordAfterCreateSuccess", async (e) => {
  await e.next();
  console.log("created", e.record?.id);
}, "posts");
```

The trailing arguments are PocketBase's tags, the collections the hook is limited to. `routerUse`, PocketBase's
global request middleware, is a hook like any other and can be written here too, but Void already has a directory
for that, and it means the same thing:

```ts
// middleware/20.trace.ts  ->  every request
import { defineMiddleware } from "void";

export default defineMiddleware(async (c, next) => {
  await next();
  c.res.headers.set("x-trace-id", crypto.randomUUID());
});
```

Two build errors keep the two apart. **A `vb_hooks/` file attached to no hook fails**, by name: there is nowhere to
register it, and silently dropping it would be worse. So does a name that is not one of PocketBase's hooks, and the
error offers the nearest real ones. **A `defineHook` left in `middleware/` fails too**, and says to move it: Void's
middleware is called with `(c, next)`, which is not what a hook handler expects.

`pb` is also usable while a module is being imported, which is what lets a plain module under `src/` register
something of its own. Void's build imports the same modules again to prerender the pages, with no PocketBase in the
process, so a registration made then is held and replayed, or dropped with the process. Reading anything
(`pb.$app` and the rest) outside a request, a cron tick or a hook still throws.


### Secrets

The secrets the app needs are named in `vb_secrets/main.ts`, where the build can read them without running anything,
and valued in `vb_secrets/secrets.json`, which stays out of git (add it to `.gitignore`; the generated app's own
`.gitignore` already lists its copy):

```ts
// vb_secrets/main.ts
import { defineSecrets } from "@voidbase-cloud/voidbase/adapter";

export default defineSecrets({
  SMTP_PASSWORD: "the mail provider's SMTP password",
  CF_OAUTH_CLIENT_SECRET: "the OAuth app's client secret",
});
```

The adapter writes them into `.voidbase/pb_secrets/` in PocketBase's shape (`main.pb.js` with `secrets({...})`,
`secrets.json` copied beside it), which is what `voidbase serve` and `voidbase deploy` read: locally the values
enter the process environment, on Cloudflare they become the Worker's secrets (a deploy stores what the Worker
lacks, `voidbase secrets push` replaces), and a deploy refuses to go ahead while a declared secret has no value
anywhere. The app reads them like any other binding: `c.env.SMTP_PASSWORD` in
a route, `pb.$os.getenv("SMTP_PASSWORD")` in a hook. A value in `secrets.json` that `main.ts` does not declare
fails the build, by name: it would silently never reach the Worker. Details and the `voidbase secrets` commands:
`docs/deploy.md`.

## What maps to what

| Void | voidbase | notes |
| --- | --- | --- |
| `index.html`, `public/`, the client build | `.voidbase/pb_public/` | served at `/`; `404.html` is copied from `index.html` so a deep link behaves the same on Bun and on the asset layer |
| `routes/**/*.ts` | `.voidbase/pb_hooks/void-app.js` | `[id]` → `:id`, `[...rest]` → catch-all, `(group)/` stripped, `_file.ts` ignored, `.dev.ts` / `.prod.ts` honoured |
| `middleware/*.ts` | `routerUse(...)`, in file order | every request, as in Void (see below) |
| `vb_hooks/*.ts` | the hook each file names, registered once | `onBootstrap`, `onRecordCreate`, the mailer hooks |
| `vb_secrets/main.ts` + `secrets.json` | `.voidbase/pb_secrets/main.pb.js` + `secrets.json` | `voidbase deploy` stores the values as the Worker's secrets; `bun .voidbase/main.ts` loads them (see below) |
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

- **Static.** No `routes/`, `middleware/`, `vb_hooks/`, `crons/` or `queues/` (`vb_secrets/` alone changes nothing). The generated app is `main.ts`
  plus `pb_public`.
- **Server.** Anything else. The bundle and its hook go into `pb_hooks/`. `voidbase deploy`, run from `.voidbase/`,
  ships that directory whole, so the same code serves on Cloudflare.

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
`/api/backups`, `/api/crons`, `/api/batch`, `/api/health`, `/api/webauthn` (voidbase's passkey endpoints) and `/_/`
are voidbase's own. An app route on one of those paths never runs; the build warns and names it. Everything else
under `/api` is yours.

**Middleware runs on every request.** `middleware/` registers through `routerUse`, PocketBase's own global
middleware, so it means what Void means by it: every request, in file order, before whatever answers. That includes
PocketBase's endpoints and the admin panel, so a middleware that throws takes the whole backend with it. Guard on
the path when a middleware is only meant for the app's own routes.

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
surface: the generated layout, route paths and parameters, literal-beats-parameter ordering, middleware order and
its reach over PocketBase's own endpoints, `void/db` through the shim, `void/storage`, a queue round trip, a cron
run, both kinds of migration, an `onBootstrap` hook running exactly once, a tagged event hook, a tsconfig alias
resolving to a directory's index file, the four build errors (a hook attached to nothing, a misspelt hook name, a
hook left in `middleware/`, a secret value nothing declares), `vb_secrets/` reaching the app through `$os.getenv`,
and that nothing is written outside `.voidbase/`. Run it with
`bun test/adapter.ts`, or as part of `bash scripts/ci.sh` (step `adapter`).
