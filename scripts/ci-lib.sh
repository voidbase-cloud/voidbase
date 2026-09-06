#!/usr/bin/env bash
# Shared by scripts/ci.sh and scripts/release.sh: the step runner that records every step for the status page
# (scripts/ci-status.ts), backend detection, and daemon helpers that need nothing beyond bash and curl (the Workers
# Builds image has neither lsof nor jq). Source it after `cd` to the repository root.
ci_backend() { if [ -n "${WORKERS_CI_BUILD_UUID:-}" ] || [ "${WORKERS_CI:-}" = "1" ]; then echo cloudflare; elif [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo github; else echo local; fi; }
CI_STEPS_DIR="${CI_STEPS_DIR:-.void/ci-logs/steps}"; CI_STEPS_TSV="${CI_STEPS_TSV:-.void/ci-steps.tsv}"
ci_failed=0
# step <name> <command...>: runs the command in this shell (a function may export variables), shows its output live,
# keeps it in $CI_STEPS_DIR/<name>.log, records name / ok|fail / seconds, and returns the command's status
step() {
  local name="$1"; shift; local t0 rc log tp secs; t0=$(date +%s); log="$CI_STEPS_DIR/$name.log"; mkdir -p "$CI_STEPS_DIR"
  printf '\n=== %s\n' "$name"
  : > "$log"; tail -n +1 -f "$log" & tp=$!
  "$@" > "$log" 2>&1; rc=$?
  sleep 0.3; kill "$tp" 2>/dev/null; wait "$tp" 2>/dev/null
  secs=$(( $(date +%s) - t0 ))
  if [ "$rc" -eq 0 ]; then printf -- '--- %s: ok (%ss)\n' "$name" "$secs"; else ci_failed=$((ci_failed + 1)); printf -- '--- %s: FAILED (exit %s, %ss)\n' "$name" "$rc" "$secs"; fi
  printf '%s\t%s\t%s\t%s\n' "$name" "$([ "$rc" -eq 0 ] && echo ok || echo fail)" "$secs" "$log" >> "$CI_STEPS_TSV"
  return "$rc"
}
skip_step() { printf '%s\tskip\t0\t\n' "$1" >> "$CI_STEPS_TSV"; printf '\n=== %s: skipped%s\n' "$1" "${2:+ ($2)}"; }
# the plan scripts/ci-plan.ts wrote (.void/ci-plan.txt): plan_run <key> succeeds when the key runs, plan_reason <key>
# prints why, plan_list suites|bun prints the selected suites
plan_run() { grep -qE "^$1 run " .void/ci-plan.txt 2>/dev/null; }
plan_reason() { sed -n "s/^$1 [a-z]* //p" .void/ci-plan.txt 2>/dev/null | head -n 1; }
plan_list() { sed -n "s/^$1 //p" .void/ci-plan.txt 2>/dev/null | head -n 1; }
plan_flag() { grep -qE "^$1 yes" .void/ci-plan.txt 2>/dev/null; }
# ci_cache_dir: the directory kept between runs; on Workers Builds only the package manager cache survives a build,
# so it lives inside bun's (the dependencies cache the build system restores and uploads)
ci_cache_dir() { if [ -n "${CI_CACHE_DIR:-}" ]; then echo "$CI_CACHE_DIR"; elif [ "$(ci_backend)" = cloudflare ]; then echo "$HOME/.bun/install/cache/voidbase-ci"; else echo "${XDG_CACHE_HOME:-$HOME/.cache}/voidbase-ci"; fi; }
# port_busy <port>: something listens on 127.0.0.1:<port>
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
# wait_http <url> [tries=60]: until the URL answers
wait_http() { curl --retry "${2:-60}" --retry-delay 1 --retry-all-errors -s -o /dev/null "$1"; }
# daemon <name> <log> <command...>: a detached process group whose pid is kept in .void/ci-<name>.pid
daemon() { local name="$1" log="$2"; shift 2; ( setsid nohup "$@" > "$log" 2>&1 < /dev/null & echo $! > ".void/ci-$name.pid" ); }
# stop_daemon <name>: ends the process group started by daemon
stop_daemon() { local f=".void/ci-$1.pid" pid; [ -f "$f" ] || return 0; pid=$(cat "$f"); kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null; rm -f "$f"; }
# render_status [--kind ci|release]: the status page from the recorded steps (ci/public)
render_status() { bun scripts/ci-status.ts render "$@"; }
