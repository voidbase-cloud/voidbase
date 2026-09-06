#!/usr/bin/env bash
# The cache Workers Builds does not keep between builds (docs/ci.md, "What is kept between runs"): CI_CACHE_DIR is
# restored from and saved to an R2 bucket through Cloudflare's API, one archive per component, uploaded only when its
# content changed since it was restored. Without CI_CACHE_TOKEN (an API token with Workers R2 Storage edit),
# CI_CACHE_ACCOUNT and CI_CACHE_BUCKET the script does nothing, so a dev machine just keeps its local directory.
#   scripts/ci-cache.sh restore      the components missing locally
#   scripts/ci-cache.sh save         the components whose content changed
# Components are the directories of CI_CACHE_DIR: browsers, chrome-libs, apt (scripts/ci-browser.sh), oracles
# (scripts/ci-oracles.sh), xdg (the panel, scripts/sync-panel.ts), archives (the reference PocketBase).
set -u
COMPONENTS="browsers chrome-libs apt oracles xdg archives"
DIR="${CI_CACHE_DIR:?CI_CACHE_DIR}"; mkdir -p "$DIR/.stamps"
enabled() { [ -n "${CI_CACHE_TOKEN:-}" ] && [ -n "${CI_CACHE_ACCOUNT:-}" ] && [ -n "${CI_CACHE_BUCKET:-}" ]; }
if command -v zstd >/dev/null 2>&1; then EXT="tar.zst"; TAR_C=(tar -I zstd -cf); TAR_X=(tar -I zstd -xf); else EXT="tar.gz"; TAR_C=(tar -czf); TAR_X=(tar -xzf); fi
url() { echo "https://api.cloudflare.com/client/v4/accounts/$CI_CACHE_ACCOUNT/r2/buckets/$CI_CACHE_BUCKET/objects/ci-cache/$1.$EXT"; }
stamp() { (cd "$DIR" && find "$1" -type f -printf '%p %s %T@\n' 2>/dev/null | sort | sha256sum | cut -c1-16); }
restore() {
  for c in $COMPONENTS; do
    if [ -d "$DIR/$c" ]; then echo "cache: $c present locally"; continue; fi
    tmp="$DIR/.$c.$EXT"
    if curl -fsS -o "$tmp" -H "Authorization: Bearer $CI_CACHE_TOKEN" "$(url "$c")" 2>/dev/null; then
      if "${TAR_X[@]}" "$tmp" -C "$DIR"; then stamp "$c" > "$DIR/.stamps/$c"; echo "cache: $c restored ($(du -sh "$DIR/$c" 2>/dev/null | cut -f1))"; else echo "cache: $c archive unreadable, ignored"; rm -rf "$DIR/$c"; fi
    else echo "cache: $c not in the bucket yet"; fi
    rm -f "$tmp"
  done
}
save() {
  for c in $COMPONENTS; do
    [ -d "$DIR/$c" ] || continue
    now=$(stamp "$c"); if [ "$now" = "$(cat "$DIR/.stamps/$c" 2>/dev/null)" ]; then echo "cache: $c unchanged"; continue; fi
    tmp="$DIR/.$c.$EXT"
    (cd "$DIR" && "${TAR_C[@]}" "$tmp" "$c") || { echo "cache: $c could not be archived"; rm -f "$tmp"; continue; }
    if curl -fsS -o /dev/null -X PUT -H "Authorization: Bearer $CI_CACHE_TOKEN" --data-binary "@$tmp" "$(url "$c")"; then echo "$now" > "$DIR/.stamps/$c"; echo "cache: $c saved ($(du -h "$tmp" | cut -f1))"; else echo "cache: $c upload failed"; fi
    rm -f "$tmp"
  done
}
case "${1:-}" in
  restore|save) if enabled; then "$1"; else echo "cache: no bucket configured (CI_CACHE_TOKEN, CI_CACHE_ACCOUNT, CI_CACHE_BUCKET), local directory only"; fi ;;
  *) echo "usage: scripts/ci-cache.sh restore|save"; exit 2 ;;
esac
