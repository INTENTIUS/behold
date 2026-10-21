import { managedEnvironments, containerApps, output } from "@intentius/chant-lexicon-azure";

// The website on Azure Container Apps in West Europe: one environment and one
// app with external ingress.
export const env = new managedEnvironments({ name: "three-cloud", location: "westeurope" });

export const app = new containerApps({
  name: "web",
  location: "westeurope",
  managedEnvironmentId: env.id,
  configuration: { ingress: { external: true, targetPort: 80, transport: "auto" } },
  template: {
    containers: [{ name: "web", image: "traefik/whoami:v1.10", resources: { cpu: 0.25, memory: "0.5Gi" } }],
    scale: { minReplicas: 1, maxReplicas: 1 },
  },
});

// The dns member reads this as its `azureEndpoint` parameter.
export const azureEndpoint = output(app.configuration_ingress_fqdn, "azureEndpoint");
