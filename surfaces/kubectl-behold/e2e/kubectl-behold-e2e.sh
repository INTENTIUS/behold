#!/usr/bin/env bash
# behold#1086: `kubectl behold`, through krew, and the k9s entry.
#
# Boots a scratch k3d cluster (BEHOLD_E2E_CLUSTER, default behold-kubectl-e2e),
# refuses to adopt one that exists unless BEHOLD_E2E_REUSE=1, and NEVER deletes
# it: the script prints the command that does. The kubeconfig is a temp file,
# so the caller's default kubeconfig is never written or switched.
#
#   1. `kubectl behold deploy/web -n app` writes a picture of that Deployment
#      and what touches it, and hands it to the opener.
#   2. the same through krew: install from the built archive and the manifest
#      the index pull request carries, run it, uninstall, and nothing is left
#      under KREW_ROOT. Needs `kubectl krew` (KREW_BIN names a krew binary);
#      skipped, and said so, without it.
#   3. the k9s entry's command, with the variables k9s sets, draws the same
#      Deployment. Run for real inside k9s when K9S_BIN is set and `expect`
#      exists.
#   4. a kubeconfig whose user runs an exec plugin is refused, and the message
#      says how to allow it.
#
# behold runs from this checkout's build (BEHOLD_BIN="node bin/behold.js"):
# the plugin's pinned npm release is not what is under test here.
set -euo pipefail
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
SURF="$ROOT/surfaces/kubectl-behold"

for t in docker k3d kubectl node; do
  command -v "$t" >/dev/null 2>&1 || { echo "SKIP: $t is not on PATH"; exit 0; }
done
docker info >/dev/null 2>&1 || { echo "SKIP: docker is not running"; exit 0; }
[ -f dist/cli.js ] || npm run build >/dev/null

CLUSTER="${BEHOLD_E2E_CLUSTER:-behold-kubectl-e2e}"
case "$CLUSTER" in behold-*) ;; *) echo "BEHOLD_E2E_CLUSTER must start with behold-"; exit 2 ;; esac
WORK="$(mktemp -d "${TMPDIR:-/tmp}/behold-kubectl-e2e.XXXXXX")"
export KUBECONFIG="$WORK/kubeconfig"
export BEHOLD_BIN="node $ROOT/bin/behold.js"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

if k3d cluster list -o json | node -e 'process.exit(JSON.parse(require("fs").readFileSync(0,"utf8")).some(c=>c.name===process.argv[1])?0:1)' "$CLUSTER"; then
  [ "${BEHOLD_E2E_REUSE:-}" = 1 ] || fail "cluster $CLUSTER exists; set BEHOLD_E2E_REUSE=1 to use it, or BEHOLD_E2E_CLUSTER to name another"
  echo "reusing cluster $CLUSTER"
else
  echo "creating scratch cluster $CLUSTER (left in place afterwards)"
  k3d cluster create "$CLUSTER" --wait --kubeconfig-update-default=false --kubeconfig-switch-context=false >/dev/null
fi
k3d kubeconfig get "$CLUSTER" >"$KUBECONFIG"
CTX="k3d-$CLUSTER"
kubectl config use-context "$CTX" >/dev/null
kubectl get ns app >/dev/null 2>&1 || kubectl create ns app >/dev/null
kubectl -n app get deploy web >/dev/null 2>&1 || kubectl -n app create deploy web --image=registry.k8s.io/pause:3.9 >/dev/null
kubectl -n app get svc web >/dev/null 2>&1 || kubectl -n app expose deploy web --port 80 >/dev/null
kubectl -n app wait --for=condition=Available deploy/web --timeout=120s >/dev/null

# A fake opener records what the plugin would have opened.
OPENER="$WORK/opener.sh"
printf '#!/bin/sh\necho "$1" >> "%s/opened"\n' "$WORK" >"$OPENER"
chmod +x "$OPENER"
export BEHOLD_OPEN="$OPENER"

check_picture() { # file
  [ -s "$1" ] || fail "no picture at $1"
  grep -q "<svg" "$1" || fail "$1 is not an SVG"
  grep -q "web" "$1" || fail "$1 does not name the web Deployment"
  if grep -q "kube-system" "$1"; then fail "$1 shows kube-system: the view was not focused"; fi
}

# 1. the plugin on PATH, as kubectl finds it.
mkdir -p "$WORK/bin"
ln -s "$SURF/kubectl-behold" "$WORK/bin/kubectl-behold"
PATH="$WORK/bin:$PATH" kubectl behold deploy/web -n app -o "$WORK/one.svg" >/dev/null
check_picture "$WORK/one.svg"
grep -qx "$WORK/one.svg" "$WORK/opened" || fail "the opener was not handed the picture"
ok "kubectl behold deploy/web -n app drew the Deployment and opened it"
PATH="$WORK/bin:$PATH" kubectl behold deploy web -n app --no-open -o "$WORK/two.svg" >/dev/null
check_picture "$WORK/two.svg"
ok "TYPE NAME spelling"
PATH="$WORK/bin:$PATH" kubectl behold --no-open -o "$WORK/all.svg" >/dev/null
grep -q "kube-system" "$WORK/all.svg" || fail "the whole-context picture misses kube-system"
ok "no object draws the whole context"

# 2. krew: install from the archive and manifest, run, uninstall.
KREW="${KREW_BIN:-}"
if [ -z "$KREW" ] && kubectl krew version >/dev/null 2>&1; then KREW="kubectl-krew"; fi
if [ -n "$KREW" ]; then
  node "$SURF/scripts/package.mjs" --check >/dev/null || fail "archive does not match krew/behold.yaml"
  ARCHIVE="$SURF/release/$(basename "$(grep -o 'kubectl-behold-v[0-9.]*\.tar\.gz' "$SURF/krew/behold.yaml" | head -1)")"
  [ -f "$ARCHIVE" ] || node "$SURF/scripts/package.mjs" >/dev/null
  export KREW_ROOT="$WORK/krew"
  mkdir -p "$KREW_ROOT"
  PATH="$KREW_ROOT/bin:$PATH"
  # krew installs itself first, then the plugin from the local archive.
  "$KREW" install krew >/dev/null 2>&1 || fail "krew could not install itself"
  kubectl krew install --manifest="$SURF/krew/behold.yaml" --archive="$ARCHIVE" >"$WORK/krew-install.log" 2>&1 || { cat "$WORK/krew-install.log"; fail "krew install"; }
  grep -qi "node 20" "$WORK/krew-install.log" || fail "the caveat about Node was not shown"
  kubectl behold deploy/web -n app --no-open -o "$WORK/krew.svg" >/dev/null
  check_picture "$WORK/krew.svg"
  ok "kubectl krew install from the built archive, then kubectl behold deploy/web -n app"
  kubectl krew uninstall behold >/dev/null 2>&1 || fail "krew uninstall"
  if kubectl behold --help >/dev/null 2>&1; then fail "kubectl behold still resolves after uninstall"; fi
  left="$(find "$KREW_ROOT" \( -name '*behold*' \) 2>/dev/null || true)"
  [ -z "$left" ] || fail "uninstall left: $left"
  ok "kubectl krew uninstall left nothing under KREW_ROOT"
else
  echo "SKIP krew: no kubectl-krew on PATH and KREW_BIN unset"
fi

# 3. the k9s entry, with the variables k9s sets for a selected Deployment.
CTX="$CTX" node - "$SURF/k9s/behold.yaml" "$WORK/k9s-argv.txt" <<'JS'
const yaml = require(process.cwd() + "/node_modules/js-yaml");
const [file, outFile] = process.argv.slice(2);
const p = yaml.load(require("fs").readFileSync(file, "utf8")).plugins.behold;
if (!p.scopes.includes("deployments")) throw new Error("the entry does not cover deployments");
if (p.command !== "kubectl" || p.background !== true) throw new Error("expected a background kubectl command");
const env = { RESOURCE_NAME: "deployments", NAME: "web", NAMESPACE: "app", CONTEXT: process.env.CTX, KUBECONFIG: process.env.KUBECONFIG };
require("fs").writeFileSync(outFile, p.args.map((a) => a.replace(/\$([A-Z_]+)/g, (_, k) => env[k] ?? "")).join("\n") + "\n");
JS
argv=()
while IFS= read -r line; do argv+=("$line"); done <"$WORK/k9s-argv.txt"
: >"$WORK/opened"
PATH="$WORK/bin:$PATH" kubectl "${argv[@]}" >"$WORK/k9s.out"
picture="$(head -1 "$WORK/k9s.out")"
check_picture "$picture"
[ -s "$WORK/opened" ] || fail "the k9s entry's command did not open anything"
ok "the k9s entry's command (${argv[*]}) draws the Deployment"

if [ -n "${K9S_BIN:-}" ] && command -v expect >/dev/null 2>&1; then
  : >"$WORK/opened"
  mkdir -p "$WORK/k9s-config"
  cp "$SURF/k9s/behold.yaml" "$WORK/k9s-config/plugins.yaml"
  PATH="$WORK/bin:$PATH" K9S_CONFIG_DIR="$WORK/k9s-config" XDG_DATA_HOME="$WORK/k9s-data" XDG_CONFIG_HOME="$WORK/k9s-config" \
    expect "$SURF/e2e/k9s-drive.exp" "$K9S_BIN" "$CTX" "$WORK/opened" >/dev/null || fail "k9s did not open the view on Shift-B"
  check_picture "$(tail -1 "$WORK/opened")"
  ok "in k9s, Shift-B on the Deployment opened a view of it"
else
  echo "SKIP k9s: K9S_BIN unset or no expect; the entry's command was run as k9s would (above)"
fi

# 4. an exec-plugin kubeconfig is refused, and the message says how to allow it.
cat >"$WORK/exec.kubeconfig" <<YAML
apiVersion: v1
kind: Config
clusters: [{name: c, cluster: {server: "https://127.0.0.1:9"}}]
users: [{name: u, user: {exec: {apiVersion: client.authentication.k8s.io/v1, command: /usr/bin/false}}}]
contexts: [{name: x, context: {cluster: c, user: u}}]
current-context: x
YAML
set +e
PATH="$WORK/bin:$PATH" kubectl behold --kubeconfig "$WORK/exec.kubeconfig" --no-open >"$WORK/exec.out" 2>"$WORK/exec.err"
code=$?
set -e
[ "$code" = 2 ] || { cat "$WORK/exec.err"; fail "exec-plugin kubeconfig exit $code, want 2"; }
grep -q -- "--allow-exec-plugin" "$WORK/exec.err" || fail "the refusal does not say how to allow it"
ok "an exec-plugin kubeconfig is refused with the way to allow it"

echo
echo "PASS. Cluster $CLUSTER was left in place; remove it with: k3d cluster delete $CLUSTER"
