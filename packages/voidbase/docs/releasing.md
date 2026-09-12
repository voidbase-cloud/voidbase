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
   section compiled from the commits, the `packages/voidbase/package.json` bump (the workspace root is private and
   has no version). Keep merging work; the PR follows.
2. Merge the PR. `github-release` tags `vX.Y.Z` and creates the GitHub release with that section as notes.
3. `publish`, when release `v<package.json version>` exists and npm lacks the version: install, typecheck, the unit
   and cloud-rest tests, `npm pack` in `packages/voidbase`, a smoke install of the tarball that runs the CLI from
   it, `npm publish`, the
   GitHub Packages copy (with `GH_PACKAGES_TOKEN`), and the tarball attached to the release (`scripts/gh-release.ts`).
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
`scripts/hot-release.ts` asks release-please nothing: it reads `packages/voidbase/package.json`, increments the
prerelease counter, writes the changelog from the commit subjects, tags and pushes. So with hot mode on, a push that
touches only `scripts/` still cuts a release and still reaches npm, exactly like any other push to master. The two
modes disagree here on purpose -- hot mode releases pushes, release-please releases changes to the package -- and
the first normal run after `hot off` is the one that goes back to the narrow rule.

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
  flow (release-please in dry-run mode, `npm publish --dry-run`, the executables, nothing published, no release
  touched), or locally `bun run release -- --dry-run` (needs `GH_TOKEN` with read access and `NPM_TOKEN`).
- A release cut by hand also publishes: `gh release create vX.Y.Z --notes-file notes.md` after bumping `packages/voidbase/package.json`
  to X.Y.Z on `master`; the next build of master finds a release that is not on npm and publishes it, or
  `bun run release` does from a machine at that commit.
- Publishing from a machine: `bun run check && bun test` at the repository root, then `npm publish` **in
  `packages/voidbase`** --
  `cd packages/voidbase && NPM_CONFIG_//registry.npmjs.org/:_authToken=$VOIDBASE_NPM_TOKEN npm publish --access public`.
  The root is the private workspace root and has nothing to publish; `npm publish` there refuses.

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
