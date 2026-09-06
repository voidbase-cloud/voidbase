# Releasing

The package is `@voidbase-cloud/voidbase`. A release is a git tag `vX.Y.Z` that matches `package.json`; pushing
the tag runs `.github/workflows/release.yml`, which checks, packs, smoke-installs and publishes.

```bash
# on master, tree clean, CHANGELOG.md has a "## X.Y.Z" section
npm version minor            # or patch / major / 0.2.0: bumps package.json, commits "vX.Y.Z", tags it
git push --follow-tags       # the tag triggers the release workflow
```

What the workflow does, in order:

1. `bun install --frozen-lockfile`, the two typechecks, `bun test`, `test/cloud-rest.ts` (self-contained mocks).
2. Refuses to continue if the tag and `package.json` disagree, or if that version is already on npm.
3. `npm pack`, then installs the tarball into a temporary project and runs the CLI from it.
4. `npm publish` to npm with `--access public`, and with `--provenance` when the repository is public (npm's
   provenance needs a public repository; the workflow turns it off while the repository is private).
5. The same tarball to GitHub Packages (`npm.pkg.github.com`, the `@voidbase-cloud` scope matches the organization).
6. A GitHub release for the tag with the `CHANGELOG.md` section for that version as notes and the tarball attached.

Secrets and permissions: `NPM_TOKEN` (repository secret: an npm granular token with publish rights on the
`@voidbase-cloud` scope, created at npmjs.com > Access Tokens); GitHub Packages and the release use the
workflow's own `GITHUB_TOKEN` (`packages: write`, `contents: write`, `id-token: write` for provenance).

Try the pipeline without publishing: Actions > release > Run workflow with `dry_run` on (or
`gh workflow run release.yml -f dry_run=true`). It runs every step with `npm publish --dry-run` and creates no
release.

Publishing by hand, when Actions is not an option:

```bash
bun run check && bun test
NPM_CONFIG_//registry.npmjs.org/:_authToken=$VOIDBASE_NPM_TOKEN npm publish --access public
```

Consumers install with `bun add @voidbase-cloud/voidbase`. From GitHub Packages instead, add to `.npmrc`:
`@voidbase-cloud:registry=https://npm.pkg.github.com` plus a token with `read:packages`.
