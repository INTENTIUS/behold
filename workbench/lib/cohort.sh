#!/usr/bin/env bash
# The body of the three estate-gen cohort entries (#389). Sourced by
# workbench/choudoufu-cohort-*/up.sh, which passes the cohort and its port.
#
#   wb_cohort_up <cohort> <port>
#
# What it does, in the demo target (empty on a first run — these entries name
# no `path`, so their setup IS the source, #386's third decision):
#
#   1. renders the cohort with choudoufu's own tools/estate-gen,
#   2. boots the entry's scratch floci,
#   3. `choudoufu init`, so the rungs come from the provider's schemas,
#   4. `choudoufu apply`, best effort — see the note below,
#   5. leaves scripts/down.sh behind.
#
# The cohort arrives carrying `estate.chdf.hcl`, choudoufu's leading estate
# declaration and the form behold's probe learned to read in #387. That sidecar
# is the whole point of these three entries: a cohort has no `live` block in any
# *.tf, so before M1 every one of them fell through as "no chant.config.ts here".
#
# Why estate-gen is asked for `-all`. `-cohort <name>` alone resolves its types
# through live/mapping.json by CFN SERVICE, which answers for "s3" (16 types)
# but not for a registry cohort whose name is not a service — `-cohort iam-ecr`
# fails with "no admitted type maps to a \"iam-ecr\" CFN service". `-all` renders
# every cohort in internal/live/cohorts, which is the registry these entries
# mean, off ONE provider-schema acquisition: measured at 13s for all 31 into
# 1.4MB. We keep the one we came for and drop the rest, rather than pin a copy
# of the registry's type lists here that would drift.
#
# Why apply is best effort. choudoufu measures this itself, in
# live/cohort-acceptance.json: 5 of 31 cohorts apply clean against floci; the
# rest hit an operation the emulator does not implement. A cohort that cannot
# apply still serves — as a choudoufu member with its sidecar read, its roster
# drawn and its cards honestly unbound — so the script prints exactly what
# refused and carries on instead of failing the demo.

wb_cohort_up() {
  local cohort="$1" port="$2"
  local container render
  container="$(wb_container)"

  wb_require_bin go
  wb_require_bin terraform # estate-gen runs `terraform init` for the schemas
  wb_require_choudoufu

  if [ -f versions.tf ]; then
    wb_say "reusing the ${cohort} cohort already rendered here — nothing re-rendered over live state"
  else
    wb_say "rendering the ${cohort} cohort with choudoufu's tools/estate-gen"
    render="$PWD/.behold-cohort-render"
    rm -rf "$render"
    env -u PWD go -C "$(wb_choudoufu_checkout)" run ./tools/estate-gen -all -out "$render" >/dev/null ||
      wb_die "estate-gen -all failed"
    [ -d "$render/$cohort" ] || wb_die "estate-gen rendered no \"$cohort\" cohort — internal/live/cohorts no longer lists that name?"
    cp -R "$render/$cohort/." .
    rm -rf "$render"
    [ -f estate.chdf.hcl ] || wb_die "the ${cohort} cohort has no estate.chdf.hcl — the sidecar is what makes it a choudoufu member"
    wb_say "estate $(sed -n 's/^estate *= *"\(.*\)"/\1/p' estate.chdf.hcl), declared in estate.chdf.hcl (no live block in any *.tf)"
  fi

  wb_floci_up "$container" "$port"
  wb_write_down "$container"
  wb_export_aws "$port"

  wb_say "choudoufu init (provider schemas — what makes the rungs real)"
  "$(wb_choudoufu)" init -input=false -no-color >/dev/null || wb_die "choudoufu init failed in $PWD"

  wb_say "choudoufu apply (best effort — floci implements 5 of 31 cohorts, live/cohort-acceptance.json)"
  if "$(wb_choudoufu)" apply -auto-approve -input=false -no-color 2>&1 | tail -12; then
    :
  fi

  wb_say "$(wb_instance_count) instances in live-check's roster"
  local refused
  refused="$(wb_refused_types)"
  if [ -n "$refused" ]; then
    wb_say "live-check still refuses, by type (count, type):"
    echo "$refused" | sed 's/^/     /'
  fi
  echo "behold workbench ${BEHOLD_DEMO_NAME}: up. behold serves it next with --env live."
}
