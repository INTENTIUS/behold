/**
 * Azure logical projection (#102) — the architecture diagram for an ARM estate,
 * the Azure counterpart to src/logical.ts's AWS lens:
 *
 *   resource group → VNet → subnet   (network containment, CIDRs as box labels)
 *       ⊃ component                   (the logical grouping — a box per component)
 *           ⊃ resource                (one headline card per composite)
 *
 * Same contract as the AWS lens — a filtered IR plus the `byContainer` nesting
 * pinhole's `layoutArchitecture` turns into nested boundary boxes — and the same
 * component grouping (`componentNamer`, shared from ./logical.ts). What differs
 * is everything about how Azure states containment, and it differs more than the
 * shapes suggest.
 *
 * ## Three things Azure does not do the way AWS does
 *
 * **1. The outermost box is not a declared resource.** An AWS estate declares
 * its VPC, so the lens finds it in the graph. An ARM template deploys *into* a
 * resource group — `resourceGroup()` is resolved at deploy time and there is no
 * `Microsoft.Resources/resourceGroups` node to find. Confirmed against chant's
 * `k8s-aks-microservice` example: 14 azure nodes, not one of them the group they
 * all land in. So the RG box comes from the environment (chant's azure reader
 * uses `resourceGroups/{env}` for exactly this reason), and a caller with no env
 * gets an unnamed group box rather than a fabricated one.
 *
 * **2. Subnets carry their parent in their NAME, not a reference.** A subnet is
 * `Microsoft.Network/virtualNetworks_subnets` named `"<vnet>/<subnet>"` —
 * `aks-microservice-vnet/subnet-1`. The VNet is the first path segment. No ref
 * walk, no bridging: the containment is spelled out in the name, and reading it
 * any other way would be inventing work.
 *
 * **3. Associations are ARM expression STRINGS, not `$ref`s.** A subnet points
 * at its NSG as `"[resourceId('Microsoft.Network/networkSecurityGroups',
 * 'aks-microservice-vnet-nsg')]"` — a template function in a string, which the
 * AWS lens's `collectRefs` (looking for `{$ref}`) cannot see at all. Resolving
 * those is this module's equivalent of `enrichedRefs`, and it is simpler: parse
 * the expression, match by resource NAME.
 *
 * ## What is a box and what is a card
 *
 * #102 lists `Microsoft.Network/*` among the headline kinds, but VNet and subnet
 * cannot be both the boxes and the cards inside them — the AWS lens draws VPC
 * and subnet as boundaries for the same reason. So: VNet and subnet are boxes,
 * NSG and route table are fabric (they annotate, they are not cards), and what
 * survives as a card is the thing an architecture diagram is actually about — a
 * VM, a managed cluster, a load balancer, a public IP, a database, a registry.
 *
 * ## The NSG overlay, honestly
 *
 * #102 says "NSG carries the security overlay", by analogy with the AWS lens
 * deriving directional traffic edges from security-group ingress. That analogy
 * does not carry, and it is worth stating rather than half-implementing:
 *
 * An AWS ingress rule can name **another security group** as its source, which
 * is a resource-to-resource fact and becomes a real edge. An Azure NSG rule
 * names `sourceAddressPrefix` / `destinationAddressPrefix` — a CIDR, `*`, or a
 * service tag like `Internet` or `AzureLoadBalancer`. None of those identify a
 * resource, so there is no resource pair to draw an edge between. (The example's
 * NSG has `securityRules: []` outright.)
 *
 * What an NSG *does* state is which subnets it guards, and that is a containment
 * fact this lens can show truthfully: a guarded subnet's box says so. Deriving
 * traffic edges from CIDR rules would mean inventing pairs, which is the one
 * thing the AWS lens is careful never to do.
 */
import type { GraphIR, IRNode, IREdge } from "@intentius/chant";
import { componentNamer, type ByContainer, type LogicalProjection } from "./logical.ts";

/** Resources an Azure architecture diagram actually shows. Deliberately a tight
 * allowlist, like the AWS lens's — the fabric (VNet, subnet, NSG, route table)
 * becomes boxes or annotation, never cards. */
export const AZURE_HEADLINE_KINDS = new Set([
  // compute / workloads
  "Microsoft.Compute/virtualMachines",
  "Microsoft.Compute/virtualMachineScaleSets",
  "Microsoft.ContainerService/managedClusters",
  "Microsoft.ContainerInstance/containerGroups",
  "Microsoft.Web/sites",
  // network edge
  "Microsoft.Network/publicIPAddresses",
  "Microsoft.Network/loadBalancers",
  "Microsoft.Network/applicationGateways",
  "Microsoft.Network/natGateways",
  "Microsoft.Network/dnsZones",
  // data stores
  "Microsoft.Storage/storageAccounts",
  "Microsoft.Sql/servers",
  "Microsoft.DocumentDB/databaseAccounts",
  "Microsoft.Cache/redis",
  "Microsoft.DBforPostgreSQL/flexibleServers",
  // registry / identity edge
  "Microsoft.ContainerRegistry/registries",
]);

/** Network fabric — the boxes and the wiring between them. Never cards, and
 * never bridged through when contracting edges: every resource in a VNet
 * references the same subnet and route table, so contracting through them would
 * connect everything to everything. Mirrors the AWS lens's NO_CONTRACT_KINDS. */
const AZURE_FABRIC_KINDS = new Set([
  "Microsoft.Network/virtualNetworks",
  "Microsoft.Network/virtualNetworks_subnets",
  "Microsoft.Network/networkSecurityGroups",
  "Microsoft.Network/routeTables",
  "Microsoft.Network/networkInterfaces",
  // identity/authorization hubs — a role assignment or managed identity is
  // referenced by half the estate, so contracting through one invents edges
  // between unrelated resources.
  "Microsoft.Authorization/roleAssignments",
  "Microsoft.ManagedIdentity/userAssignedIdentities",
  "Microsoft.KeyVault/vaults",
]);

const VNET_KIND = "Microsoft.Network/virtualNetworks";
const SUBNET_KIND = "Microsoft.Network/virtualNetworks_subnets";
const NSG_KIND = "Microsoft.Network/networkSecurityGroups";

/** `[resourceId('Microsoft.Network/networkSecurityGroups', 'my-nsg')]` → the
 * quoted arguments. ARM's own expression syntax; the last argument is the
 * resource name, which is what identifies the target here. */
const RESOURCE_ID_RE = /resourceId\(\s*([^)]*)\)/g;
const QUOTED_RE = /'([^']*)'/g;

/** Every resource NAME an ARM expression string refers to. Pure. */
export function resourceIdNames(value: unknown): string[] {
  if (typeof value !== "string" || !value.includes("resourceId(")) return [];
  const out: string[] = [];
  for (const call of value.matchAll(RESOURCE_ID_RE)) {
    const args = [...call[1].matchAll(QUOTED_RE)].map((m) => m[1]);
    // resourceId(type, name[, name…]) — the last argument names the resource.
    if (args.length >= 2) out.push(args[args.length - 1]);
  }
  return out;
}

/** Deep-collect every resource name an attribute tree refers to through ARM
 * expressions, plus any `{$ref}` chant did resolve symbolically. */
function collectAzureRefs(value: unknown, out: Set<string>): void {
  if (value === null || typeof value !== "object") {
    for (const name of resourceIdNames(value)) out.add(name);
    return;
  }
  const ref = (value as { $ref?: unknown }).$ref;
  if (typeof ref === "string") out.add(ref.split(".")[0]);
  for (const v of Object.values(value as Record<string, unknown>)) collectAzureRefs(v, out);
}

function strAttr(node: IRNode, key: string): string | undefined {
  const v = node.attrs?.[key];
  return typeof v === "string" ? v : undefined;
}

/** A node's ARM resource name — what `resourceId(...)` expressions match on. */
function resourceName(node: IRNode): string | undefined {
  return strAttr(node, "name");
}

/** A subnet's parent VNet name — the first segment of `"<vnet>/<subnet>"`. */
export function subnetVnetName(node: IRNode): string | undefined {
  const name = resourceName(node);
  if (!name || !name.includes("/")) return undefined;
  return name.split("/")[0];
}

/** A subnet's own short name — the segment after the VNet. */
function subnetShortName(node: IRNode): string | undefined {
  const name = resourceName(node);
  return name?.includes("/") ? name.split("/").slice(1).join("/") : name;
}

/** The VNet's address space, for the box label. */
function vnetCidr(node: IRNode): string | undefined {
  const space = node.attrs?.addressSpace as { addressPrefixes?: unknown } | undefined;
  const prefixes = space?.addressPrefixes;
  return Array.isArray(prefixes) && typeof prefixes[0] === "string" ? prefixes[0] : undefined;
}

/**
 * Project an Azure entity IR into the logical/architecture view.
 *
 * `env` names the resource group every resource deploys into — see the module
 * note on why it cannot come from the graph. Pure; the input IR is untouched.
 */
export function projectAzureLogical(ir: GraphIR, env?: string): LogicalProjection {
  const azure = ir.nodes.filter((n) => n.lexicon === "azure");
  if (azure.length === 0) return { ir: { nodes: [], edges: [], groups: {} }, byContainer: {} };

  const componentOf = componentNamer(azure);
  const byId = new Map(azure.map((n) => [n.id, n]));
  // ARM expressions identify a resource by NAME, so this is the index that
  // turns `resourceId('…','my-nsg')` back into a node.
  const byName = new Map<string, IRNode>();
  for (const n of azure) {
    const name = resourceName(n);
    if (name && !byName.has(name)) byName.set(name, n);
  }

  const vnets = azure.filter((n) => n.kind === VNET_KIND);
  const subnets = azure.filter((n) => n.kind === SUBNET_KIND);
  const vnetByName = new Map(vnets.map((v) => [resourceName(v) ?? v.id, v]));

  // Outward adjacency: `$ref`s plus ARM `resourceId(...)` names, resolved to ids.
  const refOut = new Map<string, Set<string>>();
  for (const n of azure) {
    const names = new Set<string>();
    collectAzureRefs(n.attrs, names);
    const targets = new Set<string>();
    for (const name of names) {
      const target = byName.get(name) ?? byId.get(name);
      if (target && target.id !== n.id) targets.add(target.id);
    }
    if (targets.size) refOut.set(n.id, targets);
  }
  for (const e of ir.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    (refOut.get(e.from) ?? refOut.set(e.from, new Set()).get(e.from)!).add(e.to);
  }

  // Box titles — synthetic ids that double as titles, as the AWS lens does.
  const RG_TITLE = env ? `resource group ${env}` : "resource group";
  const vnetTitle = (v: IRNode) => `VNet ${vnetCidr(v) ?? resourceName(v) ?? v.id}`;
  const subnetTitle = (s: IRNode) => `subnet ${strAttr(s, "addressPrefix") ?? subnetShortName(s) ?? s.id}`;

  // Which subnets an NSG guards — the honest form of #102's "security overlay"
  // (see the module note on why NSG rules yield no traffic edges).
  const guardedBy = new Map<string, string>(); // subnet id → nsg name
  for (const s of subnets) {
    const names = new Set<string>();
    collectAzureRefs(s.attrs?.networkSecurityGroup, names);
    for (const name of names) {
      if (byName.get(name)?.kind === NSG_KIND) guardedBy.set(s.id, name);
    }
  }

  const headline = azure.filter((n) => AZURE_HEADLINE_KINDS.has(n.kind));

  // Placement: a card's subnet if it references one, else its VNet, else the
  // resource group itself — Azure's equivalent of the AWS lens's global lane,
  // except here the outer box always exists.
  const subnetIds = new Set(subnets.map((s) => s.id));
  const vnetIds = new Set(vnets.map((v) => v.id));
  const nearest = (start: string, want: Set<string>, maxDepth = 6): string | undefined => {
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
  };

  const byContainer: ByContainer = {};
  const child = (parent: string, c: string) => {
    const arr = byContainer[parent] ?? (byContainer[parent] = []);
    if (!arr.includes(c)) arr.push(c);
  };

  // Network boxes: subnet ⊂ VNet ⊂ resource group. Drawn for every declared
  // VNet/subnet, not only the ones holding a card — an empty subnet is a fact
  // about the estate, and the AWS lens omits it only because a VPC with no
  // resources is not something its examples produce.
  for (const v of vnets) child(RG_TITLE, vnetTitle(v));
  for (const s of subnets) {
    const parentVnet = subnetVnetName(s);
    const v = parentVnet ? vnetByName.get(parentVnet) : undefined;
    child(v ? vnetTitle(v) : RG_TITLE, subnetTitle(s));
  }

  const placeOf = new Map<string, string>(); // headline id → box title
  for (const n of headline) {
    const subnetId = nearest(n.id, subnetIds);
    if (subnetId) {
      placeOf.set(n.id, subnetTitle(byId.get(subnetId)!));
      continue;
    }
    const vnetId = nearest(n.id, vnetIds);
    placeOf.set(n.id, vnetId ? vnetTitle(byId.get(vnetId)!) : RG_TITLE);
  }

  // Component boxes, nested in the network place their members share.
  const byComponent = new Map<string, IRNode[]>();
  for (const n of headline) {
    const c = componentOf(n);
    (byComponent.get(c) ?? byComponent.set(c, []).get(c)!).push(n);
  }
  for (const [component, members] of byComponent) {
    const places = new Set(members.map((m) => placeOf.get(m.id)!));
    child(places.size === 1 ? [...places][0] : RG_TITLE, component);
    for (const m of members) child(component, m.id);
  }

  // Contracted connectivity: an edge between two cards, bridged through dropped
  // non-fabric nodes only — so a workload reaches its database, but a shared
  // managed identity never wires unrelated resources together.
  const kept = new Set(headline.map((n) => n.id));
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  for (const [from, tos] of refOut) for (const to of tos) link(from, to);

  const edges: IREdge[] = [];
  const seenEdge = new Set<string>();
  const addEdge = (a: string, b: string) => {
    if (a === b || !kept.has(a) || !kept.has(b)) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ from: a, to: b, kind: "ref" });
  };
  const contractable = (id: string) => !kept.has(id) && !AZURE_FABRIC_KINDS.has(byId.get(id)?.kind ?? "");
  for (const start of kept) {
    const seen = new Set([start]);
    let frontier = [...(adj.get(start) ?? [])];
    for (let depth = 0; depth < 6 && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (kept.has(id)) {
          addEdge(start, id);
          continue; // never route THROUGH another card
        }
        if (!contractable(id)) continue;
        for (const nb of adj.get(id) ?? []) if (!seen.has(nb)) next.push(nb);
      }
      frontier = next;
    }
  }

  // The NSG a subnet is guarded by, carried on the surviving cards in it, so a
  // renderer can annotate without the lens inventing traffic edges.
  const nodes = headline.map((n) => {
    const place = placeOf.get(n.id);
    const guardedSubnet = subnets.find((s) => subnetTitle(s) === place);
    const nsg = guardedSubnet ? guardedBy.get(guardedSubnet.id) : undefined;
    return nsg ? { ...n, attrs: { ...n.attrs, _nsg: nsg } } : n;
  });

  return { ir: { nodes, edges, groups: {} }, byContainer };
}
