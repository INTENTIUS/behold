#!/usr/bin/env bash
# behold#994 local E2E: a pulumi member in a chant workspace renders.
#
# Serves e2e/fixtures/pulumi-workspace (one member, `app`, a Pulumi.yaml and
# the `pulumi stack export` checked in beside it as stack-export.json) the way
# `behold serve <root>` serves a declared workspace, through the chant and the
# terraform lexicon installed beside behold, and asserts:
#   - /api/graph draws the export's six resources as cards, edged by parent
#     and dependencies, and no UnreadableMember box;
#   - no card carries a colour other than neutral;
#   - /api/overlay draws the same cards neutral, each saying chant has no
#     live read for a pulumi member.
#
# Nothing runs Pulumi, nothing reaches a cloud, and nothing is written under
# the fixture (chant writes its reader project under the OS temp directory).
# Needs @intentius/chant-lexicon-terraform 0.124.49 or newer beside behold.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${BEHOLD_E2E_PORT:-4697}"
FIXTURE="e2e/fixtures/pulumi-workspace"
LOG="${TMPDIR:-/tmp}/behold-pulumi-e2e.log"

echo "-> build behold"
npm run build --silent

echo "-> serve $FIXTURE on :$PORT"
node ./bin/behold.js serve "$FIXTURE" --port "$PORT" >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

ready=""
for _ in $(seq 1 45); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[ -n "$ready" ] || { echo "x behold did not come up"; sed -n '1,40p' "$LOG"; exit 1; }

check() {
  curl -sf "http://localhost:$PORT$1" | node -e '
    const want = [
      "app/app/aws:iam/role:Role::web",
      "app/app/aws:iam/rolePolicy:RolePolicy::webReadsAssets",
      "app/app/aws:s3/bucket:Bucket::assets",
      "app/app/my:mod:Web$aws:lambda/function:Function::handler",
      "app/app/my:mod:Web::web-app",
      "app/app/pulumi:pulumi:Stack::app-dev",
    ];
    const mode = process.argv[1];
    let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => {
      const j = JSON.parse(s);
      const fail = (m) => { console.error("x " + mode + ": " + m); process.exit(1); };
      if (j.error) fail("api error: " + j.error);
      const nodes = j.ir?.nodes ?? [];
      const box = nodes.find(n => n.kind === "UnreadableMember");
      if (box) fail("the member drew as an unreadable box: " + JSON.stringify(box.attrs._unreadable));
      const ids = nodes.map(n => n.id).filter(id => id.startsWith("app/")).sort();
      if (JSON.stringify(ids) !== JSON.stringify(want)) fail("cards " + JSON.stringify(ids));
      if (!(j.ir.edges ?? []).length) fail("no edges");
      if (!/<svg/.test(j.svg || "")) fail("no svg rendered");
      const coloured = nodes.filter(n => n.attrs && n.attrs._status !== undefined && n.attrs._status !== "neutral");
      if (coloured.length) fail(coloured.length + " cards carry a colour behold has no source for");
      if (mode === "overlay") {
        const said = nodes.filter(n => n.attrs?._status !== "neutral" || !/no live read/.test(n.attrs?._unobserved ?? ""));
        if (said.length) fail(said.length + " cards are not neutral with the no-live-read reason");
      }
      console.log("  " + mode + " ok: " + ids.length + " cards, " + j.ir.edges.length + " edges");
    });
  ' "$2"
}

echo "-> GET /api/graph"
check "/api/graph" source
echo "-> GET /api/overlay?env=dev"
check "/api/overlay?env=dev" overlay

echo "ok: pulumi member e2e passed"
