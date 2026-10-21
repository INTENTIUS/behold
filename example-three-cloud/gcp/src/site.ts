import { output } from "@intentius/chant-lexicon-gcp";
import { PrivateEgressNetwork, PublicCloudRun } from "../composites/public-cloud-run";

// The website on Cloud Run in Tokyo behind a global load balancer, from this
// project's own composites (../composites/public-cloud-run.ts): its network,
// and the site that sends its egress into it.
export const network = PrivateEgressNetwork({ name: "three-cloud", region: "asia-northeast1", subnetCidr: "10.30.0.0/24" });

export const web = PublicCloudRun({
  name: "three-cloud",
  project: "three-cloud",
  region: "asia-northeast1",
  vpc: network.vpc,
  subnet: network.subnet,
  image: "traefik/whoami:v1.10",
  port: 80,
  instances: 1,
});

// The dns member reads this as its `gcpEndpoint` parameter: the load
// balancer's front end, whose IP is the reserved address. Config Connector
// YAML has no outputs and neither kind exposes the IP as an attribute, so
// this declares the join for the graph, and scripts/front-door.ts reads the
// IP from the emulator.
export const gcpEndpoint = output(web.rule.status_selfLink, "gcpEndpoint");
