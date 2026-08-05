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
 * applies to locations.
 *
 * The cluster is not a declared resource and has no name in the graph. `env`
 * names it when the caller knows one, exactly as Azure's resource group and
 * GCP's project are handled — an unnamed cluster box beats a fabricated id.
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

/** Every namespace the estate names — declared as one, or referenced by an object in it. */
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
  }
  return out;
}

/**
 * Project a Kubernetes entity IR into the logical/architecture view.
 *
 * `env` names the cluster when the caller knows one — see the module note on
 * why it cannot come from the graph. Pure; the input IR is untouched.
 */
export function projectK8sLogical(ir: GraphIR, env?: string): LogicalProjection {
  const k8s = ir.nodes.filter((n) => n.lexicon === "k8s");
  if (k8s.length === 0) return { ir: { nodes: [], edges: [], groups: {} }, byContainer: {} };

  const CLUSTER_TITLE = env ? `cluster ${env}` : "cluster";
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

  return { ir: { nodes: headline, edges: [], groups: {} }, byContainer };
}
