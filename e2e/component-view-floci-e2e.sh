#!/usr/bin/env bash
# behold's unified component-view E2E (#59, the M1 epic's definition of done).
#
# Asserts the epic's acceptance bar directly: with loomster deployed on Floci
# (no AWS account), behold's component DAG renders wave-laned, coloured by
# live per-component AWS status (#57), and a drill-in returns the CI job
# (#58) + live status + resources (#59) for a real component — all through
# one endpoint, `/api/graph?components=1&env=<env>`, not three separate views.
#
# Unlike e2e/run.sh (which installs and serves the bundled `example` fixture
# end to end, self-contained for CI), this targets a real external project —
# loomster — and its already-running Floci emulator. It does NOT install
# loomster's deps or boot Floci itself (`just local-up` is loomster's own,
# separate setup step — see docs/roadmap/m1-cli-notes.md Q3); it fails fast
# with a clear instruction if that prerequisite isn't met, rather than
# reaching into another project's lifecycle.
set -euo pipefail
cd "$(dirname "$0")/.."

LOOMSTER="${LOOMSTER_DIR:-$HOME/checkouts/intentius/loomster}"
PORT="${BEHOLD_E2E_PORT:-4698}"
ENV="${BEHOLD_E2E_ENV:-local}"
ENDPOINT="${AWS_ENDPOINT_URL:-http://localhost:4566}"

echo "→ prerequisite: loomster checkout"
[ -d "$LOOMSTER" ] || { echo "✗ no loomster checkout at $LOOMSTER (set LOOMSTER_DIR)"; exit 1; }

echo "→ prerequisite: Floci reachable at $ENDPOINT"
if ! curl -sf "$ENDPOINT/_localstack/health" >/dev/null 2>&1; then
  echo "✗ Floci isn't up at $ENDPOINT."
  echo "  Bring it up first (loomster's own setup, not behold's):"
  echo "    cd $LOOMSTER && just local-up"
  exit 1
fi

echo "→ prerequisite: loomster's component stacks deployed"
STACK_COUNT=$(LOOM_ENV="$ENV" AWS_ENDPOINT_URL="$ENDPOINT" AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
  aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
  --query "length(StackSummaries[?starts_with(StackName, 'loom-$ENV-')])" --output text 2>/dev/null || echo 0)
[ "$STACK_COUNT" -ge 1 ] || { echo "✗ no loom-$ENV-* stacks found on Floci — run \`just local-up\` in loomster first"; exit 1; }
echo "  $STACK_COUNT stack(s) present"

echo "→ build behold"
npm run build --silent

echo "→ serve loomster on :$PORT (env=$ENV, components view, NO --local — Q3: loomster's Floci is the single source of truth)"
LOOM_ENV="$ENV" AWS_ENDPOINT_URL="$ENDPOINT" AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
  node ./bin/behold.js serve "$LOOMSTER" --env "$ENV" --port "$PORT" >/tmp/behold-component-e2e.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

ready=""
for _ in $(seq 1 45); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[ -n "$ready" ] || { echo "✗ behold did not come up"; sed -n '1,40p' /tmp/behold-component-e2e.log; exit 1; }

echo "→ GET /api/graph?components=1&env=$ENV — the unified view"
curl -sf "http://localhost:$PORT/api/graph?components=1&env=$ENV" | node -e '
  let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => {
    const j = JSON.parse(s);
    if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
    const { ir, svg, meta } = j;
    if (meta.mode !== "component-status") { console.error("✗ expected mode component-status, got", meta.mode); process.exit(1); }
    if (!ir.nodes.length) { console.error("✗ no component nodes"); process.exit(1); }
    if (!ir.groups || !ir.groups.byWave || !Object.keys(ir.groups.byWave).length) { console.error("✗ no wave lanes (groups.byWave)"); process.exit(1); }
    if (!/<svg/.test(svg || "")) { console.error("✗ no svg rendered"); process.exit(1); }
    // Every component node must carry a live-status colour (#57) — the whole
    // point of the unified view is that the pipeline (waves) and the
    // deployment (colour) are the SAME graph, not two views to reconcile.
    const uncoloured = ir.nodes.filter((n) => !(n.attrs && n.attrs._status));
    if (uncoloured.length) { console.error("✗", uncoloured.length, "component node(s) missing live status:", uncoloured.map((n) => n.id)); process.exit(1); }
    const waves = Object.keys(ir.groups.byWave).length;
    console.log(`  ok: ${ir.nodes.length} components, ${ir.edges.length} dependsOn edges, ${waves} wave lanes, all coloured by live status`);
    require("node:fs").writeFileSync("/tmp/behold-component-e2e-graph.json", s);
  });
'

echo "→ pick a component and drill in: CI job (#58) + live status (#57) + resources (#59)"
COMPONENT=$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync("/tmp/behold-component-e2e-graph.json", "utf8"));
  process.stdout.write(j.ir.nodes[0].id);
')
echo "  component: $COMPONENT"

curl -sf "http://localhost:$PORT/api/ci?env=$ENV" | node -e "
  let s = ''; process.stdin.on('data', d => (s += d)).on('end', () => {
    const j = JSON.parse(s);
    if (j.error) { console.error('✗ /api/ci error:', j.error); process.exit(1); }
    const job = (j.jobs || []).find((x) => x.component === '$COMPONENT');
    if (!job) { console.error('✗ no CI job for $COMPONENT'); process.exit(1); }
    if (typeof job.stage !== 'string' || !Array.isArray(job.needs)) { console.error('✗ malformed CI job', job); process.exit(1); }
    console.log('  ci ok: $COMPONENT → stage', job.stage, ', needs', JSON.stringify(job.needs));
  });
"

curl -sf "http://localhost:$PORT/api/resources?env=$ENV" | node -e "
  let s = ''; process.stdin.on('data', d => (s += d)).on('end', () => {
    const j = JSON.parse(s);
    if (j.error) { console.error('✗ /api/resources error:', j.error); process.exit(1); }
    const resources = (j.byComponent || {})['$COMPONENT'];
    if (!resources) { console.error('✗ no resources entry for $COMPONENT'); process.exit(1); }
    console.log('  resources ok: $COMPONENT →', resources.length, 'AWS resource(s), e.g.', resources.slice(0, 2).map((r) => r.kind).join(', '));
  });
"

echo "→ GET /api/project — the header axes (env/target)"
curl -sf "http://localhost:$PORT/api/project" | node -e '
  let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => {
    const j = JSON.parse(s);
    if (!j.currentEnv) { console.error("✗ /api/project reported no currentEnv"); process.exit(1); }
    console.log("  env:", j.currentEnv, " target:", j.target || "(none)");
  });
'

echo "✓ e2e passed — unified component view (waves + live status + CI + resources) against loomster/Floci"
