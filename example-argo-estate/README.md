# argo-estate — behold's Argo CD estate demo (#235)

Three chant projects served as one composed estate, the Argo mirror of
[example-flux-estate](../example-flux-estate):

- **control-plane/** — the Argo machinery: an `AppProject` fencing which repo
  and which namespaces the estate may deploy, and one `Application` per app
  syncing that app's committed manifests from behold's own public repo. Argo's
  controller does the applying; this project never applies a workload itself.
- **app-a/**, **app-b/** — small web workloads in namespaces `app-a` and
  `app-b`, the namespaces the Applications name as their sync destinations.

```sh
npx @intentius/behold demo argo-estate
```

The demo path is **declared only** — no cluster, no Argo install, no Docker. It
copies out, `npm install`s, and serves. (There is a live lane, but it is an
acceptance run rather than part of the demo: see "Live" below.) What to look
at:

- The **estate**: per-project boundary boxes, and the `project` edges joining
  both Applications to the AppProject they name (behold#222) — the join chant
  lints as ARGO002, so an estate whose lint passes cannot be drawn wrong.
  The entity graph carries them at the attributes tier (`?detail=3`).
- The **logical lens** (zoom: logical): cluster ⊃ `namespace app-a` and
  `namespace app-b`, each holding that app's Deployment + Service, plus
  `namespace argocd` holding both Applications and the AppProject — drawn
  even though the control plane declares no `Namespace` object anywhere. The
  app namespaces come from each Application's `spec.destination.namespace`; a
  namespace Argo will own objects in is a namespace the estate is committed
  to, and behold#224 taught the composed estate to draw that projection.
  Serve `control-plane` alone (`behold serve control-plane`, zoom: logical)
  and the same boxes appear empty — the destination harvest still names them,
  but there is nothing from app-a/app-b in the graph to fill them with.

That alone-vs-composed split is the Argo/Flux difference worth noticing:
flux-estate's control plane must declare the app namespaces itself (a
Kustomization's `targetNamespace` must already exist), while here
`CreateNamespace=true` means Argo makes them — so the box exists on the
strength of the destination alone.

Argo's ordering is the `argocd.argoproj.io/sync-wave` annotation, so unlike
Flux's `dependsOn` (behold#223) there is no edge to draw for it: app-a is wave
0, app-b wave 1, and the picture says nothing about it.

The app `manifests/` are committed `chant build` output — the path each
Application syncs. Changing an app's source means a rebuild (`npm run build` in
the app), and the rebuilt manifests have to be on `main` before Argo can sync
them. `chant build` in the control plane warns ARGO005 on both Applications:
`source.path` is repo-relative (that's what Argo resolves it against), not
relative to the build root, so it doesn't resolve locally. Fine here, and the
check's own message says so.

## Live

Nothing above needs a cluster, but the estate as committed does reconcile
against a real one — the Applications point at this repo on `main` and the app
`manifests/` are already there, so an Argo CD install has everything it needs.
`just e2e-argo-estate` (behold#269) is that run: a scratch k3d cluster, Argo
from the pinned `core-install` manifest, the control plane applied once, and
then the composed estate served against the result — the destination-namespace
boxes filled with live cards, #238's health verdicts read off each
Application's health/sync pair, and the unhappy arm (an Application pointed at
a path that does not exist, then restored). It creates and deletes its own
cluster and touches no other context.

Each member's `chant.config.ts` therefore binds a `local` profile to the
context `k3d-behold-argo-demo`, which is what that run aliases its scratch
cluster to. Serving without `--env` — what `behold demo argo-estate` does —
reads none of it.
