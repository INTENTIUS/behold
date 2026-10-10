#!/usr/bin/env bash
# behold#490 local E2E: a terragucci estate painted from its reports.
#
# Serves a copy of terragucci's own example (15 Terraform roots) with
# `--terragucci example-terragucci-reports` (the bucket terragucci's code wrote
# for it, see that directory's README), then asserts, against the real
# Terraform read and the real server:
#   - the graph draws the 15 roots;
#   - /api/terragucci marks exactly the cards the newest runs flag, places
#     every change, and offers the waiting wave as a line, not a route;
#   - a run's report page opens through the server, sandboxed;
#   - every write route refuses, since the example holds terragucci.yml (#489).
#
# Needs: TERRAGUCCI=<a terragucci checkout> (its example/ is copied, never
# written), and chant's terraform lexicon + @cdktn/hcl2json beside behold.
# Exits 0 with "skip" when either is absent: CI has neither.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${BEHOLD_E2E_PORT:-4698}"
TG="${TERRAGUCCI:-}"
if [ -z "$TG" ] || [ ! -d "$TG/example/envs" ]; then
  echo "skip: set TERRAGUCCI to a terragucci checkout (its example/ is what gets painted)"
  exit 0
fi
if ! node -e 'require.resolve("@intentius/chant-lexicon-terraform"); require.resolve("@cdktn/hcl2json")' 2>/dev/null; then
  echo "skip: chant's terraform lexicon and @cdktn/hcl2json are not installed beside behold"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/behold-terragucci-e2e.XXXXXX")"
trap 'kill "${PID:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT
# A copy, from git when it is one, so a working tree's edits don't leak in.
if git -C "$TG" rev-parse --verify -q origin/main >/dev/null; then
  git -C "$TG" archive origin/main example | tar -x -C "$WORK"
else
  cp -R "$TG/example" "$WORK/example"
fi
EX="$WORK/example"

echo "→ build behold"
npm run build --silent

echo "→ serve terragucci's example on :$PORT, painted from example-terragucci-reports"
node ./bin/behold.js serve "$EX" --port "$PORT" --terragucci example-terragucci-reports >"$WORK/serve.log" 2>&1 &
PID=$!
for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://localhost:$PORT/healthz" >/dev/null || { echo "✗ behold did not come up"; sed -n '1,40p' "$WORK/serve.log"; exit 1; }

check() { node -e "$1" "$2"; }

echo "→ GET /api/graph"
curl -sf "http://localhost:$PORT/api/graph?detail=2" >"$WORK/graph.json"
check '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const roots = Object.keys(j.ir.groups.byStack || {});
  if (roots.length !== 15) { console.error("✗ expected 15 roots, got", roots.length); process.exit(1); }
  console.log("  graph ok:", j.ir.nodes.length, "nodes in", roots.length, "roots");
' "$WORK/graph.json"

echo "→ GET /api/terragucci"
curl -sf "http://localhost:$PORT/api/terragucci" >"$WORK/tg.json"
check '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const fail = (m) => { console.error("✗", m); process.exit(1); };
  const want = [
    "example/envs-dev-orders/module.service/aws_sqs_queue.jobs",
    "example/envs-prod-search/module.service/aws_dynamodb_table.records",
    "example/envs-staging-email/module.service/aws_dynamodb_table.records",
    "example/envs-staging-orders/module.service/aws_sqs_queue.jobs",
  ];
  const got = Object.keys(j.cards).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) fail("marked cards " + JSON.stringify(got));
  if (j.unmatched.roots.length || j.unmatched.changes.length) fail("unplaced: " + JSON.stringify(j.unmatched));
  if (j.roots.length !== 15) fail("roots " + j.roots.length);
  const w = j.waiting[0];
  if (!w || w.wave !== 2 || !/^npx terragucci approve wave-2 --plan jcs1-sha256:/.test(w.command)) fail("waiting wave " + JSON.stringify(w));
  if (!j.estate || j.estate.drifted !== 1) fail("estate counts " + JSON.stringify(j.estate));
  console.log("  marks ok:", got.length, "cards,", j.waiting.length, "wave waiting, read", j.reports, "reports,", j.validation.by);
' "$WORK/tg.json"

echo "→ a run's report opens through the server, sandboxed"
KEY="$(node -e 'const j=require(process.argv[1]); process.stdout.write(encodeURIComponent(j.waiting[0].report))' "$WORK/tg.json")"
curl -sfD "$WORK/h.txt" -o /dev/null "http://localhost:$PORT/api/terragucci/file?key=$KEY"
grep -qi '^content-security-policy: sandbox' "$WORK/h.txt" || { echo "✗ report not sandboxed"; cat "$WORK/h.txt"; exit 1; }
echo "  report ok"

echo "→ every write refuses on a terragucci repo"
for p in "/api/apply?env=prod" "/api/rollback?to=HEAD" "/api/workspace/gates/approve"; do
  code="$(curl -s -o "$WORK/w.json" -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "http://localhost:$PORT$p")"
  [ "$code" = 409 ] && grep -q '"code":"terragucci"' "$WORK/w.json" || { echo "✗ POST $p answered $code: $(cat "$WORK/w.json")"; exit 1; }
done
echo "  writes refused"
kill "$PID" 2>/dev/null || true

echo "✓ terragucci e2e passed"
