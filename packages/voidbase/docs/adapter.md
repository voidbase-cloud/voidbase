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
  pb_secrets/         the project's vb_secrets/: the declaration re-exported, the local values beside it
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
| `vb_secrets/` | `main.ts` declares the app's configuration with `defineSecrets` and Void's validators, every key wrapped in its audience (`secret`, `server`, `browser`, `local`); `secrets.json` (git-ignored) holds the local values |

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
| `sessionOf(request)` | the same question asked of a cookie rather than a header, for a page's loader: "One session across the pages and the API" below |
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


### Configuration and secrets

The app's configuration is declared in `vb_secrets/main.ts`, with the validators a Void `env.ts` uses, every key
wrapped in the audience that may read it (a key without one fails the build), and valued in
`vb_secrets/secrets.json`, which stays out of git (add it to `.gitignore`; the generated app's own `.gitignore`
already lists its copy):

```ts
// vb_secrets/main.ts
import { defineSecrets, secret, server, browser, local, string, number, url } from "@voidbase-cloud/voidbase/secrets";

export default defineSecrets({
  SMTP_PASSWORD: secret(string(), "the mail provider's SMTP password"),   // the Worker's secrets
  MAX_INSTANCES: server(number().default(5)),                              // a Worker var
  PUBLIC_API_URL: browser(url().optional()),                               // a var the browser gets too
  VOIDBASE_DEPLOY_CF_API_KEY: local(string(), "the deploy token"),        // the tooling's, never deployed
});
```

One declaration serves the three places the app runs. The Worker: `voidbase deploy` stores secrets as the Worker's
secrets and the rest as its vars, and refuses to deploy while a value is invalid or missing everywhere. The build:
every `public` key is inlined into the client as `import.meta.env.KEY`, parsed and defaulted, and no other key can
reach it. The static site therefore knows exactly what it was declared to know. Locally, `bun .voidbase/main.ts`
parses `secrets.json` and the shell into the environment, defaults included. Routes and hooks read
`c.env.SMTP_PASSWORD` or `pb.$os.getenv("SMTP_PASSWORD")`, or the typed values through the same declaration:

```ts
import config from "../../vb_secrets/main";
const { MAX_INSTANCES } = await config.read((n) => pb.$os.getenv(n));   // a number, on both runtimes
```

The adapter writes a re-export into `.voidbase/pb_secrets/main.ts`, where `voidbase serve` and `voidbase deploy`
look for the declaration, and copies `secrets.json` beside it. A value in `secrets.json` that `main.ts` does not
declare fails the build, by name: it would silently never reach the Worker. Details, the tiers and the `voidbase
secrets` commands: `docs/deploy.md`.

## What maps to what

| Void | voidbase | notes |
| --- | --- | --- |
| `index.html`, `public/`, the client build | `.voidbase/pb_public/` | served at `/`; `404.html` is copied from `index.html` so a deep link behaves the same on Bun and on the asset layer |
| `routes/**/*.ts` | `.voidbase/pb_hooks/void-app.js` | `[id]` → `:id`, `[...rest]` → catch-all, `(group)/` stripped, `_file.ts` ignored, `.dev.ts` / `.prod.ts` honoured |
| `middleware/*.ts` | `routerUse(...)`, in file order | every request, as in Void (see below) |
| `vb_hooks/*.ts` | the hook each file names, registered once | `onBootstrap`, `onRecordCreate`, the mailer hooks |
| `vb_secrets/main.ts` + `secrets.json` | `.voidbase/pb_secrets/main.ts` (a re-export) + `secrets.json` | secrets to the Worker's secrets, the rest to its vars, `public` keys into the client build (see below) |
| `crons/*.ts` | `cronAdd(<file name>, cron, handler)`; the literal `cron` export also becomes a cron trigger of the Worker at deploy | listed by `GET /api/crons`, runnable with `POST /api/crons/<name>` |
| `queues/*.ts` | a voidbase job per message | `void/queues` and `c.env.QUEUE_<NAME>` produce; the consumer runs on the jobs queue, or inline where there is none |
| `workflows/*.ts` | one ES module each under `.voidbase/workflows/`, its default export a class extending `WorkflowEntrypoint`; the deploy exports it from the Worker and binds it as `WORKFLOW_<NAME>` | `env.WORKFLOW_<NAME>.create({ id, params })` starts a durable, multi-step run; a step opens the app with `withApp(env, fn)` from `@voidbase-cloud/voidbase/workflows` |
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

## An installable app

The `pwa` option writes into `pb_public` what an installable app needs, from what the app already declares:

```ts
voidbaseAdapter({ pwa: { icon: "icon.svg" } })
```

| written | what it is |
| --- | --- |
| `manifest.webmanifest` | name, short name and description from `void.json`'s `head` (`title`, the `description` meta), `theme_color` from its `theme-color` meta, `background_color` the same unless set, `start_url` and `scope` at `/`, `display: standalone`, and the icons |
| `icons/` | the icon set from `icon`, one square PNG or SVG under `public/`. A PNG is resized to 192 and 512 with Photon, the resizer the thumbnails already use. An SVG is written as it is with `sizes: "any"`; the PNGs beside it need a rasterizer, so they are written when `sharp` is installed (`bun add -d sharp`) and skipped, with a warning, when it is not |
| `sw.js` | the service worker: it precaches the shell (every prerendered page, the client build's hashed `assets/`, and the `precache` list) under a version hashed from those files, so a new build is a new worker; navigations go to the network first with the cached page or the shell as the fallback; hashed assets come from the cache first; `/api/*` and `/_/*` are never touched |

Every option (`name`, `shortName`, `description`, `themeColor`, `backgroundColor`, `start`, `scope`, `precache`)
overrides the default it is named for. Each prerendered page gets a `<link rel="manifest">` and a `<meta
name="theme-color">` when it has none; nothing registers the worker, because that is the client's job:
`@voidbase-cloud/sdk/pwa` registers it, shows the update prompt and unregisters it, over the messages `sw.js`
answers to. A page posts `{ type: "SKIP_WAITING" }` to switch to a waiting version (the worker never skips
waiting on its own) and receives `{ type: "UPDATED", version }` from the version that activated; `{ type:
"UNREGISTER" }` makes the worker clear its caches and unregister itself, answering `{ type: "UNREGISTERED" }`,
which is the way out of a stuck worker. A `precache` path the build does not have fails the build by name,
because a missing entry would stop the worker from installing at all. The plugin's log line names the files and
the version, and `adapt()` returns them as `pwa`.

## A locale in the route

The `locales` option gives each locale an address and puts the `hreflang` links that say so on every prerendered
page:

```ts
voidbaseAdapter({ locales: { codes: ["en", "ar", "fr"], path: "prefix", default: "en" } })
```

`codes` are the locales the site is served in, `default` is the locale the bare URL is in (the first code unless
you name another), and `path` is where a locale goes in a URL: `query`, the default, leaves `?locale=<code>` as the
only address, and `prefix` adds `/<code>/<path>` beside it.

Both modes tag every prerendered page under `pb_public`: one `<link rel="alternate" hreflang="<code>">` per locale
plus `x-default`, and `<html lang>` set to the default locale. They are the links the seo plugin already emits in
the sitemap and the meta answer, built by the same functions (`src/server/plugins/seo-locales.ts`), so the two
cannot disagree. With `VOIDBASE_SITE_URL` set they are absolute, as the sitemap's are; without it they are paths.
A page that already declares its language keeps it when it is the same language (`en-GB` stays `en-GB` under `en`),
a page with no `<html>` element gets one opened after the doctype, since that is the only place the attribute can
live, and the 404 shell gets the attribute but no alternates, because it answers every unknown path and has no
page of its own to name.

`prefix` also writes two rules per locale into `pb_public/_redirects`, beside the seo plugin's:

```
/ar /?locale=ar 302
/ar/* /:splat?locale=ar 302
```

So `/ar/about` lands on `/about?locale=ar`: the page Void prerendered, with the locale in the address the
translations plugin reads first (`?locale=`, ahead of `Accept-Language`). The default locale gets the same pair
without the query, so `/en/about` is `/about` rather than a 404.

**Why a redirect and not a rewrite.** Cloudflare's `_redirects` does support a 200 proxy line
(`/ar/* /:splat 200`, relative destinations only), so the prefix could serve the page's bytes with no round trip.
It is still the wrong mechanism here, three times over. A proxy serves one file for every locale, so `<html lang>`
and the canonical URL on that page can only name one of them, and the rest would be served a page that says it is
the first. `_redirects` cannot add a request header: the asset layer answers and the Worker is never invoked, so
nothing on that path makes the request carry `Accept-Language: ar` for the API calls the page then makes, and a
rule that looks like a locale and carries none is worse than no rule. And `voidbase deploy` forwards only 3xx path
rules to the uploaded `_redirects` (`parseRedirects` in `src/node/cloud-init.ts`, and the test that pins it), so a
200 line would be dropped on the way out and do nothing at all. The redirect has none of those problems, and the
prefix stays what it was for: an address people can link and share. A Void route would have been the other way to
do it, and is the one thing to avoid: outside `/api` it would put the Worker in front of every page, image and
hashed chunk, which is what the asset layer is there to prevent (platform.md).

The rules are the deployed asset layer's; `voidbase serve` on Bun does not read `_redirects`, so on a local
instance the query form is the address that works. A rule is applied before the asset layer looks for a file, so a
real directory named like a locale would stop being reachable: the build says so when it finds one.

When `VOIDBASE_LOCALES` is set as well, the two lists have to be the same one and the option's `default` has to be
its source locale (its first), or the build fails with both lists in front of you, because `hreflang` links naming
a locale the API does not answer in are worse than no links at all. Without the option none of this is written:
no rule, no link, no attribute. `adapt()` returns what it did as `locales`, and the plugin's log line names the
locales, the mode, and how many pages and rules it wrote.

Interface strings are the other half of the same problem and are not the adapter's: `voidbase i18n extract` writes
the catalogues and the key union for them (setup.md), and content translations are the `translations` plugin's
(plugins.md).

## One session across the pages and the API

A stack app has two notions of who is signed in. voidbase authenticates a request from `Authorization: Bearer
<token>`, which is what the SDK sends from the browser. A Void page's loader runs server-side on the same Worker
and is handed an ordinary navigation, which carries cookies and no header of the app's own, so on its own it cannot
tell who the visitor is. `VOIDBASE_AUTH_COOKIE=1` makes the two agree:

```bash
VOIDBASE_AUTH_COOKIE=1
VOIDBASE_CORS_ORIGINS=https://app.example     # or VOIDBASE_CSRF=double-submit; one of the two is required
```

Every route that mints a token sets it as a cookie on the same answer: `auth-with-password`, `auth-with-oauth2`,
`auth-with-otp` (the MFA handshake included, since the second method is what ends in a token), the passkey routes,
and `auth-refresh`, which replaces it with a fresh one. `POST /api/collections/<collection>/auth-clear` takes it
away and answers 204; it needs no valid session of its own, because clearing a cookie nobody holds is the same
answer. Impersonation is the one exception: `impersonate` mints a token for *another* record at a superuser's
request, and that is data in the answer, not the caller's own session, so it sets no cookie.

| | |
| --- | --- |
| name | `__Host-vb_auth` on https, `vb_auth` on http, where a `__Host-` cookie would need `Secure` and no browser would keep it |
| attributes | `Path=/`, `HttpOnly`, `SameSite=Lax`, and `Secure` on https. No `Domain`, which is what `__Host-` means |
| lifetime | `Max-Age` is what is left of the token's own `exp`, so the cookie dies exactly when the token does |

The server then accepts that cookie as a source of the token **when the `Authorization` header is absent**, so an
ordinary browser navigation is authenticated and `authOf(c)` answers in a route reached that way. The header wins
whenever both are there, whichever of the two is the good one: nothing an SDK client does changes, and a stale
cookie cannot override the token a client sent on purpose.

**The knob is off by default, and refuses to take effect without a CSRF protection.** A browser attaches a cookie
on its own and never attaches a bearer token on its own, so the moment a cookie authenticates a state-changing
request, a cross-site page can make the browser send one. That is exactly the hole the hardening plugin's origin
rule and its double-submit token exist for (plugins.md, "The response policy"), so one of the two has to be on:

- `VOIDBASE_CORS_ORIGINS` naming the origins the application is served from, which turns the origin rule on: a
  `POST`, `PATCH`, `PUT` or `DELETE` carrying cookies from an origin that is neither this instance's nor one of the
  named ones is refused 403; or
- `VOIDBASE_CSRF=double-submit`, which additionally requires the `X-CSRF-Token` header from `GET /api/csrf` on a
  cookie-authenticated write.

With neither, `voidbase deploy` fails with the reason rather than shipping it, and an instance whose vars were set
some other way refuses the knob at request time: no cookie is set, no cookie is accepted, and the reason is printed
once. `VOIDBASE_CORS_ORIGINS=*`, which is what unset means, is not an origin rule and does not count.

**What a loader imports.** `sessionOf(request)` is `authOf(c)`'s counterpart for a page: it reads the cookie and
has the generated app verify it, the same path every API request takes, and answers the record or `null`.

```ts
// pages/account.server.ts
import { defineHandler } from "void";
import { sessionOf } from "@voidbase-cloud/voidbase/adapter";

export const loader = defineHandler(async (c) => {
  const user = await sessionOf(c.req.raw);
  return { email: user?.getString("email") ?? null };
});
```

The verification is not the adapter's: the token goes to whoever provides `auth@1`, through the same globals the
generated hook publishes before any of the app's code runs (`$auth`, beside `$app` and `$jobs`). That handoff is on
`globalThis`, not in the pb_hooks bundle, so a loader compiled apart from `routes/` reaches it just the same, and
where there is no voidbase at all — Void's build importing the same module to prerender a page — the answer is
`null` rather than a throw. The half of this that is still missing is the one the whole file already says: a page
that renders per request has no runtime here, so today a loader answers where server code runs, which is
`routes/`, `middleware/` and `vb_hooks/`. `sessionOf` is what it will call when pages render on this Worker too.


Under a guard the panel's entry is written as `entry.html`, not `index.html`. The rules that send the panel's path
to the handler name `<path>index.html` too, and Cloudflare applies a rule to the Worker's own `env.ASSETS.fetch`,
so a handler reading `index.html` would be answered with its own redirect and could never serve the panel it
guards. Without a guard the entry stays `index.html`, because the browser loads it directly.
## The panel under your own path

The admin panel is PocketBase's own static build, served at `/_/` since the beginning. The `panel` option moves it,
and optionally puts its front door behind a check:

```ts
voidbaseAdapter({ panel: { path: "/admin", guard: "superuser", hide: true } })
```

| Key | Default | What it does |
| --- | --- | --- |
| `path` | `/_/` | where the panel's files are written inside the generated `pb_public`. `/admin`, `/admin/` and `admin` all mean `/admin/` |
| `guard` | `false` | `"superuser"` puts the panel's entry behind a voidbase superuser session; without one it answers 404 |
| `hide` | `false` | takes `/_/` away, so the panel is only where `path` says |

Without the option nothing changes: no files are copied, no rule is written, and the panel stays at `/_/` exactly
as it was. `hide` needs a `path` of its own, or it would take the only panel away, and the build says so.

**What the panel's build hardcodes, measured rather than assumed** (PocketBase 0.40.2, the version
`src/node/panel.ts` pins):

- `index.html` references everything relatively (`./assets/...`, `./libs/...`), so it is copied unchanged and works
  from wherever it sits. There is no `<base>` to rewrite.
- the router is a hash router (`#/collections`), so there is no router base to rebase either.
- the API base is `new PocketBase("../")`, which the SDK resolves as the origin plus `location.pathname` plus
  `../`. That is right at `/_/` and at any other one-segment path, and wrong at a deeper one: `/ops/panel/` would
  call `/ops/api/...`. So the literal is rewritten at build time to `/`, which is origin-rooted and
  depth-independent, and a voidbase instance's API is always at the origin's `/api`.
- two absolute `/_/` URLs exist in the bundle. One builds the "API example" URL shown in the panel and already
  falls back to `window.location.origin` when the path is not `/_/`, so it is right once moved. The other loads
  `/_/extensions.js` (the UI extension registry) and is rewritten to `<path>extensions.js`.

Nothing else in the build names `/_/`. The rewrite touches `assets/*.js` in the copy only, and if a future panel
version stops constructing its base that way the build fails with what it looked for, rather than shipping a panel
whose API calls go somewhere else. So this is a rebase, not a redirect: the panel really is served from your path.

**The guard.** On Cloudflare the asset layer answers every path outside `/api` and never invokes the Worker
(platform.md item 1), so a check on the panel's path can only run if something sends that path to `/api`. `guard`
writes the rules for exactly that, into `pb_public/_redirects`, beside the seo plugin's and the locales':

```
/admin /api/panel?at=/admin/ 302
/admin/ /api/panel?at=/admin/ 302
/admin/index.html /api/panel?at=/admin/ 302
```

`GET /api/panel` answers the panel's index to a request carrying a voidbase superuser session, and **404** to
everything else. 404 and not 403: someone who is not a superuser should not learn the panel is there. The session
is read from the `Authorization` header, from the `pb_auth` cookie the SDK writes with
`authStore.exportToCookie()` (a browser navigating to a URL sends no header, so that cookie is how a browser
carries one), or from `?token=`. The `at` value comes from the rule the build wrote, and is checked before use --
one leading slash, a trailing slash, no host, no scheme, no `..`, not under `/api` -- so a request cannot turn the
handler into an open redirect. The index is answered with a `<base href="<path>">` injected, so its relative asset
URLs still resolve against the panel's own directory, and with `Cache-Control: private, no-store`.

**What the guard covers, and what it does not.** It covers the panel's entry: the three URLs above, which is every
address a browser resolves the panel's directory to. It does **not** cover the hashed chunks under the path
(`/admin/assets/...`, `/admin/libs/...`): those are served by the asset layer, and anyone who knows their exact
URLs can read them. They are PocketBase's stock build, the same bytes the project publishes, and they hold nothing
about your instance; every call the panel makes is still authorised by the API's own rules, so a person who gets
past the front door with no session sees a panel that cannot read anything. The guard hides the panel and gates
its entry. It is not a second authorisation layer over your data -- the collection rules are that.

**`hide`.** Rules are applied before the asset layer looks for a file, so `hide` rules `/_`, `/_/` and `/_/*` to
`/api/panel` with no `at`, which is the case that answers 404 for everybody. The panel's files still ship at `/_/`
(the deploy syncs them there), and nothing resolves to them.

**On Bun.** `voidbase serve` reads the same option: the adapter writes it into the generated `main.ts`, so the
runtime knows where the panel is, mounts the same `/api/panel` handler on the path itself (the app runs before the
static fallback there, so no `_redirects` are needed), and stops serving `/_/` when `hide` is on. What works on
Cloudflare works on Bun, from one option.

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
`/api/backups`, `/api/crons`, `/api/batch`, `/api/health`, `/api/webauthn` (passkeys), `/api/presence`,
`/api/openapi.json`, `/api/docs` and `/_/`
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
hook left in `middleware/`, a secret value nothing declares), `vb_secrets/` reaching the app through `$os.getenv`, one session across the pages and the API (signing in sets the cookie with its exact attributes and a lifetime that is the token's own, a later request with only the cookie is authenticated by the API, a page loader calling `sessionOf` sees the same user, the header still wins, a cross-site write carrying the cookie is refused, sign-out takes it away, and the knob without either CSRF protection is refused with the reason on an instance of its own),
the `pwa` option (the manifest's defaults, the icon set, the worker's precache list and handshake, the tags in
`index.html`, a new version for a changed shell, and nothing of it without the option), the `locales` option (the
rules each mode writes, the `hreflang` links and the `lang` attribute on the pages, the 404 shell without
alternates, absolute links under `VOIDBASE_SITE_URL`, a second pass writing the same bytes, nothing without the
option, and codes that disagree with `VOIDBASE_LOCALES` failing the build), the `panel` option (the files under
the path, the index copied unchanged, the two rebased URLs, the guard's three rules, `hide` ruling `/_/` away, a
second pass writing the same bytes, the two build errors, nothing without the option, and the moved panel served
by `voidbase serve` at its path), and that nothing is written outside `.voidbase/`. Run it with
`bun test/adapter.ts`, or as part of `bash scripts/ci.sh` (step `adapter`).
