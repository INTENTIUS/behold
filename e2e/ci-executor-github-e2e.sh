#!/usr/bin/env bash
# behold#165: the executor contract against the REAL forge.
#
# Serves example-ci (two components, `prod` designated to the committed
# workflow .github/workflows/behold-e2e-dispatch.yml at this repo's root) and
# drives the contract through the operator's own `gh` login — the same
# delegation the product uses, nothing scripted:
#
#   1. /api/project says prod is dispatchable through github; the local
#      applies for prod are refused (409 executor-forge); staging, which is
#      undesignated and has no workflow named for it, is refused rather than
#      handed prod's workflow.
#   2. dispatch prod: the run is adopted by watermark, followed by name-painted
#      jobs to GitHub's own verdict, and its record persisted with the url.
#   3. a dead stream: with a 1ms follow deadline the next dispatch is LOST, the
#      record says so, and the run's page is kept.
#   4. re-adoption: POST /api/ci/readopt follows the lost run by its saved id
#      to a real verdict; then the same through a restart — dispatch, kill
#      behold once adopted, boot again, the boot re-adopts.
#
# Scratch discipline: nothing is created on the forge but workflow runs of a
# workflow that sleeps; nothing is applied anywhere. SKIPs (exit 0) without
# gh, without a login, or when the repo's default branch does not carry the
# workflow yet (dispatch needs it there). Needs network; ~4 minutes.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${BEHOLD_E2E_PORT:-4697}"
EX="example-ci"
WF="behold-e2e-dispatch.yml"
LOG="${TMPDIR:-/tmp}/behold-ci-e2e.log"
STORE="$(mktemp -d "${TMPDIR:-/tmp}/behold-ci-e2e-store.XXXXXX")"
export BEHOLD_CI_RUN_DIR="$STORE"

skip() { echo "SKIP: $*"; exit 0; }
command -v gh >/dev/null || skip "gh not installed"
gh auth status >/dev/null 2>&1 || skip "gh not logged in"
git remote get-url origin 2>/dev/null | grep -q github.com || skip "origin is not a github.com repo"
gh workflow view "$WF" >/dev/null 2>&1 || skip "$WF is not on the default branch yet — merge it first (workflow_dispatch needs it there)"

echo "→ install $EX deps"
npm --prefix "$EX" install --no-audit --no-fund --silent
echo "→ build behold"
npm run build --silent

PID=""
boot() {
  node ./bin/behold.js serve "$EX" --env prod --port "$PORT" >"$LOG" 2>&1 &
  PID=$!
  for _ in $(seq 1 45); do
    curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "✗ behold did not come up"; sed -n '1,40p' "$LOG"; exit 1
}
stop() { [ -n "$PID" ] && { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; }; PID=""; }
cleanup() { stop; rm -rf "$STORE"; }
trap cleanup EXIT INT TERM

api() { curl -s "http://localhost:$PORT$1" "${@:2}"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],j);console.log(typeof v==="string"?v:JSON.stringify(v??null))})' "$1"; }
check() { if [ "$2" = "$3" ]; then echo "  ✓ $1"; else echo "  ✗ $1 — expected $3, got $2"; exit 1; fi; }
match() { if echo "$2" | grep -Eq "$3"; then echo "  ✓ $1"; else echo "  ✗ $1 — got: $2"; exit 1; fi; }
# Wait for the dial's pipeline state to settle (ok/failed/lost), printing it.
settle() {
  for _ in $(seq 1 "${1:-90}"); do
    st="$(api /api/ops | json applyProgress.status)"
    case "$st" in ok|failed|lost) echo "$st"; return 0;; esac
    sleep 4
  done
  echo "timeout"
}

echo "→ (1/4) the contract at the routes"
boot
check "prod is designated and dispatchable" "$(api /api/project | json executor.prod.ok)" "true"
check "…through the designated file" "$(api /api/project | json executor.prod.workflow)" "$WF"
check "POST /api/apply?env=prod is refused" "$(api '/api/apply?env=prod' -X POST -o /dev/null -w '%{http_code}')" "409"
check "…with the executor-forge code" "$(api '/api/apply?env=prod' -X POST | json code)" "executor-forge"
staging="$(api '/api/ci/dispatch?env=staging' -X POST)"
match "staging (undesignated, no workflow named for it) is refused, not handed prod's" "$staging" "named for another env"

echo "→ (2/4) dispatch prod and follow to GitHub's verdict"
d="$(api '/api/ci/dispatch?env=prod' -X POST)"
check "dispatch started" "$(echo "$d" | json started)" "true"
check "…designated" "$(echo "$d" | json designated)" "true"
check "…the designated workflow" "$(echo "$d" | json workflow)" "$WF"
verdict="$(settle 90)"
check "the run concluded ok (GitHub's own conclusion)" "$verdict" "ok"
match "the dial carried the run's page" "$(api /api/ops | json applyProgress.url)" "^https://github.com/.*/actions/runs/[0-9]+$"
rec="$(api /api/ci/run)"
match "the record persisted the adopted run id" "$(echo "$rec" | json run.runId)" "^[0-9]+$"
check "…and its verdict" "$(echo "$rec" | json run.concluded.verdict)" "ok"
first_id="$(echo "$rec" | json run.runId)"

echo "→ (3/4) a dead stream is lost, never a verdict"
stop
BEHOLD_CI_FOLLOW_TIMEOUT_MS=1 boot
d="$(api '/api/ci/dispatch?env=prod' -X POST)"
check "dispatch started" "$(echo "$d" | json started)" "true"
verdict="$(settle 40)"
check "the follow lost the stream" "$verdict" "lost"
rec="$(api /api/ci/run)"
check "the record says lost" "$(echo "$rec" | json run.concluded.verdict)" "lost"
lost_id="$(echo "$rec" | json run.runId)"
[ "$lost_id" != "$first_id" ] && echo "  ✓ a new run ($lost_id), not the first ($first_id)"
match "the lost line names the re-adoption" "$(grep -E "stopped following" "$LOG" | tail -1)" "readopt"

echo "→ (4/4) re-adoption: by request, then through a restart"
stop
boot
r="$(api /api/ci/readopt -X POST)"
check "the lost run is re-adopted by its saved id" "$(echo "$r" | json outcome)" "readopted"
check "…the same run" "$(echo "$r" | json run.runId)" "$lost_id"
verdict="$(settle 90)"
check "…followed to GitHub's verdict" "$verdict" "ok"
check "the record now concludes ok" "$(api /api/ci/run | json run.concluded.verdict)" "ok"
# Through a restart: dispatch, wait for adoption (the record appears), kill, boot.
d="$(api '/api/ci/dispatch?env=prod' -X POST)"
check "dispatch started" "$(echo "$d" | json started)" "true"
adopted=""
for _ in $(seq 1 40); do
  id="$(api /api/ci/run | json run.runId)"
  if [ "$id" != "null" ] && [ "$id" != "$lost_id" ]; then adopted="$id"; break; fi
  sleep 3
done
[ -n "$adopted" ] || { echo "  ✗ the third run was never adopted"; exit 1; }
echo "  ✓ run $adopted adopted; killing behold mid-follow"
stop
boot
check "boot re-adopted the unconcluded run" "$(grep -c "re-adopting run $adopted" "$LOG")" "1"
verdict="$(settle 90)"
check "…and followed it to GitHub's verdict" "$verdict" "ok"
check "the record's id survived the restart" "$(api /api/ci/run | json run.runId)" "$adopted"
echo "✓ ci-executor acceptance passed"
