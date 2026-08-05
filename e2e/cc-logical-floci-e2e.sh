#!/usr/bin/env bash
# behold#148 — the mixed-substrate (CC) acceptance run, against chant's
# `examples/cc-aws-canonical` deployed on Floci: the same estate chant's own
# `just aws-cc-e2e` deploys, probed from behold's side of the bar.
#
# The aws/azure/gcp logical runs each assert their own substrate's boxes and
# only PRINT the roots — a second, disconnected root passes all three silently.
# This run asserts the one claim every CC lane carries and none of them checks:
# "behold observes both substrates in ONE graph."
#
#   1. live overlay      — both lexicons present, every node classified.
#   2. logical zoom      — the k8s half nests INSIDE the managed-cluster box
#                          (#142): the cluster node's id is a byContainer key
#                          holding the namespace boxes, and that key is itself a
#                          member of a component box — one root, not two. The
#                          env-named `cluster <env>` box must not exist.
#   3. runtime zoom      — a Deployment-less estate reports the honest
#                          "nothing below the declaration boundary" note; an
#                          estate with live Pods must list each owner inside
#                          its own runtime box (#144).
#
# Like its three siblings, this targets an already-deployed project and its
# already-running emulator. It boots and installs NOTHING. Deploy first with
# chant's own steps (see chant test/aws-cc-e2e.sh steps 0-3), export the same
# AWS_ENDPOINT_URL + KUBECONFIG that deploy used, and point BEHOLD_E2E_PROJECT
# at the deployed copy.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${BEHOLD_E2E_PROJECT:-$HOME/checkouts/intentius/chant/examples/cc-aws-canonical}"
PORT="${BEHOLD_E2E_PORT:-4697}"
ENV="${BEHOLD_E2E_ENV:-local}"
ENDPOINT="${AWS_ENDPOINT_URL:-http://localhost:4566}"

echo "→ prerequisite: project checkout"
[ -d "$PROJECT" ] || { echo "✗ no project checkout at $PROJECT (set BEHOLD_E2E_PROJECT)"; exit 1; }
echo "  $PROJECT"

echo "→ prerequisite: Floci reachable at $ENDPOINT"
if ! curl -sf "$ENDPOINT/_localstack/health" >/dev/null 2>&1; then
  echo "✗ Floci isn't up at $ENDPOINT (export AWS_ENDPOINT_URL to point elsewhere)."
  echo "  Deploy the estate first — chant's test/aws-cc-e2e.sh steps 0-3 are the recipe."
  exit 1
fi

echo "→ build behold"
npm run build --silent

echo "→ serve $PROJECT on :$PORT (env=$ENV)"
node ./bin/behold.js serve "$PROJECT" --env "$ENV" --port "$PORT" >/tmp/behold-cc-logical-e2e.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

ready=""
for _ in $(seq 1 45); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[ -n "$ready" ] || { echo "✗ behold did not come up"; sed -n '1,40p' /tmp/behold-cc-logical-e2e.log; exit 1; }

# --------------------------------------------------------------- 1. overlay --
echo "→ (1/3) GET /api/overlay?env=$ENV — both substrates, one graph"
curl -sf "http://localhost:$PORT/api/overlay?env=$ENV" >/tmp/behold-cc-overlay.json
node -e '
  const j = JSON.parse(require("node:fs").readFileSync("/tmp/behold-cc-overlay.json", "utf8"));
  if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
  const { ir, meta } = j;
  if (meta.mode !== "overlay") { console.error("✗ expected mode overlay, got", meta.mode); process.exit(1); }
  const lexicons = new Set(ir.nodes.map((n) => n.lexicon));
  if (!lexicons.has("aws") || !lexicons.has("k8s")) {
    console.error("✗ expected both aws and k8s nodes in one overlay, got:", [...lexicons].join(", "));
    console.error("  Is the estate deployed? chant test/aws-cc-e2e.sh steps 0-3 are the recipe.");
    process.exit(1);
  }
  const uncoloured = ir.nodes.filter((n) => !(n.attrs && n.attrs._status));
  if (uncoloured.length) { console.error("✗", uncoloured.length, "node(s) missing _status:", uncoloured.map((n) => n.id).join(", ")); process.exit(1); }
  console.log("  ✓ one overlay:", ir.nodes.length, "nodes across", [...lexicons].sort().join("+"), "— every node classified");
'

# --------------------------------------------------------------- 2. logical --
echo "→ (2/3) GET /api/overlay?logical=1&env=$ENV — the cluster join (#142)"
curl -sf "http://localhost:$PORT/api/overlay?logical=1&env=$ENV" >/tmp/behold-cc-logical.json
CC_ENV="$ENV" node -e '
  const j = JSON.parse(require("node:fs").readFileSync("/tmp/behold-cc-logical.json", "utf8"));
  if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
  const { ir, byContainer, meta } = j;
  if (meta.mode !== "logical") { console.error("✗ expected mode logical, got", meta.mode); process.exit(1); }
  if (!byContainer || !Object.keys(byContainer).length) { console.error("✗ no byContainer nesting in the logical response"); process.exit(1); }

  const MANAGED = new Set(["AWS::EKS::Cluster", "GCP::Container::Cluster", "Microsoft.ContainerService/managedClusters"]);
  const clusters = ir.nodes.filter((n) => MANAGED.has(n.kind));
  if (clusters.length !== 1) {
    console.error("✗ expected exactly one managed cluster in the projection, found", clusters.length);
    process.exit(1);
  }
  const clusterId = clusters[0].id;

  // The join itself: the cluster node id is a container key holding namespaces.
  const held = byContainer[clusterId] ?? [];
  const namespaces = held.filter((m) => /^namespace /.test(m));
  if (!namespaces.length) {
    console.error("✗ the managed cluster box holds no namespace boxes — the k8s half is not joined.");
    console.error("  byContainer[" + JSON.stringify(clusterId) + "] =", JSON.stringify(held));
    process.exit(1);
  }
  const k8sIds = new Set(ir.nodes.filter((n) => n.lexicon === "k8s").map((n) => n.id));
  const nested = namespaces.some((ns) => (byContainer[ns] ?? []).some((m) => k8sIds.has(m)));
  if (!nested) { console.error("✗ no k8s node inside any of the cluster box namespaces"); process.exit(1); }

  // One root, not two: the cluster box must be a MEMBER of something (the
  // component box the cloud lens placed it in), and the env-named synthetic
  // box must not exist.
  const members = new Set(Object.values(byContainer).flat());
  if (!members.has(clusterId)) {
    console.error("✗ the cluster box is a root — nothing nests it, so the picture still has two roots");
    process.exit(1);
  }
  const envBox = "cluster " + (process.env.CC_ENV ?? "local");
  if (byContainer[envBox]) {
    console.error("✗ the synthetic", JSON.stringify(envBox), "box still exists beside the joined cluster");
    process.exit(1);
  }
  console.log("  ✓ joined:", clusterId, "⊃", namespaces.join(", "), "— and", clusterId, "is itself nested (one root)");
'

# --------------------------------------------------------------- 3. runtime --
echo "→ (3/3) GET /api/overlay?env=$ENV&detail=3&runtime=1 — the tier below the declaration boundary"
curl -sf "http://localhost:$PORT/api/overlay?env=$ENV&detail=3&runtime=1" >/tmp/behold-cc-runtime.json
node -e '
  const j = JSON.parse(require("node:fs").readFileSync("/tmp/behold-cc-runtime.json", "utf8"));
  if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
  const { ir, meta } = j;
  const owned = ir.nodes.filter((n) => n.runtimeOwner);
  if (!owned.length) {
    // A Service-only estate has no owner-referenced children; the honest note
    // is the assertion (#86), not a fabricated Pod.
    const note = meta.note ?? "";
    if (!/declaration boundary/.test(note)) {
      console.error("✗ no runtime children and no honest note about it — got:", JSON.stringify(note));
      process.exit(1);
    }
    console.log("  ✓ no runtime children, and the note says so:", JSON.stringify(note));
    process.exit(0);
  }
  // Live Pods: each owner must sit inside its own runtime box (#144).
  const byContainer = (ir.groups && ir.groups.byContainer) || {};
  const owners = [...new Set(owned.map((n) => n.runtimeOwner))];
  for (const owner of owners) {
    const box = byContainer[owner] ?? [];
    if (!box.includes(owner)) {
      console.error("✗ owner", JSON.stringify(owner), "is not a member of its own runtime box:", JSON.stringify(box));
      process.exit(1);
    }
  }
  console.log("  ✓", owned.length, "runtime child(ren) across", owners.length, "owner box(es), each owner inside its own box");
'

echo "✓ cc logical acceptance passed"
