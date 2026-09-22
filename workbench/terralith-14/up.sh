#!/usr/bin/env bash
# behold workbench entry `terralith-14` (#457): the terralith at scale 14 — 1041
# resources at this generator, the smallest scale at or above the ~1k a dot view
# of a carve is sized against — applied by choudoufu against a scratch floci and
# served with --env live. It is also the estate `scripts/dot-bench/record-carve.sh`
# records a carve on. workbench/lib/terralith.sh is the body. Runs with cwd = the
# demo target.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"
# shellcheck source=../lib/common.sh
. "$LIB/common.sh"
# shellcheck source=../lib/terralith.sh
. "$LIB/terralith.sh"

wb_terralith_greenfield 14 4658
