#!/usr/bin/env bash
# Bring up the local, single-node k3d cluster behold's k3d turnkey demo (#88)
# deploys to. Docker + k3d only — no cloud account, no credentials. Idempotent:
# a cluster of this name already up is left alone.
#
# Safety: never touches any OTHER kubeconfig context. Whatever context is
# current before k3d switches it is saved to .prev-context and restored by
# local-down.sh; the cluster and its context are uniquely named to this demo
# (behold-k3d-demo / k3d-behold-k3d-demo) so nothing pre-existing is renamed,
# reused, or deleted.
set -euo pipefail
cd "$(dirname "$0")"

CLUSTER=behold-k3d-demo
CONTEXT="k3d-${CLUSTER}"
STATE=".prev-context"

if ! docker info >/dev/null 2>&1; then
  echo "behold k3d demo: Docker is not running — start Docker and re-run this script." >&2
  exit 1
fi
if ! command -v k3d >/dev/null 2>&1; then
  echo "behold k3d demo: k3d is not installed — see https://k3d.io/#installation." >&2
  exit 1
fi

if k3d cluster list "$CLUSTER" --no-headers 2>/dev/null | grep -q .; then
  echo "behold k3d demo: cluster \"$CLUSTER\" already up — reusing."
else
  # Save whatever context is current BEFORE k3d switches it, so local-down.sh
  # can restore it. Only written once: a later local-up (already-up cluster,
  # different code path above) must never overwrite an earlier save with our
  # own context.
  if [ ! -f "$STATE" ]; then
    kubectl config current-context > "$STATE" 2>/dev/null || : > "$STATE"
  fi
  echo "behold k3d demo: creating single-node cluster \"$CLUSTER\"…"
  k3d cluster create "$CLUSTER" --servers 1 --agents 0 --wait --timeout 120s
fi

current="$(kubectl config current-context 2>/dev/null || true)"
if [ "$current" != "$CONTEXT" ]; then
  echo "behold k3d demo: expected kubectl context \"$CONTEXT\" to be current after cluster create, got \"$current\" — aborting rather than reading the wrong cluster." >&2
  exit 1
fi
echo "behold k3d demo: cluster \"$CLUSTER\" up, kubectl context \"$CONTEXT\" active."
