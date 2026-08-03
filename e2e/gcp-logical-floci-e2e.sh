#!/usr/bin/env bash
# behold#126 (B·gcp acceptance) — the GCP lane's counterpart to
# e2e/aws-logical-floci-e2e.sh, for chant's CC epic (chant#1199, E slot
# chant#1211). #101 shipped the GCP lens with its diagram half verified
# statically; the overlay and resource-rollup halves had no live run.
#
# Asserts three things against one estate deployed on floci-gcp:
#
#   1. component status  — painted from the RESOURCE ROLLUP (#98). As on Azure,
#                          GCP has no deploy object, so the rollup is the only
#                          status source and a rollup-less row has nothing
#                          behind its colour.
#   2. live overlay      — every declared node classified, read over the
#                          direct-REST transport chant#1209 swapped in (which is
#                          also what made behold#125's target entry possible).
#   3. logical zoom      — the project/location diagram (#101):
#                          `project -> location -> component ⊃ resource`, with
#                          NO network containment. floci-gcp emulates no compute
#                          networking, so subnet boxes would stay permanently
#                          empty — #101 settled that GCP does not get the
#                          AWS/Azure shape, and this asserts it stays that way.
#
# Like the AWS and Azure runs, this targets an already-deployed project and its
# already-running emulator. It boots and installs NOTHING.
#
# ## Prerequisite that is NOT behold's
#
# chant#1431: `FLOCI_GCP_EMULATOR` injects no env, so `chant emulator up
# --lexicon gcp` boots the emulator and leaves `GCP_ENDPOINT_URL` unset — which
# points chant's GCP read path at REAL GCP. Until that lands, this script sets
# the variable itself (behold does the same for its own shell-outs, which is why
# behold#125 works regardless). If you see live reads failing on credentials,
# that is the bug, not this script.
#
# Like the Azure run, "is the estate deployed" is derived from behold's own
# overlay rather than a pre-flight list call — chant's GCP reader does targeted
# reads and never lists, so there is no listing endpoint here to lean on.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${BEHOLD_E2E_PROJECT:-$HOME/checkouts/intentius/chant/examples/k8s-gke-microservice}"
PORT="${BEHOLD_E2E_PORT:-4697}"
ENV="${BEHOLD_E2E_ENV:-local}"
ENDPOINT="${GCP_ENDPOINT_URL:-http://localhost:4588}"

echo "→ prerequisite: project checkout"
[ -d "$PROJECT" ] || { echo "✗ no project checkout at $PROJECT (set BEHOLD_E2E_PROJECT)"; exit 1; }
echo "  $PROJECT"

echo "→ prerequisite: floci-gcp reachable at $ENDPOINT"
# /_floci-gcp/health is the emulator's own health path (chant's FLOCI_GCP_SPEC).
if ! curl -sf "$ENDPOINT/_floci-gcp/health" >/dev/null 2>&1; then
  echo "✗ floci-gcp isn't up at $ENDPOINT."
  echo "  Bring it up first (chant's generic emulator lifecycle, not behold's):"
  echo "    cd $PROJECT && npx chant emulator up --lexicon gcp"
  exit 1
fi

echo "→ build behold"
npm run build --silent

echo "→ serve $PROJECT on :$PORT (env=$ENV)"
# GCP_ENDPOINT_URL set explicitly — see the chant#1431 note above.
GCP_ENDPOINT_URL="$ENDPOINT" \
  node ./bin/behold.js serve "$PROJECT" --env "$ENV" --port "$PORT" >/tmp/behold-gcp-logical-e2e.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

ready=""
for _ in $(seq 1 45); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[ -n "$ready" ] || { echo "✗ behold did not come up"; sed -n '1,40p' /tmp/behold-gcp-logical-e2e.log; exit 1; }

# ---------------------------------------------------------------- 1. status --
echo "→ (1/3) GET /api/graph?components=1&env=$ENV — component status with no deploy object to fall back on"
curl -sf "http://localhost:$PORT/api/graph?components=1&env=$ENV" >/tmp/behold-gcp-logical-status.json
ROLLUP_SKIPPED=""
STATUS_RC=0
node -e '
  const j = JSON.parse(require("node:fs").readFileSync("/tmp/behold-gcp-logical-status.json", "utf8"));
  if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
  const { ir, meta } = j;
  if (meta.mode !== "component-status") { console.error("✗ expected mode component-status, got", meta.mode); process.exit(1); }

  // Exit 3, not 1 — "this project cannot exercise the clause" is a different
  // fact from "the clause failed". The rollup comes from `chant components
  // status`, which has nothing to report for a project declaring no components.
  // Both canonical CC examples (chant `k8s-gke-microservice`,
  // `k8s-aks-microservice`) are in exactly that position — verified, both
  // return 0 component nodes.
  if (!ir.nodes.length) {
    console.error("  ! this project declares no components, so there are no status rows");
    console.error("    The resource rollup (#98) is component-level — `chant components status");
    console.error("    --live --json` is its only source — so the sharpest assertion in this");
    console.error("    run cannot be exercised here. Point BEHOLD_E2E_PROJECT at a gcp");
    console.error("    project WITH components. Stages 2 and 3 still run below.");
    process.exit(3);
  }

  const uncoloured = ir.nodes.filter((n) => !(n.attrs && n.attrs._status));
  if (uncoloured.length) { console.error("✗", uncoloured.length, "component node(s) missing _status:", uncoloured.map((n) => n.id)); process.exit(1); }

  const noRollup = ir.nodes.filter((n) => !(n.attrs && n.attrs._liveStatus && n.attrs._liveStatus.resources));
  if (noRollup.length) {
    console.error("✗", noRollup.length, "component(s) carry no resource rollup:", noRollup.map((n) => n.id).join(", "));
    console.error("  GCP has no deploy object, so the rollup is the ONLY status source (#98).");
    console.error("  Needs chant >= 0.34 (chant#1300) AND behold past #123 (the ^0.32.0 floor could not type it).");
    process.exit(1);
  }

  const withStack = ir.nodes.filter((n) => n.attrs._liveStatus.stack);
  if (withStack.length) {
    console.error("✗", withStack.length, "gcp component(s) report a deploy object, which GCP does not have:");
    for (const n of withStack) console.error("   ", n.id, JSON.stringify(n.attrs._liveStatus.stack));
    process.exit(1);
  }

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
    console.error("✗ no component observed a single live resource — is the estate deployed to floci-gcp?");
    console.error("  Also check GCP_ENDPOINT_URL actually reached chant (chant#1431).");
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
echo "→ (2/3) GET /api/overlay?env=$ENV — the live overlay over direct REST (chant#1209)"
curl -sf "http://localhost:$PORT/api/overlay?env=$ENV" >/tmp/behold-gcp-logical-overlay.json
node -e '
  const j = JSON.parse(require("node:fs").readFileSync("/tmp/behold-gcp-logical-overlay.json", "utf8"));
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

  const gcp = ir.nodes.filter((n) => n.lexicon === "gcp");
  if (!gcp.length) { console.error("✗ no gcp nodes in the overlay — wrong project?"); process.exit(1); }

  const byStatus = {};
  for (const n of ir.nodes) byStatus[n.attrs._status] = (byStatus[n.attrs._status] || 0) + 1;
  if (!gcp.some((n) => n.attrs._status === "good" || n.attrs._status === "warn")) {
    console.error("✗ no gcp node observed live —", JSON.stringify(byStatus));
    console.error("  Every node pending means nothing is deployed, or the reader never reached the emulator (chant#1431).");
    process.exit(1);
  }

  // The mixed-substrate half chant#1211 asserts: floci-gcp k3s-backs GKE, so a
  // canonical estate carries the k8s workload beside the GKE cluster. Reported,
  // not required — the assertion belongs to the E slot, and this run should
  // still be useful against a cloud-only project.
  const k8s = ir.nodes.filter((n) => n.lexicon === "k8s").length;
  console.log(`  ok: ${ir.nodes.length} nodes (${gcp.length} gcp, ${k8s} k8s), ${ir.edges.length} edges,`, JSON.stringify(byStatus));
'

# --------------------------------------------------------------- 3. logical --
echo "→ (3/3) GET /api/overlay?logical=1&env=$ENV — the project/location diagram on live status"
curl -sf "http://localhost:$PORT/api/overlay?logical=1&env=$ENV" >/tmp/behold-gcp-logical-arch.json
node -e '
  const j = JSON.parse(require("node:fs").readFileSync("/tmp/behold-gcp-logical-arch.json", "utf8"));
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
    console.error("✗ containment is flat (depth", deepest + ") — expected project > location > cards");
    console.error("  byContainer:", JSON.stringify(byContainer, null, 2));
    process.exit(1);
  }

  // #101 gcp-specific: the project is the outermost box and is NOT a declared
  // resource — CNRM carries it as an annotation chant resolves at deploy time,
  // so it comes from source only when pinned literally, else from the env.
  const projectBoxes = [...containers].filter((c) => /^project\b/.test(c));
  if (!projectBoxes.length) {
    console.error("✗ no project box — the gcp lens did not produce project nesting");
    console.error("  containers:", [...containers].join(" | "));
    process.exit(1);
  }
  if (!roots.some((r) => /^project\b/.test(r))) {
    console.error("✗ the project is not the outermost box; roots:", roots.join(" | "));
    process.exit(1);
  }

  // The negative assertion #101 settled, and the reason this is not a copy of
  // the AWS run: floci-gcp emulates NO compute networking, so a network lens
  // would draw subnet boxes that stayed permanently empty. Their appearance
  // means the AWS or Azure lens ran on a gcp estate.
  const networkBoxes = [...containers].filter((c) => /\bVPC\b|^subnet\b|^VNet\b|resource group/.test(c));
  if (networkBoxes.length) {
    console.error("✗ network containment on a GCP estate — wrong lens ran:", networkBoxes.join(", "));
    process.exit(1);
  }

  const locationBoxes = [...containers].filter((c) => /^location\b/.test(c));
  if (!locationBoxes.length && !containers.has("global")) {
    console.error("✗ neither a location box nor the global lane — resources carry no `location` and none is global");
    console.error("  containers:", [...containers].join(" | "));
    process.exit(1);
  }

  const coloured = ir.nodes.filter((n) => n.attrs && n.attrs._status).length;
  if (!coloured) { console.error("✗ no headline card kept its live _status through the projection"); process.exit(1); }

  console.log(`  ok: ${ir.nodes.length} headline cards, ${ir.edges.length} contracted edges, nesting depth ${deepest}`);
  console.log(`      ${projectBoxes.length} project box, ${locationBoxes.length} location box(es)${containers.has("global") ? " + global lane" : ""}, ${coloured}/${ir.nodes.length} cards carrying live status`);
  for (const r of roots) console.log("   ", r, "->", byContainer[r].join(", "));
'

if [ -n "$ROLLUP_SKIPPED" ]; then
  echo
  echo "✗ overlay and architecture diagram passed, but the ROLLUP clause never ran —"
  echo "  this project declares no components. That clause is the reason this script"
  echo "  exists (GCP has no deploy object, so nothing else can source the colour),"
  echo "  so a run without it is not an acceptance. Re-run against a component-bearing"
  echo "  gcp project."
  exit 1
fi

echo "✓ behold#126 (gcp) passed — rollup-sourced component status with no deploy object, live overlay over direct REST, and the project/location diagram with no network containment, on one live floci-gcp estate"
