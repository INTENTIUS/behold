#!/usr/bin/env bash
# behold#994 local E2E: a pulumi member in a chant workspace renders.
#
# Serves e2e/fixtures/pulumi-workspace (one member, `app`, a Pulumi.yaml and
# the `pulumi stack export` checked in beside it as stack-export.json) the way
# `behold serve <root>` serves a declared workspace, through the chant and the
# pulumi lexicon installed beside behold, and asserts:
#   - /api/graph draws the export's five resources as cards (no card for the
#     stack root, chant#4456), edged by parent and dependencies, and no
#     UnreadableMember box;
#   - no card carries a colour other than neutral;
#   - /api/overlay draws the same cards neutral, each saying why nothing was
#     observed. On a chant at behold's drift-record floor (behold#995) the
#     overlay paints the member from `chant workspace drift`, which runs
#     `pulumi refresh --preview-only` per resource; the fixture selects no
#     stack, so each record is not-observed with pulumi's reason, and
#     `meta.driftRecord` lists the member. On an older chant there is no drift
#     read and each card says chant has no live read for a pulumi member.
#
# Nothing reaches a cloud: the refresh runs against PULUMI_BACKEND_URL set to
# an empty local directory below, never Pulumi Cloud or a backend this machine
# is logged in to. Nothing is written under the fixture (chant writes its
# reader project under the OS temp directory).
# Needs @intentius/chant-lexicon-pulumi beside behold at the version the
# fixture's chant.workspace.json pins (chant#4453 moved the kind there, and
# chant reads a pinned package's kinds only at the pinned version).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${BEHOLD_E2E_PORT:-4697}"
FIXTURE="e2e/fixtures/pulumi-workspace"
LOG="${TMPDIR:-/tmp}/behold-pulumi-e2e.log"
PULUMI_BACKEND_DIR="$(mktemp -d "${TMPDIR:-/tmp}/behold-pulumi-backend.XXXXXX")"
export PULUMI_BACKEND_URL="file://$PULUMI_BACKEND_DIR" PULUMI_SKIP_UPDATE_CHECK=true

echo "-> build behold"
npm run build --silent

echo "-> serve $FIXTURE on :$PORT"
node ./bin/behold.js serve "$FIXTURE" --port "$PORT" >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; rm -rf "$PULUMI_BACKEND_DIR"' EXIT

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
        const record = (j.meta?.driftRecord ?? []).some(m => m.member === "app");
        const cards = nodes.filter(n => n.id.startsWith("app/"));
        const said = record
          ? cards.filter(n => n.attrs?._status !== "neutral" || n.attrs?._drift?.status !== "not-observed" || !(n.attrs?._unobserved ?? ""))
          : cards.filter(n => n.attrs?._status !== "neutral" || !/no live read/.test(n.attrs?._unobserved ?? ""));
        if (said.length) fail(said.length + " cards are not neutral with " + (record ? "the drift record not-observed reason" : "the no-live-read reason"));
        console.log("  overlay read: " + (record ? "the drift record from chant, " + JSON.stringify(cards[0].attrs._unobserved) : "no drift read, the no-live-read words"));
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
