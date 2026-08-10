// App B: same small workload as app-a, with NO metadata.namespace anywhere —
// the control plane's Kustomization stamps targetNamespace: app-b at apply
// time. Idiomatic Flux (that's what the field is for), and the deliberate
// exhibit of behold's estate namespace join (behold#221): served ALONE this
// project's live read scopes to `default`, finds nothing, and behold explains
// the all-pending paint with its namespace-mismatch note (behold#192) rather
// than letting it read as "not deployed". Served COMPOSED, the estate reads
// the binding off ../../control-plane and scopes the read to `app-b`.
import { Deployment, Service } from "@intentius/chant-lexicon-k8s";

const labels = { app: "app-b" };
const image = "nginxinc/nginx-unprivileged:1.27-alpine";

export const deployment = new Deployment({
  metadata: { name: "app-b", labels },
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
  metadata: { name: "app-b" },
  spec: { selector: labels, ports: [{ port: 80, targetPort: 8080 }] },
});
