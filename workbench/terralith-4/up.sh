#!/usr/bin/env bash
# behold workbench entry `terralith-4` (#389): the same terralith as
# `terralith-1` at scale 4 — about 205 resources, the same proportions — applied
# by choudoufu against a scratch floci and served with --env live. This is the
# entry #386's definition of done names: 205 resources on screen, green.
# workbench/lib/terralith.sh is the body. Runs with cwd = the demo target.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"
# shellcheck source=../lib/common.sh
. "$LIB/common.sh"
# shellcheck source=../lib/terralith.sh
. "$LIB/terralith.sh"

wb_terralith_greenfield 4 4656
