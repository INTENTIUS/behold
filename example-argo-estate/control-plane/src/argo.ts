// The control plane, Argo-style: one AppProject that fences what the estate is
// allowed to deploy, and one Application per app project, each syncing that
// app's committed manifests from this repo. Argo's application controller does
// the applying — this project never applies a workload itself.
//
// Written with the raw declarables rather than the ArgoAppFor composite on
// purpose: the two fields the whole demo is about, `spec.project` and
// `spec.destination.namespace`, are the ones a stranger reading Argo YAML
// already knows by sight, and here they sit in the source verbatim. (For real
// estates the composite is fewer lines: ArgoAppFor("app-a", { repo, path,
// project, destination }) renders this same Application.)
import { AppProject, Application } from "@intentius/chant-lexicon-k8s";

const REPO = "https://github.com/INTENTIUS/behold";
// The in-cluster target every Argo install has. Naming it (rather than a
// registered cluster Secret) is what keeps this estate a one-cluster story.
const IN_CLUSTER = "https://kubernetes.default.svc";

// The fence: which repo the apps may sync from, and which namespaces Argo may
// own objects in. Both Applications name it in spec.project — the join behold
// draws (behold#222) and chant lints as ARGO002.
export const project = new AppProject({
  metadata: { name: "estate", namespace: "argocd" },
  spec: {
    description: "behold's demo estate: two app projects, one cluster.",
    sourceRepos: [REPO],
    destinations: [
      { server: IN_CLUSTER, namespace: "app-a" },
      { server: IN_CLUSTER, namespace: "app-b" },
    ],
    // CreateNamespace=true below means Argo creates the destination namespaces,
    // so the project has to permit that one cluster-scoped kind.
    clusterResourceWhitelist: [{ group: "", kind: "Namespace" }],
  },
});

export const appA = new Application({
  metadata: {
    name: "app-a",
    namespace: "argocd",
    // Argo's ordering idiom is a wave annotation, not a reference — so unlike
    // Flux's dependsOn (behold#223) there is no edge to draw for it. app-a
    // syncs first; app-b follows.
    annotations: { "argocd.argoproj.io/sync-wave": "0" },
  },
  spec: {
    project: "estate",
    source: { repoURL: REPO, targetRevision: "main", path: "example-argo-estate/app-a/manifests" },
    // The namespace Argo will own objects in. app-a's own objects declare it
    // too, so the box behold draws holds the app's cards; declaring it here is
    // what makes the box a fact about the CONTROL PLANE's graph as well.
    destination: { server: IN_CLUSTER, namespace: "app-a" },
    syncPolicy: { automated: { prune: true, selfHeal: true }, syncOptions: ["CreateNamespace=true"] },
  },
});

export const appB = new Application({
  metadata: {
    name: "app-b",
    namespace: "argocd",
    annotations: { "argocd.argoproj.io/sync-wave": "1" },
  },
  spec: {
    project: "estate",
    source: { repoURL: REPO, targetRevision: "main", path: "example-argo-estate/app-b/manifests" },
    destination: { server: IN_CLUSTER, namespace: "app-b" },
    syncPolicy: { automated: { prune: true, selfHeal: true }, syncOptions: ["CreateNamespace=true"] },
  },
});
