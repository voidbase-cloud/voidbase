# Changelog

## 0.1.0 (unreleased)

First release candidate: PocketBase 0.40 wire compatibility on Cloudflare Workers (D1, R2, cron) via Void.

- Collections engine with runtime DDL, all 14 field types, views with inferred fields, import/export, API rule validation.
- Records API: filter/sort/expand/fields, files with thumbnails and ranges, batch, cascade delete.
- Auth: password, OAuth2 (32 providers), OTP, MFA, passkeys, verification / password reset / email change flows, impersonation, auth alerts.
- Realtime over SSE with a D1 change feed; JS hooks and migrations (`pb_hooks`, `pb_migrations`) bundled at build time.
- Settings, SMTP over Cloudflare sockets, S3 file and backup storage, logs, crons, backups, SQL console, rate limits, trusted proxy, encryption at rest.
- Unmodified PocketBase admin panel served at `/_/`; unmodified `pocketbase` JS SDK 0.28 supported.
- Differential conformance suites against a reference PocketBase, SDK coverage matrix, security suite, generated filter corpus, browser suites for the panel and the SvelteKit starter, CI workflow.
