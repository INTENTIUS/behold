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

Unlike flux-estate this one is **declared only** — no cluster, no Argo install,
no Docker. It copies out, `npm install`s, and serves. What to look at:

- The **estate**: per-project boundary boxes, and the `project` edges joining
  both Applications to the AppProject they name (behold#222) — the join chant
  lints as ARGO002, so an estate whose lint passes cannot be drawn wrong.
  The entity graph carries them at the attributes tier (`?detail=3`).
- The **logical lens** on the control plane alone
  (`behold serve control-plane`, zoom: logical): `namespace app-a` and
  `namespace app-b` drawn as boxes even though the control plane declares no
  `Namespace` object anywhere. They come from each Application's
  `spec.destination.namespace` — a namespace Argo will own objects in is a
  namespace the estate is committed to. Serve all three members and the apps'
  Deployments and Services sit inside those boxes.

That last one is the Argo/Flux difference worth noticing: flux-estate's control
plane must declare the app namespaces itself (a Kustomization's
`targetNamespace` must already exist), while here `CreateNamespace=true` means
Argo makes them — so the box exists on the strength of the destination alone.

Argo's ordering is the `argocd.argoproj.io/sync-wave` annotation, so unlike
Flux's `dependsOn` (behold#223) there is no edge to draw for it: app-a is wave
0, app-b wave 1, and the picture says nothing about it.

The app `manifests/` are committed `chant build` output — the path each
Application syncs. Changing an app's source means a rebuild (`npm run build` in
the app). `chant build` in the control plane warns ARGO005 on both
Applications: `source.path` is repo-relative (that's what Argo resolves it
against), not relative to the build root, so it doesn't resolve locally. Fine
here, and the check's own message says so.
