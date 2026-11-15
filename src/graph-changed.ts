/**
 * #1059: the cut of what changed between two revisions, plus neighbours.
 *
 *     cutChanged(before, after, { depth, budget }) => GraphDocument
 *
 * `before` and `after` are `behold-graph/1` documents read from the files at
 * two revisions (src/graph-revisions.ts reads them). The cut keeps every card
 * that was added, removed or changed, the cards within `depth` hops of those
 * in either revision (the neighbours), and the edges between what it keeps.
 * Each kept card carries `diff`: `added`, `removed`, `changed` or `neighbour`.
 * A `changed` card names the attribute keys that differ in `changedAttrs`.
 * An edge that exists in one revision only carries `diff` too.
 *
 * Cards are aligned by id and classified as pinhole's `diffNodes` does (the
 * attribute values compared as JSON). The comparison leaves out the fields
 * that name where a block sits in a file, not what it says: `source` (the
 * file's whole text, on every card from it), `file`, `line` and `sourceLoc`.
 * A commit that only reformats a file therefore changes no card. Keys are
 * compared in sorted order, so a block whose keys were reordered is not a
 * change either.
 *
 * The neighbour walk is `cutDocument` (src/graph-cut.ts), run over the union
 * of the two revisions with the changed cards as its seeds; this module does
 * not walk the graph itself.
 *
 * Past `budget` cards the cut folds. First the neighbours go, each box keeping
 * a count of what was left out (`changed-folded` notes). If the changed cards
 * alone are over the budget, the cards go too and one `changed-table` note per
 * box says how many were added, removed and changed. `cut.folded` says which.
 *
 * Nothing here imports from `node:*`, so a browser host can run it on two
 * fetched documents.
 */
import { cutDocument } from "./graph-cut.ts";
import type { GraphDocument, GraphDocumentEdge, GraphDocumentGroup, GraphDocumentNode, GraphDocumentNote } from "./graph-document.ts";

export type ChangeKind = "added" | "removed" | "changed";

/** The cards a cut keeps, past which it folds. */
export const CHANGED_NODE_BUDGET = 60;

/** Attribute keys that say where a block is written, not what it is. */
const POSITION_ATTRS: ReadonlySet<string> = new Set(["source", "file", "line", "sourceLoc"]);

export interface CutChangedOptions {
  /** Hops from a changed card, in either revision. Default 1. */
  depth?: number;
  /** Cards the cut may hold before it folds. Default {@link CHANGED_NODE_BUDGET}. */
  budget?: number;
  /** What to call the two revisions in the cut and its notes. */
  base?: string;
  head?: string;
}

type Rec = Record<string, unknown>;

/** `v` as JSON with every object's keys in sorted order. */
function stable(v: unknown): string {
  const order = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(order);
    if (x !== null && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, order((x as Rec)[k])]));
    return x;
  };
  return JSON.stringify(order(v)) ?? "null";
}

const comparable = (n: GraphDocumentNode): Rec => {
  const attrs: Rec = {};
  for (const [k, v] of Object.entries(n.attrs ?? {})) if (!POSITION_ATTRS.has(k)) attrs[k] = v;
  return attrs;
};

const edgeKey = (e: GraphDocumentEdge): string => `${e.source}>${e.target}>${e.kind}>${e.via ?? ""}`;

const STATUS = { added: "good", removed: "warn", changed: "accent" } as const;

export interface ChangedClassification {
  status: Map<string, ChangeKind>;
  /** For a changed card, the attribute keys that differ. */
  attrs: Map<string, string[]>;
  /** Edges (by key) present in one revision only. */
  edges: Map<string, "added" | "removed">;
}

/** Classify the cards and edges of two documents. A card whose edge to another kept-in-both card was added or removed is `changed` too: its references moved. */
export function classifyChanged(before: GraphDocument, after: GraphDocument): ChangedClassification {
  const b = new Map(before.nodes.map((n) => [n.id, n]));
  const a = new Map(after.nodes.map((n) => [n.id, n]));
  const status = new Map<string, ChangeKind>();
  const attrs = new Map<string, string[]>();
  for (const id of new Set([...b.keys(), ...a.keys()])) {
    const x = b.get(id);
    const y = a.get(id);
    if (x && !y) status.set(id, "removed");
    else if (!x && y) status.set(id, "added");
    else if (x && y) {
      const cx = comparable(x);
      const cy = comparable(y);
      const differ = [...new Set([...Object.keys(cx), ...Object.keys(cy)])].filter((k) => stable(cx[k]) !== stable(cy[k])).sort();
      if (x.kind !== y.kind) differ.unshift("kind");
      if (differ.length) {
        status.set(id, "changed");
        attrs.set(id, differ);
      }
    }
  }
  const be = new Set(before.edges.map(edgeKey));
  const ae = new Set(after.edges.map(edgeKey));
  const edges = new Map<string, "added" | "removed">();
  for (const k of new Set([...be, ...ae])) if (be.has(k) !== ae.has(k)) edges.set(k, ae.has(k) ? "added" : "removed");
  // A reference between two cards that exist in both revisions moved without either card's attributes changing.
  for (const e of [...before.edges, ...after.edges]) {
    if (!edges.has(edgeKey(e)) || !b.has(e.source) || !a.has(e.source) || !b.has(e.target) || !a.has(e.target)) continue;
    for (const id of [e.source, e.target]) if (!status.has(id)) status.set(id, "changed");
  }
  return { status, attrs, edges };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function counts(status: Iterable<ChangeKind>): Record<ChangeKind, number> {
  const c = { added: 0, removed: 0, changed: 0 };
  for (const s of status) c[s]++;
  return c;
}

const words = (c: Record<ChangeKind, number>): string =>
  (["added", "removed", "changed"] as const).filter((k) => c[k]).map((k) => `${c[k]} ${k}`).join(", ") || "nothing";

/** Cut `after` to what changed since `before`, and the neighbours of what changed. See the module header. */
export function cutChanged(before: GraphDocument, after: GraphDocument, opts: CutChangedOptions = {}): GraphDocument {
  const depth = opts.depth ?? 1;
  const budget = opts.budget ?? CHANGED_NODE_BUDGET;
  const range = opts.base && opts.head ? `${opts.base}..${opts.head}` : "the two revisions";
  const { status, attrs, edges: edgeStatus } = classifyChanged(before, after);

  // The union: every card and edge from either revision, the after version where both have it.
  const nodes = new Map<string, GraphDocumentNode>();
  for (const n of before.nodes) nodes.set(n.id, n);
  for (const n of after.nodes) nodes.set(n.id, n);
  const edgeMap = new Map<string, GraphDocumentEdge>();
  for (const e of before.edges) edgeMap.set(edgeKey(e), e);
  for (const e of after.edges) edgeMap.set(edgeKey(e), e);
  const groupMap = new Map<string, GraphDocumentGroup>();
  for (const g of [...before.groups, ...after.groups]) groupMap.set(g.id, g);
  const union: GraphDocument = { ...after, nodes: [...nodes.values()], edges: [...edgeMap.values()], groups: [...groupMap.values()], notes: after.notes };

  const total = counts(status.values());
  const cutBase = { kind: "changed", ...(opts.base ? { base: opts.base } : {}), ...(opts.head ? { head: opts.head } : {}), depth, counts: total };
  const titleOf = (box: string | undefined): string => (box ? groupMap.get(box)?.title ?? box : "no box");

  if (status.size === 0) {
    return {
      ...after,
      cut: cutBase,
      nodes: [],
      edges: [],
      groups: [],
      notes: [...after.notes, { kind: "changed", text: `no card was added, removed or changed between ${range}`, count: 0 }],
    };
  }

  const cut = cutDocument(union, [...status.keys()], { depth, direction: "both" });
  if (!cut.ok) throw new Error(cut.error); // unreachable: every seed is a card of the union
  let doc = cut.document;

  const mark = (n: GraphDocumentNode): GraphDocumentNode => {
    const s = status.get(n.id);
    if (!s) return { ...n, diff: "neighbour" };
    const { seed: _seed, ...rest } = n;
    return { ...rest, diff: s, status: STATUS[s], mainstat: s, ...(attrs.has(n.id) ? { changedAttrs: attrs.get(n.id) } : {}) };
  };
  const markEdge = (e: GraphDocumentEdge): GraphDocumentEdge => {
    const s = edgeStatus.get(edgeKey(e));
    return s ? { ...e, diff: s } : e;
  };
  const overall: GraphDocumentNote = { kind: "changed", text: `${words(total)} between ${range}`, count: status.size };

  const keptNodes = doc.nodes.map(mark);
  const neighbours = keptNodes.filter((n) => n.diff === "neighbour");
  const base: GraphDocument = { ...doc, cut: cutBase, nodes: keptNodes, edges: doc.edges.map(markEdge), notes: [...doc.notes, overall] };
  if (keptNodes.length <= budget) return base;

  // Over the budget: the neighbours fold into a count per box.
  const dropNotes = (notes: GraphDocumentNote[]) => notes.filter((n) => n.kind !== "cut-left-out");
  const boxesOf = (list: GraphDocumentNode[]): Set<string> => {
    const out = new Set<string>();
    const byId = new Map(base.groups.map((g) => [g.id, g]));
    for (const n of list) for (let at = n.box, guard = 0; at !== undefined && !out.has(at) && guard <= base.groups.length; guard++) (out.add(at), (at = byId.get(at)?.parent));
    return out;
  };
  const changedNodes = keptNodes.filter((n) => n.diff !== "neighbour");
  if (changedNodes.length <= budget) {
    const perBox = new Map<string, number>();
    for (const n of neighbours) perBox.set(n.box ?? "", (perBox.get(n.box ?? "") ?? 0) + 1);
    const ids = new Set(changedNodes.map((n) => n.id));
    const folded: GraphDocumentNote[] = [...perBox].map(([box, count]) => ({
      kind: "changed-folded",
      text: `${plural(count, "neighbour", "neighbours")} of the changed cards in ${titleOf(box || undefined)} folded: ${keptNodes.length} cards were over the budget of ${budget}`,
      ...(box ? { box } : {}),
      count,
    }));
    const keep = boxesOf(changedNodes);
    return {
      ...base,
      cut: { ...cutBase, folded: "neighbours", budget },
      nodes: changedNodes,
      edges: base.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
      groups: base.groups.filter((g) => keep.has(g.id)),
      notes: [...dropNotes(base.notes), ...folded],
    };
  }

  // The changed cards alone are over the budget: one line per box.
  const perBox = new Map<string, ChangeKind[]>();
  for (const n of changedNodes) perBox.set(n.box ?? "", [...(perBox.get(n.box ?? "") ?? []), n.diff as ChangeKind]);
  const table: GraphDocumentNote[] = [...perBox].map(([box, list]) => ({
    kind: "changed-table",
    text: `${titleOf(box || undefined)}: ${words(counts(list))}`,
    ...(box ? { box } : {}),
    count: list.length,
  }));
  const keep = boxesOf(changedNodes);
  return {
    ...base,
    cut: { ...cutBase, folded: "table", budget },
    nodes: [],
    edges: [],
    groups: base.groups.filter((g) => keep.has(g.id)),
    notes: [
      ...dropNotes(base.notes).filter((n) => n !== overall),
      { ...overall, text: `${overall.text}; ${plural(changedNodes.length, "changed card is", "changed cards are")} over the budget of ${budget}, so the cut is a table of counts per box` },
      ...table,
    ],
  };
}
