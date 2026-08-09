#!/usr/bin/env bash
# Tear the flux-estate demo down: delete the uniquely-named cluster and
# restore whatever kubectl context was current before estate-up.sh switched it.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=behold-flux-demo
STATE="scripts/.prev-context"

k3d cluster delete "$CLUSTER" 2>/dev/null || echo "flux-estate demo: no ${CLUSTER} cluster to remove."
if [ -f "$STATE" ]; then
  prev="$(cat "$STATE")"
  if [ -n "$prev" ] && kubectl config get-contexts -o name 2>/dev/null | grep -qx "$prev"; then
    kubectl config use-context "$prev" >/dev/null
    echo "flux-estate demo: restored kubectl context \"$prev\"."
  fi
  rm -f "$STATE"
fi
echo "flux-estate demo: cluster removed."
