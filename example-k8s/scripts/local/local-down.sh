#!/usr/bin/env bash
# Tear down behold's k3d turnkey demo cluster (#88) and restore whatever
# kubectl context was current before local-up.sh ran. Safe to run even if the
# cluster is already gone (k3d's delete is then a no-op).
set -euo pipefail
cd "$(dirname "$0")"

CLUSTER=behold-k3d-demo
STATE=".prev-context"

if command -v k3d >/dev/null 2>&1; then
  k3d cluster delete "$CLUSTER" >/dev/null 2>&1 || true
fi

if [ -f "$STATE" ]; then
  prev="$(cat "$STATE")"
  rm -f "$STATE"
  if [ -n "$prev" ] && kubectl config get-contexts "$prev" >/dev/null 2>&1; then
    kubectl config use-context "$prev" >/dev/null 2>&1 || true
    echo "behold k3d demo: restored kubectl context \"$prev\"."
  fi
fi
echo "behold k3d demo: cluster \"$CLUSTER\" removed."
