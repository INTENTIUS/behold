/**
 * Logical projection (#63) — a traditional AWS architecture diagram as a zoom
 * lens. Two grouping dimensions at once, nested:
 *
 *   region → VPC → subnet   (network containment, CIDRs as box labels)
 *       ⊃ component          (the logical grouping — a box per component)
 *           ⊃ resource       (one headline card per composite, leaves hidden)
 *
 * A pure projection over the rich (detail 3) entity IR, in the same spirit as
 * src/resources.ts. It returns a filtered IR plus a `byContainer` nesting map,
 * which pinhole's `layoutArchitecture` (chant#74) turns into nested boundary
 * boxes with the resource cards inside and the surviving edges routed between
 * them (src/render.ts `renderArchitecture`).
 *
 * The moves that make it an architecture diagram, not the entity graph:
 *   1. COARSE nodes. Only "headline" kinds survive as cards — the load
 *      balancer, the service, the database, the gateway — roughly one per
 *      composite; target groups, listeners, task defs, security groups, roles,
 *      KMS, params, log groups are dropped (used only to route edges).
 *   2. LOGICAL boxes. Survivors group into a box per component (the
 *      `<component>/` a node is declared under), nested inside the network place
 *      (subnet/VPC) that contains them.
 *   3. NETWORK boxes. VPCs and subnets become the outer boxes; their CIDR is the
 *      box label, never a node.
 *   4. CROSS-STACK placement. A consuming stack references the foundation VPC
 *      through a CloudFormation Parameter (an import). The pre-deploy IR has no
 *      symbolic link import→producer (names don't match; subnet ids are
 *      deploy-time intrinsics), so containment is recovered by bridging the ref
 *      graph three ways — see `enrichedRefs`.
 *
 * AWS-lexicon only, by design: an AWS architecture diagram is the wrong shape
 * for k8s or GitHub Actions. Other substrates get their own topology lens later.
 */
import type { GraphIR, IRNode, IREdge } from "@intentius/chant";

/** The container-nesting map pinhole's `layoutArchitecture` consumes:
 * `containerId → memberIds`, where a member may itself be a container id (the
 * nesting). Synthetic string ids double as the box titles. */
export type ByContainer = Record<string, string[]>;

export interface LogicalProjection {
  ir: GraphIR;
  byContainer: ByContainer;
}

// Headline kinds — the resources an architecture diagram actually shows. Roughly
// one per composite (a composite's leaves collapse into it). Everything not
// listed is dropped from the picture (still used to route edges). Deliberately a
// tight allowlist — "even some top-level leaves are too much".
const HEADLINE_KINDS = new Set([
  // network edge / gateways
  "AWS::ElasticLoadBalancingV2::LoadBalancer",
  "AWS::EC2::InternetGateway",
  "AWS::EC2::NatGateway",
  "AWS::EC2::VPCEndpoint",
  "AWS::EC2::VPCEndpointService",
  "AWS::Route53::RecordSet",
  "AWS::CloudFront::Distribution",
  "AWS::ApiGatewayV2::Api",
  "AWS::ApiGateway::RestApi",
  // compute / workloads
  "AWS::ECS::Service",
  "AWS::EC2::Instance",
  "AWS::Lambda::Function",
  "AWS::EKS::Cluster",
  "AWS::BedrockAgentCore::Runtime",
  // data stores
  "AWS::RDS::DBInstance",
  "AWS::RDS::DBCluster",
  "AWS::ElastiCache::CacheCluster",
  "AWS::ElastiCache::ReplicationGroup",
  "AWS::DynamoDB::Table",
  "AWS::EFS::FileSystem",
  "AWS::OpenSearchService::Domain",
  "AWS::S3::Bucket",
  // identity / edge
  "AWS::Cognito::UserPool",
]);

// Workloads (compute) and the data stores they depend on — for the
// data-dependency edge pass. A workload → store link (an app reading a database
// or a bucket) is real, but in a pre-deploy graph it's carried by config a
// generic contraction can't see (a DB endpoint injected as an env var, an S3
// bucket granted by a task role) — so it gets its own pass that reaches through
// anything but only ever accepts a data-store endpoint (never compute→compute).
const WORKLOAD_KINDS = new Set([
  "AWS::ECS::Service",
  "AWS::EC2::Instance",
  "AWS::Lambda::Function",
  "AWS::EKS::Cluster",
  "AWS::BedrockAgentCore::Runtime",
]);
const DATA_STORE_KINDS = new Set([
  "AWS::RDS::DBInstance",
  "AWS::RDS::DBCluster",
  "AWS::S3::Bucket",
  "AWS::DynamoDB::Table",
  "AWS::ElastiCache::CacheCluster",
  "AWS::ElastiCache::ReplicationGroup",
  "AWS::EFS::FileSystem",
  "AWS::OpenSearchService::Domain",
]);

// Never routed THROUGH when contracting edges — bridging across these would wire
// every workload to every other and produce a hairball. Two families:
//   - property hubs: a shared IAM role / KMS key / log group is referenced by
//     half the estate, so contracting through one invents edges between unrelated
//     resources;
//   - containment fabric: the VPC, subnets, route tables and gateway attachments
//     are what *every* resource in the VPC references, so contracting through
//     them connects everything to everything (and to the internet gateway). That
//     relationship is CONTAINMENT — already shown by the nested boxes — not
//     traffic, so it must not become an edge.
// Ordinary dropped wiring (listeners, target groups, parameters, security-group
// ingress) is still contracted through, so the real request path survives
// (ALB → listener → target group → service).
const NO_CONTRACT_KINDS = new Set([
  // property hubs
  "AWS::IAM::Role",
  "AWS::IAM::Policy",
  "AWS::IAM::ManagedPolicy",
  "AWS::IAM::InstanceProfile",
  "AWS::KMS::Key",
  "AWS::KMS::Alias",
  "AWS::Logs::LogGroup",
  "AWS::SecretsManager::Secret",
  "AWS::SSM::Parameter",
  // containment fabric
  "AWS::EC2::VPC",
  "AWS::EC2::Subnet",
  "AWS::EC2::RouteTable",
  "AWS::EC2::Route",
  "AWS::EC2::SubnetRouteTableAssociation",
  "AWS::EC2::VPCGatewayAttachment",
  // security groups — membership isn't traffic (two workloads sharing an SG
  // don't necessarily talk); the directional ingress rules ARE traffic and are
  // derived explicitly below, so contraction must not also bridge through them.
  "AWS::EC2::SecurityGroup",
  "AWS::EC2::SecurityGroupIngress",
]);

const REGION_RE = /\b([a-z]{2}-[a-z]+-\d)\b/;
const WORD_RE = /[A-Za-z][A-Za-z0-9]*/g;

/** A node declared under `examples/…` (byo scaffolding) — excluded from the
 * diagram, and de-prioritised as a cross-stack producer. Mirrors the overlay's
 * `src/examples/` reclassification (src/overlay.ts). */
function isExample(node: IRNode): boolean {
  return (node.sourceLoc?.file ?? "").includes("examples/");
}

/** The component a node belongs to — the first path segment of its declaring
 * file (`shared-foundation/foundation.ts` → `shared-foundation`), the same
 * convention src/resources.ts uses. `other` when there's no usable source loc. */
function componentOf(node: IRNode): string {
  const first = (node.sourceLoc?.file ?? "").split("/")[0];
  return first && first.length ? first : "other";
}

/** Deep-collect the node ids a value references via `{$ref:"node.attr"}`. */
function collectRefs(v: unknown, out: Set<string>): void {
  if (!v || typeof v !== "object") return;
  const ref = (v as { $ref?: unknown }).$ref;
  if (typeof ref === "string") out.add(ref.split(".")[0]);
  for (const key of Object.keys(v as Record<string, unknown>)) collectRefs((v as Record<string, unknown>)[key], out);
}

function regionOf(node: IRNode): string | undefined {
  for (const v of Object.values(node.attrs ?? {})) {
    const m = JSON.stringify(v).match(REGION_RE);
    if (m) return m[1];
  }
  return undefined;
}

function strAttr(node: IRNode, key: string): string | undefined {
  const v = node.attrs?.[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Outward reference adjacency, enriched so containment survives across stack
 * boundaries. Three sources, because in a multi-stack estate a consuming stack's
 * link to the foundation VPC isn't a plain `$ref`:
 *   1. `$ref`s in a node's own attrs (in-stack);
 *   2. the IR's derived edges (value-matched wiring, e.g. RDS→DB subnet group);
 *   3. cross-stack bridges — a `Parameter` (import) threaded to the resource that
 *      produces it. Two ways to find the producer: an export whose name matches
 *      the import handle (chant's canonical import↔export tie, tolerating a
 *      leading `o` output prefix); or, when the handle is mangled, a known export
 *      name appearing as a token in the Parameter's description. Non-example
 *      producers win when a handle is exported by more than one stack.
 */
function enrichedRefs(ir: GraphIR, aws: IRNode[], byId: Map<string, IRNode>): Map<string, Set<string>> {
  const refOut = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    if (!byId.has(from) || !byId.has(to) || from === to) return;
    (refOut.get(from) ?? refOut.set(from, new Set()).get(from)!).add(to);
  };
  for (const n of aws) {
    const refs = new Set<string>();
    collectRefs(n.attrs, refs);
    for (const r of refs) add(n.id, r);
  }
  for (const e of ir.edges) add(e.from, e.to);

  // Producers by export name (non-example first, so a real foundation wins over
  // a byo example that exports the same handle).
  const producersByName = new Map<string, string[]>();
  for (const ex of ir.exports ?? []) {
    if (!ex.node || !byId.has(ex.node)) continue;
    const list = producersByName.get(ex.name) ?? producersByName.set(ex.name, []).get(ex.name)!;
    if (isExample(byId.get(ex.node)!)) list.push(ex.node);
    else list.unshift(ex.node);
  }
  const exportNames = [...producersByName.keys()].sort((a, b) => b.length - a.length); // longest-first for the token scan
  const bridge = (paramId: string, producers: string[] | undefined) => {
    if (producers && producers.length) add(paramId, producers[0]);
  };
  for (const imp of ir.imports ?? []) {
    const handle = imp.name.toLowerCase();
    bridge(imp.node, producersByName.get(imp.name) ?? [...producersByName].find(([k]) => k.toLowerCase() === handle || k.toLowerCase() === "o" + handle)?.[1]);
  }
  // Description scan: a Parameter whose description names a known export.
  for (const n of aws) {
    if (n.kind !== "AWS::CloudFormation::Parameter") continue;
    const desc = strAttr(n, "description");
    if (!desc) continue;
    const toks = new Set(desc.match(WORD_RE) ?? []);
    const hit = exportNames.find((name) => toks.has(name));
    if (hit) bridge(n.id, producersByName.get(hit));
  }
  return refOut;
}

/** Nearest node id in `want` reachable by following refs outward from `start`
 * (BFS — a resource's own subnet is depth 1; RDS reaches its subnet via the DB
 * subnet group; a consumer reaches the foundation VPC via a bridged parameter). */
function nearestByRef(start: string, want: Set<string>, refOut: Map<string, Set<string>>, maxDepth = 8): string | undefined {
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
 * Project the entity IR into the logical/architecture view. Returns the filtered
 * IR (headline cards + contracted edges) and the `byContainer` nesting for
 * pinhole's `layoutArchitecture`. Pure; the input IR is untouched.
 */
export function projectLogical(ir: GraphIR): LogicalProjection {
  const aws = ir.nodes.filter((n) => n.lexicon === "aws" && !isExample(n));
  const byId = new Map(aws.map((n) => [n.id, n]));
  const refOut = enrichedRefs(ir, aws, byId);

  const vpcIds = new Set(aws.filter((n) => n.kind === "AWS::EC2::VPC").map((n) => n.id));
  const subnetIds = new Set(aws.filter((n) => n.kind === "AWS::EC2::Subnet").map((n) => n.id));
  const igwIds = new Set(aws.filter((n) => n.kind === "AWS::EC2::InternetGateway").map((n) => n.id));

  // IGWs have no outward refs — a gateway attachment (refs both) binds them.
  const igwToVpc = new Map<string, string>();
  for (const n of aws) {
    if (n.kind !== "AWS::EC2::VPCGatewayAttachment") continue;
    const refs = refOut.get(n.id) ?? new Set();
    const igw = [...refs].find((r) => igwIds.has(r));
    const vpc = [...refs].find((r) => vpcIds.has(r));
    if (igw && vpc) igwToVpc.set(igw, vpc);
  }

  // Public subnets: a route to an internet gateway from an associated table.
  const publicRouteTables = new Set<string>();
  for (const n of aws) {
    if (n.kind !== "AWS::EC2::Route") continue;
    const refs = refOut.get(n.id) ?? new Set();
    if (![...refs].some((r) => igwIds.has(r))) continue;
    for (const r of refs) if (byId.get(r)?.kind === "AWS::EC2::RouteTable") publicRouteTables.add(r);
  }
  const publicSubnets = new Set<string>();
  for (const n of aws) {
    if (n.kind !== "AWS::EC2::SubnetRouteTableAssociation") continue;
    const refs = refOut.get(n.id) ?? new Set();
    const subnet = [...refs].find((r) => subnetIds.has(r));
    const rt = [...refs].find((r) => byId.get(r)?.kind === "AWS::EC2::RouteTable");
    if (subnet && rt && publicRouteTables.has(rt)) publicSubnets.add(subnet);
  }
  const subnetScope = (id: string): string => (publicSubnets.has(id) || /public/i.test(id) ? "public" : /private/i.test(id) ? "private" : "subnet");

  // Region from an ARN somewhere in the estate — undefined in a pure source
  // graph (ids are all `$ref`s), resolved in the live overlay. Prefixed onto the
  // VPC box title only when known, so source reads "VPC 10.0.0.0/16" not the
  // confusing "global · VPC …".
  const defaultRegion = aws.map(regionOf).find(Boolean);
  const regionForVpc = (vpcId: string) => (byId.has(vpcId) ? regionOf(byId.get(vpcId)!) ?? defaultRegion : defaultRegion);

  // Network place box titles (synthetic ids that double as titles).
  const vpcTitle = (vpcId: string) => {
    const region = regionForVpc(vpcId);
    return `${region ? region + " · " : ""}VPC ${strAttr(byId.get(vpcId)!, "CidrBlock") ?? vpcId}`;
  };
  const subnetTitle = (subnetId: string) => `${subnetScope(subnetId)} subnet ${strAttr(byId.get(subnetId)!, "CidrBlock") ?? subnetId}`;
  const GLOBAL = "regional & global";

  // Placement per headline node: its subnet (if resolvable), else its VPC, else
  // the global lane.
  const headline = aws.filter((n) => HEADLINE_KINDS.has(n.kind));
  type Place = { kind: "subnet"; subnet: string; vpc?: string } | { kind: "vpc"; vpc: string } | { kind: "global" };
  const placeOf = new Map<string, Place>();
  for (const n of headline) {
    const subnet = nearestByRef(n.id, subnetIds, refOut);
    if (subnet) placeOf.set(n.id, { kind: "subnet", subnet, vpc: nearestByRef(subnet, vpcIds, refOut) });
    else {
      const vpc = nearestByRef(n.id, vpcIds, refOut) ?? igwToVpc.get(n.id);
      placeOf.set(n.id, vpc ? { kind: "vpc", vpc } : { kind: "global" });
    }
  }

  // Build the nesting. Each component becomes a box, nested in the network place
  // that holds its resources: a subnet if they all share one, else their VPC,
  // else the global lane. Network place boxes nest subnet ⊂ VPC.
  const byContainer: ByContainer = {};
  const child = (parent: string, c: string) => {
    const arr = byContainer[parent] ?? (byContainer[parent] = []);
    if (!arr.includes(c)) arr.push(c);
  };
  const ensureSubnet = (subnetId: string, vpcId?: string) => {
    const t = subnetTitle(subnetId);
    if (vpcId) child(vpcTitle(vpcId), t); // subnet ⊂ VPC
    return t;
  };

  const byComponent = new Map<string, IRNode[]>();
  for (const n of headline) (byComponent.get(componentOf(n)) ?? byComponent.set(componentOf(n), []).get(componentOf(n))!).push(n);

  for (const [component, members] of byComponent) {
    const places = members.map((m) => placeOf.get(m.id)!);
    // The component box's home: a shared subnet if every member sits in the same
    // one, else a shared/any VPC, else the global lane.
    const subnets = new Set(places.map((p) => (p.kind === "subnet" ? p.subnet : "")));
    const vpcs = new Set(places.map((p) => (p.kind === "subnet" ? p.vpc : p.kind === "vpc" ? p.vpc : undefined)).filter((v): v is string => !!v));
    let parent: string;
    if (subnets.size === 1 && !subnets.has("")) {
      const p = places[0] as Extract<Place, { kind: "subnet" }>;
      parent = ensureSubnet(p.subnet, p.vpc);
    } else if (vpcs.size >= 1) {
      parent = vpcTitle([...vpcs][0]);
    } else {
      parent = GLOBAL;
    }
    child(parent, component);
    for (const m of members) child(component, m.id);
  }

  // Contracted connectivity: keep any original edge between two headline nodes,
  // and bridge headline nodes joined by a path through only dropped, non-hub
  // nodes (so ALB→listener→target-group→(cross-stack)→service survives, but a
  // shared IAM role never wires unrelated workloads). Undirected, deduped.
  const keptSet = new Set(headline.map((n) => n.id));
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  for (const [from, tos] of refOut) for (const to of tos) link(from, to);

  const edges: IREdge[] = [];
  const seenEdge = new Set<string>();
  const addEdge = (a: string, b: string, via?: string) => {
    if (a === b || !keptSet.has(a) || !keptSet.has(b)) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ from: a, to: b, kind: "ref", ...(via ? { viaAttr: via } : {}) });
  };

  // Security-group ingress — the first-class traffic signal. An ingress rule
  // whose source is ANOTHER security group means the source SG's resources may
  // open connections to the target SG's resources: real, directional traffic
  // (ALB SG → ECS SG; an app SG → a DB SG). Emitted BEFORE contraction so the
  // pair reads as a directed traffic edge (source → target = initiator →
  // acceptor) rather than an undirected reference. CIDR-sourced ingress (a DB
  // open to the VPC range, say) names no specific source resource, so it yields
  // no edge — that stays containment, not a hairball.
  const isSg = (id: string) => byId.get(id)?.kind === "AWS::EC2::SecurityGroup";
  const firstRef = (v: unknown): string | undefined => {
    const s = new Set<string>();
    collectRefs(v, s);
    return [...s].find((id) => byId.has(id));
  };
  // Which security groups each headline resource is attached to — resolved
  // through cross-stack `Parameter` bridges (a service's SG arrives as an import).
  const sgsOf = (start: string): Set<string> => {
    const out = new Set<string>();
    const seen = new Set([start]);
    let frontier = [...(refOut.get(start) ?? [])];
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (isSg(id)) out.add(id);
        else if (byId.get(id)?.kind === "AWS::CloudFormation::Parameter") for (const r of refOut.get(id) ?? []) next.push(r);
      }
      frontier = next;
    }
    return out;
  };
  const sgMembers = new Map<string, Set<string>>(); // sg id → headline ids in it
  for (const n of headline) for (const sg of sgsOf(n.id)) (sgMembers.get(sg) ?? sgMembers.set(sg, new Set()).get(sg)!).add(n.id);
  // Ingress rules → (sourceSg, targetSg): inline on a SecurityGroup, or a
  // standalone SecurityGroupIngress node (GroupId = target, source = ref).
  const ingress: Array<[string, string]> = [];
  for (const n of aws) {
    if (n.kind === "AWS::EC2::SecurityGroup") {
      const rules = n.attrs?.SecurityGroupIngress;
      for (const r of Array.isArray(rules) ? rules : rules ? [rules] : []) {
        const src = firstRef((r as { SourceSecurityGroupId?: unknown })?.SourceSecurityGroupId);
        if (src && isSg(src)) ingress.push([src, n.id]);
      }
    } else if (n.kind === "AWS::EC2::SecurityGroupIngress") {
      const src = firstRef(n.attrs?.SourceSecurityGroupId);
      const tgt = firstRef(n.attrs?.GroupId);
      if (src && tgt && isSg(src) && isSg(tgt)) ingress.push([src, tgt]);
    }
  }
  for (const [src, tgt] of ingress)
    for (const rs of sgMembers.get(src) ?? []) for (const rt of sgMembers.get(tgt) ?? []) addEdge(rs, rt, "security-group ingress");

  const contractable = (id: string) => !keptSet.has(id) && !NO_CONTRACT_KINDS.has(byId.get(id)?.kind ?? "");
  for (const start of keptSet) {
    // BFS to other headline nodes through contractable (dropped, non-hub) nodes.
    const seen = new Set([start]);
    let frontier = [...(adj.get(start) ?? [])];
    for (let depth = 0; depth < 8 && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (keptSet.has(id)) {
          addEdge(start, id);
          continue; // don't route through another headline node
        }
        if (!contractable(id)) continue;
        for (const nb of adj.get(id) ?? []) if (!seen.has(nb)) next.push(nb);
      }
      frontier = next;
    }
  }

  // Data-dependency pass — a workload → a data store it can reach. Unlike the
  // compute contraction above this DELIBERATELY reaches through the containment
  // fabric and IAM grants (a DB endpoint injected via config, an S3 bucket
  // granted by a task role), because that's the only trail those links leave in
  // a pre-deploy graph. It stays clean because it only ever ACCEPTS a data-store
  // endpoint — never a compute or gateway node — so it draws "app uses the
  // database / bucket" without the mesh-to-everything those fabric paths caused.
  for (const w of headline) {
    if (!WORKLOAD_KINDS.has(w.kind)) continue;
    const seen = new Set([w.id]);
    let frontier = [...(adj.get(w.id) ?? [])];
    for (let depth = 0; depth < 6 && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (keptSet.has(id)) {
          if (DATA_STORE_KINDS.has(byId.get(id)?.kind ?? "")) addEdge(w.id, id, "data dependency");
          continue; // never route THROUGH a headline node
        }
        for (const nb of adj.get(id) ?? []) if (!seen.has(nb)) next.push(nb);
      }
      frontier = next;
    }
  }

  return { ir: { nodes: headline, edges, groups: {} }, byContainer };
}
