// The neighbourhood of one Kubernetes object, cut from a graph the page
// already holds (#1081). A cluster UI (Headlamp, the Argo CD UI) shows one
// object; this answers "it, its neighbours in the cluster, and what it reaches
// outside" with no server to ask.
//
// Imports only ./cut-around.js, which imports nothing: no `node:*`, nothing
// from src/. `esbuild web/neighbourhood.js --bundle --platform=browser` takes
// it whole, and web/neighbourhood.test.js checks the module graph.
import { cutAround } from "./cut-around.js";

export { cutAround };

/** API group of a `K8s::<Segment>::` IR kind, for the segments that name one group. A node carrying `attrs.apiVersion` never reaches this table. */
const GROUP_OF_SEGMENT = {
  Core: "",
  Apps: "apps",
  Batch: "batch",
  Rbac: "rbac.authorization.k8s.io",
  Networking: "networking.k8s.io",
  Storage: "storage.k8s.io",
  Policy: "policy",
  Autoscaling: "autoscaling",
  Apiextensions: "apiextensions.k8s.io",
  Argo: "argoproj.io",
  Monitoring: "monitoring.coreos.com",
};

/** Kinds with no namespace, so an identity without one still matches. */
const CLUSTER_SCOPED = new Set([
  "Namespace",
  "Node",
  "PersistentVolume",
  "StorageClass",
  "ClusterRole",
  "ClusterRoleBinding",
  "CustomResourceDefinition",
  "PriorityClass",
  "IngressClass",
  "RuntimeClass",
  "ValidatingWebhookConfiguration",
  "MutatingWebhookConfiguration",
  "APIService",
  "AppProject",
]);

/** Whether a node is a Kubernetes object (the lexicon chant tags it with, else its kind). */
export function isK8sNode(node) {
  return !!node && (node.lexicon === "k8s" || (typeof node.kind === "string" && node.kind.startsWith("K8s::")));
}

const str = (v) => (typeof v === "string" && v.length > 0 ? v : undefined);

/** `{ group, kind, namespace, name }` of a Kubernetes node, as far as it declares them. */
export function identityOf(node) {
  const attrs = (node && node.attrs) || {};
  const meta = attrs.metadata && typeof attrs.metadata === "object" ? attrs.metadata : {};
  const parts = typeof node.kind === "string" ? node.kind.split("::") : [];
  const kind = str(attrs.kind) || (parts[0] === "K8s" ? parts[parts.length - 1] : undefined);
  let group;
  const apiVersion = str(attrs.apiVersion);
  if (apiVersion) group = apiVersion.includes("/") ? apiVersion.slice(0, apiVersion.indexOf("/")) : "";
  else if (parts[0] === "K8s" && parts.length === 3 && parts[1] in GROUP_OF_SEGMENT) group = GROUP_OF_SEGMENT[parts[1]];
  return { group, kind, namespace: str(meta.namespace), name: str(meta.name) };
}

/**
 * The node for `{ group, kind, namespace, name }`, or null. `group` is the API
 * group ("" or omitted for core, "apps" for Deployment). An object with no
 * namespace joins `default`, as the apiserver defaults it (src/k8s-edges.ts),
 * and a cluster-scoped kind matches without one. A group left out matches any
 * group; one given never matches a node whose group is known and different.
 */
export function findK8sNode(graph, { group, kind, namespace, name } = {}) {
  if (!kind || !name) return null;
  const wantNamespace = CLUSTER_SCOPED.has(kind) ? undefined : namespace || "default";
  for (const node of (graph && graph.nodes) || []) {
    if (!isK8sNode(node)) continue;
    const id = identityOf(node);
    if (id.kind !== kind || id.name !== name) continue;
    if (group !== undefined && id.group !== undefined && id.group !== group) continue;
    if (wantNamespace !== undefined && (id.namespace || "default") !== wantNamespace) continue;
    return node;
  }
  return null;
}

/** "apps/Deployment default/web", the way a person names an object. */
export function describeIdentity({ group, kind, namespace, name } = {}) {
  const k = group ? `${group}/${kind}` : `${kind}`;
  return namespace ? `${k} ${namespace}/${name}` : `${k} ${name}`;
}

/**
 * The cut around the object named by `identity`. Walks `depth` hops (default
 * 1) between Kubernetes objects and `outside` hops (default 2) past the last
 * one. An identity the graph does not hold returns no nodes and a `reason`
 * naming it.
 */
export function neighbourhoodOf(graph, identity, opts = {}) {
  const start = findK8sNode(graph, identity);
  if (!start) {
    return { nodes: [], edges: [], groups: {}, seeds: [], reason: `the graph holds no Kubernetes object ${describeIdentity(identity)}` };
  }
  return cutAround(graph, [start.id], { depth: 1, outside: 2, ...opts, inside: isK8sNode });
}
