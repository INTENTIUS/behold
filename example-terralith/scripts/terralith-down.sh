#!/usr/bin/env bash
# Remove the terralith demo's scratch floci, by its name and no other. The
# copy and its snapshots stay; they are yours to read, and the next
# terralith-up.sh in a fresh copy starts over.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
echo "terralith demo: ${CONTAINER} removed."
