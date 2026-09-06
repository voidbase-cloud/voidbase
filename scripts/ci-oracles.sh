#!/usr/bin/env bash
# The oracle every CI run needs, resolved the same way on a dev machine, GitHub Actions and Workers Builds: the
# unmodified pocketbase-sveltekit-starter (pb_hooks, pb_migrations, the sk frontend). $STARTER_DIR when set, else the
# sibling checkout ../pocketbase-sveltekit-starter when it exists, else a shallow clone under .void/oracles.
# (The panel needs no step here: scripts/sync-panel.ts reads POCKETBASE_UI_DIST, else ../pocketbase/ui/dist, else
# downloads the pinned PocketBase tag.) Source it: `. scripts/ci-oracles.sh`; it exports STARTER_DIR, absolute.
_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STARTER_REPO="${STARTER_REPO:-https://github.com/spinspire/pocketbase-sveltekit-starter}"
if [ -z "${STARTER_DIR:-}" ]; then
  if [ -d "$_root/../pocketbase-sveltekit-starter/pb/pb_hooks" ]; then STARTER_DIR="$_root/../pocketbase-sveltekit-starter"
  else
    _oracles="${CI_CACHE_DIR:-$_root/.void}/oracles"; STARTER_DIR="$_oracles/pocketbase-sveltekit-starter"
    if [ -d "$STARTER_DIR/.git" ]; then git -C "$STARTER_DIR" pull --quiet --ff-only 2>/dev/null || echo "starter: pull failed, keeping the cached clone"
    else echo "cloning $STARTER_REPO into $_oracles"; mkdir -p "$_oracles"; git clone --quiet --depth 1 "$STARTER_REPO" "$STARTER_DIR" || { echo "clone failed"; return 1 2>/dev/null || exit 1; }; fi
  fi
fi
[ -d "$STARTER_DIR/pb/pb_hooks" ] || { echo "STARTER_DIR $STARTER_DIR has no pb/pb_hooks"; return 1 2>/dev/null || exit 1; }
STARTER_DIR="$(cd "$STARTER_DIR" && pwd)"; export STARTER_DIR
echo "starter: $STARTER_DIR"
