/**
 * GCP logical projection (#101) — the third topology lens, and the one that is
 * deliberately not shaped like the other two:
 *
 *   project → location → component ⊃ resource
 *
 * ## Why not network containment
 *
 * The AWS lens nests `region → VPC → subnet` and the Azure lens
 * `resource group → VNet → subnet`, because on both substrates a resource sits
 * *inside* a network the estate declares. #101 settles that GCP does not get
 * that shape, and models `projects/{p}/locations/{loc}/…` instead — the
 * hierarchy the resources themselves carry.
 *
 * Worth recording precisely, because the source graph looks like it disagrees:
 * chant's GCP lexicon **can** express networking, and the canonical example
 * declares `GCP::Compute::Network`, two `Subnetwork`s, a `Router`, a `RouterNAT`
 * and two `Firewall`s. What is missing is on the other side — floci-gcp emulates
 * no compute networking at all, so none of it is ever observed. A live overlay
 * would draw subnet boxes that stayed permanently empty.
 *
 * So the data for a network lens exists on the declared side and never on the
 * live side. If that changes, this module has the pieces; the fabric list below
 * is where those kinds are named today.
 *
 * ## Where the boxes come from
 *
 * **Project** is not a declared resource. CNRM carries it as the
 * `cnrm.cloud.google.com/project-id` annotation, which chant emits as an
 * intrinsic resolved at deploy time — so a source graph has a placeholder, not
 * a value. Same situation as Azure's resource group, and handled the same way:
 * the caller's environment names it, and an unnamed project box is better than
 * a fabricated id.
 *
 * **Location** is a plain string on each resource (`location: "us-central1"`),
 * so it needs no resolution at all. A resource with none is global — an IAM
 * service account and a DNS zone genuinely are — and gets its own lane rather
 * than being forced into a region it does not live in.
 */
import type { GraphIR, IRNode, IREdge } from "@intentius/chant";
import { componentNamer, type ByContainer, type LogicalProjection } from "./logical.ts";

/**
 * Resources a GCP architecture diagram shows. #101 names the first four; the
 * last two are here because a VM and a managed DNS zone are headline resources
 * on any substrate, and leaving them out would drop them from the picture
 * entirely rather than nest them somewhere.
 */
export const GCP_HEADLINE_KINDS = new Set([
  "GCP::Container::Cluster",
  "GCP::Run::Service",
  "GCP::Sql::Instance",
  "GCP::Storage::Bucket",
  "GCP::Compute::Instance",
  "GCP::Dns::ManagedZone",
]);

/**
 * Fabric and hubs — never cards, and never bridged through when contracting
 * edges.
 *
 * The networking kinds are here rather than absent: they are real, declared,
 * and unobservable on floci-gcp (see the module note). Listing them keeps them
 * out of the picture without pretending chant cannot express them.
 *
 * The IAM kinds are hubs in the AWS sense — one service account is referenced by
 * half the estate, so contracting through it would wire unrelated resources to
 * each other. A node pool is capacity, not a thing a workload is scheduled onto,
 * the same call the cluster-anchor makes for an AWS node group.
 */
const GCP_FABRIC_KINDS = new Set([
  // networking — declared, not emulated
  "GCP::Compute::Network",
  "GCP::Compute::Subnetwork",
  "GCP::Compute::Firewall",
  "GCP::Compute::Router",
  "GCP::Compute::RouterNAT",
  // identity hubs
  "GCP::Iam::ServiceAccount",
  "GCP::Iam::PolicyMember",
  "GCP::Iam::CustomRole",
  // capacity, not a workload host
  "GCP::Container::NodePool",
  // chant's own annotation carrier
  "chant:gcp:defaultAnnotations",
]);

/** The CNRM annotation that names the project a resource deploys into. */
const PROJECT_ID_ANNOTATION = "cnrm.cloud.google.com/project-id";

function strAttr(node: IRNode, key: string): string | undefined {
  const v = node.attrs?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * The project id, if any node states it as a literal.
 *
 * chant emits the annotation as an intrinsic (`{$intrinsic: true}`) resolved at
 * deploy time, so this is usually undefined on a source graph and the caller's
 * environment supplies the name instead. Read anyway, because a project pinned
 * literally in source is a better label than an environment name.
 */
export function declaredProject(nodes: readonly IRNode[]): string | undefined {
  for (const n of nodes) {
    const annotations = (n.attrs?.annotations ?? (n.attrs?.metadata as Record<string, unknown> | undefined)?.annotations) as
      | Record<string, unknown>
      | undefined;
    const value = annotations?.[PROJECT_ID_ANNOTATION];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Deep-collect the node ids a value references via `{$ref:"node.attr"}`. */
function collectRefs(v: unknown, out: Set<string>): void {
  if (!v || typeof v !== "object") return;
  const ref = (v as { $ref?: unknown }).$ref;
  if (typeof ref === "string") out.add(ref.split(".")[0]);
  for (const key of Object.keys(v as Record<string, unknown>)) collectRefs((v as Record<string, unknown>)[key], out);
}

/**
 * Project a GCP entity IR into the logical/architecture view.
 *
 * `env` names the project when source does not pin one — see the module note on
 * why it cannot come from the graph. Pure; the input IR is untouched.
 */
export function projectGcpLogical(ir: GraphIR, env?: string): LogicalProjection {
  const gcp = ir.nodes.filter((n) => n.lexicon === "gcp");
  if (gcp.length === 0) return { ir: { nodes: [], edges: [], groups: {} }, byContainer: {} };

  const componentOf = componentNamer(gcp);
  const byId = new Map(gcp.map((n) => [n.id, n]));

  const project = declaredProject(gcp) ?? env;
  const PROJECT_TITLE = project ? `project ${project}` : "project";
  const GLOBAL = "global";
  const locationTitle = (loc: string) => `location ${loc}`;

  // Outward adjacency for edge contraction: `$ref`s plus the IR's own edges.
  const refOut = new Map<string, Set<string>>();
  for (const n of gcp) {
    const refs = new Set<string>();
    collectRefs(n.attrs, refs);
    const targets = new Set<string>();
    for (const r of refs) if (byId.has(r) && r !== n.id) targets.add(r);
    if (targets.size) refOut.set(n.id, targets);
  }
  for (const e of ir.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    (refOut.get(e.from) ?? refOut.set(e.from, new Set()).get(e.from)!).add(e.to);
  }

  const headline = gcp.filter((n) => GCP_HEADLINE_KINDS.has(n.kind));

  const byContainer: ByContainer = {};
  const child = (parent: string, c: string) => {
    const arr = byContainer[parent] ?? (byContainer[parent] = []);
    if (!arr.includes(c)) arr.push(c);
  };

  // Location boxes for every region the estate actually names — including ones
  // holding no headline card, since a declared region is a fact about the
  // estate.
  const locations = new Set<string>();
  for (const n of gcp) {
    const loc = strAttr(n, "location");
    if (loc) locations.add(loc);
  }
  for (const loc of [...locations].sort()) child(PROJECT_TITLE, locationTitle(loc));

  // A card's home: its own location, else the global lane. There is no
  // containment to resolve — GCP resources state their region directly.
  const placeOf = new Map<string, string>();
  for (const n of headline) {
    const loc = strAttr(n, "location");
    placeOf.set(n.id, loc ? locationTitle(loc) : GLOBAL);
  }

  // Component boxes, nested in the place their members share.
  const byComponent = new Map<string, IRNode[]>();
  for (const n of headline) {
    const c = componentOf(n);
    (byComponent.get(c) ?? byComponent.set(c, []).get(c)!).push(n);
  }
  for (const [component, members] of byComponent) {
    const places = new Set(members.map((m) => placeOf.get(m.id)!));
    // A component spanning regions belongs to neither, so it sits at the
    // project — the same rule the AWS lens uses for a component spanning
    // subnets.
    const parent = places.size === 1 ? [...places][0] : PROJECT_TITLE;
    if (parent === GLOBAL) child(PROJECT_TITLE, GLOBAL);
    child(parent, component);
    for (const m of members) child(component, m.id);
  }

  // Contracted connectivity between cards, bridged only through dropped
  // non-fabric nodes — so a workload reaches its database, and a shared service
  // account never wires unrelated resources together.
  const kept = new Set(headline.map((n) => n.id));
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  for (const [from, tos] of refOut) for (const to of tos) link(from, to);

  const edges: IREdge[] = [];
  const seen = new Set<string>();
  const addEdge = (a: string, b: string) => {
    if (a === b || !kept.has(a) || !kept.has(b)) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: a, to: b, kind: "ref" });
  };
  const contractable = (id: string) => !kept.has(id) && !GCP_FABRIC_KINDS.has(byId.get(id)?.kind ?? "");
  for (const start of kept) {
    const walked = new Set([start]);
    let frontier = [...(adj.get(start) ?? [])];
    for (let depth = 0; depth < 6 && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (walked.has(id)) continue;
        walked.add(id);
        if (kept.has(id)) {
          addEdge(start, id);
          continue; // never route THROUGH another card
        }
        if (!contractable(id)) continue;
        for (const nb of adj.get(id) ?? []) if (!walked.has(nb)) next.push(nb);
      }
      frontier = next;
    }
  }

  return { ir: { nodes: headline, edges, groups: {} }, byContainer };
}
