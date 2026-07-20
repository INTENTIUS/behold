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
 * The one heuristic is mapping a component name to its composite node: a
 * composite's kind is the PascalCase of its component (`LoomBackend` ↔
 * `loom-backend`), and the real instance is preferred over a `byo`-prefixed
 * example twin. Components with no composite node (e.g. downstream-stub, which
 * is all pruned params) simply contribute no edge.
 */
import type { GraphIR, IREdge } from "@intentius/chant";

/** `LoomBackend` → `loom-backend`, `SharedFoundation` → `shared-foundation`. */
export function kebabKind(kind: string): string {
  return kind.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** Overlay component→component `dependsOn` edges onto the collapsed composite
 * nodes. `componentEdges` are the component DAG's edges (from/to = component
 * names). Mutates + returns `ir`. */
export function addCompositeDeps(ir: GraphIR, componentEdges: Pick<IREdge, "from" | "to">[]): GraphIR {
  // component name → composite node id, preferring the real instance over a
  // `byo` example twin (both share a kind). Skip lexicon-qualified kinds
  // (Docker::Compose::Service etc.) — those aren't composites.
  const compToNode = new Map<string, string>();
  for (const n of ir.nodes) {
    if (n.kind.includes("::")) continue;
    const comp = kebabKind(n.kind);
    const current = compToNode.get(comp);
    if (!current || (current.startsWith("byo") && !n.id.startsWith("byo"))) compToNode.set(comp, n.id);
  }

  const declared = new Set(ir.edges.map((e) => `${e.from}\0${e.to}`));
  for (const e of componentEdges) {
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
