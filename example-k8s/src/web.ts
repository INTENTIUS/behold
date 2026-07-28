// The whole "infra": one small web app. `WebApp` is a composite — a typed call
// that expands to a Deployment, a Service, and a PodDisruptionBudget — deployed
// via `ops/k3d-apply.op.ts` to a local k3d cluster (scripts/local/local-up.sh),
// no cloud account. The Deployment's replicas are the runtime tier's example:
// its Pods aren't declared here, but a live cluster owns them.
import { WebApp } from "@intentius/chant-lexicon-k8s";
import { appName, image } from "./config";

const web = WebApp({
  name: appName,
  image,
  port: 8080,
  replicas: 2,
  minAvailable: 1,
  cpuRequest: "50m",
  memoryRequest: "64Mi",
  cpuLimit: "200m",
  memoryLimit: "128Mi",
  securityContext: {
    runAsNonRoot: true,
    runAsUser: 101,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
  },
});

export const deployment = web.deployment;
export const service = web.service;
export const pdb = web.pdb!;
