// App B: the same workload in namespace app-b, the estate's second sync wave.
// Two apps rather than one so the AppProject has more than a single Application
// hanging off it — the fan-out is what an app-of-apps picture is for.
import { Deployment, Service } from "@intentius/chant-lexicon-k8s";

const labels = { app: "app-b" };
const image = "nginxinc/nginx-unprivileged:1.27-alpine";

export const deployment = new Deployment({
  metadata: { name: "app-b", namespace: "app-b", labels },
  spec: {
    replicas: 2,
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        containers: [
          {
            name: "web",
            image,
            ports: [{ containerPort: 8080 }],
            securityContext: { runAsNonRoot: true, runAsUser: 101, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
            resources: { requests: { cpu: "25m", memory: "32Mi" }, limits: { cpu: "100m", memory: "64Mi" } },
          },
        ],
      },
    },
  },
});

export const service = new Service({
  metadata: { name: "app-b", namespace: "app-b" },
  spec: { selector: labels, ports: [{ port: 80, targetPort: 8080 }] },
});
