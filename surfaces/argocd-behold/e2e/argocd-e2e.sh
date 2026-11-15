#!/usr/bin/env bash
# The extension against a full Argo CD (not core-install, which has no UI) on a
# scratch k3d cluster. Installs Argo CD at a pinned release, adds the extension
# through argocd-extension-installer as an init container of argocd-server,
# syncs an Application from a git repository served inside the cluster, then
# drives the UI in Chrome: a ServiceAccount tab shows its IAM role, the
# Application tab lists the role and the git source, and the console has no
# TypeError. Needs docker, k3d, kubectl, node and Chrome. The cluster
# (behold-argocd-ui by default) is left running; nothing here deletes it, and a
# second run reuses it. A small file server for the tarball is left running on
# BEHOLD_ARGOCD_FILE_PORT (8099): argocd-server's init container downloads from
# it each time the pod starts.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cluster="${BEHOLD_ARGOCD_CLUSTER:-behold-argocd-ui}"
ctx="k3d-$cluster"
version="${ARGOCD_VERSION:-v3.5.7}"
hostport="${BEHOLD_ARGOCD_FILE_PORT:-8099}"
uiport="${BEHOLD_ARGOCD_UI_PORT:-8480}"
work="${BEHOLD_ARGOCD_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/behold-argocd-e2e.XXXXXX")}"
k="kubectl --context $ctx"

k3d cluster list "$cluster" >/dev/null 2>&1 || k3d cluster create "$cluster" --agents 0 --wait
$k get ns argocd >/dev/null 2>&1 || $k create ns argocd
$k -n argocd get deploy argocd-server >/dev/null 2>&1 || \
  $k apply -n argocd --server-side -f "https://raw.githubusercontent.com/argoproj/argo-cd/$version/manifests/install.yaml"
$k -n argocd rollout status deploy/argocd-server --timeout=300s

(cd "$here" && npm run build >/dev/null && node scripts/package.mjs >/dev/null)
curl -sf "http://localhost:$hostport/checksums.txt" >/dev/null 2>&1 || (cd "$here" && node e2e/serve-release.mjs "$hostport" >"$work/files.log" 2>&1 &)
sleep 1
url="http://host.k3d.internal:$hostport"

if ! $k -n argocd get deploy argocd-server -o jsonpath='{.spec.template.spec.initContainers[*].name}' | grep -q extension-behold; then
  sed "s#@URL@#$url#g" "$here/fixtures/installer-patch.json" >"$work/patch.json"
  $k -n argocd patch deploy argocd-server --type=json --patch-file "$work/patch.json"
  $k -n argocd rollout status deploy/argocd-server --timeout=300s
fi

$k apply -f "$here/fixtures/repo.yaml"
$k -n gitsrv rollout status deploy/gitsrv --timeout=180s
$k apply -f "$here/fixtures/app.yaml"
for _ in $(seq 1 60); do
  [ "$($k -n argocd get app shop -o jsonpath='{.status.sync.status}/{.status.health.status}' 2>/dev/null)" = "Synced/Healthy" ] && break
  sleep 3
done

$k -n argocd port-forward svc/argocd-server "$uiport:443" >"$work/pf.log" 2>&1 &
pf=$!
trap 'kill $pf 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -skf "https://localhost:$uiport/" >/dev/null && break; sleep 1; done
password="$($k -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)"

ARGOCD_URL="https://localhost:$uiport" ARGOCD_PASSWORD="$password" SHOTS="${SHOTS:-$work}" node "$here/e2e/argocd-e2e.mjs"
