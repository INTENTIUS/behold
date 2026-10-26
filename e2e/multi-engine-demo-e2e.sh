#!/usr/bin/env bash
# INTENTIUS/behold#1000 (B7): the multi-engine three-cloud demo. Four members,
# three engines: dns and gcp are chant members, azure a choudoufu estate, aws
# a Pulumi program on plunge. The bundled example is copied out, its
# emulators booted under scratch names, and three things are asserted, each
# from what behold served or front-door wrote, never from an exit code:
#
#   1. One composed graph. `behold serve` on the copy draws cards from every
#      member, none of them an unreadable box: dns/ and gcp/ (chant), azure/
#      (choudoufu, its estate's blocks) and aws/ (pulumi, the resources of
#      aws/stack-export.json, among them the log group).
#   2. An out-of-band edit in each engine changes that card's colour. For each
#      member behold's streamed drift read (POST /api/workspace/drift/stream,
#      frames on /api/events) is run before and after the edit, and the
#      edited card's record frame goes from tone good (in sync) to warn
#      (drifted) while the member's other cards stay good.
#   3. One change set. `front-door.ts plan` composes one document with a part
#      per member: chant for dns and gcp, choudoufu for azure, pulumi for aws,
#      under one digest that verifies; planned twice with nothing changed, the
#      digest is the same. One source change (dns's record name) gives one
#      change set again, four parts under a new digest, only dns's part moved.
#      And `front-door.ts apply --change-set <the first document>` refuses
#      the whole set, nothing applied, when any one part's plan moved: dns's
#      (chant), azure's (choudoufu, a retention change in azure/site.tf) and
#      aws's (pulumi, a preview that updates the log group), each named in
#      .front-door/apply-verdict.json as the one part that moved.
#
# What stands in for what (the maintainer's live run does each for real):
#
# - plunge is e2e/fixtures/multi-engine-demo/bin/plunge, which answers
#   preview, stack output and drift from hand-written fixtures and refuses
#   `up`. A real plunge needs the nodejs language host, pulumi-aws and floci
#   with the program applied. The pulumi part and the aws card's drift still
#   go through chant's own pulumi lexicon (previewPulumiMember, plunge drift
#   through `chant workspace drift`).
# - aws/stack-export.json is e2e/fixtures/multi-engine-demo/aws-stack-export.json,
#   the export `front-door.ts apply-aws` writes after `plunge up` in a live run.
# - The drift reads of dns, gcp and azure are recorded streams
#   (e2e/fixtures/multi-engine-demo/chant, behold's BEHOLD_DRIFT_CHANT), since
#   a live read needs the members applied. The edit is a file the fake reads;
#   live, it is `front-door.ts oob-edit <member>` against the emulators.
#
# Live (the maintainer, by hand, not this script): `npm run front-door` on the
# emulators with a real plunge, `behold serve` the copy, `tsx
# scripts/front-door.ts oob-edit <member>` for each member, and watch each
# edited card change colour on the page.
#
# Needs chant's packages/core, lexicons/terraform and lexicons/pulumi from a
# checkout of chant main, built (`npm run build` in each lexicon), linked into
# the copy: BEHOLD_E2E_CHANT_LINK="/path/to/chant/packages/core
# /path/to/chant/lexicons/terraform /path/to/chant/lexicons/pulumi". No
# release has the pulumi lexicon yet (0.124.34 is the local build's version).
# Without it the script skips, with the reason. Skips too, exit 0, when
# Docker or choudoufu is absent.
#
# Scratch discipline (src/scratch.ts): the containers are
# behold-multi-engine-floci, -floci-az and -floci-gcp on their own ports,
# refused if one already exists, removed on exit by those names and no other.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
PORT="${BEHOLD_E2E_PORT:-4699}"
WORK="${BEHOLD_E2E_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/behold-multi-engine-e2e.XXXXXX")}"
TARGET="$WORK/three-cloud"
# behold#1013: any pulumi or plunge this run starts, through behold or chant,
# uses an empty file backend under $WORK and skips the update check, never the
# machine's login or Pulumi Cloud.
mkdir -p "$WORK/pulumi-backend"
export PULUMI_BACKEND_URL="file://$WORK/pulumi-backend" PULUMI_SKIP_UPDATE_CHECK=true
FIX="$REPO/e2e/fixtures/multi-engine-demo"
LOG="$WORK/behold.log"

CHOUDOUFU="${CHOUDOUFU_BIN:-choudoufu}"
if ! docker info >/dev/null 2>&1; then echo "skip: Docker is not running"; exit 0; fi
if ! command -v "$CHOUDOUFU" >/dev/null 2>&1; then echo "skip: ${CHOUDOUFU} is not on PATH (set CHOUDOUFU_BIN to name a build)"; exit 0; fi
# The azure part is a choudoufu set plan, which needs choudoufu v0.22.0 or
# newer (chant's MIN_CHOUDOUFU_WAVES_VERSION); a dev build names no release
# and is let through, as chant lets it through.
CHOUDOUFU_VERSION=$("$CHOUDOUFU" version 2>/dev/null | sed -n 's/^choudoufu v\([0-9][0-9.]*\).*/\1/p' | head -1)
if [ -n "$CHOUDOUFU_VERSION" ] && [ "$(printf '%s\n0.22.0\n' "$CHOUDOUFU_VERSION" | sort -V | head -1)" != 0.22.0 ]; then
  echo "FAIL: $(command -v "$CHOUDOUFU") is choudoufu v$CHOUDOUFU_VERSION, older than v0.22.0, which the azure part's set plan needs; set CHOUDOUFU_BIN to a build of choudoufu main" >&2
  exit 1
fi

export FLOCI_CONTAINER=behold-multi-engine-floci FLOCI_AZ_CONTAINER=behold-multi-engine-floci-az FLOCI_GCP_CONTAINER=behold-multi-engine-floci-gcp
export FLOCI_PORT=4664 FLOCI_AZ_PORT=4665 FLOCI_GCP_PORT=4666
for c in "$FLOCI_CONTAINER" "$FLOCI_AZ_CONTAINER" "$FLOCI_GCP_CONTAINER"; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$c"; then
    echo "$c already exists: a previous run didn't tear down; \`docker rm -f $c\` and re-run" >&2
    exit 1
  fi
done
PID="" CURL_PID=""
cleanup() {
  [ -n "$CURL_PID" ] && kill "$CURL_PID" 2>/dev/null || true
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  docker rm -f "$FLOCI_CONTAINER" "$FLOCI_AZ_CONTAINER" "$FLOCI_GCP_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

export AWS_ENDPOINT_URL="http://localhost:$FLOCI_PORT" AZURE_ENDPOINT_URL="http://localhost:$FLOCI_AZ_PORT" GCP_ENDPOINT_URL="http://localhost:$FLOCI_GCP_PORT"
fail() { echo "FAIL: $1" >&2; exit 1; }

echo "→ copy example-three-cloud to $TARGET and install it"
mkdir -p "$TARGET"
tar -C example-three-cloud --exclude node_modules --exclude .front-door --exclude export --exclude .terraform --exclude .tofu-records \
  --exclude .plunge --exclude stack-export.json --exclude Pulumi.local.yaml -cf - . | tar -C "$TARGET" -xf -
npm --prefix "$TARGET" install --no-audit --no-fund --silent
for dir in ${BEHOLD_E2E_CHANT_LINK:-}; do
  name=$(node -p "require('$dir/package.json').name")
  rm -rf "$TARGET/node_modules/$name"
  mkdir -p "$(dirname "$TARGET/node_modules/$name")"
  ln -s "$dir" "$TARGET/node_modules/$name"
done
if [ ! -f "$TARGET/node_modules/@intentius/chant/src/components/verbs/member-outputs.ts" ] || [ ! -f "$TARGET/node_modules/@intentius/chant-lexicon-pulumi/workspace-kinds.json" ]; then
  echo "skip: the copy has no chant with member-outputs or no @intentius/chant-lexicon-pulumi; set BEHOLD_E2E_CHANT_LINK to chant main's packages/core, lexicons/terraform and lexicons/pulumi"
  exit 0
fi
# The export a live `front-door.ts apply-aws` writes after `plunge up`.
cp "$FIX/aws-stack-export.json" "$TARGET/aws/stack-export.json"
# The fake plunge for every plunge call: front-door's, and the pulumi lexicon's inside chant.
export PATH="$FIX/bin:$PATH" PLUNGE_BIN="$FIX/bin/plunge" FAKE_PLUNGE_LOG="$WORK/plunge.log"
export FAKE_OOB_DIR="$WORK/oob"
mkdir -p "$FAKE_OOB_DIR"
: >"$FAKE_PLUNGE_LOG"

echo "→ boot the emulators under scratch names, choudoufu init in azure"
bash "$TARGET/scripts/emulators-up.sh"

# ── 1. one composed graph ────────────────────────────────────────────────────
echo "→ build behold and serve the copy on :$PORT"
npm run build --silent
LOG_GROUP="urn:pulumi:local::three-cloud-aws::aws:cloudwatch/logGroup:LogGroup::web-log-group"
export FAKE_PLUNGE_DRIFTED="$LOG_GROUP"
export BEHOLD_DRIFT_CHANT="$FIX/chant" FAKE_REAL_CHANT="$TARGET/node_modules/.bin/chant"
node ./bin/behold.js serve "$TARGET" --port "$PORT" >"$LOG" 2>&1 &
PID=$!
ready=""
for _ in $(seq 1 120); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && { ready=1; break; }
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
[ -n "$ready" ] || { echo "behold never answered on :$PORT" >&2; tail -40 "$LOG" >&2; exit 1; }

echo "→ 1. GET /api/graph: a card from every engine"
curl -sf "http://localhost:$PORT/api/graph" >"$WORK/graph.json"
# Picks, per member, the card the out-of-band edit lands on and the cards its
# stream names, written as shell assignments for step 2.
node -e '
  const fs = require("fs");
  const [file, logGroup] = process.argv.slice(1);
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
  if (j.error) fail("api error: " + j.error);
  const nodes = j.ir?.nodes ?? [];
  const box = nodes.find((n) => n.kind === "UnreadableMember");
  if (box) fail("a member drew as an unreadable box: " + JSON.stringify(box.attrs?._unreadable ?? box.id));
  const of = (m) => nodes.filter((n) => n.id.startsWith(m + "/"));
  const engines = { dns: "chant", gcp: "chant", azure: "choudoufu", aws: "pulumi" };
  for (const [m, engine] of Object.entries(engines)) {
    if (!of(m).length) fail(`no card for ${m} (${engine}); members drawn: ${[...new Set(nodes.map((n) => n.id.split("/")[0]))].join(", ")}`);
    console.error(`  ✓ ${m} (${engine}): ${of(m).length} cards`);
  }
  const aws = of("aws").find((n) => n.id === `aws/aws/${logGroup.split("::").slice(2).join("::")}`);
  if (!aws) fail(`aws has no card for the log group; its cards are ${of("aws").map((n) => n.id).join(", ")}`);
  console.error(`  ✓ aws draws the export: ${aws.id}`);
  if (!/<svg/.test(j.svg || "")) fail("no svg rendered");
  const addr = (n, m) => n.attrs?.address ?? n.id.slice(m.length + 1);
  const pick = (m, want) => { const n = of(m).find((x) => want.test(addr(x, m))) ?? of(m)[0]; return addr(n, m); };
  const out = {
    FAKE_DRIFT_EDITED_DNS: pick("dns", /^zone$/),
    FAKE_DRIFT_ADDRS_DNS: of("dns").map((n) => addr(n, "dns")).join(" "),
    FAKE_DRIFT_EDITED_GCP: pick("gcp", /^webService$/),
    FAKE_DRIFT_ADDRS_GCP: of("gcp").map((n) => addr(n, "gcp")).join(" "),
    FAKE_DRIFT_EDITED_AZURE: pick("azure", /^azurerm_container_app\.web$/),
    AZURE_ADDRS: JSON.stringify(of("azure").map((n) => addr(n, "azure"))),
  };
  fs.writeFileSync(process.argv[3], JSON.stringify(out));
  console.log("  ✓ one composed graph: " + nodes.length + " cards from dns, gcp (chant), azure (choudoufu) and aws (pulumi)");
 ' "$WORK/graph.json" "$LOG_GROUP" "$WORK/picks.json"
pick() { node -p "require('$WORK/picks.json')['$1']"; }
FAKE_DRIFT_EDITED_DNS=$(pick FAKE_DRIFT_EDITED_DNS) FAKE_DRIFT_ADDRS_DNS=$(pick FAKE_DRIFT_ADDRS_DNS)
FAKE_DRIFT_EDITED_GCP=$(pick FAKE_DRIFT_EDITED_GCP) FAKE_DRIFT_ADDRS_GCP=$(pick FAKE_DRIFT_ADDRS_GCP)
FAKE_DRIFT_EDITED_AZURE=$(pick FAKE_DRIFT_EDITED_AZURE) AZURE_ADDRS=$(pick AZURE_ADDRS)
# The server's fake chant reads these; behold was started before they were
# known, so they reach it through a file the fake sources.
printf 'FAKE_DRIFT_EDITED_DNS=%q\nFAKE_DRIFT_ADDRS_DNS=%q\nFAKE_DRIFT_EDITED_GCP=%q\nFAKE_DRIFT_ADDRS_GCP=%q\nFAKE_DRIFT_EDITED_AZURE=%q\n' \
  "$FAKE_DRIFT_EDITED_DNS" "$FAKE_DRIFT_ADDRS_DNS" "$FAKE_DRIFT_EDITED_GCP" "$FAKE_DRIFT_ADDRS_GCP" "$FAKE_DRIFT_EDITED_AZURE" >"$FAKE_OOB_DIR/picks"

# ── 2. an out-of-band edit in each engine changes that card's colour ────────
echo "→ 2. streamed drift per member, before and after an out-of-band edit"
FRAMES="$WORK/drift-frames.txt"
curl -sN "http://localhost:$PORT/api/events" | while IFS= read -r line; do
  case "$line" in data:*) printf '%s\n' "${line#data: }" ;; esac
done >"$FRAMES" &
CURL_PID=$!
sleep 1
post() { curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:$PORT/api/workspace/drift/stream" -H 'content-type: application/json' -d "$1"; }
# One run for one member, to its end frame; prints the run's id.
stream() {
  local member=$1 body
  body=$(node -e 'const [m, a] = process.argv.slice(1); process.stdout.write(JSON.stringify(m === "azure" ? { member: m, addresses: JSON.parse(a) } : { member: m }))' "$member" "$AZURE_ADDRS")
  local before; before=$(grep -c '"kind":"end"' "$FRAMES" 2>/dev/null || true)
  local code; code=$(post "$body")
  [ "$code" = 202 ] || fail "the drift stream for $member answered $code"
  for _ in $(seq 1 180); do
    [ "$(grep -c '"kind":"end"' "$FRAMES" 2>/dev/null || true)" -gt "${before:-0}" ] && return 0
    sleep 1
  done
  fail "the drift stream for $member never ended; frames: $(tail -c 1500 "$FRAMES")"
}
# The tone the last run for <member> gave <address>, from its record frames.
tone() {
  node -e '
    const fs = require("fs");
    const [file, member, address] = process.argv.slice(1);
    const frames = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((f) => f && f.member === member);
    const last = Math.max(...frames.filter((f) => f.kind === "end").map((f) => f.run));
    const run = frames.filter((f) => f.run === last);
    const bad = run.find((f) => f.kind === "failed");
    if (bad) { console.error(`FAIL: ${member}: a read failed: ${bad.error}`); process.exit(1); }
    const r = run.filter((f) => f.kind === "record" && (f.address === address || (f.node ?? "").endsWith(address)));
    if (!r.length) { console.error(`FAIL: ${member}: no record frame for ${address} in run ${last} (${run.filter((f) => f.kind === "record").map((f) => f.address).join(", ")})`); process.exit(1); }
    const others = run.filter((f) => f.kind === "record" && f.address !== address && f.tone !== "good" && f.tone !== "neutral");
    process.stdout.write(`${r[r.length - 1].tone} ${others.length}`);
  ' "$FRAMES" "$1" "$2"
}
for member in dns gcp azure aws; do
  case "$member" in
    dns) card="$FAKE_DRIFT_EDITED_DNS" ;;
    gcp) card="$FAKE_DRIFT_EDITED_GCP" ;;
    azure) card="$FAKE_DRIFT_EDITED_AZURE" ;;
    aws) card="$LOG_GROUP" ;;
  esac
  stream "$member"
  read -r t0 _ <<<"$(tone "$member" "$card")"
  [ "$t0" = good ] || fail "$member: $card reads $t0 before any edit, not good (in sync)"
  touch "$FAKE_OOB_DIR/$member"
  stream "$member"
  read -r t1 others <<<"$(tone "$member" "$card")"
  [ "$t1" = warn ] || fail "$member: $card reads $t1 after the out-of-band edit, not warn (drifted)"
  [ "$others" = 0 ] || fail "$member: $others other cards changed colour with it"
  echo "  ✓ $member: $card went from good to warn after the edit, its other cards stayed as they were"
done
kill "$CURL_PID" 2>/dev/null || true; CURL_PID=""
grep -q '^plunge drift --resource' "$FAKE_PLUNGE_LOG" || fail "chant never ran plunge drift for the aws member"
echo "  ✓ aws's drift came through chant's pulumi lexicon, as plunge drift --resource <urn> --stream"

# ── 3. one change set, a part per engine, one digest; a moved part refuses it
echo "→ 3. plan the four members into one change set"
fd() { ( cd "$TARGET" && ./node_modules/.bin/tsx scripts/front-door.ts "$@" ); }
fd plan --out "$WORK/cs-base.json" | tee "$WORK/plan-base.log"
fd plan --out "$WORK/cs-again.json" >"$WORK/plan-again.log"
cat > "$TARGET/check-change-set.mts" <<'TS'
import { readFileSync } from "node:fs";
import { verifyChangeSetDigest } from "@intentius/chant/change-set";

const [mode, file, other] = process.argv.slice(2);
const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const doc = read(file!);
const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  console.error(JSON.stringify(doc.members, null, 2).slice(0, 2500));
  process.exit(1);
};
const ok = (m: string) => console.log(`  ✓ ${m}`);
const by: Record<string, any> = Object.fromEntries(doc.members.map((m: any) => [m.member, m]));
const planners: Record<string, string> = { dns: "chant", gcp: "chant", azure: "choudoufu", aws: "pulumi" };
if (JSON.stringify(Object.keys(by).sort()) !== JSON.stringify(Object.keys(planners).sort())) fail(`members are ${Object.keys(by).join(", ")}, not aws, azure, dns and gcp`);
for (const [m, planner] of Object.entries(planners)) {
  if (by[m].planner !== planner || by[m].status !== "planned" || !by[m].planDigest) fail(`${m} is planner ${by[m].planner}, status ${by[m].status}${by[m].error ? `: ${by[m].error}` : ""}`);
}
ok("four parts, one per member: dns and gcp chant, azure choudoufu, aws pulumi, all planned");
if (!verifyChangeSetDigest(doc)) fail(`the document digest ${doc.digest} does not verify`);
ok(`one digest over all four parts: ${doc.digest}`);
if (mode === "base") {
  const log = doc.entries.find((e: any) => e.member === "aws" && /LogGroup::web-log-group$/.test(e.address));
  if (!log || log.planner !== "pulumi") fail(`aws's part has no entry for the log group (${JSON.stringify(log)})`);
  ok(`aws's part is plunge's preview: ${log.address} is ${log.action}`);
  const again = read(other!);
  if (again.digest !== doc.digest) fail(`planned again with nothing changed, the digest is ${again.digest}, not ${doc.digest}`);
  ok("planned again with nothing changed, the digest is the same");
}
if (mode === "changed") {
  const base = read(other!);
  if (doc.digest === base.digest) fail("the source change left the digest where it was");
  const moved = doc.members.filter((m: any) => m.planDigest !== base.members.find((b: any) => b.member === m.member)?.planDigest).map((m: any) => m.member);
  if (JSON.stringify(moved) !== JSON.stringify(["dns"])) fail(`the parts that moved are ${moved.join(", ") || "none"}, not dns alone`);
  ok(`one source change, one change set: ${doc.digest}, only dns's part moved`);
}
TS
( cd "$TARGET" && ./node_modules/.bin/tsx check-change-set.mts base "$WORK/cs-base.json" "$WORK/cs-again.json" )

echo "→ one source change: dns's record name"
cp "$TARGET/dns/src/route53.ts" "$WORK/route53.ts.orig"
sed -i.bak 's|const NAME = "www.three-cloud.example.";|const NAME = "web.three-cloud.example.";|' "$TARGET/dns/src/route53.ts" && rm -f "$TARGET/dns/src/route53.ts.bak"
grep -q 'const NAME = "web.three-cloud.example.";' "$TARGET/dns/src/route53.ts" || fail "the source change did not land in dns/src/route53.ts"
fd plan --out "$WORK/cs-changed.json" >"$WORK/plan-changed.log"
( cd "$TARGET" && ./node_modules/.bin/tsx check-change-set.mts changed "$WORK/cs-changed.json" "$WORK/cs-base.json" )

# apply --change-set with the first document, after one part moved: refused
# whole, the moved part named, nothing applied.
refused() {
  local want=$1 planner=$2
  rm -f "$TARGET/.front-door/apply-verdict.json"
  : >"$FAKE_PLUNGE_LOG"
  fd apply --change-set "$WORK/cs-base.json" >"$WORK/apply-$want.log" 2>&1 || true
  node -e '
    const fs = require("fs");
    const [file, want, planner, plungeLog] = process.argv.slice(1);
    const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
    if (!fs.existsSync(file)) fail(`apply wrote no verdict for a moved ${want}`);
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    if (v.verdict !== "refused") fail(`the verdict is ${v.verdict}, not refused, with ${want} moved`);
    const moved = (v.moved ?? []).map((m) => `${m.member}:${m.planner}`);
    if (JSON.stringify(moved) !== JSON.stringify([`${want}:${planner}`])) fail(`the moved parts are ${moved.join(", ") || "none"}, not ${want} (${planner}) alone`);
    if (/^plunge up\b/m.test(fs.readFileSync(plungeLog, "utf8"))) fail("plunge up ran after the refusal");
    console.log(`  ✓ ${want} (${planner}) moved: the whole set is refused, nothing applied (${v.moved[0].reason})`);
  ' "$TARGET/.front-door/apply-verdict.json" "$want" "$planner" "$FAKE_PLUNGE_LOG"
}
echo "→ apply the first change set after each engine's part moves"
refused dns chant
cp "$WORK/route53.ts.orig" "$TARGET/dns/src/route53.ts"

cp "$TARGET/azure/site.tf" "$WORK/site.tf.orig"
sed -i.bak 's|retention_in_days   = 30|retention_in_days   = 60|' "$TARGET/azure/site.tf" && rm -f "$TARGET/azure/site.tf.bak"
grep -q 'retention_in_days   = 60' "$TARGET/azure/site.tf" || fail "the azure change did not land in azure/site.tf"
refused azure choudoufu
cp "$WORK/site.tf.orig" "$TARGET/azure/site.tf"

export FAKE_PLUNGE_PREVIEW="$FIX/aws-preview-changed.json"
refused aws pulumi
unset FAKE_PLUNGE_PREVIEW

echo "multi-engine demo e2e: all green"
