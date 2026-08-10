import type { ChantConfig } from "@intentius/chant";
import type { K8sChantConfig } from "@intentius/chant-lexicon-k8s";

// App project B — same shape as app-a, second sync wave. Unlike flux-estate's
// app-b this one declares its own namespace on every object (Argo has no
// targetNamespace to stamp one at apply time), so a live read resolves it
// straight away. See ../control-plane/chant.config.ts for the binding.
export default {
  lexicons: ["k8s"],
  sourceDir: "src",
  environments: ["local"],
  ownership: { stack: "argo-app-b" },
  k8s: {
    profiles: {
      local: { context: "k3d-behold-argo-demo" },
    },
  } satisfies K8sChantConfig,
} satisfies ChantConfig;
