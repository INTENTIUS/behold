#!/usr/bin/env bash
# behold#998: streamed drift, end to end in the choudoufu-estate demo.
#
# The demo is set up as `behold demo choudoufu-estate` sets it up (a scratch
# floci, choudoufu init, the monolith applied) and served with
# BEHOLD_DRIFT_CHANT pointing at a fake chant
# (e2e/fixtures/fake-chant-drift/chant). behold reaches that binary for the
# streamed drift read only; every other read is the demo's own chant. The fake
# answers each `--resource` the way choudoufu's `live-plan -resource` would,
# with a pause of FAKE_DRIFT_STEP_SECS before its record, and stays silent for
# one resource.
#
#   1. the route  — POST /api/workspace/drift/stream answers 400 for a member
#                   the workspace does not declare, 202 for the monolith, and
#                   409 for a second start while that run goes.
#   2. the stream — /api/events carries `drift` frames, one record frame per
#                   resource, arriving apart in time (read with curl -N).
#   3. the page   — e2e/streamed-drift.mjs: the monolith's cards read as
#                   reading, then change colour one by one; the silent one ends
#                   not-observed / not-reached.
#
# Skips, exit 0, with the reason, when Docker or choudoufu is absent, as
# e2e/choudoufu-estate-floci-e2e.sh does. Scratch discipline as there: the
# container is behold-choudoufu-floci, refused if it already exists, removed
# on exit by the demo's down script.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${BEHOLD_E2E_PORT:-4698}"
TARGET="${BEHOLD_E2E_TARGET:-$(mktemp -d "${TMPDIR:-/tmp}/behold-drift-e2e.XXXXXX")/estate}"
LOG="${TMPDIR:-/tmp}/behold-drift-e2e.log"

export FAKE_DRIFT_STEP_SECS="${FAKE_DRIFT_STEP_SECS:-0.6}"
export FAKE_DRIFT_SILENT="${FAKE_DRIFT_SILENT:-aws_cloudwatch_log_group.team_c_2}"
export FAKE_DRIFT_DRIFTED="${FAKE_DRIFT_DRIFTED:-aws_iam_policy.team_b}"
export FAKE_DRIFT_UNCLAIMED="${FAKE_DRIFT_UNCLAIMED:-aws_iam_role.team_c}"
export BEHOLD_DRIFT_CHANT="$PWD/e2e/fixtures/fake-chant-drift/chant"

CHOUDOUFU="${CHOUDOUFU_BIN:-choudoufu}"
if ! docker info >/dev/null 2>&1; then echo "skip: Docker is not running"; exit 0; fi
if ! command -v "$CHOUDOUFU" >/dev/null 2>&1; then echo "skip: ${CHOUDOUFU} is not on PATH (set CHOUDOUFU_BIN to name a build)"; exit 0; fi
if docker ps -a --format '{{.Names}}' | grep -qx behold-choudoufu-floci; then
  echo "behold-choudoufu-floci already exists; \`docker rm -f behold-choudoufu-floci\` and re-run" >&2
  exit 1
fi

echo "→ build behold"
npm run build --silent

echo "→ behold demo choudoufu-estate → $TARGET (fake chant for the drift stream: $BEHOLD_DRIFT_CHANT)"
node ./bin/behold.js demo choudoufu-estate "$TARGET" --port "$PORT" >"$LOG" 2>&1 &
PID=$!
CURL_PID=""
cleanup() {
  [ -n "$CURL_PID" ] && kill "$CURL_PID" 2>/dev/null || true
  kill "$PID" 2>/dev/null || true
  [ -x "$TARGET/scripts/choudoufu-down.sh" ] && bash "$TARGET/scripts/choudoufu-down.sh" || docker rm -f behold-choudoufu-floci >/dev/null 2>&1 || true
}
trap cleanup EXIT

ready=""
for _ in $(seq 1 240); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && { ready=1; break; }
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 1
done
if [ -z "$ready" ]; then echo "behold never answered on :$PORT" >&2; tail -40 "$LOG" >&2; exit 1; fi

fail() { echo "FAIL: $1" >&2; exit 1; }
post() { curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:$PORT/api/workspace/drift/stream" -H 'content-type: application/json' -d "$1"; }

echo "→ 1. the route"
code=$(post '{"member":"no-such-member"}')
[ "$code" = 400 ] && echo "  ✓ an unknown member is refused (400)" || fail "an unknown member answered $code"

echo "→ 2. the stream, read off /api/events"
FRAMES="$(dirname "$TARGET")/drift-frames.txt"
# Each SSE data line, stamped with the time it arrived.
curl -sN "http://localhost:$PORT/api/events" | while IFS= read -r line; do
  case "$line" in data:*) printf '%s %s\n' "$(node -e 'process.stdout.write(String(Date.now()))')" "${line#data: }" ;; esac
done >"$FRAMES" &
CURL_PID=$!
sleep 1
G=$(curl -sf "http://localhost:$PORT/api/graph")
ADDRS=$(printf '%s' "$G" | jq -c '[.ir.nodes[] | select(.id | startswith("monolith/")) | (.attrs.address // (.id | ltrimstr("monolith/")))]')
code=$(post "{\"member\":\"monolith\",\"addresses\":$ADDRS}")
[ "$code" = 202 ] && echo "  ✓ the stream starts (202)" || fail "the start answered $code"
code=$(post '{"member":"monolith"}')
[ "$code" = 409 ] && echo "  ✓ a second start while it runs is refused (409)" || fail "a second start answered $code"
for _ in $(seq 1 120); do
  grep -q '"kind":"end"' "$FRAMES" 2>/dev/null && break
  sleep 1
done
grep -q '"kind":"end"' "$FRAMES" || fail "the stream never ended; frames: $(head -c 1500 "$FRAMES")"
node -e '
  const fs = require("fs");
  const [file, silent, step] = process.argv.slice(1);
  const frames = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => {
    const i = l.indexOf(" "); let f = null;
    try { f = JSON.parse(l.slice(i + 1)); } catch {}
    return { t: Number(l.slice(0, i)), f };
  }).filter((x) => x.f && x.f.kind && x.f.member === "monolith");
  const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
  const records = frames.filter((x) => x.f.kind === "record");
  const starts = frames.filter((x) => x.f.kind === "start");
  if (starts.length !== 21) fail(`expected 21 starts, one per resource, got ${starts.length}`);
  if (records.length !== 21) fail(`expected 21 records, got ${records.length}`);
  console.log("  ✓ one start and one record per resource (21)");
  const gaps = records.slice(1).map((r, i) => r.t - records[i].t);
  const min = Number(step) * 1000 * 0.5;
  if (gaps.some((g) => g < min)) fail(`records arrived together: gaps ${gaps.join(",")} ms`);
  console.log(`  ✓ the records arrived one at a time (every gap at least ${min} ms)`);
  const nr = records.find((r) => r.f.address === silent);
  if (!nr || nr.f.status !== "not-observed" || nr.f.reason !== "not-reached" || nr.f.notReached !== true) fail(`the silent resource: ${JSON.stringify(nr && nr.f)}`);
  console.log(`  ✓ ${silent}, which never reported, settled as not-observed / not-reached`);
  if (frames.some((x) => x.f.kind === "failed")) fail(`a read failed: ${JSON.stringify(frames.find((x) => x.f.kind === "failed").f)}`);
' "$FRAMES" "$FAKE_DRIFT_SILENT" "$FAKE_DRIFT_STEP_SECS"
kill "$CURL_PID" 2>/dev/null || true; CURL_PID=""

echo "→ 3. the page"
node e2e/streamed-drift.mjs "http://localhost:$PORT/" "$FAKE_DRIFT_SILENT" "$FAKE_DRIFT_DRIFTED" "$FAKE_DRIFT_UNCLAIMED" "$FAKE_DRIFT_STEP_SECS"

echo "streamed drift e2e: all green"
