/**
 * behold#1070: a `behold-graph/1` document back into the graph IR the
 * painter takes, so the single-file viewer draws a document with the same
 * renderGraph the server draws `/api/graph` with.
 *
 * The document keeps each card's innermost box and each box's parent
 * (src/to-document.ts), so the IR's groups are rebuilt by walking up from a
 * card's box: the stack it is in, the pipeline, the wave, the live container.
 * Types only from chant, so this bundles for a browser.
 */
import type { GraphIR, IREdge, IRNode } from "@intentius/chant";
import type { GraphDocument } from "../graph-document.ts";

/** Which boxes renderGraph draws for the document, as the server picks them. */
export type DocumentBoxes = "byStack" | "byContainer" | undefined;

export interface DocumentIr {
  ir: GraphIR;
  boxes: DocumentBoxes;
  /** True when the document has no box at all, so the whole graph is one layout. */
  flat: boolean;
}

const KINDS = { stack: "byStack", pipeline: "byPipeline", wave: "byWave", container: "byContainer" } as const;
type GroupKey = (typeof KINDS)[keyof typeof KINDS];

/** The key a group id carries after its `<kind>:` prefix. */
const keyOf = (id: string, kind: string): string => (id.startsWith(`${kind}:`) ? id.slice(kind.length + 1) : id);

export function documentToIr(doc: GraphDocument): DocumentIr {
  const groups = new Map(doc.groups.map((g) => [g.id, g] as const));
  const out: Record<GroupKey, Record<string, string[]>> = { byStack: {}, byPipeline: {}, byWave: {}, byContainer: {} };
  // Every group the document names is drawn, even one whose cards a cut took away.
  for (const g of doc.groups) {
    const into = KINDS[g.kind as keyof typeof KINDS];
    if (into) out[into][keyOf(g.id, g.kind)] ??= [];
  }
  const add = (into: GroupKey, key: string, id: string) => {
    const list = (out[into][key] ??= []);
    if (!list.includes(id)) list.push(id);
  };
  // A container inside another is listed in it by its key, which is its node's id.
  for (const g of doc.groups) {
    const parent = g.parent ? groups.get(g.parent) : undefined;
    if (g.kind === "container" && parent?.kind === "container") add("byContainer", keyOf(parent.id, "container"), keyOf(g.id, "container"));
  }

  const nodes: IRNode[] = doc.nodes.map((n) => {
    // The first box of each kind on the way up from the card is the one it is in.
    const taken = new Set<string>();
    for (let at = n.box ? groups.get(n.box) : undefined, hops = 0; at && hops < 64; at = at.parent ? groups.get(at.parent) : undefined, hops++) {
      const into = KINDS[at.kind as keyof typeof KINDS];
      if (!into || taken.has(into)) continue;
      taken.add(into);
      add(into, keyOf(at.id, at.kind), n.id);
    }
    return {
      id: n.id,
      kind: n.kind,
      lexicon: n.lexicon,
      attrs: n.attrs ?? {},
      ...(n.file ? { sourceLoc: { file: n.file, ...(n.line ? { line: n.line } : {}) } } : {}),
    } as IRNode;
  });

  const edges: IREdge[] = doc.edges.map(
    (e) =>
      ({
        from: e.source,
        to: e.target,
        kind: e.kind,
        ...(e.via ? { viaAttr: e.via } : {}),
        ...(e.inferred ? { inferred: true } : {}),
      }) as IREdge,
  );

  const irGroups: Record<string, Record<string, string[]>> = {};
  for (const [k, v] of Object.entries(out)) if (Object.keys(v).length) irGroups[k] = v;
  const boxes: DocumentBoxes = irGroups.byContainer ? "byContainer" : irGroups.byStack ? "byStack" : undefined;
  return { ir: { nodes, edges, groups: irGroups } as GraphIR, boxes, flat: Object.keys(irGroups).length === 0 };
}
