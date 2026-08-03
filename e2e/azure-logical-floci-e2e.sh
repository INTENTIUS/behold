#!/usr/bin/env bash
# behold#126 (B·azure acceptance) — the Azure lane's counterpart to
# e2e/aws-logical-floci-e2e.sh, for chant's CC epic (chant#1200, E slot
# chant#1214). #102 shipped the Azure lens with its diagram half verified
# statically against chant's own `k8s-aks-microservice`; the overlay and
# resource-rollup halves had no live run at all. This is that run.
#
# Asserts three things against one estate deployed on floci-az:
#
#   1. component status  — painted from the RESOURCE ROLLUP (#98). On Azure this
#                          is not one source among several, it is the ONLY one:
#                          there is no deploy object, so `stack` is absent and a
#                          rollup-less row has nothing behind its colour. This is
#                          the substrate #98 was written for, and the one the AWS
#                          run cannot stand in for — CloudFormation status can
#                          mask a rollup defect there, and nothing masks it here.
#   2. live overlay      — every declared node classified, read over the ARM
#                          transport chant#1212 swapped in.
#   3. logical zoom      — the RG-nested architecture diagram (#102):
#                          `resource group -> VNet -> subnet` boxes containing
#                          component boxes containing headline resource cards.
#
# Like the AWS run, this targets an already-deployed project and its
# already-running emulator. It boots and installs NOTHING.
#
# ## One deliberate difference from the AWS script
#
# The AWS run pre-checks "the estate is deployed" with
# `aws cloudformation list-stacks`. There is no Azure equivalent to lean on:
# chant's azure reader (`api/read-client.ts`) does targeted GETs by exact
# type+name and never lists, so no listing endpoint is confirmed to exist on
# floci-az. Rather than invent a probe against an API that may not be there,
# this derives "deployed" from behold's own overlay — if nothing observes, the
# overlay assertion fails and says to deploy first. One less pre-flight, and no
# claim about an emulator API this repo cannot verify.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${BEHOLD_E2E_PROJECT:-$HOME/checkouts/intentius/chant/examples/k8s-aks-microservice}"
PORT="${BEHOLD_E2E_PORT:-4698}"
ENV="${BEHOLD_E2E_ENV:-local}"
ENDPOINT="${AZURE_ENDPOINT_URL:-http://localhost:4577}"

echo "→ prerequisite: project checkout"
[ -d "$PROJECT" ] || { echo "✗ no project checkout at $PROJECT (set BEHOLD_E2E_PROJECT)"; exit 1; }
echo "  $PROJECT"

echo "→ prerequisite: floci-az reachable at $ENDPOINT"
# /_floci/health is the emulator's own health path (chant's FLOCI_AZ_SPEC).
if ! curl -sf "$ENDPOINT/_floci/health" >/dev/null 2>&1; then
  echo "✗ floci-az isn't up at $ENDPOINT."
  echo "  Bring it up first (chant's generic emulator lifecycle, not behold's):"
  echo "    cd $PROJECT && npx chant emulator up --lexicon azure"
  exit 1
fi

echo "→ build behold"
npm run build --silent

echo "→ serve $PROJECT on :$PORT (env=$ENV)"
AZURE_ENDPOINT_URL="$ENDPOINT" \
  node ./bin/behold.js serve "$PROJECT" --env "$ENV" --port "$PORT" >/tmp/behold-azure-logical-e2e.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

ready=""
for _ in $(seq 1 45); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[ -n "$ready" ] || { echo "✗ behold did not come up"; sed -n '1,40p' /tmp/behold-azure-logical-e2e.log; exit 1; }

# ---------------------------------------------------------------- 1. status --
echo "→ (1/3) GET /api/graph?components=1&env=$ENV — component status with no deploy object to fall back on"
curl -sf "http://localhost:$PORT/api/graph?components=1&env=$ENV" >/tmp/behold-azure-logical-status.json
ROLLUP_SKIPPED=""
STATUS_RC=0
node -e '
  const j = JSON.parse(require("node:fs").readFileSync("/tmp/behold-azure-logical-status.json", "utf8"));
  if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
  const { ir, meta } = j;
  if (meta.mode !== "component-status") { console.error("✗ expected mode component-status, got", meta.mode); process.exit(1); }

  // Exit 3, not 1 — "this project cannot exercise the clause" is a different
  // fact from "the clause failed", and conflating them reads as a behold bug.
  // The rollup comes from `chant components status`, which has nothing to
  // report for a project that declares no components. Both canonical CC
  // examples (chant `k8s-aks-microservice`, `k8s-gke-microservice`) are in
  // exactly that position — verified, both return 0 component nodes.
  if (!ir.nodes.length) {
    console.error("  ! this project declares no components, so there are no status rows");
    console.error("    The resource rollup (#98) is component-level — `chant components status");
    console.error("    --live --json` is its only source — so the sharpest assertion in this");
    console.error("    run cannot be exercised here. Point BEHOLD_E2E_PROJECT at an azure");
    console.error("    project WITH components. Stages 2 and 3 still run below.");
    process.exit(3);
  }

  const uncoloured = ir.nodes.filter((n) => !(n.attrs && n.attrs._status));
  if (uncoloured.length) { console.error("✗", uncoloured.length, "component node(s) missing _status:", uncoloured.map((n) => n.id)); process.exit(1); }

  // The clause this whole script exists for. On AWS a missing rollup is masked
  // by CloudFormation stack status; here there is nothing behind it, so a
  // rollup-less row means the colour is unsourced.
  const noRollup = ir.nodes.filter((n) => !(n.attrs && n.attrs._liveStatus && n.attrs._liveStatus.resources));
  if (noRollup.length) {
    console.error("✗", noRollup.length, "component(s) carry no resource rollup:", noRollup.map((n) => n.id).join(", "));
    console.error("  Azure has no deploy object, so the rollup is the ONLY status source (#98).");
    console.error("  Needs chant >= 0.34 (chant#1300) AND behold past #123 (the ^0.32.0 floor could not type it).");
    process.exit(1);
  }

  // Azure genuinely has no deploy object. A `stack` here would mean behold is
  // reporting a CloudFormation-shaped fact on a substrate that has none.
  const withStack = ir.nodes.filter((n) => n.attrs._liveStatus.stack);
  if (withStack.length) {
    console.error("✗", withStack.length, "azure component(s) report a deploy object, which Azure does not have:");
    for (const n of withStack) console.error("   ", n.id, JSON.stringify(n.attrs._liveStatus.stack));
    process.exit(1);
  }

  // The paint must follow the rollup, since nothing else can be speaking.
  const lying = ir.nodes.filter((n) => {
    const r = n.attrs._liveStatus.resources;
    return n.attrs._status === "good" && r.total > 0 && r.present !== r.total;
  });
  if (lying.length) {
    console.error("✗ painted good over an incomplete rollup:");
    for (const n of lying) console.error("   ", n.id, JSON.stringify(n.attrs._liveStatus.resources));
    process.exit(1);
  }

  const observed = ir.nodes.filter((n) => n.attrs._liveStatus.resources.present > 0);
  if (!observed.length) {
    console.error("✗ no component observed a single live resource — is the estate deployed to floci-az?");
    console.error("  Deploy it first, then re-run.");
    process.exit(1);
  }

  console.log(`  ok: ${ir.nodes.length} components, all on the rollup, none claiming a deploy object`);
  for (const n of ir.nodes) {
    const r = n.attrs._liveStatus.resources;
    console.log(`    ${n.id} ${n.attrs._status} ${r.present}/${r.total}${r.unobserved ? ` (${r.unobserved} unread)` : ""}`);
  }
' || STATUS_RC=$?
if [ "$STATUS_RC" = "3" ]; then
  ROLLUP_SKIPPED=1
elif [ "$STATUS_RC" != "0" ]; then
  exit "$STATUS_RC"
fi

# --------------------------------------------------------------- 2. overlay --
echo "→ (2/3) GET /api/overlay?env=$ENV — the live overlay over the ARM transport (chant#1212)"
curl -sf "http://localhost:$PORT/api/overlay?env=$ENV" >/tmp/behold-azure-logical-overlay.json
node -e '
  const j = JSON.parse(require("node:fs").readFileSync("/tmp/behold-azure-logical-overlay.json", "utf8"));
  if (j.error) { console.error("✗ /api/overlay error:", j.error, j.remedy || ""); process.exit(1); }
  const { ir, svg, meta } = j;
  if (meta.mode !== "overlay") { console.error("✗ expected mode overlay, got", meta.mode); process.exit(1); }
  if (!ir.nodes.length) { console.error("✗ overlay returned no nodes"); process.exit(1); }
  if (!/<svg/.test(svg || "")) { console.error("✗ no svg rendered"); process.exit(1); }

  const untagged = ir.nodes.filter((n) => !(n.attrs && n.attrs._status));
  if (untagged.length) {
    console.error("✗", untagged.length, "overlay node(s) carry no _status, e.g.", untagged.slice(0, 5).map((n) => `${n.id} (${n.kind})`).join(", "));
    process.exit(1);
  }

  const azure = ir.nodes.filter((n) => n.lexicon === "azure");
  if (!azure.length) { console.error("✗ no azure nodes in the overlay — wrong project?"); process.exit(1); }

  // "Everything pending" is what an undeployed estate looks like, and it would
  // otherwise pass every assertion above.
  const byStatus = {};
  for (const n of ir.nodes) byStatus[n.attrs._status] = (byStatus[n.attrs._status] || 0) + 1;
  if (!azure.some((n) => n.attrs._status === "good" || n.attrs._status === "warn")) {
    console.error("✗ no azure node observed live —", JSON.stringify(byStatus));
    console.error("  Every node pending means nothing is deployed on floci-az. Deploy, then re-run.");
    process.exit(1);
  }
  console.log(`  ok: ${ir.nodes.length} nodes (${azure.length} azure), ${ir.edges.length} edges,`, JSON.stringify(byStatus));
'

# --------------------------------------------------------------- 3. logical --
echo "→ (3/3) GET /api/overlay?logical=1&env=$ENV — the RG-nested architecture diagram on live status"
curl -sf "http://localhost:$PORT/api/overlay?logical=1&env=$ENV" >/tmp/behold-azure-logical-arch.json
node -e '
  const j = JSON.parse(require("node:fs").readFileSync("/tmp/behold-azure-logical-arch.json", "utf8"));
  if (j.error) { console.error("✗ logical error:", j.error, j.remedy || ""); process.exit(1); }
  const { ir, svg, byContainer, meta } = j;
  if (meta.mode !== "logical") { console.error("✗ expected mode logical, got", meta.mode); process.exit(1); }
  if (!byContainer) { console.error("✗ no byContainer in the response"); process.exit(1); }
  if (!ir.nodes.length) { console.error("✗ no headline cards survived the projection"); process.exit(1); }
  if (!/<svg/.test(svg || "")) { console.error("✗ no svg rendered"); process.exit(1); }

  const placed = new Set(Object.values(byContainer).flat());
  const orphans = ir.nodes.filter((n) => !placed.has(n.id));
  if (orphans.length) { console.error("✗", orphans.length, "headline card(s) in no container:", orphans.map((n) => n.id).join(", ")); process.exit(1); }

  const containers = new Set(Object.keys(byContainer));
  const depth = (id, seen = new Set()) => {
    if (seen.has(id) || !byContainer[id]) return 0;
    seen.add(id);
    return 1 + Math.max(0, ...byContainer[id].map((c) => depth(c, seen)));
  };
  const roots = [...containers].filter((c) => !Object.values(byContainer).flat().includes(c));
  const deepest = Math.max(0, ...roots.map((r) => depth(r)));
  if (deepest < 2) {
    console.error("✗ containment is flat (depth", deepest + ") — expected resource group > VNet/subnet > cards");
    console.error("  byContainer:", JSON.stringify(byContainer, null, 2));
    process.exit(1);
  }

  // #102 azure-specific: the outermost box is the resource group, and it is NOT
  // a declared resource — an ARM template deploys INTO a group, resolved at
  // deploy time. So it comes from the environment (src/logical-azure.ts
  // RG_TITLE), and the AWS lens has nothing like it. Its absence means the
  // azure lens did not run, or ran without an env.
  const rgBoxes = [...containers].filter((c) => /^resource group\b/.test(c));
  if (!rgBoxes.length) {
    console.error("✗ no resource-group box — the azure lens did not produce RG nesting");
    console.error("  containers:", [...containers].join(" | "));
    process.exit(1);
  }
  if (!roots.some((r) => /^resource group\b/.test(r))) {
    console.error("✗ the resource group is not the outermost box; roots:", roots.join(" | "));
    process.exit(1);
  }

  // No VPC anywhere — that is the AWS lens leaking into an azure estate.
  const vpcBoxes = [...containers].filter((c) => /\bVPC\b/.test(c));
  if (vpcBoxes.length) { console.error("✗ AWS lens ran on an azure estate — VPC boxes:", vpcBoxes.join(", ")); process.exit(1); }

  const vnetBoxes = [...containers].filter((c) => /^VNet\b/.test(c));
  const subnetBoxes = [...containers].filter((c) => /^subnet\b/.test(c));

  const coloured = ir.nodes.filter((n) => n.attrs && n.attrs._status).length;
  if (!coloured) { console.error("✗ no headline card kept its live _status through the projection"); process.exit(1); }

  console.log(`  ok: ${ir.nodes.length} headline cards, ${ir.edges.length} contracted edges, nesting depth ${deepest}`);
  console.log(`      ${rgBoxes.length} RG box, ${vnetBoxes.length} VNet box(es), ${subnetBoxes.length} subnet box(es), ${coloured}/${ir.nodes.length} cards carrying live status`);
  for (const r of roots) console.log("   ", r, "->", byContainer[r].join(", "));
'

if [ -n "$ROLLUP_SKIPPED" ]; then
  echo
  echo "✗ overlay and architecture diagram passed, but the ROLLUP clause never ran —"
  echo "  this project declares no components. That clause is the reason this script"
  echo "  exists (Azure has no deploy object, so nothing else can source the colour),"
  echo "  so a run without it is not an acceptance. Re-run against a component-bearing"
  echo "  azure project."
  exit 1
fi

echo "✓ behold#126 (azure) passed — rollup-sourced component status with no deploy object, live overlay over ARM, and the RG-nested architecture diagram, on one live floci-az estate"
