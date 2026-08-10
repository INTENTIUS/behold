import type { ChantConfig } from "@intentius/chant";
import type { K8sChantConfig } from "@intentius/chant-lexicon-k8s";

// App project B — the targetNamespace half of the estate: its objects declare
// no metadata.namespace (see src/app.ts), so the control plane's
// Kustomization stamps `app-b` at apply time. That is idiomatic Flux, AND it
// means a live read of THIS PROJECT ALONE scopes to `default` and finds
// nothing — behold's namespace-mismatch note (behold#192) names exactly this,
// on purpose, in this demo. Composed with the control plane, behold joins the
// binding and reads `app-b` instead (behold#221).
export default {
  lexicons: ["k8s"],
  sourceDir: "src",
  environments: ["local"],
  ownership: { stack: "app-b", env: "local" },
  k8s: {
    profiles: {
      local: { context: "k3d-behold-flux-demo" },
    },
  } satisfies K8sChantConfig,
} satisfies ChantConfig;
