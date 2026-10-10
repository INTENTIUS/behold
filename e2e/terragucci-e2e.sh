#!/usr/bin/env bash
# behold#490/#491 local E2E: a terragucci estate painted from its reports.
#
# Serves a copy of terragucci's own example (15 Terraform roots) with
# `--terragucci example-terragucci-reports` (the bucket terragucci's code wrote
# for it, see that directory's README), then asserts, against the real
# Terraform read and the real server:
#   - the graph draws the 15 roots;
#   - /api/terragucci marks exactly the cards the newest runs flag, places
#     every change, and offers the waiting wave as a line, not a route;
#   - a run's report page opens through the server, sandboxed;
#   - every write route refuses, since the example holds terragucci.yml (#489);
#   - `behold export --terragucci --no-source`, into a copy of the bucket at
#     views/behold/ the way the estate job uploads it, carries the same marks,
#     no source text and no path of this machine, and its report links open
#     the bucket's own objects through a plain file server (#491).
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

echo "→ behold export --terragucci, into views/behold/ of a copy of the bucket"
cp -R example-terragucci-reports "$WORK/bucket"
node ./bin/behold.js export "$EX" --terragucci "$WORK/bucket" --no-source --out "$WORK/bucket/views/behold" >"$WORK/export.log" 2>&1 || { cat "$WORK/export.log"; exit 1; }
check '
  const fs = require("fs"), path = require("path");
  const dir = process.argv[1];
  const fail = (m) => { console.error("✗", m); process.exit(1); };
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const f = m.keyToFile["/api/terragucci"];
  if (!f) fail("no /api/terragucci snapshot");
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  if (Object.keys(j.cards).length !== 4) fail("export marks " + Object.keys(j.cards));
  if (j.files !== "../../") fail("export links are not bucket-relative: " + j.files);
  const all = fs.readdirSync(dir, { recursive: true }).filter((x) => /\.json$/.test(x)).map((x) => fs.readFileSync(path.join(dir, x), "utf8")).join("\n");
  if (all.includes(require("os").homedir())) fail("a home path is in the bundle");
  if (/"source":"(terraform|resource|variable)/.test(all) || all.includes("required_providers")) fail("source text is in the bundle");
  console.log("  export ok:", Object.keys(j.cards).length, "cards marked, links ../../, no source, no local paths");
' "$WORK/bucket/views/behold"

echo "→ the published view, served as the bucket serves it"
python3 -m http.server "$((PORT + 1))" --bind 127.0.0.1 --directory "$WORK/bucket" >"$WORK/http.log" 2>&1 &
HTTP=$!
trap 'kill "${PID:-}" "${HTTP:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT
BASE="http://127.0.0.1:$((PORT + 1))/views/behold"
for _ in $(seq 1 20); do curl -sf -o /dev/null "$BASE/index.html" && break; sleep 0.5; done
curl -sf -o "$WORK/page.html" "$BASE/index.html" && grep -q "__BEHOLD_STATIC__" "$WORK/page.html" || { echo "✗ the view's page is not there"; exit 1; }
REPORT="$(node -e 'const fs=require("fs"),p=require("path");const d=process.argv[1];const m=JSON.parse(fs.readFileSync(p.join(d,"manifest.json")));const j=JSON.parse(fs.readFileSync(p.join(d,m.keyToFile["/api/terragucci"])));process.stdout.write(j.files+j.waiting[0].report)' "$WORK/bucket/views/behold")"
curl -sf -o "$WORK/report.html" "$BASE/$REPORT" && grep -qi "<html" "$WORK/report.html" || { echo "✗ $REPORT does not open from the view"; exit 1; }
echo "  view ok: page served, $REPORT opens"
echo "✓ terragucci e2e passed"
