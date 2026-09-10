#!/usr/bin/env bash
# behold#391 — the workbench catalog's acceptance run (M5 of #386).
#
# Every entry in `workbench.json` — the catalog this checkout carries and the
# npm package does not — loaded through `behold demo <entry> <tmp target>` and
# asserted over HTTP, in catalog order, one behold per entry on its own port
# from 4720 up:
#
#   - `missingRequirements` (src/demos.ts) decides first. A binary that is not
#     on PATH, a sibling checkout nobody has, an optional peer behold does not
#     install — each prints `skip: <entry>: needs …` and the run moves on. CI
#     has no Docker, no choudoufu, no siblings, so every entry skips there and
#     the script exits 0, the way e2e/choudoufu-estate-floci-e2e.sh does.
#   - what survives is served: wait for /healthz, then /api/graph must carry
#     nodes (the count is printed), and a live entry's /api/overlay?env=<env>
#     must answer with its bound/unowned/neutral split.
#   - `terralith-4-adopt` is the one entry asserted twice: stock terraform
#     applied that estate, so every card serves UNOWNED. The script then runs
#     the `choudoufu live-import` line the up script PRINTED, by hand, in the
#     target — behold never runs that write (#372's boundary) — and the same
#     overlay reads bound afterwards.
#   - `waterpark` is served in place out of a working checkout, so
#     `git status --porcelain` there must be as empty after as before (#384:
#     nothing is written under a served Terraform estate).
#
# Scratch discipline (src/scratch.ts, and workbench/lib/common.sh's bash half):
# each entry's emulator is `behold-wb-<entry>` on the entry's own port, and it
# is torn down through the `scripts/down.sh` its own up script wrote into the
# target — never `docker rm` by pattern. The run refuses to start if a
# behold-wb-* container is already there, and fails if one is left behind.
#
#   just e2e-workbench
#   BEHOLD_E2E_PORT=4740 just e2e-workbench          # a different port block
#   BEHOLD_E2E_ONLY="terralith-1 waterpark" just e2e-workbench
set -euo pipefail
cd "$(dirname "$0")/.."

PORT_BASE="${BEHOLD_E2E_PORT:-4720}"
ONLY="${BEHOLD_E2E_ONLY:-}"
# The longest entry is the terralith at scale 4 adopted from a stock apply:
# a terraform apply and a choudoufu init over 301 resources before behold
# answers at all.
WAIT="${BEHOLD_E2E_WAIT:-600}"

# The one entry excluded BY NAME rather than by a missing requirement: its
# setup is ../fountain-ops's own `just up`, which boots a five-minute k3d
# cluster in that working copy and switches your kubectl context. Everything
# else here is scratch; that one is not, so it stays a by-hand run.
excluded_reason() {
  case "$1" in
    fountain-ops) echo "excluded by name — its setup is ../fountain-ops's own \`just up\`: a five-minute k3d cluster built in that working copy, and it switches your kubectl context. Run it by hand: just example name=\"fountain-ops\"" ;;
    *) echo "" ;;
  esac
}

command -v jq >/dev/null 2>&1 || { echo "skip: jq is not on PATH (every assertion here reads JSON)"; exit 0; }
[ -x ./node_modules/.bin/tsx ] || { echo "run npm install first — the catalog is read through src/demos.ts, with tsx" >&2; exit 1; }
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  LEFT="$(docker ps -a --format '{{.Names}}' | grep '^behold-wb-' || true)"
  if [ -n "$LEFT" ]; then
    echo "workbench containers already exist — a previous run didn't tear down:" >&2
    echo "$LEFT" | sed 's/^/  /' >&2
    echo "run \`bash scripts/down.sh\` in each target, then re-run" >&2
    exit 1
  fi
fi

echo "→ build behold"
npm run build --silent

# The catalog, read through the same functions behold reads it with: the
# registry merge, `missingRequirements`, `demoLocalPath`, and — for an entry
# served in place — the two preconditions that are not a binary on PATH: an
# uninstalled chant example (an in-place entry is never installed, #390) and
# the Terraform lexicon behold declares as an optional peer and does not ship.
CATALOG="$(./node_modules/.bin/tsx -e "$(
  cat <<'JS'
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadDemoRegistry, missingRequirements, demoLocalPath } from "./src/demos.ts";
import { hasTerraformRoots, terraformReaderState } from "./src/terraform-member.ts";

const out = [];
for (const e of loadDemoRegistry(process.cwd())) {
  if (e.catalog !== "workbench") continue;
  const local = demoLocalPath(e) ?? "";
  const missing = missingRequirements(e);
  let reason = missing.length ? `needs ${missing.join(", ")}` : "";
  if (!reason && e.inPlace && local) {
    if (existsSync(join(local, "package.json")) && !existsSync(join(local, "node_modules"))) {
      reason = `needs its own node_modules — an in-place entry is served exactly as it sits and behold installs nothing there (npm install in ${local})`;
    } else if (hasTerraformRoots(local)) {
      const refusal = terraformReaderState().refusal;
      if (refusal) reason = `needs the Terraform lexicon behold does not install — ${refusal.remedy}`;
    }
  }
  // The unit separator, not a tab: `read` in bash folds a run of IFS
  // WHITESPACE into one delimiter, so an entry with no env would shift every
  // field after it by one.
  out.push([e.name, e.serve.env ?? "", e.inPlace ? "1" : "0", local, reason].join("\u001f"));
}
process.stdout.write(out.join("\n"));
JS
)")"

[ -n "$CATALOG" ] || { echo "no workbench catalog in this checkout (workbench.json missing?)" >&2; exit 1; }

PID=""; TARGET=""; INPLACE="0"; ENTRY=""
teardown() { # tear the entry currently up down, through its own down script
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  PID=""
  # An in-place entry's "target" is somebody's checkout, and a checkout may
  # well have a scripts/down.sh of its own — the workbench never wrote it and
  # this run never runs it.
  if [ "$INPLACE" = "0" ] && [ -n "$TARGET" ] && [ -f "$TARGET/scripts/down.sh" ]; then
    bash "$TARGET/scripts/down.sh" || true
  fi
  TARGET=""
}
trap teardown EXIT

api() { curl -sf "http://localhost:$1$2"; }
jq_assert() { # <json> <jq expr that must be true> <message>
  if ! printf '%s' "$1" | jq -e "$2" >/dev/null; then echo "FAIL: $ENTRY: $3" >&2; printf '%s' "$1" | jq -c '.' | head -c 1200 >&2; echo >&2; exit 1; fi
  echo "  ✓ $3"
}
# The live half's three words for a card, from src/choudoufu-live.ts: bound
# (the plan matched an identity), UNOWNED (live, and this estate does not own
# it), neutral (looked, and could not answer).
counts() { printf '%s' "$1" | jq -r '[([.ir.nodes[]|select(.attrs._status=="good")]|length), ([.ir.nodes[]|select(.attrs.omission=="UNOWNED")]|length), ([.ir.nodes[]|select(.attrs._status=="neutral")]|length)] | @tsv'; }

TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/behold-workbench-e2e.XXXXXX")"
RAN=0; SKIPPED=0; i=-1
RUN_T0=$SECONDS

while IFS=$'\x1f' read -r name env inplace local reason <&3; do
  [ -n "$name" ] || continue
  i=$((i + 1))
  port=$((PORT_BASE + i))
  if [ -n "$ONLY" ] && ! printf ' %s ' "$ONLY" | grep -q " $name "; then continue; fi
  excluded="$(excluded_reason "$name")"
  if [ -n "$excluded" ]; then reason="$excluded"; fi
  if [ -n "$reason" ]; then
    echo "skip: $name: $reason"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  ENTRY="$name"; INPLACE="$inplace"
  # An in-place entry is served out of a working checkout, which may well be
  # dirty before we touch it. What must not change is what the serve leaves
  # behind, so the check is before against after, not "is this tree clean".
  before=""
  if [ "$inplace" = "1" ] && git -C "$local" rev-parse --git-dir >/dev/null 2>&1; then
    before="$(git -C "$local" status --porcelain)"
  fi
  t0=$SECONDS
  TARGET="$TMPROOT/$name"
  log="$TMPROOT/$name.log"
  echo
  echo "→ $name (:$port${env:+, --env $env})"
  node ./bin/behold.js demo "$name" "$TARGET" --port "$port" >"$log" 2>&1 </dev/null &
  PID=$!

  ready=""
  for _ in $(seq 1 "$WAIT"); do
    curl -sf "http://localhost:$port/healthz" >/dev/null 2>&1 && { ready=1; break; }
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  if [ -z "$ready" ]; then
    echo "FAIL: $name: behold never answered on :$port" >&2
    tail -40 "$log" >&2
    exit 1
  fi
  echo "  up in $((SECONDS - t0))s"

  G="$(api "$port" "/api/graph")"
  jq_assert "$G" '(.ir.nodes | length) > 0' "$(printf '%s nodes, %s edges in /api/graph' "$(printf '%s' "$G" | jq -r '.ir.nodes|length')" "$(printf '%s' "$G" | jq -r '.ir.edges|length')")"

  if [ -n "$env" ]; then
    O="$(api "$port" "/api/overlay?env=$env")"
    jq_assert "$O" '(.ir.nodes | length) > 0' "/api/overlay?env=$env answers"
    IFS=$'\t' read -r bound unowned neutral <<<"$(counts "$O")"
    echo "  ✓ overlay: bound $bound, unowned $unowned, neutral $neutral"
  fi

  # #393: the estate behold is sized against must not come back as a strip.
  # 301 choudoufu cards, no edges between them, and dagre's answer to that is
  # one rank — a 144010 x 316 SVG where "fit" is a one-pixel line. The wrap
  # (src/edgeless.ts) is what keeps it a picture, and this is the assertion
  # that says so out loud, on the real estate rather than a fixture. Measured
  # after the wrap: 8186 x 3436, 2.4:1.
  if [ "$name" = "terralith-4" ]; then
    G2="$(api "$port" "/api/graph?detail=2")"
    ratio="$(printf '%s' "$G2" | jq -r '.svg | capture("viewBox=\"0 0 (?<w>[0-9.]+) (?<h>[0-9.]+)\"") | (.w|tonumber) / (.h|tonumber)')"
    jq_assert "$G2" "(.svg | capture(\"viewBox=\\\"0 0 (?<w>[0-9.]+) (?<h>[0-9.]+)\\\"\") | (.w|tonumber) / (.h|tonumber)) < 4" \
      "$(printf 'the graph is %.2f:1 at detail 2 — not a strip' "$ratio")"
  fi

  # #391: the adopt entry, twice — unowned before the by-hand import, bound
  # after it. The line run below is the one the up script printed into the
  # log; behold never runs it, and neither does the entry's setup.
  if [ "$name" = "terralith-4-adopt" ]; then
    # UNOWNED is the word for "live, and this estate does not own it" — what a
    # stock apply leaves behind, since nothing wears the marker tag. (The cards
    # that do read bound before the import are bound by DERIVED identity, off
    # the configuration alone; ownership is the thing the import changes.)
    [ "$unowned" -gt 0 ] || { echo "FAIL: $name: nothing reads UNOWNED before the import — the estate was supposed to arrive unowned" >&2; exit 1; }
    echo "  ✓ before the import: $unowned cards UNOWNED"
    endpoint="$(grep -o 'AWS_ENDPOINT_URL=http://127\.0\.0\.1:[0-9]*' "$log" | tail -1)"
    line="$(grep -o '[^ ]* live-import -state=[^ ]* -estate=[^ ]* -approve' "$log" | tail -1)"
    [ -n "$line" ] && [ -n "$endpoint" ] || { echo "FAIL: $name: the up script printed no live-import line to run" >&2; tail -30 "$log" >&2; exit 1; }
    echo "  → by hand, in the target: $line"
    ( cd "$TARGET" && env "$endpoint" AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 sh -c "$line" >"$log.import" 2>&1 ) ||
      { echo "FAIL: $name: live-import failed" >&2; tail -20 "$log.import" >&2; exit 1; }
    O2="$(api "$port" "/api/overlay?env=$env")"
    IFS=$'\t' read -r bound2 unowned2 neutral2 <<<"$(counts "$O2")"
    echo "  ✓ after the import: bound $bound2, unowned $unowned2, neutral $neutral2"
    [ "$bound2" -gt "$bound" ] || { echo "FAIL: $name: the import bound nothing" >&2; exit 1; }
    [ "$unowned2" -eq 0 ] || { echo "FAIL: $name: $unowned2 cards still read UNOWNED after the import" >&2; exit 1; }
    jq_assert "$O2" '([.ir.nodes[]|select(.attrs._status=="good")]|length) == (.ir.nodes|length)' "every card is bound after the import — the whole estate, adopted"
  fi

  # #384/#390: an in-place entry is served where it sits — a Terraform estate's
  # scratch project lives outside the estate, and no in-place entry is ever npm
  # installed into somebody's checkout. So the checkout reads the same after.
  if [ "$inplace" = "1" ] && git -C "$local" rev-parse --git-dir >/dev/null 2>&1; then
    after="$(git -C "$local" status --porcelain)"
    if [ "$after" != "$before" ]; then
      echo "FAIL: $name: $local changed under the serve — behold wrote into a checkout" >&2
      diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | sed 's/^/    /' >&2 || true
      exit 1
    fi
    echo "  ✓ $local is untouched (git status --porcelain unchanged)"
  fi

  teardown
  echo "  $name: $((SECONDS - t0))s"
  RAN=$((RAN + 1))
done 3<<<"$CATALOG"

ENTRY=""
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  LEFT="$(docker ps -a --format '{{.Names}}' | grep '^behold-wb-' || true)"
  [ -z "$LEFT" ] || { echo "FAIL: workbench containers left behind: $LEFT" >&2; exit 1; }
  echo
  echo "✓ no behold-wb-* container left"
fi
echo "workbench e2e: $RAN entries green, $SKIPPED skipped, $((SECONDS - RUN_T0))s"
