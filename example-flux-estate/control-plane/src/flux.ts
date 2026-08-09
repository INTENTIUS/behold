// The control plane, GitOps-style: Flux reconcilers deploy the app projects
// FROM THIS REPO. The GitRepository points at behold's own public repo; each
// Kustomization applies one app project's committed manifests into that app's
// namespace via targetNamespace — which is why app-b's objects declare no
// metadata.namespace (see ../../app-b/src/app.ts): Flux stamps it at apply
// time. That is the normal Flux estate shape, and exactly the shape behold's
// namespace-mismatch note (behold#192) exists to explain.
//
// scripts/estate-up.sh applies the BUILT form of this project (chant build →
// dist/control-plane.yaml) once, after installing Flux; from then on the
// reconcilers own the apps.
import { Namespace, GitRepository, Kustomization } from "@intentius/chant-lexicon-k8s";

// The app namespaces are control-plane concerns: a Kustomization's
// targetNamespace must already exist — Flux does not create it.
export const nsAppA = new Namespace({ metadata: { name: "app-a" } });
export const nsAppB = new Namespace({ metadata: { name: "app-b" } });

export const source = new GitRepository({
  metadata: { name: "behold", namespace: "flux-system" },
  spec: {
    interval: "1m",
    url: "https://github.com/INTENTIUS/behold",
    // main is where the committed manifests live once merged. Verifying a
    // not-yet-merged branch: estate-up.sh patches the LIVE object's ref when
    // BEHOLD_FLUX_REF is set — the declared source stays main.
    ref: { branch: "main" },
  },
});

export const appA = new Kustomization({
  metadata: { name: "app-a", namespace: "flux-system" },
  spec: {
    interval: "1m",
    prune: true,
    targetNamespace: "app-a",
    sourceRef: { kind: "GitRepository", name: "behold" },
    path: "./example-flux-estate/app-a/manifests",
  },
});

export const appB = new Kustomization({
  metadata: { name: "app-b", namespace: "flux-system" },
  spec: {
    interval: "1m",
    prune: true,
    targetNamespace: "app-b",
    sourceRef: { kind: "GitRepository", name: "behold" },
    path: "./example-flux-estate/app-b/manifests",
  },
});
