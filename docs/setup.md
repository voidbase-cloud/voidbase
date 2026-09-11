# Setting up voidbase

Two different jobs share this page. If someone has already given you a voidbase address, you want
[Connecting to an instance](#connecting-to-an-instance) and nothing else. If you need an instance of your own,
[Setting one up](#setting-up-an-instance) has four ways to get one, and the first needs no toolchain at all.

Everything here assumes you have npm or bun and nothing more. Where a command is written with `bun`, `npm` does the
same thing: `npm i -g` for `bun i -g`, `npx` for `bunx`.

---

# Connecting to an instance

A voidbase instance answers PocketBase's API. That is the whole point of it: the client libraries, the admin panel,
the filter syntax, the error shape and the realtime protocol are PocketBase's, so anything written for PocketBase
works against voidbase without a change, and PocketBase's own documentation is the reference for all of it. What
differs is written down in [differences.md](differences.md), and it is a short list.

## From your app: the SDK

The SDK is PocketBase's, unmodified, from npm:

```bash
bun add pocketbase
```

Point it at your instance and use it exactly as its documentation says:

```ts
import PocketBase from "pocketbase";

const pb = new PocketBase("https://your-instance.example.com");

await pb.collection("users").authWithPassword("you@example.com", "your-password");

const posts = await pb.collection("posts").getList(1, 20, {
  filter: "published = true && author.verified = true",
  sort: "-created",
  expand: "author",
});

await pb.collection("posts").create({ title: "Hello", body: "…", author: pb.authStore.record?.id });

// realtime: every change to the collection, over one connection
pb.collection("posts").subscribe("*", (e) => console.log(e.action, e.record));
```

The auth token is kept in `pb.authStore` and sent with every later request, so signing in once is enough for the
rest of the session. File URLs come from `pb.files.getURL(record, filename)`, and a thumbnail is a `thumb` option on
that call.

Where to read further, all of it directly applicable:

- [The JS SDK](https://github.com/pocketbase/js-sdk) for every method, and the SDKs for other languages linked from
  it, which speak the same API.
- [Records API](https://pocketbase.io/docs/api-records/) for what each endpoint accepts and returns.
- [Filters and API rules](https://pocketbase.io/docs/api-rules-and-filters/) for the query and permission language.
- [Authentication](https://pocketbase.io/docs/authentication/) for password, OAuth2, OTP and multi-factor sign-in.
- [Files](https://pocketbase.io/docs/files-handling/) for uploads, protected files and thumbnails.

## From a browser: the admin panel

Every instance serves the admin panel at `/_/`, so `https://your-instance.example.com/_/` is the whole address. It
is PocketBase's own admin panel, unmodified, and it is where collections are designed, API rules are written,
records are browsed and edited, mail and OAuth2 providers are configured, logs are read and backups are taken.

Beside it, `/api/docs` is the instance's own API reference: an OpenAPI document generated from the collections you
have, scoped to the token it is opened with (nothing signed in, the public API; a user, that user's; a superuser,
everything), read through Scalar. The document itself is `/api/openapi.json` (docs/plugins.md, the `openapi` plugin).

Sign in with a superuser account. If you are setting the instance up yourself, the next section makes one.

PocketBase's documentation covers the panel screen by screen:

- [Collections](https://pocketbase.io/docs/collections/) for fields, indexes and the three collection types.
- [API rules and filters](https://pocketbase.io/docs/api-rules-and-filters/) for who may read and write what, which
  is the panel's most important screen and the one worth reading before going live.
- [Going to production](https://pocketbase.io/docs/going-to-production/) for the settings to check before you open
  an instance to the world.

---

# Setting up an instance

Four ways, in order of how much they ask of you:

| | what you get | what it costs you |
| --- | --- | --- |
| [Standalone](#standalone-one-file-no-toolchain) | one executable, running on your machine or your server | nothing to install, not even npm |
| [From npm](#from-npm-a-project-and-a-worker) | a project on your machine, and one command to put it on Cloudflare | bun or npm |
| [The voidbase stack](#the-voidbase-stack-a-void-app-with-a-backend-inside) | a whole application, site and backend, deployed as one Worker | bun or npm, and a build step |
| [voidbase cloud](#voidbase-cloud) | an instance without a machine of your own | experimental |

## Standalone: one file, no toolchain

The way to try voidbase, and a perfectly good way to run one in production on a server you own.

1. Download the archive for your platform from the
   [releases](https://github.com/voidbase-cloud/voidbase/releases): `voidbase_<version>_<os>_<arch>.zip`, built for
   Linux, macOS and Windows on amd64 and arm64, with musl builds for Alpine.
2. Unzip it. Inside is a single executable with the admin panel, the system migrations and the hook typings already
   in it. Nothing else is needed, and nothing is installed anywhere.
3. Make the first superuser, then start it:

```bash
./voidbase superuser upsert you@example.com your-password   # 8 characters or more: the panel asks for that later
./voidbase serve
```

It prints where it is:

```
Server started at http://127.0.0.1:8090
├─ REST API:  http://127.0.0.1:8090/api/
└─ Dashboard: http://127.0.0.1:8090/_/
```

Open the dashboard, sign in with the account you just made, and you have an instance. `--http 0.0.0.0:8090` makes it
reachable from other machines; put a TLS terminator in front of it before you do that on the open internet.

`./voidbase serve --tunnel` (the npm package's `voidbase serve --tunnel` too, with or without `--dev`) puts the
instance on the internet without any of that, through a Cloudflare quick tunnel: the banner gains a line,
`└─ Tunnel:    https://<words>.trycloudflare.com`, and that address reaches the API and the dashboard over HTTPS
until the server stops. It needs `cloudflared`: the one `VOIDBASE_CLOUDFLARED` names, else the one on `PATH`, else
the release binary is downloaded once into `~/.cache/voidbase/cloudflared/` (`XDG_CACHE_HOME` respected). When none
can be had, the server still starts and says so in one line. Quick tunnels get a fresh address every start and are
meant for showing work, not hosting it; with `--dev` the watcher keeps one tunnel across hook restarts.

Everything the instance owns lives in `pb_data/` next to the executable: the SQLite database, the uploaded files and
the generated hook typings. Copy that directory and you have copied the instance. `./voidbase update` fetches the
newest release for your platform, checks it against the published checksum and replaces the executable in place;
`--backup` zips `pb_data` first, and `--check` reports without changing anything.

`voidbase update` is the same command whichever way voidbase is installed. It looks at where you are standing: a
project whose `package.json` depends on voidbase is updated as a dependency, a global install reinstalls itself, and
the executable replaces itself as above. Updating a project changes what your next deploy will carry, not what is
serving right now.

`voidbase types --url <instance>` writes a typed client for the PocketBase JS SDK, generated from the instance's own
API description rather than from a second reading of the collections, so the client and `/api/docs` cannot
disagree. It fetches `GET /api/openapi.json` as a superuser (`--token <superuser token>`, or `--email` and
`--password` to sign in through `_superusers/auth-with-password`; `--admin email:password` and
`VOIDBASE_SUPERUSER_EMAIL`/`_PASSWORD` work as for the other commands), the one scope that describes every
collection, and writes one file, `src/voidbase.ts` unless `--out` says otherwise, overwritten each time, with a
header that says it is generated and how to regenerate it. The file has an interface per collection
(`PostsRecord`, `UsersRecord`: `string`, `number`, `boolean`, a union of the literals for a `select`, an array of
them for a multi-select, `unknown` for `json`, `{ lon; lat }` for a `geoPoint`, an id or ids for a `relation` and a
name or names for a `file`, plus `id`, `collectionId`, `collectionName`, `created` and `updated`; `expand` is typed
from the relation fields whose target the document names), a `Collections` map from name to interface, and
`TypedPocketBase`, which narrows the SDK's `collection(name)` to the right record type for a known name and leaves
any other name untyped. With `@voidbase-cloud/sdk`, voidbase's fork of the SDK, the map is the type argument:
`const pb = new VoidBase<Collections>(url)`. With the upstream `pocketbase` package apply it as
`const pb = new PocketBase(url) as TypedPocketBase`, or `as TypedPocketBase<PocketBase>` to keep everything the
SDK's class has. Either way a renamed field is then a compile error.
The file imports nothing: the few SDK shapes it needs are declared in it, structurally, so it compiles on its own
and against whichever SDK version the project installed. `--json <file>` generates from a saved document instead
of the network, for tests and offline use. There is no `--watch`: run the command again when the collections
change (or put it in the build). The client plugin surface beside this is the fork's `client.use(plugin)`.

`voidbase migrate <from-url> <to-url>` moves an instance's data to another running instance, whichever way each one
runs (the executable, the npm package, Cloudflare) and in either direction. It is a backup taken on the source and
restored on the target through the backups API over HTTP, so it works from the executable and needs nothing but the
two URLs and a superuser on each side (`--from-email` / `--from-password`, `--to-email` / `--to-password`, or
`--from-token` / `--to-token`). Every step is printed. The target's collections, records, files, settings and
superusers become the source's, which is what a move means; `--dry-run` signs in on both sides and says what would
happen without doing it, and `--keep` leaves the migration archive on both sides instead of deleting it once the
target is verified.

To add server-side behaviour, put JavaScript in `pb_hooks/` beside the executable. The
[directories section](#what-the-directories-are) below explains each one, and they mean the same thing here.

## From npm: a project and a Worker

This is the path if you want the instance in a repository, and probably on Cloudflare.

```bash
bun i -g @voidbase-cloud/voidbase
```

### Instances on this machine

The npm package does the same job as the standalone executable, and remembers what you have made, so a second
instance does not mean finding where you put the first.

```bash
voidbase local new blog      # a directory, a port and a superuser, under ~/.voidbase/instances
voidbase local ls            # what you have, which port each is on, and which are running
voidbase local start blog    # run it
voidbase local rm blog       # forget it; --purge deletes the directory and its database too
```

Nothing there touches Cloudflare. `--dir` puts an instance where you want it, `--port` picks the port, and
`--email` with `--password` chooses the superuser instead of having one generated. Each instance keeps the port it
was given, so two never collide.

### A project on your machine

```bash
mkdir my-backend && cd my-backend
voidbase init          # writes pb_hooks/, pb_migrations/, pb_secrets/, .env and a .gitignore
voidbase serve         # http://127.0.0.1:8090, panel at /_/
```

A local instance and a project are the same shape, so moving between them is moving a directory.
`voidbase serve --workers` runs the same project on Cloudflare's local runtime instead of Bun, with local D1, R2,
queue and hub and nothing touching Cloudflare ([deploy.md](deploy.md#the-instance-on-cloudflares-local-runtime-voidbase-serve---workers)).

`voidbase init` leaves a working hook in `pb_hooks/main.pb.js` so `GET /api/hello` answers, and a commented
declaration in `pb_secrets/main.ts` to fill in. Make a superuser the same way as above, with
`voidbase superuser upsert you@example.com your-password`, or set `VOIDBASE_SUPERUSER_EMAIL` and
`VOIDBASE_SUPERUSER_PASSWORD` in `.env` and let the first run create it.

To start from somebody's working project instead of empty directories, `voidbase init [dir] --template <name>`
takes a template the marketplace lists (`voidbase templates`, or `voidbase init --template` with no name, prints
them: name, title, summary, repository; `--marketplace <url>` reads another, and `VOIDBASE_PLUGIN_MARKETPLACES`
applies here too) and `--template owner/name` takes any public GitHub repository. The files of the default branch
(or `--ref <branch or tag>`) are downloaded from GitHub as a tarball and unpacked with the system `tar` into `dir`
(default: the repository's name), which has to be empty or absent; nothing is cloned and no `.git` is left behind.
The next steps are read from the template itself: `bun install` and its `dev` script for a package, `voidbase
serve` for a PocketBase layout, `bun install` and `bun run dev` for a voidbase stack app. GitHub answers 404 for a
private repository and a missing one alike, and the command says so.

### Straight onto Cloudflare

The same directory deploys to your own Cloudflare account as one Worker, with its D1 database, R2 bucket, jobs queue
and realtime Durable Object created for it on the first run. You need one API token, and one command prints the link
that creates it with the right permissions already ticked:

```bash
voidbase token
```

Put the token where the project's configuration lives, as a `local()` key, meaning one your tooling reads and that is
never deployed anywhere. In `pb_secrets/main.ts`:

```ts
import { defineSecrets, local, string } from "@voidbase-cloud/voidbase/secrets";

export default defineSecrets({
  VOIDBASE_DEPLOY_CF_API_KEY: local(string(), "the deploy token"),
  VOIDBASE_DEPLOY_NAME: local(string().default("my-backend"), "the Worker this project deploys to"),
});
```

The Worker is named after the directory unless you say otherwise, so `VOIDBASE_DEPLOY_NAME` is optional. Declaring it
is worth the line anyway: a repository that holds more than one instance would otherwise be one stray environment
variable away from deploying one of them over another, and a project that names its target refuses to be deployed
anywhere else.

and its value in `pb_secrets/secrets.json`, which `voidbase init` has already added to `.gitignore`:

```json
{ "VOIDBASE_DEPLOY_CF_API_KEY": "…" }
```

Then:

```bash
voidbase deploy
```

It creates what does not exist, updates what does, stores the declared secrets on the Worker, and prints the URL.
Deploy again whenever you change anything. `voidbase secrets` shows every declared key, its tier, whether it has a
value here and whether the Worker has it. [deploy.md](deploy.md) covers custom domains, a static site in `pb_public/`
and the rest.

If you would rather push to GitHub than run a command, `voidbase sync` does the deploy and then connects the
repository to Cloudflare Workers Builds, so every later push deploys by itself. That flow is in
[deploy.md](deploy.md) too.

### What the directories are

A voidbase project is PocketBase's layout, and each directory means what it means in PocketBase.

| directory | what goes in it |
| --- | --- |
| `pb_hooks/` | Server-side JavaScript, run inside the instance. `routerAdd("GET", "/api/thing", …)` adds an endpoint; `onRecordCreate`, `onRecordAfterUpdateSuccess` and the rest run around writes; `cronAdd` schedules work. One file or many, any name ending `.pb.js`, loaded in filename order. This is PocketBase's [JSVM API](https://pocketbase.io/docs/js-overview/), and [hooks.md](hooks.md) lists exactly what voidbase implements. |
| `pb_migrations/` | Schema changes as JavaScript, applied in filename order, each one recorded so it runs once, in the same format as PocketBase's [JS migrations](https://pocketbase.io/docs/js-migrations/). This is one of the two ways a collection you designed in the panel on your machine reaches production; the other is the panel's own export, which `voidbase import collections.json --url <instance>` applies to another instance. |
| `pb_public/` | Static files served at `/`, so a built frontend can ship inside the same instance. An `index.html` here is the site; unknown paths get its `404.html`, while `/api` and `/_/` are untouched. |
| `pb_secrets/` | The project's configuration. `main.ts` declares every key and who may read it; `secrets.json` holds the values on your machine and is git-ignored. Nothing else in the project needs a `.env`. See [deploy.md](deploy.md#configuration-and-secrets-pb_secrets) for the tiers. |
| `pb_data/` | Everything the running instance owns: the SQLite database, uploaded files, and the generated `types.d.ts` that makes hook editing autocomplete. Git-ignored, and not used at all once deployed, where D1 and R2 hold the same things. |

Only `pb_hooks/` and `pb_migrations/` are worth putting in version control from day one. The rest appear when you
need them.

## The voidbase stack: a Void app with a backend inside

The paths above give you a backend that a separate frontend talks to. This one gives you a single application: a
[Void](https://void.cloud) app with pages, routes and a database, which builds into a voidbase instance and deploys
as one Cloudflare Worker serving the site, the API and the admin panel from the same address.

Start from a Void app and add voidbase to it:

```bash
mkdir my-app && cd my-app
bun add void && bunx void init            # scaffolds a Void app: pages/, routes/, db/, vite.config.ts
bun add @voidbase-cloud/voidbase
```

Add the adapter to the Vite config, which is the only wiring there is:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidbaseAdapter } from "@voidbase-cloud/voidbase/adapter/plugin";

export default defineConfig({ plugins: [voidPlugin(), voidbaseAdapter()] });
```

The project stays a plain Void app. `routes/`, `middleware/`, `crons/`, `queues/`, `pages/` and `db/` are Void's and
mean what Void means by them. Three directories are yours to add when you want them, each named for the voidbase
thing it is:

| directory | what goes in it |
| --- | --- |
| `vb_hooks/` | PocketBase's event hooks, one per file: `export default defineHook("onRecordCreate", handler, "posts")`. Void has no equivalent, which is why they have a home of their own. |
| `vb_migrations/` | PocketBase JS migrations, the counterpart of Void's `db/`, for collections rather than Drizzle tables. |
| `vb_secrets/` | `main.ts` declares the app's configuration and `secrets.json` holds the local values, exactly as `pb_secrets/` does above. |

Then build and run it:

```bash
bun run build                                  # writes the whole voidbase app into .voidbase/
bun .voidbase/main.ts --http 127.0.0.1:8090    # site at /, API at /api, panel at /_/
```

The build generates a complete voidbase project into a git-ignored `.voidbase/`, so what you deploy is an ordinary
voidbase instance, and everything in the npm section applies to it:

```bash
cd .voidbase && voidbase deploy
```

[adapter.md](adapter.md) is the full reference: how Void's routes reach PocketBase's data, what the build refuses and
why, and what each generated file is.

## voidbase cloud

**Experimental. A full guide is coming.** voidbase cloud provisions instances into a Cloudflare account for you,
without a project or a deploy command of your own. It exists and it works, but it is still moving, so it is not yet
documented as something to depend on. Until it settles, the three paths above are the supported ways to run an
instance, and every one of them puts the instance in an account you control.

Everything the cloud page does is also a command, so nothing is dashboard-only. Sign in once with the "CLI token"
the cloud page shows for the signed-in user; it is kept in `~/.config/voidbase/cloud.json` (mode 600,
`XDG_CONFIG_HOME` respected), and `--url` points at a site other than voidbase.cloud. The commands are plain HTTP
against the site, so they work from the executable as well as the package.

```bash
voidbase cloud login --token <token>        # from the cloud page; logout forgets it, whoami says who you are
voidbase cloud whoami                       # the user, the Cloudflare connection and its accounts, GitHub
voidbase cloud instances                    # yours, with status, release and url
voidbase cloud instances create shop        # provisioned in your own Cloudflare account from the site's release;
                                            # --account picks one of several, --email the superuser (the password
                                            # is printed once and kept nowhere)
voidbase cloud instances upgrade shop       # to the site's current release, in place
voidbase cloud instances delete shop --yes  # the Worker, its D1, R2, queue and domains; asks first without --yes
voidbase cloud repos                        # the repositories linked to your instances
voidbase cloud repos create shop --template voidbase-site --name my-site --private
voidbase cloud repos link shop owner/name   # one you already have; unlink owner/name forgets it (GitHub keeps it)
voidbase cloud plugins shop --email you@example.com --password ...     # ls (default), install name[@version]
                                            # [--marketplace url], remove name, update [name]: the instance's own
                                            # installer, signed in as its superuser
```

An instance is named by its name (`shop` finds `vb-shop`) or its id, and every verb takes `--json` for the raw
result. A verb that fails exits non-zero with the site's, Cloudflare's or the instance's own message.
