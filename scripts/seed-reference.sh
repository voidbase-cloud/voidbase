#!/usr/bin/env bash
# Prepares and starts a reference PocketBase for the differential suites: downloads the release binary, runs the
# starter's pb_migrations and pb_hooks, upserts the superuser and creates the app user the suites expect.
#   scripts/seed-reference.sh <dir> [port=8090] [version=0.39.11] [starter=../pocketbase-sveltekit-starter]
#   scripts/seed-reference.sh stop <dir>
set -euo pipefail
if [ "${1:-}" = "stop" ]; then d="$2"; [ -f "$d/pb.pid" ] && { kill -TERM -- "-$(cat "$d/pb.pid")" 2>/dev/null || kill -TERM "$(cat "$d/pb.pid")" 2>/dev/null || true; rm -f "$d/pb.pid"; echo "stopped"; }; exit 0; fi
DIR="${1:?dir}"; PORT="${2:-8090}"; VERSION="${3:-0.39.11}"; STARTER="${4:-../pocketbase-sveltekit-starter}"
SU_EMAIL="${VOIDBASE_SUPERUSER_EMAIL:-admin@example.com}"; SU_PASSWORD="${VOIDBASE_SUPERUSER_PASSWORD:-changeme123}"
USER_EMAIL="${REFERENCE_USER_EMAIL:-user@example.com}"; USER_PASSWORD="${REFERENCE_USER_PASSWORD:-changeme123}"
mkdir -p "$DIR"; STARTER="$(cd "$STARTER" && pwd)"
if [ ! -x "$DIR/pocketbase" ] || [ "$("$DIR/pocketbase" --version 2>/dev/null)" != "pocketbase version $VERSION" ]; then
  arch="linux_amd64"; case "$(uname -m)" in aarch64|arm64) arch="linux_arm64";; esac
  cached="${CI_CACHE_DIR:+$CI_CACHE_DIR/archives/pocketbase_${VERSION}_${arch}.zip}"
  if [ -n "$cached" ] && [ -f "$cached" ]; then echo "pocketbase $VERSION ($arch) from the cache"; cp "$cached" "$DIR/pb.zip"
  else
    echo "downloading pocketbase $VERSION ($arch)"
    curl -sSL "https://github.com/pocketbase/pocketbase/releases/download/v${VERSION}/pocketbase_${VERSION}_${arch}.zip" -o "$DIR/pb.zip"
    if [ -n "$cached" ]; then mkdir -p "$CI_CACHE_DIR/archives" && cp "$DIR/pb.zip" "$cached"; fi
  fi
  (cd "$DIR" && unzip -oq pb.zip pocketbase && rm pb.zip)
fi
PB=("$DIR/pocketbase" "--dir" "$DIR/pb_data" "--migrationsDir" "$STARTER/pb/pb_migrations" "--hooksDir" "$STARTER/pb/pb_hooks")
"${PB[@]}" superuser upsert "$SU_EMAIL" "$SU_PASSWORD" >/dev/null
# the starter's hooks read AUDITLOG like its Docker entrypoint sets it
AUDITLOG="${AUDITLOG:-posts,users}" setsid nohup "${PB[@]}" serve --automigrate=0 --http "127.0.0.1:$PORT" > "$DIR/pb.log" 2>&1 < /dev/null &
echo $! > "$DIR/pb.pid"
curl --retry 60 --retry-delay 1 --retry-all-errors -s -o /dev/null "http://127.0.0.1:$PORT/api/health"
TOKEN=$(curl -s -X POST "http://127.0.0.1:$PORT/api/collections/_superusers/auth-with-password" -H "content-type: application/json" -d "{\"identity\":\"$SU_EMAIL\",\"password\":\"$SU_PASSWORD\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
existing=$(curl -s "http://127.0.0.1:$PORT/api/collections/users/records?filter=email%3D%27$USER_EMAIL%27" -H "authorization: $TOKEN" | sed -n 's/.*"totalItems":\([0-9]*\).*/\1/p')
if [ "${existing:-0}" = "0" ]; then
  curl -s -o /dev/null -w "user $USER_EMAIL: HTTP %{http_code}\n" -X POST "http://127.0.0.1:$PORT/api/collections/users/records" -H "content-type: application/json" -H "authorization: $TOKEN" -d "{\"email\":\"$USER_EMAIL\",\"password\":\"$USER_PASSWORD\",\"passwordConfirm\":\"$USER_PASSWORD\"}"
fi
echo "reference pocketbase $VERSION on http://127.0.0.1:$PORT (pid $(cat "$DIR/pb.pid"), data $DIR/pb_data)"
