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
                                        #   (in a Cloudflare build the same word runs the CI suite: docs/ci.md)
```

Secrets and settings that must exist in production (declared in `env.ts`):

| Variable | Purpose |
| --- | --- |
| `VOIDBASE_SUPERUSER_EMAIL`, `VOIDBASE_SUPERUSER_PASSWORD` | first superuser, upserted on the first request. Remove or rotate after the first login |
| `VOIDBASE_ENCRYPTION_KEY` | optional; encrypts the settings row (SMTP password, OAuth2 secrets) at rest |
| `AUDITLOG` | only if your `pb_hooks` read it, like the starter's audit log |
| `VOIDBASE_ALERT_WEBHOOK_URL` | optional; every unhandled request error (HTTP 500) is POSTed there as JSON `{source, level, message, status, time, method, path, error, stack}` (Slack/Discord/PagerDuty-style receivers or your own endpoint) |
| `VOIDBASE_MAIL_HTTP_URL`, `VOIDBASE_MAIL_HTTP_KEY` | optional HTTP mail provider (Resend-compatible JSON endpoint + bearer key) used instead of SMTP for every email, including the panel's test email |
| `VOIDBASE_MAIL_DOMAIN` | optional; a domain of the instance's whose zone is on the account (`example.com`, not an address). Read by `voidbase deploy` from the environment or `pb_secrets/secrets.json`: the Worker gets Cloudflare's `send_email` binding as `SEND_EMAIL` and the domain as a var, and the shipped `mail` plugin sends every message whose From is on that domain through Cloudflare Email Service; any other sender goes to SMTP when it is enabled, else is refused with the reason. The domain has to be onboarded for Email Sending once in the dashboard (docs/plugins.md, "Mail from the instance's domain") |
| `VOIDBASE_AI` | optional; `1` or a Workers AI model name (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, the default `1` means). Read by `voidbase deploy` from the environment or `pb_secrets/secrets.json`: the Worker gets the Workers AI binding as `AI` and the model as a var, and the shipped `ai` plugin answers `POST /api/ai/chat`, a chat over the instance with the MCP server's tool list for the caller (docs/plugins.md, "A chat over the instance") |
| `VOIDBASE_DATABASE` | optional; `durable` keeps the instance's data in its own SQLite-backed Durable Object instead of a D1 database (also `--database durable`). Read by `voidbase deploy` from the environment or `pb_secrets/secrets.json`: the Worker gets `DB_OBJECT` bound to `VoidbaseDatabase` under its own migration tag and no D1 is created or bound; unset or `d1` means D1 as before. A batched write becomes a real transaction; the 100-column and 100-parameter ceilings stay; one object per instance (docs/platform.md, "The database as a Durable Object") |
| `VOIDBASE_TRANSLATABLE`, `VOIDBASE_LOCALES` | optional, both needed for the shipped `translations` plugin to do anything: `posts:title,body;pages:title` declares the fields that have translations (`;` between collections, `,` between fields), `en,ar,fr` the locales (the first is the source, the order the fallback). The records API then answers in `?locale=` or the best `Accept-Language` match and says which in `Content-Language` (docs/plugins.md, "Content in the reader's language") |
| `VOIDBASE_SITE_URL`, `VOIDBASE_SITEMAP`, `VOIDBASE_ROBOTS_DISALLOW`, `VOIDBASE_LLMS_NOTE` | optional; the shipped `seo` plugin's files: the site's URL when it is not the request's origin, `posts[status="live"]:/blog/{slug},pages:/{slug}` the sitemap entries (a collection, an optional filter, a path template; the collection must be publicly listable), extra `Disallow:` paths for robots.txt, and a paragraph for llms.txt (docs/plugins.md, "The crawlers' view of the instance") |
| `VOIDBASE_SEO`, `VOIDBASE_SEO_IMAGE_SIZE`, `VOIDBASE_SEO_THEME`, `VOIDBASE_SEO_LOCALE_PATH` | optional; the `seo` plugin's page metadata (`GET /api/seo/meta?path=`) and share cards (`GET /api/seo/og/<collection>/<id>.svg`): `posts:Article{title=title,description=summary,image=cover,datePublished=created,author=author.name}` maps a schema.org type and fields onto a collection (a collection in the sitemap without one gets `WebPage` and the obvious fields), a thumb size for the mapped image, the card's background colour, and `prefix` to put the locale in the path (`/ar/...`) rather than `?locale=` for the `hreflang` alternates `VOIDBASE_LOCALES` adds |
| `VOIDBASE_SEO_PNG` | optional, default off; `1` renders the `seo` plugin's share cards as PNG (`<id>.png`) instead of SVG, which is what social scrapers can actually read. It is a build knob as well as a var: the deploy reads it here or from `pb_secrets/secrets.json`, bundles the resvg rasteriser and the card's font into the Worker, and bakes the var so the plugin advertises the `.png` in `og:image`. Off, none of it is in the bundle, `.png` answers the SVG body with `X-Voidbase-Card: svg-fallback` and `og:image` names the `.svg`. The cost of turning it on: the gzipped Worker goes from about 1.01 MB to 2.05 MB, against Cloudflare's 3 MB free-plan limit (docs/platform.md) |
| `VOIDBASE_BACKUP_KIND`, `VOIDBASE_BACKUP_KEEP` | optional; what the scheduled backup (Settings > Backups cron) writes: `full` (default: tables, files, settings, schema), `data` (the non-system collections' rows and files) or `schema` (the definitions alone), and how many automatic archives to keep, the oldest beyond it deleted after a verified write (default: the settings' `cronMaxKeep`). Named backups are never pruned (docs/plugins.md, "Backups worth relying on") |
| `VOIDBASE_BACKUP_S3_ENDPOINT`, `VOIDBASE_BACKUP_S3_BUCKET`, `VOIDBASE_BACKUP_S3_ACCESS_KEY_ID`, `VOIDBASE_BACKUP_S3_SECRET_ACCESS_KEY`, `VOIDBASE_BACKUP_S3_REGION` | optional, the first four together (the key and secret as secrets in `env.ts`); every archive written is also `PUT` to that S3-compatible bucket (another R2 account, Backblaze B2, AWS S3) with a SigV4 signature computed by the plugin, so a copy survives losing this account. Region `auto` unless set. `GET /api/backups` says `offsite: true` per archive, or `offsite: false` with the error; a failed copy never fails the backup |
| `STRIPE_SECRET_KEY` | optional, a secret (`secret(...)` in `env.ts`, so it lives in `pb_secrets`/`vb_secrets`); the shipped `stripe` plugin takes money through Stripe with it: `POST /api/payments/stripe/checkout`, `portal`, `cancel`, and the `customers`, `subscriptions` and `payments` collections created on the first request that carries a payment provider's key. Unset means the plugin is loaded and idle. With none of the three providers' keys `/api/plugins` says `payments: { via: "none" }`; with one, that provider; with two, the first in shipped order (stripe, polar, lemonsqueezy) answers and `/api/plugins` says which and why (docs/plugins.md, "Taking money") |
| `STRIPE_WEBHOOK_SECRET` | optional, a secret; the signing secret of the endpoint registered in Stripe's dashboard as `https://<instance>/api/payments/stripe/webhook`. Without it the webhook route answers 503 rather than accepting unsigned events |
| `POLAR_ACCESS_TOKEN` | optional, a secret; the shipped `polar` plugin takes money through Polar with it: `POST /api/payments/polar/checkout`, `portal`, `cancel`, the same three collections. `POLAR_SANDBOX=1` (a var) points every call at `sandbox-api.polar.sh` |
| `POLAR_WEBHOOK_SECRET` | optional, a secret; the `whsec_...` of the endpoint registered at Polar as `https://<instance>/api/payments/polar/webhook` (Standard Webhooks signature). Without it the webhook route answers 503 |
| `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID` | optional; the key is a secret, the store id (numeric) a var; the shipped `lemonsqueezy` plugin takes money through Lemon Squeezy with them: `POST /api/payments/lemonsqueezy/checkout`, `portal`, `cancel`, the same three collections. Both are needed |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | optional, a secret; the signing secret of the webhook registered at Lemon Squeezy as `https://<instance>/api/payments/lemonsqueezy/webhook` (`X-Signature`). Without it the webhook route answers 503 |
| `VOIDBASE_CORS_ORIGINS`, `VOIDBASE_HSTS`, `VOIDBASE_REFERRER_POLICY`, `VOIDBASE_PERMISSIONS_POLICY`, `VOIDBASE_CSP`, `VOIDBASE_CSP_FILES`, `VOIDBASE_CROSS_ORIGIN` | optional, all off unless set; the response policy the hardening plugin applies to every response (the security headers, CORS as a named list, the CSRF rule that comes with it): "The response policy" below |

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
voidbase deploy                              # --name <worker>, --account <id> when the token reaches several accounts
```

A static site is served at `/` by the same Worker when there is one: `./pb_public` (PocketBase's convention, picked up
automatically when the directory exists, exactly like `voidbase serve`), `--public-dir <dir>` or
`VOIDBASE_DEPLOY_PUBLIC_DIR`. Build it first: the directory needs an `index.html`. Unknown paths get its `404.html`
(a copy of `index.html` unless the build made one) with status 404, `/api` and `/_/` are untouched. A `_redirects`
file in that directory (Netlify/Pages syntax, `source destination [status]`) is split in two: path-only lines are
uploaded with the assets as Cloudflare's own `_redirects` (evaluated before the Worker), and lines whose source names a
host (`https://api.example.com/  /_/  302`) become zone Redirect Rules after the upload, tagged with the Worker's name so
a redeploy replaces exactly its own rules. That is how one Worker behind several custom domains answers differently per
hostname: the site on the apex, the API hostname's root sent to the admin panel, `www` sent to the apex. Writing them needs
the zone permission Single Redirect > Edit on the deploy token (the API's permission listing calls it Dynamic URL
Redirects Write; it sits with the zone permissions, like DNS Edit, scoped to the zone). Without it the deploy prints the
rules to create by hand and carries on.
(Void's own `routing.redirects` are not used: they are applied by the Void platform's dispatch worker, which a
self-hosted deploy does not have.)

```bash
voidbase deploy --public-dir ../sk/build     # a build that lives elsewhere
```

What it does, in order: resolves the account through the token, creates `<name>-db` (D1), `<name>-storage`
(R2) and `<name>-jobs` (Queue) if they do not exist, writes the Void project inside the voidbase package
(`node_modules/voidbase/.cloud/<name>`, nothing appears in your tree) with a `wrangler.jsonc` carrying the real
ids and, when the directory has a `main.ts` exporting `register(app)`, composes it into the Worker; stores the
superuser as worker secrets (from `VOIDBASE_SUPERUSER_*` / `PB_SUPERUSER_*`, or a generated
password saved in `pb_data/.superuser-credentials`; the local dev default `changeme123` never goes live) together
with the secrets and vars `pb_secrets/` declares (below), syncs
the admin panel and your frontend build into that project, and runs `void deploy --backend cloudflare`,
which builds, applies the D1 migrations and uploads the Worker with its cron trigger. It ends with the
`https://<name>.<your-subdomain>.workers.dev` URL and a health check. Re-running is idempotent: existing resources
and credentials are reused. `--dry-run` does everything except install, secrets and the upload.

Plugins take part in a deploy through the deploy-time surface (docs/plugins.md, "What a plugin does at deploy
time"): a shipped plugin's deploy module, or an installed plugin's `pb_plugins/<name>/deploy.js`, runs its `before`
hook once the Worker config is composed (it may change the config and the baked vars, or claim the URL), its
`after` hook once the Worker is up (it acts on the account), and its `remove` hook on `--remove`. The deploy prints
the deploy plugins it found (`deploy plugins: domains (shipped), ...`) and stops with the plugin named when a hook
fails; a dry run calls the hooks too, as a dry run, so the printed plan is the whole plan.

### Taking the Worker down: `voidbase deploy --remove`

`voidbase deploy --remove` (with `--name` / `--account` as for a deploy; `--yes` when nobody can be asked, `--dry-run`
to see the plan) runs every deploy plugin's `remove` hook, then deletes the Worker (its queue consumer first, which
Cloudflare requires). The database, the bucket and the queue stay, with everything in them: a deploy afterwards
finds them again, and `voidbase destroy <name>` is the command that removes them.

Quotas to know: the Workers Free plan allows 10 D1 databases per account (paid plans 50,000) and 5 cron
triggers per worker; voidbase needs one database, one bucket, one queue and the triggers its hooks declare (an
hourly tick without any). Cloudflare's own permission reference is at
https://developers.cloudflare.com/fundamentals/api/reference/permissions/ should the link's pre-selection ever
stop matching (the token then needs those permissions, picked by hand at
https://dash.cloudflare.com/?to=/:account/api-tokens).

### A custom domain: the `domains` plugin

Where the instance answers is the `domains` plugin's decision, not the deploy's (docs/plugins.md, "Where an
instance answers: domains"). `VOIDBASE_DOMAINS=example.com,www.example.com` (`--domain` on the command line;
`VOIDBASE_DEPLOY_DOMAIN`, the older name, is still read) lists the hostnames, comma separated, the first being the
canonical one. Before the upload the plugin validates them, turns workers.dev off for the Worker and bakes the list
and the canonical name as vars (`VOIDBASE_DOMAINS`, `VOIDBASE_CANONICAL_DOMAIN`, reported on `/api/plugins`), and
the deploy reports `https://<canonical>` as the URL. After the upload it attaches each hostname through the Workers
Custom Domains API (Cloudflare creates the DNS record and issues the certificate; the token needs nothing beyond
Workers Scripts edit, provided the zone is on the same account), waits up to 90 seconds for the certificate to be
active and says where it got (reading the zone's certificate packs takes SSL and Certificates Read on the token;
without it the plugin says so and does not wait), then sets a zone Redirect Rule per non-canonical hostname sending
everything under it, 301, to the same path on the canonical one (the same Rulesets path and permission as the
`_redirects` rules above; the two sets are tagged apart, `voidbase:<worker>:@domains:<host>` for the plugin's, and
never replace each other). `voidbase deploy --remove` detaches every hostname pointing at the Worker and deletes
those rules before the Worker goes. Cloudflare still requires the account to have a workers.dev subdomain before it
accepts any upload (error 10063): open Workers & Pages once, or
`PUT /accounts/<id>/workers/subdomain {"subdomain": "<name>"}`. `destroyInstance` in `voidbase/cloud` detaches
custom domains before deleting the Worker, and the control plane attaches them itself for the instances it provisions.

### A preview per pull request: `--preview`

`voidbase deploy --preview <branch>` deploys the project as a second Worker, the branch's own instance, and the
`previews` plugin does the rest (docs/plugins.md, "A preview per pull request: previews"). `VOIDBASE_PREVIEW=<branch>`
is the knob's environment form, and it is what a Workers build sets from `WORKERS_CI_BRANCH`. The Worker is
`<name>-pr-<slug>` (the branch lowercased, `[^a-z0-9]` runs to a dash, 20 characters at most, then a 4-character
hash of the branch, so two branches never share a Worker), which names its database, bucket and queue as any
instance's are named; it stays on workers.dev (the `domains` plugin attaches no production hostname to a preview);
`VOIDBASE_PREVIEW` and `VOIDBASE_PREVIEW_OF` are baked as vars and reported on `/api/plugins`. After the upload the
preview is seeded from production through the backups API (`VOIDBASE_PREVIEW_SEED=schema`, the default: the
collections' definitions; `data`: rows and files too; `none`), signing in on both sides with
`VOIDBASE_SUPERUSER_EMAIL` and `VOIDBASE_SUPERUSER_PASSWORD` (production at `VOIDBASE_PREVIEW_SOURCE_URL`, else its
workers.dev address), and the branch's open pull request gets one comment with the address, updated by every later
deploy of the branch, when `VOIDBASE_GH_TOKEN` and the repository (`VOIDBASE_PROJECT_REPO=owner/name`, else the
checkout's origin remote) are known. `--dry-run` says all of it and touches nothing.

```bash
voidbase deploy --preview feature/login            # a preview of this project's Worker for the branch
voidbase previews                                  # the previews on the account: branch, address, created
voidbase deploy --remove --preview feature/login   # the preview goes with its database, bucket and queue (asks, or --yes)
voidbase previews remove feature/login             # the same
voidbase previews prune --merged                   # every preview whose pull request is merged or closed goes
```

A preview is disposable, so `--remove --preview` (and the prune) deletes the Worker and everything it owns, unlike a
production `--remove`. On the production build `VOIDBASE_PREVIEW_PRUNE=1` makes every production deploy run the
prune in its `after` hook, which is what makes a preview disappear on merge.

**In CI.** A Worker takes two triggers at most, and two triggers may not watch the same branch, so a project with
previews has exactly these: the production trigger (the production branch, as `voidbase sync` sets it up) and the
previews trigger, `["*"]` minus the production branch, watching every path, with the same build command and the
deploy `VOIDBASE_PREVIEW=$WORKERS_CI_BRANCH bun run deploy` (the spelled-out form when the project has no `deploy`
verb: `bunx @voidbase-cloud/voidbase sync --name <name> --preview $WORKERS_CI_BRANCH`). `voidbase sync --previews`
creates or updates it and puts on both triggers what the plugin needs: `VOIDBASE_PROJECT_REPO` (the repository; the
build knows its branch and commit but not its repository), `VOIDBASE_GH_TOKEN` as a build secret when it is in the
environment, `VOIDBASE_PREVIEW_PRUNE=1` on the production trigger, and on the previews trigger
`VOIDBASE_SUPERUSER_EMAIL` and `VOIDBASE_SUPERUSER_PASSWORD` as build secrets when they are in the environment (the
preview stores them as its own superuser and signs in on production with them). A plain `voidbase sync` afterwards
leaves the previews trigger as it is; `--no-previews` removes it. Two things to set up by hand: the token, a
fine-grained GitHub token with pull requests: write (and contents: read) on the repository, exported as
`VOIDBASE_GH_TOKEN` when running `sync --previews` (or set later with the dashboard's build variables); and the
declared secrets, since a preview Worker is new and holds none: a secret `pb_secrets/main.ts` declares without a value
in the build's environment fails the deploy the way it does for any new Worker, so either declare it optional or set
it as a build secret on the previews trigger.

### What the deploy wires up, and the knobs

| Binding | What it does | Knob |
| --- | --- | --- |
| `<name>-jobs` queue (`queues/<name>-jobs.ts`) | outbound mail and automatic backups run from the queue with retries (30 s, 60 s, ... up to 15 min, five times, then dropped and posted to `VOIDBASE_ALERT_WEBHOOK_URL`). Requests never wait on SMTP. Without the queue everything runs inline, as on the Bun runtime | `--no-queue` / `VOIDBASE_DEPLOY_QUEUE=0`; skipped automatically when the token lacks Queues edit |
| `RATE_LIMITER` (Cloudflare rate-limit binding) | a ceiling per client IP on `/api`, counted per Cloudflare location across every isolate there, on top of the settings' rate-limit rules (which count per isolate). Applies only while rate limits are enabled in Settings, and skips superusers and excluded IPs like the rules do. Cloudflare documents it as eventually consistent, not an exact counter | `--rate-limit 300/10` (requests per 10 or 60 seconds, default PocketBase's `/api/` rule) / `VOIDBASE_DEPLOY_RATE_LIMIT`, `0` disables |
| `LOGS_ANALYTICS` (Workers Analytics Engine) | one data point per request (method, path, status, auth collection, error, execution time) at any log level, queryable in the dashboard and the SQL API at $0.25 per million points, while the panel's log keeps writing D1 rows from `VOIDBASE_LOG_MIN_LEVEL` up. The account has to enable Analytics Engine once, at https://dash.cloudflare.com/?to=/:account/workers/analytics-engine, or the upload fails with code 10089 | opt-in: `--analytics` / `VOIDBASE_DEPLOY_ANALYTICS=1` |
| `HUB` (Durable Object `VoidbaseHub`, SQLite-backed, in this Worker) | the realtime hub: every SSE connection holds one hibernatable socket to it, writes publish to it, so events arrive in tens of milliseconds instead of the D1 poll's second, and idle apps cost nothing (the object sleeps). Free plan included | `--no-hub` / `VOIDBASE_DEPLOY_HUB=0` keeps the D1 poll |
| `DB_OBJECT` (Durable Object `VoidbaseDatabase`, SQLite-backed, in this Worker) | the instance's database when `VOIDBASE_DATABASE=durable`: every query the Worker runs is an RPC to it and a batch is one transaction, rolled back on the first error. It replaces the D1 binding, which is then neither created nor bound; the same 100-column and 100-parameter ceilings apply (docs/platform.md) | `VOIDBASE_DATABASE=durable` or `--database durable`; unset means D1 |
| `SEND_EMAIL` (Cloudflare Email Service `send_email` binding) | outbound mail from `VOIDBASE_MAIL_DOMAIN` leaves through Cloudflare from the instance's own domain, with the SPF, DKIM and DMARC records Cloudflare wrote when the domain was onboarded; the deploy checks that the domain's zone is on the account and, when the token may read it, whether the domain is onboarded, and prints the dashboard step otherwise. Email Sending is in beta on the Workers Paid plan (checked 2026-09-11) | `VOIDBASE_MAIL_DOMAIN=example.com`; unset means no binding and mail goes where it went before |
| `AI` (Workers AI `ai` binding) | the `ai` plugin's chat: `POST /api/ai/chat` runs a tool-calling loop on the model the knob names, the tools being the MCP server's list for the caller, each call the instance's own route in process. Configuration only, nothing created on the account; Workers AI is metered per neuron, with a daily free allowance | `VOIDBASE_AI=1` or `VOIDBASE_AI=<model>`; unset means no binding and the route answers 503 |
| Smart Placement | the Worker runs next to its D1 database, or toward the database object | always on |

### Configuration and secrets: `pb_secrets/`

The app's configuration is declared once, in code, with Void's validators, and valued in each deploy's environment
(twelve-factor III): locally a git-ignored file, on Cloudflare the Worker's own secrets and vars. Every key states
who may read it, and the maintainer of the file answers for that: a key without a tier is refused.

```ts
// pb_secrets/main.ts                                   committed
import { defineSecrets, secret, server, browser, local, string, number, url } from "@voidbase-cloud/voidbase/secrets";

export default defineSecrets({
  SMTP_PASSWORD: secret(string(), "the mail provider's password"),
  ADMIN_EMAILS: server(string().default("")),
  MAX_UPLOAD_MB: server(number().default(10)),
  PUBLIC_SITE_URL: browser(url().optional()),
  VOIDBASE_DEPLOY_CF_API_KEY: local(string(), "the deploy token"),
  VOIDBASE_DEPLOY_NAME: local(string().default("my-app")),
});
```

```
pb_secrets/secrets.json    { "SMTP_PASSWORD": "...", "ADMIN_EMAILS": "me@example.com", "VOIDBASE_DEPLOY_CF_API_KEY": "..." }    git-ignored
```

With the deploy token and target declared as `local`, there is no `.env` file left: everything the app or the
tooling needs is either declared with a default or valued in `secrets.json` (this machine) and the build's
environment (CI).

The tier is the audience, and it decides where the value lives:

| tier | lives in | readable by |
| --- | --- | --- |
| `secret(...)` | the Worker's encrypted secrets | hooks and routes; never listed, never in a build |
| `server(...)` | the Worker's plain vars | hooks and routes; never in a client build |
| `browser(...)` | the Worker's vars and the client build (`import.meta.env.KEY`) | everyone, the browser included |
| `local(...)` | `secrets.json` on this machine, the build's environment in CI | voidbase's own tooling: the deploy token, the deploy target; never on the Worker, never in a build |

The validators are the ones a Void project's `env.ts` uses (`string()`, `number()`, `boolean()`, `url()`,
`email()`, `oneOf()`, `json()`, each with `.optional()` and `.default()`); their `.secret()` and `.public()` markers
count as the tier too. Any Standard Schema validator works inside the wrappers. A value is parsed through its validator wherever it is read, so a default is
filled in, a number is a number, and a bad or missing value stops the process with the key's name, never its value.
In hooks, `$os.getenv("NAME")` (the stored string); in TypeScript, `await definition.read((n) => $os.getenv(n))`
gives the typed values.

`voidbase init` writes an empty declaration and the `.gitignore` lines. `voidbase serve` parses `secrets.json` and
the shell and puts the result, defaults included, into the environment (the shell outranks the file, the file
outranks `.env`). `voidbase deploy` stores every server and public value as the Worker's vars on every deploy (a var
is the code's to set), stores the secrets the Worker does not have yet as its secrets, and refuses to deploy while a
value is invalid or a required one is missing everywhere. A secret the Worker already holds is left alone by a
deploy: a deploy ships code, and a checkout whose `secrets.json` carries dev values (another OAuth client, the
placeholder password) must not overwrite production by deploying. Replacing is explicit:

```bash
voidbase secrets              # each key: tier, local value or default, and for secrets whether the Worker has it
voidbase secrets push         # store the local secrets on the Worker (replacing), without redeploying
```

That is what makes CI simple: a checkout without `secrets.json` deploys with nothing but the deploy token, because
the secrets were pushed once from a machine that has them and the plain values come from the declared defaults or the
build's environment. The superuser follows the same rule: a checkout without credentials of its own keeps the
superuser the Worker has. A value in `secrets.json` that the declaration does not name is never deployed (the list
says so). `VOIDBASE_DEPLOY_VARS=A,B` and `VOIDBASE_DEPLOY_SECRETS=X,Y` still bake or store plain environment variables
for a deploy driven purely by the shell. Cloudflare's account-level Secrets Store is deliberately not used: one store
is shared by every Worker of the account, and its bindings are read asynchronously, which `$os.getenv` is not.

### The account's Secrets Store instead of the Worker's own secrets

A Worker's own secrets are stored once per Worker and seen by nothing else. Cloudflare's Secrets Store is the
account's: one place, role-based access, and a secret a Worker binds by name. Tell the deploy which store to use,
with `VOIDBASE_SECRETS_STORE=<store id>` in the environment (a build's variables) or in `pb_secrets/secrets.json`,
and it stores every declared `secret()` value there under `<worker>__<KEY>` (scoped to Workers), binds each as a
`secrets_store_secrets` binding of the same key, and retires the Worker's own secrets of those names, since a
binding name is one thing or the other. `voidbase secrets push` stores into it the same way, and `voidbase secrets`
says which names the store holds. Nothing in the app changes: a store binding's value is behind an async `get()`,
and voidbase resolves every such binding once per isolate, on its first request, cron tick or queue batch, before
anything reads `c.env`, `$os.getenv` or the env schema. The deploy token needs "Secrets Store: Write" and the
account's Secrets Store Deployer role; the free plan holds 100 secrets per store. Instances a control plane
provisions keep their own secrets: the knob is a deploy's, not the platform's.

### Workflows: durable, multi-step work

A `workflows/<name>.ts` module in a Void app (or a `workflows/<name>.js` beside a pb layout, its first line
`// voidbase:workflow <ClassName>`) whose default export extends `WorkflowEntrypoint` from `cloudflare:workers` is a
Cloudflare Workflow: the deploy exports the class from the Worker and binds it as `WORKFLOW_<NAME>`, and
`env.WORKFLOW_<NAME>.create({ id, params })` starts a run whose steps retry, sleep and wait for events without a
cron polling for them (`step.waitForEvent`; `instance.sendEvent` from a route). A step opens the app with
`withApp(env, fn)` from `@voidbase-cloud/voidbase/workflows`, so `pb.$app` works inside it the way it does in a
cron. voidbase.cloud's instance builds run this way: a workflow starts the builder's build, waits for it to report,
and fails the build with a reason when it never does.

### Feature flags, from Cloudflare Flagship

A boolean knob declared as `flag(boolean().default(false), "...")` in `pb_secrets/main.ts` is a feature flag: the
deploy makes sure the account has a Flagship app named after the Worker, creates every declared flag in it with
its default (an existing flag is left as the dashboard has it, so a change there wins without a deploy), binds the
app to the Worker as `FLAGS`, and bakes the defaults as vars (`VOIDBASE_FLAGS`). On every request, once who is
asking is known, voidbase evaluates the declared flags with a targeting key (the signed-in record, else the client's
address, so a percentage rollout is sticky per person) and writes the answers onto the request's env as strings,
so `c.env.KEY`, `$os.getenv(KEY)` and every reader of a boolean knob see the flag's value without knowing it is
one. Where Flagship is not reachable (Bun, or a deploy token without "Flagship: Write") the baked defaults answer
and the deploy says so. Booleans only, until variants are wanted.

### Presence: live cursors without a database

An instance can tell every connected client who is here now and where their cursor is, with no row written:

```
VOIDBASE_PRESENCE=1        off unless the instance asks for it: the endpoints are anonymous and public
VOIDBASE_PRESENCE_MAX=3    how many hold a slot at once (the newest arrivals; the oldest is evicted)
VOIDBASE_PRESENCE_TTL=12   seconds a slot survives without a beat
```

`POST /api/presence` with `{"op":"join"|"beat"|"leave", "id", "name", "color", "x", "y"}` updates the roster, and
every client subscribed to the `presence` topic (`pb.realtime.subscribe("presence", ...)`, the same call as a
collection) is sent the whole roster. `GET /api/presence` answers with it for a client that would rather poll.

The cost is bounded by construction: only the members holding a slot may beat, so the write path is
`VOIDBASE_PRESENCE_MAX` clients however many are watching; the roster lives in the instance's hub (the Durable
Object that already holds the SSE connections) and never in D1; and watchers pay one hibernatable socket each.
`VOIDBASE_PRESENCE=0` turns the whole thing off, which is the switch to pull if the fanout ever costs more than it
is worth: `GET /api/presence` then answers `{"enabled": false}` and a page can fall back to something canned.
voidbase.cloud's landing page does exactly that.

### The response policy: the headers every answer carries

The hardening plugin (`hardening@1`) sends PocketBase's headers on every response, errors and files included:
`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `X-Xss-Protection: 1; mode=block`,
`Cross-Origin-Opener-Policy: same-origin`, a strict `Content-Security-Policy` (`default-src 'none'; media-src
'self'; style-src 'unsafe-inline'; sandbox`) on a served file, and CORS at origin `*` with `Authorization` and
`Content-Type` allowed. That is what an instance sends with nothing set. Seven variables, read from the instance's
env like `VOIDBASE_PRESENCE`, change it:

```
VOIDBASE_CORS_ORIGINS=https://app.example,https://admin.example
                           only these origins get Access-Control-Allow-Origin (echoed, with Vary: Origin);
                           any other origin gets no CORS headers, and the CSRF rule below is on. Unset is *
VOIDBASE_HSTS=1            Strict-Transport-Security: max-age=31536000; includeSubDomains on https requests only;
                           a number instead of 1/true is the max-age in seconds
VOIDBASE_REFERRER_POLICY=strict-origin-when-cross-origin      sent as Referrer-Policy
VOIDBASE_PERMISSIONS_POLICY="camera=(), geolocation=()"        sent as Permissions-Policy
VOIDBASE_CSP="default-src 'self'"                              Content-Security-Policy on every non-file response
                           (a route that set its own, like the backups download, keeps it)
VOIDBASE_CSP_FILES="default-src 'none'; img-src 'self'"        replaces the strict policy on served files
VOIDBASE_CROSS_ORIGIN=1    adds Cross-Origin-Embedder-Policy: require-corp and Cross-Origin-Resource-Policy:
                           same-origin beside the Opener-Policy
```

The CSRF rule, and why naming the origins turns it on: origin `*` is safe while authentication is a bearer token,
because nothing a browser sends on its own carries one; a cookie is sent on its own, which is what a cookie-based
auth plugin would expose. So once `VOIDBASE_CORS_ORIGINS` is set, a state-changing request (`POST`, `PATCH`, `PUT`,
`DELETE`) that carries a `Cookie` header and whose `Origin` is neither the instance's own origin nor one of the named
ones is refused with 403 and a message naming `Origin` and `VOIDBASE_CORS_ORIGINS`; without an `Origin` header,
`Sec-Fetch-Site` decides (`same-origin` and `none` pass, `same-site` and `cross-site` are refused, naming
`Sec-Fetch-Site`); a request with neither header passes. A request without a cookie is never touched, so a
bearer-only client is never affected. Removing the hardening plugin removes the policy, CORS included; a company
with its own policy provides `hardening@1` from its own plugin (docs/plugins.md).

### Every instance is isolated

Two voidbase instances on one account never share a resource. Everything the deploy creates is named or derived from
the worker name: `<name>-db`, `<name>-storage`, `<name>-jobs`, the `<name>_requests` dataset, and the rate-limit
binding's `namespace_id` is hashed from the name, because Cloudflare shares counters between bindings that reuse an
id across Workers. The realtime hub is a Durable Object class exported from the instance's own Worker rather than a Worker shared
by apps. `test/deploy-cf.ts` asserts the naming.

## `voidbase sync`: the instance and its pipeline

`voidbase deploy` is one machine deploying. `voidbase sync` is the whole loop: it deploys (creating what does not
exist, updating what does), then connects the project's GitHub repository to Cloudflare Workers Builds, so that
from then on a push to the production branch deploys from Cloudflare; other branches build nowhere (the plainest
pipeline: one trigger, build then deploy, and nothing else).

It knows the two layouts by their directories' names. The **pb layout** is PocketBase's structure: `pb_hooks/`,
`pb_migrations/`, `pb_secrets/`, `pb_public/`, `pb_data/`; `voidbase init` makes one, and it deploys in place. The
**vb layout** is a Void app with the adapter: `routes/`, `vb_hooks/`, `vb_secrets/`, `vb_migrations/` at the root
(voidbase-site is one); `sync` builds it and deploys from the pb layout the build generates in `.voidbase/`. The
`vb_` directories are the `pb_` ones raised to the adapter's level, and every `vb_` becomes its `pb_` in the build.
A brand-new project is four steps:

1. Create a Cloudflare account and a GitHub account (a Cloudflare account alone runs the instance).
2. Fork or clone voidbase-site (or `voidbase init` in an empty directory) and push it to GitHub. Nothing is deployed
   by that push: the repository is not connected yet.
3. Fill in `pb_secrets/secrets.json` (a Void app: `vb_secrets/secrets.json`): the secrets, the deploy token
   `VOIDBASE_DEPLOY_CF_API_KEY` (`voidbase token` prints the link that creates it) and `CLOUDFLARE_BUILDS_TOKEN`, a
   *user* API token with "Workers Builds Configuration: Edit" and "Workers Scripts: Edit", both declared as
   `local()` keys. Run `voidbase sync`. It builds a Void app, deploys, stores the secrets on the Worker, and connects
   the repository. One step the API cannot do it asks of you the first time: in the dashboard page it prints,
   connect the repository, which installs the Cloudflare Workers and Pages GitHub App for it and creates the build
   token. Run `voidbase sync` again and the two triggers are in place. Their commands are the project's own verbs
   when it has them, `bun run build` then `bun run deploy` on the production branch and `bun run version` on every
   other, so what the dashboard shows is three words and the project decides what they mean by reading the
   environment (see [ci.md](ci.md#the-three-commands)). A project without those scripts gets commands that say the
   whole thing: the build, then `bunx voidbase sync`, which in a build is the deploy alone (no secrets.json there,
   the Worker keeps its secrets, the build's environment carries the deploy token and the declared server values).
4. Push. Cloudflare builds, and the instance stays in step with the repository.

`--dry-run` prints the plan; `--no-ci` deploys only; `--repo owner/name` and `--branch` override what git says;
`--previews` adds the second trigger, every other branch deploying a preview instance (above, "A preview per pull
request"), and `--no-previews` removes it.

**One trigger per instance.** A Cloudflare build may only deploy the Worker its trigger belongs to, so a repository
that holds two instances (a site and a demo, say) gets a trigger for each, both watching the same branch. `sync`
creates the one for the project it is run in, and its commands step into that project's directory
(`cd demo && bunx voidbase sync --name …`), so the repository's lockfile is still what the build installs from.

**A project is not deployed onto another project's Worker.** When `pb_secrets/main.ts` declares its own
`VOIDBASE_DEPLOY_NAME` and the environment carries a different one, the deploy refuses and says both names: a
repository whose CI deploys more than one instance (a site and its demo, say) would otherwise put the second one on
the first one's Worker, over whatever lives there. Give each instance its target on the command line
(`voidbase sync --name … --domain …`) or clear the ambient variables for that deploy; `--name` also says the
override is deliberate.
A project whose builds are started from GitHub instead (this repository's own CI) keeps its watch paths: `sync`
never switches an existing trigger between the two.

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
(`cloudflare` OAuth2 provider, see `voidbase-site/cloud`) or an API token with the same permissions.
`test/cloud-rest.ts` exercises it against `test/cf-mock.ts`. The hub and the queue are decided when the release
is bundled (`voidbase bundle --no-hub` / `--no-queue`), not per instance: an instance can leave them out at
provisioning, but cannot add what the release does not carry. Tokens a control plane keeps go to rest sealed
with `VOIDBASE_ENCRYPTION_KEY` (`sealSecret` / `openSecret` from `voidbase/cloud`).

## After deploying

1. Open `/_/`, log in with the bootstrap superuser, change the password.
2. Settings > Application: set the application URL (used in emails) and, if you terminate TLS elsewhere,
   the trusted proxy header. On Workers the client IP already comes from `CF-Connecting-IP`.
3. Settings > Mail server: SMTP on port 465 or 587 (25 is blocked on Workers); send the test email.
4. Settings > Backups: set a cron to write zips to R2 (`__backups__/`); `VOIDBASE_BACKUP_KIND`, `VOIDBASE_BACKUP_KEEP` and
   `VOIDBASE_BACKUP_S3_*` shape what it writes, keeps and copies off-site (docs/plugins.md).
5. Point your app at the Worker URL. The `pocketbase` JS SDK needs no other change.

## The instance on Cloudflare's local runtime: `voidbase serve --workers`

```bash
voidbase serve --workers                    # --http 127.0.0.1:8090, --name, --no-queue, --no-hub, --database durable as for deploy; also: voidbase dev --workers
```

`voidbase serve` runs the instance on Bun. `--workers` runs it on workerd, Cloudflare's runtime, so what you exercise
on your machine is the Workers code, with the same bindings the deploy wires up. It generates the very project
`voidbase deploy` would upload (`.cloud/<name>/`, through the deploy's own generation with a `local` option that stops
before anything reaches Cloudflare: no token, no account, no resource created, no upload; `wrangler.jsonc` carries
local ids) and runs it with Void's dev server (`vp dev`), which is what the generated project supports and what needs
no login: it bundles the Worker on the fly, reads the generated `wrangler.jsonc` for the hub binding, and runs D1, R2,
the jobs queue (batches delivered natively) and the realtime hub Durable Object in Miniflare, persisted under
`.cloud/<name>/.void/`, which the banner names. Void applies `db/migrations` to that D1 when the server starts, with the
same runner its deploy uses, and the superuser is seeded on the first request from `VOIDBASE_SUPERUSER_EMAIL` /
`VOIDBASE_SUPERUSER_PASSWORD` (or `pb_data/.superuser-credentials`, written when nothing is set), carried by the
project's git-ignored `.env` instead of Worker secrets; declared `pb_secrets/` values ride the same way, and a deploy
rewrites that file without them. The first workerd start takes half a minute or so. Cron triggers do not tick locally
(maintenance runs lazily in requests; Void prints the `curl` that fires a trigger by hand), Flagship and the
Secrets Store are out of reach (declared flags keep their baked defaults), and without network the panel is skipped
with a message while the API still runs. `test/workers-local.ts` boots a temporary project this way and checks the
API, with a dead Cloudflare API base to prove nothing was called. `--database durable` (or `VOIDBASE_DATABASE=durable`)
runs it with the database Durable Object instead of Miniflare's D1, as the deploy's knob does; `test/workers-durable.ts`
boots a project that way and proves the transaction, the ceilings, a backup and restore and realtime on workerd
(docs/platform.md, "The database as a Durable Object"). `vp preview` below stays the rehearsal of the production
build itself.

## Local preview of the production build

```bash
VOIDBASE_PERSIST_TO=.void-preview bun run build && vp preview --port 5181
```

`vp preview` runs the built Worker in workerd with the same module-scope restrictions as production, which is
how `test/fresh-db.ts` catches code that only works in dev.
