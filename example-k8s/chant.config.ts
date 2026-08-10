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
    // chant#1626 (chant 0.44.3, behold#225): a real kustomize build root —
    // `overlays/dev` layers a namePrefix and a replica patch onto `base/`.
    // Rendered at build time and stamped with the
    // `chant.intentius.io/kustomize-root` provenance annotation, which
    // behold's kustomize lens (src/logical-kustomize.ts, #217) prefers over
    // its directory-walk heuristic — the `overlay dev` box in the demo graph
    // comes from this, not source-file location. Core/apps kinds only inside
    // the root: chant#1628 still mistypes Flux/Argo/cert-manager CRs
    // rendered through a kustomize build.
    kustomize: { roots: ["overlays/dev"] },
  } satisfies K8sChantConfig,
} satisfies ChantConfig;
