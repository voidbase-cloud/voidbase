# Deploying voidbase

voidbase is a Void app: one Worker (with its realtime hub Durable Object inside), one D1 database, one R2 bucket, a
jobs queue and the cron triggers the hooks need. Void infers the bindings (`DB`, `STORAGE`, the queue from `queues/`) from the source and provisions them; the
system tables come from the checked-in Drizzle migrations in `db/migrations/`, and PocketBase-style `pb_migrations`
run on the first request.

## Before the first deploy

```bash
bun install
bun run panel:sync                      # unmodified PocketBase admin panel -> public/_  (see --brand in scripts/sync-panel.ts)
bun run app:sync                        # optional: a built SvelteKit/SPA app -> public/  (deep links get index.html as the 404 page)
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
your account with the permissions voidbase needs already selected (Workers Scripts edit, D1 edit, Workers R2
Storage edit, Queues edit, Account Settings read):

[Create VOIDBASE_DEPLOY_CF_API_KEY](https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22queues%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&name=VOIDBASE_DEPLOY_CF_API_KEY)

Queues edit is optional: a token without it (one created before this permission was added) still deploys, the
deploy just skips the jobs queue and says so.

`voidbase token` prints the same link. Then, in the directory that holds `pb_hooks/` and `pb_migrations/`
(`voidbase-sveltekit-starter/vb` for the starter):

```bash
export VOIDBASE_DEPLOY_CF_API_KEY=...        # or put it in .env next to pb_hooks, or a CI secret
voidbase deploy --public-dir ../sk/build     # --name <worker>, --account <id> when the token reaches several accounts
```

What it does, in order: resolves the account through the token, creates `<name>-db` (D1), `<name>-storage`
(R2) and `<name>-jobs` (Queue) if they do not exist, writes the Void project inside the voidbase package
(`node_modules/voidbase/.cloud/<name>`, nothing appears in your tree) with a `wrangler.jsonc` carrying the real
ids and, when the directory has a `main.ts` exporting `register(app)`, composes it into the Worker; stores the
superuser as worker secrets (from `VOIDBASE_SUPERUSER_*` / `PB_SUPERUSER_*`, or a generated
password saved in `pb_data/.superuser-credentials`; the local dev default `changeme123` never goes live), syncs
the admin panel and your frontend build into that project, and runs `void deploy --backend cloudflare`,
which builds, applies the D1 migrations and uploads the Worker with its cron trigger. It ends with the
`https://<name>.<your-subdomain>.workers.dev` URL and a health check. Re-running is idempotent: existing resources
and credentials are reused. `--dry-run` does everything except install, secrets and the upload.

Quotas to know: the Workers Free plan allows 10 D1 databases per account (paid plans 50,000) and 5 cron
triggers per worker; voidbase needs one database, one bucket, one queue and the triggers its hooks declare (an
hourly tick without any). Cloudflare's own permission reference is at
https://developers.cloudflare.com/fundamentals/api/reference/permissions/ should the link's pre-selection ever
stop matching (the token then needs those permissions, picked by hand at
https://dash.cloudflare.com/?to=/:account/api-tokens).

### A custom domain

`voidbase deploy --domain api.example.com` (or `VOIDBASE_DEPLOY_DOMAIN`) turns workers.dev off for the Worker and attaches
the hostname through the Workers Custom Domains API after the upload: Cloudflare creates the DNS record and the
certificate (a minute or two), and the token needs nothing beyond Workers Scripts edit, provided the zone is on the same
account. Cloudflare still requires the account to have a workers.dev subdomain before it accepts any upload (error
10063): open Workers & Pages once, or `PUT /accounts/<id>/workers/subdomain {"subdomain": "<name>"}`.
`destroyInstance` in `voidbase/cloud` detaches custom domains before deleting the Worker.

### What the deploy wires up, and the knobs

| Binding | What it does | Knob |
| --- | --- | --- |
| `<name>-jobs` queue (`queues/<name>-jobs.ts`) | outbound mail and automatic backups run from the queue with retries (30 s, 60 s, ... up to 15 min, five times, then dropped and posted to `VOIDBASE_ALERT_WEBHOOK_URL`). Requests never wait on SMTP. Without the queue everything runs inline, as on the Bun runtime | `--no-queue` / `VOIDBASE_DEPLOY_QUEUE=0`; skipped automatically when the token lacks Queues edit |
| `RATE_LIMITER` (Cloudflare rate-limit binding) | a ceiling per client IP on `/api`, counted per Cloudflare location across every isolate there, on top of the settings' rate-limit rules (which count per isolate). Applies only while rate limits are enabled in Settings, and skips superusers and excluded IPs like the rules do. Cloudflare documents it as eventually consistent, not an exact counter | `--rate-limit 300/10` (requests per 10 or 60 seconds, default PocketBase's `/api/` rule) / `VOIDBASE_DEPLOY_RATE_LIMIT`, `0` disables |
| `LOGS_ANALYTICS` (Workers Analytics Engine) | one data point per request (method, path, status, auth collection, error, execution time) at any log level, queryable in the dashboard and the SQL API at $0.25 per million points, while the panel's log keeps writing D1 rows from `VOIDBASE_LOG_MIN_LEVEL` up. The account has to enable Analytics Engine once, at https://dash.cloudflare.com/?to=/:account/workers/analytics-engine, or the upload fails with code 10089 | opt-in: `--analytics` / `VOIDBASE_DEPLOY_ANALYTICS=1` |
| `HUB` (Durable Object `VoidbaseHub`, SQLite-backed, in this Worker) | the realtime hub: every SSE connection holds one hibernatable socket to it, writes publish to it, so events arrive in tens of milliseconds instead of the D1 poll's second, and idle apps cost nothing (the object sleeps). Free plan included | `--no-hub` / `VOIDBASE_DEPLOY_HUB=0` keeps the D1 poll |
| Smart Placement | the Worker runs next to its D1 database | always on |

### Every instance is isolated

Two voidbase instances on one account never share a resource. Everything the deploy creates is named or derived from
the worker name: `<name>-db`, `<name>-storage`, `<name>-jobs`, the `<name>_requests` dataset, and the rate-limit
binding's `namespace_id` is hashed from the name, because Cloudflare shares counters between bindings that reuse an
id across Workers. The realtime hub is a Durable Object class exported from the instance's own Worker rather than a Worker shared
by apps. `test/deploy-cf.ts` asserts the naming.

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

## Option D: instances created by a control plane (`voidbase bundle` + `voidbase/cloud`)

`voidbase deploy` builds on your machine. A service that creates voidbase instances for other people (the site's
/cloud page is one: sign in with Cloudflare, one click, an instance in the user's own account) cannot build, so it
uploads a prebuilt release over Cloudflare's REST API instead:

```bash
voidbase bundle                                   # builds the generic Worker + panel once -> .cloud/releases/<version>/
voidbase bundle --push https://<control plane> --token <superuser token>   # ... and stores it in that instance (POST /api/vbcloud/releases)
```

`voidbase/cloud` (src/cloud/rest.ts, plain fetch, runs in a Worker) then does what the deploy does, from the
release: `provisionInstance(cf, { account, name, release, superuser })` creates `<name>-db`, `<name>-storage`,
`<name>-jobs`, applies the D1 migrations through `/query` (tracked in wrangler's `d1_migrations` table), uploads the
assets through an upload session and the script with its bindings, DO migration, cron trigger and workers.dev
subdomain, tagged `voidbase` + `voidbase-release:<version>`; `destroyInstance` removes all of it (worker first,
bucket last, emptied before); `listVoidbaseWorkers` finds instances by tag. The token is the user's OAuth access token
(`cloudflare` OAuth2 provider, see `voidbase-site/vb/cloud`) or an API token with the same permissions.
`test/cloud-rest.ts` exercises it against `test/cf-mock.ts`. The hub and the queue are decided when the release
is bundled (`voidbase bundle --no-hub` / `--no-queue`), not per instance: an instance can leave them out at
provisioning, but cannot add what the release does not carry. Tokens a control plane keeps go to rest sealed
with `VOIDBASE_ENCRYPTION_KEY` (`sealSecret` / `openSecret` from `voidbase/cloud`).

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
