#!/usr/bin/env bash
# behold#269 — the argo-estate lane's acceptance run, against a REAL Argo CD on
# a scratch k3d cluster. The Argo joins (#222/#235), the estate lenses (#241)
# and the Argo half of the GitOps health verdicts (#238) shipped with unit tests
# and a declared-only demo; #238's `health`/`sync` mapping had never met an
# application controller. This is that run.
#
#   1. estate composition  — /api/graph?detail=3 carries the `project` edges
#                            joining both Applications to the AppProject, the
#                            `delivers` edge #329 derives from each
#                            `spec.source.path` across the member boundary, and
#                            NOTHING for the sync-wave ordering: Argo's ordering
#                            is an annotation, not a reference (contrast Flux's
#                            `dependsOn`, #223). Six edges, exactly.
#   2. the detail cliff     — /api/overlay at chant's default detail is edgeless
#      (#322/#326)            (every join above reads full attrs), and says so in
#                            those words instead of claiming the estate
#                            references nothing. At detail 3 the claim is gone
#                            and the cross-member edge is in the LIVE overlay,
#                            not only in the source graph.
#   3. logical lens (#241)  — /api/overlay?logical=1 boxes each Application's
#                            `spec.destination.namespace` and fills it with that
#                            app's live cards, though the estate declares no
#                            `Namespace` object anywhere: Argo creates them from
#                            `CreateNamespace=true`, so the box exists on the
#                            strength of the destination alone (#224).
#   4. runtime tier (#241)  — /api/overlay?runtime=1 boxes live objects under
#                            the Application that deployed them, resolved from
#                            Argo's `app.kubernetes.io/instance` label
#                            (chant#1549's Argo channel, live for the first
#                            time here).
#   5. health, happy (#238) — /api/diff reads each Application's health/sync
#                            pair, while the AppProject — which reports neither
#                            — keeps the regex fallback with nothing added.
#   6. health, unhappy      — app-b's live Application is pointed at a path that
#      (#275)                 does not exist. Argo writes a `ComparisonError`
#                            condition and holds `sync: Unknown` (it will not
#                            prune what it cannot compute), and behold's verdict
#                            follows it off the cluster, naming BOTH halves it
#                            read (`health=Healthy, sync=Unknown`) rather than
#                            guessing which one chant's collapsed word meant —
#                            AND joining the ComparisonError's own message,
#                            which chant carries since 0.44.8 (chant#1644).
#   7. the queried line     — with the comparison broken, app-b's Deployment is
#      (#192)                 deleted: Argo cannot self-heal a target state it
#                            cannot generate, so the read genuinely misses, and
#                            the diff carries the address it was issued
#                            against — `namespaces/app-b`, the app's OWN
#                            namespace. That is the Argo/Flux contrast worth
#                            having: flux-estate's same line reads `default`,
#                            because a Kustomization stamps the namespace at
#                            apply time and the objects never declare one.
#                            Restoring the path then puts the Deployment back
#                            (selfHeal) and the verdict back to healthy.
#
# ## The choices this run makes
#
# **The source is the real one.** Both Applications point at behold's own public
# repo on `main`, where the app members' `manifests/` (committed `chant build`
# output) already live — so Argo's repo-server fetches from GitHub exactly as
# the demo declares. Nothing is stubbed, no local git server is invented, and
# the ARGO005 warning the demo carries is precisely the property being used: the
# `source.path` is repo-relative, which is what Argo resolves it against. If
# GitHub is unreachable the run SKIPs rather than asserting a weaker thing.
#
# **Argo comes from the pinned `core-install` manifest** — the reconciler-only
# install (application controller, repo-server, redis; no API server, no UI, no
# dex). The `argocd` CLI is deliberately NOT a prerequisite, for the same reason
# the flux run needs no `flux` CLI: everything asserted is state a controller
# wrote to an object, readable with kubectl.
#
# **The context is aliased inside an isolated kubeconfig.** All three members
# pin `k3d-behold-argo-demo`; this run's cluster is `behold-argo-e2e`. So it
# writes its own kubeconfig under a temp dir, renames the context there, and
# exports `KUBECONFIG` — the caller's default kubeconfig is never written, never
# switched, and no other cluster, context or container is read or touched.
#
# **Every wait is a deadline poll over queryable state** — no blind sleeps, and
# a terminal controller verdict aborts immediately instead of burning the
# deadline (see `TERMINAL_CONDITIONS`).
#
# ## Teardown
#
# One trap on EXIT/INT/TERM kills both servers, deletes the cluster and removes
# the temp dir — on pass, on failure, on interrupt. The cluster name is fixed
# and unique to this script, and it refuses to start if one already exists, so
# it can never delete a cluster it did not create in that same run.
#
#   just e2e-argo-estate
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=behold-argo-e2e
CONTEXT=k3d-behold-argo-demo # what the members' chant.config.ts pins
ESTATE=example-argo-estate
PORT="${BEHOLD_E2E_PORT:-4697}"
PORT_B="${BEHOLD_E2E_PORT_B:-4696}"
ARGO_VERSION=v2.13.3
ARGO_MANIFEST="https://raw.githubusercontent.com/argoproj/argo-cd/${ARGO_VERSION}/manifests/core-install.yaml"
# The condition a controller writes about a spec it rejects outright — an
# unknown project, a destination the AppProject forbids. Deliberately NOT here:
# `ComparisonError`, which appears transiently while the repo is first cloned,
# and is the exact state step 6 induces on purpose.
TERMINAL_CONDITIONS='InvalidSpecError'
# `InvalidSpecError` is terminal only once it has SURVIVED this window. The
# estate is one multi-doc apply, kubectl applies it top to bottom, and the
# Applications land before the AppProject they name — so for a few seconds
# every fresh estate says "referencing project estate which does not exist" and
# then stops saying it. A spec error still standing after a full reconcile is
# one no amount of waiting fixes; the same judgement the flux run makes about
# `DependencyNotReady`, expressed as time rather than as a name.
INVALID_SPEC_GRACE=60
POD_TERMINAL='ImagePullBackOff|ErrImagePull|CrashLoopBackOff|CreateContainerConfigError|InvalidImageName'

skip() { echo "SKIP: $*"; exit 0; }

for bin in k3d kubectl curl node npm; do
  command -v "$bin" >/dev/null 2>&1 || skip "$bin is not installed — this run needs docker, k3d, kubectl."
done
docker info >/dev/null 2>&1 || skip "Docker is not running — start it and re-run."
curl -sf --max-time 10 -o /dev/null https://github.com ||
  skip "github.com is unreachable — the estate's Applications sync a real remote, and a source-less run would prove none of what this asserts."
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

app_field() { k -n argocd get application "$1" -o jsonpath="{.status.$2}" 2>/dev/null || true; }
app_conditions() { k -n argocd get application "$1" -o jsonpath='{range .status.conditions[*]}{.type}: {.message}{"\n"}{end}' 2>/dev/null || true; }

# Healthy AND Synced — the pair chant's readiness registry overrides `Ready`
# with — aborting on a condition the controller will not retract.
app_ready() {
  local name="$1" conds stamp
  conds="$(app_conditions "$name")"
  stamp="$TMP/invalid-spec-$name"
  if printf '%s' "$conds" | grep -qE "^(${TERMINAL_CONDITIONS}):"; then
    [ -f "$stamp" ] || date +%s >"$stamp"
    if [ "$(($(date +%s) - $(cat "$stamp")))" -ge "$INVALID_SPEC_GRACE" ]; then
      echo "✗ application/$name held a rejected spec for ${INVALID_SPEC_GRACE}s: $conds"
      exit 1
    fi
    return 1
  fi
  rm -f "$stamp"
  [ "$(app_field "$name" health.status)" = "Healthy" ] && [ "$(app_field "$name" sync.status)" = "Synced" ]
}

# A workload with its declared replicas ready, aborting on a pod the kubelet
# will never start.
deploy_ready() {
  local ns="$1" name="$2" waiting
  waiting="$(k -n "$ns" get pods -o jsonpath='{range .items[*].status.containerStatuses[*]}{.state.waiting.reason}{"\n"}{end}' 2>/dev/null || true)"
  if printf '%s' "$waiting" | grep -qE "^(${POD_TERMINAL})$"; then
    echo "✗ $ns/$name has a pod the kubelet cannot start: $(printf '%s' "$waiting" | grep -E "^(${POD_TERMINAL})$" | head -1)"
    exit 1
  fi
  local want got
  want="$(k -n "$ns" get deploy "$name" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
  got="$(k -n "$ns" get deploy "$name" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
  [ -n "$want" ] && [ "$want" = "$got" ]
}

rollout_ready() { [ "$(k -n argocd get "$1" "$2" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)" = "1" ]; }

api() { curl -sf --max-time 300 "http://localhost:$PORT$1"; }

START="$(date +%s)"

echo "→ (0/7) build behold + install the estate's own chant"
npm run build --silent
npm --prefix "$ESTATE" install --no-audit --no-fund --silent
echo "  chant: $(node -e "process.stdout.write(require('./$ESTATE/node_modules/@intentius/chant/package.json').version)")"

echo "→ scratch cluster $CLUSTER (isolated KUBECONFIG, default kubeconfig untouched)"
k3d cluster create "$CLUSTER" --wait --kubeconfig-update-default=false --kubeconfig-switch-context=false >/dev/null
CREATED=1
k3d kubeconfig get "$CLUSTER" >"$KUBECONFIG"
# The members declare `k3d-behold-argo-demo`; this run's cluster is uniquely
# named. Rename inside OUR kubeconfig so the declared binding resolves and a
# live read can still never reach an ambient cluster.
kubectl config rename-context "k3d-$CLUSTER" "$CONTEXT" >/dev/null

echo "→ Argo CD ${ARGO_VERSION} (core-install: the reconciler, no API server, no UI, no CLI)"
# core-install.yaml declares no Namespace of its own.
k create namespace argocd >/dev/null
k apply -n argocd -f "$ARGO_MANIFEST" >/dev/null
wait_for "argocd-repo-server" 300 rollout_ready deploy argocd-repo-server
wait_for "argocd-application-controller" 300 rollout_ready statefulset argocd-application-controller

echo "→ control plane: built by its own chant, applied once"
(cd "$ESTATE/control-plane" && npx chant build src -o dist/control-plane.yaml --format yaml >/dev/null)
k apply -f "$ESTATE/control-plane/dist/control-plane.yaml" >/dev/null

echo "→ the application controller deploys both apps from the repo"
wait_for "application/app-a Healthy+Synced" 300 app_ready app-a
wait_for "application/app-b Healthy+Synced" 300 app_ready app-b
wait_for "deploy app-a/app-a" 180 deploy_ready app-a app-a
wait_for "deploy app-b/app-b" 180 deploy_ready app-b app-b
echo "  ✓ Argo deployed both apps"

echo "→ serve the estate on :$PORT (control-plane app-a app-b, env=local)"
node ./bin/behold.js serve "$ESTATE/control-plane" "$ESTATE/app-a" "$ESTATE/app-b" \
  --env local --port "$PORT" >"$TMP/serve.log" 2>&1 &
SRV=$!
up() { curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1; }
wait_for "behold" 90 up || { sed -n '1,40p' "$TMP/serve.log"; exit 1; }

echo "→ (1/7) estate composition — project + delivers edges, and none for the sync waves"
api "/api/graph?detail=3" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const j = JSON.parse(d);
    if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
    if (j.meta.estate !== 3) { console.error("✗ estate composed", j.meta.estate, "projects, expected 3"); process.exit(1); }
    const has = (from, to, via) => j.ir.edges.some((e) => e.from === from && e.to === to && e.viaAttr === via);
    const want = [
      ["control-plane/appA", "control-plane/project", "project"],
      ["control-plane/appB", "control-plane/project", "project"],
      // #329, the Argo half of the edge #166 measured missing. The verb comes
      // from the controller: Flux `reconciles` a Kustomization path, Argo
      // `delivers` an Application source path — one derivation, two words,
      // because the two reconcilers do not do the same thing to a directory.
      ["control-plane/appA", "app-a/service", "delivers"],
      ["control-plane/appB", "app-b/service", "delivers"],
      // The crossing lands on the member ENTRY node; these carry the interior.
      ["app-a/service", "app-a/deployment", "selector"],
      ["app-b/service", "app-b/deployment", "selector"],
    ];
    for (const [f, t, v] of want) {
      if (!has(f, t, v)) { console.error("✗ missing", v, "edge", f, "->", t); process.exit(1); }
      console.log(`  ✓ ${f} -${v}-> ${t}`);
    }
    // Those six and nothing else: the sync-wave annotations that order this
    // estate are not references, so there is no edge to draw (the Flux
    // contrast, #223). One crossing per member boundary, never one per card.
    if (j.ir.edges.length !== 6) {
      console.error("✗", j.ir.edges.length, "edges — expected 6:", j.ir.edges.map((e) => `${e.from}-${e.viaAttr}->${e.to}`).join(", "));
      process.exit(1);
    }
    for (const owner of ["control-plane/appA", "control-plane/appB"]) {
      const crossings = j.ir.edges.filter((e) => e.from === owner && e.viaAttr === "delivers");
      if (crossings.length !== 1) {
        console.error("✗", owner, "draws", crossings.length, "delivers edges —", crossings.map((e) => e.to).join(", "));
        process.exit(1);
      }
      if (!crossings[0].inferred) { console.error("✗", owner, "delivers edge is not tagged inferred"); process.exit(1); }
    }
    console.log("  ✓ 6 edges total — the sync-wave ordering draws none, and each member is crossed once");
  });
'

echo "→ (2/7) the detail cliff the estate opens on (#322/#326)"
# Every join that draws an edge here reads full attrs, so at chant's default
# detail the composed estate is genuinely edgeless — and the note used to assert
# the wrong reason for it ("nothing in this estate references anything else"),
# which is false of an estate that has 6 edges one tier up. #326 made the
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
    const crossings = j.ir.edges.filter((e) => e.viaAttr === "delivers");
    if (crossings.length !== 2) {
      console.error("✗", crossings.length, "delivers edges on the live overlay — expected 2:", j.ir.edges.map((e) => `${e.from}-${e.viaAttr}->${e.to}`).join(", "));
      process.exit(1);
    }
    if (/no edges/.test(j.meta.note ?? "")) { console.error("✗ detail 3 still claims no edges:", j.meta.note); process.exit(1); }
    console.log(`  ✓ detail 3: ${crossings.map((e) => `${e.from} -delivers-> ${e.to}`).join(", ")}, no edgeless claim`);
  });
'

echo "→ (3/7) the logical lens on the estate (#241) — destination namespaces, live"
api "/api/overlay?logical=1&env=local" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const j = JSON.parse(d);
    if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
    if (j.meta.mode !== "logical") { console.error("✗ mode", j.meta.mode, "— the lens did not apply"); process.exit(1); }
    const bc = j.byContainer ?? {};
    const holds = (box, id) => (bc[box] ?? []).includes(id);
    for (const box of ["namespace argocd", "namespace app-a", "namespace app-b"]) {
      if (!bc[box]) { console.error("✗ no", JSON.stringify(box), "box —", Object.keys(bc).join(", ")); process.exit(1); }
    }
    for (const app of ["app-a", "app-b"]) {
      for (const id of [`${app}/deployment`, `${app}/service`]) {
        if (!holds(`namespace ${app}`, id)) { console.error("✗", id, "is not inside the namespace its Application names as destination"); process.exit(1); }
      }
    }
    for (const id of ["control-plane/appA", "control-plane/appB", "control-plane/project"]) {
      if (!holds("namespace argocd", id)) { console.error("✗", id, "is not inside namespace argocd"); process.exit(1); }
    }
    // Those namespace boxes are drawn from each Application spec.destination
    // alone: Argo makes the namespaces (CreateNamespace=true), so the estate
    // declares no Namespace object anywhere (#224, the flux-estate contrast).
    if (j.ir.nodes.some((n) => n.kind === "K8s::Core::Namespace")) {
      console.error("✗ the estate declares a Namespace — the destination harvest is not what drew these boxes"); process.exit(1);
    }
    // Live colours survive the projection. Unlike flux-estate every object here
    // declares its own namespace, so nothing is stranded and there is no
    // namespace-mismatch note (#192) to write.
    const st = Object.fromEntries(j.ir.nodes.map((n) => [n.id, n.attrs && n.attrs._status]));
    for (const id of Object.keys(st)) {
      if (st[id] !== "good") { console.error("✗", id, "reads", st[id], "— expected good on a converged estate"); process.exit(1); }
    }
    if (j.meta.note) { console.error("✗ unexpected overlay note:", j.meta.note); process.exit(1); }
    console.log("  ✓ boxes:", Object.keys(bc).join(" / "));
    console.log("  ✓ every card good, no Namespace declared, no mismatch note");
  });
'

echo "→ (4/7) the runtime tier on the estate (#241) — Argo instance-label attribution"
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
      if (!kids.length) { console.error("✗ nothing attributed to", owner, "— Argo tracking label unread"); process.exit(1); }
      for (const kid of kids) {
        if (byId[kid].attrs._status !== "runtime") { console.error("✗", kid, "is not painted runtime"); process.exit(1); }
      }
      // chant#1643 (fixed in 0.44.8): the sweep keys carry the kind, so the
      // same-named Deployment/Service/Endpoints no longer collide into one row
      // and the box must hold the WORKLOAD — before the fix, whichever kind
      // swept first (usually Endpoints) was the only survivor.
      if (!kids.some((k) => byId[k].kind === "K8s::Apps::Deployment")) {
        console.error("✗ no Deployment inside", owner, "(chant#1643) — kinds:", kids.map((k) => byId[k].kind).join(", ")); process.exit(1);
      }
      console.log(`  ✓ ${owner} ⊃ ${kids.map((k) => `${byId[k].kind.replace(/^K8s::/, "")} ${k}`).join(", ")}`);
    }
  });
'

echo "→ (5/7) health verdicts read off the Application health/sync pair (#238)"
api "/api/diff?env=local" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const j = JSON.parse(d);
    if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
    for (const id of ["appA", "appB"]) {
      const n = j.nodes[id];
      if (!n) { console.error("✗ no", id, "in the diff"); process.exit(1); }
      if (n.health !== "healthy" || n.healthDetail !== "health=Healthy, sync=Synced") {
        console.error("✗", id, "read", n.health, JSON.stringify(n.healthDetail), "— expected healthy from the Healthy/Synced pair"); process.exit(1);
      }
      console.log(`  ✓ ${id}: ${n.health} (${n.healthDetail})`);
    }
    // The kind-aware layer is a layer, not a replacement: an AppProject reports
    // neither health nor sync, so it takes the regex, which has nothing to add
    // beyond the status word.
    const p = j.nodes.project;
    if (!p || p.healthDetail !== undefined) {
      console.error("✗ project carries a condition detail —", JSON.stringify(p && p.healthDetail), "— the fallback should be untouched"); process.exit(1);
    }
    console.log(`  ✓ project: ${p.health}, no detail (regex fallback, unchanged)`);
  });
'

echo "→ (6/7) the unhappy arm — the app-b Application pointed at a missing path"
k -n argocd patch application app-b --type merge \
  -p '{"spec":{"source":{"path":"example-argo-estate/app-b/behold-e2e-does-not-exist"}}}' >/dev/null
comparison_error() { printf '%s' "$(app_conditions app-b)" | grep -q '^ComparisonError:'; }
wait_for "Argo to write ComparisonError on app-b" 180 comparison_error
echo "  argo says: $(app_conditions app-b | head -1)"
echo "  argo says: health=$(app_field app-b health.status) sync=$(app_field app-b sync.status)"
verdict() { api "/api/diff?env=local" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const n = (JSON.parse(d).nodes ?? {}).appB ?? {};
    const drift = ((n.fieldDrift ?? {}).drifted ?? []).map((f) => f.path).join(",");
    process.stdout.write(`${n.health ?? "?"}|${n.healthDetail ?? ""}|${drift}`);
  });
'; }
# Argo will not prune what it cannot compute, so the WORKLOAD stays Healthy and
# the unhappy half is the sync: `Unknown`, which is the rung behold paints when
# the controller has stopped being able to compare live against source. #275:
# the detail names BOTH halves it read (`health=Healthy, sync=Unknown`), not
# just the one chant's collapsed word happens to carry.
#
# It ALSO carries Argo's own ComparisonError message ("app path does not
# exist"). Argo's `ApplicationCondition` has no `status` field at all, and
# chant's `unhappyConditions()` used to require one and dropped it — fixed in
# chant 0.44.8 (chant#1644), so the one diagnostic line the controller writes
# now reaches behold and `classifyObservedHealth` joins it onto the pair
# (src/health.test.ts). This assertion was the absence-proof until then.
unknown() { verdict | grep -q '^unknown|health=Healthy, sync=Unknown'; }
wait_for "appB to read unknown" 180 unknown
echo "  ✓ appB: $(verdict | tr '|' ' ')"
verdict | grep -q 'app path does not exist' || { echo "✗ healthDetail does not join Argo's ComparisonError message (chant#1644): $(verdict)"; exit 1; }
echo "  ✓ healthDetail joins the ComparisonError message — the one line Argo writes"
verdict | grep -q 'spec.source.path$' || { echo "✗ the drift does not name spec.source.path: $(verdict)"; exit 1; }
echo "  ✓ the field drift names spec.source.path — declared vs the broken live value"

echo "→ (7/7) the queried line (#192) — where the failed live read looked"
# With the comparison broken Argo cannot regenerate the target state, so selfHeal
# cannot put back what is deleted: a genuinely absent object, on purpose.
k -n app-b delete deploy app-b --wait=true >/dev/null
# /api/diff slices the PRIMARY project, and the primary here is the control
# plane (whose objects all resolve). app-b is served on its own to read its
# addresses.
node ./bin/behold.js serve "$ESTATE/app-b" --env local --port "$PORT_B" >"$TMP/serve-b.log" 2>&1 &
SRV_B=$!
up_b() { curl -sf "http://localhost:$PORT_B/healthz" >/dev/null 2>&1; }
wait_for "behold (app-b)" 90 up_b || { sed -n '1,40p' "$TMP/serve-b.log"; exit 1; }
curl -sf --max-time 300 "http://localhost:$PORT_B/api/diff?env=local" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const j = JSON.parse(d);
    if (j.error) { console.error("✗ api error:", j.error); process.exit(1); }
    const n = j.nodes.deployment;
    if (!n || !n.diff) { console.error("✗ no diff for deployment"); process.exit(1); }
    if (n.diff.category !== "missing") { console.error("✗ deployment is", n.diff.category, "— expected missing"); process.exit(1); }
    const q = n.diff.queried;
    if (!q) { console.error("✗ deployment carries no queried address — the diagnosis line is gone"); process.exit(1); }
    // The app declares its own namespace, so the read went to it. flux-estate
    // reads `default` at this exact line — the whole point of the contrast.
    if (!/\/namespaces\/app-b\//.test(q)) {
      console.error("✗ deployment queried", q, "— expected the namespace the app declares"); process.exit(1);
    }
    // The Service was never deleted: only the object that is actually gone
    // reads missing.
    if (j.nodes.service.diff.category === "missing") { console.error("✗ the service reads missing too — the read is not addressing what it claims"); process.exit(1); }
    console.log(`  ✓ deployment: missing, queried ${q}`);
    console.log(`  ✓ service: ${j.nodes.service.diff.category} — untouched`);
  });
'

echo "  restoring the declared path"
k -n argocd patch application app-b --type merge \
  -p '{"spec":{"source":{"path":"example-argo-estate/app-b/manifests"}}}' >/dev/null
healthy() { [ "$(verdict)" = "healthy|health=Healthy, sync=Synced|" ]; }
wait_for "appB back to healthy" 300 healthy
wait_for "deploy app-b/app-b restored by selfHeal" 180 deploy_ready app-b app-b
echo "  ✓ appB: healthy (health=Healthy, sync=Synced), Deployment back — selfHeal, and the verdict follows both ways"

echo "✓ argo-estate acceptance passed in $(( $(date +%s) - START ))s"
