#!/usr/bin/env bash
# behold workbench entry `terralith-4-adopt` (#389): the terralith at scale 4
# again, but applied by STOCK terraform first — terralith-gen's versions.tf
# carries no live block, which is the point — so nothing in the estate wears a
# marker tag and there is no record store. The sidecar and `choudoufu init` come
# after, over the state terraform wrote. Served with --env live, every card is
# unowned; one `choudoufu live-import` line, run by hand in the target, binds
# them, and behold never runs the write (#372's pattern).
# workbench/lib/terralith.sh is the body. Runs with cwd = the demo target.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"
# shellcheck source=../lib/common.sh
. "$LIB/common.sh"
# shellcheck source=../lib/terralith.sh
. "$LIB/terralith.sh"

wb_terralith_adopt 4 4657
