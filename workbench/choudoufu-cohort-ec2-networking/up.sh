#!/usr/bin/env bash
# behold workbench entry `choudoufu-cohort-ec2-networking` (#389): choudoufu's
# `ec2-networking` cohort — 49 resources, the widest of the three cohorts here —
# rendered by tools/estate-gen into the demo target, `choudoufu init` + `apply`
# against a scratch floci, served with --env live. floci does not implement this
# cohort (live/cohort-acceptance.json records it failing at apply), so the apply
# is best effort and the estate serves declared: the roster, the sidecar and the
# rungs are the point, not a green overlay. workbench/lib/cohort.sh is the body;
# this file names the cohort and the port. Runs with cwd = the demo target.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"
# shellcheck source=../lib/common.sh
. "$LIB/common.sh"
# shellcheck source=../lib/cohort.sh
. "$LIB/cohort.sh"

wb_cohort_up ec2-networking 4654
