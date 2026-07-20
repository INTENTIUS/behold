import { describe, it, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { projectNetwork, type NetworkGroups } from "./network.ts";

const ref = (target: string) => ({ $ref: target });

/** A small but realistic estate: one VPC, a public + private subnet, an IGW with
 * its route plumbing, an ALB (with a listener) → target group → ECS service in
 * the public subnet, an RDS in the private subnet via a DB subnet group, plus a
 * regional S3 bucket and an IAM role that should never appear. */
function fixture(): GraphIR {
  const n = (id: string, kind: string, attrs: Record<string, unknown> = {}) => ({ id, kind, lexicon: "aws", attrs });
  return {
    nodes: [
      n("vpc", "AWS::EC2::VPC", { CidrBlock: "10.0.0.0/16", VpcArn: "arn:aws:ec2:us-east-1:1:vpc/x" }),
      n("publicSubnet", "AWS::EC2::Subnet", { CidrBlock: "10.0.0.0/20", VpcId: ref("vpc.VpcId") }),
      n("privateSubnet", "AWS::EC2::Subnet", { CidrBlock: "10.0.16.0/20", VpcId: ref("vpc.VpcId") }),
      n("igw", "AWS::EC2::InternetGateway", {}),
      n("igwAttach", "AWS::EC2::VPCGatewayAttachment", { VpcId: ref("vpc.VpcId"), InternetGatewayId: ref("igw.InternetGatewayId") }),
      n("publicRt", "AWS::EC2::RouteTable", { VpcId: ref("vpc.VpcId") }),
      n("defaultRoute", "AWS::EC2::Route", { RouteTableId: ref("publicRt.RouteTableId"), GatewayId: ref("igw.InternetGatewayId") }),
      n("pubAssoc", "AWS::EC2::SubnetRouteTableAssociation", { SubnetId: ref("publicSubnet.SubnetId"), RouteTableId: ref("publicRt.RouteTableId") }),
      n("alb", "AWS::ElasticLoadBalancingV2::LoadBalancer", { Subnets: [ref("publicSubnet.SubnetId")] }),
      n("listener", "AWS::ElasticLoadBalancingV2::Listener", { LoadBalancerArn: ref("alb.Arn"), TargetGroupArn: ref("tg.Arn") }),
      n("tg", "AWS::ElasticLoadBalancingV2::TargetGroup", { VpcId: ref("vpc.VpcId") }),
      n("svc", "AWS::ECS::Service", { NetworkConfiguration: { Subnets: [ref("publicSubnet.SubnetId")] }, TargetGroup: ref("tg.Arn"), Role: ref("taskRole.Arn") }),
      n("taskRole", "AWS::IAM::Role", { Arn: "arn:aws:iam::1:role/x" }),
      n("dbSubnetGroup", "AWS::RDS::DBSubnetGroup", { SubnetIds: [ref("privateSubnet.SubnetId")] }),
      n("db", "AWS::RDS::DBInstance", { DBSubnetGroupName: ref("dbSubnetGroup.DBSubnetGroupName") }),
      n("bucket", "AWS::S3::Bucket", { Arn: "arn:aws:s3:::b", BucketName: "b" }),
    ],
    edges: [
      { from: "listener", to: "alb", kind: "ref" },
      { from: "listener", to: "tg", kind: "ref" },
      { from: "svc", to: "tg", kind: "ref" },
      { from: "svc", to: "taskRole", kind: "ref" },
      { from: "db", to: "dbSubnetGroup", kind: "ref" },
    ],
    groups: {},
  };
}

const boxOf = (groups: NetworkGroups, id: string) =>
  Object.entries(groups.byNetwork ?? {}).find(([, ids]) => ids.includes(id))?.[0];

describe("projectNetwork", () => {
  const out = projectNetwork(fixture());
  const groups = out.groups as NetworkGroups;

  it("drops property + container + wiring nodes, keeps topology resources", () => {
    const ids = out.nodes.map((n) => n.id).sort();
    // IGW stays (it's drawn at the VPC edge); VPC/subnet became boxes;
    // IAM/route-table/listener/db-subnet-group are gone.
    expect(ids).toEqual(["alb", "bucket", "db", "igw", "svc", "tg"].sort());
    expect(ids).not.toContain("vpc");
    expect(ids).not.toContain("taskRole");
    expect(ids).not.toContain("listener");
  });

  it("places resources in their subnet, resolving multi-hop refs (RDS → DB subnet group → subnet)", () => {
    expect(boxOf(groups, "svc")).toMatch(/public 10\.0\.0\.0\/20/);
    expect(boxOf(groups, "db")).toMatch(/private 10\.0\.16\.0\/20/);
    // Both subnets carry the VPC CIDR + region in the box title.
    expect(boxOf(groups, "svc")).toMatch(/us-east-1 · vpc 10\.0\.0\.0\/16/);
  });

  it("detects a public subnet from its route to the internet gateway", () => {
    expect(boxOf(groups, "svc")).toMatch(/^us-east-1 · vpc 10\.0\.0\.0\/16 · public/);
  });

  it("puts VPC-less regional services in a global lane, never in a subnet", () => {
    expect(boxOf(groups, "bucket")).toBe("us-east-1 · regional & global");
  });

  it("contracts connectivity through the dropped listener (ALB → TargetGroup)", () => {
    const has = (a: string, b: string) => out.edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
    expect(has("alb", "tg")).toBe(true); // bridged through the listener
    expect(has("svc", "tg")).toBe(true); // survived directly
    // No false edge to the dropped IAM role.
    expect(out.edges.some((e) => e.from === "taskRole" || e.to === "taskRole")).toBe(false);
  });

  it("ignores non-AWS nodes", () => {
    const ir = fixture();
    ir.nodes.push({ id: "compose", kind: "Docker::Compose::Service", lexicon: "docker", attrs: {} });
    const p = projectNetwork(ir);
    expect(p.nodes.some((n) => n.id === "compose")).toBe(false);
  });
});
