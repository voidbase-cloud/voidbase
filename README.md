# voidbase

A PocketBase-wire-compatible backend on Cloudflare Workers, built with [Void](https://void.cloud).
The unmodified PocketBase admin panel (0.40.2) and the unmodified `pocketbase` JS SDK (0.28) are the two oracles that define done.

Codename: `kanz-zjy`. Progress map: `surface/surface.json` rendered by `bun run surface`.

## Use it like PocketBase as a framework

```ts
// main.ts
import { voidbase, parseServeArgs, type VoidbaseApp } from "@voidbase-cloud/voidbase";
export function register(app: VoidbaseApp) {
  app.hooks.onRecordAfterCreateSuccess(async (e) => { /* ... */ }, "posts");   // the same on* functions pb_hooks get
  app.router.get("/api/hello", (c) => c.json({ hello: "world" }));              // Hono-style routes
  app.hooks.cronAdd("digest", "0 8 * * *", () => { /* ... */ });
}
if (import.meta.main) { const app = await voidbase(parseServeArgs()); register(app); await app.start(); }
```

`bun main.ts --http 127.0.0.1:8090` runs it; `voidbase deploy` composes `register` into the Worker as well.
`voidbase-sveltekit-starter/vb` is the worked example (audit log, `hooks` collection actions, passkeys).

## Install

```bash
bun add @voidbase-cloud/voidbase        # the package: library, CLI (`voidbase`) and the Cloudflare project generator
bunx @voidbase-cloud/voidbase serve     # or run the CLI without installing
```

Commits follow Conventional Commits (enforced by husky and CI); release-please turns them into a release PR,
and merging it publishes to npm (with provenance once the repository is public) and GitHub Packages with the
compiled notes; see [docs/releasing.md](docs/releasing.md).

## Run it like PocketBase

```bash
bun install
bunx voidbase serve --http 127.0.0.1:8090 --dir pb_data --hooksDir pb_hooks --migrationsDir pb_migrations --publicDir ./public
```

One Bun process, SQLite in `pb_data/data.db`, files in `pb_data/storage/`, the admin panel at `/_/`, the same
`pb_hooks` and `pb_migrations` you would give PocketBase (`--dev` restarts on hook changes, `voidbase superuser
upsert email pass` works offline on `pb_data`). The Cloudflare deployment runs the same code on D1 and R2 with
`voidbase deploy` from the same directory (see docs/deploy.md). The PocketBase-shaped
consumer is `voidbase-sveltekit-starter/vb`.

## Run locally (this checkout, Workers dev server)

```bash
bun install
cp .env.example .env            # first superuser, upserted at bootstrap
bun run panel:sync              # copies ../pocketbase/ui/dist to public/_ (set POCKETBASE_UI_DIST to override)
./node_modules/.bin/void db migrate
./scripts/dev.sh start 5180     # background dev server with a pidfile; stop / status / log
```

Panel: http://127.0.0.1:5180/_/  ·  API: http://127.0.0.1:5180/api/health

## Verify against PocketBase

With a reference PocketBase on 127.0.0.1:8090 (the starter's `pb/` works, superuser admin@example.com / changeme123):

```bash
bun test/conformance/compare.ts          # same requests at both servers, JSON diffed with volatile fields masked
bun test/panel-smoke.ts                  # headless login through the unmodified panel, screenshot to /tmp/panel.png
```

## The starter fork

`voidbase-sveltekit-starter` is the reference consumer: `pocketbase-sveltekit-starter` with `pb/` replaced by
`vb/` (a PocketBase-shaped directory: `pb_hooks`, `pb_migrations`, `pb_data`, `main.ts`, `entrypoint.sh`) and
nothing else changed. Its `vb/package.json` depends on this package; `bun run backend` in `sk` runs `voidbase serve`,
`bun run dev:backend` runs `main.ts`, and `bun run deploy` in `vb` goes live on Cloudflare. The original
`pocketbase-sveltekit-starter` checkout stays on upstream master as the PocketBase reference for the differential
suites (`scripts/seed-reference.sh` runs its `pb/` against the reference binary).

## CLI

`bun bin/voidbase.ts --help` (or `voidbase` when installed): `init`, `dev`, `build`, `preview`, `deploy [--cloudflare]`,
`superuser upsert|list`, `import <collections.json>`, `export <outDir>`, `panel sync [--brand dir]`, `app sync`,
`seed-user`. Remote commands take `--url` and `--admin email:password`.

## Tests

Conformance suites in `test/conformance/` run the same requests against a reference PocketBase (8090) and voidbase
(5180) and compare; browser suites `test/panel-*.ts` and `test/starter-*.ts` drive the unmodified panel and the
unmodified `pocketbase-sveltekit-starter`. Helpers that must be running for some suites: `bun test/smtp-sink.ts`
(SMTP 2525 / HTTP 2526), `bun test/mock-oidc.ts` (5190) and `bun test/s3-mock.ts` (5195, S3 with SigV4 verification). `bun test/fresh-db.ts` builds the production Worker
with the fixture hooks and migrations and boots it on an empty D1; `bun test/mail-http.ts` does the same with the HTTP mail
provider variables.

## Go live

`voidbase token` prints a Cloudflare dashboard link that creates `VOIDBASE_DEPLOY_CF_API_KEY` with the right
permissions pre-selected; with that variable set, `voidbase deploy` provisions D1 and R2, generates the Void project
inside the package (`node_modules/voidbase/.cloud/<name>`), stores the superuser as secrets and uploads the Worker.
Your directory stays `pb_hooks` + `pb_migrations` + `pb_data`, like a PocketBase folder. See [docs/deploy.md](docs/deploy.md).

## Continuous integration

`.github/workflows/ci.yml` checks out the two oracles (the starter and PocketBase's panel build), starts voidbase and
a seeded reference PocketBase (`scripts/seed-reference.sh`), and runs every suite through `scripts/ci-suites.sh`,
then `test/fresh-db.ts` and the starter smoke. The same scripts run locally against any pair of servers.

## Docs

- [docs/deploy.md](docs/deploy.md): Void platform or your own Cloudflare account.
- [docs/differences.md](docs/differences.md): what the platform changes (D1 batches, per-isolate limits, polling realtime, backups format).
- [docs/hooks.md](docs/hooks.md): `pb_hooks` and `pb_migrations` on Workers, supported events and globals.
- [docs/migrating.md](docs/migrating.md): moving an existing PocketBase app.
- [docs/platform.md](docs/platform.md): how to run cheap and fast on Cloudflare (assets off the Worker, log writes, change feed, crons, placement, queues, rate limits, the realtime hub) and the per-app Durable Object design for going beyond the account limits.
- [COMPAT.md](COMPAT.md): verified upstream versions and endpoint matrix.

## Layout

- `routes/api/[...path].ts` hands every `/api/*` request to the Hono app in `src/server/app.ts`.
- `src/server/` is the server: collections model, auth, settings, records, bootstrap.
- `db/schema.ts` defines only the system tables. User collections are rows in `_collections` and tables created at runtime, as in PocketBase.
- `public/_` is the panel build, synced, never edited (`bun run panel:sync --brand <dir>` for an optional logo/title/docs-link swap).
- Everything outside `/api` is served by Cloudflare's asset layer without invoking the Worker; deep links get the SPA shell through `404.html` copies of `index.html` (written at build time by `hooks-plugin.ts` and by the sync scripts).
- `crons/every-minute.ts` runs PocketBase's maintenance jobs and `cronAdd` jobs.
- `queues/jobs.ts` consumes the jobs queue (system mail, automatic backups) with retries; without it every job runs inline.
- `src/server/hub.ts` is the realtime hub, a Durable Object exported from this Worker (`hooks-plugin.ts` appends it to Void's entry; `wrangler.jsonc` binds it); without the binding realtime polls the D1 change feed.
- `hooks-plugin.ts` bundles `pb_hooks` and `pb_migrations` into the Worker at build time.
