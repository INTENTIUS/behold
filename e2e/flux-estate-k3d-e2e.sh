#!/usr/bin/env bash
# behold#256 — the flux-estate lane's acceptance run, against a REAL Flux on a
# scratch k3d cluster. The estate lenses (#241) and the GitOps health verdicts
# (#238) both shipped with unit tests and a hand-driven demo; this is the run
# that puts them in front of a live reconciler, where the states that matter
# (a `Ready` condition the controller actually wrote, a `targetNamespace`
# stamped at apply time, workloads Flux attributed back to a Kustomization)
# exist for real instead of as fixtures.
#
#   1. estate composition  — /api/graph?detail=3 carries both `sourceRef` edges
#                            (Kustomization → GitRepository, across stacks),
#                            app-b's `dependsOn` gate on app-a, and — since
#                            #329 — the `reconciles` edge that crosses a member
#                            boundary: the control plane's Kustomization joined
#                            to the app member its `spec.path` names, landing on
#                            that member's ENTRY node and nowhere else.
#   2. the detail cliff     — /api/overlay at chant's default detail is edgeless
#      (#322/#326)            (every join above reads full attrs), and says so in
#                            those words instead of claiming the estate
#                            references nothing. At detail 3 the claim is gone
#                            and the cross-member edge is in the LIVE overlay,
#                            not only in the source graph.
#   3. logical lens (#241)  — /api/overlay?logical=1 answers mode "logical" with
#      + the join (#221)      cluster ⊃ namespace boxes, app-a's objects inside
#                            the namespace the CONTROL PLANE declares, and each
#                            card keeping its live drift colour — app-b's
#                            included, which is green only because the estate
#                            joined the control plane's `targetNamespace` into
#                            app-b's own live read.
#   4. runtime tier (#241)  — /api/overlay?runtime=1 boxes the objects Flux
#                            deployed under the declaring Kustomization, via the
#                            composed-id `runtimeOwner` re-pointing.
#   5. health, happy (#238) — /api/diff reads each Flux CR's own `Ready`
#                            condition (`Ready=True`), while a plain Namespace
#                            keeps the regex fallback with nothing added.
#   6. health, unhappy      — app-b's live Kustomization is pointed at a path
#                            that does not exist; the verdict turns `degraded`
#                            carrying the controller's own reason, then follows
#                            it back to healthy when the path is restored.
#   7. the queried line     — app-b served ALONE (no estate, so no binding to
#      (#192)                 join) carries the resolved address its failed
#                            live read was issued against: namespace
#                            `default`, not `app-b`. The control case for
#                            step 3 — the same objects, the same cluster, and
#                            the composed read is the only one that finds them.
#
# ## The choices this run makes
#
# **The source is the real one.** The demo's `GitRepository` points at behold's
# own public repo on `main`, and its app `manifests/` are committed there — so
# the reconcilers fetch from GitHub exactly as `scripts/estate-up.sh` intends.
# Nothing is stubbed and no local Bucket/OCI substitute is invented (the demo
# supports none). A source-less variant could only assert that Kustomizations
# exist, which proves neither #241's attribution nor #238's Ready mapping. If
# GitHub is unreachable the run SKIPs rather than asserting a weaker thing.
#
# **Flux comes from the pinned release manifest**, the same `install.yaml`
# `scripts/estate-up.sh` applies — so the `flux` CLI is deliberately NOT a
# prerequisite, matching the demo's documented path (docker, k3d, kubectl).
#
# **The context is aliased inside an isolated kubeconfig.** All three members
# pin `k3d-behold-flux-demo` in their `chant.config.ts`; this run's cluster is
# `behold-flux-e2e`. So it writes its own kubeconfig under a temp dir, renames
# the context there, and exports `KUBECONFIG` — the caller's default kubeconfig
# is never written, never switched, and no other cluster, context or container
# is read or touched.
#
# **Every wait is a deadline poll over queryable state** — no blind sleeps, and
# a terminal controller reason aborts immediately instead of burning the
# deadline (see `TERMINAL_REASONS`).
#
# ## Teardown
#
# One trap on EXIT/INT/TERM kills both servers, deletes the cluster and removes
# the temp dir — on pass, on failure, on interrupt. The cluster name is fixed
# and unique to this script, and it refuses to start if one already exists, so
# it can never delete a cluster it did not create in that same run.
#
#   just e2e-flux-estate
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=behold-flux-e2e
CONTEXT=k3d-behold-flux-demo # what the members' chant.config.ts pins
ESTATE=example-flux-estate
PORT="${BEHOLD_E2E_PORT:-4695}"
PORT_B="${BEHOLD_E2E_PORT_B:-4694}"
FLUX_MANIFEST="https://github.com/fluxcd/flux2/releases/download/v2.4.0/install.yaml"
# Reasons Flux only writes when the thing cannot converge without a change:
# abort on sight. Deliberately NOT here: `ArtifactFailed` and
# `DependencyNotReady`, which the kustomize-controller writes transiently while
# the source is still being fetched and while an earlier layer converges.
TERMINAL_REASONS='BuildFailed|AuthenticationFailed|URLInvalid|InvalidPath|StorageOperationFailed'
POD_TERMINAL='ImagePullBackOff|ErrImagePull|CrashLoopBackOff|CreateContainerConfigError|InvalidImageName'

skip() { echo "SKIP: $*"; exit 0; }

for bin in k3d kubectl curl node npm; do
  command -v "$bin" >/dev/null 2>&1 || skip "$bin is not installed — this run needs docker, k3d, kubectl (the demo's own prerequisites)."
done
docker info >/dev/null 2>&1 || skip "Docker is not running — start it and re-run."
curl -sf --max-time 10 -o /dev/null https://github.com ||
  skip "github.com is unreachable — the estate's GitRepository is a real remote, and a source-less run would prove none of what this asserts."
if k3d cluster list 2>/dev/null | grep -q "^${CLUSTER} "; then
  echo "✗ a cluster named ${CLUSTER} already exists — this run only ever deletes a cluster it created."
  echo "  Remove it yourself (k3d cluster delete ${CLUSTER}) and re-run."
  exit 1
fi

TMP="$(mktemp -d)"
export KUBECONFIG="$TMP/kubeconfig"
CREATED=""
SRV=""
SRV_B=""
cleanup() {
  if [ -n "$SRV" ]; then kill "$SRV" 2>/dev/null || true; fi
  if [ -n "$SRV_B" ]; then kill "$SRV_B" 2>/dev/null || true; fi
  if [ -n "$CREATED" ]; then
    echo "→ teardown: deleting cluster $CLUSTER"
    k3d cluster delete "$CLUSTER" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

k() { kubectl --context "$CONTEXT" "$@"; }

# Poll a predicate to a deadline. The interval is a poll cadence, never a bet on
# how long something takes — the predicate is the detector (see the estate's
# other runs and the "timeouts are not detectors" reading).
wait_for() {
  local label="$1" secs="$2"
  shift 2
  local end=$(($(date +%s) + secs))
  while :; do
    if "$@"; then return 0; fi
    if [ "$(date +%s)" -ge "$end" ]; then
      echo "✗ timed out after ${secs}s waiting for $label"
      return 1
    fi
    sleep 2
  done
}

ready_cond() { k -n flux-system get "$1" "$2" -o jsonpath="{.status.conditions[?(@.type=='Ready')].$3}" 2>/dev/null || true; }

# Ready=True, or abort on a reason that will not clear on its own.
flux_ready() {
  local kind="$1" name="$2" status reason
  status="$(ready_cond "$kind" "$name" status)"
  if [ "$status" = "True" ]; then return 0; fi
  reason="$(ready_cond "$kind" "$name" reason)"
  if [ "$status" = "False" ] && printf '%s' "$reason" | grep -qE "^(${TERMINAL_REASONS})$"; then
    echo "✗ $kind/$name is terminally not ready: $reason — $(ready_cond "$kind" "$name" message)"
    exit 1
  fi
  return 1
}

# A workload with at least one ready replica, aborting on a pod the kubelet
# will never start.
deploy_ready() {
  local ns="$1" name="$2" waiting
  waiting="$(k -n "$ns" get pods -o jsonpath='{range .items[*].status.containerStatuses[*]}{.state.waiting.reason}{"\n"}{end}' 2>/dev/null || true)"
  if printf '%s' "$waiting" | grep -qE "^(${POD_TERMINAL})$"; then
    echo "✗ $ns/$name has a pod the kubelet cannot start: $(printf '%s' "$waiting" | grep -E "^(${POD_TERMINAL})$" | head -1)"
    exit 1
  fi
  [ "$(k -n "$ns" get deploy "$name" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)" = "1" ]
}

api() { curl -sf --max-time 120 "http://localhost:$PORT$1"; }

START="$(date +%s)"

echo "→ (0/7) build behold + install the estate's own chant"
npm run build --silent
npm --prefix "$ESTATE" install --no-audit --no-fund --silent
echo "  chant: $(node -e "process.stdout.write(require('./$ESTATE/node_modules/@intentius/chant/package.json').version)")"

echo "→ scratch cluster $CLUSTER (isolated KUBECONFIG, default kubeconfig untouched)"
k3d cluster create "$CLUSTER" --wait --kubeconfig-update-default=false --kubeconfig-switch-context=false >/dev/null
CREATED=1
k3d kubeconfig get "$CLUSTER" >"$KUBECONFIG"
# The members declare `k3d-behold-flux-demo`; this run's cluster is uniquely
# named. Rename inside OUR kubeconfig so the declared binding resolves and a
# live read can still never reach an ambient cluster.
kubectl config rename-context "k3d-$CLUSTER" "$CONTEXT" >/dev/null

echo "→ Flux controllers (${FLUX_MANIFEST##*/download/})"
k apply -f "$FLUX_MANIFEST" >/dev/null
wait_for "source-controller" 240 deploy_ready flux-system source-controller
wait_for "kustomize-controller" 240 deploy_ready flux-system kustomize-controller

echo "→ control plane: built by its own chant, applied once"
(cd "$ESTATE/control-plane" && npx chant build src -o dist/control-plane.yaml --format yaml >/dev/null)
k apply -f "$ESTATE/control-plane/dist/control-plane.yaml" >/dev/null

echo "→ the reconcilers deploy both apps from the repo"
wait_for "gitrepository/behold Ready" 240 flux_ready gitrepository behold
wait_for "kustomization/app-a Ready" 240 flux_ready kustomization app-a
wait_for "kustomization/app-b Ready" 240 flux_ready kustomization app-b
wait_for "deploy app-a/app-a" 180 deploy_ready app-a app-a
wait_for "deploy app-b/app-b" 180 deploy_ready app-b app-b
echo "  ✓ Flux deployed both apps"

echo "→ serve the estate on :$PORT (control-plane app-a app-b, env=local)"
node ./bin/behold.js serve "$ESTATE/control-plane" "$ESTATE/app-a" "$ESTATE/app-b" \
  --env local --port "$PORT" >"$TMP/serve.log" 2>&1 &
SRV=$!
up() { curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1; }
wait_for "behold" 90 up || { sed -n '1,40p' "$TMP/serve.log"; exit 1; }

echo "→ (1/7) estate composition — sourceRef, dependsOn, and the cross-member reconciles"
api "/api/graph?detail=3" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const j = JSON.parse(d);
    if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
    if (j.meta.estate !== 3) { console.error("✗ estate composed", j.meta.estate, "projects, expected 3"); process.exit(1); }
    const has = (from, to, via) => j.ir.edges.some((e) => e.from === from && e.to === to && e.viaAttr === via);
    const want = [
      ["control-plane/appA", "control-plane/source", "sourceRef"],
      ["control-plane/appB", "control-plane/source", "sourceRef"],
      ["control-plane/appB", "control-plane/appA", "dependsOn"],
      // #329, the edge #166 measured missing: the Kustomization declares
      // `spec.path: ./example-flux-estate/app-a/manifests`, and behold knows
      // app-a by the checkout it was pointed at, so the two join across the
      // member boundary. Nothing in `src/k8s-edges.ts` can make this join —
      // every one of those keys on kind/namespace/name, and a path is none.
      ["control-plane/appA", "app-a/service", "reconciles"],
      ["control-plane/appB", "app-b/service", "reconciles"],
      // The member is a box of cards and Flux applies all of them, so the
      // crossing lands on the member ENTRY node — the one nothing inside the
      // member already points at — and the edges inside carry the rest.
      ["app-a/service", "app-a/deployment", "selector"],
      ["app-b/service", "app-b/deployment", "selector"],
    ];
    for (const [f, t, v] of want) {
      if (!has(f, t, v)) { console.error("✗ missing", v, "edge", f, "->", t); process.exit(1); }
      console.log(`  ✓ ${f} -${v}-> ${t}`);
    }
    // ...and ONLY on the entry node. A second arrow into the Deployment would
    // restate what the box already says, which is the hairball #329 refused.
    for (const owner of ["control-plane/appA", "control-plane/appB"]) {
      const crossings = j.ir.edges.filter((e) => e.from === owner && e.viaAttr === "reconciles");
      if (crossings.length !== 1) {
        console.error("✗", owner, "draws", crossings.length, "reconciles edges —", crossings.map((e) => e.to).join(", "), "— expected one crossing per boundary");
        process.exit(1);
      }
      if (!crossings[0].inferred) { console.error("✗", owner, "reconciles edge is not tagged inferred"); process.exit(1); }
    }
    console.log("  ✓ one reconciles crossing per member, tagged inferred — the box interior unchanged");
  });
'

echo "→ (2/7) the detail cliff the estate opens on (#322/#326)"
# Every join that draws an edge here reads full attrs, so at chant's default
# detail the composed estate is genuinely edgeless — and the note used to assert
# the wrong reason for it ("nothing in this estate references anything else"),
# which is false of an estate that has 7 edges one tier up. #326 made the
# non-lens estate overlay pass its detail through to `edgelessNote`; this is that
# sentence, read off a live three-member estate rather than a fixture.
api "/api/overlay?env=local" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const j = JSON.parse(d);
    if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
    if (j.ir.edges.length !== 0) { console.error("✗", j.ir.edges.length, "edges at the default detail — the cliff this note explains is gone"); process.exit(1); }
    const note = j.meta.note ?? "";
    if (!/no edges at this detail/.test(note)) { console.error("✗ the edgeless estate says nothing about the tier:", JSON.stringify(note)); process.exit(1); }
    if (/nothing in this estate references anything else/.test(note)) {
      console.error("✗ the note still claims the estate is edgeless in fact, not at this tier:", note); process.exit(1);
    }
    console.log("  ✓ default detail:", note);
  });
'
# One tier up the claim has to be gone — and the cross-member edge has to be in
# the LIVE overlay, not only in the source graph step 1 read.
api "/api/overlay?detail=3&env=local" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const j = JSON.parse(d);
    if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
    const crossings = j.ir.edges.filter((e) => e.viaAttr === "reconciles");
    if (crossings.length !== 2) {
      console.error("✗", crossings.length, "reconciles edges on the live overlay — expected 2:", j.ir.edges.map((e) => `${e.from}-${e.viaAttr}->${e.to}`).join(", "));
      process.exit(1);
    }
    if (/no edges/.test(j.meta.note ?? "")) { console.error("✗ detail 3 still claims no edges:", j.meta.note); process.exit(1); }
    console.log(`  ✓ detail 3: ${crossings.map((e) => `${e.from} -reconciles-> ${e.to}`).join(", ")}, no edgeless claim`);
  });
'

echo "→ (3/7) the logical lens on the estate (#241)"
api "/api/overlay?logical=1&env=local" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const j = JSON.parse(d);
    if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
    if (j.meta.mode !== "logical") { console.error("✗ mode", j.meta.mode, "— the lens did not apply"); process.exit(1); }
    const bc = j.byContainer ?? {};
    const holds = (box, id) => (bc[box] ?? []).includes(id);
    for (const box of ["namespace flux-system", "namespace app-a"]) {
      if (!bc[box]) { console.error("✗ no", JSON.stringify(box), "box —", Object.keys(bc).join(", ")); process.exit(1); }
    }
    // app-a declares its own namespace; the box it lands in is the one the
    // CONTROL PLANE declares — the containment that only exists composed.
    for (const id of ["app-a/deployment", "app-a/service"]) {
      if (!holds("namespace app-a", id)) { console.error("✗", id, "is not inside the namespace the control plane declares"); process.exit(1); }
    }
    for (const id of ["control-plane/appA", "control-plane/appB", "control-plane/source"]) {
      if (!holds("namespace flux-system", id)) { console.error("✗", id, "is not inside namespace flux-system"); process.exit(1); }
    }
    // Live colours survive the projection — and since #221 that includes
    // app-b, whose objects declare no namespace at all. Green here means the
    // estate joined targetNamespace off the control plane into the live read
    // issued for app-b. Step 7 serves app-b alone and gets the other answer.
    const st = Object.fromEntries(j.ir.nodes.map((n) => [n.id, n.attrs && n.attrs._status]));
    for (const id of ["control-plane/appA", "control-plane/appB", "control-plane/source", "app-a/deployment", "app-a/service", "app-b/deployment", "app-b/service"]) {
      if (st[id] !== "good") { console.error("✗", id, "reads", st[id], "— expected good on a converged estate"); process.exit(1); }
    }
    if (!/read app-b in "app-b"/.test(j.meta.note ?? "")) {
      console.error("✗ no namespace-join line on the estate overlay:", j.meta.note); process.exit(1);
    }
    // The #192 note explains an all-pending half. There is no longer one.
    if (/declare no metadata\.namespace/.test(j.meta.note ?? "")) {
      console.error("✗ the namespace-mismatch note survived the join:", j.meta.note); process.exit(1);
    }
    console.log("  ✓ boxes:", Object.keys(bc).join(" / "));
    console.log("  ✓ note:", j.meta.note);
  });
'

echo "→ (4/7) the runtime tier on the estate (#241) — Kustomization containment"
api "/api/overlay?runtime=1&env=local" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const j = JSON.parse(d);
    if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
    const bc = (j.ir.groups && j.ir.groups.byContainer) ?? {};
    const byId = Object.fromEntries(j.ir.nodes.map((n) => [n.id, n]));
    for (const owner of ["control-plane/appA", "control-plane/appB"]) {
      const members = bc[owner];
      if (!members) { console.error("✗ no containment box for", owner, "—", Object.keys(bc).join(", ")); process.exit(1); }
      if (!members.includes(owner)) { console.error("✗", owner, "is outside its own box — the #144 shape"); process.exit(1); }
      const kids = members.filter((m) => m !== owner && byId[m] && byId[m].runtimeOwner === owner);
      if (!kids.length) { console.error("✗ no workload attributed to", owner); process.exit(1); }
      for (const kid of kids) {
        if (byId[kid].attrs._status !== "runtime") { console.error("✗", kid, "is not painted runtime"); process.exit(1); }
      }
      console.log(`  ✓ ${owner} ⊃ ${kids.map((k) => `${byId[k].kind.replace(/^K8s::/, "")} ${k}`).join(", ")}`);
    }
  });
'

echo "→ (5/7) health verdicts read off the controller conditions (#238)"
api "/api/diff?env=local" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const j = JSON.parse(d);
    if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
    for (const id of ["appA", "appB", "source"]) {
      const n = j.nodes[id];
      if (!n) { console.error("✗ no", id, "in the diff"); process.exit(1); }
      if (n.health !== "healthy" || n.healthDetail !== "Ready=True") {
        console.error("✗", id, "read", n.health, JSON.stringify(n.healthDetail), "— expected healthy from Ready=True"); process.exit(1);
      }
      console.log(`  ✓ ${id}: ${n.health} (${n.healthDetail})`);
    }
    // The kind-aware layer is a layer, not a replacement: a plain Namespace
    // still takes the regex, which has nothing to add beyond the status word.
    const ns = j.nodes.nsAppA;
    if (!ns || ns.healthDetail !== undefined) {
      console.error("✗ nsAppA carries a condition detail —", JSON.stringify(ns && ns.healthDetail), "— the fallback should be untouched"); process.exit(1);
    }
    console.log(`  ✓ nsAppA: ${ns.health}, no condition detail (regex fallback, unchanged)`);
  });
'

echo "→ (6/7) the unhappy arm — the app-b Kustomization pointed at a missing path"
k -n flux-system patch kustomization app-b --type merge \
  -p '{"spec":{"path":"./example-flux-estate/app-b/behold-e2e-does-not-exist"}}' >/dev/null
k -n flux-system annotate --overwrite kustomization app-b reconcile.fluxcd.io/requestedAt="e2e-break" >/dev/null
verdict() { api "/api/diff?env=local" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const n = (JSON.parse(d).nodes ?? {}).appB ?? {};
    process.stdout.write(`${n.health ?? "?"}|${n.healthDetail ?? ""}`);
  });
'; }
degraded() { verdict | grep -q '^degraded|Ready=False'; }
wait_for "appB to read degraded" 180 degraded
echo "  ✓ appB: $(verdict | tr '|' ' ')"

echo "  restoring the declared path"
k -n flux-system patch kustomization app-b --type merge \
  -p '{"spec":{"path":"./example-flux-estate/app-b/manifests"}}' >/dev/null
k -n flux-system annotate --overwrite kustomization app-b reconcile.fluxcd.io/requestedAt="e2e-restore" >/dev/null
healthy() { [ "$(verdict)" = "healthy|Ready=True" ]; }
wait_for "appB back to healthy" 180 healthy
echo "  ✓ appB: healthy (Ready=True) — the verdict follows the controller both ways"

echo "→ (7/7) the queried line (#192) — where an UNJOINED read looks"
# /api/diff slices the PRIMARY project, and the primary here is the
# control plane (whose objects all resolve). app-b — the half whose namespace
# Flux stamps at apply time — is served on its own to read its addresses.
# Alone it has no sibling declaring the binding, so the #221 join cannot
# apply: this is the control case that makes step 3's green mean something.
node ./bin/behold.js serve "$ESTATE/app-b" --env local --port "$PORT_B" >"$TMP/serve-b.log" 2>&1 &
SRV_B=$!
up_b() { curl -sf "http://localhost:$PORT_B/healthz" >/dev/null 2>&1; }
wait_for "behold (app-b)" 90 up_b || { sed -n '1,40p' "$TMP/serve-b.log"; exit 1; }
curl -sf --max-time 120 "http://localhost:$PORT_B/api/diff?env=local" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const j = JSON.parse(d);
    if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
    for (const id of ["deployment", "service"]) {
      const n = j.nodes[id];
      if (!n || !n.diff) { console.error("✗ no diff for", id); process.exit(1); }
      if (n.diff.category !== "missing") { console.error("✗", id, "is", n.diff.category, "— expected missing"); process.exit(1); }
      const q = n.diff.queried;
      if (!q) { console.error("✗", id, "carries no queried address — the diagnosis line is gone"); process.exit(1); }
      if (!/\/namespaces\/default\//.test(q)) {
        console.error("✗", id, "queried", q, "— expected the default namespace the mismatch note names"); process.exit(1);
      }
      console.log(`  ✓ ${id}: missing, queried ${q}`);
    }
  });
'

echo "✓ flux-estate acceptance passed in $(( $(date +%s) - START ))s"
