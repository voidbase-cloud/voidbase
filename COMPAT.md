# Compatibility matrix

Verified against these upstream versions. "Verified" means a differential test drives the same requests (or the
same UI) against a reference PocketBase and voidbase and compares the results; see `surface/surface.json` for the
item-level map (`bun run surface`).

| Component | Version | How it is verified |
| --- | --- | --- |
| PocketBase admin panel (`ui/dist`, served unmodified at `/_/`) | 0.40.2 | `test/panel-*.ts` (Playwright + system Chrome): login, collections, records, admin screens, superuser password reset, API preview |
| Reference PocketBase server | 0.39.11 binary (0.40.2 source for behavior) | `test/conformance/*.ts` differential suites. 0.40-only features (`Cross-Origin-Opener-Policy`, Instagram provider, `DELETE /api/logs`) are tolerated when the 0.39 binary lacks them |
| `pocketbase` JS SDK | 0.28 | through `pocketbase-sveltekit-starter` (`test/starter-*.ts`) and the SDK-shaped requests in the conformance suites |
| Void | 0.10.13 | dev, preview and build |
| Cloudflare Workers compatibility date | 2026-09-05, `nodejs_compat` | `void.json` |

## API endpoints

| Area | Endpoints | Status |
| --- | --- | --- |
| Health | `GET /api/health` | verified |
| Collections | `GET/POST /api/collections`, `GET/PATCH/DELETE /api/collections/:c`, `DELETE .../truncate`, `PUT /api/collections/import`, `GET /api/collections/meta/scaffolds`, `GET /api/collections/meta/oauth2-providers` | verified (incl. view inference, rule validation) |
| Records | `GET/POST .../records`, `GET/PATCH/DELETE .../records/:id` with filter, sort, expand, fields, skipTotal, `@request`/`@collection` rules, multipart files, modifiers | verified (88 recorded + live cases) |
| Auth | `auth-methods`, `auth-with-password`, `auth-refresh`, `auth-with-oauth2`, `auth-with-otp`, `request-otp`, MFA handshake, `impersonate`, `request/confirm-verification`, `request/confirm-password-reset`, `request/confirm-email-change`, auth alerts, `GET/POST /api/oauth2-redirect` | verified |
| Files | `GET /api/files/:c/:r/:f` (thumbs, ranges, 304, download), `POST /api/files/token`, protected files | verified |
| Realtime | `GET /api/realtime` (SSE), `POST /api/realtime` | verified (polling fanout, see differences) |
| Batch | `POST /api/batch` | verified (transaction emulated with undo statements) |
| Settings | `GET/PATCH /api/settings`, `test/email`, `test/s3` (validation only), `apple/generate-client-secret` | verified; S3 backend not implemented |
| Logs | `GET /api/logs`, `/api/logs/:id`, `/api/logs/stats`, `DELETE /api/logs` | verified |
| Crons | `GET /api/crons`, `POST /api/crons/:id` | verified (built-ins + `cronAdd`) |
| Backups | `GET/POST /api/backups`, `upload`, `GET/DELETE /api/backups/:key`, `POST .../restore` | verified; voidbase archive format |
| SQL console | `POST /api/sql` | verified |
| Passkeys (starter) | `/api/webauthn/*` | verified with a virtual authenticator |

## Hooks

All `on*` event families, `routerAdd`/`routerUse`, `cronAdd`/`cronRemove`, `migrate` and the `$app`, `$apis`,
`$http`, `$filesystem`, `$security`, `$os`, `$dbx` globals listed in [docs/hooks.md](docs/hooks.md).

## Tracking upstream

- Panel: rerun `bun run panel:sync` from a newer `pocketbase/ui/dist`, then `bun test/panel-*.ts`.
- Server behavior: point the conformance suites at a newer reference binary
  (`bun test/conformance/compare.ts http://127.0.0.1:8090 http://127.0.0.1:5180`) and fix the diffs.
- SDK: bump `pocketbase` in the starter and rerun `test/starter-*.ts`.
