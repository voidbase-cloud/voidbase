# voidbase

A PocketBase-wire-compatible backend on Cloudflare Workers, built with [Void](https://void.cloud).
The unmodified PocketBase admin panel (0.40.2) and the unmodified `pocketbase` JS SDK (0.28) are the two oracles that define done.

Codename: `kanz-zjy`. Progress map: `surface/surface.json` rendered by `bun run surface`.

## Run locally

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

## Layout

- `routes/api/[...path].ts` hands every `/api/*` request to the Hono app in `src/server/app.ts`.
- `src/server/` is the server: collections model, auth, settings, records, bootstrap.
- `db/schema.ts` defines only the system tables. User collections are rows in `_collections` and tables created at runtime, as in PocketBase.
- `public/_` is the panel build, synced, never edited.
