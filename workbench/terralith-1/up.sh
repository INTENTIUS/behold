#!/usr/bin/env bash
# behold workbench entry `terralith-1` (#389): choudoufu's tools/terralith-gen
# at scale 1 — 79 resources across network, IAM, ECS, DNS and a module tier —
# rendered into the demo target, given the `estate.chdf.hcl` sidecar the
# generator deliberately omits, then `choudoufu init` + `apply` against a
# scratch floci and served with --env live. The greenfield stage: choudoufu owns
# it from the first apply, so every card paints bound. workbench/lib/terralith.sh
# is the body. Runs with cwd = the demo target.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"
# shellcheck source=../lib/common.sh
. "$LIB/common.sh"
# shellcheck source=../lib/terralith.sh
. "$LIB/terralith.sh"

wb_terralith_greenfield 1 4655
