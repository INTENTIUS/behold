#!/usr/bin/env bash
# behold#999, the Pulumi half: "adopt this stack", end to end over a real
# chant and a real behold serve, with plunge replaced by
# e2e/fixtures/adopt-pulumi/plunge (no cloud, no Pulumi engine; it answers
# plunge stack adopt --json with plunge's v1 document, with plunge's gate, and
# logs every call). behold is started with PULUMI_SKIP_CONFIRMATIONS=true in its
# environment, which would confirm an adoption if it reached plunge.
#
#   1. the offer   GET /api/adopt: the stock stack `app` (Pulumi.yaml names a
#                  file:// backend) is offered adoption into plunge, stack dev
#                  read off its stack-export.json, and the command has no --yes.
#   2. the report  GET /api/adopt/report?member=app: every custom resource of
#                  the export comes back with its fate and why, and the
#                  confirm command.
#   3. the start   POST /api/adopt/start {member: app}: the same
#                  classification, through the runner.
#      NO WRITE BEFORE APPROVAL, after 2 and after 3: no adoption record
#      under the backend's root, the stand-in never saw --yes or -y, and
#      never saw PULUMI_SKIP_CONFIRMATIONS.
#   4. approval    a person's act, done here by the script as that person: the
#                  confirm line the start answered, run as given.
#   5. the report  again: already adopted, nothing to confirm.
#
# Needs the pulumi lexicon (BEHOLD_E2E_PULUMI_LEXICON=<a lexicons/pulumi
# directory>, or @intentius/chant-lexicon-pulumi beside behold); the copy's
# pin is set to whatever version that is. chant is behold's own, or
# BEHOLD_E2E_CHANT_PKG. The maintainer runs this by hand; CI does not.
set -euo pipefail
cd "$(dirname "$0")/.."
HERE="$(pwd)"
PORT="${BEHOLD_E2E_PORT:-4699}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/behold-adopt-pulumi-e2e.XXXXXX")"
WS="$WORK/ws"
STATE="$WORK/state"
LOG="$WORK/plunge.log"
STUBS="$HERE/e2e/fixtures/adopt-pulumi"
CHANT_PKG="${BEHOLD_E2E_CHANT_PKG:-$HERE/node_modules/@intentius/chant}"
LEX_PKG="${BEHOLD_E2E_PULUMI_LEXICON:-$HERE/node_modules/@intentius/chant-lexicon-pulumi}"
RECORD="$STATE/.plunge/stacks/app/dev/adoption"
# behold#1013: any pulumi or plunge this run starts, through behold or chant,
# uses an empty file backend under $WORK and skips the update check, never the
# machine's login or Pulumi Cloud.
mkdir -p "$WORK/pulumi-backend"
export PULUMI_BACKEND_URL="file://$WORK/pulumi-backend" PULUMI_SKIP_UPDATE_CHECK=true
fail() { echo "✗ $*"; [ -f "$WORK/serve.log" ] && sed -n '1,40p' "$WORK/serve.log"; [ -f "$LOG" ] && cat "$LOG"; exit 1; }

[ -f "$LEX_PKG/workspace-kinds.json" ] || fail "no pulumi lexicon at $LEX_PKG: set BEHOLD_E2E_PULUMI_LEXICON to chant's lexicons/pulumi"

echo "→ copy e2e/fixtures/pulumi-workspace to $WS, its stack on a file:// backend at $STATE"
cp -R e2e/fixtures/pulumi-workspace "$WS"
mkdir -p "$STATE" "$WS/node_modules/@intentius"
ln -s "$CHANT_PKG" "$WS/node_modules/@intentius/chant"
ln -s "$LEX_PKG" "$WS/node_modules/@intentius/chant-lexicon-pulumi"
LEX_VERSION="$(node -p "require('$LEX_PKG/package.json').version")"
node -e 'const f=process.argv[1],v=process.argv[2],d=JSON.parse(require("fs").readFileSync(f,"utf8"));for(const p of d.pins||[])if(p.package==="@intentius/chant-lexicon-pulumi")p.version=v;require("fs").writeFileSync(f,JSON.stringify(d,null,2)+"\n")' "$WS/chant.workspace.json" "$LEX_VERSION"
printf 'backend:\n  url: file://%s\n' "$STATE" >> "$WS/app/Pulumi.yaml"
printf 'node_modules/\n' > "$WS/.gitignore"
git -C "$WS" init -q -b main
git -C "$WS" config user.name "behold e2e"
git -C "$WS" config user.email "e2e@behold.invalid"
git -C "$WS" add -A
git -C "$WS" commit -qm "the workspace"

echo "→ build behold"
npm run build --silent

echo "→ serve it on :$PORT with the plunge stand-in first on PATH, and PULUMI_SKIP_CONFIRMATIONS=true"
PATH="$STUBS:$PATH" ADOPT_STUB_LOG="$LOG" PULUMI_SKIP_CONFIRMATIONS=true \
  node ./bin/behold.js serve "$WS" --port "$PORT" >"$WORK/serve.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT
ready=""
for _ in $(seq 1 45); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[ -n "$ready" ] || fail "behold did not come up"
api() { curl -s "http://localhost:$PORT$1" "${@:2}"; }

no_write() {
  [ ! -e "$RECORD" ] || fail "$1: plunge wrote the adoption record before approval"
  [ ! -e "$STATE/.plunge" ] || fail "$1: something was written under the backend's root before approval: $(find "$STATE/.plunge")"
  if [ -f "$LOG" ]; then
    node -e '
      const lines=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      for (const l of lines) {
        if (l.argv.some(a=>a==="-y"||a.startsWith("--yes"))) { console.error("✗ plunge was asked to confirm:", l.argv.join(" ")); process.exit(1); }
        if (l.skip!==null) { console.error("✗ plunge saw PULUMI_SKIP_CONFIRMATIONS=" + l.skip); process.exit(1); }
        if (!l.argv.includes("--non-interactive")) { console.error("✗ plunge was run interactively:", l.argv.join(" ")); process.exit(1); }
        if (!l.argv.includes("--json")) { console.error("✗ plunge was not asked for its JSON view:", l.argv.join(" ")); process.exit(1); }
      }' "$LOG" || fail "$1: the stand-in's log"
  fi
}

echo "→ 1. GET /api/adopt"
api /api/adopt | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const j=JSON.parse(s);
    if (j.refusal) { console.error("✗ refused:", j.refusal.error); process.exit(1); }
    const o=(j.offers||[]).find(x=>x.member==="app");
    if (!o || !o.offered || o.engine!=="plunge") { console.error("✗ app is not offered adoption into plunge:", s); process.exit(1); }
    if (!o.start || !o.start.offered) { console.error("✗ app has no start:", JSON.stringify(o)); process.exit(1); }
    if (!o.stack || o.stack.name!=="dev") { console.error("✗ stack:", JSON.stringify(o.stack)); process.exit(1); }
    if (/--yes/.test(o.command) || !/--yes$/.test(o.confirm)) { console.error("✗ command/confirm:", o.command, "|", o.confirm); process.exit(1); }
    console.log("  offered:", o.command);
  });' || fail "the offer"
no_write "the offer"

echo "→ 2. GET /api/adopt/report?member=app"
api "/api/adopt/report?member=app" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const j=JSON.parse(s);
    if (j.error) { console.error("✗", j.error, j.remedy||""); process.exit(1); }
    if (j.outcome!=="classified") { console.error("✗ outcome", j.outcome, j.words); process.exit(1); }
    const exp=require(process.argv[1]).deployment.resources.filter(r=>r.custom&&!r.type.startsWith("pulumi:providers:")).map(r=>r.urn).sort();
    const got=(j.report&&j.report.entries||[]);
    const urns=got.map(e=>e.urn).sort();
    if (JSON.stringify(urns)!==JSON.stringify(exp)) { console.error("✗ the report lists", JSON.stringify(urns), "and the checkpoint holds", JSON.stringify(exp)); process.exit(1); }
    for (const e of got) if (e.fate!=="claimed" || !e.why || !e.ownership) { console.error("✗", e.urn, "has no fate:", JSON.stringify(e)); process.exit(1); }
    if (!/--yes$/.test(j.confirm||"")) { console.error("✗ no confirm line:", j.confirm); process.exit(1); }
    console.log("  report ok:", j.report.claimed, "of", j.report.total, "claimed;", JSON.stringify(j.report.byOwnership));
  });' "$WS/app/stack-export.json" || fail "the report"
no_write "the report"

wait_run() {
  local id="$1" out=""
  for _ in $(seq 1 120); do
    out="$(api "/api/adopt/runs/$id")"
    node -e 'process.exit(JSON.parse(process.argv[1]).outcome==="running"?1:0)' "$out" && { printf '%s' "$out"; return 0; }
    sleep 1
  done
  printf '%s' "$out"
  return 1
}

echo "→ 3. POST /api/adopt/start: classified, and nothing written before approval"
ID="$(api /api/adopt/start -X POST -H 'content-type: application/json' -d '{"member":"app"}' | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')"
[ -n "$ID" ] && [ "$ID" != "undefined" ] || fail "the start was refused"
RUN="$(wait_run "$ID")" || fail "the start did not finish: $RUN"
CONFIRM="$(node -e '
  const r=JSON.parse(process.argv[1]);
  if (r.outcome!=="classified") { console.error("✗ outcome", r.outcome, r.words); process.exit(1); }
  if (!/nothing was written/.test(r.words)) { console.error("✗ words:", r.words); process.exit(1); }
  if (!/--yes$/.test(r.confirm||"")) { console.error("✗ no confirm line"); process.exit(1); }
  process.stdout.write(r.confirm);' "$RUN")" || fail "the start was not held at the confirm"
no_write "the start"
echo "  held at the confirm; nothing written, plunge never asked to confirm"

echo "→ 4. approve, as the person: $CONFIRM"
(cd "$WS" && PATH="$STUBS:$PATH" ADOPT_STUB_LOG="$WORK/person.log" bash -c "$CONFIRM") || fail "the confirm line failed"
[ -f "$RECORD" ] || fail "the confirm line wrote no adoption record"

echo "→ 5. GET /api/adopt/report?member=app again: already adopted"
api "/api/adopt/report?member=app" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const j=JSON.parse(s);
    if (j.outcome!=="already-adopted" || j.confirm) { console.error("✗ after the confirm:", j.outcome, j.confirm||""); process.exit(1); }
  });' || fail "the report after approval"

echo "✓ adopt pulumi e2e passed: every resource with its fate, and nothing written before a person confirmed"
