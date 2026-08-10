import type { ChantConfig } from "@intentius/chant";
import type { K8sChantConfig } from "@intentius/chant-lexicon-k8s";

// App project A. Argo syncs its committed manifests/ (chant build output) from
// the repo; this project applies nothing itself. behold serves it as part of
// the estate, and the live overlay reads the cluster through the same binding
// as every other member — see ../control-plane/chant.config.ts.
export default {
  lexicons: ["k8s"],
  sourceDir: "src",
  environments: ["local"],
  ownership: { stack: "argo-app-a" },
  k8s: {
    profiles: {
      local: { context: "k3d-behold-argo-demo" },
    },
  } satisfies K8sChantConfig,
} satisfies ChantConfig;
