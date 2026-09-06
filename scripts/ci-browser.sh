#!/usr/bin/env bash
# Finds or provisions the Chrome the browser suites launch (playwright's chromium.launch with CHROME_PATH):
#   1. $CHROME_PATH when it is an executable
#   2. google-chrome / chromium on PATH (GitHub's runners, dev machines)
#   3. otherwise Playwright's chromium-headless-shell under .void/browsers and, when the machine lacks them, the shared
#      libraries it needs, taken from Ubuntu's packages into .void/chrome-libs without root: the Workers Builds image
#      (Ubuntu 24.04) ships neither Chrome nor sudo, so the packages are fetched into a private apt root and unpacked
# Prints `export CHROME_PATH=...` (plus LD_LIBRARY_PATH when the unpacked libraries are needed) for
# `eval "$(scripts/ci-browser.sh)"`; progress goes to stderr. CI_BROWSER_DOWNLOAD=1 forces step 3,
# CI_BROWSER_LIBS=always forces the package unpacking (both for testing the path on a machine that has Chrome).
set -u
cd "$(dirname "$0")/.."
log() { echo "browser: $*" >&2; }
found() { echo "export CHROME_PATH='$1'"; [ -n "${2:-}" ] && echo "export LD_LIBRARY_PATH='$2${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}'"; exit 0; }
if [ "${CI_BROWSER_DOWNLOAD:-0}" != "1" ]; then
  if [ -n "${CHROME_PATH:-}" ] && [ -x "$CHROME_PATH" ]; then log "using CHROME_PATH $CHROME_PATH"; found "$CHROME_PATH"; fi
  for c in google-chrome google-chrome-stable chromium chromium-browser; do p=$(command -v "$c" 2>/dev/null) && { log "using $p"; found "$p"; }; done
fi
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.void/browsers"
find_shell() { find "$PLAYWRIGHT_BROWSERS_PATH" -type f -name chrome-headless-shell 2>/dev/null | head -1; }
CHROME=$(find_shell)
if [ -z "$CHROME" ]; then
  log "downloading Playwright's chromium-headless-shell into .void/browsers"
  ./node_modules/.bin/playwright install chromium-headless-shell >&2 || { log "playwright install failed"; exit 1; }
  CHROME=$(find_shell)
fi
[ -n "$CHROME" ] || { log "no chrome-headless-shell under $PLAYWRIGHT_BROWSERS_PATH"; exit 1; }
LIBS="$PWD/.void/chrome-libs"; LIBDIR="$LIBS/usr/lib/x86_64-linux-gnu"
missing() { LD_LIBRARY_PATH="$LIBDIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ldd "$CHROME" 2>/dev/null | awk '/not found/ { print $1 }'; }
if [ -n "$(missing)" ] || [ "${CI_BROWSER_LIBS:-}" = "always" ]; then
  # what Playwright's `install-deps` would apt-get for chromium on Ubuntu 24.04 (playwright-core's nativeDeps table)
  PKGS="libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libfontconfig1 libfreetype6"
  log "shared libraries missing: $(missing | tr '\n' ' ')- unpacking Ubuntu packages into .void/chrome-libs"
  APTROOT="$PWD/.void/apt"; mkdir -p "$APTROOT/state/lists/partial" "$APTROOT/cache/archives/partial" "$APTROOT/debs" "$LIBS"
  APT=(apt-get -q -o "Dir::State=$APTROOT/state" -o "Dir::Cache=$APTROOT/cache" -o Dir::State::status=/var/lib/dpkg/status -o Debug::NoLocking=1 -o APT::Sandbox::User=root)
  "${APT[@]}" update >&2 2>&1 || log "apt-get update reported errors (continuing with what it fetched)"
  # shellcheck disable=SC2086
  (cd "$APTROOT/debs" && "${APT[@]}" download $PKGS >&2 2>&1) || log "some packages did not download"
  for d in "$APTROOT"/debs/*.deb; do [ -f "$d" ] && dpkg-deb -x "$d" "$LIBS"; done
  still=$(missing); if [ -n "$still" ]; then log "still missing after unpacking: $(echo $still)"; exit 1; fi
  log "libraries unpacked under .void/chrome-libs ($(find "$LIBDIR" -name '*.so*' | wc -l) files)"
fi
if [ -d "$LIBDIR" ] && ldd "$CHROME" 2>/dev/null | grep -q "not found"; then log "using $CHROME with .void/chrome-libs"; found "$CHROME" "$LIBDIR"; fi
if [ -d "$LIBDIR" ] && [ "${CI_BROWSER_LIBS:-}" = "always" ]; then log "using $CHROME with .void/chrome-libs (forced)"; found "$CHROME" "$LIBDIR"; fi
log "using $CHROME"; found "$CHROME"
