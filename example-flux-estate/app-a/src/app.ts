// App A: one small web workload, namespace declared EXPLICITLY on every
// object. Contrast app-b, which leaves namespace to the control plane's
// targetNamespace — the two apps together show both halves of the Flux
// namespace story: behold#192's note when app-b is served alone, behold#221's
// estate join when the three projects are served composed.
import { Deployment, Service } from "@intentius/chant-lexicon-k8s";

const labels = { app: "app-a" };
const image = "nginxinc/nginx-unprivileged:1.27-alpine";

export const deployment = new Deployment({
  metadata: { name: "app-a", namespace: "app-a", labels },
  spec: {
    replicas: 1,
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
  metadata: { name: "app-a", namespace: "app-a" },
  spec: { selector: labels, ports: [{ port: 80, targetPort: 8080 }] },
});
