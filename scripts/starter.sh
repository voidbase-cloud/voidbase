#!/usr/bin/env bash
# Runs the unmodified pocketbase-sveltekit-starter frontend (sk) against voidbase instead of PocketBase.
#   scripts/starter.sh start [port] [backend]   scripts/starter.sh stop   scripts/starter.sh log
set -u
cd "$(dirname "$0")/.."
SK="${STARTER_SK_DIR:-../pocketbase-sveltekit-starter/sk}"
PORT="${2:-5174}"; BACKEND="${3:-http://127.0.0.1:5180}"
PIDFILE=".void/starter.pid"; LOG=".void/starter.log"
mkdir -p .void
running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
case "${1:-status}" in
  start)
    if running; then echo "already running (pid $(cat "$PIDFILE"))"; exit 0; fi
    ( cd "$SK" && POCKETBASE_URL="$BACKEND" setsid nohup ./node_modules/.bin/vite dev --port "$PORT" --host 127.0.0.1 --strictPort > "$OLDPWD/$LOG" 2>&1 < /dev/null & echo $! > "$OLDPWD/$PIDFILE" )
    echo "started pid $(cat "$PIDFILE") on http://127.0.0.1:$PORT -> $BACKEND (log: $LOG)"
    curl --retry 60 --retry-delay 1 --retry-all-errors -s -o /dev/null -w "ready: HTTP %{http_code}\n" "http://127.0.0.1:$PORT/" ;;
  stop)
    if running; then pid="$(cat "$PIDFILE")"; kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null; for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done; kill -0 "$pid" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null; echo "stopped"; else echo "not running"; fi
    rm -f "$PIDFILE" ;;
  status) if running; then echo "running (pid $(cat "$PIDFILE"))"; else echo "not running"; fi ;;
  log) tail -n "${2:-40}" "$LOG" ;;
esac
