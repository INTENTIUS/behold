import type { ChantConfig } from "@intentius/chant";
import type { K8sChantConfig } from "@intentius/chant-lexicon-k8s";

// The estate's control plane: it declares the Flux machinery (GitRepository +
// one Kustomization per app), and the reconcilers deploy the app projects —
// this project never applies a workload itself. Bound to the demo's own
// cluster (scripts/estate-up.sh creates it) so a live read can never observe
// whatever kubectl context happens to be ambient (chant#1100).
export default {
  lexicons: ["k8s"],
  sourceDir: "src",
  environments: ["local"],
  ownership: { stack: "flux-control-plane", env: "local" },
  k8s: {
    profiles: {
      local: { context: "k3d-behold-flux-demo" },
    },
  } satisfies K8sChantConfig,
} satisfies ChantConfig;
