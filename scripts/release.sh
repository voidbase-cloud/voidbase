#!/usr/bin/env bash
# The release flow (docs/releasing.md) as one script, run by Cloudflare Workers Builds (or any machine):
#   release-pr       keeps the "chore(master): release X.Y.Z" pull request up to date (every push to master)
#   github-release   tags vX.Y.Z and creates the GitHub release with the compiled notes once that PR is merged
#   publish          when release v<package.json version> exists and npm lacks that version: check, unit and cloud-rest
#                    tests, pack, smoke install, npm publish (provenance only where GitHub Actions' OIDC token exists),
#                    GitHub Packages, the tarball on the release
#   executables      when that release lacks checksums.txt: every platform, the exe smoke, the archives and checksums on
#                    the release, the notes opened with the `./voidbase update` hint
# Idempotent: a re-run after a partial failure does only what is still missing. Steps are recorded for the status page
# (ci/public, kind release).
#   scripts/release.sh [--dry-run] [--tag vX.Y.Z] [--no-pr]
#     --dry-run   everything up to the actions: release-please in dry-run mode, npm publish --dry-run, no uploads
#     --tag       publish a release cut by hand (skips release-please; the checkout must be that tag)
# Environment: GH_TOKEN (contents + pull requests write on the repository), NPM_TOKEN, GH_PACKAGES_TOKEN (optional: the
# Actions token or a classic PAT with write:packages; fine-grained tokens cannot publish packages), GITHUB_REPOSITORY.
set -uo pipefail
cd "$(dirname "$0")/.."; ROOT="$PWD"
. scripts/ci-lib.sh
DRY=""; TAG=""; PR=1
while [ $# -gt 0 ]; do case "$1" in --dry-run) DRY=1 ;; --tag) TAG="$2"; shift ;; --no-pr) PR=0 ;; *) echo "unknown option $1"; exit 2 ;; esac; shift; done
BACKEND=$(ci_backend); export CI_BACKEND_NAME="$BACKEND"
REPO="${GITHUB_REPOSITORY:-voidbase-cloud/voidbase}"; export GITHUB_REPOSITORY="$REPO"
BRANCH="${WORKERS_CI_BRANCH:-${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null)}}"
VERSION=$(node -p "require('./package.json').version"); PKG="@voidbase-cloud/voidbase"
RP=(bunx release-please@17.11.2); RP_ARGS=(--repo-url "$REPO" --token "${GH_TOKEN:-}" --target-branch master --config-file release-please-config.json --manifest-file .release-please-manifest.json)
rm -rf .void/ci-logs "$CI_STEPS_TSV"; mkdir -p .void/ci-logs
CI_CACHE_DIR="$(ci_cache_dir)"; export CI_CACHE_DIR; mkdir -p "$CI_CACHE_DIR"; export XDG_CACHE_HOME="$CI_CACHE_DIR/xdg"
outputs() { if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s\n' "$@" >> "$GITHUB_OUTPUT"; fi; }
finish() { local rc=$?; render_status --kind release || true; if [ "$rc" = 0 ]; then echo "RELEASE FLOW DONE"; else echo "RELEASE FLOW FAILED (exit $rc)"; fi; }
trap finish EXIT
echo "release flow on $BACKEND: $REPO, branch $BRANCH, package $VERSION${TAG:+, tag $TAG}${DRY:+, dry run}"

step install bun install --frozen-lockfile || exit 1
step cache-restore ./scripts/ci-cache.sh restore || true

# release-please, on master only, unless a release cut by hand is being published; without GH_TOKEN the release PR
# cannot be maintained, which only matters once something needs publishing (checked below without a token)
if [ -z "${GH_TOKEN:-}" ]; then echo "GH_TOKEN is not set: release-please skipped, publishing would fail"; skip_step release-pr "no GH_TOKEN"; skip_step github-release "no GH_TOKEN"
elif [ -z "$TAG" ] && [ "$BRANCH" = master ]; then
  if [ "$PR" = 1 ]; then step release-pr "${RP[@]}" release-pr "${RP_ARGS[@]}" ${DRY:+--dry-run} || exit 1; else skip_step release-pr; fi
  step github-release "${RP[@]}" github-release "${RP_ARGS[@]}" ${DRY:+--dry-run} || exit 1
else skip_step release-pr; skip_step github-release; fi

TAG="${TAG:-v$VERSION}"
[ "$TAG" = "v$VERSION" ] || { echo "tag $TAG does not match package.json version $VERSION"; exit 1; }
release_json=$(bun scripts/gh-release.ts view "$TAG" 2>/dev/null) || release_json=""
if [ -z "$release_json" ] && [ -z "$DRY" ]; then echo; echo "no release $TAG: nothing to publish"; outputs "published=false" "executables=false" "tag=$TAG"; exit 0; fi
echo "release $TAG: ${release_json:-none (dry run continues)}"
has_asset() { printf '%s' "$release_json" | grep -qF "\"$1\""; }

on_npm=0; npm view "$PKG@$VERSION" version >/dev/null 2>&1 && on_npm=1
publish_npm() {
  bun run check && bun test && bun test/cloud-rest.ts || return 1
  rm -f voidbase-cloud-voidbase-*.tgz; npm pack || return 1
  local tarball; tarball="$PWD/$(ls voidbase-cloud-voidbase-*.tgz)"; ls -la "$tarball"
  local smoke; smoke=$(mktemp -d)
  (cd "$smoke" && bun init -y >/dev/null && bun add "$tarball" && bunx voidbase help | head -n 5 && node -e "const p=require('$PKG/package.json'); if (p.version !== '$VERSION') throw new Error('version mismatch: ' + p.version)") || return 1
  [ -n "${NPM_TOKEN:-}" ] || { echo "NPM_TOKEN is not set"; return 1; }
  local npmrc; npmrc=$(mktemp); printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$npmrc"
  local provenance=""; [ "$BACKEND" = github ] && [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] && provenance="--provenance"
  echo "npm publish: provenance ${provenance:-off (only GitHub Actions can mint the OIDC token)}, dry run ${DRY:-no}"
  NPM_CONFIG_USERCONFIG="$npmrc" npm publish "$tarball" --access public $provenance ${DRY:+--dry-run} || { rm -f "$npmrc"; return 1; }
  rm -f "$npmrc"
  if [ -n "${GH_PACKAGES_TOKEN:-}" ]; then
    npmrc=$(mktemp); printf '@voidbase-cloud:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$GH_PACKAGES_TOKEN" > "$npmrc"
    NPM_CONFIG_USERCONFIG="$npmrc" npm publish "$tarball" --registry=https://npm.pkg.github.com ${DRY:+--dry-run} || echo "GitHub Packages publish failed (npm is the registry of record; continuing)"
    rm -f "$npmrc"
  else echo "GitHub Packages: skipped (no GH_PACKAGES_TOKEN)"; fi
  if [ -z "$DRY" ]; then bun scripts/gh-release.ts upload "$TAG" "$tarball" || return 1; fi
}
if [ "$on_npm" = 1 ] && [ -z "$DRY" ]; then skip_step publish; echo "$PKG@$VERSION is already on npm"
elif [ -z "${GH_TOKEN:-}" ]; then echo "release $TAG needs publishing but GH_TOKEN is not set"; exit 1
else step publish publish_npm || exit 1; [ -z "$DRY" ] && outputs "published=true"; fi

build_executables() {
  . scripts/ci-oracles.sh
  bun run panel:sync || return 1
  bun scripts/build-exe.ts --targets all --out dist/release || return 1
  cat dist/release/checksums.txt
  STARTER_VB_DIR="$STARTER_DIR/pb" bun test/exe-smoke.ts || return 1
  [ -n "$DRY" ] && return 0
  bun scripts/gh-release.ts upload "$TAG" dist/release/*.zip dist/release/checksums.txt || return 1
  # PocketBase's shape: the `./voidbase update` hint first, then the compiled notes (`voidbase update` strips the hint again)
  bun scripts/gh-release.ts body "$TAG" > .void/release-body.md || return 1
  if ! grep -qF 'To update the prebuilt executable you can run `./voidbase update`' .void/release-body.md; then
    { printf '> _To update the prebuilt executable you can run `./voidbase update`._\n\n'; cat .void/release-body.md; } > .void/release-notes.md
    bun scripts/gh-release.ts notes "$TAG" .void/release-notes.md || return 1
  fi
}
if has_asset checksums.txt && [ -z "$DRY" ]; then skip_step executables; echo "release $TAG already has its executables"
elif [ -z "${GH_TOKEN:-}" ]; then echo "release $TAG needs its executables but GH_TOKEN is not set"; exit 1
else step executables build_executables || exit 1; [ -z "$DRY" ] && outputs "executables=true"; fi
outputs "tag=$TAG"
step cache-save ./scripts/ci-cache.sh save || true
echo; echo "release $TAG: done${DRY:+ (dry run)}"
