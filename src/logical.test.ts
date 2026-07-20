import { describe, it, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { projectLogical } from "./logical.ts";

const ref = (target: string) => ({ $ref: target });

/** A two-stack estate. A `shared-foundation` stack owns the VPC, a public + a
 * private subnet, an IGW (+ route plumbing), an ALB and a target group. A
 * `backend` stack's ECS service reaches the foundation only through a
 * CloudFormation Parameter (an import) whose description names a foundation
 * export — the sole cross-stack tie in a pre-deploy graph. Plus a regional S3
 * bucket, an IAM role that must never appear, and a byo example that's excluded. */
function fixture(): GraphIR {
  const n = (id: string, kind: string, file: string, attrs: Record<string, unknown> = {}) => ({
    id,
    kind,
    lexicon: "aws",
    attrs,
    sourceLoc: { file },
  });
  const F = "shared-foundation/foundation.ts";
  const B = "backend/service.ts";
  return {
    nodes: [
      n("vpc", "AWS::EC2::VPC", F, { CidrBlock: "10.0.0.0/16", VpcArn: "arn:aws:ec2:us-east-1:1:vpc/x" }),
      n("publicSubnet", "AWS::EC2::Subnet", F, { CidrBlock: "10.0.0.0/20", VpcId: ref("vpc.VpcId") }),
      n("privateSubnet", "AWS::EC2::Subnet", F, { CidrBlock: "10.0.16.0/20", VpcId: ref("vpc.VpcId") }),
      n("igw", "AWS::EC2::InternetGateway", F, {}),
      n("igwAttach", "AWS::EC2::VPCGatewayAttachment", F, { VpcId: ref("vpc.VpcId"), InternetGatewayId: ref("igw.InternetGatewayId") }),
      n("publicRt", "AWS::EC2::RouteTable", F, { VpcId: ref("vpc.VpcId") }),
      n("defaultRoute", "AWS::EC2::Route", F, { RouteTableId: ref("publicRt.RouteTableId"), GatewayId: ref("igw.InternetGatewayId") }),
      n("pubAssoc", "AWS::EC2::SubnetRouteTableAssociation", F, { SubnetId: ref("publicSubnet.SubnetId"), RouteTableId: ref("publicRt.RouteTableId") }),
      n("alb", "AWS::ElasticLoadBalancingV2::LoadBalancer", F, { Subnets: [ref("publicSubnet.SubnetId")], SecurityGroups: [ref("albSg.GroupId")] }),
      n("listener", "AWS::ElasticLoadBalancingV2::Listener", F, { LoadBalancerArn: ref("alb.Arn"), TargetGroupArn: ref("tg.Arn") }),
      n("tg", "AWS::ElasticLoadBalancingV2::TargetGroup", F, { VpcId: ref("vpc.VpcId") }),
      n("albSg", "AWS::EC2::SecurityGroup", F, { VpcId: ref("vpc.VpcId") }),
      // ecsSg accepts inbound from albSg — the ALB → service traffic edge.
      n("ecsSg", "AWS::EC2::SecurityGroup", F, { VpcId: ref("vpc.VpcId"), SecurityGroupIngress: [{ FromPort: 8000, SourceSecurityGroupId: ref("albSg.GroupId") }] }),
      n("foundationRole", "AWS::IAM::Role", F, { Arn: "arn:aws:iam::1:role/f" }),
      // backend stack — reaches the foundation only via the import parameters.
      n("svc", "AWS::ECS::Service", B, { NetworkConfiguration: { SecurityGroups: [ref("ecsSgParam")] }, TargetGroup: ref("tgParam"), Role: ref("taskRole.Arn") }),
      // taskRole grants the service access to the bucket — the only trail the
      // app→bucket dependency leaves (an IAM policy, a property hub).
      n("taskRole", "AWS::IAM::Role", B, { Arn: "arn:aws:iam::1:role/b", Policies: [ref("bucket.Arn")] }),
      // a database in its own component + SG, in the VPC — the service reaches it
      // only through the shared VPC fabric (its endpoint arrives via config).
      n("db", "AWS::RDS::DBInstance", "database/db.ts", { VPCSecurityGroups: [ref("dbSg.GroupId")] }),
      n("dbSg", "AWS::EC2::SecurityGroup", "database/db.ts", { VpcId: ref("vpc.VpcId") }),
      n("ecsSgParam", "AWS::CloudFormation::Parameter", B, { parameterType: "String", description: "ECS security group id (shared-foundation oEcsSg)" }),
      n("tgParam", "AWS::CloudFormation::Parameter", B, { parameterType: "String", description: "backend target group (shared-foundation oBackendTg)" }),
      // a regional service + an excluded byo example.
      n("bucket", "AWS::S3::Bucket", "assets/bucket.ts", { Arn: "arn:aws:s3:::b" }),
      n("byoSvc", "AWS::ECS::Service", "examples/byo/backend.ts", {}),
    ],
    edges: [
      { from: "listener", to: "alb", kind: "ref" },
      { from: "listener", to: "tg", kind: "ref" },
      { from: "svc", to: "ecsSgParam", kind: "ref" },
      { from: "svc", to: "tgParam", kind: "ref" },
    ],
    groups: {},
    exports: [
      { name: "oEcsSg", node: "ecsSg" }, // the backend's imported SG resolves here (bridged from ecsSgParam's description)
      { name: "oBackendTg", node: "tg", attr: "TargetGroupArn" },
    ],
    imports: [
      { name: "LoomBackendpEcsSg", node: "ecsSgParam" },
      { name: "LoomBackendpBackendTg", node: "tgParam" },
    ],
  } as GraphIR;
}

// Which container box a node id sits in (its immediate parent in byContainer).
const parentOf = (bc: Record<string, string[]>, id: string) =>
  Object.entries(bc).find(([, ids]) => ids.includes(id))?.[0];

describe("projectLogical", () => {
  const { ir, byContainer } = projectLogical(fixture());
  const kept = ir.nodes.map((n) => n.id).sort();

  it("keeps only headline resources — leaves, wiring, property nodes dropped", () => {
    // alb + igw (foundation), svc (backend), db (database), bucket (regional).
    // NOT tg (target group), listener, security groups, roles, params, byo.
    expect(kept).toEqual(["alb", "bucket", "db", "igw", "svc"].sort());
  });

  it("excludes byo example nodes entirely", () => {
    expect(kept).not.toContain("byoSvc");
  });

  it("groups resources into a box per component", () => {
    expect(parentOf(byContainer, "alb")).toBe("shared-foundation");
    expect(parentOf(byContainer, "igw")).toBe("shared-foundation");
    expect(parentOf(byContainer, "svc")).toBe("backend");
    expect(parentOf(byContainer, "bucket")).toBe("assets");
  });

  it("nests component boxes inside their network place (VPC), with CIDR labels", () => {
    const vpcBox = "us-east-1 · VPC 10.0.0.0/16";
    // shared-foundation spans the public subnet (ALB) + VPC-level (IGW), so its
    // box sits at the VPC; backend reaches the VPC via the bridged parameter.
    expect(parentOf(byContainer, "shared-foundation")).toBe(vpcBox);
    expect(parentOf(byContainer, "backend")).toBe(vpcBox);
    expect(Object.keys(byContainer)).toContain(vpcBox);
  });

  it("places the consuming stack in the VPC via the import↔export description bridge", () => {
    // svc → tgParam → (description names oBackendTg) → tg → VpcId → vpc.
    expect(parentOf(byContainer, "backend")).toBe("us-east-1 · VPC 10.0.0.0/16");
  });

  it("puts VPC-less regional services in the global lane", () => {
    expect(parentOf(byContainer, "assets")).toBe("regional & global");
  });

  it("draws data-dependency edges from a workload to the stores it reaches (db via fabric, bucket via IAM grant)", () => {
    const data = ir.edges.filter((e) => e.viaAttr === "data dependency");
    const pairs = data.map((e) => `${e.from}->${e.to}`).sort();
    expect(pairs).toEqual(["svc->bucket", "svc->db"]);
    // directional: the workload depends on the store, not vice versa.
    expect(data.every((e) => e.from === "svc")).toBe(true);
  });

  it("draws ALB → service as a directional security-group-ingress traffic edge", () => {
    // ecsSg accepts inbound from albSg; alb ∈ albSg, svc ∈ ecsSg (via the bridged
    // SG parameter) → a directed alb → svc edge, tagged as SG ingress. It wins
    // over the target-group contraction path (same pair, emitted first).
    const e = ir.edges.find((x) => (x.from === "alb" && x.to === "svc") || (x.from === "svc" && x.to === "alb"));
    expect(e).toBeDefined();
    expect(e!.from).toBe("alb"); // source (initiator) → target (acceptor)
    expect(e!.to).toBe("svc");
    expect(e!.viaAttr).toBe("security-group ingress");
    // never through a property hub
    expect(ir.edges.some((x) => x.from === "taskRole" || x.to === "taskRole")).toBe(false);
  });
});
