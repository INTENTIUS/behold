import type { ChantConfig } from "@intentius/chant";
import type { K8sChantConfig } from "@intentius/chant-lexicon-k8s";

// Bound to the demo's own cluster (scripts/local/local-up.sh creates it, k3d
// names the context "k3d-behold-k3d-demo") rather than whatever kubectl
// context happens to be ambient — chant#1100. A declared binding is checked
// against the ambient context on every live read/apply; a mismatch refuses
// loudly instead of silently reading the wrong cluster. The walkthrough's
// "unobserved" step (README.md) is exactly that refusal, produced on purpose
// by switching away from this context for a moment.
export default {
  lexicons: ["k8s", "temporal"],
  sourceDir: "src",
  environments: ["local"],
  ownership: { stack: "behold-k3d-demo", env: "local" },
  k8s: {
    profiles: {
      local: { context: "k3d-behold-k3d-demo" },
    },
  } satisfies K8sChantConfig,
} satisfies ChantConfig;
