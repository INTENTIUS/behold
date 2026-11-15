/**
 * #1067: cut a `behold-graph/1` document around one resource or one box.
 *
 * The walk is web/cut-around.js (#1081); this module does not walk the graph
 * itself. It turns the ids it is given into node ids (an id that names a box,
 * such as a Terraform root, stands for every card drawn in that box or in a box
 * inside it), hands the document's edges to `cutAround` in its own `from`/`to`
 * form, and puts the result back into a document: `cut` says what was asked,
 * each seed card carries `seed: true`, and `notes` count, per box, the
 * neighbours the cut left out.
 *
 * With no `inside` predicate every node is inside, so the cut is the plain
 * depth-bounded one a Terraform estate wants.
 *
 * Nothing here imports from `node:*`, so a browser host can cut a fetched
 * document. src/graph-cut.test.ts walks the module graph to check it.
 */
import { cutAround } from "../web/cut-around.js";
import type { GraphDocument, GraphDocumentGroup, GraphDocumentNote } from "./graph-document.ts";

export type CutDirection = "both" | "up" | "down";

export interface CutDocumentOptions {
  /** Hops from the seeds. Default 1. */
  depth?: number;
  /** Which way to walk: `up` follows what a seed depends on, `down` what depends on it. Default `both`. */
  direction?: CutDirection;
}

export type CutDocumentResult =
  | { ok: true; document: GraphDocument }
  | { ok: false; error: string; missing: string[] };

/** The node ids a start id stands for: the id itself when it is a card, every card in the box (and boxes inside it) when it is a box. */
function expand(doc: GraphDocument, id: string, nodeIds: ReadonlySet<string>): string[] | undefined {
  if (nodeIds.has(id)) return [id];
  if (!doc.groups.some((g) => g.id === id)) return undefined;
  const inside = (box: string | undefined): boolean => {
    for (let at = box, guard = 0; at !== undefined && guard <= doc.groups.length; guard++) {
      if (at === id) return true;
      at = doc.groups.find((g) => g.id === at)?.parent;
    }
    return false;
  };
  return doc.nodes.filter((n) => inside(n.box)).map((n) => n.id);
}

// Seam: `behold graph --around <id>[,<id>...] [--depth n] [--up | --down]` calls cutDocument and exits non-zero on `ok: false`. It waits on #1058 (the CLI).
/**
 * Cut `doc` to `ids` and what they reach within `depth` hops. An id the
 * document holds neither as a card nor as a box makes the result `ok: false`
 * and is named in `error` and `missing`.
 */
export function cutDocument(doc: GraphDocument, ids: readonly string[], opts: CutDocumentOptions = {}): CutDocumentResult {
  const depth = opts.depth ?? 1;
  const direction = opts.direction ?? "both";
  const nodeIds = new Set(doc.nodes.map((n) => n.id));
  const asked = [...new Set(ids)];
  const missing: string[] = [];
  const seedIds: string[] = [];
  for (const id of asked) {
    const members = expand(doc, id, nodeIds);
    if (members) seedIds.push(...members);
    else missing.push(id);
  }
  if (!asked.length) return { ok: false, error: "no start id was given", missing };
  if (missing.length) return { ok: false, error: `the graph holds no card or box ${missing.map((m) => `"${m}"`).join(", ")}`, missing };
  if (!seedIds.length) return { ok: false, error: `${asked.map((m) => `"${m}"`).join(", ")} holds no card`, missing };

  const result = cutAround(
    { nodes: doc.nodes, edges: doc.edges.map((e) => ({ from: e.source, to: e.target })) },
    seedIds,
    { depth, up: direction !== "down", down: direction !== "up" },
  );
  const kept = new Set(result.nodes.map((n) => n.id));
  const seeds = new Set(result.seeds);
  const nodes = result.nodes.map((n) => (seeds.has(n.id) ? { ...n, seed: true } : n));
  const edges = doc.edges.filter((e) => kept.has(e.source) && kept.has(e.target));

  // A box stays when a kept card is drawn in it or in a box inside it, and so do the boxes around it.
  const groupById = new Map(doc.groups.map((g) => [g.id, g]));
  const keptGroups = new Set<string>();
  for (const n of nodes) {
    for (let at = n.box, guard = 0; at !== undefined && !keptGroups.has(at) && guard <= doc.groups.length; guard++) {
      keptGroups.add(at);
      at = groupById.get(at)?.parent;
    }
  }
  const groups: GraphDocumentGroup[] = doc.groups.filter((g) => keptGroups.has(g.id));

  // Per box: the cards outside the cut that a kept card in that box is joined to.
  const boxOf = new Map(doc.nodes.map((n) => [n.id, n.box]));
  const left = new Map<string, Set<string>>();
  const noBox = "";
  for (const e of doc.edges) {
    for (const [inKept, other] of [[e.source, e.target], [e.target, e.source]] as const) {
      if (!kept.has(inKept) || kept.has(other)) continue;
      const box = boxOf.get(inKept) ?? noBox;
      let set = left.get(box);
      if (!set) left.set(box, (set = new Set()));
      set.add(other);
    }
  }
  const notes: GraphDocumentNote[] = doc.notes.filter((n) => n.kind !== "cut-left-out");
  for (const g of groups) {
    const count = left.get(g.id)?.size ?? 0;
    if (count) notes.push({ kind: "cut-left-out", text: `${count} neighbour${count === 1 ? "" : "s"} of the cards in ${g.title} ${count === 1 ? "is" : "are"} outside this cut`, box: g.id, count });
  }
  const loose = left.get(noBox)?.size ?? 0;
  if (loose) notes.push({ kind: "cut-left-out", text: `${loose} neighbour${loose === 1 ? "" : "s"} of cards in no box ${loose === 1 ? "is" : "are"} outside this cut`, count: loose });

  return {
    ok: true,
    document: {
      ...doc,
      cut: { kind: "around", ids: asked, depth, direction },
      nodes,
      edges,
      groups,
      notes,
    },
  };
}
