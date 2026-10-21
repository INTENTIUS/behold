import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { awsIconFor, azureIconFor, gcpIconFor, ICON_SOURCES, referencedIcons, terraformIconFor } from "./cloud-icons.ts";
import { loadIcon } from "./icon-packs.ts";

const ICONS = join(import.meta.dirname, "..", "web", "icons");

describe("cloud icons (#872)", () => {
  it("vendors every icon a kind can reach, from a named source, and nothing that isn't reachable", () => {
    for (const rel of referencedIcons()) {
      expect(ICON_SOURCES[rel], rel).toBeTruthy();
      expect(existsSync(join(ICONS, `${rel}.svg`)), rel).toBe(true);
      const glyph = loadIcon(rel);
      expect(glyph.viewBox, rel).toMatch(/\d/);
      expect(glyph.body, rel).not.toMatch(/<script|<foreignObject|\son\w+=/i);
    }
    expect(Object.keys(ICON_SOURCES).sort()).toEqual(referencedIcons());
  });

  it("picks a resource's own icon before its service's", () => {
    expect(awsIconFor("AWS::ElasticLoadBalancingV2::LoadBalancer")).toBe(loadIcon("aws/alb"));
    expect(awsIconFor("AWS::ElasticLoadBalancingV2::TargetGroup")).toBe(loadIcon("aws/elb"));
    expect(awsIconFor("AWS::EC2::NatGateway")).toBe(loadIcon("aws/nat-gateway"));
    expect(awsIconFor("AWS::EC2::SecurityGroup")).toBe(loadIcon("aws/ec2"));
    expect(awsIconFor("AWS::Route53::RecordSet")).toBe(loadIcon("aws/route-53"));
    expect(awsIconFor("AWS::CloudFormation::Parameter")).toBe(loadIcon("aws/cloudformation"));
    expect(awsIconFor("AWS::Nothing::Here")).toBeUndefined();
  });

  it("reads Azure types in ARM's spelling and chant's", () => {
    expect(azureIconFor("Microsoft.App/containerApps")).toBe(loadIcon("azure/container-app"));
    expect(azureIconFor("Microsoft.Network/virtualNetworks/subnets")).toBe(loadIcon("azure/subnet"));
    expect(azureIconFor("Microsoft.Network/virtualNetworks_subnets")).toBe(loadIcon("azure/subnet"));
    expect(azureIconFor("Microsoft.Unknown/things")).toBeUndefined();
  });

  it("maps GCP kinds by kind, then by service whatever its case", () => {
    expect(gcpIconFor("GCP::Run::Service")).toBe(loadIcon("gcp/cloud-run"));
    expect(gcpIconFor("GCP::Compute::ForwardingRule")).toBe(loadIcon("gcp/cloud-load-balancing"));
    expect(gcpIconFor("GCP::Iam::ServiceAccount")).toBe(loadIcon("gcp/iam"));
    expect(gcpIconFor("GCP::PubSub::Topic")).toBe(loadIcon("gcp/pubsub"));
  });

  it("gives a Terraform resource type its vendor's icon, by the longest prefix", () => {
    expect(terraformIconFor("aws_s3_bucket_policy")).toBe(loadIcon("aws/s3-bucket"));
    expect(terraformIconFor("aws_s3_object")).toBe(loadIcon("aws/s3"));
    expect(terraformIconFor("azurerm_container_app_environment")).toBe(loadIcon("azure/container-apps-environment"));
    expect(terraformIconFor("google_cloud_run_v2_service")).toBe(loadIcon("gcp/cloud-run"));
    expect(terraformIconFor("random_id")).toBeUndefined();
  });
});
