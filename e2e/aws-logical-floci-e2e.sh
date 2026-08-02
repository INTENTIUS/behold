#!/usr/bin/env bash
# behold#100 (B·aws) — the AWS lane's acceptance run for chant's CC epic
# (chant#1198). AWS is the reference substrate for behold's three live views,
# so this asserts all three against one running estate, in one pass:
#
#   1. component status  — painted from the RESOURCE ROLLUP (#98), not from
#                          CloudFormation stack status. This is the clause
#                          #100 exists to confirm: `stack` only exists on AWS,
#                          so if `stack` decided the colour, AWS would be the
#                          one substrate that never exercised the rollup #98
#                          added. Every row must carry `_liveStatus.resources`.
#   2. live overlay      — `chant graph --live --overlay` (source-anchored,
#                          chant#821) classified per node, every declared node
#                          carrying a `_status`.
#   3. logical zoom      — the nested architecture diagram (#63): the
#                          `region -> VPC -> subnet` network boxes containing
#                          component boxes containing headline resource cards.
#
# Like e2e/component-view-floci-e2e.sh (#59), this targets a real external
# project and its already-running Floci. It boots and installs NOTHING — that
# is the project's own lifecycle, not behold's — and fails fast with the
# command to run when a prerequisite is missing.
#
# The project defaults to loomster because it is the AWS estate already wired
# for this (real VPC/subnets, several components, a Floci to deploy onto).
# Point BEHOLD_E2E_PROJECT at the CC lane's canonical example to run the same
# assertions against that instead — nothing here is loomster-specific beyond
# the default path and the stack-name prefix probe.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${BEHOLD_E2E_PROJECT:-${LOOMSTER_DIR:-$HOME/checkouts/intentius/loomster}}"
PORT="${BEHOLD_E2E_PORT:-4699}"
ENV="${BEHOLD_E2E_ENV:-local}"
ENDPOINT="${AWS_ENDPOINT_URL:-http://localhost:4566}"
STACK_PREFIX="${BEHOLD_E2E_STACK_PREFIX:-}"

echo "→ prerequisite: project checkout"
[ -d "$PROJECT" ] || { echo "✗ no project checkout at $PROJECT (set BEHOLD_E2E_PROJECT)"; exit 1; }
echo "  $PROJECT"

echo "→ prerequisite: Floci reachable at $ENDPOINT"
if ! curl -sf "$ENDPOINT/_localstack/health" >/dev/null 2>&1; then
  echo "✗ Floci isn't up at $ENDPOINT."
  echo "  Bring it up first (the project's own setup, not behold's):"
  echo "    cd $PROJECT && just local-up"
  exit 1
fi

echo "→ prerequisite: the project's stacks are deployed"
QUERY="length(StackSummaries)"
[ -n "$STACK_PREFIX" ] && QUERY="length(StackSummaries[?starts_with(StackName, '$STACK_PREFIX')])"
STACK_COUNT=$(LOOM_ENV="$ENV" AWS_ENDPOINT_URL="$ENDPOINT" AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
  aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
  --query "$QUERY" --output text 2>/dev/null || echo 0)
[ "$STACK_COUNT" -ge 1 ] || { echo "✗ no deployed stacks found on Floci — deploy the project first (\`just local-up\`)"; exit 1; }
echo "  $STACK_COUNT stack(s) present"

echo "→ build behold"
npm run build --silent

echo "→ serve $PROJECT on :$PORT (env=$ENV)"
LOOM_ENV="$ENV" AWS_ENDPOINT_URL="$ENDPOINT" AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
  node ./bin/behold.js serve "$PROJECT" --env "$ENV" --port "$PORT" >/tmp/behold-aws-logical-e2e.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

ready=""
for _ in $(seq 1 45); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[ -n "$ready" ] || { echo "✗ behold did not come up"; sed -n '1,40p' /tmp/behold-aws-logical-e2e.log; exit 1; }

# ---------------------------------------------------------------- 1. status --
echo "→ (1/3) GET /api/graph?components=1&env=$ENV — component status on the #98 rollup source"
curl -sf "http://localhost:$PORT/api/graph?components=1&env=$ENV" >/tmp/behold-aws-logical-status.json
node -e '
  const j = JSON.parse(require("node:fs").readFileSync("/tmp/behold-aws-logical-status.json", "utf8"));
  if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
  const { ir, meta } = j;
  if (meta.mode !== "component-status") { console.error("✗ expected mode component-status, got", meta.mode); process.exit(1); }
  if (!ir.nodes.length) { console.error("✗ no component nodes"); process.exit(1); }

  const uncoloured = ir.nodes.filter((n) => !(n.attrs && n.attrs._status));
  if (uncoloured.length) { console.error("✗", uncoloured.length, "component node(s) missing _status:", uncoloured.map((n) => n.id)); process.exit(1); }

  // The #100 clause. chant#1300 emits `resources` for every component with
  // live evidence, INCLUDING on AWS where a `stack` is also present. A row
  // without it means either an older chant (below the 0.34 floor) or a status
  // path that never gathered evidence — both make the paint unverifiable.
  const noRollup = ir.nodes.filter((n) => !(n.attrs && n.attrs._liveStatus && n.attrs._liveStatus.resources));
  if (noRollup.length) {
    console.error("✗", noRollup.length, "component(s) carry no resource rollup:", noRollup.map((n) => n.id).join(", "));
    console.error("  chant must be >= 0.34 (behold#98 / chant#1300) for the rollup to reach behold at all.");
    process.exit(1);
  }

  // And the paint must actually be the rollup talking. A component whose
  // resources are all present, sitting on a healthy stack, is `good` under
  // both the old and new ordering — so the assertion that distinguishes them
  // is the disagreement case: any component whose rollup is NOT all-present
  // must not be painted `good` just because CloudFormation said CREATE_COMPLETE.
  const lying = ir.nodes.filter((n) => {
    const { _status: s, _liveStatus: l } = n.attrs;
    const r = l.resources;
    return s === "good" && r.total > 0 && r.present !== r.total;
  });
  if (lying.length) {
    console.error("✗ painted good over an incomplete rollup — CFN status is still the source:");
    for (const n of lying) console.error("   ", n.id, JSON.stringify(n.attrs._liveStatus.resources), "stack:", JSON.stringify(n.attrs._liveStatus.stack));
    process.exit(1);
  }

  const shape = (n) => { const r = n.attrs._liveStatus.resources; return `${n.id} ${n.attrs._status} ${r.present}/${r.total}${r.unobserved ? ` (${r.unobserved} unread)` : ""}`; };
  console.log(`  ok: ${ir.nodes.length} components, all carrying a rollup`);
  for (const n of ir.nodes) console.log("   ", shape(n));
'

# --------------------------------------------------------------- 2. overlay --
echo "→ (2/3) GET /api/overlay?env=$ENV — the source-anchored live overlay"
curl -sf "http://localhost:$PORT/api/overlay?env=$ENV" >/tmp/behold-aws-logical-overlay.json
node -e '
  const j = JSON.parse(require("node:fs").readFileSync("/tmp/behold-aws-logical-overlay.json", "utf8"));
  if (j.error) { console.error("✗ /api/overlay error:", j.error, j.remedy || ""); process.exit(1); }
  const { ir, svg, meta } = j;
  if (meta.mode !== "overlay") { console.error("✗ expected mode overlay, got", meta.mode); process.exit(1); }
  if (!ir.nodes.length) { console.error("✗ overlay returned no nodes"); process.exit(1); }
  if (!/<svg/.test(svg || "")) { console.error("✗ no svg rendered"); process.exit(1); }

  // Every node chant classified carries `_status` — good/warn/accent/neutral/
  // runtime (src/overlay.ts). A node with none means the join did not reach it.
  const untagged = ir.nodes.filter((n) => !(n.attrs && n.attrs._status));
  if (untagged.length) {
    console.error("✗", untagged.length, "overlay node(s) carry no _status, e.g.", untagged.slice(0, 5).map((n) => `${n.id} (${n.kind})`).join(", "));
    process.exit(1);
  }
  const byStatus = {};
  for (const n of ir.nodes) byStatus[n.attrs._status] = (byStatus[n.attrs._status] || 0) + 1;
  console.log(`  ok: ${ir.nodes.length} nodes, ${ir.edges.length} edges,`, JSON.stringify(byStatus));
'

# --------------------------------------------------------------- 3. logical --
echo "→ (3/3) GET /api/overlay?logical=1&env=$ENV — the nested architecture diagram on live status"
curl -sf "http://localhost:$PORT/api/overlay?logical=1&env=$ENV" >/tmp/behold-aws-logical-arch.json
node -e '
  const j = JSON.parse(require("node:fs").readFileSync("/tmp/behold-aws-logical-arch.json", "utf8"));
  if (j.error) { console.error("✗ logical error:", j.error, j.remedy || ""); process.exit(1); }
  const { ir, svg, byContainer, meta } = j;
  if (meta.mode !== "logical") { console.error("✗ expected mode logical, got", meta.mode); process.exit(1); }
  if (!byContainer) { console.error("✗ no byContainer in the response — behold is older than #100"); process.exit(1); }
  if (!ir.nodes.length) { console.error("✗ no headline cards survived the projection"); process.exit(1); }
  if (!/<svg/.test(svg || "")) { console.error("✗ no svg rendered"); process.exit(1); }

  // Every surviving card must be placed. An unplaced card renders outside every
  // box, which is the failure the nesting exists to prevent.
  const placed = new Set(Object.values(byContainer).flat());
  const orphans = ir.nodes.filter((n) => !placed.has(n.id));
  if (orphans.length) { console.error("✗", orphans.length, "headline card(s) in no container:", orphans.map((n) => n.id).join(", ")); process.exit(1); }

  // The nesting has to be genuinely nested — a VPC box holding a subnet box
  // holding a component box holding cards. A flat map (every component hanging
  // off the global lane) means containment resolution failed, which is exactly
  // what the cross-stack bridge in logical.ts `enrichedRefs` is there to fix.
  const containers = new Set(Object.keys(byContainer));
  const nodeIds = new Set(ir.nodes.map((n) => n.id));
  const depth = (id, seen = new Set()) => {
    if (seen.has(id) || !byContainer[id]) return 0;
    seen.add(id);
    return 1 + Math.max(0, ...byContainer[id].map((c) => depth(c, seen)));
  };
  const roots = [...containers].filter((c) => !Object.values(byContainer).flat().includes(c));
  const deepest = Math.max(0, ...roots.map((r) => depth(r)));
  if (deepest < 2) {
    console.error("✗ containment is flat (depth", deepest + ") — expected at least VPC > component > cards");
    console.error("  byContainer:", JSON.stringify(byContainer, null, 2));
    process.exit(1);
  }

  const vpcBoxes = [...containers].filter((c) => /\bVPC\b/.test(c));
  const subnetBoxes = [...containers].filter((c) => /subnet/i.test(c));
  if (!vpcBoxes.length) { console.error("✗ no VPC box in the nesting — network containment did not resolve"); process.exit(1); }

  // The overlay statuses have to SURVIVE the projection — the logical lens over
  // a live overlay is only worth anything if the cards keep their drift colour.
  const coloured = ir.nodes.filter((n) => n.attrs && n.attrs._status).length;
  if (!coloured) { console.error("✗ no headline card kept its live _status through the projection"); process.exit(1); }

  console.log(`  ok: ${ir.nodes.length} headline cards, ${ir.edges.length} contracted edges, nesting depth ${deepest}`);
  console.log(`      ${vpcBoxes.length} VPC box(es), ${subnetBoxes.length} subnet box(es), ${coloured}/${ir.nodes.length} cards carrying live status`);
  for (const r of roots) console.log("   ", r, "->", byContainer[r].join(", "));
'

echo "✓ behold#100 passed — component status on the #98 rollup, live overlay, and the nested architecture diagram, all on one live AWS estate"
