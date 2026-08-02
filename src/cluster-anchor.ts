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
 */
import type { GraphIR, IRNode } from "@intentius/chant";

/**
 * Managed-cluster kinds across the three cloud lexicons — the node a k8s
 * workload runs *on*. Deliberately the control-plane resource only: a node
 * group / node pool is capacity, not the thing a Service is scheduled onto.
 */
export const MANAGED_CLUSTER_KINDS = new Set([
  "AWS::EKS::Cluster",
  "GCP::Container::Cluster",
  "Microsoft.ContainerService/managedClusters",
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

/**
 * Add `runs-on` anchor edges: cluster → namespace → namespaced resource, and
 * cluster → cluster-scoped resource. Mutates + returns `ir`, matching
 * `addValueMatchEdges`'s contract so the two compose in the same pipeline.
 */
export function addClusterAnchorEdges(ir: GraphIR): GraphIR {
  const nodes = ir.nodes as AnchorNode[];
  const cluster = soleManagedCluster(ir.nodes);
  if (!cluster) return ir;
  const k8sNodes = nodes.filter(isK8s);
  if (k8sNodes.length === 0) return ir;

  // Declared namespaces, by the name Kubernetes knows them as. A Namespace's
  // `metadata.name` is the join key that `metadata.namespace` on every other
  // object points at — nothing in the IR links them symbolically.
  const namespaceByName = new Map<string, string>();
  for (const n of k8sNodes) {
    if (!isNamespace(n)) continue;
    const name = metaString(n, "name");
    if (name && !namespaceByName.has(name)) namespaceByName.set(name, n.id);
  }

  const existing = new Set(ir.edges.map((e) => `${e.from}\0${e.to}`));
  const add = (from: string, to: string) => {
    if (from === to) return;
    const key = `${from}\0${to}`;
    if (existing.has(key)) return;
    existing.add(key);
    ir.edges.push({ from, to, kind: "ref", viaAttr: ANCHOR_VIA, inferred: true } as never);
  };

  for (const n of k8sNodes) {
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

  return ir;
}
