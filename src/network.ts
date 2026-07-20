/**
 * Network/regional projection (#63) — a traditional AWS diagram as a zoom lens.
 *
 * A pure IR→IR projection, in the same spirit as src/resources.ts and
 * composeEstate (src/estate.ts): it takes the rich entity graph (detail 3) and
 * re-projects it the way Cloudcraft / AWS Perspective / the draw.io AWS stencils
 * draw an estate — organized by CONTAINMENT TOPOLOGY (region → VPC → subnet),
 * not by the source-directory ownership the other zoom stops use.
 *
 * The three moves that make it a network diagram and not the entity graph:
 *   1. Re-partition every surviving node into a region/VPC/subnet container
 *      (`groups.byNetwork`), resolving `$ref` chains so a resource lands in the
 *      subnet it actually sits in (RDS → DBSubnetGroup → subnets included).
 *   2. Keep only topology-bearing nodes. VPCs/subnets BECOME the boxes (their
 *      CIDR is a box label, never a node); IAM/KMS/SSM/params/log groups/secrets
 *      and the like — property-level, not topology — are dropped entirely.
 *   3. Collapse the network wiring (listeners, security groups, route tables)
 *      into connectivity: edges are contracted THROUGH those dropped nodes so
 *      ALB → TargetGroup → ECS and same-SG reachability survive, while a shared
 *      IAM role never invents a false edge.
 *
 * AWS-lexicon only, by design: an AWS network diagram is the wrong shape for k8s
 * or GitHub Actions. Other substrates get their own topology lens later.
 *
 * Known limitation — multi-stack SOURCE graphs. When a consuming stack references
 * a foundation stack's VPC/subnet through a CloudFormation Parameter (an import),
 * the pre-deploy IR has no symbolic link from the import to its producer: the
 * import/export names don't match (the tie is a human-readable Parameter
 * description behold deliberately won't parse), and the subnet ids arrive as
 * `{$intrinsic}` resolved at deploy time. So the foundation's own network
 * resources place correctly, but a consuming stack's services land in the
 * regional/global lane until they can be placed by live physical ids — i.e. the
 * live overlay (`?env=`), where chant's reference resolver reconstructs the
 * cross-stack edges. This mirrors the rest of behold: the source graph shows
 * declared topology, the overlay shows resolved live topology.
 */
import type { GraphIR, IRNode, IREdge, IRGroups } from "@intentius/chant";

/** `groups.byNetwork`: container-box title → member node ids. Declared locally
 * (behold's pinned chant predates it); the render path reads it the same way it
 * reads `byStack`/`byWave` for boundary boxes. */
export type NetworkGroups = IRGroups & { byNetwork?: Record<string, string[]> };

// Containers — consumed into box titles, never drawn as nodes. Their CIDR/AZ is
// a label on the box.
const CONTAINER_KINDS = new Set(["AWS::EC2::VPC", "AWS::EC2::Subnet"]);

// Property-level — dropped entirely and NOT contracted through (bridging through
// a shared IAM role or KMS key would invent connectivity that isn't traffic).
const PROPERTY_KINDS = new Set([
  "AWS::IAM::Role",
  "AWS::IAM::Policy",
  "AWS::IAM::ManagedPolicy",
  "AWS::IAM::InstanceProfile",
  "AWS::KMS::Key",
  "AWS::KMS::Alias",
  "AWS::SSM::Parameter",
  "AWS::CloudFormation::Parameter",
  "AWS::Logs::LogGroup",
  "AWS::SecretsManager::Secret",
  "AWS::SecretsManager::SecretTargetAttachment",
  "AWS::S3::BucketPolicy",
  "AWS::ApplicationAutoScaling::ScalableTarget",
  "AWS::ApplicationAutoScaling::ScalingPolicy",
  "AWS::RDS::DBSubnetGroup", // a placement helper — read for containment, not drawn
  "AWS::Cognito::UserPoolClient",
  "AWS::Cognito::UserPoolResourceServer",
  "AWS::Cognito::UserPoolDomain",
]);

// Network wiring — dropped as nodes, but connectivity is CONTRACTED through them
// (their kept neighbours are wired to each other), so the traffic path survives.
const WIRING_KINDS = new Set([
  "AWS::ElasticLoadBalancingV2::Listener",
  "AWS::ElasticLoadBalancingV2::ListenerRule",
  "AWS::EC2::SecurityGroup",
  "AWS::EC2::SecurityGroupIngress",
  "AWS::EC2::SecurityGroupEgress",
  "AWS::EC2::RouteTable",
  "AWS::EC2::Route",
  "AWS::EC2::SubnetRouteTableAssociation",
  "AWS::EC2::VPCGatewayAttachment",
]);

/** A region string (`us-east-1`) sitting inside an ARN or any attr value. */
const REGION_RE = /\b([a-z]{2}-[a-z]+-\d)\b/;

/** Deep-collect the logical node ids a value references via `{$ref:"node.attr"}`.
 * Arrays and nested objects are walked; only the node id (before the dot) is kept. */
function collectRefs(v: unknown, out: Set<string>): void {
  if (!v || typeof v !== "object") return;
  const ref = (v as { $ref?: unknown }).$ref;
  if (typeof ref === "string") out.add(ref.split(".")[0]);
  for (const key of Object.keys(v as Record<string, unknown>)) collectRefs((v as Record<string, unknown>)[key], out);
}

/** First region string found anywhere in a node's attr values, or undefined. */
function regionOf(node: IRNode): string | undefined {
  for (const v of Object.values(node.attrs ?? {})) {
    const m = JSON.stringify(v).match(REGION_RE);
    if (m) return m[1];
  }
  return undefined;
}

/** A concrete string attr, or undefined when it's a `$ref`/intrinsic/absent. */
function strAttr(node: IRNode, key: string): string | undefined {
  const v = node.attrs?.[key];
  return typeof v === "string" ? v : undefined;
}

/** Nearest node id in `want` (a set of node ids) reachable by following `$ref`
 * edges outward from `start` (BFS, so nearest wins — a resource's own subnet is
 * depth 1; RDS reaches its subnet at depth 2 via the DB subnet group). */
function nearestByRef(start: string, want: Set<string>, refOut: Map<string, Set<string>>, maxDepth = 6): string | undefined {
  const seen = new Set([start]);
  let frontier = [...(refOut.get(start) ?? [])];
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (want.has(id)) return id;
      for (const r of refOut.get(id) ?? []) if (!seen.has(r)) next.push(r);
    }
    frontier = next;
  }
  return undefined;
}

/**
 * Project an entity-graph IR into the network/regional view. Pure — returns a new
 * IR (surviving nodes kept by reference so inspect still reads their attrs); the
 * input is untouched. `groups.byNetwork` carries the container boxes.
 */
export function projectNetwork(ir: GraphIR): GraphIR {
  const aws = ir.nodes.filter((n) => n.lexicon === "aws");
  const byId = new Map(aws.map((n) => [n.id, n]));
  const kindOf = new Map(aws.map((n) => [n.id, n.kind]));

  // Outward reference adjacency: what each node points AT, so a BFS lands a
  // resource in the VPC/subnet it references. Built from three sources, because
  // in a multi-stack estate the containment path crosses stack boundaries:
  //   1. `$ref`s in the node's own attrs (in-stack references);
  //   2. the IR's derived edges (includes value-matched wiring — a service to
  //      its security-group parameter, an RDS to its DB subnet group);
  //   3. import↔export bridges — a cross-stack `Parameter` (an import) threaded
  //      to the resource that produces it (the matching export's node), so a
  //      service reaches the foundation stack's VPC through its imported SG id.
  const refOut = new Map<string, Set<string>>();
  const addRef = (from: string, to: string) => {
    if (!byId.has(from) || !byId.has(to) || from === to) return;
    (refOut.get(from) ?? refOut.set(from, new Set()).get(from)!).add(to);
  };
  for (const n of aws) {
    const refs = new Set<string>();
    collectRefs(n.attrs, refs);
    for (const r of refs) addRef(n.id, r);
  }
  for (const e of ir.edges) addRef(e.from, e.to);
  const exportsByName = new Map<string, string[]>();
  for (const ex of ir.exports ?? []) if (ex.node) (exportsByName.get(ex.name) ?? exportsByName.set(ex.name, []).get(ex.name)!).push(ex.node);
  for (const imp of ir.imports ?? []) for (const producer of exportsByName.get(imp.name) ?? []) addRef(imp.node, producer);

  const vpcIds = new Set(aws.filter((n) => n.kind === "AWS::EC2::VPC").map((n) => n.id));
  const subnetIds = new Set(aws.filter((n) => n.kind === "AWS::EC2::Subnet").map((n) => n.id));
  const igwIds = new Set(aws.filter((n) => n.kind === "AWS::EC2::InternetGateway").map((n) => n.id));

  // IGWs have no outward refs — they're bound to a VPC by a gateway attachment
  // that refs both. Pre-resolve igw → vpc from those attachments.
  const igwToVpc = new Map<string, string>();
  for (const n of aws) {
    if (n.kind !== "AWS::EC2::VPCGatewayAttachment") continue;
    const refs = refOut.get(n.id) ?? new Set();
    const igw = [...refs].find((r) => igwIds.has(r));
    const vpc = [...refs].find((r) => vpcIds.has(r));
    if (igw && vpc) igwToVpc.set(igw, vpc);
  }

  // Public subnets: associated (via a SubnetRouteTableAssociation) to a route
  // table that has a Route to an internet gateway. Best-effort; a name heuristic
  // (`…PublicSubnet…`) is the fallback when the route graph doesn't resolve.
  const publicRouteTables = new Set<string>();
  for (const n of aws) {
    if (n.kind !== "AWS::EC2::Route") continue;
    const refs = refOut.get(n.id) ?? new Set();
    if (![...refs].some((r) => igwIds.has(r))) continue;
    for (const r of refs) if (kindOf.get(r) === "AWS::EC2::RouteTable") publicRouteTables.add(r);
  }
  const publicSubnets = new Set<string>();
  for (const n of aws) {
    if (n.kind !== "AWS::EC2::SubnetRouteTableAssociation") continue;
    const refs = refOut.get(n.id) ?? new Set();
    const subnet = [...refs].find((r) => subnetIds.has(r));
    const rt = [...refs].find((r) => kindOf.get(r) === "AWS::EC2::RouteTable");
    if (subnet && rt && publicRouteTables.has(rt)) publicSubnets.add(subnet);
  }
  const subnetScope = (id: string): string => {
    if (publicSubnets.has(id)) return "public";
    if (/public/i.test(id)) return "public";
    if (/private/i.test(id)) return "private";
    return "subnet";
  };

  // Region resolution: a node's own ARN region, else its VPC's, else the one
  // region seen across the estate (single-region collapses to one label).
  const defaultRegion = aws.map(regionOf).find(Boolean) ?? "global";
  const vpcRegion = (vpcId: string): string => (byId.has(vpcId) ? regionOf(byId.get(vpcId)!) ?? defaultRegion : defaultRegion);

  // Container box titles.
  const vpcTitle = (vpcId: string): string => {
    const cidr = strAttr(byId.get(vpcId)!, "CidrBlock");
    return `${vpcRegion(vpcId)} · vpc ${cidr ?? vpcId}`;
  };
  const subnetTitle = (subnetId: string): string => {
    const sub = byId.get(subnetId)!;
    const vpc = nearestByRef(subnetId, vpcIds, refOut);
    const region = vpc ? vpcRegion(vpc) : defaultRegion;
    const vpcCidr = vpc ? strAttr(byId.get(vpc)!, "CidrBlock") : undefined;
    const cidr = strAttr(sub, "CidrBlock");
    const az = strAttr(sub, "AvailabilityZone");
    const vpcPart = vpcCidr ? `vpc ${vpcCidr} · ` : "";
    return `${region} · ${vpcPart}${subnetScope(subnetId)} ${cidr ?? subnetId}${az ? ` (${az})` : ""}`;
  };
  const globalTitle = (region: string): string => `${region} · regional & global`;

  // Assign every kept node to a container. Subnet placement is directed (a
  // resource declares the subnets it sits in); VPC-level is the fallback for
  // things bound to the VPC but not a subnet (IGW, VPC-scoped endpoints).
  const kept = aws.filter((n) => !CONTAINER_KINDS.has(n.kind) && !PROPERTY_KINDS.has(n.kind) && !WIRING_KINDS.has(n.kind));
  const members = new Map<string, string[]>(); // title → node ids, insertion-ordered
  const place = (title: string, id: string) => (members.get(title) ?? members.set(title, []).get(title)!).push(id);

  for (const n of kept) {
    const subnet = nearestByRef(n.id, subnetIds, refOut);
    if (subnet) {
      place(subnetTitle(subnet), n.id);
      continue;
    }
    const vpc = nearestByRef(n.id, vpcIds, refOut) ?? igwToVpc.get(n.id);
    if (vpc) {
      place(vpcTitle(vpc), n.id);
      continue;
    }
    place(globalTitle(regionOf(n) ?? defaultRegion), n.id);
  }

  // Order the boxes readably: region, then VPC boxes (with their subnets), then
  // the region's global lane last. A lexical sort on the titles gets close —
  // "vpc" sorts before the "regional & global" lane inside the same region — so
  // keep it simple and deterministic.
  const orderedTitles = [...members.keys()].sort((a, b) => {
    const ga = /regional & global$/.test(a) ? 1 : 0;
    const gb = /regional & global$/.test(b) ? 1 : 0;
    return ga - gb || a.localeCompare(b);
  });
  const byNetwork: Record<string, string[]> = {};
  for (const t of orderedTitles) byNetwork[t] = members.get(t)!;

  // Connectivity edges. Keep any original edge between two surviving nodes, then
  // contract 1-hop through each wiring node so a dropped listener/SG/route table
  // still connects its kept neighbours (ALB→listener→TG becomes ALB→TG).
  const keptSet = new Set(kept.map((n) => n.id));
  const edges: IREdge[] = [];
  const seen = new Set<string>();
  const addEdge = (from: string, to: string) => {
    if (from === to || !keptSet.has(from) || !keptSet.has(to)) return;
    const [a, b] = from < to ? [from, to] : [to, from];
    const key = `${a}|${b}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind: "ref" });
  };

  // Undirected adjacency over the ORIGINAL edges, for the contraction step.
  const adj = new Map<string, Set<string>>();
  const link = (x: string, y: string) => (adj.get(x) ?? adj.set(x, new Set()).get(x)!).add(y);
  for (const e of ir.edges) {
    link(e.from, e.to);
    link(e.to, e.from);
    if (keptSet.has(e.from) && keptSet.has(e.to)) addEdge(e.from, e.to);
  }
  for (const n of aws) {
    if (!WIRING_KINDS.has(n.kind)) continue;
    const keptNeighbours = [...(adj.get(n.id) ?? [])].filter((id) => keptSet.has(id));
    for (let i = 0; i < keptNeighbours.length; i++)
      for (let j = i + 1; j < keptNeighbours.length; j++) addEdge(keptNeighbours[i], keptNeighbours[j]);
  }

  return { nodes: kept, edges, groups: { byNetwork } as NetworkGroups };
}
