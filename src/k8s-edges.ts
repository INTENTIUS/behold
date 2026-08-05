/**
 * Kubernetes declared-attribute edges (#143).
 *
 * chant's IR carries no k8s edges at all: the k8s serializer resolves only
 * `.name`/`.namespace` AttrRefs, and the composites wire members with plain
 * strings — so a Deployment, its Service, its Ingress and its HPA arrive as
 * four unrelated nodes. The relationships are still *declared*, though, as
 * exact literals the Kubernetes API itself joins on:
 *
 *   Service.spec.selector          ⊆ workload.spec.template.metadata.labels
 *   Ingress …backend.service.name  = Service.metadata.name
 *   HPA.spec.scaleTargetRef        = { kind, name } of a workload
 *
 * This pass derives those three, and only those three. They are exact joins on
 * declared literals — the same standard the AWS lens's security-group ingress
 * pass meets — so nothing here guesses. A CRD's reference fields stay out of
 * scope: which of its strings are references is per-CRD knowledge this module
 * must not encode.
 *
 * Namespace scoping uses the platform's own defaulting rule: an object with no
 * declared `metadata.namespace` lives in `default`, so that is what it joins
 * against. Two workloads matching one selector both get an edge — the match is
 * just as real on the cluster.
 *
 * Edges are tagged `inferred: true` (styled apart from declared refs, same as
 * value-match and the cluster anchors) with a `viaAttr` naming the join.
 * Mutates + returns `ir`, matching `addValueMatchEdges`'s contract so the
 * passes compose in the same pipeline.
 */
import type { GraphIR, IRNode } from "@intentius/chant";

/** Workload kinds a selector or scaleTargetRef can land on — the pod-template
 * carriers. Job/CronJob templates exist too but nothing selects across them. */
const WORKLOAD_KINDS = new Set([
  "K8s::Apps::Deployment",
  "K8s::Apps::StatefulSet",
  "K8s::Apps::DaemonSet",
  "K8s::Apps::ReplicaSet",
]);

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** `metadata.namespace`, defaulted the way the apiserver defaults it. */
function namespaceOf(n: IRNode): string {
  return str(rec(n.attrs?.metadata)?.namespace) ?? "default";
}

function nameOf(n: IRNode): string | undefined {
  return str(rec(n.attrs?.metadata)?.name);
}

/** A flat string→string record (a selector, a label set), or undefined. */
function labelRecord(v: unknown): Record<string, string> | undefined {
  const r = rec(v);
  if (!r) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(r)) {
    if (typeof val !== "string") return undefined; // matchExpressions etc. — out of scope
    out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Every selector pair present, with the same value, in `labels`. */
function selects(selector: Record<string, string>, labels: Record<string, string>): boolean {
  return Object.entries(selector).every(([k, v]) => labels[k] === v);
}

/** The workload's pod-template labels — what a Service selector matches. */
function templateLabels(n: IRNode): Record<string, string> | undefined {
  const template = rec(rec(n.attrs?.spec)?.template);
  return labelRecord(rec(template?.metadata)?.labels);
}

/** The `kind` short name a scaleTargetRef compares against (`Deployment`). */
function shortKind(kind: string): string {
  const parts = kind.split("::");
  return parts[parts.length - 1] ?? kind;
}

/** Service names an Ingress's backends point at: rules[].http.paths[].backend
 * plus defaultBackend. */
function ingressBackendServices(n: IRNode): string[] {
  const spec = rec(n.attrs?.spec);
  const out: string[] = [];
  const backendName = (b: unknown) => str(rec(rec(b)?.service)?.name);
  const fromDefault = backendName(spec?.defaultBackend);
  if (fromDefault) out.push(fromDefault);
  const rules = Array.isArray(spec?.rules) ? spec.rules : [];
  for (const rule of rules) {
    const paths = rec(rec(rule)?.http)?.paths;
    for (const p of Array.isArray(paths) ? paths : []) {
      const name = backendName(rec(p)?.backend);
      if (name) out.push(name);
    }
  }
  return out;
}

export interface K8sDeclaredEdge {
  from: string;
  to: string;
  kind: "ref";
  viaAttr: string;
  inferred: true;
}

/** Derive the three declared-attribute joins over a graph's k8s nodes. Pure. */
export function deriveK8sEdges(nodes: readonly IRNode[]): K8sDeclaredEdge[] {
  const k8s = nodes.filter((n) => n.lexicon === "k8s");
  if (k8s.length === 0) return [];
  const out: K8sDeclaredEdge[] = [];
  const add = (from: string, to: string, viaAttr: string) => {
    if (from !== to) out.push({ from, to, kind: "ref", viaAttr, inferred: true });
  };

  const workloads = k8s.filter((n) => WORKLOAD_KINDS.has(n.kind));
  const servicesByNsName = new Map<string, IRNode>();
  for (const n of k8s) {
    if (n.kind !== "K8s::Core::Service") continue;
    const name = nameOf(n);
    if (name) servicesByNsName.set(`${namespaceOf(n)}/${name}`, n);
  }

  for (const n of k8s) {
    // Service → workload its selector lands on.
    if (n.kind === "K8s::Core::Service") {
      const selector = labelRecord(rec(n.attrs?.spec)?.selector);
      if (!selector) continue;
      for (const w of workloads) {
        if (namespaceOf(w) !== namespaceOf(n)) continue;
        const labels = templateLabels(w);
        if (labels && selects(selector, labels)) add(n.id, w.id, "selector");
      }
      continue;
    }
    // Ingress → Service its backends name.
    if (n.kind === "K8s::Networking::Ingress") {
      for (const svcName of ingressBackendServices(n)) {
        const svc = servicesByNsName.get(`${namespaceOf(n)}/${svcName}`);
        if (svc) add(n.id, svc.id, "ingress backend");
      }
      continue;
    }
    // HPA → the workload its scaleTargetRef names.
    if (n.kind === "K8s::Autoscaling::HorizontalPodAutoscaler") {
      const ref = rec(rec(n.attrs?.spec)?.scaleTargetRef);
      const refKind = str(ref?.kind);
      const refName = str(ref?.name);
      if (!refKind || !refName) continue;
      for (const w of workloads) {
        if (namespaceOf(w) !== namespaceOf(n)) continue;
        if (shortKind(w.kind) === refKind && nameOf(w) === refName) add(n.id, w.id, "scaleTargetRef");
      }
    }
  }
  return out;
}

/**
 * Add the derived edges to `ir`, deduped against whatever is already there.
 * Mutates + returns `ir` — the same contract as `addValueMatchEdges` and
 * `addClusterAnchorEdges`, so the three compose in the server's pipeline.
 */
export function addK8sDeclaredEdges(ir: GraphIR): GraphIR {
  const existing = new Set(ir.edges.map((e) => `${e.from}\0${e.to}`));
  for (const e of deriveK8sEdges(ir.nodes)) {
    const key = `${e.from}\0${e.to}`;
    if (existing.has(key)) continue;
    existing.add(key);
    ir.edges.push(e as never);
  }
  return ir;
}
