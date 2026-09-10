# CI and release: one flow, Cloudflare runs it

`scripts/ci.sh` is the whole CI, and its last step runs `scripts/release.sh`, the whole release flow, when the
commits call for it. Both run the same way on a dev machine and on Cloudflare Workers Builds, which builds every
push through the repository's connection; there are no GitHub Actions.
Every step is recorded (`scripts/ci-lib.sh`) and `scripts/ci-status.ts` renders the record into `ci/public`:
`index.html`, `status.json`, `badge.svg`, the suite logs and the screenshots. That directory is the status Worker a
build deploys.

## The CI steps (`scripts/ci.sh`)

| step | what |
| --- | --- |
| install | `bun install --frozen-lockfile` |
| commitlint | the commits the push or pull request introduces (`--last` when there is nothing to compare with) |
| oracles | the starter (`scripts/ci-oracles.sh`: `STARTER_DIR`, else the sibling checkout, else a shallow clone in the cache), the panel (`panel:sync`), the starter's frontend build next to it (`app:sync`), `void prepare` |
| plan | `scripts/ci-plan.ts`: which of the following steps and suites this run needs (below); hot mode trims the list to a time budget |
| typecheck, unit | `tsc --noEmit`, `bun test` |
| browser | a Chrome for the panel and starter suites (`scripts/ci-browser.sh`, below); `CI_BROWSER=0` skips them |
| boot | the run's `.env`, `void db migrate`, the dev server on 5180 (`CI_PORT`), the app user |
| reference | PocketBase 0.39.11 on 8090 (`CI_PB_PORT`) freshly seeded from the starter (again before the Bun pass: the reference keeps state the suites cannot undo, such as a stored S3 secret), the SMTP sink, the OIDC, S3 and Cloudflare API mocks, awaited before a first mail warms the SMTP transport; whatever already listens on a port is reused |
| suites | `scripts/ci-suites.sh`: every differential suite, the SDK suite, the panel suites |
| suites-bun | the same suites against `voidbase serve` on 8093 (Bun, SQLite, local files), without the browser suites |
| deploy-cf, adapter, fresh-db, mail-http, exe-smoke | the deploy dry run against the API mock, a Void app converted and run through the adapter, the fresh-database boot and the HTTP mail transport of the production build, the prebuilt executable and its update flow |
| starter | the unmodified starter frontend against voidbase |
| release | on master, with `GH_TOKEN`: the release flow (docs/releasing.md) when a releasable commit was pushed, the release PR was merged, a `Release: dry-run` trailer asks for a rehearsal, or a release still needs npm or its executables |

The script stops at the first failed step, prints the relevant logs, renders the status page and stops the servers
it started; a dev machine's `.env` is put back. Steps the plan does not select are recorded as skipped with the reason. Ports, oracles and Chrome come from the environment, so a dev machine
runs the same flow with `bun run ci`.

## Incremental runs (`scripts/ci-plan.ts`)

A full run takes about nine minutes on the build image, most of it the two suite passes, so a run only repeats the
checks its changes reach. Every check has a set of files: the import closure of its test entry point plus the runtime
it exercises, resolved through the same import graph (`#platform/*` follows the `workerd` condition for the Workers
server and the default one for the Bun runtime), so `src/node/deploy-cf.ts` reaches the deploy dry run, the
executable smoke, typecheck and the unit tests and nothing else, while a file of the server reaches every suite on
both runtimes. File hashes come from git blob ids, so they are exact and cost nothing; the combined hash of a check's
files is compared with the one the last green run recorded, and the check runs only when they differ. The record is
the deployed status page of master (`CI_STATUS_URL`, https://release.voidbase.cloud/status.json, whose `verified`
map holds the hash each check last passed on); on a dev machine it is `ci/public/status.json` from the previous run. What passed
gets this run's hashes, what was skipped keeps the previous record's, so a chain of partial runs stays sound. The
oracle sync, the servers, the reference and Chrome happen only when a selected check needs them.

| change | what runs |
| --- | --- |
| docs, README, surface, `ci/` | commit messages and the plan: about half a minute |
| one suite's file | that suite on both runtimes, with the servers it needs |
| `src/node/deploy-cf.ts`, `src/cloud` | typecheck, unit, the deploy dry run, the executable smoke, cloud-rest: under two minutes |
| `src/node/serve.ts`, `bin/voidbase.ts` | the Bun pass and the executable smoke |
| `src/server`, `routes`, the app config, the harness | everything |

`bun scripts/ci-plan.ts affected <file>` prints the checks a file reaches; `explain` prints every check with its
file count and hash. Uncommitted changes never match a record, so a dirty working tree reruns what it touches.
`CI_PLAN=full` (or `--full`) runs everything regardless, and so does a commit whose message carries `Tests: all`; the
same happens when the record cannot be fetched. Only the repository's own files are hashed: a new commit of the
starter oracle is picked up by the next full run.

## Hot mode

The suites test the server as a black box, so a server change reaches all of them and a full run is the honest
answer. During a development phase that is too slow, so hot mode keeps every run within a time budget:
`bun scripts/cf-builds.ts hot on` (`--budget 60` to change the default of sixty seconds; `hot off` to return to
full runs). With hot mode on, a run does typecheck and the unit tests always, then whatever the commits name, then
the suites of the commits' scopes, then the cheapest of the remaining selected checks until the budget is spent,
using the durations the last run recorded (`status.json`, `suites[].seconds`). The Bun pass, the browser suites and
the starter smoke wait for a normal run. Deferred checks are listed on the status page and are never marked verified,
so the first run after `hot off` does them all. Releasing in hot mode publishes to npm only, so voidbase-site can
pick the version up at once; the executables of that release are built by the first normal run on master.

The commits steer it: a Conventional Commit scope (`fix(records): ...`) puts that area's suites first
(`SCOPE_KEYS` in the planner maps every scope of `commitlint.config.js` to suites), a `Tests:` trailer names checks
that are never deferred (`Tests: thumbs s3`, `Tests: bun` for the Bun pass, `Tests: browser`), and `Tests: all`
forces a full run. A commit that edits a suite's file always runs that suite. The messages of every commit since the
last green run count, not only the last one: a Cloudflare build checks out a single commit, so the planner deepens
the history until the last green run's commit is reachable before it reads them.

## The three commands

Cloudflare Workers Builds calls three commands, and both projects answer with the same three words:

```
Build command     bun run build
Deploy command    bun run deploy
Version command   bun run version      (a preview upload, by hand: no trigger runs it)
Root directory    /
```

Nothing in the dashboard says what they mean. `scripts/pipeline.ts` reads that from the environment
(`scripts/environment.ts`), as granular controls rather than a named environment, which is what twelve-factor asks
for: `WORKERS_CI` / `WORKERS_CI_BUILD_UUID` say a Cloudflare build is running this, `WORKERS_CI_BRANCH` says which
branch, `PRODUCTION_BRANCH` (default `master`) says which branch is production, and `WRANGLER_CI_OVERRIDE_NAME`
says which Worker that build may deploy. A deploy off the production branch says there is nothing to do rather than
taking production's place, and every run prints what it read.

Here `build` runs this suite when automation calls it and this project's own Vite build when a person does;
`deploy` publishes the status page; `version` uploads it as a version. voidbase.cloud answers the same three words
with its own meanings (build the site and typecheck it, deploy the instance, read back the configuration a branch
would deploy with). `voidbase sync` writes these three into the triggers it creates whenever the project has the
scripts, so a project set up from the CLI and one set up by hand in the dashboard end up saying the same thing.

**One change, one build.** Cloudflare builds every push, so the count is decided by the triggers' branch filters.
Only master has a trigger, so release-please's own branch (a changelog, a version and a manifest generated from
commits the master build has already run) builds nowhere. A release is the master build that merged its pull request:
in hot mode that build publishes to npm and moves the testbeds; with hot mode off it also builds the release's
executables. So a push to master is one build, a pull request is none until it merges (a push to master), and a release is one.

None of the three verbs supervises the commands it runs: no deadline, no retry, no watchdog. A build that hangs or
fails is the build platform's to cut short and to run again -- Cloudflare has a twenty minute limit and a retry
button -- and keeping that logic out of the scripts is what makes them read as a build path rather than a supervisor.

## What is kept between runs

`CI_CACHE_DIR` holds the downloads: Playwright's headless shell and the unpacked libraries, the Ubuntu packages,
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

## Every push builds

The "Cloudflare Workers and Pages" GitHub App tells Cloudflare about every push to the connected repository, and the
triggers decide what runs:

| event | build |
| --- | --- |
| push to master | the master trigger; the release step of the build then refreshes the release PR for releasable commits, or publishes a merged release PR and moves the testbeds onto it |
| push to any other branch | nothing: only master has a trigger |
| `bun scripts/cf-builds.ts build --branch <b>` or the dashboard's retry | the same, started by hand |

Nothing runs on GitHub's side: no Actions, no Actions secrets, no variables. The check run Cloudflare posts back
is the pull request's status, and the result lives in the dashboard, in `cf-builds.ts logs`, and on the status page.

Two things do not exist with this layout because they need the OIDC token only a GitHub Actions run can mint:
`npm publish --provenance` and the build attestations of the release archives. Releases carry checksums only.

## Cloudflare Workers Builds

[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) is Cloudflare's build system for Workers: the
"Cloudflare Workers and Pages" GitHub App starts a build on every push to a connected repository, runs a build command
and a deploy command in Cloudflare's build image, and posts a check run (and a preview URL on pull requests) back to
GitHub. One project, `voidbase-ci`, runs voidbase's flows there: a Worker whose deploy publishes the status page of
the build (`ci/wrangler.jsonc`, assets only). A trigger has one build command and one deploy command, and a Worker
has two triggers at most (the API answers 12030 to a third), which is why the release flow runs inside the CI build
rather than as a project of its own; the second slot stays free:

| trigger | build command | deploy command |
| --- | --- | --- |
| master | `bun run build` (the CI suite) | `bun run deploy` (`wrangler deploy -c ci/wrangler.jsonc`) |



A failed build command means no deploy, so the status Worker shows the last build that ran to the end; the log of a
failed build is in the dashboard and in `cf-builds.ts logs`. The release secrets (`GH_TOKEN`, `NPM_TOKEN`, optionally
`GH_PACKAGES_TOKEN`) are build secrets of the master trigger.

### Limits and cost

| | Free plan | Paid plan |
| --- | --- | --- |
| build minutes | 3,000 a month | 6,000 a month, then $0.005 a minute |
| concurrent builds | 1 | 6 |
| build timeout | 20 minutes | 20 minutes |
| CPU, memory | 2 vCPU, 8 GB | 4 vCPU, 8 GB |

The image is Ubuntu 24.04 x86_64 with Node 22, Bun 1.2.15 (the projects set `BUN_VERSION=1.3.14`, the version setup
pins), git, curl, unzip and build-essential; no Chrome, no lsof, no jq, no gh. The scripts need none of them:
`scripts/gh-release.ts` talks to GitHub's API directly. The 20-minute timeout and the one concurrent build of the
Free plan are the constraints to watch: a full CI run takes about nine minutes on 2 vCPU, and every project of the
account (the CI, the site, the demo, the marketplace, the instance builds) waits in the same queue.

### Setup, once

1. Install the [Cloudflare Workers and Pages GitHub App](https://github.com/apps/cloudflare-workers-and-pages) for
   `voidbase-cloud/voidbase` (an organization owner does this on GitHub; limit it to that repository).
2. Create a user API token at dash.cloudflare.com/profile/api-tokens with **Workers Builds Configuration: Edit** and
   **Workers Scripts: Edit**, and export it as `CLOUDFLARE_BUILDS_TOKEN`. The Builds API takes user tokens only; the
   account-owned token `voidbase deploy` uses is rejected.
3. `GH_TOKEN=... NPM_TOKEN=... bun scripts/cf-builds.ts setup` connects the
   repository, creates the CI Worker with its trigger (every push to master builds)
   (only through the API), sets `BUN_VERSION`, and stores the secrets it finds in the environment: the release
   secrets on the master trigger. The release secrets: `GH_TOKEN` (a fine-grained
   PAT with contents and pull requests write on this repository and contents write on the testbeds' repositories,
   for release-please, the release assets and the testbed bumps), `NPM_TOKEN` (the npm granular token), optionally
   `GH_PACKAGES_TOKEN` (a classic PAT with `write:packages`; fine-grained tokens cannot publish packages, and without
   it the GitHub Packages copy is skipped). The first run stops when the account has no build token yet: open the
   `voidbase-ci` Worker in the dashboard, Settings > Builds > API token > Create new token, and run setup again.
4. `bun scripts/cf-builds.ts build --branch master --follow` runs the first build and streams its log; `status`,
   `builds`, `logs <uuid>`, `cancel <uuid>` and `env` cover the rest (the header of the script lists them).
5. From then on every push builds, one build each.

`test/cf-builds.ts` runs the CLI against `test/cf-mock.ts`, whose Builds endpoints follow the request and response
shapes of Cloudflare's API reference; the live API is exercised the first time the App and the user token exist.

### What to expect

- No provenance and no attestations (OIDC): `npm publish` runs without `--provenance`, the release archives carry
  checksums only.
- GitHub Packages only with `GH_PACKAGES_TOKEN`.
- Logs live in the dashboard and in `cf-builds.ts logs`; the deployed page is the last build that ran to the end.
- A release cut by hand (`gh release create vX.Y.Z` after bumping `package.json` on master) is published by the next
  build of master, which finds a release that is not on npm; nothing listens for GitHub's `release` event.

## The status page

`ci/public/index.html` lists the steps with their durations and logs, every suite with its result and last line, the
screenshots of the panel and starter suites, and links `status.json` (the same, as data) and `badge.svg`
(`ci: passing`). The page's canonical address is https://release.voidbase.cloud (the custom domain
`ci/wrangler.jsonc` declares; the workers.dev address stays on for the preview URLs): `badge.svg` there is the badge
in the README and `status.json` the record of the last green run and the feed for anything else; a pull request's
build uploads a version, so its preview URL shows the same page for that commit.
