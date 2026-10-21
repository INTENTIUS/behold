import { HostedZone, Parameter } from "@intentius/chant-lexicon-aws";
import { AddressEntry, HostnameEntry } from "../composites/latency-entry";

// Route 53 in front of the three clouds: one latency record per cloud, each
// guarded by a health check on that cloud's endpoint. A record whose check
// fails stops answering, and the other two take its traffic.
//
// Latency records name an AWS region, so Azure (West Europe) answers as
// eu-west-1 and GCP (Tokyo) as ap-northeast-1. All three are CNAMEs, since an
// alias can only point at an AWS target and records sharing a name must share
// a type. GCP's load balancer has an IP address rather than a hostname, so
// it gets a name of its own (an A record) and the latency record points at
// that, as a GCP load balancer is usually published.
//
// Each endpoint arrives as a parameter named like the output the cloud's
// member publishes, which is the join behold draws the cross-member edge on.

const NAME = "www.three-cloud.example.";

export const zone = new HostedZone({ Name: "three-cloud.example." });

export const awsEndpoint = new Parameter("String", { description: "The aws member's load balancer hostname" });
export const azureEndpoint = new Parameter("String", { description: "The azure member's Container App hostname" });
export const gcpEndpoint = new Parameter("String", { description: "The gcp member's load balancer IP address" });

// One entry per cloud, from this project's own composites
// (../composites/latency-entry.ts). Azure (West Europe) answers as eu-west-1
// and GCP (Tokyo) as ap-northeast-1, since latency records name AWS regions.
const endpoint = (p: Parameter) => p as unknown as string;
export const aws = HostnameEntry({ zoneId: zone.Id, name: NAME, id: "aws", region: "us-east-1", endpoint: endpoint(awsEndpoint) });
export const azure = HostnameEntry({ zoneId: zone.Id, name: NAME, id: "azure", region: "eu-west-1", endpoint: endpoint(azureEndpoint) });
export const gcp = AddressEntry({ zoneId: zone.Id, name: NAME, id: "gcp", region: "ap-northeast-1", endpoint: endpoint(gcpEndpoint), origin: "gcp.three-cloud.example.", port: 80 });
