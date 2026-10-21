import { describe, it, expect } from "vitest";
import { memberPrefixes, simplifyNesting } from "./logical-simplify.ts";

// The three-cloud demo's logical nesting, as the lenses join it (behold#824).
const threeCloud = () => ({
  "AWS account 000000000000": ["regional & global", "us-east-1 · VPC 10.20.0.0/16"],
  "regional & global": ["dns"],
  dns: ["dns/awsRecord", "dns/gcpRecord"],
  "us-east-1 · VPC 10.20.0.0/16": ["aws", "public subnets 10.20.0.0/24, 10.20.1.0/24"],
  aws: ["aws/igw"],
  "public subnets 10.20.0.0/24, 10.20.1.0/24": ["aws · public"],
  "aws · public": ["aws/alb", "aws/nat"],
  "Azure subscription 1": ["resource group local"],
  "resource group local": ["VNet 10.40.0.0/16"],
  "VNet 10.40.0.0/16": ["subnet 10.40.0.0/23"],
  "subnet 10.40.0.0/23": ["azure"],
  azure: ["azure/app", "azure/env"],
  "GCP project three-cloud": ["location global"],
  "location global": ["gcp · global"],
  "gcp · global": ["gcp/rule"],
});
const members = new Set(["dns", "aws", "azure", "gcp"]);

describe("simplifyNesting", () => {
  it("unwraps component boxes that only repeat their member", () => {
    const out = simplifyNesting(threeCloud(), members);
    expect(out["regional & global"]).toEqual(["dns/awsRecord", "dns/gcpRecord"]);
    expect(out["us-east-1 · VPC 10.20.0.0/16"]).toEqual(["aws/igw", "public subnets 10.20.0.0/24, 10.20.1.0/24"]);
    expect(out["public subnets 10.20.0.0/24, 10.20.1.0/24"]).toEqual(["aws/alb", "aws/nat"]);
    for (const m of members) expect(out[m]).toBeUndefined();
  });

  it("merges a chain of single boxes into one title, inside the account boundary", () => {
    const out = simplifyNesting(threeCloud(), members);
    expect(out["Azure subscription 1"]).toEqual(["resource group local › VNet 10.40.0.0/16 › subnet 10.40.0.0/23"]);
    expect(out["resource group local › VNet 10.40.0.0/16 › subnet 10.40.0.0/23"]).toEqual(["azure/app", "azure/env"]);
    expect(out["GCP project three-cloud"]).toEqual(["location global"]);
    expect(out["location global"]).toEqual(["gcp/rule"]);
  });

  it("keeps a box a caller addresses by key", () => {
    const out = simplifyNesting({ cluster: ["namespace shop"], "namespace shop": ["shop/api"] }, new Set(["shop"]), new Set(["namespace shop"]));
    expect(out["namespace shop"]).toEqual(["shop/api"]);
  });

  it("with no member prefixes, unwraps nothing but still merges a single-box chain", () => {
    const bc = { "VPC 10.0.0.0/16": ["app"], app: ["web"] };
    expect(simplifyNesting(bc, memberPrefixes([{ id: "web" }]))).toEqual({ "VPC 10.0.0.0/16 › app": ["web"] });
  });
});
