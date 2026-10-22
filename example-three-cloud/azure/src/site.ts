import { ContainerAppNetwork, ContainerAppSite, output } from "@intentius/chant-lexicon-azure";

// The website on Azure Container Apps in West Europe, from the lexicon's
// composites: its network, and the site in it.
export const network = ContainerAppNetwork({ name: "three-cloud", location: "westeurope", addressSpace: "10.40.0.0/16", subnetPrefix: "10.40.0.0/23" });

export const web = ContainerAppSite({
  name: "three-cloud",
  app: "web",
  location: "westeurope",
  subnetId: network.subnet.id as unknown as string,
  image: "traefik/whoami:v1.10",
  port: 80,
  replicas: 1,
});

// The dns member reads this as its `azureEndpoint` parameter.
export const azureEndpoint = output(web.containerApp.configuration_ingress_fqdn, "azureEndpoint");
