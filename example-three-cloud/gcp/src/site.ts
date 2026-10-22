import { PrivateEgressNetwork, PublicCloudRun, output } from "@intentius/chant-lexicon-gcp";

// The website on Cloud Run in Tokyo behind a global load balancer, from the
// lexicon's composites: its network, and the site that sends its egress into it.
export const network = PrivateEgressNetwork({ name: "three-cloud", region: "asia-northeast1", subnetCidr: "10.30.0.0/24" });

export const web = PublicCloudRun({
  name: "three-cloud",
  projectId: "three-cloud",
  region: "asia-northeast1",
  vpc: network.vpc,
  subnet: network.subnet,
  image: "traefik/whoami:v1.10",
  port: 80,
  frontendPort: 80,
  minInstanceCount: 1,
  maxInstanceCount: 1,
});

// The dns member reads this as its `gcpEndpoint` parameter: the load
// balancer's front end, whose IP is the reserved address. Config Connector
// YAML has no outputs and neither kind exposes the IP as an attribute, so
// this declares the join for the graph, and scripts/front-door.ts reads the
// IP from the emulator.
export const gcpEndpoint = output(web.rule.status_selfLink, "gcpEndpoint");
