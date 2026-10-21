import { describe, it, expect } from "vitest";
import { cidrContains, cidrsOverlap, networkFindings, OUTSIDE, parseCidr, traceRoute } from "./net-trace.js";

const ref = (id) => ({ $ref: id });
const n = (id, kind, attrs = {}) => ({ id, kind, lexicon: kind.startsWith("AWS") ? "aws" : kind.startsWith("GCP") ? "gcp" : "azure", attrs });

/** A VPC with a public and a private subnet, a load balancer in front of a service. */
function aws({ albIngress = [{ IpProtocol: "tcp", FromPort: 80, ToPort: 80, CidrIp: "0.0.0.0/0" }], nacl = false, publicRoute = true, albSubnets = ["a/pub1", "a/pub2"] } = {}) {
  const nodes = [
    n("a/vpc", "AWS::EC2::VPC", { CidrBlock: "10.0.0.0/16" }),
    n("a/igw", "AWS::EC2::InternetGateway"),
    n("a/attach", "AWS::EC2::VPCGatewayAttachment", { VpcId: ref("a/vpc.VpcId"), InternetGatewayId: ref("a/igw.InternetGatewayId") }),
    n("a/pub1", "AWS::EC2::Subnet", { VpcId: ref("a/vpc.VpcId"), CidrBlock: "10.0.0.0/24", MapPublicIpOnLaunch: true }),
    n("a/pub2", "AWS::EC2::Subnet", { VpcId: ref("a/vpc.VpcId"), CidrBlock: "10.0.1.0/24", MapPublicIpOnLaunch: true }),
    n("a/priv", "AWS::EC2::Subnet", { VpcId: ref("a/vpc.VpcId"), CidrBlock: "10.0.10.0/24" }),
    n("a/pubRt", "AWS::EC2::RouteTable", { VpcId: ref("a/vpc.VpcId") }),
    n("a/rta1", "AWS::EC2::SubnetRouteTableAssociation", { SubnetId: ref("a/pub1.SubnetId"), RouteTableId: ref("a/pubRt.RouteTableId") }),
    n("a/rta2", "AWS::EC2::SubnetRouteTableAssociation", { SubnetId: ref("a/pub2.SubnetId"), RouteTableId: ref("a/pubRt.RouteTableId") }),
    ...(publicRoute ? [n("a/pubRoute", "AWS::EC2::Route", { RouteTableId: ref("a/pubRt.RouteTableId"), DestinationCidrBlock: "0.0.0.0/0", GatewayId: ref("a/igw.InternetGatewayId") })] : []),
    n("a/albSg", "AWS::EC2::SecurityGroup", { VpcId: ref("a/vpc.VpcId"), SecurityGroupIngress: albIngress }),
    n("a/taskSg", "AWS::EC2::SecurityGroup", { VpcId: ref("a/vpc.VpcId"), SecurityGroupIngress: [{ IpProtocol: "tcp", FromPort: 8080, ToPort: 8080, SourceSecurityGroupId: ref("a/albSg.GroupId") }] }),
    n("a/alb", "AWS::ElasticLoadBalancingV2::LoadBalancer", { Scheme: "internet-facing", Subnets: albSubnets.map((s) => ref(`${s}.SubnetId`)), SecurityGroups: [ref("a/albSg.GroupId")] }),
    n("a/listener", "AWS::ElasticLoadBalancingV2::Listener", { LoadBalancerArn: ref("a/alb.LoadBalancerArn"), Port: 80, DefaultActions: [{ Type: "forward", TargetGroupArn: ref("a/tg.TargetGroupArn") }] }),
    n("a/tg", "AWS::ElasticLoadBalancingV2::TargetGroup", { Port: 8080, VpcId: ref("a/vpc.VpcId") }),
    n("a/svc", "AWS::ECS::Service", {
      LoadBalancers: [{ ContainerPort: 8080, TargetGroupArn: ref("a/tg.TargetGroupArn") }],
      NetworkConfiguration: { AwsvpcConfiguration: { Subnets: [ref("a/priv.SubnetId")], SecurityGroups: [ref("a/taskSg.GroupId")] } },
    }),
  ];
  if (nacl) {
    nodes.push(
      n("a/acl", "AWS::EC2::NetworkAcl", { VpcId: ref("a/vpc.VpcId") }),
      n("a/aclAssoc1", "AWS::EC2::SubnetNetworkAclAssociation", { SubnetId: ref("a/pub1.SubnetId"), NetworkAclId: ref("a/acl.Id") }),
      n("a/aclAssoc2", "AWS::EC2::SubnetNetworkAclAssociation", { SubnetId: ref("a/pub2.SubnetId"), NetworkAclId: ref("a/acl.Id") }),
      n("a/aclDeny", "AWS::EC2::NetworkAclEntry", { NetworkAclId: ref("a/acl.Id"), RuleNumber: 90, Protocol: 6, PortRange: { From: 80, To: 80 }, CidrBlock: "0.0.0.0/0", RuleAction: "deny", Egress: false }),
      n("a/aclAllow", "AWS::EC2::NetworkAclEntry", { NetworkAclId: ref("a/acl.Id"), RuleNumber: 100, Protocol: -1, CidrBlock: "0.0.0.0/0", RuleAction: "allow", Egress: false }),
    );
  }
  return { nodes, edges: [], groups: {} };
}

describe("addresses (#881)", () => {
  it("reads IPv4 ranges and compares them", () => {
    expect(parseCidr("10.0.0.0/16")).toMatchObject({ bits: 16 });
    expect(parseCidr("::/0")).toBeNull();
    expect(cidrContains("10.0.0.0/16", "10.0.3.0/24")).toBe(true);
    expect(cidrContains("10.0.3.0/24", "10.0.0.0/16")).toBe(false);
    expect(cidrContains("0.0.0.0/0", "0.0.0.0/0")).toBe(true);
    expect(cidrsOverlap("10.0.3.0/24", "10.0.0.0/16")).toBe(true);
    expect(cidrsOverlap("10.0.0.0/24", "10.0.1.0/24")).toBe(false);
  });
});

describe("traceRoute (#881)", () => {
  const steps = (t) => t.hops.map((h) => `${h.open ? "+" : "-"}${h.step}`);

  it("follows outside through the gateway, ACLs, groups and listener to the service", () => {
    const t = traceRoute(aws(), { from: OUTSIDE, to: "a/svc", port: 80 });
    expect(t.reached).toBe(true);
    expect(steps(t)).toEqual(["+way in", "+gateway", "+network ACL", "+security group", "+listener", "+forward", "+network ACL", "+security group"]);
    expect(t.hops.at(-1)).toMatchObject({ id: "a/taskSg", basis: "source", seen: false });
    expect(t.hops[5].why).toMatch(/forwards to a\/tg on 8080/);
  });

  it("stops at the security group and the listener for a port nothing takes", () => {
    const t = traceRoute(aws(), { from: OUTSIDE, to: "a/svc", port: 443 });
    expect(t.reached).toBe(false);
    expect(t.stop).toBe("a/albSg");
    expect(t.hops.find((h) => h.step === "listener").why).toBe("a/alb listens on 80, not 443");
  });

  it("reads a network ACL in rule order", () => {
    const t = traceRoute(aws({ nacl: true }), { from: OUTSIDE, to: "a/svc", port: 80 });
    expect(t.stop).toBe("a/aclDeny");
    expect(t.hops[2].why).toMatch(/rule 90 denies 80/);
  });

  it("stops at the gateway when the public subnets have no route out", () => {
    const t = traceRoute(aws({ publicRoute: false }), { from: OUTSIDE, to: "a/alb", port: 80 });
    expect(steps(t)[1]).toBe("-gateway");
    expect(t.hops[1].why).toMatch(/no route to 0\.0\.0\.0\/0/);
  });

  it("judges a security group from its live rules when the card carries them", () => {
    const ir = aws();
    const sg = ir.nodes.find((x) => x.id === "a/albSg");
    sg.attrs.GroupId = "sg-1";
    sg.attrs._status = "good";
    sg.attrs.IpPermissions = [{ IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0" }], UserIdGroupPairs: [] }];
    const t = traceRoute(ir, { from: OUTSIDE, to: "a/alb", port: 80 });
    expect(t.hops[3]).toMatchObject({ step: "security group", open: false, basis: "live", seen: true });
  });

  it("goes card to card inside one VPC", () => {
    const t = traceRoute(aws(), { from: "a/alb", to: "a/svc", port: 8080 });
    expect(t.reached).toBe(true);
    expect(t.hops[0].why).toBe("inside a/vpc: the local route");
    expect(traceRoute(aws(), { from: "a/alb", to: "a/svc", port: 22 }).stop).toBe("a/taskSg");
  });

  it("follows a forwarding rule to a Cloud Run service and asks who may call it", () => {
    const ir = {
      nodes: [
        n("g/rule", "GCP::Compute::ForwardingRule", { loadBalancingScheme: "EXTERNAL_MANAGED", portRange: "80", target: { targetHTTPProxyRef: { name: ref("g/proxy.name") } } }),
        n("g/proxy", "GCP::Compute::TargetHTTPProxy", { urlMapRef: { name: ref("g/map.name") } }),
        n("g/map", "GCP::Compute::URLMap", { defaultService: { backendServiceRef: { name: ref("g/backend.name") } } }),
        n("g/backend", "GCP::Compute::BackendService", { backend: [{ group: { networkEndpointGroupRef: { name: ref("g/neg.name") } } }] }),
        n("g/neg", "GCP::Compute::RegionNetworkEndpointGroup", { cloudRun: { serviceRef: { name: ref("g/run.name") } } }),
        n("g/run", "GCP::Run::Service", { metadata: { name: "site" } }),
      ],
      edges: [],
      groups: {},
    };
    const closed = traceRoute(ir, { from: OUTSIDE, to: "g/run", port: 80 });
    expect(closed.stop).toBe("g/run");
    expect(closed.hops.at(-1).why).toMatch(/callers need a credential/);
    ir.nodes.push(n("g/public", "GCP::Iam::PolicyMember", { member: "allUsers", role: "roles/run.invoker", resourceRef: { kind: "RunService", name: "site" } }));
    const open = traceRoute(ir, { from: OUTSIDE, to: "g/run", port: 80 });
    expect(open.reached).toBe(true);
    expect(open.hops.map((h) => h.id)).toEqual(["g/rule", "g/proxy", "g/map", "g/backend", "g/neg", "g/run", "g/public"]);
  });

  it("reads a container app's environment and ingress", () => {
    const ir = {
      nodes: [
        n("z/env", "Microsoft.App/managedEnvironments", { vnetConfiguration: { internal: true } }),
        n("z/app", "Microsoft.App/containerApps", { managedEnvironmentId: ref("z/env.id"), configuration: { ingress: { external: true, targetPort: 8080 } } }),
      ],
      edges: [],
      groups: {},
    };
    const t = traceRoute(ir, { from: OUTSIDE, to: "z/app", port: 443 });
    expect(t.stop).toBe("z/env");
    expect(t.hops.at(-1).why).toBe("takes 443 and forwards to 8080");
  });

  it("says when it can't read a card, rather than guess", () => {
    const ir = { nodes: [n("k/pod", "K8s::Core::Pod")], edges: [], groups: {} };
    ir.nodes[0].lexicon = "k8s";
    expect(traceRoute(ir, { from: OUTSIDE, to: "k/pod", port: 80 }).unread).toMatch(/reads AWS, GCP and Azure/);
    expect(traceRoute(ir, { from: OUTSIDE, to: "nope", port: 80 }).unread).toMatch(/isn't on this graph/);
    expect(traceRoute(ir, { from: OUTSIDE, to: "k/pod", port: 0 }).unread).toMatch(/port/);
  });
});

describe("networkFindings (#881)", () => {
  it("finds nothing on a sound network", () => {
    expect(networkFindings(aws())).toEqual([]);
  });

  it("finds a public subnet with no way out, a load balancer in one zone, and an admin port open to anyone", () => {
    const ir = aws({ publicRoute: false, albSubnets: ["a/pub1"], albIngress: [{ IpProtocol: "tcp", FromPort: 0, ToPort: 65535, CidrIp: "0.0.0.0/0" }] });
    const f = networkFindings(ir);
    expect(f.map((x) => `${x.finding}:${x.ids.join(",")}`)).toEqual(["no way out:a/pub1", "no way out:a/pub2", "one zone:a/alb", "admin port:a/albSg"]);
    expect(f.at(-1).text).toMatch(/22 \(SSH\)/);
  });

  it("finds ranges that overlap across networks and clouds, but not a subnet inside its own network", () => {
    const ir = aws();
    ir.nodes.push(
      n("z/vnet", "Microsoft.Network/virtualNetworks", { name: "v", addressSpace: { addressPrefixes: ["10.0.0.0/20"] } }),
      n("z/sub", "Microsoft.Network/virtualNetworks_subnets", { name: "v/apps", addressPrefix: "10.0.0.0/23" }),
      n("g/sub", "GCP::Compute::Subnetwork", { ipCidrRange: "192.168.0.0/24", networkRef: { name: ref("g/vpc.name") } }),
    );
    const f = networkFindings(ir).filter((x) => x.finding === "overlap");
    expect(f.map((x) => x.ids)).toEqual([["a/vpc", "z/vnet"]]);
  });

  it("finds an admin port open on a GCP firewall and an Azure security group", () => {
    const ir = {
      nodes: [
        n("g/fw", "GCP::Compute::Firewall", { direction: "INGRESS", sourceRanges: ["0.0.0.0/0"], allow: [{ protocol: "tcp", ports: ["22", "80"] }] }),
        n("z/nsg", "Microsoft.Network/networkSecurityGroups", { securityRules: [{ name: "rdp", properties: { direction: "Inbound", access: "Allow", sourceAddressPrefix: "*", destinationPortRange: "3389", priority: 100 } }] }),
      ],
      edges: [],
      groups: {},
    };
    expect(networkFindings(ir).map((x) => x.text)).toEqual(["g/fw lets anyone reach 22 (SSH)", "z/nsg lets anyone reach 3389 (remote desktop)"]);
  });
});
