#!/usr/bin/env bash
# The whole CI flow in one script (docs/ci.md), the same on a dev machine and on Cloudflare Workers Builds (GitHub
# Actions only starts the builds): commit messages, typecheck and unit tests, the differential and panel suites against a reference
# PocketBase, the same suites on the Bun runtime, the deploy dry run, the production-build boots, the prebuilt
# executable and the unmodified starter. Every step is recorded for the status page (ci/public, scripts/ci-status.ts);
# the script stops at the first failed step and exits non-zero. It stops the servers it started when it ends.
#   scripts/ci.sh
# Environment: STARTER_DIR (scripts/ci-oracles.sh resolves it), CHROME_PATH (scripts/ci-browser.sh finds or provisions
# a Chrome), CI_BROWSER=0 skips the browser suites, CI_PORT (5180) and CI_PB_PORT (8090) for voidbase and the reference,
# CI_CACHE_DIR for the downloads kept between runs, CI_STATUS_URL for the record of the last green run
# (scripts/ci-plan.ts skips what that run already verified on the same inputs; CI_PLAN=full runs everything).
set -uo pipefail
cd "$(dirname "$0")/.."; ROOT="$PWD"
. scripts/ci-lib.sh
export VOIDBASE_SUPERUSER_EMAIL="${VOIDBASE_SUPERUSER_EMAIL:-admin@example.com}"
export VOIDBASE_SUPERUSER_PASSWORD="${VOIDBASE_SUPERUSER_PASSWORD:-changeme123}"
export AUDITLOG="${AUDITLOG:-posts,users}" VOIDBASE_LOG_MIN_LEVEL=0
BACKEND=$(ci_backend); export CI_BACKEND_NAME="$BACKEND"
PORT="${CI_PORT:-5180}"; PB_PORT="${CI_PB_PORT:-8090}"; VB="http://127.0.0.1:$PORT"; PB="http://127.0.0.1:$PB_PORT"
LOGS="$ROOT/.void/ci-logs"; rm -rf "$LOGS" "$CI_STEPS_TSV" .void/ci-plan.txt .void/ci-plan.json; mkdir -p "$LOGS"
CI_CACHE_DIR="$(ci_cache_dir)"; export CI_CACHE_DIR; mkdir -p "$CI_CACHE_DIR"
started_pb=0; booted=0
echo "voidbase ci on $BACKEND: $(git rev-parse --short HEAD 2>/dev/null || echo '?') $(git log -1 --format=%s 2>/dev/null | cut -c1-80), bun $(bun --version)"
echo "cache: $CI_CACHE_DIR ($(du -sh "$CI_CACHE_DIR" 2>/dev/null | cut -f1 || echo empty))"

cleanup() {
  local rc=$?
  ./scripts/starter.sh stop >/dev/null 2>&1 || true
  ./scripts/dev.sh stop >/dev/null 2>&1 || true
  for d in serve smtp-sink mock-oidc s3-mock cf-mock; do stop_daemon "$d"; done
  if [ "$started_pb" = 1 ] && [ -f .void/reference/pb.pid ]; then kill "$(cat .void/reference/pb.pid)" 2>/dev/null || true; fi
  if [ -f .void/ci-env.backup ]; then mv .void/ci-env.backup .env; fi
  if [ "$rc" != 0 ]; then
    echo; echo "--- dev.log"; tail -n 60 .void/dev.log 2>/dev/null; echo "--- reference"; tail -n 30 .void/reference/pb.log 2>/dev/null
    for f in "$LOGS"/*.log "$LOGS"/bun/*.log; do [ -f "$f" ] && grep -qE "^FAIL" "$f" 2>/dev/null && { echo "--- $f"; grep -E "^FAIL|Error|error:" "$f" | head -8; }; done
  fi
  render_status --kind ci || true
  if [ "$rc" = 0 ]; then echo "CI PASSED"; else echo "CI FAILED (exit $rc)"; fi
}
trap cleanup EXIT

install() { bun install --frozen-lockfile; }
commitlint_check() {  # the commits this run introduces; the last one when there is nothing to compare with
  local from="" to="HEAD"
  if [ "$BACKEND" = github ] && [ "${GITHUB_EVENT_NAME:-}" = pull_request ]; then
    from=$(bun -e 'const e = await Bun.file(process.env.GITHUB_EVENT_PATH!).json(); console.log(e.pull_request.base.sha)'); to=$(bun -e 'const e = await Bun.file(process.env.GITHUB_EVENT_PATH!).json(); console.log(e.pull_request.head.sha)')
  elif [ "$BACKEND" = github ]; then
    from=$(bun -e 'const e = await Bun.file(process.env.GITHUB_EVENT_PATH!).json(); console.log(e.before ?? "")'); [ "$from" = "0000000000000000000000000000000000000000" ] && from=""
  elif [ "$BACKEND" = cloudflare ] && [ "${WORKERS_CI_BRANCH:-master}" != master ]; then
    git fetch --quiet --depth=200 origin master 2>/dev/null && from=$(git merge-base origin/master HEAD 2>/dev/null || true)
  elif [ "$BACKEND" = local ]; then from=$(git merge-base origin/master HEAD 2>/dev/null || true); fi
  if [ -n "$from" ] && [ "$from" != "$(git rev-parse "$to")" ] && git cat-file -e "$from" 2>/dev/null; then node_modules/.bin/commitlint --from "$from" --to "$to" --verbose; else node_modules/.bin/commitlint --last --verbose; fi
}
oracles() {  # the starter and the panel next to a production-shaped public/ (the SPA shell the boot test checks)
  . scripts/ci-oracles.sh
  XDG_CACHE_HOME="$CI_CACHE_DIR/xdg" bun run panel:sync   # scripts/sync-panel.ts keeps the panel tarball under it
  # the starter's frontend build is kept with the clone and reused while the starter's commit is the same
  local head stamp; head=$(git -C "$STARTER_DIR" rev-parse HEAD 2>/dev/null || echo none); stamp="$STARTER_DIR/sk/build/.voidbase-ci-stamp"
  if [ -d "$STARTER_DIR/sk/build" ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$head" ]; then echo "starter frontend build reused ($head)"
  else (cd "$STARTER_DIR/sk" && bun install --frozen-lockfile && bunx svelte-kit sync && bun run build) && echo "$head" > "$stamp"; fi
  VOIDBASE_APP_DIR="$STARTER_DIR/sk/build" bun run app:sync
  ./node_modules/.bin/void prepare
}
plan() { bun scripts/ci-plan.ts; }
cache_restore() { ./scripts/ci-cache.sh restore; }
cache_save() { ./scripts/ci-cache.sh save; }
typecheck() { bunx tsc --noEmit -p tsconfig.json && bunx tsc --noEmit -p tsconfig.node.json && bunx tsc --noEmit -p tsconfig.scripts.json; }
unit() { bun test; }
browser() { local exports; exports=$(./scripts/ci-browser.sh) || return 1; eval "$exports"; echo "$exports"; }
boot() {
  # the Worker reads its vars from .env (Void bakes them), not from the shell: the run writes its own values so both
  # sides serve the same starter; a dev machine's file is put back when the run ends (cleanup)
  if [ -f .env ] && [ ! -f .void/ci-env.backup ]; then cp .env .void/ci-env.backup; fi
  printf 'VOIDBASE_SUPERUSER_EMAIL=%s\nVOIDBASE_SUPERUSER_PASSWORD=%s\nVOIDBASE_HOOKS_DIR=%s\nVOIDBASE_MIGRATIONS_DIR=%s\nAUDITLOG=%s\nVOIDBASE_LOG_MIN_LEVEL=0\n' "$VOIDBASE_SUPERUSER_EMAIL" "$VOIDBASE_SUPERUSER_PASSWORD" "$STARTER_DIR/pb/pb_hooks" "$STARTER_DIR/pb/pb_migrations" "$AUDITLOG" > .env
  ./node_modules/.bin/void db migrate
  ./scripts/dev.sh start "$PORT" && booted=1
  ./scripts/seed-app-user.sh "$VB"
  warm_up
}
warm_up() {  # first requests to the paths whose dependencies Vite+ optimizes on first use (a reload that would lose a
  # suite's in-flight work, such as a queued mail), then wait until the optimizer has been quiet for a few seconds
  local j='content-type: application/json'
  curl -s -o /dev/null -X POST "$VB/api/collections/users/auth-with-password" -H "$j" -d '{"identity":"user@example.com","password":"changeme123"}'
  curl -s -o /dev/null -X POST "$VB/api/collections/users/request-password-reset" -H "$j" -d '{"email":"user@example.com"}'
  curl -s -o /dev/null "$VB/api/collections/users/auth-methods"
  curl -s -o /dev/null -m 2 "$VB/api/realtime" || true
  curl -s -o /dev/null "$VB/api/collections/posts/records?perPage=1"
  local before after; for _ in $(seq 1 20); do before=$(grep -cE "optimized|program reload" .void/dev.log 2>/dev/null); sleep 3; after=$(grep -cE "optimized|program reload" .void/dev.log 2>/dev/null); [ "$before" = "$after" ] && break; done
  wait_http "$VB/api/health" 30; echo "warm: optimizer quiet after $after optimization(s)"
}
helper() { local name="$1" port="$2"; shift 2; if port_busy "$port"; then echo "reusing $name on $port"; else daemon "$name" ".void/$name.log" "$@"; echo "started $name on $port"; fi; }
reference() {
  if port_busy "$PB_PORT"; then echo "reusing the PocketBase listening on $PB"; else ./scripts/seed-reference.sh .void/reference "$PB_PORT" 0.39.11 "$STARTER_DIR" && started_pb=1; fi
  helper smtp-sink 2525 bun test/smtp-sink.ts
  helper mock-oidc 5190 bun test/mock-oidc.ts
  helper s3-mock 5195 bun test/s3-mock.ts
  helper cf-mock 5197 bun test/cf-mock.ts
  sleep 2
}
# shellcheck disable=SC2086
suites() { ./scripts/ci-suites.sh "$PB" "$VB" $(plan_list suites); }
suites_bun() {  # the selected suites against `voidbase serve` (Bun runtime, SQLite + local files)
  [ "$booted" = 1 ] && ./scripts/dev.sh stop
  rm -rf .void/ci-serve; mkdir -p .void/ci-serve
  daemon serve .void/serve.log bun bin/voidbase.ts serve --http 127.0.0.1:8093 --dir .void/ci-serve/pb_data --hooksDir "$STARTER_DIR/pb/pb_hooks" --migrationsDir "$STARTER_DIR/pb/pb_migrations"
  wait_http http://127.0.0.1:8093/api/health 60
  ./scripts/seed-app-user.sh http://127.0.0.1:8093
  # shellcheck disable=SC2086
  CI_BROWSER=0 CI_LOGS="$LOGS/bun" ./scripts/ci-suites.sh "$PB" http://127.0.0.1:8093 $(plan_list bun); local rc=$?
  stop_daemon serve
  [ "$booted" = 1 ] && ./scripts/dev.sh start "$PORT"
  return "$rc"
}
deploy_cf() { bun test/deploy-cf.ts; }
adapter() { bun test/adapter.ts; }   # a Void app converted into a voidbase app, then run
fresh_db() { bun test/fresh-db.ts 5181; }
mail_http() { bun test/mail-http.ts 5184; }
exe_smoke() { STARTER_VB_DIR="$STARTER_DIR/pb" bun test/exe-smoke.ts; }
starter() {  # the unmodified starter frontend against voidbase
  STARTER_SK_DIR="$STARTER_DIR/sk" ./scripts/starter.sh start 5174 "$VB"
  bun test/starter-smoke.ts http://127.0.0.1:5174 "$LOGS/starter.png"
}

release_work() {  # release-please, npm and the executables in this build (docs/releasing.md): on master, when the
  # commits ask for it or a release still needs publishing; hot mode publishes to npm and leaves the executables
  local branch; branch="${WORKERS_CI_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null)}"
  if [ "$branch" != master ]; then skip_step release "not master"; return 0; fi
  if [ -z "${GH_TOKEN:-}" ]; then skip_step release "no GH_TOKEN"; return 0; fi
  local why=""; plan_flag release-merge && why="the release PR was merged"; plan_flag release-pr && why="${why:-releasable commits, refreshing the release PR}"; plan_flag release-dry-run && why="${why:-dry run requested by a commit}"
  if [ -z "$why" ]; then  # a release that still needs publishing or its executables: cut by hand, or left by hot mode
    local v rel; v=$(node -p "require('./package.json').version"); rel=$(bun scripts/gh-release.ts view "v$v" 2>/dev/null) || rel=""
    if [ -n "$rel" ]; then
      if ! npm view "@voidbase-cloud/voidbase@$v" version >/dev/null 2>&1; then why="release v$v is not on npm yet"
      elif ! printf '%s' "$rel" | grep -q checksums.txt && [ "${CI_HOT:-0}" != 1 ]; then why="release v$v has no executables yet"; fi
    fi
  fi
  if [ -z "$why" ]; then skip_step release "nothing to release"; return 0; fi
  echo; echo "=== release: $why"
  local args=(); plan_flag release-pr || args+=(--no-pr); [ "${CI_HOT:-0}" = 1 ] && args+=(--hot); plan_flag release-dry-run && args+=(--dry-run)
  export CI_STEPS_DIR CI_STEPS_TSV; CI_NESTED=1 bash scripts/release.sh "${args[@]}"
}
run() { step "$@" || exit 1; }
# maybe <step> <command...>: the step when the plan selects it, else a recorded skip
maybe() { local name="$1"; shift; if plan_run "step:$name"; then run "$name" "$@"; else skip_step "$name" "$(plan_reason "step:$name")"; fi; }
run install install
run cache-restore cache_restore
run commitlint commitlint_check
run plan plan
maybe oracles oracles
maybe typecheck typecheck
maybe unit unit
maybe browser browser
maybe boot boot
maybe reference reference
maybe suites suites
maybe suites-bun suites_bun
maybe deploy-cf deploy_cf
maybe adapter adapter
maybe fresh-db fresh_db
maybe mail-http mail_http
maybe exe-smoke exe_smoke
maybe starter starter
release_work || exit 1
run cache-save cache_save
echo; echo "every selected step passed"
