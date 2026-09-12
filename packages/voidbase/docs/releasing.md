# Releasing

Every release has release notes because every commit message is a release note in waiting: commits follow
[Conventional Commits](https://www.conventionalcommits.org), husky and CI enforce it, and
[release-please](https://github.com/googleapis/release-please) compiles the commits merged since the previous
release into `CHANGELOG.md`, the version bump and the GitHub release notes.

## Commit messages

```
type(scope): subject            # scope optional; subject in the imperative, no trailing period, header <= 100 chars

body (optional): what and why, wrapped at 120

BREAKING CHANGE: description    # footer; or `feat(scope)!: subject`
```

| type | in the release notes as | bumps |
| --- | --- | --- |
| `feat` | Features | minor (0.x: minor) |
| `fix` | Bug Fixes | patch |
| `perf` | Performance | patch |
| `revert` | Reverts | patch |
| `docs`, `refactor` | Documentation, Refactoring | nothing on their own |
| `build`, `ci`, `chore`, `test`, `style` | hidden | nothing |

A breaking change (`!` or the footer) bumps the minor while the version is below 1.0, the major after.
Scopes are the areas of the code base (`commitlint.config.js` lists them; an unknown scope is a warning, a
wrong type or a long header is an error). Examples:

```
feat(realtime): push changes through the hub Durable Object
fix(mail): keep stored SMTP passwords when the settings PATCH sends a blank
docs(deploy): custom domains through the Workers API
ci(release): compile release notes with release-please
```

`.husky/commit-msg` runs commitlint on every commit; `.husky/pre-commit` runs `bun run check` and `bun test`.
`bun install` installs the hooks (`prepare`); `git commit --no-verify` skips them, and the CI build
(`scripts/ci.sh`, step `commitlint`) checks the pushed or proposed commits regardless.

## The release

`scripts/release.sh` is the whole flow. It runs as the last step of the CI build on master (docs/ci.md) when the
pushed commits are releasable (`feat`, `fix`, `perf`, `revert`, a breaking change), when the release PR was merged,
when a commit carries a `Release: dry-run` trailer, or when a release still needs npm or its executables (one cut
by hand, or one published in hot mode). It is idempotent: a re-run after a partial failure does only what is still
missing. In hot mode it publishes to npm and leaves the executables to the first normal run.

1. Push or merge conventional commits to `master`. `release-pr` (release-please) opens or updates the pull request
   "chore(master): release X.Y.Z": the next version from the commit types, the `packages/voidbase/CHANGELOG.md`
   section compiled from the commits, and the version written into every `packages/*/package.json` (the workspace
   root is private and has no version). Keep merging work; the PR follows.
2. Merge the PR. `github-release` tags `vX.Y.Z` and creates the GitHub release with that section as notes.
3. `publish`, when npm lacks any publishable package at `v<package.json version>`: install, typecheck, the unit and
   cloud-rest tests, then `scripts/publish.ts` -- `bun pm pack` over every publishable package in the workspace, the
   refusal of any packed manifest that still carries a `workspace:` spec or names a sibling that is never
   published, one smoke install of all the tarballs
   together that imports each package by name and runs the bins it declares, `npm publish` in dependency order with
   each package skipped when the registry already has it, the GitHub Packages copy (with `GH_PACKAGES_TOKEN`), and
   the tarballs attached to the release (`scripts/gh-release.ts`). The next section is what "every package" means
   while there is one of them.
4. `executables`, when that release lacks `checksums.txt`: the prebuilt executables for every platform
   (`scripts/build-exe.ts`: Bun cross-compiles from one machine; the panel, the system migrations and the hooks
   typings are embedded), the smoke of the machine's own build (`test/exe-smoke.ts`: serve with pb_hooks, the panel
   from the embedded zip, a thumbnail through the wasm, then `voidbase update` against a mock GitHub API),
   `voidbase_<version>_<os>_<arch>.zip` for linux/darwin/windows × amd64/arm64 (plus musl builds) and `checksums.txt`
   attached to the release, and the release notes in PocketBase's shape: the `./voidbase update` hint first, then the
   compiled notes.

The layout mirrors PocketBase's releases: the zip holds the executable, `CHANGELOG.md` and `LICENSE`;
`checksums.txt` is goreleaser's format (`<sha256>  <file>`), which `voidbase update` checks before replacing the
executable. Builds on Cloudflare cannot attest the archives or publish with npm provenance (both need the OIDC token
of a GitHub Actions run), so the checksums are the integrity check. For the "Immutable" badge and the release
attestation GitHub adds itself, enable immutable releases once in the repository settings (Settings > General >
Releases); it is a setting, not something a workflow can turn on.

`.release-please-manifest.json` (at the workspace root, keyed by `packages/voidbase`) holds the released version (0.1.0 was cut by hand and its notes written by hand;
everything after it is compiled). `release-please-config.json` maps commit types to changelog sections.

### What a commit has to touch, and what a tooling-only fix does

release-please attributes a commit to a package only when the commit touches that package's path, and the
configuration names exactly one package, `packages/voidbase`. So the version bump, the `packages/voidbase/CHANGELOG.md`
section and the release pull request follow the commits that touch `packages/voidbase/**`, and only those. **A commit
that touches only the workspace root -- `scripts/`, `ci/`, `surface/`, `bunfig.toml`, the root `package.json`, this
repository's own CI and release tooling -- does not bump the version, does not refresh the release pull request and
does not appear in the changelog.** A tooling-only `fix:` therefore does nothing releasable: it lands on master and
sits in the git history until the next commit that does touch the package carries a release over it, with no
changelog line of its own.

This is a real change and not a side effect worth shrugging at. Until the move the configuration was keyed `"."`,
and `"."` is release-please's root project path: `CommitSplit` (release-please 17.11.2,
`build/src/util/commit-split.js`) deliberately skips it, and `Manifest.buildPullRequests` hands that path the
unsplit commit list, so every commit counted. Keying `packages/voidbase` puts every commit through the splitter,
which matches a file to a package only by the `packages/voidbase/` prefix and drops repository-root files entirely.

The narrow scope is the deliberate choice. The root's tooling is no longer in the tarball -- it used to be, which is
why a change to `scripts/ci.sh` once changed what people installed -- so a version that moved for it would be a
version number that says nothing about the package. The alternative release-please actually offers is a second
entry keyed `"."`; it would take *all* commits, the package's included, duplicate every changelog line and bump the
private workspace root's own `package.json`, so it was not taken. If a tooling change has to reach a release, touch
the package in the same commit, or cut the release by hand (below).

**Hot mode is the exception, and it is the mode this repository runs in during the beta** (`CI_HOT=1`, docs/ci.md).
`scripts/hot-release.ts` asks release-please nothing: it reads the version off the publishable packages, increments
the prerelease counter, writes it into every workspace package, writes the changelog of each publishable one from
the commit subjects, tags and pushes. So with hot mode on, a push that
touches only `scripts/` still cuts a release and still reaches npm, exactly like any other push to master. The two
modes disagree here on purpose -- hot mode releases pushes, release-please releases changes to the package -- and
the first normal run after `hot off` is the one that goes back to the narrow rule.

### N packages, one version

The repository publishes one package and is about to publish more, so the release flow is written for N of them and
is proved at N > 1 while N is 1. `scripts/publish.ts` is all of the packing and publishing;
`packages/release-fixture` -- a private, never-published second workspace package that depends on
`@voidbase-cloud/voidbase` through `workspace:*` -- is what keeps the N > 1 paths honest, and
`test/unit/publish.test.ts` drives the whole loop over a throwaway two-package workspace against a stubbed registry
on localhost.

**Pack with `bun pm pack`, never `npm pack`.** A workspace dependency is written `workspace:*`, and npm copies that
string into the published manifest verbatim -- measured on npm 11.19.0 against the fixture, which packs as
`"@voidbase-cloud/voidbase": "workspace:*"`, a spec nobody can install. Bun 1.3.14 resolves it while packing:
`workspace:*` becomes the sibling's exact version, `workspace:^` and `workspace:~` become ranges on it, across
`dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies` alike. Bun reads that resolution
out of the lockfile, so the workspace has to be installed before a release packs it -- CI installs first, and
`bun pm pack` says so rather than guessing if it is not.

**The gates.** Every packed manifest is read back out of its own tarball and refused on three counts. The first is
obvious: it still carries a `workspace:` spec. npm publishes the manifest essentially verbatim, so that is read
everywhere a spec can be -- the four dependency maps, and `overrides` and `resolutions`, which nest and are
therefore walked recursively (`bundleDependencies` is the one map left alone: it holds names, not specs). The
second is not obvious, and it is the one that would have shipped quietly. Bun resolves the protocol out of
`bun.lock`, not out of the sibling's `package.json`,
and `bun install` does **not** rewrite a workspace entry's version when only that version moved -- measured on bun
1.3.14, where `--force` and `--lockfile-only` both leave the old number and only deleting the lockfile and
reinstalling refreshes it. Every release bumps the manifests *after* the install: hot mode by writing them,
release-please by merging a pull request that did. So `bun pm pack` would resolve a sibling to the release before
this one, produce a tarball that looks completely normal, and put it on npm. `scripts/publish.ts` therefore writes
the lockfile's workspace versions in step with the manifests before it packs (`syncLockfile`, the same entries bun
writes itself), and `hot-release.ts` commits that with the bump; the second gate compares what the packer resolved
against what the sibling actually is, so if the sync ever stops working the release stops with it.

The third gate refuses a manifest that depends on a workspace sibling this release never publishes -- the fixture,
or any package that keeps `"private": true`. The registry does not have that name and nothing here will put it
there, so the package is uninstallable; and if the name *does* exist on npm, under a scope we do not own, the
install succeeds and ships a dependency on a stranger's code. The smoke install would find the first case as a 404
that says nothing about why, `--no-smoke` skips it, and nothing at all finds the second. `dependencies`,
`optionalDependencies` and `peerDependencies` are read: nobody installing a tarball resolves its devDependencies.

All three are hard failures before anything reaches npm: half a workspace on the registry, a package naming a
sibling it was not built against, or one naming a sibling that does not exist, is worse than no release at all.

Two more refusals sit beside them, neither of which is a gate on a manifest. `--out` is refused unless it resolves
to a directory strictly below the workspace root, because the pack directory is emptied at the start of a run and
`--out .` would otherwise empty the repository; and what is emptied is the `*.tgz` files in it, not the directory.
And the fixture is refused by name (`NEVER_PUBLISH`) as well as by its flag, because `"private": true` is one edit
from being dropped: npm does refuse a private package with `EPRIVATE`, from a directory and from a tarball alike
(measured, npm 11.19.0), but `npm publish --dry-run` does not check at all and prints `+ name@version` -- so the
rehearsal, which is where anyone would notice, is the one place npm says nothing.

**The smoke install** takes all of the tarballs at once into a scratch project, with `overrides` pointing each name
at its own tarball -- a sibling's resolved version is not on the registry yet, and without that the install goes
looking for it and fails. Each package is then used by name rather than looked at: `import(name)` through its
exports, and every bin it declares run with `--help`.

**The publish loop** walks the publishable packages in dependency order and skips any whose `name@version` the
registry already has. A retried or half-finished release finishes instead of dying on npm's 403, and a package is
never published before a sibling it names. Dependency order is `dependencies` and `optionalDependencies` and
nothing else: a devDependency cycle is legal and says nothing, and a **peer** edge says nothing either -- npm does
not resolve peers at publish time. Reading peers as ordering would be worse than useless here, because every
`@voidbase-cloud/plugin-*` package peer-depends on the core: the moment the core depends on an extracted plugin,
that pair is a cycle and every release stops.

**One version across the workspace** -- the owner's decision, and the reason a tarball can name a sibling at all.
In hot mode `scripts/hot-release.ts` bumps every workspace package together and refuses a workspace whose
publishable packages have drifted apart. On the normal path release-please does it from the one package it tracks:

```json
"extra-files": [{ "type": "json", "path": "/packages/*/package.json", "jsonpath": "$.version", "glob": true }]
```

A leading `/` makes the glob root-relative rather than package-relative (`BaseStrategy.extraFilePaths` and
`addPath`, release-please 17.11.2), so the release pull request writes the new version into every
`packages/*/package.json` and touches nothing else in them -- and a package added later is covered without editing
the configuration.

What it cannot write is `bun.lock`, which is JSONC and has no updater. So the release pull request leaves the
lockfile's workspace versions a release behind, and nothing else notices: `bun install --frozen-lockfile` checks
clean and exits 0 with the manifests at 1.0.1 and the lockfile at 1.0.0 (measured, bun 1.3.14). That is exactly the
state the second gate exists to catch, and a release repairs it at pack time rather than complaining -- so the unit
suite asserts it instead (`lockfileDrift`, `test/unit/publish.test.ts`), loudly and for a penny. When it fails,
`bun install` and a commit of `bun.lock` is the whole fix; merging the release pull request and pushing that commit
is one step of the same release.

release-please's own `linked-versions` plugin is the obvious answer and is the wrong one here. It collects the
strategies in a group by `strategy.getComponent()`, and `BaseStrategy.getComponent()` returns `''` whenever
`include-component-in-tag` is false (`build/src/strategies/base.js`, release-please 17.11.2); `LinkedVersions.preconfigure`
skips every strategy with no component. This repository tags `vX.Y.Z` with no component in it, so the plugin would
find zero group members and quietly do nothing, and turning the component on would rename every tag the executables'
update path and `scripts/release.sh --tag` depend on. The glob gets the same lockstep with the tag scheme intact.

## The public beta

While voidbase is in public beta the versions carry the label: `"versioning": "prerelease"` with
`"prerelease-type": "beta"` turns the next bump into `0.9.0-beta` rather than `0.9.0`, and `"prerelease": true` marks
the GitHub release as a pre-release. Going stable is deleting those three keys and nothing else.

Two consequences are worth knowing, because both of them decide whether an existing install ever hears about a
release:

- **npm.** npm refuses to publish a prerelease unless `--tag` is explicit, because the default would quietly move
  `latest` onto it. `scripts/release.sh` passes `--tag latest` anyway, deliberately: while the beta is what we are
  asking people to run, a fresh `bun i -g` and `voidbase update` should both land on it, and publishing under a
  `beta` tag alone would leave everyone on the last stable version without saying so. After a prerelease publishes,
  `beta` is added as a second dist-tag, so `@beta` works for anyone who would rather pin the channel. Going stable
  needs no change here: a version with no prerelease part takes `latest` the same way.
- **GitHub.** `/repos/.../releases/latest` deliberately excludes anything marked as a pre-release, so the prebuilt
  executable's update path does not use it. `fetchLatestRelease` (`src/node/update.ts`) reads the releases list and
  takes the highest version, drafts excluded, and falls back to `/releases/latest` only when the list cannot be
  read. `test/exe-smoke.ts` covers exactly this: a beta that `/releases/latest` hides is still offered.

## Rehearsals and manual paths

- A dry run: a commit on master whose message carries a `Release: dry-run` trailer makes the build rehearse the
  flow (release-please in dry-run mode, the pack and the smoke install for real, `npm publish --dry-run` for every
  package the registry does not already have, the executables, nothing published, no release touched), or locally
  `bun run release -- --dry-run` (needs `GH_TOKEN` with read access and `NPM_TOKEN`). A dry run changes no tracked
  file: where a real release would write the lockfile's workspace versions it prints what it would have written and
  packs against `bun.lock` as committed, so a machine that rehearses a release is not left with a modified one.
- A release cut by hand also publishes: `gh release create vX.Y.Z --notes-file notes.md` after bumping **every**
  `packages/*/package.json` to X.Y.Z on `master` and committing the `bun install` that follows (the versions are
  lockstep, so bumping one of them dies in `assertLockstep`, and a lockfile left behind fails the unit suite). The
  next build of master finds a release that is not on npm and publishes it, or `bun run release` does from a
  machine at that commit.
- Publishing from a machine: `bun run check && bun test` at the repository root, then
  `NPM_TOKEN=$VOIDBASE_NPM_TOKEN bun scripts/publish.ts` from the root, which packs, proves, smoke-installs and
  publishes every publishable package and skips the ones npm already has. Do not run `npm publish` in
  `packages/voidbase` by hand: `npm pack` leaves a `workspace:*` dependency in the manifest, and a package with one
  cannot be installed. `bun scripts/publish.ts --pending` prints what npm is still missing at the current version;
  the root itself is the private workspace root and has nothing to publish.

Secrets and permissions. The master trigger on Cloudflare holds `GH_TOKEN` (a fine-grained PAT with contents, pull
requests and issues write on this repository: release-please opens and labels the release PR and creates the release
with it, the assets are uploaded with it), `NPM_TOKEN` (an npm granular token with publish rights on the
`@voidbase-cloud` scope) and optionally `GH_PACKAGES_TOKEN` (a classic PAT with `write:packages`; without it the
GitHub Packages copy is skipped). `bun scripts/cf-builds.ts setup` stores them from the environment; builds of other
branches never carry them. GitHub itself holds nothing: there are no Actions, so no Actions secrets or variables.
release-please's PR needs no organization setting for Actions, since a PAT opens it. `GH_TOKEN` also pushes the
testbed bumps (`bun scripts/testbeds.ts <version>`, run by hand: the three apps are their own projects), so it needs contents write on
`voidbase-cloud/voidbase-demo`, `voidbase-marketplace` and `voidbase-site` as well.

Consumers: `bun add @voidbase-cloud/voidbase`; from GitHub Packages instead, `.npmrc` with
`@voidbase-cloud:registry=https://npm.pkg.github.com` and a token with `read:packages`.
