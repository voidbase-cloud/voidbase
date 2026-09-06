# Performance baseline

Numbers below come from `scripts/bench.ts` and `scripts/bench-realtime.ts` against the **local dev server**
(Void `vp dev`, miniflare/workerd on WSL2, D1 and R2 emulated on disk). They show the shape of the cost per
endpoint, not production latency: on Cloudflare the Worker runs next to D1 (single-digit ms reads in the same
region), R2 adds a few ms, and cold starts of the Worker are in the tens of milliseconds. Re-run both scripts against
a deployment for real figures (`bun scripts/bench.ts https://<your-worker> --n 50 --concurrency 20`).

## Endpoints (local, 2026-09-06)

| endpoint | p50 ms | p95 ms | max ms | concurrent req/s | errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| GET /api/health | 23.3 | 45.9 | 46.7 | 52 | 0 |
| GET records list (30) | 30.7 | 48.2 | 151.0 | 56 | 0 |
| GET records list + filter + sort | 24.9 | 41.1 | 86.1 | 40 | 0 |
| GET record view | 23.8 | 39.4 | 52.7 | 54 | 0 |
| POST record create | 28.5 | 40.5 | 77.7 | 37 | 0 |
| PATCH record update | 29.6 | 38.8 | 53.8 | 37 | 0 |
| POST auth-with-password | 117.6 | 137.9 | 202.9 | 9 | 0 |
| GET file | 24.3 | 32.1 | 53.7 | 52 | 0 |
| GET thumb 100x100 (cached after first) | 37.2 | 59.2 | 92.3 | 38 | 0 |
| GET collections list (superuser) | 25.3 | 33.7 | 53.9 | 54 | 0 |

Reading the table: every request pays one settings read (cached per isolate for a few seconds), one auth lookup when a
token is present, and the D1 statements the endpoint needs (list: one count + one page query; create: one batch with
the insert and the realtime change-feed row). `auth-with-password` is dominated by bcrypt (cost 10, ~100 ms of CPU),
as in PocketBase. Thumbnails are generated once (Photon, wasm) and then served from the R2/S3 cache.

## Realtime fan-out (local)

| clients | opened + subscribed | received the event | delivery p50 | p95 |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 4.5 s | 100 / 100 | 587 ms | 837 ms |

Each SSE connection is a long-running Worker request that polls the `_changes` table about once per second;
connections in the same isolate share the read, so the D1 cost is roughly one query per second per isolate while at
least one client is connected and zero when idle. Delivery latency is bounded by the poll interval (under one second
here). The local dev server could not hold 300 concurrent streams within the bench's five-minute budget; that is a
miniflare limit, not the design's. Production limits to measure on a deployment: concurrent connections per isolate
(Cloudflare spreads long requests across isolates), D1 reads per second at 1k and 10k clients (expected: number of
isolates x 1/s), and per-request CPU (the poll loop sleeps, it does not spin).

## Cold start

The Worker bundle is about 1.5 MB with the Photon wasm (loaded lazily on the first thumbnail). Bootstrap on a fresh
isolate runs one `_params` read (settings) and, on the very first request after a deploy, the pending
`pb_migrations`. There is no in-memory state to warm apart from the settings cache and rate-limit counters.
