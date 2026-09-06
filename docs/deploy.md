# Deploying voidbase

voidbase is a Void app: one Worker, one D1 database, one R2 bucket, one cron trigger. Void infers the
bindings (`DB`, `STORAGE`) from the source and provisions them; the system tables come from the checked-in
Drizzle migrations in `db/migrations/`, and PocketBase-style `pb_migrations` run on the first request.

## Before the first deploy

```bash
bun install
bun run panel:sync                      # unmodified PocketBase admin panel -> public/_  (see --brand in scripts/sync-panel.ts)
bun run app:sync                        # optional: a built SvelteKit/SPA app -> public/  (served with SPA fallback)
bun run build                           # vp build; bundles pb_hooks and pb_migrations into the Worker
```

Secrets and settings that must exist in production (declared in `env.ts`):

| Variable | Purpose |
| --- | --- |
| `VOIDBASE_SUPERUSER_EMAIL`, `VOIDBASE_SUPERUSER_PASSWORD` | first superuser, upserted on the first request. Remove or rotate after the first login |
| `VOIDBASE_ENCRYPTION_KEY` | optional; encrypts the settings row (SMTP password, OAuth2 secrets) at rest |
| `AUDITLOG` | only if your `pb_hooks` read it, like the starter's audit log |
| `VOIDBASE_ALERT_WEBHOOK_URL` | optional; every unhandled request error (HTTP 500) is POSTed there as JSON `{source, level, message, status, time, method, path, error, stack}` (Slack/Discord/PagerDuty-style receivers or your own endpoint) |
| `VOIDBASE_MAIL_HTTP_URL`, `VOIDBASE_MAIL_HTTP_KEY` | optional HTTP mail provider (Resend-compatible JSON endpoint + bearer key) used instead of SMTP for every email, including the panel's test email |

Everything else (SMTP, OAuth2 providers, rate limits, backups cron, trusted proxy) is configured from the
panel's Settings pages and stored in D1.

## Option A: the Void platform

```bash
void auth login
void project link             # or let `void deploy` create the project
void secrets put VOIDBASE_SUPERUSER_EMAIL
void secrets put VOIDBASE_SUPERUSER_PASSWORD
void secrets put VOIDBASE_ENCRYPTION_KEY
void deploy
```

`void deploy` builds, applies the Drizzle migrations to the remote D1, provisions D1/R2/cron from the source
and makes the deploy live. The panel is then at `https://<project>.void.app/_/`. Continuous deploys: `void init
--github` writes `.github/workflows/void-deploy.yml` (GitHub OIDC, no long-lived token), or install the Void
GitHub app (`void github install`, `void github connect`).

Operations: `void project logs --level error` (request handler errors, `console.error`), `void project
requests --status 5xx` (edge-level failures), `void project rollback`.

## Option B: your own Cloudflare account

```bash
wrangler login                                   # or CLOUDFLARE_API_TOKEN with Workers, D1, R2 edit
export CLOUDFLARE_ACCOUNT_ID=...                 # or account_id in wrangler.jsonc
void deploy --backend cloudflare --provision     # first time: creates the D1 database, R2 bucket, cron trigger
void deploy --backend cloudflare                 # afterwards
```

Keep secrets in `wrangler secret put VOIDBASE_SUPERUSER_PASSWORD` etc.: every `.env*` file this backend loads
ships as plaintext worker vars (a value that is also exported in the shell with the same value is stripped, so
`export VOIDBASE_SUPERUSER_PASSWORD=...` from `.env` before deploying and put the real one in a secret).
`wrangler.jsonc` in the repo pins the worker name, account and the two bindings; `--provision` fills in the D1 id.
Quotas to know: the Workers Free plan allows 10 D1 databases per account (paid plans 50,000) and 5 cron triggers
per worker; voidbase needs one database, one bucket and one cron. `--provision` runs on a developer machine (it fails closed in CI); commit the
`wrangler.jsonc` it writes, then CI can run `void deploy --backend cloudflare`.

## After deploying

1. Open `/_/`, log in with the bootstrap superuser, change the password.
2. Settings > Application: set the application URL (used in emails) and, if you terminate TLS elsewhere,
   the trusted proxy header. On Workers the client IP already comes from `CF-Connecting-IP`.
3. Settings > Mail server: SMTP on port 465 or 587 (25 is blocked on Workers); send the test email.
4. Settings > Backups: set a cron to write zips to R2 (`__backups__/`).
5. Point your app at the Worker URL. The `pocketbase` JS SDK needs no other change.

## Local preview of the production build

```bash
VOIDBASE_PERSIST_TO=.void-preview bun run build && vp preview --port 5181
```

`vp preview` runs the built Worker in workerd with the same module-scope restrictions as production, which is
how `test/fresh-db.ts` catches code that only works in dev.
