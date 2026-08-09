import type { ChantConfig } from "@intentius/chant";
import type { K8sChantConfig } from "@intentius/chant-lexicon-k8s";

// App project A. Deployed by the control plane's Flux Kustomization, never by
// this project — its committed manifests/ (chant build output) are what Flux
// syncs from the repo. behold serves it as part of the estate; the live
// overlay reads the cluster through the same binding as every other member.
export default {
  lexicons: ["k8s"],
  sourceDir: "src",
  environments: ["local"],
  ownership: { stack: "app-a", env: "local" },
  k8s: {
    profiles: {
      local: { context: "k3d-behold-flux-demo" },
    },
  } satisfies K8sChantConfig,
} satisfies ChantConfig;
