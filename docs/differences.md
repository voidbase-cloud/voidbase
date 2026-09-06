# Differences and limits versus PocketBase

voidbase speaks PocketBase's HTTP API on Cloudflare Workers with D1 (SQLite), R2 (files) and the Workers cron
trigger. The panel and the SDK cannot tell the two apart for the surfaces listed in [COMPAT.md](../COMPAT.md);
this page lists where the platform forces a different shape, and the limits that come with it.

## Storage and database

| Topic | PocketBase | voidbase |
| --- | --- | --- |
| Database | one SQLite file on local disk | one D1 database (SQLite semantics, remote) |
| Transactions | interactive, `RunInTransaction` | none: every write validates first, then runs as **one D1 batch** (atomic). Hook code cannot open a transaction; `$app.runInTransaction(fn)` runs `fn` directly |
| Bound parameters | SQLite default (32766) | **100 per statement** (D1). Large `IN (...)` lists and wide inserts are chunked by the server; hand-written `$app.dao()` SQL must respect it |
| Columns per table | 2000 | 100 (D1) |
| Row / query size | SQLite limits | 1 MB per row, 128 MB per query result (D1). List endpoints paginate anyway |
| `_logs`, `_changes` | logs in a second SQLite file | tables in the same D1 database, pruned by the built-in crons |
| Files | local `pb_data/storage` or S3 | R2 bucket bound as `STORAGE` (keys `{collectionId}/{recordId}/{filename}`), or any S3-compatible bucket when `settings.s3.enabled` (SigV4 over fetch, path-style or virtual-host); `settings.backups.s3` likewise for archives |
| Backups | zip of the SQLite files + storage | zip of `data.json` (every table) + `storage/`, kept in R2 under `__backups__/`. A PocketBase backup cannot be restored here and vice versa; use import/export for cross-migration |

## Runtime

| Topic | PocketBase | voidbase |
| --- | --- | --- |
| Process | long-running binary, in-memory state | `voidbase serve` is a long-running Bun process with SQLite and local files (limits below do not apply there: transactions are real, rate limits exact, realtime pushes from memory); on Cloudflare, stateless isolates. Anything PocketBase keeps in memory (resend limits, OTP attempts, MFA sessions, WebAuthn challenges, backup lock) lives in `_params` or its own table |
| Rate limits | per process, exact | per isolate, **approximate**: each isolate keeps its own fixed-window counters. Configure limits as a safety net, not as billing |
| Realtime | in-process broadcaster | every SSE connection polls the `_changes` table from inside its own request, about once a second; connections in one isolate share the read. Events arrive within roughly one second and cost one D1 read per second per isolate while at least one client is connected (zero when idle) |
| Crons | in-process scheduler | Cloudflare cron trigger every minute runs the due jobs (`runDue`). A job may run on any isolate; keep jobs idempotent. `POST /api/crons/:id` runs a job on demand |
| CPU time | unlimited | Workers CPU limit per request (30 s on paid plans by default). Thumbnail generation of very large images and huge batch requests are the operations most likely to hit it |
| Request body | 32 MB default (configurable) | 32 MB, and Cloudflare's own upload limit applies (100 MB on Free/Pro plans, higher on Business/Enterprise) |
| Outbound mail | net/smtp | `cloudflare:sockets` TCP with STARTTLS or implicit TLS (port 25 is blocked on Workers; use 465 or 587), or an HTTP provider when `VOIDBASE_MAIL_HTTP_URL` is set (Resend-compatible JSON, bearer key in `VOIDBASE_MAIL_HTTP_KEY`); the settings JSON stays PocketBase-shaped either way |
| OAuth2 | Go providers | the same 32 providers implemented on `fetch`; Apple client secret generation with ES256 in WebCrypto |
| JS hooks | goja VM, synchronous | bundled at build time into the Worker (`pb_hooks/*.pb.js`), running on V8. `$app.*`, `$http.send`, `$filesystem.*` and mail calls are asynchronous under the hood; the bundler inserts the awaits so hook code stays PocketBase-shaped. See [hooks.md](./hooks.md) |
| Migrations | `pb_migrations/*.js` at startup | the same files, bundled at build time and applied on the first request after a deploy (tracked in `_pbMigrations`) |
| Panel | embedded | the unmodified panel build copied to `public/_` by `bun run panel:sync` |
| Settings encryption | `--encryptionEnv` | `VOIDBASE_ENCRYPTION_KEY` (16, 24 or 32 chars): the settings row is stored AES-GCM encrypted |
| Superuser bootstrap | `superuser upsert` CLI | `VOIDBASE_SUPERUSER_EMAIL` / `VOIDBASE_SUPERUSER_PASSWORD` env, upserted on the first request |

## Thumbnails

Sizes, crop anchors and fit rules follow PocketBase's `tools/filesystem` (imaging semantics), generated in Photon
(Rust compiled to wasm) and cached in R2. Only sizes declared on the field (plus `100x100`) are honoured, as in
PocketBase. WebP output is not produced: JPEG in, JPEG out; PNG in, PNG out.

## Not implemented

- `OnTerminate`, `OnBackupCreate` / `OnBackupRestore` hook events (registered, never fired).
- `$os.cmd` / `$os.exec`, `$filesystem.fileFromPath`, `$template` rendering from disk: there is no filesystem or shell on Workers.
- PocketBase's own CLI (`pocketbase serve|migrate|superuser`). Use the panel, `bun run` scripts and Void's CLI ([deploy.md](./deploy.md)).

## Health endpoint

`GET /api/health` returns `canBackup: false` while a backup or restore is running. `possibleProxyHeader` never
reports `CF-Connecting-IP`: Workers set that header themselves and voidbase already uses it as the client IP,
so the panel's "behind a reverse proxy" reminder only fires for other proxy headers you have not listed in
`settings.trustedProxy`.

## Static files on Cloudflare

PocketBase serves `--publicDir` itself: an existing file, otherwise `index.html` with status 200, and the admin panel's
index for any `/_/` path. On Cloudflare, voidbase hands everything outside `/api` to the static asset layer, which
never invokes the Worker (assets are free and skip the isolate; see docs/platform.md). Cloudflare answers a miss with
the nearest `404.html`, so the build ships `404.html` copies of `index.html` and of `_/index.html`:

- deep links (`/posts/abc/`) get the SPA shell with **status 404** instead of PocketBase's 200 (the body is identical; the
  client router boots as usual, and this is the shape SvelteKit documents for Cloudflare);
- a browser navigating to an unknown `/api/...` URL gets that HTML page with status 404, while API clients (anything
  without `text/html` in `Accept`) get PocketBase's JSON 404;
- `voidbase serve` (Bun) keeps PocketBase's exact semantics, including the 200 index fallback.
