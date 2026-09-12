#!/usr/bin/env bash
# The release flow (docs/releasing.md) as one script, run by Cloudflare Workers Builds (or any machine):
#   release-pr       keeps the "chore(master): release X.Y.Z" pull request up to date (every push to master)
#   github-release   tags vX.Y.Z and creates the GitHub release with the compiled notes once that PR is merged
#   publish          when release v<package.json version> exists and npm lacks it: check, unit and cloud-rest tests,
#                    then scripts/publish.ts -- every publishable package in the workspace packed with `bun pm pack`,
#                    proved free of `workspace:` specs, smoke-installed together and published in dependency order
#                    (provenance only where GitHub Actions' OIDC token exists), GitHub Packages, tarballs on the release
#   executables      when that release lacks checksums.txt: every platform, the exe smoke, the archives and checksums on
#                    the release, the notes opened with the `./voidbase update` hint
# Idempotent: a re-run after a partial failure does only what is still missing. Steps are recorded for the status page
# (ci/public, kind release).
#   scripts/release.sh [--dry-run] [--tag vX.Y.Z] [--no-pr] [--hot]
#     --dry-run   everything up to the actions: release-please in dry-run mode, npm publish --dry-run, no uploads
#     --tag       publish a release cut by hand (skips release-please; the checkout must be that tag)
#     --no-pr     skip the release PR refresh (nothing releasable in the push)
#     --hot       hot mode: publish to npm without the checks, leave the executables to a later normal run
# scripts/ci.sh runs it as the last step of a CI build (CI_NESTED=1: no reset, no cache, no page of its own).
# Environment: GH_TOKEN (contents + pull requests write on the repository), NPM_TOKEN, GH_PACKAGES_TOKEN (optional: the
# Actions token or a classic PAT with write:packages; fine-grained tokens cannot publish packages), GITHUB_REPOSITORY.
set -uo pipefail
cd "$(dirname "$0")/.."; ROOT="$PWD"; PKG_DIR="$ROOT/packages/voidbase"
. scripts/ci-lib.sh
DRY=""; TAG=""; PR=1; HOT=""
while [ $# -gt 0 ]; do case "$1" in --dry-run) DRY=1 ;; --tag) TAG="$2"; shift ;; --no-pr) PR=0 ;; --hot) HOT=1 ;; *) echo "unknown option $1"; exit 2 ;; esac; shift; done
BACKEND=$(ci_backend); export CI_BACKEND_NAME="$BACKEND"
REPO="${GITHUB_REPOSITORY:-voidbase-cloud/voidbase}"; export GITHUB_REPOSITORY="$REPO"
BRANCH="${WORKERS_CI_BRANCH:-${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null)}}"
VERSION=$(node -p "require('./packages/voidbase/package.json').version"); PACKS="$ROOT/dist/packs"
RP=(bunx release-please@17.11.2); RP_ARGS=(--repo-url "$REPO" --token "${GH_TOKEN:-}" --target-branch master --config-file release-please-config.json --manifest-file .release-please-manifest.json)
CI_CACHE_DIR="$(ci_cache_dir)"; export CI_CACHE_DIR; mkdir -p "$CI_CACHE_DIR"
outputs() { if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s\n' "$@" >> "$GITHUB_OUTPUT"; fi; }
if [ -z "${CI_NESTED:-}" ]; then
  rm -rf .void/ci-logs "$CI_STEPS_TSV"; mkdir -p .void/ci-logs
  finish() { local rc=$?; render_status --kind release || true; if [ "$rc" = 0 ]; then echo "RELEASE FLOW DONE"; else echo "RELEASE FLOW FAILED (exit $rc)"; fi; }
  trap finish EXIT
fi
echo "release flow on $BACKEND: $REPO, branch $BRANCH, package $VERSION${TAG:+, tag $TAG}${DRY:+, dry run}${HOT:+, hot mode (npm only)}"

if [ -z "${CI_NESTED:-}" ]; then step install bun install --frozen-lockfile || exit 1; step cache-restore ./scripts/ci-cache.sh restore || true; fi

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

# what npm is missing at this version, across every publishable package in the workspace (scripts/publish.ts). A
# failed check counts as "missing", never as "published": the publish step is idempotent and would skip what is
# already there, so erring towards running it is the safe direction.
PENDING=$(bun scripts/publish.ts --pending | tr '\n' ' ') || PENDING="unknown (the pending check failed)"; PENDING="${PENDING% }"
publish_npm() {
  # hot mode publishes what master is, unchecked: the point of hot mode is that nothing stands between a push and npm
  if [ -z "$HOT" ]; then bun run check && bun test && (cd "$PKG_DIR" && bun test/cloud-rest.ts) || return 1; fi
  [ -n "${NPM_TOKEN:-}" ] || { echo "NPM_TOKEN is not set"; return 1; }
  # scripts/publish.ts is the whole of it: `bun pm pack` over every publishable package (never `npm pack`, which
  # copies a `workspace:*` dependency into the manifest verbatim), the refusal of any packed manifest that still
  # carries `workspace:`, the refusal of one that names a sibling this release never publishes, one smoke install
  # of all the tarballs together, then npm in dependency order with each package skipped when the registry already
  # has it -- so a retried or half-finished release finishes, and a dry run of a published version no longer has to
  # duck npm's refusal to "publish over" it. It empties dist/packs of tarballs itself, so the upload below is this
  # release's tarballs and nothing else.
  local args=(--version "$VERSION" --out dist/packs)
  [ -n "$DRY" ] && args+=(--dry-run)
  if [ "$BACKEND" = github ] && [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then args+=(--provenance); else echo "provenance: off (only GitHub Actions can mint the OIDC token)"; fi
  bun scripts/publish.ts "${args[@]}" || return 1
  if [ -z "$DRY" ]; then bun scripts/gh-release.ts upload "$TAG" "$PACKS"/*.tgz || return 1; fi
}
if [ -z "$PENDING" ] && [ -z "$DRY" ]; then skip_step publish; echo "every publishable package is already on npm at $VERSION"
elif [ -z "${GH_TOKEN:-}" ]; then echo "release $TAG needs publishing but GH_TOKEN is not set"; exit 1
else step publish publish_npm || exit 1; [ -z "$DRY" ] && outputs "published=true"; fi

# voidbase-site, voidbase-demo and voidbase-marketplace are their own projects and are moved onto a version by hand
# (`bun scripts/testbeds.ts <version>`), never by this build.

build_executables() {
  . scripts/ci-oracles.sh
  XDG_CACHE_HOME="$CI_CACHE_DIR/xdg" bun run panel:sync || return 1
  bun scripts/build-exe.ts --targets all --out dist/release || return 1
  cat dist/release/checksums.txt
  (cd "$PKG_DIR" && STARTER_VB_DIR="$STARTER_DIR/pb" bun test/exe-smoke.ts) || return 1
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
elif [ -n "$HOT" ]; then skip_step executables "hot mode: npm only, a normal run adds them"; echo "release $TAG: executables left to a normal run (hot mode)"
elif [ -z "${GH_TOKEN:-}" ]; then echo "release $TAG needs its executables but GH_TOKEN is not set"; exit 1
else step executables build_executables || exit 1; [ -z "$DRY" ] && outputs "executables=true"; fi
outputs "tag=$TAG"
if [ -z "${CI_NESTED:-}" ]; then step cache-save ./scripts/ci-cache.sh save || true; fi
echo; echo "release $TAG: done${DRY:+ (dry run)}${HOT:+ (hot mode)}"
