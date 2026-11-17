/**
 * behold#1132: an operator's view of a cluster read.
 *
 * A live read (src/read-cluster.ts) is every API object and every reference
 * between them. An operator thinks in applications: a workload, the Service
 * that routes to it, the config and identity it uses, and the applications it
 * calls. chant infers those from the read (`inferK8sComponents` in
 * `@intentius/chant/cloud-lister`, chant#5252): one component per application,
 * each member with a role, and a `dependsOn` from an application to one whose
 * Service it names. behold draws what that answers and computes no membership
 * of its own.
 *
 * Three views read it:
 *
 * - objects (the default): every object, with the runtime children
 *   (ReplicaSets, Pods, a CronJob's Jobs) and the bookkeeping members
 *   (EndpointSlices, Endpoints, `kube-root-ca.crt`, the `default`
 *   ServiceAccount) folded into the card they serve. `--every-card` draws them
 *   again.
 * - logical: a box per application holding what an operator manages in it,
 *   with what those objects name outside the cluster.
 * - components: chant's component graph itself, one card per application with
 *   its health, and an edge per `dependsOn`.
 *
 * In every view an edge is labelled with the relationship (routes to, runs as,
 * reads env from, mounts, assumes role) rather than the top-level field that
 * held the reference. The field stays on the edge as `field`, and the
 * document carries it. A reference a pod template holds is drawn once, from
 * the workload, not again from each ReplicaSet and Pod.
 *
 * A workload card is titled with its name and says ready over desired
 * replicas, its image and its Pods' restarts (`_workload`, painted by the k8s
 * pack in src/render.ts). Its Pods' names are in `_workload.pods`.
 *
 * Pure: no `node:` import, no state. The inference itself is loaded by
 * src/read-cluster.ts.
 */
import type { GraphIR, IREdge, IRNode } from "@intentius/chant";
import { applicationSubtitle } from "./operator-cards.ts";

type Rec = Record<string, unknown>;

/** What a member is to its application, as chant's inference names it. */
export type AppRole = "workload" | "runtime" | "service" | "route" | "policy" | "config" | "storage" | "identity" | "bookkeeping";

/** An object two or more applications use, with the drawn id. */
export interface SharedObject {
  id: string;
  role: AppRole;
  usedBy: string[];
}

/** chant's component graph of a cluster read, with member ids rewritten to the drawn ids. */
export interface ClusterApps {
  /** One `Component` node per application, `dependsOn` edges, `groups.byWave`. */
  ir: GraphIR;
  shared: SharedObject[];
  notes: string[];
}

/** The answer of `inferK8sComponents`, held loosely so behold builds against a chant without it. */
export interface InferredApps {
  ir: GraphIR;
  shared: Array<{ id: string; role: string; usedBy: string[]; outside?: unknown[] }>;
  notes: string[];
}

export type InferApps = (graph: Pick<GraphIR, "nodes">) => InferredApps;

/** The views of a cluster read. */
export type ClusterViewKind = "objects" | "logical" | "components";

/** What a view's note says when the chant beside behold infers no applications. */
export const NO_APPS_NOTE = "the chant beside behold infers no applications from a cluster read (inferK8sComponents, chant#5252), so there is no logical or components view of it";

/** The attr a workload card carries its face in. */
export const WORKLOAD_FACE = "_workload";

/** The attr a card carries the ids folded into it in. */
export const FOLDED = "_folded";

/** The attr a card's painted title is read from (src/card-face.ts). */
export const CARD_TITLE = "_title";

const rec = (v: unknown): Rec => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The inference's answer with every member, shared object and outside name keyed by the drawn id. */
export function drawnApps(inferred: InferredApps, ids: ReadonlyMap<string, string>): ClusterApps {
  const to = (id: unknown) => (typeof id === "string" ? (ids.get(id) ?? id) : id);
  const nodes = inferred.ir.nodes.map((n) => {
    const a = rec(n.attrs);
    const members = arr(a.members).map((m) => ({ ...rec(m), id: to(rec(m).id) }));
    const outside = arr(a.outside).map((o) => ({ ...rec(o), from: to(rec(o).from) }));
    return {
      ...n,
      attrs: {
        ...a,
        ...(Array.isArray(a.liveNames) ? { liveNames: a.liveNames.map(to) } : {}),
        ...(Array.isArray(a.members) ? { members } : {}),
        ...(Array.isArray(a.shares) ? { shares: a.shares.map(to) } : {}),
        ...(Array.isArray(a.outside) ? { outside } : {}),
      },
    } as IRNode;
  });
  const shared = inferred.shared.map((s) => ({ id: String(to(s.id)), role: s.role as AppRole, usedBy: [...s.usedBy] }));
  return { ir: { ...inferred.ir, nodes }, shared, notes: [...inferred.notes] };
}

/** Each drawn id an application takes in, with the application and the role. */
export function memberIndex(apps: ClusterApps): Map<string, { app: string; role: AppRole }> {
  const out = new Map<string, { app: string; role: AppRole }>();
  for (const n of apps.ir.nodes) {
    for (const m of arr(rec(n.attrs).members)) {
      const id = str(rec(m).id);
      if (id) out.set(id, { app: n.id, role: rec(m).role as AppRole });
    }
  }
  return out;
}

// --- Relationships ---------------------------------------------------------

/** The field an edge's reference was found in: the path of a k8s catalog rule, or the attribute it names. */
export function edgeField(e: IREdge): string | undefined {
  const r = e as unknown as Rec;
  const rule = str(r.rule);
  if (rule && /^k8s:/.test(rule)) return rule.slice(rule.lastIndexOf(":") + 1);
  return str(r.field) ?? str(e.viaAttr);
}

const OWNER = /metadata\.ownerReferences/;
const IDENTITY_ANNOTATION: ReadonlyArray<[RegExp, string]> = [
  [/eks\.amazonaws\.com\/role-arn/, "assumes role"],
  [/iam\.gke\.io\/gcp-service-account/, "acts as"],
  [/azure\.workload\.identity\/client-id/, "acts as"],
];

/** The ports a Service routes to, as `:80` or `:80 to 8080`. */
function servicePorts(svc: IRNode | undefined): string {
  const ports = arr(rec(rec(svc?.attrs).spec).ports).map(rec);
  return ports
    .map((p) => {
      const port = p.port;
      if (port === undefined) return undefined;
      const target = p.targetPort;
      return target !== undefined && String(target) !== String(port) ? `:${port} to ${target}` : `:${port}`;
    })
    .filter(Boolean)
    .join(", ");
}

const kindWord = (n: IRNode | undefined): string => (n?.kind ?? "").split("::").pop() ?? "";

/**
 * The relationship an edge stands for, in words, or undefined when it is not
 * one this view names. Read off the field the reference was found in and the
 * kinds at its two ends.
 */
export function relationOf(e: IREdge, from: IRNode | undefined, to: IRNode | undefined): string | undefined {
  const field = edgeField(e) ?? "";
  const r = e as unknown as Rec;
  const rule = str(r.rule) ?? "";
  for (const [re, words] of IDENTITY_ANNOTATION) if (re.test(field)) return words;
  if (OWNER.test(field)) return "owned by";
  if (field === "metadata.namespace") return "in namespace";
  if (kindWord(from) === "Service" && (/^spec\.selector/.test(field) || (rule === "" && e.viaAttr === "selector") || r.join === "k8s-declared")) {
    const ports = servicePorts(from);
    return ports ? `routes to ${ports}` : "routes to";
  }
  if (/serviceAccount(Name)?$/.test(field)) return "runs as";
  if (/\.env(From)?\[\]/.test(field)) return "reads env from";
  if (/volumes\[\]/.test(field)) return "mounts";
  if (/imagePullSecrets/.test(field)) return "pulls images with";
  if (/scaleTargetRef/.test(field)) return "scales";
  if (/roleRef/.test(field)) return "grants";
  if (/backend/.test(field) && kindWord(to) === "Service") return "routes to";
  if (/^identity-match:/.test(rule) && (kindWord(from) === "EndpointSlice" || kindWord(from) === "Endpoints")) return "endpoints of";
  return undefined;
}

/** Each edge labelled with its relationship, the field it was found in kept as `field`. */
function relabel(ir: GraphIR): IREdge[] {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  return ir.edges.map((e) => {
    const words = relationOf(e, byId.get(e.from), byId.get(e.to));
    if (!words) return e;
    const field = edgeField(e);
    return { ...e, viaAttr: words, ...(field ? { field } : {}) } as IREdge;
  });
}

// --- Workload faces --------------------------------------------------------

const WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "CronJob", "Job", "ReplicaSet", "Pod"]);

/** A workload's pod spec: the Pod's own, a CronJob's job template's, or the template's. */
function podSpec(n: IRNode): Rec {
  const spec = rec(rec(n.attrs).spec);
  const kind = kindWord(n);
  if (kind === "Pod") return spec;
  if (kind === "CronJob") return rec(rec(rec(rec(spec.jobTemplate).spec).template).spec);
  return rec(rec(spec.template).spec);
}

function imagesOf(n: IRNode): string | undefined {
  const images = [...new Set(arr(podSpec(n).containers).map((c) => str(rec(c).image)).filter((i): i is string => !!i))];
  return images.length ? images.join(", ") : undefined;
}

export interface WorkloadFace {
  ready?: number;
  desired?: number;
  image?: string;
  restarts?: number;
  /** The names of the Pods it runs, off the face. */
  pods: string[];
}

/** A card titled with the object's own name. */
function titled(n: IRNode): IRNode {
  const name = str(rec(rec(n.attrs).metadata).name);
  if (!name || n.lexicon !== "k8s") return n;
  return { ...n, attrs: { ...n.attrs, [CARD_TITLE]: name } };
}

// --- Folding -----------------------------------------------------------------

const BOOKKEEPING_KINDS = new Set(["Endpoints", "EndpointSlice"]);

/** An object behold folds on any read, member or not: what the API server keeps for itself, and the metrics server's samples. */
function isBookkeeping(n: IRNode): boolean {
  const kind = kindWord(n);
  const listed = str((n as unknown as Rec).listedType);
  if (n.lexicon !== "k8s" && !listed) return false;
  if (listed?.startsWith("metrics.k8s.io/")) return true;
  const name = str(rec(rec(n.attrs).metadata).name);
  return BOOKKEEPING_KINDS.has(kind) || (kind === "ConfigMap" && name === "kube-root-ca.crt") || (kind === "ServiceAccount" && name === "default");
}

export interface OperatorObjects {
  ir: GraphIR;
  /** Cards folded into another or left out. */
  folded: number;
  /** Edges drawn once at the workload rather than again from its runtime children. */
  repeats: number;
}

/**
 * The objects view: relationship labels, workload faces, each pod-template
 * reference once, and (unless `everyCard`) the runtime and bookkeeping
 * members folded into the card they serve.
 */
export function operatorObjects(irIn: GraphIR, apps: ClusterApps | undefined, opts: { everyCard?: boolean } = {}): OperatorObjects {
  const members = apps ? memberIndex(apps) : new Map<string, { app: string; role: AppRole }>();
  const sharedRole = new Map((apps?.shared ?? []).map((s) => [s.id, s.role]));
  const byId = new Map(irIn.nodes.map((n) => [n.id, n]));
  const edges = relabel(irIn);

  // The owner each object names, from the owner-reference edges.
  const ownerOf = new Map<string, string>();
  for (const e of edges) if (OWNER.test(edgeField(e) ?? "") && byId.has(e.to)) ownerOf.set(e.from, e.to);
  const roleOf = (id: string): AppRole | undefined => members.get(id)?.role ?? sharedRole.get(id);
  const isRuntime = (id: string) => roleOf(id) === "runtime";
  // The workload a runtime child runs under: up its owners to the first that is not runtime.
  const topOf = (id: string): string | undefined => {
    const seen = new Set<string>();
    let cur: string | undefined = id;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (!isRuntime(cur)) return cur;
      cur = ownerOf.get(cur);
    }
    const app = members.get(id)?.app;
    const workload = app ? [...members].find(([, m]) => m.app === app && m.role === "workload")?.[0] : undefined;
    return workload;
  };

  // Where a bookkeeping object folds: an EndpointSlice or Endpoints into its Service.
  const serviceOf = (n: IRNode): string | undefined => {
    const meta = rec(rec(n.attrs).metadata);
    const name = kindWord(n) === "Endpoints" ? str(meta.name) : str(rec(meta.labels)["kubernetes.io/service-name"]);
    const ns = str(meta.namespace);
    if (!name) return undefined;
    const svc = irIn.nodes.find((s) => kindWord(s) === "Service" && str(rec(rec(s.attrs).metadata).name) === name && str(rec(rec(s.attrs).metadata).namespace) === ns);
    return svc?.id;
  };

  // Workload faces: health from the lister's status view, restarts summed over the Pods each runs.
  const pods = new Map<string, IRNode[]>();
  for (const n of irIn.nodes) {
    if (kindWord(n) !== "Pod" || !isRuntime(n.id)) continue;
    const top = topOf(n.id);
    if (top) (pods.get(top) ?? pods.set(top, []).get(top)!).push(n);
  }
  const faceOf = (n: IRNode): WorkloadFace | undefined => {
    if (!WORKLOAD_KINDS.has(kindWord(n)) || n.lexicon !== "k8s" || isRuntime(n.id)) return undefined;
    const view = rec(rec(n.attrs).workloadStatus);
    const mine = kindWord(n) === "Pod" ? [n] : (pods.get(n.id) ?? []);
    const restarts = mine.map((p) => rec(rec(p.attrs).workloadStatus).restarts).filter((r): r is number => typeof r === "number");
    const desired = typeof view.desiredReplicas === "number" ? view.desiredReplicas : kindWord(n) === "Pod" && typeof view.ready === "boolean" ? 1 : undefined;
    const ready = typeof view.readyReplicas === "number" ? view.readyReplicas : kindWord(n) === "Pod" && typeof view.ready === "boolean" ? (view.ready ? 1 : 0) : desired !== undefined ? 0 : undefined;
    const image = imagesOf(n);
    return {
      ...(desired !== undefined ? { ready: ready ?? 0, desired } : {}),
      ...(image ? { image } : {}),
      ...(restarts.length ? { restarts: restarts.reduce((a, b) => a + b, 0) } : {}),
      pods: mine.filter((p) => p.id !== n.id).map((p) => str(rec(rec(p.attrs).metadata).name) ?? p.id),
    };
  };

  // What folds where. `null` is left out with nowhere to fold.
  const foldTo = new Map<string, string | null>();
  if (!opts.everyCard) {
    for (const n of irIn.nodes) {
      const role = roleOf(n.id);
      if (role === "runtime") foldTo.set(n.id, topOf(n.id) ?? null);
      else if (role === "bookkeeping" || isBookkeeping(n)) {
        const into = BOOKKEEPING_KINDS.has(kindWord(n)) ? serviceOf(n) : members.get(n.id) ? topOf(n.id) : undefined;
        foldTo.set(n.id, into && into !== n.id ? into : null);
      }
    }
    // A target that is itself folded passes it on.
    for (const [id, into] of foldTo) {
      let cur = into;
      const seen = new Set([id]);
      while (cur && foldTo.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        cur = foldTo.get(cur) ?? null;
      }
      foldTo.set(id, cur ?? null);
    }
  }
  const folded = new Map<string, string[]>();
  for (const [id, into] of foldTo) if (into) (folded.get(into) ?? folded.set(into, []).get(into)!).push(id);
  for (const [id] of foldTo) {
    const app = members.get(id)?.app;
    if (foldTo.get(id) === null && app) {
      const w = [...members].find(([, m]) => m.app === app && m.role === "workload")?.[0];
      if (w && !foldTo.has(w)) (folded.get(w) ?? folded.set(w, []).get(w)!).push(id);
    }
  }

  const nodes = irIn.nodes
    .filter((n) => !foldTo.has(n.id))
    .map((n) => {
      const face = faceOf(n);
      const into = folded.get(n.id);
      const out = titled(n);
      if (!face && !into) return out;
      const status = face && face.desired !== undefined ? (face.desired > 0 && face.ready === face.desired ? "good" : face.ready! < face.desired ? "warn" : undefined) : undefined;
      return {
        ...out,
        attrs: {
          ...out.attrs,
          ...(face ? { [WORKLOAD_FACE]: face } : {}),
          ...(into ? { [FOLDED]: [...into].sort() } : {}),
          ...(status && out.attrs._status === undefined ? { _status: status } : {}),
        },
      } as IRNode;
    });

  // Each reference once: re-pointed at the card it folded into, and dropped from a runtime child when its workload holds it too.
  const at = (id: string): string | undefined => (foldTo.has(id) ? (foldTo.get(id) ?? undefined) : id);
  const seen = new Set<string>();
  const kept: IREdge[] = [];
  const workloadHolds = new Set(edges.filter((e) => !isRuntime(e.from)).map((e) => `${e.from}\0${e.to}\0${e.viaAttr ?? ""}`));
  let repeats = 0;
  for (const e of edges) {
    if (opts.everyCard && isRuntime(e.from) && !OWNER.test(edgeField(e) ?? "")) {
      const top = topOf(e.from);
      if (top && workloadHolds.has(`${top}\0${e.to}\0${e.viaAttr ?? ""}`)) {
        repeats++;
        continue;
      }
    }
    const from = at(e.from);
    const to = at(e.to);
    if (!from || !to || from === to) continue;
    // Between two folded objects (an EndpointSlice naming a Pod) is bookkeeping of its own.
    if (foldTo.has(e.from) && foldTo.has(e.to)) continue;
    const key = `${from}\0${to}\0${e.viaAttr ?? ""}`;
    if (seen.has(key)) {
      if (from !== e.from || to !== e.to) repeats++;
      continue;
    }
    seen.add(key);
    kept.push(from === e.from && to === e.to ? e : { ...e, from, to });
  }
  const keepIds = new Set(nodes.map((n) => n.id));
  const groups = filterGroups(irIn.groups, keepIds);
  const dangling = (irIn.dangling ?? []).filter((d) => keepIds.has(d.from));
  return { ir: { ...irIn, nodes, edges: kept, groups, dangling } as GraphIR, folded: foldTo.size, repeats };
}

/** The groups with only the ids kept. */
function filterGroups(groups: GraphIR["groups"] | undefined, keep: ReadonlySet<string>): GraphIR["groups"] {
  const out: Record<string, unknown> = {};
  for (const [kind, boxes] of Object.entries((groups ?? {}) as Record<string, unknown>)) {
    if (boxes === null || typeof boxes !== "object" || Array.isArray(boxes)) {
      out[kind] = boxes;
      continue;
    }
    const kept: Record<string, string[]> = {};
    for (const [key, ids] of Object.entries(boxes as Record<string, unknown>)) {
      if (!Array.isArray(ids)) continue;
      const inside = ids.filter((id) => typeof id === "string" && keep.has(id));
      if (inside.length) kept[key] = inside;
    }
    out[kind] = kept;
  }
  return out as GraphIR["groups"];
}

// --- The logical view --------------------------------------------------------

/** The box shared objects of a namespace sit in. */
export const sharedBox = (ns: string) => `shared in ${ns}`;

/**
 * The logical view: a box per application with the objects an operator
 * manages in it (the objects view's cards that are members), a box per
 * namespace for objects several applications share, and the cards outside the
 * cluster (or in a folder read beside it) those objects name. Everything else
 * is left out and counted.
 *
 * Each application's box is titled with its health, `checkout · 2/2 ready`
 * (the IR's `boxTitles`, which src/render.ts paints and the document's group
 * title carries). Each `dependsOn` is drawn between the boxes, from the card
 * that names the other application (the ConfigMap whose value holds its
 * Service's address) to that application's Service, with the components
 * view's label.
 */
export function logicalOfApps(objects: GraphIR, apps: ClusterApps): { ir: GraphIR; leftOut: number } {
  const members = memberIndex(apps);
  const shared = new Map(apps.shared.map((s) => [s.id, s]));
  const byStack: Record<string, string[]> = {};
  const inApp = new Set<string>();
  for (const n of objects.nodes) {
    const m = members.get(n.id);
    if (m) {
      (byStack[m.app] ??= []).push(n.id);
      inApp.add(n.id);
      continue;
    }
    const s = shared.get(n.id);
    if (s) {
      const ns = str(rec(rec(n.attrs).metadata).namespace) ?? "cluster";
      (byStack[sharedBox(ns)] ??= []).push(n.id);
      inApp.add(n.id);
    }
  }
  // What the members name beyond the cluster's objects: a placeholder outside it, or a folder's card.
  const isClusterObject = (n: IRNode) => n.lexicon === "k8s" || !!(n as unknown as Rec).listedType;
  const byId = new Map(objects.nodes.map((n) => [n.id, n]));
  const beyond = new Set<string>();
  for (const e of objects.edges) {
    const to = byId.get(e.to);
    if (inApp.has(e.from) && to && !isClusterObject(to)) beyond.add(e.to);
  }
  const keep = new Set([...inApp, ...beyond]);
  const prior = (objects.groups?.byStack ?? {}) as Record<string, string[]>;
  for (const [box, ids] of Object.entries(prior)) {
    const outside = ids.filter((id) => beyond.has(id));
    if (outside.length) byStack[box] = outside;
  }
  const nodes = objects.nodes.filter((n) => keep.has(n.id));
  const edges = [...objects.edges.filter((e) => keep.has(e.from) && keep.has(e.to)), ...dependsOnEdges(apps, keep)];
  const boxTitles: Record<string, string> = {};
  for (const app of apps.ir.nodes) {
    if (!byStack[app.id]) continue;
    const desired = rec(rec(app.attrs).status).desiredReplicas;
    if (typeof desired === "number") boxTitles[app.id] = `${app.id} · ${applicationSubtitle(rec(app.attrs)).replace(/^Application · /, "")}`;
  }
  const groups = { byStack } as unknown as GraphIR["groups"];
  return { ir: { ...objects, nodes, edges, groups, dangling: [], ...(Object.keys(boxTitles).length ? { boxTitles } : {}) } as GraphIR, leftOut: objects.nodes.length - nodes.length };
}

/**
 * Each application-to-application `dependsOn` as an edge between two drawn
 * cards: from the member chant found the reference in (its `viaAttr` reads
 * `ConfigMap checkout-config data.PAYMENTS_URL`), or the workload when that
 * card is not drawn, to the other application's Service, or its workload.
 */
function dependsOnEdges(apps: ClusterApps, drawn: ReadonlySet<string>): IREdge[] {
  const membersOf = new Map(apps.ir.nodes.map((n) => [n.id, arr(rec(n.attrs).members).map((m) => ({ id: str(rec(m).id) ?? "", role: str(rec(m).role) }))] as const));
  const pick = (app: string, role: string) => membersOf.get(app)?.find((m) => m.role === role && drawn.has(m.id))?.id;
  const out: IREdge[] = [];
  for (const e of apps.ir.edges) {
    const via = str(e.viaAttr) ?? "";
    const named = via
      .split(";")
      .map((s) => s.trim().split(/\s+/))
      .flatMap(([kind, name]) => membersOf.get(e.from)?.find((m) => drawn.has(m.id) && m.id.endsWith(`/${kind}/${name}`))?.id ?? []);
    const from = named[0] ?? pick(e.from, "workload");
    const to = pick(e.to, "service") ?? pick(e.to, "workload");
    if (!from || !to) continue;
    out.push({ from, to, kind: "ref", viaAttr: dependsLabel(via), ...(via ? { field: via } : {}) } as IREdge);
  }
  return out;
}

/** A `dependsOn` edge's label: the names that made it, `depends on: PAYMENTS_URL`. */
function dependsLabel(via: string): string {
  const names = [...new Set(via.split(";").map((s) => s.trim().split(/\s+/).pop()?.replace(/^data\./, "")).filter((s): s is string => !!s))];
  return names.length ? `depends on: ${names.join(", ")}` : "depends on";
}

// --- The components view -----------------------------------------------------

/**
 * chant's component graph as behold paints it: each application's health as
 * its status colour (all its replicas ready is good, fewer is warn, none to
 * count is left neutral), and each `dependsOn` labelled with the names that
 * made it, the full list kept as `field`.
 *
 * A card's second line is `Application · <ready>/<desired> ready`
 * (`_subtitle`, src/card-face.ts) rather than `Component · chant`: the read
 * found it in the cluster, and the line says what it is there.
 *
 * chant's `groups.byWave` is left off. A wave is the order an apply would run
 * in, and nothing is applied from a cluster read; the `dependsOn` arrows
 * already say which application calls which.
 */
export function componentsOfApps(apps: ClusterApps): GraphIR {
  const nodes = apps.ir.nodes.map((n) => {
    const status = rec(rec(n.attrs).status);
    const ready = status.readyReplicas;
    const desired = status.desiredReplicas;
    const paint = typeof ready === "number" && typeof desired === "number" ? (desired > 0 && ready === desired ? "good" : ready < desired ? "warn" : undefined) : undefined;
    return { ...n, attrs: { ...n.attrs, _subtitle: applicationSubtitle(rec(n.attrs)), ...(paint ? { _status: paint } : {}) } } as IRNode;
  });
  const edges = apps.ir.edges.map((e) => {
    const via = str(e.viaAttr) ?? "";
    return { ...e, viaAttr: dependsLabel(via), ...(via ? { field: via } : {}) } as IREdge;
  });
  const { byWave: _waves, ...groups } = (apps.ir.groups ?? {}) as Record<string, unknown>;
  return { ...apps.ir, nodes, edges, groups: groups as GraphIR["groups"] };
}
