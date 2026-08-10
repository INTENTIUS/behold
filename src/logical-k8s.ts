/**
 * Kubernetes logical projection (#74) — the fourth topology lens:
 *
 *   cluster → namespace ⊃ resource
 *
 * ## Why this one cannot use an allowlist
 *
 * The other three lenses name the kinds an architecture diagram shows, because
 * AWS, Azure and GCP each have a large but *closed* set of resource types — a
 * kind nobody listed is a kind nobody was going to draw.
 *
 * Kubernetes is open by design. A CustomResourceDefinition mints new kinds, and
 * a cluster's interesting resources are frequently the custom ones: a
 * kubemicrovm-ops estate is `MicroVMImage`, `MicroVMClass`, `MicroVMNetwork` and
 * `MicroVMReplicaSet`, none of which any allowlist could have anticipated. An
 * allowlist here would render an estate's namespaces with nothing inside them,
 * which is the same empty picture this issue exists to fix, in a new costume.
 *
 * So the rule is inverted: everything is a headline card except the plumbing we
 * can name. `PLUMBING_KINDS` below is small, closed and about *support*
 * objects — config, identity, RBAC. Anything else, built-in or custom, is a
 * thing somebody declared on purpose and gets drawn.
 *
 * The cost of inverting is that a new support kind renders as a card until it is
 * listed. That is the right way round: a card too many is a picture someone
 * corrects, a card too few is an estate that looks empty.
 *
 * ## Where the boxes come from
 *
 * Namespaces need no resolution. Every namespaced object carries
 * `metadata.namespace` as a plain string, and a `Namespace` object carries its
 * own name in `metadata.name` — so the containment is read directly rather than
 * inferred from references, which is what the AWS lens has to do for subnets.
 *
 * A namespace the estate declares but puts nothing in still gets a box: a
 * declared namespace is a fact about the estate, the same reasoning the GCP lens
 * applies to locations. An Argo Application's `spec.destination.namespace` is
 * named the same way (#222) — see `destinationNamespace`.
 *
 * The cluster is usually not a declared resource — but on a mixed estate it
 * can be: a managed EKS/AKS/GKE control plane declared in the cloud half. When
 * exactly one is declared, its node id becomes the cluster box (see
 * `projectK8sLogical`'s doc — this is the #142 join). Otherwise `env` names it
 * when the caller knows one, exactly as Azure's resource group and GCP's
 * project are handled — an unnamed cluster box beats a fabricated id.
 *
 * ## Edges
 *
 * Deliberately none, for now. Kubernetes cross-references are plain strings —
 * a `MicroVM`'s `imageRef` is the image's *name*, not a `$ref` — so there are no
 * reference edges in the IR to contract, and resolving them would mean encoding
 * per-CRD knowledge of which fields are references. That is exactly the
 * substrate-specific coupling this issue is about removing, so the lens draws
 * containment and leaves edges to whoever can resolve them generically.
 */
import type { GraphIR, IRNode } from "@intentius/chant";
import { boundManagedCluster } from "./cluster-anchor.ts";
import type { ByContainer, LogicalProjection } from "./logical.ts";

/**
 * Support objects — config, identity, RBAC. Not things an architecture diagram
 * shows; things the diagram's contents need in order to work.
 *
 * `Namespace` is here because it becomes a *box*, not a card — drawing it as
 * both would nest a namespace inside itself.
 */
export const K8S_PLUMBING_KINDS = new Set([
  "K8s::Core::Namespace",
  "K8s::Core::ConfigMap",
  "K8s::Core::Secret",
  "K8s::Core::ServiceAccount",
  "K8s::Core::ResourceQuota",
  "K8s::Core::LimitRange",
  "K8s::Rbac::Role",
  "K8s::Rbac::RoleBinding",
  "K8s::Rbac::ClusterRole",
  "K8s::Rbac::ClusterRoleBinding",
]);

/** A nested `metadata.<key>` string, which is where k8s puts identity. */
function metaStr(node: IRNode, key: "name" | "namespace"): string | undefined {
  const meta = node.attrs?.metadata as Record<string, unknown> | undefined;
  const v = meta?.[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * The namespace an Argo Application *deploys into* (#222). An Application lives
 * in `argocd` and names a different namespace in `spec.destination.namespace` —
 * one the estate is committed to, since Argo will own objects there. That makes
 * it a namespace the estate names, so it gets a box like any other.
 *
 * This is the containment half of the destination join, and the whole of it:
 * `k8s-edges.ts` joins card to card, and a namespace box is a container key
 * rather than a node, so there is nothing for an edge to point at. Reading the
 * Application's own card inside `argocd` next to the box it fills is what the
 * picture can honestly say.
 */
function destinationNamespace(n: IRNode): string | undefined {
  if (n.kind !== "K8s::Argo::Application") return undefined;
  const spec = n.attrs?.spec as Record<string, unknown> | undefined;
  const dest = spec?.destination as Record<string, unknown> | undefined;
  const ns = dest?.namespace;
  return typeof ns === "string" && ns.length > 0 ? ns : undefined;
}

/** Every namespace the estate names — declared as one, referenced by an object
 * in it, or named as an Argo Application's deploy destination. */
export function declaredNamespaces(nodes: readonly IRNode[]): Set<string> {
  const out = new Set<string>();
  for (const n of nodes) {
    if (n.kind === "K8s::Core::Namespace") {
      const own = metaStr(n, "name");
      if (own) out.add(own);
      continue;
    }
    const ns = metaStr(n, "namespace");
    if (ns) out.add(ns);
    const dest = destinationNamespace(n);
    if (dest) out.add(dest);
  }
  return out;
}

/**
 * Project a Kubernetes entity IR into the logical/architecture view.
 *
 * The cluster box's identity, in order of preference (#142):
 *
 *   1. The estate's own **managed cluster node** (`soleManagedCluster` — the
 *      EKS/AKS/GKE control plane a cloud lens keeps as a headline card). Using
 *      that node's *id* as the container key is what joins the two halves into
 *      one picture: pinhole's `layoutArchitecture` removes a card whose id is
 *      also a container key and draws it as a box instead, so the namespaces
 *      nest inside the cluster card, inside whatever component/subnet/VPC box
 *      the cloud lens placed it in. One root, not two.
 *   2. `env`, when the caller knows one — the situation before #142, and still
 *      the answer for a k8s-only estate, where no declared node is the cluster.
 *   3. A bare `cluster` box — an unnamed box beats a fabricated id.
 *
 * Two managed clusters used to be an unconditional decline; with a bound kube
 * context to compare (`boundContext` — the context chant binds for the served
 * env) the cluster that context names wins, which is what makes fountain-ops's
 * two declared k3d clusters render as one picture instead of falling back to
 * `env`. No context, or an ambiguous match, still declines — the same
 * discipline `addClusterAnchorEdges` follows. Pure; the input IR is untouched.
 */
export function projectK8sLogical(ir: GraphIR, env?: string, boundContext?: string): LogicalProjection {
  const k8s = ir.nodes.filter((n) => n.lexicon === "k8s");
  if (k8s.length === 0) return { ir: { nodes: [], edges: [], groups: {} }, byContainer: {} };

  const cluster = boundManagedCluster(ir.nodes, boundContext);
  const CLUSTER_TITLE = cluster ? cluster.id : env ? `cluster ${env}` : "cluster";
  const CLUSTER_SCOPED = "cluster-scoped";
  const namespaceTitle = (ns: string) => `namespace ${ns}`;

  const byContainer: ByContainer = {};
  const child = (parent: string, c: string) => {
    const arr = byContainer[parent] ?? (byContainer[parent] = []);
    if (!arr.includes(c)) arr.push(c);
  };

  // A box per namespace the estate names, including ones holding no card.
  for (const ns of [...declaredNamespaces(k8s)].sort()) child(CLUSTER_TITLE, namespaceTitle(ns));

  // Everything that is not support plumbing. See the module note on why this is
  // a denylist where the other lenses use an allowlist.
  const headline = k8s.filter((n) => !K8S_PLUMBING_KINDS.has(n.kind));

  let clusterScoped = false;
  for (const n of headline) {
    const ns = metaStr(n, "namespace");
    if (ns) {
      child(namespaceTitle(ns), n.id);
    } else {
      // A cluster-scoped object is not homeless — it genuinely lives outside
      // any namespace, and gets its own lane rather than being forced into one.
      clusterScoped = true;
      child(CLUSTER_SCOPED, n.id);
    }
  }
  if (clusterScoped) child(CLUSTER_TITLE, CLUSTER_SCOPED);

  // Edges between two surviving cards pass through (#143). The IR has none of
  // its own for k8s; what arrives here is what the declared-attribute pass
  // (src/k8s-edges.ts) derived — selector, ingress backend, scaleTargetRef —
  // which is exactly the request path an architecture diagram wants.
  const kept = new Set(headline.map((n) => n.id));
  const edges = ir.edges.filter((e) => kept.has(e.from) && kept.has(e.to));

  return { ir: { nodes: headline, edges, groups: {} }, byContainer };
}
