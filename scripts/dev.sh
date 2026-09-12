#!/usr/bin/env bash
# Start/stop the Vite+Void dev server in the background with a pidfile (used by the test harnesses).
#   scripts/dev.sh start [port]   scripts/dev.sh stop   scripts/dev.sh status   scripts/dev.sh log
# The server is the app in packages/voidbase (void.json is there), so that is where vp runs; the pidfile and the
# log stay at the repository root, which is where scripts/ci.sh and scripts/ci-suites.sh read them.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT/packages/voidbase"
PORT="${2:-${PORT:-5180}}"
PIDFILE="$ROOT/.void/dev.pid"; LOG="$ROOT/.void/dev.log"
mkdir -p "$ROOT/.void"
running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
case "${1:-status}" in
  start)
    if running; then echo "already running (pid $(cat "$PIDFILE"))"; exit 0; fi
    setsid nohup "$ROOT/node_modules/.bin/vp" dev --port "$PORT" --host 127.0.0.1 > "$LOG" 2>&1 < /dev/null &
    echo $! > "$PIDFILE"
    echo "started pid $! on http://127.0.0.1:$PORT (log: $LOG)"
    curl --retry 90 --retry-delay 1 --retry-all-errors -s -o /dev/null -w "ready: HTTP %{http_code} for /api/health\n" "http://127.0.0.1:$PORT/api/health" ;;
  stop)
    if running; then
      pid="$(cat "$PIDFILE")"
      # setsid made $pid a group leader: signal the whole group so vite and workerd children die too
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
      for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
      kill -0 "$pid" 2>/dev/null && { kill -KILL -- "-$pid" 2>/dev/null; sleep 0.5; }
      echo "stopped"
    else echo "not running"; fi
    rm -f "$PIDFILE" ;;
  status) if running; then echo "running (pid $(cat "$PIDFILE"))"; else echo "not running"; fi ;;
  log) tail -n "${2:-40}" "$LOG" ;;
esac
