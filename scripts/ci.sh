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
cd "$(dirname "$0")/.."; ROOT="$PWD"; PKG="$ROOT/packages/voidbase"
. scripts/ci-lib.sh
export VOIDBASE_SUPERUSER_EMAIL="${VOIDBASE_SUPERUSER_EMAIL:-admin@example.com}"
export VOIDBASE_SUPERUSER_PASSWORD="${VOIDBASE_SUPERUSER_PASSWORD:-changeme123}"
export AUDITLOG="${AUDITLOG:-posts,users}" VOIDBASE_LOG_MIN_LEVEL=0
# `bun run build` means the CI suite when automation calls it (scripts/pipeline.ts). Anything this script
# starts is already inside the suite, so for those it means this project's Vite build, and cannot recurse.
export VOIDBASE_CI_INNER=1
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
  stop_reference
  if [ -f .void/ci-env.backup ]; then mv .void/ci-env.backup "$PKG/.env"; fi
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
  XDG_CACHE_HOME="$CI_CACHE_DIR/xdg" bun run panel:sync   # packages/voidbase/scripts/sync-panel.ts keeps the panel tarball under it
  # the starter's frontend build is kept with the clone and reused while the starter's commit is the same
  local head stamp; head=$(git -C "$STARTER_DIR" rev-parse HEAD 2>/dev/null || echo none); stamp="$STARTER_DIR/sk/build/.voidbase-ci-stamp"
  if [ -d "$STARTER_DIR/sk/build" ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$head" ]; then echo "starter frontend build reused ($head)"
  else (cd "$STARTER_DIR/sk" && bun install --frozen-lockfile && bunx svelte-kit sync && bun run build) && echo "$head" > "$stamp"; fi
  VOIDBASE_APP_DIR="$STARTER_DIR/sk/build" bun run app:sync
  (cd "$PKG" && "$ROOT/node_modules/.bin/void" prepare)
}
plan() { bun scripts/ci-plan.ts; }
cache_restore() { ./scripts/ci-cache.sh restore; }
cache_save() { ./scripts/ci-cache.sh save; }
typecheck() {
  ./node_modules/.bin/tsc --noEmit -p "$PKG/tsconfig.json" && ./node_modules/.bin/tsc --noEmit -p "$PKG/tsconfig.node.json" || return 1
  # each extracted plugin package's own program, globbed rather than listed so the next extraction needs no edit
  # here. The core's published sources are TypeScript and join that program, so this pass is what says a package is
  # still self-contained rather than leaning on the core's own tsconfig.
  for t in packages/plugin-*/tsconfig.json; do [ -f "$t" ] || continue; ./node_modules/.bin/tsc --noEmit -p "$t" || return 1; done
  ./node_modules/.bin/tsc --noEmit -p tsconfig.scripts.json
}
unit() { bun test; }
browser() { local exports; exports=$(./scripts/ci-browser.sh) || return 1; eval "$exports"; echo "$exports"; }
boot() {
  # the Worker reads its vars from .env (Void bakes them), not from the shell: the run writes its own values so both
  # sides serve the same starter; a dev machine's file is put back when the run ends (cleanup)
  if [ -f "$PKG/.env" ] && [ ! -f .void/ci-env.backup ]; then cp "$PKG/.env" .void/ci-env.backup; fi
  printf 'VOIDBASE_SUPERUSER_EMAIL=%s\nVOIDBASE_SUPERUSER_PASSWORD=%s\nVOIDBASE_HOOKS_DIR=%s\nVOIDBASE_MIGRATIONS_DIR=%s\nAUDITLOG=%s\nVOIDBASE_LOG_MIN_LEVEL=0\n' "$VOIDBASE_SUPERUSER_EMAIL" "$VOIDBASE_SUPERUSER_PASSWORD" "$STARTER_DIR/pb/pb_hooks" "$STARTER_DIR/pb/pb_migrations" "$AUDITLOG" > "$PKG/.env"
  (cd "$PKG" && "$ROOT/node_modules/.bin/void" db migrate)
  ./scripts/dev.sh start "$PORT" && booted=1
  "$PKG/scripts/seed-app-user.sh" "$VB"
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
start_reference() {  # a freshly seeded reference: state left by one run or one pass never reaches the next
  rm -rf .void/reference/pb_data
  ./scripts/seed-reference.sh .void/reference "$PB_PORT" 0.39.11 "$STARTER_DIR" && started_pb=1
}
stop_reference() { if [ "$started_pb" = 1 ] && [ -f .void/reference/pb.pid ]; then kill "$(cat .void/reference/pb.pid)" 2>/dev/null; for _ in $(seq 1 30); do port_busy "$PB_PORT" || break; sleep 0.5; done; started_pb=0; fi; }
reference() {
  if port_busy "$PB_PORT"; then echo "reusing the PocketBase listening on $PB"; else start_reference; fi
  helper smtp-sink 2525 bun "$PKG/test/smtp-sink.ts"
  helper mock-oidc 5190 bun "$PKG/test/mock-oidc.ts"
  helper s3-mock 5195 bun "$PKG/test/s3-mock.ts"
  helper cf-mock 5197 bun "$PKG/test/cf-mock.ts"
  wait_http http://127.0.0.1:2526/messages 30; wait_http http://127.0.0.1:5190/ 30; wait_http http://127.0.0.1:5195/ 30; wait_http http://127.0.0.1:5197/__state 30
  warm_mail
}
warm_mail() {  # the first mail through the SMTP transport goes out here, to the sink, before any suite waits for one
  local j='content-type: application/json' tok n=0
  tok=$(curl -s -X POST "$VB/api/collections/_superusers/auth-with-password" -H "$j" -d "{\"identity\":\"$VOIDBASE_SUPERUSER_EMAIL\",\"password\":\"$VOIDBASE_SUPERUSER_PASSWORD\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  [ -n "$tok" ] || { echo "warm: superuser login failed, the mail transport stays cold"; return 0; }
  curl -s -o /dev/null -X DELETE http://127.0.0.1:2526/messages
  curl -s -o /dev/null -X PATCH "$VB/api/settings" -H "$j" -H "authorization: $tok" -d '{"smtp":{"enabled":true,"host":"127.0.0.1","port":2525,"username":"","password":"","authMethod":"","tls":false,"localName":""}}'
  # the settings test email: a password reset for the same user would be rate-limited after the boot warm-up
  curl -s -o /dev/null -X POST "$VB/api/settings/test/email" -H "$j" -H "authorization: $tok" -d '{"email":"warm@example.com","template":"verification"}'
  for _ in $(seq 1 20); do n=$(curl -s http://127.0.0.1:2526/messages | grep -o '"subject"' | wc -l); [ "$n" -ge 1 ] && break; sleep 1; done
  # back to the defaults a fresh database starts with (PocketBase's), which the settings comparisons expect
  curl -s -o /dev/null -X PATCH "$VB/api/settings" -H "$j" -H "authorization: $tok" -d '{"smtp":{"enabled":false,"host":"smtp.example.com","port":587,"username":"","password":"","authMethod":"","tls":false,"localName":""}}'
  curl -s -o /dev/null -X DELETE http://127.0.0.1:2526/messages
  echo "warm: mail transport ${n:-0} message(s) delivered to the sink"
}
# shellcheck disable=SC2086
suites() { ./scripts/ci-suites.sh "$PB" "$VB" $(plan_list suites); }
suites_bun() {  # the selected suites against `voidbase serve` (Bun runtime, SQLite + local files)
  [ "$booted" = 1 ] && ./scripts/dev.sh stop
  # the reference PocketBase keeps some state the suites cannot undo (a stored S3 secret, for one), so the Bun pass
  # gets a fresh one: both sides of every comparison then start from the same state
  if [ "$started_pb" = 1 ]; then stop_reference; start_reference; fi
  rm -rf .void/ci-serve; mkdir -p .void/ci-serve
  daemon serve .void/serve.log bun "$PKG/bin/voidbase.ts" serve --http 127.0.0.1:8093 --dir .void/ci-serve/pb_data --hooksDir "$STARTER_DIR/pb/pb_hooks" --migrationsDir "$STARTER_DIR/pb/pb_migrations"
  wait_http http://127.0.0.1:8093/api/health 60
  "$PKG/scripts/seed-app-user.sh" http://127.0.0.1:8093
  # shellcheck disable=SC2086
  CI_BROWSER=0 CI_LOGS="$LOGS/bun" ./scripts/ci-suites.sh "$PB" http://127.0.0.1:8093 $(plan_list bun); local rc=$?
  stop_daemon serve
  [ "$booted" = 1 ] && ./scripts/dev.sh start "$PORT"
  return "$rc"
}
# the app-facing tests run from the package (packages/voidbase), the directory their relative paths mean: db/
# migrations, public/_, the app's .env.local and its .void state
deploy_cf() { (cd "$PKG" && bun test/deploy-cf.ts); }
adapter() { (cd "$PKG" && bun test/adapter.ts); }   # a Void app converted into a voidbase app, then run
fresh_db() { (cd "$PKG" && bun test/fresh-db.ts 5181); }
mail_http() { (cd "$PKG" && bun test/mail-http.ts 5184); }
exe_smoke() { (cd "$PKG" && STARTER_VB_DIR="$STARTER_DIR/pb" bun test/exe-smoke.ts); }
# instances on this machine: its own VOIDBASE_HOME so a build never touches a developer's registry
local_instances() { (cd "$PKG" && bun test/local.ts); }
starter() {  # the unmodified starter frontend against voidbase
  STARTER_SK_DIR="$STARTER_DIR/sk" ./scripts/starter.sh start 5174 "$VB"
  (cd "$PKG" && bun test/starter-smoke.ts http://127.0.0.1:5174 "$LOGS/starter.png")
}

release_work() {  # release-please, npm and the executables in this build (docs/releasing.md): on master, when the
  # commits ask for it or a release still needs publishing; hot mode publishes to npm and leaves the executables
  local branch; branch="${WORKERS_CI_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null)}"
  if [ "$branch" != master ]; then skip_step release "not master"; return 0; fi
  if [ -z "${GH_TOKEN:-}" ]; then skip_step release "no GH_TOKEN"; return 0; fi
  local why=""; plan_flag release-merge && why="the release PR was merged"; plan_flag release-pr && why="${why:-releasable commits, refreshing the release PR}"; plan_flag release-dry-run && why="${why:-dry run requested by a commit}"
  if [ -z "$why" ]; then  # a release that still needs publishing or its executables: cut by hand, or left by hot mode
    # the whole workspace, not the one package: a release is published when every publishable package is on npm at
    # its version, so a half-finished one (a sibling that never made it) is still work this build has to do
    local v rel pending; v=$(node -p "require('./packages/voidbase/package.json').version"); rel=$(bun scripts/gh-release.ts view "v$v" 2>/dev/null) || rel=""
    pending=$(bun scripts/publish.ts --pending | tr '\n' ' ') || pending="unknown (the pending check failed)"; pending="${pending% }"
    if [ -n "$rel" ]; then
      if [ -n "$pending" ]; then why="release v$v is not on npm yet ($pending)"
      elif ! printf '%s' "$rel" | grep -q checksums.txt && [ "${CI_HOT:-0}" != 1 ]; then why="release v$v has no executables yet"; fi
    # package.json only ever names a version release-please merged: one with no GitHub release and no npm version
    # is a merged release PR whose own build did not get this far, and release-please creates its release from it
    elif [ -n "$pending" ]; then why="v$v is neither a GitHub release nor on npm: a merged release PR whose build did not finish"; fi
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
# hot mode (CI_HOT=1): a push to master is a release, in this build, with nothing in the way: the prerelease number
# moves, the commit and tag are pushed ([CI Skip], so that push starts no build), the GitHub release is made and
# npm gets the version. No typecheck, no tests. A normal run (CI_HOT=0) is the full suite, the release PR and the
# executables. The three apps are their own projects and are moved onto a version by hand (scripts/testbeds.ts).
hot_release() {
  local branch; branch="${WORKERS_CI_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null)}"
  if [ "$branch" != master ]; then echo "hot mode: $branch is not master, nothing to release"; return 0; fi
  if git log -1 --format=%s | grep -qiE '^chore\(master\): release|\[(ci skip|skip ci|ci-skip|skip-ci|cf-build-skip)\]'; then echo "hot mode: a release commit, nothing to do"; return 0; fi
  if [ -z "${GH_TOKEN:-}" ] || [ -z "${NPM_TOKEN:-}" ]; then echo "hot mode: GH_TOKEN and NPM_TOKEN are needed to release"; return 1; fi
  local v; v=$(bun scripts/hot-release.ts | tee /dev/stderr | tail -n 1) || return 1
  export CI_STEPS_DIR CI_STEPS_TSV; CI_NESTED=1 bash scripts/release.sh --hot --no-pr --tag "v$v"
}
if [ "${CI_HOT:-0}" = 1 ]; then run hot-release hot_release; run cache-save cache_save; echo; echo "hot release done"; exit 0; fi
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
maybe local local_instances
maybe starter starter
release_work || exit 1
run cache-save cache_save
echo; echo "every selected step passed"
