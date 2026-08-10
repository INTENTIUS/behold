import type { ChantConfig } from "@intentius/chant";

// The estate's control plane: it declares the Argo machinery (an AppProject +
// one Application per app), and Argo's controller deploys the app projects —
// this project never applies a workload itself.
//
// No k8s profile block, unlike the flux-estate demo's: argo-estate is the
// DECLARED story only. Nothing here binds a kube context because nothing here
// reads one — `behold demo argo-estate` needs no cluster and installs no Argo.
export default {
  lexicons: ["k8s"],
  sourceDir: "src",
  ownership: { stack: "argo-control-plane" },
} satisfies ChantConfig;
