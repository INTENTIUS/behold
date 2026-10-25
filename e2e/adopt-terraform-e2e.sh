#!/usr/bin/env bash
# behold#999: "adopt this root", end to end over a real chant and a real
# behold serve, with choudoufu replaced by e2e/fixtures/adopt/choudoufu (no
# cloud, no provider; it prints the recorded report as choudoufu's text and
# logs every call).
#
#   1. the offer   GET /api/adopt: the terraform-estate's prod root is offered
#                  adoption into choudoufu, with its state file present.
#   2. the report  GET /api/adopt/report?member=prod: every resource in
#                  recorded/adoption/prod.json comes back with its fate
#                  (claimed or left out, and why), through chant workspace
#                  promote --dry-run --json.
#   3. the start   POST /api/adopt/start {member: prod}: chant's gate holds it.
#                  NO WRITE BEFORE APPROVAL: the outcome is gated (exit 3), the
#                  stand-in was never asked for -approve, the declaration still
#                  says terraform, and the tree has no change.
#   4. approval    a person's act, done here by the script as that person:
#                  chant approve workspace-promote prod --plan <digest>.
#   5. the start   again: now chant applies the patch and asks for -approve.
#
# Needs a chant at or above ADOPTION_REPORT_CHANT_FLOOR (src/chant-floors.ts):
# behold's own, or BEHOLD_E2E_CHANT_PKG=<an installed @intentius/chant
# directory>. The maintainer runs this by hand; CI does not.
set -euo pipefail
cd "$(dirname "$0")/.."
HERE="$(pwd)"
PORT="${BEHOLD_E2E_PORT:-4698}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/behold-adopt-e2e.XXXXXX")"
EST="$WORK/estate"
LOG="$WORK/choudoufu.log"
CHANT_PKG="${BEHOLD_E2E_CHANT_PKG:-$HERE/node_modules/@intentius/chant}"
LEX_PKG="$HERE/node_modules/@intentius/chant-lexicon-terraform"
fail() { echo "✗ $*"; [ -f "$WORK/serve.log" ] && sed -n '1,40p' "$WORK/serve.log"; exit 1; }

FLOOR="$(sed -n 's/^export const ADOPTION_REPORT_CHANT_FLOOR = "\(.*\)";/\1/p' src/chant-floors.ts)"
CHANT_VERSION="$(node -p "require('$CHANT_PKG/package.json').version")"
node -e 'const [a,b]=process.argv.slice(1).map(v=>v.split(".").map(Number));for(let i=0;i<3;i++){if(a[i]>b[i])process.exit(0);if(a[i]<b[i])process.exit(1)}' "$CHANT_VERSION" "$FLOOR" \
  || fail "chant $CHANT_VERSION at $CHANT_PKG is older than the adoption report's floor $FLOOR: set BEHOLD_E2E_CHANT_PKG"

echo "→ copy example-terraform-estate to $EST, a git repository of its own"
cp -R example-terraform-estate "$EST"
mkdir -p "$EST/node_modules/@intentius"
ln -s "$CHANT_PKG" "$EST/node_modules/@intentius/chant"
ln -s "$LEX_PKG" "$EST/node_modules/@intentius/chant-lexicon-terraform"
LEX_VERSION="$(node -p "require('$LEX_PKG/package.json').version")"
node -e 'const f=process.argv[1],v=process.argv[2],d=JSON.parse(require("fs").readFileSync(f,"utf8"));for(const p of d.pins||[])if(p.package==="@intentius/chant-lexicon-terraform")p.version=v;require("fs").writeFileSync(f,JSON.stringify(d,null,2)+"\n")' "$EST/chant.workspace.json" "$LEX_VERSION"
printf 'node_modules/\n*.tfstate\n' > "$EST/.gitignore"
# A v4 state for the root; the stand-in never reads it, chant passes its path.
printf '{"version":4,"terraform_version":"1.9.0","serial":1,"lineage":"behold-999","outputs":{},"resources":[]}\n' > "$EST/envs/prod/terraform.tfstate"
git -C "$EST" init -q -b main
git -C "$EST" config user.name "behold e2e"
git -C "$EST" config user.email "e2e@behold.invalid"
git -C "$EST" add -A
git -C "$EST" commit -qm "the estate"

echo "→ build behold"
npm run build --silent

echo "→ serve it on :$PORT with the choudoufu stand-in first on PATH"
PATH="$HERE/e2e/fixtures/adopt:$PATH" ADOPT_STUB_LOG="$LOG" ADOPT_STUB_REPORT="$HERE/example-terraform-estate/recorded/adoption/prod.json" \
  node ./bin/behold.js serve "$EST" --port "$PORT" >"$WORK/serve.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT
ready=""
for _ in $(seq 1 45); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[ -n "$ready" ] || fail "behold did not come up"
api() { curl -s "http://localhost:$PORT$1" "${@:2}"; }

echo "→ 1. GET /api/adopt"
api /api/adopt | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const j=JSON.parse(s);
    if (j.refusal) { console.error("✗ refused:", j.refusal.error); process.exit(1); }
    const o=(j.offers||[]).find(x=>x.member==="prod");
    if (!o || !o.offered || o.engine!=="choudoufu") { console.error("✗ prod is not offered adoption into choudoufu:", s); process.exit(1); }
    if (!o.state.present || !o.start.offered) { console.error("✗ prod has no state or no start:", JSON.stringify(o)); process.exit(1); }
    console.log("  offered:", o.command);
  });' || fail "the offer"

echo "→ 2. GET /api/adopt/report?member=prod"
api "/api/adopt/report?member=prod" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const j=JSON.parse(s);
    if (j.error) { console.error("✗", j.error, j.remedy||""); process.exit(1); }
    if (j.outcome!=="dry-run") { console.error("✗ outcome", j.outcome, j.words); process.exit(1); }
    const want=require(process.argv[1]).adoption.entries;
    const got=new Map((j.report&&j.report.entries||[]).map(e=>[e.address,e]));
    const missing=want.filter(e=>!got.has(e.address));
    if (missing.length) { console.error("✗ not in the report:", missing.map(e=>e.address).join(", ")); process.exit(1); }
    if (got.size!==want.length) { console.error("✗ the report has", got.size, "entries, the state", want.length); process.exit(1); }
    for (const e of want) {
      const g=got.get(e.address), fate=e.claimed?"claimed":"left-out";
      if (g.status!==e.status || g.fate!==fate || !g.why) { console.error("✗", e.address, "is", g.status, g.fate, "want", e.status, fate); process.exit(1); }
    }
    console.log("  report ok:", j.report.claimed, "of", j.report.total, "claimed; left out", JSON.stringify(j.report.leftOut));
  });' "$HERE/example-terraform-estate/recorded/adoption/prod.json" || fail "the report"
grep -q -- '-approve' "$LOG" && fail "the report asked choudoufu for -approve"
[ -z "$(git -C "$EST" status --porcelain)" ] || fail "the report changed the tree: $(git -C "$EST" status --porcelain)"

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

echo "→ 3. POST /api/adopt/start: gated, and nothing written before approval"
ID="$(api /api/adopt/start -X POST -H 'content-type: application/json' -d '{"member":"prod"}' | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')"
[ -n "$ID" ] && [ "$ID" != "undefined" ] || fail "the start was refused"
RUN="$(wait_run "$ID")" || fail "the start did not finish: $RUN"
DIGEST="$(node -e '
  const r=JSON.parse(process.argv[1]);
  if (r.outcome!=="gated" || r.exitCode!==3) { console.error("✗ outcome", r.outcome, "exit", r.exitCode, r.words); process.exit(1); }
  if (!/^Gated: nothing was written\./.test(r.words)) { console.error("✗ words:", r.words); process.exit(1); }
  process.stdout.write(r.digest);' "$RUN")" || fail "the start was not gated"
grep -q -- '-approve' "$LOG" && fail "choudoufu was asked for -approve before approval"
KIND="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).members.find(m=>m.name==="prod").kind' "$EST/chant.workspace.json")"
[ "$KIND" = "terraform" ] || fail "the declaration says $KIND before approval"
[ -z "$(git -C "$EST" status --porcelain)" ] || fail "the tree changed before approval: $(git -C "$EST" status --porcelain)"
git -C "$EST" show chant/lifecycle:_gates/workspace-promote.jsonl 2>/dev/null | grep -q "$DIGEST" \
  || fail "chant recorded no pending gate for $DIGEST on chant/lifecycle"
echo "  gated at $DIGEST; no -approve asked, declaration unchanged, tree clean"

echo "→ 4. approve, as the person: chant approve workspace-promote prod --plan $DIGEST"
(cd "$EST" && "$CHANT_PKG/$(node -p "const b=require('$CHANT_PKG/package.json').bin;typeof b==='string'?b:b.chant")" approve workspace-promote prod --plan "$DIGEST") \
  || fail "chant approve refused"

echo "→ 5. POST /api/adopt/start again: applied, and only now -approve"
ID="$(api /api/adopt/start -X POST -H 'content-type: application/json' -d '{"member":"prod"}' | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')"
RUN="$(wait_run "$ID")" || fail "the second start did not finish: $RUN"
node -e 'const r=JSON.parse(process.argv[1]); if (r.outcome!=="applied"||r.exitCode!==0){console.error("✗ outcome",r.outcome,"exit",r.exitCode,r.words);process.exit(1)}' "$RUN" || fail "the approved start did not apply"
grep -q -- '-approve' "$LOG" || fail "the approved promote never asked for -approve"
KIND="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).members.find(m=>m.name==="prod").kind' "$EST/chant.workspace.json")"
[ "$KIND" = "choudoufu" ] || fail "the declaration says $KIND after the approved promote"

echo "✓ adopt e2e passed: the report lists every resource with its fate, and nothing was written before approval"
