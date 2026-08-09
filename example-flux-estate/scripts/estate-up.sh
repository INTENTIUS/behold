#!/usr/bin/env bash
# Stand up the flux-estate demo (#211): a throwaway single-node k3d cluster,
# Flux's controllers (applied straight from the pinned release manifest — no
# flux CLI needed), and the control plane's CRs. From there the reconcilers
# deploy the app projects out of behold's public repo.
#
# Safety, same contract as example-k8s: never touches any OTHER kubeconfig
# context. Whatever context is current is saved to .prev-context and restored
# by estate-down.sh; the cluster and its context are uniquely named
# (behold-flux-demo / k3d-behold-flux-demo).
#
# BEHOLD_FLUX_REF (optional): patch the LIVE GitRepository to sync a branch
# other than main — how a not-yet-merged manifests change is verified. The
# declared source always says main.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=behold-flux-demo
CONTEXT="k3d-${CLUSTER}"
STATE="scripts/.prev-context"
FLUX_MANIFEST="https://github.com/fluxcd/flux2/releases/download/v2.4.0/install.yaml"

if ! docker info >/dev/null 2>&1; then
  echo "flux-estate demo: Docker is not running — start Docker and re-run." >&2
  exit 1
fi
for bin in k3d kubectl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "flux-estate demo: $bin is not installed." >&2
    exit 1
  fi
done

if ! k3d cluster list 2>/dev/null | grep -q "^${CLUSTER} "; then
  kubectl config current-context > "$STATE" 2>/dev/null || true
  k3d cluster create "$CLUSTER" --wait
else
  echo "flux-estate demo: cluster ${CLUSTER} already up — reusing."
fi

echo "flux-estate demo: installing Flux controllers (${FLUX_MANIFEST##*/download/})…"
kubectl --context "$CONTEXT" apply -f "$FLUX_MANIFEST" > /dev/null
kubectl --context "$CONTEXT" -n flux-system rollout status deploy/source-controller --timeout=180s
kubectl --context "$CONTEXT" -n flux-system rollout status deploy/kustomize-controller --timeout=180s

echo "flux-estate demo: building + applying the control plane's CRs…"
(cd control-plane && npx chant build src -o dist/control-plane.yaml --format yaml)
kubectl --context "$CONTEXT" apply -f control-plane/dist/control-plane.yaml

if [ -n "${BEHOLD_FLUX_REF:-}" ]; then
  echo "flux-estate demo: syncing branch ${BEHOLD_FLUX_REF} instead of main (BEHOLD_FLUX_REF)"
  kubectl --context "$CONTEXT" -n flux-system patch gitrepository behold --type merge \
    -p "{\"spec\":{\"ref\":{\"branch\":\"${BEHOLD_FLUX_REF}\"}}}"
fi

echo "flux-estate demo: waiting for the reconcilers to deploy the apps…"
kubectl --context "$CONTEXT" -n flux-system wait --for=condition=Ready --timeout=180s gitrepository/behold
kubectl --context "$CONTEXT" -n flux-system wait --for=condition=Ready --timeout=180s kustomization/app-a kustomization/app-b
kubectl --context "$CONTEXT" -n app-a rollout status deploy/app-a --timeout=180s
kubectl --context "$CONTEXT" -n app-b rollout status deploy/app-b --timeout=180s
echo "flux-estate demo: up — Flux deployed both apps from the repo."
