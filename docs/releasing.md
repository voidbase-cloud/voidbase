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
`bun install` installs the hooks (`prepare`); `git commit --no-verify` skips them, and CI (`ci.yml`, job
`commitlint`) checks the pushed or proposed commits regardless.

## The release

1. Push or merge conventional commits to `master`. `release.yml` runs release-please, which opens or updates the
   pull request "chore(master): release X.Y.Z": the next version from the commit types, the `CHANGELOG.md`
   section compiled from the commits, the `package.json` bump. Keep merging work; the PR follows.
2. Merge the PR. release-please tags `vX.Y.Z` and creates the GitHub release with that section as notes.
3. The `publish` job of the same run then installs, typechecks, runs the unit and cloud-rest tests, packs, smoke-
   installs the tarball and runs the CLI from it, publishes to npm (`--provenance` when the repository is public)
   and to GitHub Packages, and attaches the tarball to the release.
4. The `executables` job builds the prebuilt executables for every platform (`scripts/build-exe.ts`: Bun
   cross-compiles from one runner; the panel, the system migrations and the hooks typings are embedded), smokes the
   runner's own build (`test/exe-smoke.ts`: serve with pb_hooks, the panel from the embedded zip, a thumbnail through
   the wasm, then `voidbase update` against a mock GitHub API), attaches `voidbase_<version>_<os>_<arch>.zip` for
   linux/darwin/windows × amd64/arm64 (plus musl builds) and `checksums.txt` to the release, attests each archive
   with `actions/attest-build-provenance`, and puts the release notes in PocketBase's shape: the
   `./voidbase update` hint first, then the compiled notes.

The layout mirrors PocketBase's releases: the zip holds the executable, `CHANGELOG.md` and `LICENSE`;
`checksums.txt` is goreleaser's format (`<sha256>  <file>`), which `voidbase update` checks before replacing the
executable. Verify an archive's provenance with `gh attestation verify voidbase_X.Y.Z_linux_amd64.zip --owner
voidbase-cloud`. For the "Immutable" badge and the release attestation GitHub adds itself, enable immutable releases
once in the repository settings (Settings > General > Releases); it is a setting, not something the workflow can
turn on.

`.release-please-manifest.json` holds the released version (0.1.0 was cut by hand and its notes written by hand;
everything after it is compiled). `release-please-config.json` maps commit types to changelog sections.

## Rehearsals and manual paths

- Actions > release > Run workflow with `dry_run` on (or `gh workflow run release.yml -f dry_run=true`): the
  publish job with `npm publish --dry-run`, nothing published, no release touched.
- A release cut by hand also publishes: `gh release create vX.Y.Z --notes-file notes.md` after bumping
  `package.json` to X.Y.Z on `master`; the `release: published` event runs the publish job against that tag.
- Publishing from a machine: `bun run check && bun test`, then
  `NPM_CONFIG_//registry.npmjs.org/:_authToken=$VOIDBASE_NPM_TOKEN npm publish --access public`.

Secrets and permissions: `NPM_TOKEN` (repository secret, an npm granular token with publish rights on the
`@voidbase-cloud` scope). release-please opens the release PR with the workflow's own token only if the
organization allows it (voidbase-cloud > Settings > Actions > General > "Allow GitHub Actions to create and
approve pull requests", then the same switch on the repository); otherwise add `RELEASE_PLEASE_TOKEN`, a
fine-grained PAT with contents and pull requests write on this repository, which the workflow prefers when
present and which also makes CI run on the release PR (the workflow's own token cannot trigger other workflows).
GitHub Packages and the release assets use the workflow's `GITHUB_TOKEN`.

Consumers: `bun add @voidbase-cloud/voidbase`; from GitHub Packages instead, `.npmrc` with
`@voidbase-cloud:registry=https://npm.pkg.github.com` and a token with `read:packages`.
