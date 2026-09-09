#!/usr/bin/env bash
# behold workbench entry `choudoufu-cohort-s3` (#389): choudoufu's `s3` cohort,
# rendered by tools/estate-gen into the demo target, `choudoufu init` + `apply`
# against a scratch floci, served with --env live. The estate is declared in
# `estate.chdf.hcl`, choudoufu's leading form and the reason #387 taught
# behold's probe to read it. workbench/lib/cohort.sh is the body; this file
# names the cohort and the port. Runs with cwd = the demo target.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"
# shellcheck source=../lib/common.sh
. "$LIB/common.sh"
# shellcheck source=../lib/cohort.sh
. "$LIB/cohort.sh"

wb_cohort_up s3 4652
