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
 * This pass derives those joins, plus the Flux toolkit's reference contracts
 * (behold#171, #223) and Argo's project join (behold#222):
 *
 *   Kustomization.spec.sourceRef             = { kind, name[, namespace] } of a source
 *   HelmRelease.spec.chart.spec.sourceRef    = { kind, name[, namespace] } of a source
 *   Kustomization.spec.dependsOn[]           = { name[, namespace] } of a Kustomization
 *   ImagePolicy.spec.imageRepositoryRef      = { name[, namespace] } of an ImageRepository
 *   ImageUpdateAutomation.spec.sourceRef     = { kind, name[, namespace] } of a GitRepository
 *   Alert.spec.providerRef                   = { name[, namespace] } of a Provider
 *   Alert.spec.eventSources[]                = { kind, name[, namespace] } of a Flux object
 *   Application.spec.project                 = metadata.name of an AppProject
 *
 * All of them are exact joins on declared literals — the same standard the AWS
 * lens's security-group ingress pass meets — so nothing here guesses. The rule
 * for a CRD's fields stands, refined: an ARBITRARY CRD's strings stay out of
 * scope (which of them are references is per-CRD knowledge this module must
 * not encode — a MicroVM's `imageRef` gets no edge), but a NAMED, versioned,
 * upstream-stable reference contract is the `scaleTargetRef` standard, and the
 * Flux toolkit's refs and Argo's `spec.project` are exactly that. Argo's
 * `Application.spec.source.repoURL` is deliberately NOT here: it's a URL, not a
 * reference to any node in the graph — if two objects ever share it, that is
 * value-match's job. An Application's `spec.destination.namespace` names a
 * namespace, and a namespace is a box rather than a card, so there is nothing
 * for an edge to land on: `logical-k8s.ts` counts it as a namespace the estate
 * names, which is what draws the box the Application deploys into.
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

/** The Flux source kinds a `sourceRef` can point at (behold#171). */
const FLUX_SOURCE_KINDS = new Set([
  "K8s::Flux::GitRepository",
  "K8s::Flux::OCIRepository",
  "K8s::Flux::HelmRepository",
  "K8s::Flux::HelmChart",
  "K8s::Flux::Bucket",
]);

/** A `sourceRef`-shaped `{ kind, name, namespace? }` read off a nested object,
 * namespace defaulting to the REFERRER'S own (Flux's rule — a sourceRef with
 * no namespace resolves in the CR's namespace). `defaultKind` stands in for a
 * kind the CRD itself defaults (ImageUpdateAutomation's sourceRef is a
 * GitRepository when the field is omitted), which is the apiserver's own rule,
 * not a guess. */
function sourceRefOf(
  refObj: unknown,
  referrer: IRNode,
  defaultKind?: string,
): { kind: string; name: string; namespace: string } | undefined {
  const ref = rec(refObj);
  const kind = str(ref?.kind) ?? defaultKind;
  const name = str(ref?.name);
  if (!kind || !name) return undefined;
  return { kind, name, namespace: str(ref?.namespace) ?? namespaceOf(referrer) };
}

/** A `{ name, namespace? }` reference — Flux's NamespacedObjectReference, the
 * shape `dependsOn`, `imageRepositoryRef` and `providerRef` all use. Namespace
 * defaults to the referrer's own, exactly as sourceRefOf's does. */
function namedRefOf(refObj: unknown, referrer: IRNode): { name: string; namespace: string } | undefined {
  const ref = rec(refObj);
  const name = str(ref?.name);
  if (!name) return undefined;
  return { name, namespace: str(ref?.namespace) ?? namespaceOf(referrer) };
}

/** A declared list field, or an empty one. */
function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** The `sourceRef` a HelmRelease declares: `spec.chart.spec.sourceRef` — three
 * levels down, so it gets a name instead of a rec() chain at the call site. */
function helmReleaseSourceRef(n: IRNode): unknown {
  return rec(rec(rec(n.attrs?.spec)?.chart)?.spec)?.sourceRef;
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

/** Derive the declared-attribute joins listed at the top of this file over a
 * graph's k8s nodes. An edge exists only when both ends are declared here. Pure. */
export function deriveK8sEdges(nodes: readonly IRNode[]): K8sDeclaredEdge[] {
  const k8s = nodes.filter((n) => n.lexicon === "k8s");
  if (k8s.length === 0) return [];
  const out: K8sDeclaredEdge[] = [];
  const add = (from: string, to: string, viaAttr: string) => {
    if (from !== to) out.push({ from, to, kind: "ref", viaAttr, inferred: true });
  };

  const workloads = k8s.filter((n) => WORKLOAD_KINDS.has(n.kind));
  // Every object by the identity a reference names: kind + namespace + name.
  const byKindNsName = new Map<string, IRNode>();
  // AppProjects by name alone — see addProject on why the namespace is not part
  // of Argo's join.
  const appProjectsByName = new Map<string, IRNode[]>();
  for (const n of k8s) {
    const name = nameOf(n);
    if (!name) continue;
    byKindNsName.set(`${n.kind}\0${namespaceOf(n)}\0${name}`, n);
    if (n.kind === "K8s::Argo::AppProject") {
      const same = appProjectsByName.get(name) ?? [];
      same.push(n);
      appProjectsByName.set(name, same);
    }
  }
  const lookup = (kind: string, namespace: string, name: string) => byKindNsName.get(`${kind}\0${namespace}\0${name}`);

  /** Join a `{ kind, name, namespace? }` ref onto a Flux object, where `kind` is
   * the short spelling the CR carries (`GitRepository`) and the node's is the
   * lexicon's (`K8s::Flux::GitRepository`). `allowed`, when given, is the set of
   * kinds the field's contract permits. */
  const addFluxRef = (n: IRNode, refObj: unknown, viaAttr: string, allowed?: Set<string>, defaultKind?: string) => {
    const ref = sourceRefOf(refObj, n, defaultKind);
    // `*` is Alert's wildcard — it names every object of a kind, not one node.
    if (!ref || ref.name === "*") return;
    const kind = `K8s::Flux::${ref.kind}`;
    if (allowed && !allowed.has(kind)) return;
    const target = lookup(kind, ref.namespace, ref.name);
    if (target) add(n.id, target.id, viaAttr);
  };
  const addSourceRef = (n: IRNode, refObj: unknown, viaAttr: string, defaultKind?: string) =>
    addFluxRef(n, refObj, viaAttr, FLUX_SOURCE_KINDS, defaultKind);

  /** Join a `{ name, namespace? }` ref onto the one kind that field can name. */
  const addNamedRef = (n: IRNode, refObj: unknown, kind: string, viaAttr: string) => {
    const ref = namedRefOf(refObj, n);
    if (!ref) return;
    const target = lookup(kind, ref.namespace, ref.name);
    if (target) add(n.id, target.id, viaAttr);
  };

  /** Argo's `spec.project` names an AppProject the *controller* resolves in its
   * own namespace, which need not be the Application's (apps-in-any-namespace
   * puts them elsewhere), so the join is on name. When several namespaces
   * declare that name the referrer's own wins; a name that stays ambiguous gets
   * no edge, the same discipline the cluster anchor follows. */
  const addProject = (n: IRNode, project: string | undefined, viaAttr: string) => {
    const candidates = project ? (appProjectsByName.get(project) ?? []) : [];
    const target = candidates.length === 1 ? candidates[0] : candidates.find((p) => namespaceOf(p) === namespaceOf(n));
    if (target) add(n.id, target.id, viaAttr);
  };

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
        const svc = lookup("K8s::Core::Service", namespaceOf(n), svcName);
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
      continue;
    }
    // Flux reconciler → the source its sourceRef names (behold#171): a GitOps
    // estate reads source → reconciler instead of disconnected cards.
    if (n.kind === "K8s::Flux::Kustomization") {
      addSourceRef(n, rec(n.attrs?.spec)?.sourceRef, "sourceRef");
      // Reconcile ordering (#223): dependsOn gates this Kustomization on
      // sibling ones — the layered estate's most load-bearing structure, and
      // what chant lints as FLUX003.
      for (const dep of list(rec(n.attrs?.spec)?.dependsOn)) {
        addNamedRef(n, dep, "K8s::Flux::Kustomization", "dependsOn");
      }
      continue;
    }
    if (n.kind === "K8s::Flux::HelmRelease") {
      addSourceRef(n, helmReleaseSourceRef(n), "chart sourceRef");
      continue;
    }
    // Image automation (#223): a policy reads one repository's tags, and the
    // automation writes back to the git source it reconciles from.
    if (n.kind === "K8s::Flux::ImagePolicy") {
      addNamedRef(n, rec(n.attrs?.spec)?.imageRepositoryRef, "K8s::Flux::ImageRepository", "imageRepositoryRef");
      continue;
    }
    if (n.kind === "K8s::Flux::ImageUpdateAutomation") {
      addSourceRef(n, rec(n.attrs?.spec)?.sourceRef, "sourceRef", "GitRepository");
      continue;
    }
    // Notification (#223): an Alert points at the Provider it dispatches
    // through, and at every object whose events it forwards.
    if (n.kind === "K8s::Flux::Alert") {
      addNamedRef(n, rec(n.attrs?.spec)?.providerRef, "K8s::Flux::Provider", "providerRef");
      for (const src of list(rec(n.attrs?.spec)?.eventSources)) {
        addFluxRef(n, src, "eventSource");
      }
      continue;
    }
    // Argo (#222): the project join chant lints as ARGO002, so an estate whose
    // lint passes cannot be drawn wrong by deriving it.
    if (n.kind === "K8s::Argo::Application") {
      addProject(n, str(rec(n.attrs?.spec)?.project), "project");
      continue;
    }
    if (n.kind === "K8s::Argo::ApplicationSet") {
      addProject(n, str(rec(rec(rec(n.attrs?.spec)?.template)?.spec)?.project), "template project");
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
