# flux-estate — behold's GitOps estate demo (#211)

Three chant projects served as one composed estate:

- **control-plane/** — the Flux machinery: a `GitRepository` pointing at
  behold's own public repo and one `Kustomization` per app, app-b's gated on
  app-a's with `dependsOn` (behold#223). The reconcilers deploy the apps; this
  project never applies a workload itself.
- **app-a/** — a small web workload with explicit `metadata.namespace` on
  every object: the fully-resolved half.
- **app-b/** — the same workload with **no** namespace anywhere: the control
  plane's `targetNamespace` stamps it at apply time. Idiomatic Flux, and the
  deliberate exhibit of the estate namespace join (behold#221). Served alone,
  app-b's live read scopes to `default`, finds nothing, and behold explains
  the all-pending paint with the namespace-mismatch note (behold#192) instead
  of letting it read as "not deployed". Served composed, the estate reads the
  binding off the control plane's own `Kustomization` and scopes app-b's read
  to `app-b` — the answer neither project holds by itself.

```sh
npx @intentius/behold demo flux-estate
```

That stands up a throwaway k3d cluster (`behold-flux-demo`), installs Flux's
controllers straight from the pinned release manifest (no `flux` CLI needed),
applies the control plane, waits for the reconcilers to deploy both apps from
this repo, and serves the three projects composed. What to look at:

- The **estate**: per-project boundary boxes, the `sourceRef` edges wiring
  Kustomization → GitRepository across stacks, and the `dependsOn` edge from
  app-b's Kustomization to app-a's — the estate's reconcile ordering.
- The **overlay** (env `local`): app-a green, the control plane's CRs green,
  and app-b green too — read in the namespace the control plane binds it to,
  with a note naming where it looked. Serve `app-b` on its own to see the
  same objects go pending, which is what the join is worth.
- The **runtime tier** (zoom: runtime), on the estate itself since behold#224:
  the workloads Flux deployed, attributed back to the declaring Kustomization
  via its labels (chant#1549) and boxed under it.
- The **logical lens** (zoom: logical): cluster ⊃ namespace boxes, with each
  app's objects inside the namespace the control plane declared for them —
  the view that only exists once the three projects are composed, since the
  namespaces are declared in one project and filled from the others.

The app `manifests/` are committed `chant build` output — Flux syncs them
from GitHub `main`, so changes to an app's source need a rebuild
(`npm run build` in the app) and a merge before the cluster follows. To
verify an unmerged branch: `BEHOLD_FLUX_REF=<branch> bash scripts/estate-up.sh`
patches the live `GitRepository` (the declared source stays `main`).

`bash scripts/estate-down.sh` deletes the cluster and restores your previous
kubectl context.
