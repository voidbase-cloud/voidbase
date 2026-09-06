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

## Go live on your Cloudflare account (primary path)

One API token, one command. Create the token with this link; it opens the Cloudflare dashboard's token wizard for
your account with the four permissions voidbase needs already selected (Workers Scripts edit, D1 edit, Workers R2
Storage edit, Account Settings read):

[Create VOIDBASE_DEPLOY_CF_API_KEY](https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&name=VOIDBASE_DEPLOY_CF_API_KEY)

`voidbase token` prints the same link. Then, in the directory that holds `pb_hooks/` and `pb_migrations/`
(`voidbase-sveltekit-starter/vb` for the starter):

```bash
export VOIDBASE_DEPLOY_CF_API_KEY=...        # or put it in .env next to pb_hooks, or a CI secret
voidbase deploy --public-dir ../sk/build     # --name <worker>, --account <id> when the token reaches several accounts
```

What it does, in order: resolves the account through the token, creates `<name>-db` (D1) and `<name>-storage`
(R2) if they do not exist, writes the Void project inside the voidbase package
(`node_modules/voidbase/.cloud/<name>`, nothing appears in your tree) with a `wrangler.jsonc` carrying the real
ids and, when the directory has a `main.ts` exporting `register(app)`, composes it into the Worker; stores the
superuser as worker secrets (from `VOIDBASE_SUPERUSER_*` / `PB_SUPERUSER_*`, or a generated
password saved in `pb_data/.superuser-credentials`; the local dev default `changeme123` never goes live), syncs
the admin panel and your frontend build into that project, and runs `void deploy --backend cloudflare`,
which builds, applies the D1 migrations and uploads the Worker with its cron trigger. It ends with the
`https://<name>.<your-subdomain>.workers.dev` URL and a health check. Re-running is idempotent: existing resources
and credentials are reused. `--dry-run` does everything except install, secrets and the upload.

Quotas to know: the Workers Free plan allows 10 D1 databases per account (paid plans 50,000) and 5 cron
triggers per worker; voidbase needs one database, one bucket and one cron. Cloudflare's own permission reference is
at https://developers.cloudflare.com/fundamentals/api/reference/permissions/ should the link's pre-selection ever
stop matching (the token then needs exactly those four permissions, picked by hand at
https://dash.cloudflare.com/?to=/:account/api-tokens).

## Option B: the Void platform

```bash
void auth login
voidbase deploy --void            # void deploy from this checkout, or from cloud/ in a consumer
```

`void deploy` builds, applies the Drizzle migrations to the remote D1, provisions D1/R2/cron from the source and
makes the deploy live; secrets go through `void secret put`. Continuous deploys: `void init --github` (GitHub
OIDC) or the Void GitHub app. Operations: `void project logs --level error`, `void project requests --status 5xx`,
`void project rollback`.

## Option C: a visible Void project

`voidbase cloud init [dir]` writes the same project into your tree, importing the `voidbase` package by name, for
people who want to edit it (extra routes, bindings, a custom domain in `wrangler.jsonc`). Deploy it with
`voidbase deploy --dir <dir>`, or by hand: `wrangler login`, `CLOUDFLARE_ACCOUNT_ID`, then
`void deploy --backend cloudflare --provision` (interactive shells only; commit the `wrangler.jsonc` it writes for
CI). Every `.env*` file that backend loads ships as plaintext worker vars, so keep secrets in `wrangler secret put`.

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
