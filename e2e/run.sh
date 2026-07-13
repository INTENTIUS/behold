#!/usr/bin/env bash
# behold local E2E.
#
# Installs the example project's chant (behold shells the project's own chant, so
# this IS the chant install under test), builds behold, serves the example, and
# asserts the read-only API. Two modes, chosen automatically:
#   - source  (no creds): GET /api/graph — the mixed-substrate source graph.
#   - overlay (AWS creds): GET /api/overlay — the source-anchored live drift graph
#                          (queries CloudFormation; all `pending` if nothing is
#                          deployed, which is a valid pass — the point is the path).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${BEHOLD_E2E_PORT:-4699}"
EX="example"

echo "→ install example chant deps (the chant install under test)"
npm --prefix "$EX" install --no-audit --no-fund --silent
echo "  chant: $(node -e "process.stdout.write(require('./$EX/node_modules/@intentius/chant/package.json').version)")"

echo "→ build behold"
npm run build --silent

MODE="source"; ENV_ARGS=()
if aws sts get-caller-identity >/dev/null 2>&1; then
  MODE="overlay"; ENV_ARGS=(--env prod)
  echo "→ AWS creds present — exercising the live overlay"
else
  echo "→ no AWS creds — source graph only (set creds to exercise /api/overlay)"
fi

echo "→ serve $EX on :$PORT ($MODE)"
node ./bin/behold.js serve "$EX" --port "$PORT" "${ENV_ARGS[@]}" >/tmp/behold-e2e.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

ready=""
for _ in $(seq 1 45); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[ -n "$ready" ] || { echo "✗ behold did not come up"; sed -n '1,40p' /tmp/behold-e2e.log; exit 1; }

endpoint="/api/graph"; [ "$MODE" = overlay ] && endpoint="/api/overlay"
echo "→ GET $endpoint"
curl -sf "http://localhost:$PORT$endpoint" | node -e '
  let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => {
    const j = JSON.parse(s);
    if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
    if (!j.ir || !j.ir.nodes.length) { console.error("✗ no nodes"); process.exit(1); }
    if (!/<svg/.test(j.svg || "")) { console.error("✗ no svg rendered"); process.exit(1); }
    if (process.argv[1] === "overlay") {
      const missing = j.ir.nodes.filter(n => !(n.attrs && n.attrs._status));
      if (missing.length) { console.error("✗", missing.length, "nodes missing drift status"); process.exit(1); }
      const st = {}; for (const n of j.ir.nodes) st[n.attrs._status] = (st[n.attrs._status] || 0) + 1;
      console.log("  overlay ok:", j.ir.nodes.length, "nodes,", j.ir.edges.length, "edges, status", JSON.stringify(st));
    } else {
      console.log("  source ok:", j.ir.nodes.length, "nodes,", j.ir.edges.length, "edges");
    }
  });
' "$MODE"

echo "✓ e2e passed ($MODE)"
