#!/usr/bin/env bash
# Runs every differential and browser suite against a reference PocketBase and a voidbase, printing one line per
# suite and failing if any suite fails. Needs test/smtp-sink.ts (2525/2526) and test/mock-oidc.ts (5190) running.
#   scripts/ci-suites.sh [pb=http://127.0.0.1:8090] [vb=http://127.0.0.1:5180] [suites...]
set -u
cd "$(dirname "$0")/.."
PB="${1:-http://127.0.0.1:8090}"; VB="${2:-http://127.0.0.1:5180}"; shift 2 2>/dev/null || true
LOGS="${CI_LOGS:-.void/ci-logs}"; mkdir -p "$LOGS"
POSITIONAL="auth-flows backups batch cascade filter-corpus filters-extra hardening logs-crons manage-rule oauth2 otp-mfa protected-files providers rules security settings sql thumbs views"
FLAGGED="compare records realtime collections"
fail=0; run() { local name="$1"; shift; if timeout 900 "$@" > "$LOGS/$name.log" 2>&1; then echo "PASS  $name  $(tail -1 "$LOGS/$name.log" | cut -c1-90)"; else fail=$((fail+1)); echo "FAIL  $name  (see $LOGS/$name.log)"; grep -E "^FAIL|Error|error:" "$LOGS/$name.log" | head -5 | sed 's/^/      /'; fi; }
SEL="${*:-all}"
want() { [ "$SEL" = "all" ] || [[ " $SEL " == *" $1 "* ]]; }
for s in $POSITIONAL; do want "$s" && run "$s" bun "test/conformance/$s.ts" "$PB" "$VB"; done
for s in $FLAGGED; do want "$s" && run "$s" bun "test/conformance/$s.ts" --pb "$PB" --vb "$VB"; done
want sdk-suite && run sdk-suite bun test/sdk-suite.ts "$PB" "$VB"
want unit && run unit bun test
if [ "${CI_BROWSER:-1}" = "1" ]; then
  want panel-smoke && run panel-smoke bun test/panel-smoke.ts "$VB" "$LOGS/panel.png"
  want panel-collections && run panel-collections bun test/panel-collections.ts "$VB" "$LOGS/panel-collections.png"
  want panel-records && run panel-records bun test/panel-records.ts "$VB" "$LOGS/panel-records.png"
  want panel-admin && run panel-admin bun test/panel-admin.ts "$VB"
  want panel-login && run panel-login bun test/panel-login.ts "$PB" "$VB"
fi
echo; [ "$fail" = 0 ] && echo "ALL SUITES PASSED" || echo "$fail SUITE(S) FAILED"
exit $fail
