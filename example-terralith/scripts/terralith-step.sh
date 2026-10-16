#!/usr/bin/env bash
# The writes of `behold demo terralith`, one phase at a time, run by you.
# behold shows these lines and reads what they leave; it never runs them.
#
#   adopt   the terragucci `backends:` migration: the root's backend block
#           becomes a live block, and choudoufu live-import reads the old
#           state once and stamps tofu-estate and tofu-address on every
#           resource it verifies. The old state stays in the bucket.
#   split   the terragucci `moves:` migration: three team roots appear, and
#           choudoufu live-mv -from-estate rewrites each team resource's
#           markers, run in the root it moves to. One tag write per resource.
#           The record is split.json.
#   plan    a change across the new estates, planned the way terragucci
#           plans a pull request: the terralith publishes a shared setting as
#           an output, and each team's first log group reads it. The
#           terralith plans first; each team root plans its cone with
#           -estate-outputs-from, so it reads the terralith's PLANNED output
#           (choudoufu falls back to a full plan there, and says why); the
#           three team plans run as one live-plan-set, and live-summary folds
#           the identical changes into one group. Nothing is applied.
#
# Each phase ends in a snapshot under snapshots/<n>-<phase>/.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh
need_choudoufu

phase="${1:-}"
WORK=.terralith
mkdir -p "$WORK"

case "$phase" in
  adopt)
    [ -f snapshots/1-stock/phase.json ] || die "phase 1 is not up yet. Run scripts/terralith-up.sh first."
    [ -f snapshots/2-adopt/phase.json ] && { say "adopt already ran (snapshots/2-adopt)."; exit 0; }
    say "the old state, read once from s3://${BUCKET}"
    [ -s "$WORK/terralith.tfstate" ] || (cd terralith && "$CHOUDOUFU" state pull >"../$WORK/terralith.tfstate")
    say "the code change: terralith's backend block becomes a live block, plus migrations/adopt.yml"
    # The s3 backend's settings stay beside .terraform as a record; init under a
    # live block configures no backend.
    [ -f terralith/.terraform/terraform.tfstate ] && mv terralith/.terraform/terraform.tfstate "$WORK/terralith.backend.json"
    mkdir -p migrations
    cp phases/adopt/terralith/main.tf terralith/main.tf
    cp phases/adopt/migrations/adopt.yml migrations/adopt.yml
    init_root terralith
    mkdir -p snapshots/2-adopt/terralith
    say "live-import, read-only: what verifies against the live system"
    (cd terralith && "$CHOUDOUFU" live-import -no-color "-state=$PWD/../$WORK/terralith.tfstate" -estate=terralith \
      >../snapshots/2-adopt/terralith/live-import.txt 2>&1) || die "live-import could not verify the state (snapshots/2-adopt/terralith/live-import.txt)"
    say "live-import -approve: one marker write per verified resource"
    (cd terralith && "$CHOUDOUFU" live-import -no-color "-state=$PWD/../$WORK/terralith.tfstate" -estate=terralith -approve \
      >../snapshots/2-adopt/terralith/live-import-approve.txt 2>&1) || die "live-import could not stamp (snapshots/2-adopt/terralith/live-import-approve.txt)"
    tail -3 snapshots/2-adopt/terralith/live-import-approve.txt | head -1
    say "snapshot: phase 2"
    snap snapshots/2-adopt terralith
    finish snapshots/2-adopt adopt 2 terralith
    say "adopted. Next: bash scripts/terralith-step.sh split"
    ;;
  split)
    [ -f snapshots/2-adopt/phase.json ] || die "adopt has not run yet. Run scripts/terralith-step.sh adopt first."
    [ -f snapshots/3-split/phase.json ] && { say "split already ran (snapshots/3-split)."; exit 0; }
    say "the code change: three team roots, the terralith keeps the network, plus migrations/split.yml"
    for root in terralith team-a team-b team-c; do
      mkdir -p "$root"
      cp "phases/split/$root/main.tf" "$root/main.tf"
    done
    cp phases/split/migrations/split.yml migrations/split.yml
    for root in team-a team-b team-c; do init_root "$root"; done
    mkdir -p snapshots/3-split/live-mv
    moves="" retags=""
    for root in team-a team-b team-c; do
      for address in $(sed -n "/to: ${root}\$/,/^  - /s/^      - //p" migrations/split.yml); do
        doc="snapshots/3-split/live-mv/${root}--${address}.json"
        (cd "$root" && "$CHOUDOUFU" live-mv -json -dry-run -from-estate=terralith "$address" "$address" >"../${doc%.json}.dry-run.json" 2>/dev/null) \
          || die "live-mv -dry-run refused ${address} (${doc%.json}.dry-run.json)"
        (cd "$root" && "$CHOUDOUFU" live-mv -json -from-estate=terralith "$address" "$address" >"../$doc" 2>/dev/null) \
          || die "live-mv refused ${address} (${doc})"
        say "retag ${address}: terralith → ${root}"
        moves="${moves:+$moves,}
    {\"address\": \"${address}\", \"from\": \"terralith\", \"to\": \"${root}\"}"
        retags="${retags:+$retags,}
    {\"address\": \"${address}\", \"from\": \"terralith\", \"to\": \"${root}\", \"from_estate\": \"terralith\", \"to_estate\": \"${root}\", \"document\": \"${doc}\"}"
      done
    done
    # split.json: the plan behold reads (from, estates, moves), and where each
    # retag's own live-mv document is.
    printf '{\n  "from": "terralith",\n  "estates": ["team-a", "team-b", "team-c"],\n  "migration": "migrations/split.yml",\n  "moves": [%s\n  ],\n  "retags": [%s\n  ]\n}\n' "$moves" "$retags" >split.json
    say "snapshot: phase 3"
    for root in terralith team-a team-b team-c; do snap snapshots/3-split "$root"; done
    finish snapshots/3-split split 3 terralith team-a team-b team-c
    say "split. Four estates, one tag write per resource."
    ;;
  plan)
    [ -f snapshots/3-split/phase.json ] || die "split has not run yet. Run scripts/terralith-step.sh split first."
    [ -f snapshots/4-plan/phase.json ] && { say "plan already ran (snapshots/4-plan)."; exit 0; }
    command -v git >/dev/null 2>&1 || die "git is not on PATH; the cone is a diff against each root's last commit."
    out="$PWD/snapshots/4-plan"
    mkdir -p "$out"
    # Each estate root keeps its own history, as a split estate's repository
    # would: the base is the root as the split left it. (A root in a
    # subdirectory of one shared repository gets no cone from choudoufu 0.28.0:
    # live-cone lists the base with `git ls-tree` from inside the root, which
    # git filters to that directory, so the base reads empty.)
    for root in terralith team-a team-b team-c; do
      if [ ! -d "$root/.git" ]; then
        (cd "$root" && git init -q && printf '%s\n' .terraform/ .terraform.lock.hcl .tofu-records/ >.gitignore \
          && git add -A && git -c user.name=terralith-demo -c user.email=terralith-demo@localhost commit -q -m "the root as the split left it")
      fi
    done
    say "the code change: the terralith outputs log_retention_days, and each team's first log group reads it"
    for root in terralith team-a team-b team-c; do cp "phases/plan/$root/main.tf" "$root/main.tf"; done
    say "live-cone: what each change reaches, against the root's last commit"
    for root in terralith team-a team-b team-c; do
      mkdir -p "$out/$root"
      (cd "$root" && "$CHOUDOUFU" live-cone -json HEAD >"$out/$root/cone.json" 2>"$out/$root/cone.err") || true
    done
    say "plan the terralith first: its planned output is what the teams read"
    (cd terralith && "$CHOUDOUFU" plan -input=false -no-color "-out=$PWD/../$WORK/terralith.tfplan" >"$out/terralith/plan.log" 2>&1) \
      || die "the terralith's plan failed (snapshots/4-plan/terralith/plan.log)"
    (cd terralith && "$CHOUDOUFU" show -json "$PWD/../$WORK/terralith.tfplan" >"$out/terralith/plan.json")
    say "live-plan-set: the three team roots, each its cone, reading the terralith's planned output"
    TF_CLI_ARGS_plan="-cone=HEAD -estate-outputs-from=terralith=$out/terralith/plan.json" \
      "$CHOUDOUFU" live-plan-set -json "-out-dir=$WORK/plan-set" team-a team-b team-c >"$out/set.json" 2>"$out/set.err" || true
    for root in team-a team-b team-c; do cp "$WORK/plan-set/$root.log" "$out/$root/plan.log" 2>/dev/null || true; done
    say "live-summary: the identical changes, folded"
    "$CHOUDOUFU" live-summary -json "$out/set.json" >"$out/summary.json"
    "$CHOUDOUFU" live-summary "$out/set.json" | head -8
    say "snapshot: phase 4"
    snap snapshots/4-plan terralith
    for root in team-a team-b team-c; do
      SNAP_PLAN_ARGS="-estate-outputs-from=terralith=$out/terralith/plan.json" snap snapshots/4-plan "$root"
    done
    finish snapshots/4-plan plan 4 terralith team-a team-b team-c
    say "planned. Nothing was applied: the plans are in .terralith/plan-set."
    ;;
  *)
    die "which phase? bash scripts/terralith-step.sh adopt | split | plan"
    ;;
esac
