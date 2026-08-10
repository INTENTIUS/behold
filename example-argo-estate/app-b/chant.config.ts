import type { ChantConfig } from "@intentius/chant";

// App project B — same shape as app-a, second sync wave. Declared-only demo,
// so no kube context is bound; see ../control-plane/chant.config.ts.
export default {
  lexicons: ["k8s"],
  sourceDir: "src",
  ownership: { stack: "argo-app-b" },
} satisfies ChantConfig;
