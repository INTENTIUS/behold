#!/usr/bin/env bash
# behold workbench entry `choudoufu-workbench` (#389): the live-mv workbench's
# own four estates, copied out of ../choudoufu on every fresh target rather than
# out of behold's `example-choudoufu-estate`, which is a copy that drifts.
#
# Same shape as the bundled demo's scripts/choudoufu-up.sh: a scratch floci,
# `choudoufu init` in each of the four copies (behold's own target, never a
# served checkout — #366's rule), and `apply` in the monolith, whose 21
# resources the three team estates re-declare. The teams stay unapplied on
# purpose: their resources are the monolith's, so every team card serves
# `owned by tlmig-sample-monolith`.
#
# Two things the bundled demo has that the fixture does not, and this script
# does not invent: a `carve.json` move plan, and team-a's extra VPC with the
# cross-estate data source that reads it. The fixture is four `main.tf` files
# and nothing else; `behold demo choudoufu-estate` is where those two live.
#
# These estates declare their estate the OTHER way — a `live { estate = "…" }`
# block inside terraform{}, not the `estate.chdf.hcl` sidecar the cohorts carry.
# Both forms serve, which is the shape of #387's probe.
#
# Runs with cwd = the demo target (the copied estates).
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"
# shellcheck source=../lib/common.sh
. "$LIB/common.sh"

PORT=4651
ESTATES="tlmig-sample-monolith tlmig-sample-team-a tlmig-sample-team-b tlmig-sample-team-c"
CONTAINER="$(wb_container)"

wb_require_choudoufu
for e in $ESTATES; do
  [ -f "$e/main.tf" ] || wb_die "$PWD/$e/main.tf is missing — the copy of ../choudoufu's live-mv fixture is incomplete."
done

wb_floci_up "$CONTAINER" "$PORT"
wb_write_down "$CONTAINER"
wb_export_aws "$PORT"

for e in $ESTATES; do
  wb_say "choudoufu init in ${e} (provider schemas — what makes the rungs real)"
  (cd "$e" && "$(wb_choudoufu)" init -input=false -no-color >/dev/null) || wb_die "choudoufu init failed in $PWD/$e"
done

wb_say "choudoufu apply in tlmig-sample-monolith (the terralith: three teams' IAM and log groups in one estate)"
(cd tlmig-sample-monolith && "$(wb_choudoufu)" apply -auto-approve -input=false -no-color | tail -3) ||
  wb_die "choudoufu apply failed in $PWD/tlmig-sample-monolith — \`docker logs ${CONTAINER}\` and \`bash scripts/down.sh\`."

for e in $ESTATES; do
  wb_say "${e}: $( (cd "$e" && wb_instance_count) ) instances in live-check's roster"
done

cat <<EOF
behold workbench ${BEHOLD_DEMO_NAME}: up. behold serves the four estates composed,
with --env live. The monolith is green; each team's cards read
\`owned by tlmig-sample-monolith\`, dashed to the monolith's card of the same
address. To move one across, by hand, in $PWD/tlmig-sample-team-a:

  export AWS_ENDPOINT_URL=http://127.0.0.1:${PORT} AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
  ${CHOUDOUFU_BIN:-choudoufu} live-mv -from-estate=tlmig-sample-monolith aws_iam_role.team_a aws_iam_role.team_a

EOF
