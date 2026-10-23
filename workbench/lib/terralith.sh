#!/usr/bin/env bash
# The body of the terralith entries (#389). Sourced by workbench/terralith-*/up.sh.
#
#   wb_terralith_render <scale> <estate-name>   — the generated estate + its sidecar
#   wb_terralith_greenfield <scale> <port>      — choudoufu from nothing (terralith-1, terralith-4)
#   wb_terralith_adopt <scale> <port>           — stock terraform first, then choudoufu (terralith-4-adopt)
#   wb_terralith_stock <scale> <port>           — stock terraform and nothing after it (terralith-4-stock, #912)
#
# tools/terralith-gen renders one estate whose composition is a function of
# -scale: 79 resources at 1, 205 at 4, the same proportions at both. Its
# versions.tf deliberately carries NO live block — it is a stock Terraform root
# module, which is what makes the adopt entry's stock `terraform apply` the
# honest starting point it is. The `estate.chdf.hcl` sidecar is what these
# scripts add, and it is the only file they write into the estate.
#
# The route53 assertion. Under choudoufu's built-in identity table
# `aws_route53_record` has no computable identity, so `live-check` refuses every
# one of the terralith's ten record sites. After `init` the provider's own
# schemas are in hand and it must not refuse them any more — that is the whole
# reason `choudoufu init` runs here rather than being left to the person, and it
# is asserted below so a regression in the rung fails the demo instead of
# quietly serving ten grey cards.

# Render the estate, once. A target that already carries main.tf is reused: a
# second `behold demo <entry>` restarts the serve, it does not re-render over
# live state.
wb_terralith_generate() { # <scale> [extra terralith-gen flags...]
  local scale="$1"
  shift
  wb_require_bin go
  if [ -f main.tf ]; then
    wb_say "reusing the terralith already rendered here (scale ${scale}) — nothing re-rendered over live state"
  else
    wb_say "rendering the terralith at scale ${scale} with choudoufu's tools/terralith-gen${*:+ ($*)}"
    env -u PWD go -C "$(wb_choudoufu_checkout)" run ./tools/terralith-gen -scale "$scale" "$@" -out "$PWD" ||
      wb_die "terralith-gen -scale ${scale} $* failed"
  fi
}

wb_terralith_render() {
  local scale="$1" estate="$2"
  wb_terralith_generate "$scale"
  if [ -f estate.chdf.hcl ]; then
    wb_say "estate.chdf.hcl is already here — left as it is"
  else
    wb_say "writing estate.chdf.hcl: estate = ${estate} (the generator writes no live block; the sidecar is the leading form)"
    printf 'estate = "%s"\n\nrecord_store "local" {\n  path = ".tofu-records"\n}\n' "$estate" >estate.chdf.hcl
  fi
}

# After init the provider's schemas are in hand, so the type choudoufu's
# built-in table cannot identify must no longer be refused.
wb_terralith_assert_rung() {
  local refused
  refused="$(wb_refused_types)"
  if echo "$refused" | grep -q 'aws_route53_record'; then
    echo "$refused" | sed 's/^/     /' >&2
    wb_die "live-check still refuses aws_route53_record after \`choudoufu init\` — the rung should come from the provider's schema, not the built-in table."
  fi
  wb_say "live-check refuses no aws_route53_record after init (the rung is the provider's, not the built-in table's)"
  if [ -n "$refused" ]; then
    wb_say "still refused, by type (count, type):"
    echo "$refused" | sed 's/^/     /'
  fi
}

# The greenfield stage: choudoufu owns the estate from the first apply, so every
# resource is marked and every card paints bound.
wb_terralith_greenfield() {
  local scale="$1" port="$2" container
  container="$(wb_container)"
  wb_require_choudoufu
  wb_terralith_render "$scale" "behold-terralith-${scale}"
  wb_floci_up "$container" "$port"
  wb_write_down "$container"
  wb_export_aws "$port"

  wb_say "choudoufu init (provider schemas — what makes the rungs real)"
  "$(wb_choudoufu)" init -input=false -no-color >/dev/null || wb_die "choudoufu init failed in $PWD"
  wb_terralith_assert_rung

  wb_say "choudoufu apply -auto-approve (the terralith at scale ${scale}, into the scratch floci)"
  "$(wb_choudoufu)" apply -auto-approve -input=false -no-color | tail -3 ||
    wb_die "choudoufu apply failed in $PWD — \`docker logs ${container}\` and \`bash scripts/down.sh\`."

  wb_say "$(wb_instance_count) instances in live-check's roster"
  echo "behold workbench ${BEHOLD_DEMO_NAME}: up. behold serves it next with --env live; every card should be bound."
}

# The adopted stage: STOCK terraform applies the estate first — no live block
# anywhere, no marker tags, no record store, which is exactly the estate a team
# has before it adopts choudoufu. The sidecar and `choudoufu init` come after,
# and the state file stays. Served, every card reads unowned until the person
# runs the one `live-import` line below, by hand, in the target. behold never
# runs the write: that is the bundled choudoufu demo's pattern (#372).
wb_terralith_adopt() {
  local scale="$1" port="$2" container
  container="$(wb_container)"
  wb_require_bin terraform
  wb_require_choudoufu
  wb_terralith_render "$scale" "behold-terralith-${scale}-adopt"
  wb_floci_up "$container" "$port"
  wb_write_down "$container"
  wb_export_aws "$port"

  if [ -f terraform.tfstate ]; then
    wb_say "terraform.tfstate is already here — the stock apply already ran, nothing re-applied"
  else
    wb_say "STOCK terraform init (no live block in versions.tf — that is the point of this entry)"
    terraform init -input=false -no-color >/dev/null || wb_die "terraform init failed in $PWD"
    wb_say "STOCK terraform apply -auto-approve (the terralith at scale ${scale}, unmarked, into the scratch floci)"
    terraform apply -auto-approve -input=false -no-color | tail -3 ||
      wb_die "terraform apply failed in $PWD — \`docker logs ${container}\` and \`bash scripts/down.sh\`."
    [ -f terraform.tfstate ] || wb_die "terraform wrote no terraform.tfstate — live-import has nothing to read."
  fi

  wb_say "choudoufu init over the stock state (the sidecar names the estate; the state file stays where it is)"
  "$(wb_choudoufu)" init -input=false -no-color >/dev/null || wb_die "choudoufu init failed in $PWD"
  wb_terralith_assert_rung
  wb_say "$(wb_instance_count) instances in live-check's roster, none of them owned yet"

  cat <<EOF

behold workbench ${BEHOLD_DEMO_NAME}: up, and deliberately unowned. Nothing here
carries a marker tag: stock terraform applied the estate and choudoufu has only
just been pointed at it, so every card serves unowned.

One command binds them, and it is yours to run — behold never runs the write:

  cd $PWD
  export AWS_ENDPOINT_URL=http://127.0.0.1:${port} AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
  ${CHOUDOUFU_BIN:-choudoufu} live-import -state=terraform.tfstate -estate=behold-terralith-${scale}-adopt -approve

live-import takes -estate even though estate.chdf.hcl names it: its identities
come from the state file alone, so there is no configuration for it to derive
the estate from (choudoufu's own \`live-import -help\` says so). Reload behold
afterwards and the same cards are bound.

EOF
}

# The stock stage (#912): the terralith with terralith-gen's -findings layer
# (INTENTIUS/choudoufu#2199: an SSH-exposed bastion behind an internet gateway,
# an unencrypted postgres instance, a role whose policy reaches a DynamoDB
# table), applied by STOCK terraform and left there. No sidecar, no live block,
# no choudoufu step: plain .tf files and a terraform.tfstate, the estate a
# person has before any of our tools touch it. behold serves it as a bare
# Terraform directory, through chant's terraform lexicon.
#
# The demo's planned change (aws_db_instance.orders storage_encrypted false ->
# true, which forces replacement) is copied in beside the estate as
# replace-db.patch, with the expected answers, and never applied here.
wb_terralith_stock() {
  local scale="$1" port="$2" container here
  here="$(wb_root)/workbench/${BEHOLD_DEMO_NAME:-terralith-4-stock}"
  container="$(wb_container)"
  wb_require_bin terraform
  # The help text is captured before it is searched: `grep -q` closing the
  # pipe early would fail the pipeline under pipefail even on a match.
  local help=""
  [ -f main.tf ] || help="$(env -u PWD go -C "$(wb_choudoufu_checkout)" run ./tools/terralith-gen -help 2>&1 || true)"
  if [ ! -f main.tf ] && [[ "$help" != *"-findings"* ]]; then
    wb_die "$(wb_choudoufu_checkout)'s tools/terralith-gen has no -findings flag (INTENTIUS/choudoufu#2199). Update that checkout, or set BEHOLD_CHOUDOUFU_DIR to one that has it, and re-run."
  fi
  wb_terralith_generate "$scale" -findings
  [ ! -f estate.chdf.hcl ] || wb_die "estate.chdf.hcl is here: this entry is stock terraform only, render it into a fresh target."
  wb_floci_up "$container" "$port"
  wb_write_down "$container"
  wb_export_aws "$port"

  if [ -f terraform.tfstate ]; then
    wb_say "terraform.tfstate is already here — the stock apply already ran, nothing re-applied"
  else
    wb_say "STOCK terraform init"
    terraform init -input=false -no-color >/dev/null || wb_die "terraform init failed in $PWD"
    wb_say "STOCK terraform apply -auto-approve (the terralith at scale ${scale} with -findings, into the scratch floci)"
    terraform apply -auto-approve -input=false -no-color | tail -3 ||
      wb_die "terraform apply failed in $PWD — \`docker logs ${container}\` and \`bash scripts/down.sh\`."
    [ -f terraform.tfstate ] || wb_die "terraform wrote no terraform.tfstate."
  fi

  cp "$here/replace-db.patch" replace-db.patch
  cp "$here/expected-answers.md" expected-answers.md
  wb_say "$(terraform state list 2>/dev/null | wc -l | tr -d ' ') resource instances in terraform.tfstate"

  cat <<EOF

behold workbench ${BEHOLD_DEMO_NAME}: up. Stock terraform applied the estate and
nothing else ran: no sidecar, no live block, no choudoufu. behold serves it as a
bare Terraform directory.

The demo's planned change sits beside the estate, unapplied:

  cd $PWD
  export AWS_ENDPOINT_URL=http://127.0.0.1:${port} AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
  patch -p1 < replace-db.patch     # storage_encrypted = false -> true
  terraform plan                   # aws_db_instance.orders must be replaced

expected-answers.md holds the answers to demo steps 2 to 6.

EOF
}
