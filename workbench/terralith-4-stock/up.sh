#!/usr/bin/env bash
# behold workbench entry `terralith-4-stock` (#912): the terralith at scale 4
# with terralith-gen's -findings layer, applied by STOCK terraform against this
# entry's own scratch floci, and nothing after it. The estate #908's "ask your
# agent" demo runs on. workbench/lib/terralith.sh is the body. Runs with cwd =
# the demo target.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"
# shellcheck source=../lib/common.sh
. "$LIB/common.sh"
# shellcheck source=../lib/terralith.sh
. "$LIB/terralith.sh"

wb_terralith_stock 4 4659
