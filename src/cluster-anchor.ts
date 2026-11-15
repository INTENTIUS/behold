/**
 * Cross-substrate anchoring (#103) — connect a managed cluster to the k8s
 * workloads that run on it, and give those workloads their namespace structure.
 *
 * ## What this issue turned out to be
 *
 * #103 was filed as "preserve the IR's cross-provider edges in `--live`", on the
 * premise (from #74) that the source graph already composes cross-substrate and
 * only the live overlay drops the edges at the substrate boundary. Checked
 * against all three CC mixed examples before writing any of this, and the
 * premise does not hold — there is nothing being dropped, because the edges were
 * never drawn:
 *
 * | example (chant) | nodes | edges | cross-substrate |
 * |---|---|---|---|
 * | `k8s-eks-microservice`  | 51 aws + 36 k8s   | 55 | 0 |
 * | `k8s-gke-microservice`  | 23 gcp + 28 k8s   |  0 | 0 |
 * | `k8s-aks-microservice`  | 14 azure + 22 k8s |  0 | 0 |
 *
 * There is no declared tie to preserve. A k8s Service carries no reference to
 * the EKS cluster it lands on; the relationship is operational (it is whichever
 * cluster the kubeconfig points at), so it leaves no `$ref` in the source graph.
 * The live overlay is source-anchored (chant#821), so it faithfully reproduces
 * a graph that never had the edge.
 *
 * The eks row also shows the second half of the problem: all 55 edges are
 * aws → aws. The k8s half has **zero** internal edges — 36 nodes, none of them
 * connected to any other. So "behold observes both substrates in one graph"
 * (the done-bar every E slot carries) was, before this, a connected cloud
 * component next to a field of loose k8s nodes. Anchoring the cluster alone
 * would have produced a 36-spoke star, which is connected but not a picture of
 * anything.
 *
 * ## What this does instead
 *
 * Recovers the hierarchy Kubernetes actually has, all of it from declared
 * attributes — no live read, no `--live` requirement, so the source graph and
 * the overlay get the same structure:
 *
 *   managed cluster → namespace → namespaced resource
 *   managed cluster → cluster-scoped resource   (ClusterRole, StorageClass, …)
 *
 * `metadata.namespace` is a declared literal on every namespaced object, and a
 * declared `Namespace` carries its own `metadata.name`, so the middle tier is a
 * plain join. A namespaced resource whose namespace is not declared in this
 * project hangs off the cluster directly rather than being dropped.
 *
 * ## Where it declines to guess
 *
 * Anchoring needs an unambiguous cluster. With two managed clusters declared in
 * one project there is no attribute saying which one a given Service lands on —
 * that is what the kubeconfig decides at deploy time, which is #106's job — so
 * this emits nothing rather than picking one. Same discipline as
 * src/value-match.ts: infer only where the answer is forced.
 *
 * A project with no k8s nodes, or no managed cluster, is untouched.
 *
 * ## The cluster join (behold#1080)
 *
 * When the estate was read through chant's reference catalog (chant 0.124.98,
 * src/reference-catalog.ts), a member whose Argo CD Applications name a cluster
 * Secret has said which cluster its objects run on, and chant's rules
 * (INTENTIUS/chant#5101) join the Secret to the cluster resource whose name it
 * registers. That answer replaces the guess for that member's objects:
 *
 *  - one cluster resource: the member's objects anchor to it, and to no other,
 *    however many clusters the estate declares;
 *  - the Secret's name matches no cluster resource, or matches several, or the
 *    member's Applications reach more than one cluster: nothing anchors, and a
 *    note says why. The guess is not made either, since the join has the
 *    answer and the answer is that there is none to give.
 *
 * A member with no cluster Secret keeps the guess above.
 */
import type { GraphIR, IRNode } from "@intentius/chant";
import { contextBindsCluster } from "./k8s-target.ts";
import { catalogOfIr, type CatalogIr, type IrCatalog } from "./reference-catalog.ts";

/**
 * Managed-cluster kinds across the three cloud lexicons — the node a k8s
 * workload runs *on*. Deliberately the control-plane resource only: a node
 * group / node pool is capacity, not the thing a Service is scheduled onto.
 *
 * `K3d::Cluster` joins them: a declared local k3d cluster is exactly as much
 * "the thing the k8s half runs on" as an EKS control plane — the
 * fountain-ops/kubemicrovm-ops estates declare one in their `cluster/` build
 * root (merged by src/cluster-root.ts), and before this the k8s half rendered
 * inside a synthetic `cluster <env>` box while the declared cluster floated
 * beside it as an unrelated card.
 */
export const MANAGED_CLUSTER_KINDS = new Set([
  "AWS::EKS::Cluster",
  "GCP::Container::Cluster",
  "Microsoft.ContainerService/managedClusters",
  "K3d::Cluster",
]);

/** Edge tag carried by every anchor this module adds, so a viewer can style
 * cross-substrate containment apart from declared wiring (and so a test can
 * assert on it without matching node ids). */
export const ANCHOR_VIA = "runs-on";

interface AnchorNode {
  id: string;
  kind: string;
  lexicon?: string;
  attrs?: Record<string, unknown>;
}

/** A node's `metadata` block, when it has one shaped like Kubernetes'. */
function metadata(node: AnchorNode): Record<string, unknown> | undefined {
  const m = node.attrs?.metadata;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : undefined;
}

/** A declared string on `metadata`, ignoring the `{$ref}` placeholders chant
 * emits for a resource's own read-back attributes. */
function metaString(node: AnchorNode, key: string): string | undefined {
  const v = metadata(node)?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function isK8s(node: AnchorNode): boolean {
  return node.lexicon === "k8s";
}

function isNamespace(node: AnchorNode): boolean {
  return node.kind === "K8s::Core::Namespace";
}

/**
 * The single managed cluster this project's k8s half runs on, or undefined when
 * there is no cluster or more than one (see the module note on declining to
 * guess).
 */
export function soleManagedCluster(nodes: readonly IRNode[]): IRNode | undefined {
  const clusters = nodes.filter((n) => MANAGED_CLUSTER_KINDS.has(n.kind));
  return clusters.length === 1 ? clusters[0] : undefined;
}

/** The cluster name a managed-cluster node declares: `metadata.name` for the
 * k8s-shaped kinds (k3d), a scalar `name`/`clusterName` attr for the cloud
 * control planes, else the node id. */
export function managedClusterName(node: AnchorNode): string {
  const metaName = metaString(node, "name");
  if (metaName) return metaName;
  for (const key of ["name", "clusterName"]) {
    const v = node.attrs?.[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return node.id;
}

/**
 * The managed cluster the k8s half runs on, with the kube context as the
 * tiebreak (#106's `contextBindsCluster`, finally wired).
 *
 * One declared cluster answers by itself — the pre-existing rule. Two or more
 * used to be an unconditional decline, which is honest for the cloud kinds but
 * wrong for the local-substrate estates: fountain-ops declares TWO k3d
 * clusters (`fountain-local` plus a deliberately-foreign stand-in), yet the
 * bound kubeconfig context names exactly which one the reads land on. So with
 * a context to compare, the candidate it binds wins — and only when it binds
 * exactly one. No context, or an ambiguous match, still declines.
 */
export function boundManagedCluster(nodes: readonly IRNode[], boundContext?: string): IRNode | undefined {
  const clusters = nodes.filter((n) => MANAGED_CLUSTER_KINDS.has(n.kind));
  if (clusters.length === 1) return clusters[0];
  if (clusters.length === 0 || !boundContext) return undefined;
  const bound = clusters.filter((n) => contextBindsCluster(boundContext, managedClusterName(n)));
  return bound.length === 1 ? bound[0] : undefined;
}

/** The rule that joins a cluster Secret to the cluster resource it registers (INTENTIUS/chant#5101). */
const REGISTERS_RULE = /:argoCluster\.name$/;
/** The rules that join an Application, or the Applications an ApplicationSet makes, to the cluster Secret they deploy to. */
const DEPLOYS_RULE = /K8s::Argo::(Application:spec\.destination\.(name|server)|ApplicationSet:generators\[\]\.clusters)$/;

/** What the catalog says about one member's cluster. */
interface MemberCluster {
  /** The cluster resources its Secrets register, by node id. */
  clusters: Set<string>;
  /** Reasons nothing can be anchored, as notes. */
  problems: string[];
}

/** The member a node is in: its `byStack` box, else the prefix of its id. */
function memberOf(ir: GraphIR): (id: string) => string {
  const box = new Map<string, string>();
  for (const [name, ids] of Object.entries((ir.groups.byStack ?? {}) as Record<string, string[]>)) for (const id of ids) if (!box.has(id)) box.set(id, name);
  return (id) => box.get(id) ?? id.split("/")[0] ?? "";
}

/**
 * What chant's cluster join says each member runs on. A member appears when one
 * of its nodes holds an Application's reference to a cluster Secret, or is a
 * cluster Secret itself (one that registers a cluster, rightly or not).
 */
export function memberClusters(ir: GraphIR, catalog: IrCatalog): Map<string, MemberCluster> {
  const member = memberOf(ir);
  const secrets = new Map<string, Set<string>>(); // Secret id -> members that rely on it
  const rely = (secret: string, m: string): void => void (secrets.get(secret) ?? secrets.set(secret, new Set()).get(secret)!).add(m);
  const edges = ir.edges as Array<{ from: string; to: string; rule?: string; origin?: string; viaAttr?: string }>;
  const registered = new Map<string, Set<string>>(); // Secret id -> cluster resources
  const register = (secret: string, cluster: string): void => void (registered.get(secret) ?? registered.set(secret, new Set()).get(secret)!).add(cluster);
  for (const e of edges) {
    if (typeof e.rule === "string" && DEPLOYS_RULE.test(e.rule)) rely(e.to, member(e.from));
    if (typeof e.rule === "string" && REGISTERS_RULE.test(e.rule)) {
      register(e.from, e.to);
      rely(e.from, member(e.from));
    }
  }
  for (const r of catalog.runsOn) {
    register(r.from, r.to);
    rely(r.from, member(r.from));
  }
  for (const d of catalog.dangling) if (REGISTERS_RULE.test(d.rule)) rely(d.from, member(d.from));
  for (const a of catalog.ambiguous) if (REGISTERS_RULE.test(a.rule)) rely(a.from, member(a.from));

  const out = new Map<string, MemberCluster>();
  for (const [secret, members] of secrets) {
    const dangling = catalog.dangling.filter((d) => d.from === secret && REGISTERS_RULE.test(d.rule));
    const ambiguous = catalog.ambiguous.filter((a) => a.from === secret && REGISTERS_RULE.test(a.rule));
    for (const m of members) {
      const entry = out.get(m) ?? out.set(m, { clusters: new Set(), problems: [] }).get(m)!;
      for (const c of registered.get(secret) ?? []) entry.clusters.add(c);
      const resolved = (registered.get(secret)?.size ?? 0) > 0;
      for (const d of dangling) if (!resolved) entry.problems.push(`cluster Secret ${secret} registers cluster "${d.value}", which no cluster resource names (${d.rule})`);
      for (const a of ambiguous) entry.problems.push(`cluster Secret ${secret} registers cluster "${a.value}", which ${a.candidates.length} cluster resources name (${a.candidates.join(", ")})`);
    }
  }
  return out;
}

/**
 * Add `runs-on` anchor edges: cluster → namespace → namespaced resource, and
 * cluster → cluster-scoped resource. Mutates + returns `ir`, matching
 * `addValueMatchEdges`'s contract so the two compose in the same pipeline.
 * `boundContext` (the kube context chant binds for the served env) breaks a
 * multi-cluster tie — see `boundManagedCluster`. With chant's reference
 * catalog on the IR, a member the cluster join answers for is anchored by the
 * answer or not at all (see the module note), and the reasons it was not are
 * on `ir.anchorNotes`.
 */
export function addClusterAnchorEdges(ir: GraphIR, boundContext?: string): GraphIR {
  const nodes = ir.nodes as AnchorNode[];
  const k8sNodes = nodes.filter(isK8s);
  if (k8sNodes.length === 0) return ir;

  const mutual = catalogOfIr(ir) !== undefined;
  const existing = new Set(ir.edges.map((e) => `${e.from}\0${e.to}`));
  const add = (from: string, to: string) => {
    if (from === to) return;
    const key = `${from}\0${to}`;
    // A card that already registers the cluster (the cluster Secret) is tied to it by that edge.
    if (existing.has(key) || (mutual && existing.has(`${to}\0${from}`))) return;
    existing.add(key);
    ir.edges.push({ from, to, kind: "ref", viaAttr: ANCHOR_VIA, inferred: true, join: "cluster-anchor" } as never);
  };

  /** Anchor `group` to `cluster`: namespaces under it, namespaced objects under their namespace. */
  const anchor = (group: AnchorNode[], cluster: IRNode): void => {
    // Declared namespaces, by the name Kubernetes knows them as. A Namespace's
    // `metadata.name` is the join key that `metadata.namespace` on every other
    // object points at — nothing in the IR links them symbolically.
    const namespaceByName = new Map<string, string>();
    for (const n of group) {
      if (!isNamespace(n)) continue;
      const name = metaString(n, "name");
      if (name && !namespaceByName.has(name)) namespaceByName.set(name, n.id);
    }
    for (const n of group) {
      if (isNamespace(n)) {
        add(cluster.id, n.id); // the namespace itself is cluster-scoped
        continue;
      }
      const ns = metaString(n, "namespace");
      const nsNode = ns ? namespaceByName.get(ns) : undefined;
      // Namespaced and its namespace is declared here → nest under it. Otherwise
      // (cluster-scoped, or a namespace this project doesn't declare) the cluster
      // is the honest parent: something has to hold it, and inventing a namespace
      // node would put a resource in the graph nobody declared.
      add(nsNode ?? cluster.id, n.id);
    }
  };

  // behold#1080: the members chant's cluster join answers for.
  const catalog = catalogOfIr(ir);
  const joined = catalog ? memberClusters(ir, catalog) : new Map<string, MemberCluster>();
  const byId = new Map(ir.nodes.map((n) => [n.id, n] as const));
  const memberName = memberOf(ir);
  const notes: string[] = [];
  for (const [name, answer] of joined) {
    const clusters = [...answer.clusters].filter((id) => byId.has(id));
    const mine = k8sNodes.filter((n) => memberName(n.id) === name);
    if (answer.problems.length === 0 && clusters.length === 1) anchor(mine, byId.get(clusters[0]!)!);
    else if (clusters.length > 1 && answer.problems.length === 0) notes.push(`${name}: its cluster Secrets register ${clusters.length} clusters (${clusters.join(", ")}), so its objects are anchored to none`);
    else for (const p of answer.problems) notes.push(`${name}: ${p}; its objects are anchored to no cluster`);
  }
  if (notes.length) (ir as CatalogIr).anchorNotes = notes;

  // Everything the join has no answer for keeps the guess.
  const cluster = boundManagedCluster(ir.nodes, boundContext);
  if (!cluster) return ir;
  anchor(
    k8sNodes.filter((n) => !joined.has(memberName(n.id))),
    cluster,
  );
  return ir;
}
