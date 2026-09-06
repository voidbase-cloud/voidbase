# CI and release: one flow, Cloudflare runs it

`scripts/ci.sh` is the whole CI and `scripts/release.sh` the whole release flow. Both run the same way on a dev
machine and on Cloudflare Workers Builds; GitHub Actions only starts the builds (`.github/workflows/cloudflare.yml`).
Every step is recorded (`scripts/ci-lib.sh`) and `scripts/ci-status.ts` renders the record into `ci/public`:
`index.html`, `status.json`, `badge.svg`, the suite logs and the screenshots. That directory is the status Worker a
build deploys.

## The CI steps (`scripts/ci.sh`)

| step | what |
| --- | --- |
| install | `bun install --frozen-lockfile` |
| commitlint | the commits the push or pull request introduces (`--last` when there is nothing to compare with) |
| oracles | the starter (`scripts/ci-oracles.sh`: `STARTER_DIR`, else the sibling checkout, else a shallow clone in the cache), the panel (`panel:sync`), the starter's frontend build next to it (`app:sync`), `void prepare` |
| plan | `scripts/ci-plan.ts`: which of the following steps and suites this run needs (below) |
| typecheck, unit | `tsc --noEmit`, `bun test` |
| browser | a Chrome for the panel and starter suites (`scripts/ci-browser.sh`, below); `CI_BROWSER=0` skips them |
| boot | the run's `.env`, `void db migrate`, the dev server on 5180 (`CI_PORT`), the app user |
| reference | PocketBase 0.39.11 on 8090 (`CI_PB_PORT`) seeded from the starter, the SMTP sink, the OIDC, S3 and Cloudflare API mocks; whatever already listens on a port is reused |
| suites | `scripts/ci-suites.sh`: every differential suite, the SDK suite, the panel suites |
| suites-bun | the same suites against `voidbase serve` on 8093 (Bun, SQLite, local files), without the browser suites |
| deploy-cf, fresh-db, mail-http, exe-smoke | the deploy dry run against the API mock, the fresh-database boot and the HTTP mail transport of the production build, the prebuilt executable and its update flow |
| starter | the unmodified starter frontend against voidbase |

The script stops at the first failed step, prints the relevant logs, renders the status page and stops the servers
it started; a dev machine's `.env` is put back. Steps the plan does not select are recorded as skipped with the reason. Ports, oracles and Chrome come from the environment, so a dev machine
runs the same flow with `bun run ci`.

## Incremental runs (`scripts/ci-plan.ts`)

A full run takes about ten minutes on the build image, three quarters of it the two suite passes, so a run only
repeats what its changes can affect. Every step and every suite lists the areas of the repository it depends on
(`deps`, `harness`, `config`, `server`, `node`, `cloud`, `mocks`, one area per test entry point, and so on; `bun
scripts/ci-plan.ts explain` prints them with their hashes). An area's hash comes from the git blob ids of its files,
so it is exact and costs nothing; the combined hash of a key's inputs is compared with the one recorded by the last
green run, and the key runs only when they differ. The record is the deployed status page of master
(`CI_STATUS_URL`, the CI Worker's `status.json`, whose `verified` map holds the hash each step and suite last
passed on); on a dev machine it is `ci/public/status.json` from the previous run. What passed gets this run's
hashes, what was skipped keeps the previous record's, so a chain of partial runs stays sound. The oracle sync, the
servers, the reference and Chrome happen only when a selected step needs them.

| change | what runs |
| --- | --- |
| docs, README, surface, `ci/`, `.github/` | commit messages and the plan: about half a minute |
| one suite's file | that suite on both runtimes, with the servers it needs |
| `src/node` (CLI, deploy, executables) | typecheck, unit, the deploy dry run, the executable smoke, the Bun pass |
| `src/server`, `routes`, the app config, the harness | everything |

Uncommitted changes never match a record, so a dirty working tree reruns what it touches. `CI_PLAN=full` (or the
`--full` flag) runs everything regardless; the same happens when the record cannot be fetched. Only the repository's
own files are hashed: a new commit of the starter oracle is picked up by the next full run.

## What is kept between runs

`CI_CACHE_DIR` holds the downloads: Playwright's headless shell and the unpacked libraries, the apt lists and packages,
the starter clone with its `node_modules` and its frontend build (reused while the starter's commit is the same), the
panel tarball (through `XDG_CACHE_HOME`) and the PocketBase archive of the reference. On a dev machine it is
`~/.cache/voidbase-ci` and simply stays there. Workers Builds keeps nothing between builds but the package manager's
cache, and that one only until the lockfile changes, so on Cloudflare `scripts/ci-cache.sh` restores the directory from
an R2 bucket at the start of a build and saves it at the end, one archive per component, uploaded only when its content
changed. `setup` creates the bucket (`voidbase-ci-cache`) when `CI_CACHE_TOKEN` is in the environment (an API token with
Workers R2 Storage edit; the deploy token of the site is accepted) and stores it on every trigger as a build secret,
with `CI_CACHE_ACCOUNT` and `CI_CACHE_BUCKET`. Without those the builds fetch everything each time, about forty
seconds of a full run.

## Chrome (`scripts/ci-browser.sh`)

The browser suites launch whatever `CHROME_PATH` points at, else the Chrome on the PATH (a dev machine). Where there
is no Chrome, the script downloads Playwright's chromium-headless-shell under `.void/browsers` and, when the machine also
lacks the shared libraries Chrome needs, unpacks them from Ubuntu's packages into `.void/chrome-libs` without root (a
private apt root, `dpkg-deb -x`, `LD_LIBRARY_PATH`): the Workers Builds image has neither Chrome nor sudo nor those
libraries. The unpacking path is exercised on a dev machine with `CI_BROWSER_DOWNLOAD=1 CI_BROWSER_LIBS=always`.

## GitHub Actions only starts builds

`.github/workflows/cloudflare.yml` is the only workflow. It never runs the flows: it asks Cloudflare Workers Builds
for a build of the commit at hand through the Builds API (a few seconds of Actions time) and exits.

| event | build started |
| --- | --- |
| push to master | `voidbase-ci` (master trigger) and `voidbase-release` (master trigger) |
| pull request from a branch of this repository | `voidbase-ci` (branches trigger: a preview URL of the results) |
| release published | `voidbase-release` (master trigger) for the tagged commit |
| Actions > cloudflare > Run workflow | the chosen project: `ci`, `release` or `release-dry-run` |

The job is skipped until the repository variables exist (`CF_ACCOUNT_ID`, `CF_CI_TRIGGER_MASTER`,
`CF_CI_TRIGGER_BRANCHES`, `CF_RELEASE_TRIGGER_MASTER`, `CF_RELEASE_TRIGGER_DRY_RUN`) together with the secret
`CLOUDFLARE_BUILDS_TOKEN`; `bun scripts/cf-builds.ts setup --github` stores all six. With the repository variable
`CF_BUILDS_WAIT=1` the job also waits for the builds it started and fails when one fails, so the pull request check
reflects the result; without it the check only means "started", and the result lives in the dashboard, in
`cf-builds.ts logs`, and on the status page. Pushes never build on their own: every trigger's watch paths exclude every
path, and the API is not subject to them. Standard GitHub-hosted runners are free for public repositories anyway; the
trigger job spends seconds.

Two things stop existing with this layout because they need the OIDC token only a GitHub Actions run can mint:
`npm publish --provenance` and the build attestations of the release archives. Releases carry checksums only.

## Cloudflare Workers Builds

[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) is Cloudflare's build system for Workers: the
"Cloudflare Workers and Pages" GitHub App starts a build on every push to a connected repository, runs a build command
and a deploy command in Cloudflare's build image, and posts a check run (and a preview URL on pull requests) back to
GitHub. Two projects run voidbase's flows there, each a Worker whose deploy publishes the status page of the build
(`ci/wrangler.jsonc`, assets only):

| project | trigger | build command | deploy command |
| --- | --- | --- | --- |
| `voidbase-ci` | master | `bash scripts/ci.sh` | `wrangler deploy -c ci/wrangler.jsonc` |
| `voidbase-ci` | branches | `bash scripts/ci.sh` | `wrangler versions upload -c ci/wrangler.jsonc`: a preview URL of the results on the pull request |
| `voidbase-release` | master | `bash scripts/release.sh` | `wrangler deploy -c ci/wrangler.jsonc` |
| `voidbase-release` | dry run | `bash scripts/release.sh --dry-run` | `wrangler versions upload -c ci/wrangler.jsonc` |

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
3. `GH_TOKEN=... NPM_TOKEN=... bun scripts/cf-builds.ts setup --github` connects the repository, creates the two
   Workers and the four triggers with push builds off, sets `BUN_VERSION`, stores the release secrets it finds in the
   environment on the release triggers, and writes the workflow's variables and secret into the GitHub repository
   (`gh variable set`, `gh secret set`). The release secrets: `GH_TOKEN` (a fine-grained PAT with contents and pull requests write on the repository, for release-please
   and the release assets), `NPM_TOKEN` (the npm granular token), optionally `GH_PACKAGES_TOKEN` (a classic PAT with
   `write:packages`; fine-grained tokens cannot publish packages, and without it the GitHub Packages copy is skipped).
   The first run stops when the account has no build token yet: open the `voidbase-ci` Worker in the dashboard,
   Settings > Builds > API token > Create new token, and run setup again.
4. `bun scripts/cf-builds.ts build --branch master --follow` runs the first build and streams its log; `status`,
   `builds`, `logs <uuid>`, `cancel <uuid>` and `env` cover the rest (the header of the script lists them).
5. From then on every push and pull request goes through the workflow. `gh variable set CF_BUILDS_WAIT --body 1`
   makes the workflow wait for the builds it started.

`test/cf-builds.ts` runs the CLI against `test/cf-mock.ts`, whose Builds endpoints follow the request and response
shapes of Cloudflare's API reference; the live API is exercised the first time the App and the user token exist.

### What to expect

- No provenance and no attestations (OIDC): `npm publish` runs without `--provenance`, the release archives carry
  checksums only.
- GitHub Packages only with `GH_PACKAGES_TOKEN`.
- Logs live in the dashboard and in `cf-builds.ts logs`; the deployed page is the last build that ran to the end.
- release-please and the release assets use `GH_TOKEN`, a PAT, so a release it creates fires the `release` event and
  the workflow starts one more release build for the tagged commit, which finds everything published and stops.

## The status page

`ci/public/index.html` lists the steps with their durations and logs, every suite with its result and last line, the
screenshots of the panel and starter suites, and links `status.json` (the same, as data) and `badge.svg`
(`ci: passing`). Once `voidbase-ci` is deployed, `https://voidbase-ci.<subdomain>.workers.dev/badge.svg` is the badge
for the README and `status.json` the feed for anything else; a pull request's build uploads a version, so its preview
URL shows the same page for that commit.
