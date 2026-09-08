#!/usr/bin/env bash
# behold#372 — the choudoufu-estate lane's acceptance run, against a REAL
# choudoufu on a scratch floci: the bundled demo copied out, its setup run
# (the emulator, provider schemas, the terralith applied), served composed
# with --env live, and the four surfaces the epic (#366) built asserted end
# to end — then one move run BY HAND, exactly as a person would, and the
# receipt read back.
#
#   1. the roster (#369)     — /api/graph: four member boxes, the monolith's 21
#                              cards, team-b's data source drawn to team-a's
#                              VPC (the cross-estate `tofu-estate` edge).
#   2. the overlay (#370)    — /api/overlay?env=live: the monolith green, every
#                              team card `owned by tlmig-sample-monolith` with
#                              an owned-by edge to the monolith's card; team-a's
#                              VPC neutral, NEEDS_DISCOVERY (server-minted,
#                              nothing live to discover).
#   3. the pane (#370)       — /api/diff?env=live carries an entry per composed
#                              id in renderObserved's vocabulary.
#   4. the moves (#371)      — /api/choudoufu/moves?plan=carve.json&dryrun=1
#                              previews five moves through choudoufu's own
#                              -dry-run, followers named by the tool; no
#                              /api/choudoufu/mv exists (404).
#   5. by hand, the receipt  — `choudoufu live-mv -from-estate=… aws_iam_role.team_a`
#                              in team-a's directory, then ?receipt=1 reads
#                              `moved` for the role and `pending` for the rest,
#                              and the overlay's owned-by edge for the role
#                              flips direction.
#
# Scratch discipline (src/scratch.ts): the container is behold-choudoufu-floci
# on 127.0.0.1:4650, refused if it already exists, removed on exit by the
# demo's own down script and nothing else. Skips, exit 0, with the reason,
# when Docker or choudoufu is absent — CI has neither.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${BEHOLD_E2E_PORT:-4699}"
TARGET="${BEHOLD_E2E_TARGET:-$(mktemp -d "${TMPDIR:-/tmp}/behold-choudoufu-e2e.XXXXXX")/estate}"

if ! docker info >/dev/null 2>&1; then echo "skip: Docker is not running"; exit 0; fi
if ! command -v choudoufu >/dev/null 2>&1; then echo "skip: choudoufu is not on PATH"; exit 0; fi
if ! choudoufu version -json | grep -q choudoufu_version; then echo "skip: choudoufu predates version -json's choudoufu_version (needs 0.16.0 or a build from main)"; exit 0; fi
if docker ps -a --format '{{.Names}}' | grep -qx behold-choudoufu-floci; then
  echo "behold-choudoufu-floci already exists — a previous run didn't tear down; \`docker rm -f behold-choudoufu-floci\` and re-run" >&2
  exit 1
fi

echo "→ build behold"
npm run build --silent

echo "→ behold demo choudoufu-estate → $TARGET (copy, setup: floci + init + apply, serve on :$PORT)"
node ./bin/behold.js demo choudoufu-estate "$TARGET" --port "$PORT" >/tmp/behold-choudoufu-e2e.log 2>&1 &
PID=$!
cleanup() {
  kill "$PID" 2>/dev/null || true
  [ -x "$TARGET/scripts/choudoufu-down.sh" ] && bash "$TARGET/scripts/choudoufu-down.sh" || docker rm -f behold-choudoufu-floci >/dev/null 2>&1 || true
}
trap cleanup EXIT

ready=""
for _ in $(seq 1 240); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && { ready=1; break; }
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 1
done
if [ -z "$ready" ]; then echo "behold never answered on :$PORT" >&2; tail -40 /tmp/behold-choudoufu-e2e.log >&2; exit 1; fi

api() { curl -sf "http://localhost:$PORT$1"; }
jq_assert() { # <json> <jq expr that must be true> <message>
  if ! printf '%s' "$1" | jq -e "$2" >/dev/null; then echo "FAIL: $3" >&2; printf '%s' "$1" | jq -c '.' | head -c 1500 >&2; echo >&2; exit 1; fi
  echo "  ✓ $3"
}

echo "→ 1. the roster"
G=$(api "/api/graph")
jq_assert "$G" '(.ir.groups.byStack | keys | length) == 4' "four member boxes"
jq_assert "$G" '(.ir.groups.byStack.monolith | length) == 21' "the monolith's 21 cards"
jq_assert "$G" '[.ir.edges[] | select(.viaAttr == "tofu-estate" and .from == "team-b/data.aws_vpc.team_a_network" and .to == "team-a/aws_vpc.main")] | length == 1' "team-b's data source drawn to team-a's VPC"

echo "→ 2. the overlay"
O=$(api "/api/overlay?env=live")
jq_assert "$O" '[.ir.nodes[] | select(.id | startswith("monolith/")) | .attrs._status] | all(. == "good")' "the monolith is green"
jq_assert "$O" '[.ir.nodes[] | select(.id == "team-a/aws_iam_role.team_a")] | .[0].attrs.ownedBy == "tlmig-sample-monolith"' "team-a's role is owned by the monolith"
jq_assert "$O" '[.ir.edges[] | select(.viaAttr == "owned-by" and .from == "team-a/aws_iam_role.team_a" and .to == "monolith/aws_iam_role.team_a")] | length == 1' "…with an owned-by edge to the monolith's card"
# A VPC's identity is server-minted: with nothing live to discover, the plan
# omits it NEEDS_DISCOVERY (neutral), never ABSENT — the tool's own answer.
VPC=$(printf '%s' "$O" | jq -r '[.ir.nodes[] | select(.id == "team-a/aws_vpc.main")] | .[0].attrs | "\(._status) \(.omission)"')
jq_assert "$O" '[.ir.nodes[] | select(.id == "team-a/aws_vpc.main")] | .[0].attrs | ._status == "neutral" and .omission == "NEEDS_DISCOVERY"' "team-a's VPC is neutral, NEEDS_DISCOVERY: declared, server-minted, nothing live to discover (got: $VPC)"

echo "→ 3. the pane"
D=$(api "/api/diff?env=live")
jq_assert "$D" '.nodes["monolith/aws_iam_role.team_a"].health == "healthy"' "the monolith's role is healthy in the pane"
jq_assert "$D" '.nodes["team-a/aws_iam_role.team_a"].health == "degraded"' "team-a's is degraded (unowned)"

echo "→ 4. the moves"
M=$(api "/api/choudoufu/moves?plan=carve.json&dryrun=1")
jq_assert "$M" '.plan.moves == 5' "five moves in the plan"
jq_assert "$M" '[.moves[] | select(.address == "aws_iam_role.team_a")] | .[0].dryRun.followers | map(.address) | index("aws_iam_role_policy.team_a_inline") != null' "the role's dry run names its inline policy as a follower"
jq_assert "$M" '.apply.human == true' "the apply boundary is on the wire"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:$PORT/api/choudoufu/mv" -H 'content-type: application/json' -d '{}')
[ "$code" = "404" ] && echo "  ✓ /api/choudoufu/mv does not exist ($code)" || { echo "FAIL: /api/choudoufu/mv answered $code" >&2; exit 1; }

echo "→ 5. by hand: the role moves to team-a; the receipt reads it back"
LINE=$(printf '%s' "$M" | jq -r '.moves[] | select(.address == "aws_iam_role.team_a") | .command')
( cd "$TARGET/team-a" && AWS_ENDPOINT_URL=http://127.0.0.1:4650 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
    ${LINE/choudoufu live-mv/choudoufu live-mv -json} | jq -e '.written == true and .verified == true' >/dev/null )
echo "  ✓ $LINE (written, verified)"
R=$(api "/api/choudoufu/moves?plan=carve.json&receipt=1")
jq_assert "$R" '[.receipt.moves[] | select(.address == "aws_iam_role.team_a")] | .[0].state == "moved"' "the receipt says moved"
jq_assert "$R" '[.receipt.moves[] | select(.address == "aws_iam_policy.team_a")] | .[0].state == "pending"' "…and pending for a line not yet run"
O2=$(api "/api/overlay?env=live&consistent=1")
jq_assert "$O2" '[.ir.edges[] | select(.viaAttr == "owned-by" and .from == "monolith/aws_iam_role.team_a" and .to == "team-a/aws_iam_role.team_a")] | length == 1' "the owned-by edge for the role now points from the monolith to team-a"

echo "choudoufu-estate e2e: all green"
