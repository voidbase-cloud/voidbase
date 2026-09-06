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
   "chore(master): release X.Y.Z": the next version from the commit types, the `CHANGELOG.md` section compiled from
   the commits, the `package.json` bump. Keep merging work; the PR follows.
2. Merge the PR. `github-release` tags `vX.Y.Z` and creates the GitHub release with that section as notes.
3. `publish`, when release `v<package.json version>` exists and npm lacks the version: install, typecheck, the unit
   and cloud-rest tests, `npm pack`, a smoke install of the tarball that runs the CLI from it, `npm publish`, the
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

`.release-please-manifest.json` holds the released version (0.1.0 was cut by hand and its notes written by hand;
everything after it is compiled). `release-please-config.json` maps commit types to changelog sections.

## Rehearsals and manual paths

- A dry run: a commit on master whose message carries a `Release: dry-run` trailer makes the build rehearse the
  flow (release-please in dry-run mode, `npm publish --dry-run`, the executables, nothing published, no release
  touched), or locally `bun run release -- --dry-run` (needs `GH_TOKEN` with read access and `NPM_TOKEN`).
- A release cut by hand also publishes: `gh release create vX.Y.Z --notes-file notes.md` after bumping `package.json`
  to X.Y.Z on `master`; the `release` event starts a build of the tagged commit, whose release step publishes it.
- Publishing from a machine: `bun run check && bun test`, then
  `NPM_CONFIG_//registry.npmjs.org/:_authToken=$VOIDBASE_NPM_TOKEN npm publish --access public`.

Secrets and permissions. The master trigger on Cloudflare holds `GH_TOKEN` (a fine-grained PAT with contents, pull
requests and issues write on this repository: release-please opens and labels the release PR and creates the release
with it, the assets are uploaded with it), `NPM_TOKEN` (an npm granular token with publish rights on the
`@voidbase-cloud` scope) and optionally `GH_PACKAGES_TOKEN` (a classic PAT with `write:packages`; without it the
GitHub Packages copy is skipped). `bun scripts/cf-builds.ts setup` stores them from the environment; builds of other
branches never carry them. GitHub itself holds only what the workflow needs to start builds: the secret
`CLOUDFLARE_BUILDS_TOKEN` and the trigger variables. release-please's PR needs no organization setting for Actions,
since a PAT opens it.

Consumers: `bun add @voidbase-cloud/voidbase`; from GitHub Packages instead, `.npmrc` with
`@voidbase-cloud:registry=https://npm.pkg.github.com` and a token with `read:packages`.
