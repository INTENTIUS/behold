# The k3d turnkey demo — behold's Kubernetes counterpart to Loom-on-Floci

The smallest real thing on Kubernetes: one `nginx` Deployment + Service (+ a
PodDisruptionBudget), deployed from the browser with the **▶ Deploy
(k3d-apply)** header button, against a local, single-node
[k3d](https://k3d.io) cluster — no cloud account, no credentials.

```
src/config.ts         static config — app name, pinned image tag
src/web.ts            WebApp composite → Deployment + Service + PodDisruptionBudget
ops/k3d-apply.op.ts   ApplyOp "k3d-apply" — code → local k3d, server-side apply
base/                 a plain Deployment + Service, core kinds only
overlays/dev/         kustomize overlay over base/ — namePrefix "dev-" + a replica patch
chant.config.ts       lexicons [k8s, temporal], k8s.profiles.local bound to k3d-behold-k3d-demo,
                       k8s.kustomize.roots: ["overlays/dev"]
scripts/local/        local-up.sh / local-down.sh — the k3d cluster's own lifecycle
```

`overlays/dev` is a real kustomize build root (chant#1626, chant 0.44.3): chant
renders it (`kustomize build`, `kubectl kustomize` fallback) at build time and
joins the two rendered objects (`dev-echo` Deployment + Service) to the graph,
each stamped with a `chant.intentius.io/kustomize-root: overlays/dev`
annotation. behold's kustomize lens (behold#171/#217) reads that stamp and
boxes them as `overlay dev` in the graph — the same lens a hand-rolled
`kustomization.yaml` next to typed source triggers via its directory walk, but
here from chant's own provenance rather than file location. Kept to core/apps
kinds on purpose: chant#1628 still mistypes a Flux/Argo/cert-manager CR
rendered through a kustomize root.

## Run it

From the **behold** repo root:

```sh
npm run demo:k8s
#   → brings up a single-node k3d cluster ("behold-k3d-demo"),
#     then serves this project at http://localhost:4600
```

That one command does two things: `scripts/local/local-up.sh` creates the
cluster (idempotent — reuses one already up), then `behold serve --local`
points its live overlay at it. `--local`'s usual boot step (`chant emulator
up`) is a no-op here — chant's k8s lexicon has no local-emulator capability
the way Floci does for aws — so the cluster comes up via the same generic
substrate **Bring up** mechanism the Floci demo's `scripts/local/local-up.sh`
convention already uses (see `src/substrates.ts`), just run up front instead
of from a click. Ctrl-C stops `behold serve` and tears the cluster back down;
Docker or k3d missing degrades to the source graph with a clear message
instead of crashing.

1. Open **http://localhost:4600**. The graph shows the Deployment, Service and
   PodDisruptionBudget — **blue** (declared, not yet deployed).
2. Click **▶ Deploy (k3d-apply)** in the header (or ⌘K → "Deploy: Sync"). The
   now-line streams Build → Plan (a live
   diff) → Apply: a Kubernetes **server-side apply**, field manager
   `chant:behold-k3d-demo` (chant#1074/#1075) — deletes are **owned-only**, a
   marker-scoped prune that only ever touches what chant itself applied.
3. The three nodes flip **blue → green (managed)**. Zoom in on the Deployment
   and its two Pods appear **nested underneath it** — the runtime tier
   (chant#1077/behold#86): live children a Deployment's controller created,
   never declared here, never classified as drift or an orphan.

## The four things this proves live (epic #84)

behold's k8s parity (#85–#87) shipped against fixtures; this is it against a
real cluster.

**Declared, not yet deployed.** Before step 2, `/api/overlay` reports all
three nodes `_status: accent` (pending) — chant knows about them, the cluster
doesn't yet.

**Runtime children.** After apply, `/api/overlay`'s `ir.groups.byContainer`
nests the Deployment's Pods under it, each `_status: runtime` — a tier below
what's declared, sourced from the cluster's own `ownerReferences`, that
behold's zoom dial can descend into.

**Managed-fields drift.** Scale or label the Deployment out of band —
`kubectl scale deployment/web --replicas=3`, bypassing chant entirely — and
`/api/diff`'s `fieldDrift` reports `spec.replicas: { kind: "changed", declared:
2, live: 3 }`: chant's own SSA-tracked field, now diverged from a competing
field manager (`kubectl`, visible in `kubectl get deploy/web -o json`'s
`metadata.managedFields`). Re-running `k3d-apply` at that point doesn't
silently overwrite it: chant's server-side apply refuses —

```
k8s: server-side apply of apps/v1 Deployment web was refused — 1 field is owned by another field manager.

  "kubectl" owns:
    .spec.replicas

chant applied as field manager "chant:behold-k3d-demo". Taking these fields means the managers above
stop owning them, and will contest them again on their next apply.
```

— naming the contested path and the competing manager, and leaving the field
alone rather than force-resolving it. (One honest gap found running this
live: a **new** out-of-band key with no chant-declared counterpart at all —
`kubectl label deployment/web team=platform`, which has no corresponding
`web.spec` field in `src/web.ts` — doesn't currently surface in `fieldDrift`,
only a value change to a field chant *does* declare does. Worth a follow-up
issue on the chant side; noted here rather than papered over.)

**Unobserved.** `chant.config.ts` binds environment `local` to kubectl context
`k3d-behold-k3d-demo` (chant#1100) — every read/apply checks that binding
against whatever context is actually ambient, and refuses rather than reading
the wrong cluster. Switch away from it for a moment —

```sh
kubectl config use-context <anything-else>
```

— and `/api/overlay` flips every node to `_status: neutral` with
`unobservedReason: "read-failed"`, Pods and all: an honest "did not look",
never a false "these are all gone." Switch back
(`kubectl config use-context k3d-behold-k3d-demo`) and the next refresh
recovers cleanly.

## Cleanup

`Ctrl-C` on `npm run demo:k8s` runs `scripts/local/local-down.sh`
automatically: deletes the `behold-k3d-demo` cluster and restores whatever
kubectl context was current before `local-up.sh` ran. Safe to run by hand too:

```sh
bash scripts/local/local-down.sh
```

## Note for chant#1179

This Op's `delete: "owned-only"` exercises the same typed, marker-scoped
prune path chant#1179 wants a live k3d E2E for. This demo isn't that test —
it's a manual walkthrough, not an automated assertion of "exactly the orphan
and nothing else was deleted" — but it does confirm the path runs against a
real cluster, not just `fakeCluster`.
