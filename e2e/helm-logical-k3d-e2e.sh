#!/usr/bin/env bash
# behold#146 — the helm lane's acceptance run, against a chart project on a
# k3d cluster: artifact presence (the 2-way installed/not vocabulary, never
# managed/foreign), and the logical `release <chart>` box.
#
#   1. overlay, pre-install  — every Helm::Chart node reads `accent`
#                              (declared, not installed) or `neutral` with the
#                              artifact-observation reason; never `good`.
#   2. helm install          — the caller's own chart, installed for real.
#   3. overlay, post-install — the same chart node reads `good`, carrying
#                              `_artifact` with the release and its status.
#   4. logical zoom          — a `release <chart>` byContainer box exists and
#                              holds the chart card.
#
# Like its siblings (aws/azure/gcp/cc), this targets an already-prepared
# project and cluster. It boots and installs NOTHING except the helm release
# itself (step 2), which it uninstalls on exit. The project's chant must be
# ≥ the chant#1516 observedArtifacts payload, and the kube context the
# project's `k8s.profiles.<env>.context` declares must exist.
#
#   BEHOLD_E2E_PROJECT=/path/to/chart/project \
#   BEHOLD_E2E_CHART=./chart-dir BEHOLD_E2E_RELEASE=name just e2e-helm-logical
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${BEHOLD_E2E_PROJECT:?set BEHOLD_E2E_PROJECT to the chart project}"
CHART="${BEHOLD_E2E_CHART:?set BEHOLD_E2E_CHART to the chart path (relative to the project)}"
RELEASE="${BEHOLD_E2E_RELEASE:?set BEHOLD_E2E_RELEASE to the release name}"
PORT="${BEHOLD_E2E_PORT:-4698}"
ENV="${BEHOLD_E2E_ENV:-local}"

command -v helm >/dev/null 2>&1 || { echo "✗ helm not installed"; exit 1; }
[ -d "$PROJECT" ] || { echo "✗ no project at $PROJECT"; exit 1; }

echo "→ build behold"
npm run build --silent

echo "→ serve $PROJECT on :$PORT (env=$ENV)"
node ./bin/behold.js serve "$PROJECT" --env "$ENV" --port "$PORT" >/tmp/behold-helm-e2e.log 2>&1 &
PID=$!
cleanup() {
  kill "$PID" 2>/dev/null || true
  helm uninstall "$RELEASE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ready=""
for _ in $(seq 1 45); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[ -n "$ready" ] || { echo "✗ behold did not come up"; sed -n '1,40p' /tmp/behold-helm-e2e.log; exit 1; }

chart_status() {
  curl -sf "http://localhost:$PORT/api/overlay?env=$ENV" | node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c)).on("end", () => {
      const j = JSON.parse(d);
      if (j.error) { console.error("api error:", j.error); process.exit(1); }
      const charts = j.ir.nodes.filter((n) => n.kind === "Helm::Chart");
      if (!charts.length) { console.error("no Helm::Chart nodes in the overlay"); process.exit(1); }
      for (const c of charts) console.log(c.id, c.attrs._status, JSON.stringify(c.attrs._artifact ?? null));
    });
  '
}

echo "→ (1/4) overlay before install — declared, not installed"
BEFORE="$(chart_status)"
echo "$BEFORE" | sed 's/^/  /'
echo "$BEFORE" | grep -qE " (accent|neutral) " || { echo "✗ expected accent/neutral pre-install"; exit 1; }
echo "$BEFORE" | grep -q " good " && { echo "✗ a chart reads installed before the install"; exit 1; }
echo "  ✓ pre-install: no chart reads installed"

echo "→ (2/4) helm install $RELEASE"
helm upgrade --install "$RELEASE" "$PROJECT/$CHART" --wait >/dev/null
echo "  ✓ release deployed"

echo "→ (3/4) overlay after install — installed, with the release carried"
AFTER="$(chart_status)"
echo "$AFTER" | sed 's/^/  /'
echo "$AFTER" | grep -q " good " || { echo "✗ no chart flipped to installed"; exit 1; }
echo "$AFTER" | grep -q "\"release\":" || { echo "✗ the match carries no release for inspect"; exit 1; }
echo "  ✓ accent -> good across a real helm install"

echo "→ (4/4) logical zoom — the release box"
curl -sf "http://localhost:$PORT/api/overlay?logical=1&env=$ENV" | node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const j = JSON.parse(d);
    if (j.error) { console.error("api error:", j.error); process.exit(1); }
    const releaseBoxes = Object.keys(j.byContainer ?? {}).filter((k) => k.startsWith("release "));
    if (!releaseBoxes.length) { console.error("no release box in the logical projection"); process.exit(1); }
    const charts = new Set(j.ir.nodes.filter((n) => n.kind === "Helm::Chart").map((n) => n.id));
    const holds = releaseBoxes.some((b) => (j.byContainer[b] ?? []).some((m) => charts.has(m)));
    if (!holds) { console.error("no release box holds its chart card"); process.exit(1); }
    console.log("  ✓ release box:", releaseBoxes.join(", "));
  });
'
echo "✓ helm logical acceptance passed"
