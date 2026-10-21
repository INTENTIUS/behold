import { output } from "@intentius/chant-lexicon-azure";
import { ContainerAppNetwork, ContainerAppSite } from "../composites/container-app-site";

// The website on Azure Container Apps in West Europe, from this project's own
// composites (../composites/container-app-site.ts): its network, and the site
// in it.
export const network = ContainerAppNetwork({ name: "three-cloud", location: "westeurope", addressSpace: "10.40.0.0/16", subnetPrefix: "10.40.0.0/23" });

export const web = ContainerAppSite({
  name: "three-cloud",
  app: "web",
  location: "westeurope",
  subnet: network.subnet,
  image: "traefik/whoami:v1.10",
  port: 80,
  replicas: 1,
});

// The dns member reads this as its `azureEndpoint` parameter.
export const azureEndpoint = output(web.app.configuration_ingress_fqdn, "azureEndpoint");
