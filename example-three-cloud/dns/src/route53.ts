import { HostedZone, HealthCheck, RecordSet, Parameter } from "@intentius/chant-lexicon-aws";

// Route 53 in front of the three clouds: one latency record per cloud, each
// guarded by a health check on that cloud's endpoint. A record whose check
// fails stops answering, and the other two take its traffic.
//
// Latency records name an AWS region, so Azure (West Europe) answers as
// eu-west-1 and GCP (Tokyo) as ap-northeast-1. All three are CNAMEs, since an
// alias can only point at an AWS target and records sharing a name must share
// a type.
//
// Each endpoint arrives as a parameter named like the output the cloud's
// member publishes, which is the join behold draws the cross-member edge on.

const NAME = "www.three-cloud.example.";

export const zone = new HostedZone({ Name: "three-cloud.example." });

export const awsEndpoint = new Parameter("String", { description: "The aws member's load balancer hostname" });
export const azureEndpoint = new Parameter("String", { description: "The azure member's Container App hostname" });
export const gcpEndpoint = new Parameter("String", { description: "The gcp member's Cloud Run hostname" });

function healthCheck(endpoint: Parameter) {
  return new HealthCheck({
    HealthCheckConfig: {
      Type: "HTTP",
      FullyQualifiedDomainName: endpoint,
      ResourcePath: "/",
      RequestInterval: 10,
      FailureThreshold: 1,
    },
  });
}

function latencyRecord(id: string, region: string, endpoint: Parameter, check: HealthCheck) {
  return new RecordSet({
    HostedZoneId: zone.Id,
    Name: NAME,
    Type: "CNAME",
    TTL: "60",
    SetIdentifier: id,
    Region: region,
    ResourceRecords: [endpoint as unknown as string],
    HealthCheckId: check.HealthCheckId,
  });
}

export const awsCheck = healthCheck(awsEndpoint);
export const azureCheck = healthCheck(azureEndpoint);
export const gcpCheck = healthCheck(gcpEndpoint);

export const awsRecord = latencyRecord("aws", "us-east-1", awsEndpoint, awsCheck);
export const azureRecord = latencyRecord("azure", "eu-west-1", azureEndpoint, azureCheck);
export const gcpRecord = latencyRecord("gcp", "ap-northeast-1", gcpEndpoint, gcpCheck);
