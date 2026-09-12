# Migrating an app from PocketBase

1. **Export the schema** from PocketBase: Settings > Export collections, or `GET /api/collections?perPage=500`.
   Import it into voidbase with Settings > Import collections (`PUT /api/collections/import`). Collection and
   field ids are preserved, so existing tokens' `collectionId` claims and relation fields keep working.
2. **Move the data.** For each collection, page through `GET /api/collections/{name}/records` on PocketBase and
   `POST` the records to voidbase as a superuser (ids are kept when supplied). Files: download from
   `/api/files/...` and re-upload as multipart. Passwords cannot be exported by PocketBase; users keep their
   accounts through a password reset, or you write the `password` hash column directly with `POST /api/sql`
   (bcrypt hashes are compatible).
3. **Copy `pb_hooks/` and `pb_migrations/`** into the voidbase project (or point `VOIDBASE_HOOKS_DIR` and
   `VOIDBASE_MIGRATIONS_DIR` at them) and rebuild. Read [hooks.md](./hooks.md) for the few members that do
   not exist on Workers (`$os.cmd`, `$filesystem.fileFromPath`, `$template` from disk).
4. **Settings:** re-enter SMTP credentials and OAuth2 client secrets in the panel (PocketBase never exports
   secrets). Update every provider's redirect URL to `https://<your-worker>/api/oauth2-redirect`.
5. **Client apps:** change the base URL passed to `new PocketBase(...)`. Realtime, files, thumbs, batch, auth
   flows and the admin panel behave the same; the differences that can matter are listed in
   [differences.md](./differences.md).
6. **Verify.** `bun test/conformance/compare.ts <pocketbaseURL> <voidbaseURL>` runs the same requests against
   both servers and diffs the JSON; the other suites under `test/conformance/` cover records, files, auth,
   realtime, settings, logs, crons, backups and SQL.

## Leaving voidbase

`voidbase export <outDir> --url <url>` logs in as a superuser and writes `data.db` (SQLite with PocketBase's table
and column layout, password hashes included), `collections.json` (import format) and `storage/` (every file as
`{collectionId}/{recordId}/{filename}`), reading only through the API so it works against a deployed instance.
Import `collections.json` into PocketBase, copy `storage/` into `pb_data/storage/` and load the rows from `data.db`.

