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
#   4. re-adoption: the boot re-follows the lost run by its saved id to a
#      real verdict; then the same through a restart — dispatch, kill behold
#      once adopted, boot again, the boot re-adopts.
#   5. the approval that lives on the forge: `gated` dispatches a workflow
#      bound to an environment with a required reviewer; the run stops at
#      `waiting`, the dial says so and links it, nobody approves, the run is
#      cancelled through gh, and the cancellation lands as failed — never ok.
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
rm -f "${TMPDIR:-/tmp}/behold-ci-e2e-events.log"

skip() { echo "SKIP: $*"; exit 0; }
command -v gh >/dev/null || skip "gh not installed"
gh auth status >/dev/null 2>&1 || skip "gh not logged in"
git remote get-url origin 2>/dev/null | grep -q github.com || skip "origin is not a github.com repo"
gh workflow view "$WF" >/dev/null 2>&1 || skip "$WF is not on the default branch yet — merge it first (workflow_dispatch needs it there)"
# The dispatch runs on the CURRENT branch (behold passes `--ref <branch>`), and
# GitHub refuses a ref it has never seen: an unpushed branch answers "No ref
# found" — asynchronously, on the now-line, after `started: true`. Say it here.
BRANCH="$(git branch --show-current)"
git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1 || skip "branch $BRANCH is not on origin — push it first (the dispatch runs on it)"

echo "→ install $EX deps"
npm --prefix "$EX" install --no-audit --no-fund --silent
echo "→ build behold"
npm run build --silent

PID=""
EVENTS="${TMPDIR:-/tmp}/behold-ci-e2e-events.log"
EVPID=""
boot() {
  node ./bin/behold.js serve "$EX" --env prod --port "$PORT" >"$LOG" 2>&1 &
  PID=$!
  # The now-line (`gh workflow run …`, `● run N started`, the lost line) is an
  # SSE stream, not the server's stdout — capture it, so a failure can be read.
  ( for _ in $(seq 1 45); do curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break; sleep 1; done; curl -sN "http://localhost:$PORT/api/events" >>"$EVENTS" 2>/dev/null ) &
  EVPID=$!
  for _ in $(seq 1 45); do
    curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "✗ behold did not come up"; sed -n '1,40p' "$LOG"; exit 1
}
stop() { [ -n "$EVPID" ] && { kill "$EVPID" 2>/dev/null || true; }; EVPID=""; [ -n "$PID" ] && { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; }; PID=""; }
cleanup() { stop; rm -rf "$STORE"; rm -f "$EVENTS"; }
trap cleanup EXIT INT TERM

api() { curl -s "http://localhost:$PORT$1" "${@:2}"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],j);console.log(typeof v==="string"?v:JSON.stringify(v??null))})' "$1"; }
check() { if [ "$2" = "$3" ]; then echo "  ✓ $1"; else echo "  ✗ $1 — expected $3, got $2"; echo "  now-line:"; grep -a "^data:" "$EVENTS" 2>/dev/null | tail -12 | sed 's/^/    /'; exit 1; fi; }
match() { if echo "$2" | grep -Eq "$3"; then echo "  ✓ $1"; else echo "  ✗ $1 — got: $2"; exit 1; fi; }
# Wait for the dial's pipeline state to settle (ok/failed/lost), printing it.
settle() {
  for _ in $(seq 1 "${1:-90}"); do
    st="$(api /api/ops | json applyProgress.status)"
    case "$st" in ok|failed|lost) echo "$st"; return 0;; esac
    # The follow task ended without a verdict (a failed dispatch, a thrown task):
    # its exit line is on the now-line — stop waiting and let the caller show it.
    if [ "$(api /api/ops | json running)" = "null" ] && grep -aq "exited [0-9]" "$EVENTS" 2>/dev/null; then echo "ended:$st"; return 0; fi
    sleep 4
  done
  echo "timeout"
}

echo "→ (1/4) the contract at the routes"
boot
prod="$(api /api/project | json executor.prod)"
check "prod is designated and dispatchable ($prod)" "$(echo "$prod" | json ok)" "true"
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
match "the lost line names the re-adoption" "$(grep -a "stopped following" "$EVENTS" | tail -1)" "readopt"

echo "→ (4/4) re-adoption: at boot, then through a restart"
stop
boot
# A LOST run is re-adopted by the boot itself (the record says lost, the run is
# still live on the forge); an explicit readopt while that follow runs is
# refused as busy, and once GitHub's verdict is in, there is nothing to re-adopt.
sleep 4
match "boot re-adopted the lost run by its saved id" "$(grep -a "re-adopting run $lost_id" "$EVENTS" | tail -1)" "re-adopting run $lost_id"
check "an explicit readopt meanwhile is refused as busy" "$(api /api/ci/readopt -X POST -o /dev/null -w '%{http_code}')" "409"
verdict="$(settle 90)"
check "…followed to GitHub's verdict" "$verdict" "ok"
check "the record now concludes ok" "$(api /api/ci/run | json run.concluded.verdict)" "ok"
check "a concluded run has nothing to re-adopt" "$(api /api/ci/readopt -X POST -o /dev/null -w '%{http_code}')" "404"
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
sleep 3
match "boot re-adopted the unconcluded run" "$(grep -a "re-adopting run $adopted" "$EVENTS" | tail -1)" "re-adopting run $adopted"
verdict="$(settle 90)"
check "…and followed it to GitHub's verdict" "$verdict" "ok"
check "the record's id survived the restart" "$(api /api/ci/run | json run.runId)" "$adopted"
echo "→ (5/5) the approval that lives on the forge — waiting, linked, never a button"
GATED="behold-e2e-gated.yml"
gh workflow view "$GATED" >/dev/null 2>&1 || { echo "  · $GATED is not on the default branch yet — the gate beat is skipped"; echo "✓ ci-executor acceptance passed (gate beat skipped)"; exit 0; }
check "gated is designated and dispatchable" "$(api /api/project | json executor.gated.ok)" "true"
d="$(api '/api/ci/dispatch?env=gated' -X POST)"
check "dispatch started" "$(echo "$d" | json started)" "true"
waiting=""
for _ in $(seq 1 40); do
  if [ "$(api /api/ops | json applyProgress.waiting)" = "true" ]; then waiting="1"; break; fi
  sleep 4
done
[ -n "$waiting" ] || { echo "  ✗ the gated run never reached waiting"; grep -a "^data:" "$EVENTS" | tail -6; exit 1; }
echo "  ✓ the run is held at waiting — GitHub wants a deployment review"
match "the dial links the run's page" "$(api /api/ops | json applyProgress.url)" "^https://github.com/.*/actions/runs/[0-9]+$"
match "the now-line says the approval is granted on the forge, and offers only the link" "$(grep -a "waiting for a deployment review" "$EVENTS" | tail -1)" "approve at https://github.com/.*behold holds no identity"
check "the held jobs read pending, not running" "$(api /api/ops | json applyProgress.components.0.status)" "pending"
gated_id="$(api /api/ci/run | json run.runId)"
echo "  · cancelling run $gated_id through gh — nobody approves"
gh run cancel "$gated_id" >/dev/null 2>&1 || true
verdict="$(settle 60)"
check "a cancelled review lands as failed, never ok" "$verdict" "failed"
check "the record says failed" "$(api /api/ci/run | json run.concluded.verdict)" "failed"
echo "✓ ci-executor acceptance passed"
