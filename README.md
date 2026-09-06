# voidbase

A PocketBase-wire-compatible backend on Cloudflare Workers, built with [Void](https://void.cloud).
The unmodified PocketBase admin panel (0.40.2) and the unmodified `pocketbase` JS SDK (0.28) are the two oracles that define done.

Codename: `kanz-zjy`. Progress map: `surface/surface.json` rendered by `bun run surface`.

## Run it like PocketBase

```bash
bun install
bunx voidbase serve --http 127.0.0.1:8090 --dir pb_data --hooksDir pb_hooks --migrationsDir pb_migrations --publicDir ./public
```

One Bun process, SQLite in `pb_data/data.db`, files in `pb_data/storage/`, the admin panel at `/_/`, the same
`pb_hooks` and `pb_migrations` you would give PocketBase (`--dev` restarts on hook changes, `voidbase superuser
upsert email pass` works offline on `pb_data`). The Cloudflare deployment runs the same code on D1 and R2: put a
`voidbase cloud init` project next to your hooks and `void deploy` it (see docs/deploy.md). The PocketBase-shaped
consumer is `pocketbase-sveltekit-starter/vb`.

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

## Use as a package (the starter's `vb/`)

`pocketbase-sveltekit-starter/vb` is the reference consumer: a few one-line Void entry files import `voidbase/app`,
`voidbase/middleware`, `voidbase/crons`, `voidbase/schema`, `voidbase/env` and the `pbHooksPlugin` from
`voidbase/plugin`, with the project's own `pb_hooks/` and `pb_migrations/` next to them (package `exports`). Its
`entrypoint.sh` is a drop-in for the PocketBase one: same `PB_*` environment, same port. The panel is fetched from the
pinned PocketBase release when no local `ui/dist` is around (`scripts/sync-panel.ts`).

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

## Continuous integration

`.github/workflows/ci.yml` checks out the two oracles (the starter and PocketBase's panel build), starts voidbase and
a seeded reference PocketBase (`scripts/seed-reference.sh`), and runs every suite through `scripts/ci-suites.sh`,
then `test/fresh-db.ts` and the starter smoke. The same scripts run locally against any pair of servers.

## Docs

- [docs/deploy.md](docs/deploy.md): Void platform or your own Cloudflare account.
- [docs/differences.md](docs/differences.md): what the platform changes (D1 batches, per-isolate limits, polling realtime, backups format).
- [docs/hooks.md](docs/hooks.md): `pb_hooks` and `pb_migrations` on Workers, supported events and globals.
- [docs/migrating.md](docs/migrating.md): moving an existing PocketBase app.
- [COMPAT.md](COMPAT.md): verified upstream versions and endpoint matrix.

## Layout

- `routes/api/[...path].ts` hands every `/api/*` request to the Hono app in `src/server/app.ts`.
- `src/server/` is the server: collections model, auth, settings, records, bootstrap.
- `db/schema.ts` defines only the system tables. User collections are rows in `_collections` and tables created at runtime, as in PocketBase.
- `public/_` is the panel build, synced, never edited (`bun run panel:sync --brand <dir>` for an optional logo/title/docs-link swap).
- `middleware/01.request-context.ts` serves assets and the SPA fallback for everything outside `/api`.
- `crons/every-minute.ts` runs PocketBase's maintenance jobs and `cronAdd` jobs.
- `hooks-plugin.ts` bundles `pb_hooks` and `pb_migrations` into the Worker at build time.
