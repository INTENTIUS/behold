import type { ChantConfig } from "@intentius/chant";

// App project A. Argo syncs its committed manifests/ (chant build output) from
// the repo; this project applies nothing itself. Declared-only demo, so no
// kube context is bound — see ../control-plane/chant.config.ts.
export default {
  lexicons: ["k8s"],
  sourceDir: "src",
  ownership: { stack: "argo-app-a" },
} satisfies ChantConfig;
