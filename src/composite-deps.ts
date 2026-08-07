/**
 * Composite dependency edges for the COMPOSITES detail tier (level 1).
 *
 * At level 1 the graph collapses each composite instance to one node. loomster's
 * composites reference each other only through cross-stack import *sinks*
 * (a resource points at an imported-value parameter that never bridges onward to
 * the producing composite), so once those params are pruned every composite
 * floats — true, but useless. The real dependency structure lives in the
 * component DAG's authoritative `dependsOn` edges (the same ones the waves view
 * draws). This overlays them onto the composite nodes so level 1 reads as a
 * dependency graph (backend → db, everything → shared-foundation, …).
 *
 * ## How a component finds its node (#138)
 *
 * Ownership first: a component IR node carries `attrs.liveNames` (chant#1491) —
 * the declared entity names the component owns, which are entity-IR node ids.
 * The first liveName present in the graph is the component's representative.
 * That is what makes the tier work on a pure-lexicon estate (fountain-ops,
 * kubemicrovm-ops), where every kind is `K8s::…`/`AWS::…` and there is no
 * composite node to collapse to.
 *
 * The original heuristic stays as the fallback for components that mapped
 * nothing: a composite's kind is the PascalCase of its component
 * (`LoomBackend` ↔ `loom-backend`), preferring the real instance over a
 * `byo`-prefixed example twin — loomster's shape, and the shape of any chant
 * predating #1491 (behold's own pinned types do; `liveNames` is read untyped
 * off `attrs`, the same posture src/helm-releases.ts documents).
 *
 * Components with no mappable node either way (kubemicrovm's `operator`, whose
 * deploy is helm releases with no declared entities) simply contribute no edge.
 */
import type { GraphIR, IREdge, IRNode } from "@intentius/chant";

/** `LoomBackend` → `loom-backend`, `SharedFoundation` → `shared-foundation`. */
export function kebabKind(kind: string): string {
  return kind.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** The slice of the component DAG this join reads: `dependsOn` edges, and the
 * component nodes' `liveNames` ownership (absent on a chant predating #1491). */
export interface ComponentDag {
  nodes?: Array<Pick<IRNode, "id"> & { attrs?: Record<string, unknown> }>;
  edges: Pick<IREdge, "from" | "to">[];
}

/** How many edges the last `addCompositeDeps` call actually attached.
 *
 * The composites tier is *defined* as the resource graph plus these edges, so
 * zero attached means the view is the resource graph under another name — the
 * silent collapse #131 is about. The count is what `zoomNote` needs and it is
 * not recoverable from the finished IR, since an estate can have zero edges
 * either way (#84). Returned alongside rather than inferred later. */
export interface CompositeDepsResult {
  ir: GraphIR;
  /** Edges added to `ir`. 0 means nothing mapped — see src/zoom-notes.ts. */
  attached: number;
}

/** component name → representative node id, ownership first (see module doc). */
function componentRepresentatives(ir: GraphIR, dag: ComponentDag): Map<string, string> {
  const nodeById = new Map(ir.nodes.map((n) => [n.id, n]));
  const knownComponents = new Set((dag.nodes ?? []).map((c) => c.id));
  const compToNode = new Map<string, string>();

  // A node's owning component by the `src/<component>/` source convention —
  // resources.ts's rule, reduced to the one check needed here: undefined when
  // the node's path names no known component (a collapsed composite often has
  // no sourceLoc at all), which counts as agreement.
  const sourceComponent = (id: string): string | undefined => {
    const parts = nodeById.get(id)?.sourceLoc?.file?.split("/") ?? [];
    return parts.slice(0, -1).find((p) => knownComponents.has(p));
  };

  // Pass 1 — declared ownership: the first of the component's liveNames that is
  // actually in this graph (a tier prune can drop some), non-`byo` preferred.
  // Two guards against a name that is not really a claim:
  //  - `liveNames: [<the component's own name>]` is indistinguishable from
  //    chant's [name] FALLBACK ("falls back to [name]"), which asserts nothing
  //    — and collides with any unrelated entity sharing the name (kubemicrovm's
  //    `operator` component vs the aws-plane's `operator` OperatorRole
  //    instance, observed live). That shape needs POSITIVE evidence: the named
  //    node's source dir must resolve to this component (fountain's `backup`
  //    CronJob in src/backup/ does; the colliding OperatorRole, with no
  //    sourceLoc at all, does not).
  //  - any candidate whose sourceLoc sits under a DIFFERENT known component's
  //    directory belongs to that component, whatever the name says.
  for (const comp of dag.nodes ?? []) {
    const liveNames = comp.attrs?.liveNames;
    if (!Array.isArray(liveNames)) continue;
    const fallbackShaped = liveNames.length === 1 && liveNames[0] === comp.id;
    const owned = liveNames.filter((n): n is string => {
      if (typeof n !== "string" || !nodeById.has(n)) return false;
      const src = sourceComponent(n);
      return fallbackShaped ? src === comp.id : src === undefined || src === comp.id;
    });
    if (owned.length === 0) continue;
    compToNode.set(comp.id, owned.find((n) => !n.startsWith("byo")) ?? owned[0]);
  }

  // Pass 1.5 — nodes that carry their owning component outright. The
  // synthesized Helm::Release cards (src/helm-releases.ts) stamp
  // `attrs.component`; for a component whose whole deploy is helm releases
  // (kubemicrovm's operator — no declared entities at all), the release card
  // is its only presence in the graph, and on the overlay that is exactly
  // where its dependsOn edges belong.
  for (const n of ir.nodes) {
    const component = n.attrs?.component;
    if (typeof component !== "string" || !knownComponents.has(component) || compToNode.has(component)) continue;
    compToNode.set(component, n.id);
  }

  // Pass 2 — the kebab-kind heuristic, only for components that mapped nothing:
  // a collapsed composite's kind PascalCases to its component name. Skip
  // lexicon-qualified kinds (Docker::Compose::Service etc.) — not composites.
  const unmapped = new Set<string>();
  for (const e of dag.edges) {
    if (!compToNode.has(e.from)) unmapped.add(e.from);
    if (!compToNode.has(e.to)) unmapped.add(e.to);
  }
  if (unmapped.size > 0) {
    for (const n of ir.nodes) {
      if (n.kind.includes("::")) continue;
      const comp = kebabKind(n.kind);
      if (!unmapped.has(comp)) continue;
      const current = compToNode.get(comp);
      if (!current || (current.startsWith("byo") && !n.id.startsWith("byo"))) compToNode.set(comp, n.id);
    }
  }
  return compToNode;
}

/** Overlay component→component `dependsOn` edges onto each component's
 * representative node. `dag` is the component DAG (`chant graph --components`);
 * see `componentRepresentatives` for how a component finds its node. Mutates +
 * returns `ir`. */
export function addCompositeDeps(ir: GraphIR, dag: ComponentDag): GraphIR {
  const compToNode = componentRepresentatives(ir, dag);

  const declared = new Set(ir.edges.map((e) => `${e.from}\0${e.to}`));
  for (const e of dag.edges) {
    const from = compToNode.get(e.from);
    const to = compToNode.get(e.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\0${to}`;
    if (declared.has(key)) continue;
    declared.add(key);
    ir.edges.push({ from, to, kind: "ref", viaAttr: "dependsOn", inferred: true } as never);
  }
  return ir;
}

/** `addCompositeDeps`, reporting how many edges it attached (#131). Same
 * mutation, same return `ir`; the count rides alongside so a caller can say
 * "nothing mapped" instead of rendering the level below in silence. */
export function addCompositeDepsCounted(ir: GraphIR, dag: ComponentDag): CompositeDepsResult {
  const before = ir.edges.length;
  const out = addCompositeDeps(ir, dag);
  return { ir: out, attached: out.edges.length - before };
}
