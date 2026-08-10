import type { ChantConfig } from "@intentius/chant";
import type { K8sChantConfig } from "@intentius/chant-lexicon-k8s";

// The estate's control plane: it declares the Argo machinery (an AppProject +
// one Application per app), and Argo's application controller deploys the app
// projects — this project never applies a workload itself.
//
// `npx @intentius/behold demo argo-estate` still needs no cluster: it serves
// the source graph with no `--env`, and nothing below is read on that path.
// The `local` profile exists for the live lane (behold#269,
// `just e2e-argo-estate`), which stands up a scratch k3d cluster and aliases
// its context to the name pinned here — so a live read resolves the DECLARED
// binding and can never observe whatever kubectl context happens to be
// ambient (chant#1100).
//
// Deliberately no `ownership.env`: the app members' committed manifests/ are
// what Argo syncs from `main`, so a label that changes their build output
// would have to be merged before any live run could agree with the cluster.
export default {
  lexicons: ["k8s"],
  sourceDir: "src",
  environments: ["local"],
  ownership: { stack: "argo-control-plane" },
  k8s: {
    profiles: {
      local: { context: "k3d-behold-argo-demo" },
    },
  } satisfies K8sChantConfig,
} satisfies ChantConfig;
