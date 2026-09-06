# CI and release: one flow, two backends

`scripts/ci.sh` is the whole CI and `scripts/release.sh` the whole release flow. Both run the same way on a dev
machine, on GitHub Actions and on Cloudflare Workers Builds; the workflows in `.github/workflows` and the Workers
Builds projects only call them. Every step is recorded (`scripts/ci-lib.sh`) and `scripts/ci-status.ts` renders the
record into `ci/public`: `index.html`, `status.json`, `badge.svg`, the suite logs and the screenshots. GitHub Actions
keeps that directory as the `ci-status` artifact of a run; on Cloudflare it is the status Worker the build deploys.

## The CI steps (`scripts/ci.sh`)

| step | what |
| --- | --- |
| install | `bun install --frozen-lockfile` |
| commitlint | the commits the push or pull request introduces (`--last` when there is nothing to compare with) |
| oracles | the starter (`scripts/ci-oracles.sh`: `STARTER_DIR`, else the sibling checkout, else a shallow clone under `.void/oracles`), the panel (`panel:sync`), the starter's frontend build next to it (`app:sync`), `void prepare` |
| typecheck, unit | `tsc --noEmit`, `bun test` |
| browser | a Chrome for the panel and starter suites (`scripts/ci-browser.sh`, below); `CI_BROWSER=0` skips them |
| boot | the run's `.env`, `void db migrate`, the dev server on 5180 (`CI_PORT`), the app user |
| reference | PocketBase 0.39.11 on 8090 (`CI_PB_PORT`) seeded from the starter, the SMTP sink, the OIDC, S3 and Cloudflare API mocks; whatever already listens on a port is reused |
| suites | `scripts/ci-suites.sh`: every differential suite, the SDK suite, the panel suites |
| suites-bun | the same suites against `voidbase serve` on 8093 (Bun, SQLite, local files), without the browser suites |
| deploy-cf, fresh-db, mail-http, exe-smoke | the deploy dry run against the API mock, the fresh-database boot and the HTTP mail transport of the production build, the prebuilt executable and its update flow |
| starter | the unmodified starter frontend against voidbase |

The script stops at the first failed step, prints the relevant logs, renders the status page and stops the servers
it started; a dev machine's `.env` is put back. Ports, oracles and Chrome come from the environment, so a dev machine
runs the same flow with `bun run ci`.

## Chrome (`scripts/ci-browser.sh`)

The browser suites launch whatever `CHROME_PATH` points at (GitHub's runners: `/usr/bin/google-chrome`). Where there is
no Chrome, the script downloads Playwright's chromium-headless-shell under `.void/browsers` and, when the machine also
lacks the shared libraries Chrome needs, unpacks them from Ubuntu's packages into `.void/chrome-libs` without root (a
private apt root, `dpkg-deb -x`, `LD_LIBRARY_PATH`): the Workers Builds image has neither Chrome nor sudo nor those
libraries. The unpacking path is exercised on a dev machine with `CI_BROWSER_DOWNLOAD=1 CI_BROWSER_LIBS=always`.

## GitHub Actions (the default)

`ci.yml` runs `scripts/ci.sh` on pushes to master and on pull requests; `release.yml` runs `scripts/release.sh` on
pushes to master, on releases published by hand and as a dry run from Actions > release > Run workflow. Standard
GitHub-hosted runners are free for public repositories, which both repositories of the organization are; a private
repository gets 2,000 minutes a month on the Free plan and pays $0.008 per Linux minute after that. A CI run takes
about 7.5 minutes on the 4-vCPU runner, a release run about 2 minutes.

Two things exist only there, because they need the OIDC token GitHub Actions mints for a workflow run: `npm publish
--provenance` and the `actions/attest-build-provenance` attestation of the release archives.

## Cloudflare Workers Builds

[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) is Cloudflare's build system for Workers: the
"Cloudflare Workers and Pages" GitHub App starts a build on every push to a connected repository, runs a build command
and a deploy command in Cloudflare's build image, and posts a check run (and a preview URL on pull requests) back to
GitHub. Two projects run voidbase's flows there, each a Worker whose deploy publishes the status page of the build
(`ci/wrangler.jsonc`, assets only):

| project | trigger | build command | deploy command |
| --- | --- | --- | --- |
| `voidbase-ci` | master | `bun run ci` | `wrangler deploy -c ci/wrangler.jsonc` |
| `voidbase-ci` | every other branch | `bun run ci` | `wrangler versions upload -c ci/wrangler.jsonc`: a preview URL of the results on the pull request |
| `voidbase-release` | master | `bun run release` | `wrangler deploy -c ci/wrangler.jsonc` |

A failed build command means no deploy, so the status Worker shows the last build that ran to the end; the log of a
failed build is in the dashboard and in `cf-builds.ts logs`. `voidbase-release` builds on every push to master and
is done in about a minute when there is nothing to release (release-please only refreshes the release PR).

### Limits and cost

| | Free plan | Paid plan |
| --- | --- | --- |
| build minutes | 3,000 a month | 6,000 a month, then $0.005 a minute |
| concurrent builds | 1 | 6 |
| build timeout | 20 minutes | 20 minutes |
| CPU, memory | 2 vCPU, 8 GB | 4 vCPU, 8 GB |

The image is Ubuntu 24.04 x86_64 with Node 22, Bun 1.2.15 (the projects set `BUN_VERSION=1.3.14`, the version the
workflows pin), git, curl, unzip and build-essential; no Chrome, no lsof, no jq, no gh. The scripts need none of them:
`scripts/gh-release.ts` talks to GitHub's API directly. The 20-minute timeout is the constraint to watch: the CI run
takes 7.5 minutes on GitHub's 4 vCPU and gets 2 on the Free plan, and the two projects build one after the other there.

### Setup, once

1. Install the [Cloudflare Workers and Pages GitHub App](https://github.com/apps/cloudflare-workers-and-pages) for
   `voidbase-cloud/voidbase` (an organization owner does this on GitHub; limit it to that repository).
2. Create a user API token at dash.cloudflare.com/profile/api-tokens with **Workers Builds Configuration: Edit** and
   **Workers Scripts: Edit**, and export it as `CLOUDFLARE_BUILDS_TOKEN`. The Builds API takes user tokens only; the
   account-owned token `voidbase deploy` uses is rejected.
3. `GH_TOKEN=... NPM_TOKEN=... bun scripts/cf-builds.ts setup` connects the repository, creates the two Workers and
   the three triggers, sets `BUN_VERSION`, and stores the release secrets it finds in the environment on the release
   trigger: `GH_TOKEN` (a fine-grained PAT with contents and pull requests write on the repository, for release-please
   and the release assets), `NPM_TOKEN` (the npm granular token), optionally `GH_PACKAGES_TOKEN` (a classic PAT with
   `write:packages`; fine-grained tokens cannot publish packages, and without it the GitHub Packages copy is skipped).
   The first run stops when the account has no build token yet: open the `voidbase-ci` Worker in the dashboard,
   Settings > Builds > API token > Create new token, and run setup again.
4. `bun scripts/cf-builds.ts build --branch master --follow` runs the first build and streams its log; `status`,
   `builds`, `logs <uuid>`, `cancel <uuid>` and `env` cover the rest (the header of the script lists them).
5. Turn GitHub's runs off: `gh variable set CI_BACKEND --body cloudflare --repo voidbase-cloud/voidbase`. Both
   workflows skip their jobs while the variable is `cloudflare`; delete it to run on GitHub again. GitHub Actions is
   not needed as a trigger: the App starts the builds and the check runs come from Cloudflare. A deploy hook or
   `cf-builds.ts build --commit <sha>` can start a build from anywhere, a tiny workflow included, but with the App
   connected that would build every push twice.

`test/cf-builds.ts` runs the CLI against `test/cf-mock.ts`, whose Builds endpoints follow the request and response
shapes of Cloudflare's API reference; the live API is exercised the first time the App and the user token exist.

### What differs from a GitHub run

- No provenance and no attestations (OIDC): `npm publish` runs without `--provenance`, the release archives carry
  checksums only.
- GitHub Packages only with `GH_PACKAGES_TOKEN`.
- Logs live in the dashboard and in `cf-builds.ts logs`; the deployed page is the last build that ran to the end.
- release-please and the release assets use `GH_TOKEN`, a PAT, so the releases it creates do trigger GitHub workflows;
  with `CI_BACKEND=cloudflare` those skip their jobs.

## The status page

`ci/public/index.html` lists the steps with their durations and logs, every suite with its result and last line, the
screenshots of the panel and starter suites, and links `status.json` (the same, as data) and `badge.svg`
(`ci: passing`). Once `voidbase-ci` is deployed, `https://voidbase-ci.<subdomain>.workers.dev/badge.svg` is the badge
for the README and `status.json` the feed for anything else.
