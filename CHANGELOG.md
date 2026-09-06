# Changelog

Releases are tagged `vX.Y.Z`; the section for the tagged version becomes the GitHub release notes.

## Unreleased

## 0.1.0

First release candidate: PocketBase 0.40 wire compatibility on Cloudflare Workers (D1, R2, cron) via Void.

- Collections engine with runtime DDL, all 14 field types, views with inferred fields, import/export, API rule validation.
- Records API: filter/sort/expand/fields, files with thumbnails and ranges, batch, cascade delete.
- Auth: password, OAuth2 (32 providers), OTP, MFA, passkeys, verification / password reset / email change flows, impersonation, auth alerts.
- Realtime over SSE with a D1 change feed; JS hooks and migrations (`pb_hooks`, `pb_migrations`) bundled at build time.
- Settings, SMTP over Cloudflare sockets, S3 file and backup storage, logs, crons, backups, SQL console, rate limits, trusted proxy, encryption at rest.
- Unmodified PocketBase admin panel served at `/_/`; unmodified `pocketbase` JS SDK 0.28 supported.
- Published as `@voidbase-cloud/voidbase` from GitHub Actions (npm + GitHub Packages).
- Cloudflare cost shape: assets and deep links served by the asset layer without invoking the Worker (`404.html` shells, deep links carry status 404), request logs written only from warnings up by default (`VOIDBASE_LOG_MIN_LEVEL`), change-feed rows only while a client is subscribed, cron triggers derived from the hooks' `cronAdd` expressions plus lazy maintenance, Smart Placement, lazy Photon. Background jobs (system mail, automatic backups) through a Cloudflare Queue with retries, a rate-limit binding as a per-location ceiling, an opt-in Analytics Engine request log; `voidbase deploy` creates the queue and declares the bindings. Realtime pushes through a per-instance Durable Object hub (hibernating sockets, tens of milliseconds instead of a one-second poll); the D1 poll remains the fallback without the binding.
- Differential conformance suites against a reference PocketBase, SDK coverage matrix, security suite, generated filter corpus, browser suites for the panel and the SvelteKit starter, CI workflow.
