#!/usr/bin/env bash
# Headlamp against a scratch k3d cluster: a ServiceAccount annotated with an IAM
# role ARN must show a node for the role, linked to it, in the Resource Map, and
# an "Outside the cluster" section on its page. Needs docker, k3d, kubectl, node
# and Chrome. The cluster (behold-headlamp by default) and the Headlamp container
# (behold-headlamp-ui) are left running for the caller to remove; nothing here
# deletes them, and a second run reuses them.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cluster="${BEHOLD_HEADLAMP_CLUSTER:-behold-headlamp}"
ctx="k3d-$cluster"
work="${BEHOLD_HEADLAMP_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/behold-headlamp-e2e.XXXXXX")}"
port="${BEHOLD_HEADLAMP_PORT:-4466}"

k3d cluster list "$cluster" >/dev/null 2>&1 || k3d cluster create "$cluster" --agents 0 --wait
kubectl --context "$ctx" apply -f "$here/fixtures/cluster.yaml"
kubectl --context "$ctx" wait --for=condition=Established crd/applications.argoproj.io --timeout=60s
kubectl --context "$ctx" apply -f "$here/fixtures/app.yaml"

(cd "$here" && npm run build >/dev/null)
mkdir -p "$work/plugins" "$work/kc"
(cd "$here" && node scripts/package.mjs >/dev/null)
tar xzf "$here/release/headlamp-behold-$(node -p "require('$here/package.json').version").tar.gz" -C "$work/plugins"
k3d kubeconfig get "$cluster" | sed -E "s#server: https://[^ ]+#server: https://k3d-$cluster-serverlb:6443#" >"$work/kc/config"

if ! docker ps --format '{{.Names}}' | grep -qx behold-headlamp-ui; then
  docker start behold-headlamp-ui >/dev/null 2>&1 || docker run -d --name behold-headlamp-ui --network "k3d-$cluster" -p "$port:4466" \
    -v "$work/kc:/kc:ro" -v "$work/plugins:/headlamp/plugins:ro" \
    ghcr.io/headlamp-k8s/headlamp:latest -kubeconfig /kc/config -plugins-dir /headlamp/plugins >/dev/null
fi
for _ in $(seq 1 30); do curl -sf "http://localhost:$port/" >/dev/null && break; sleep 1; done

HEADLAMP_URL="http://localhost:$port" HEADLAMP_CONTEXT="$ctx" node "$here/e2e/headlamp-e2e.mjs"
