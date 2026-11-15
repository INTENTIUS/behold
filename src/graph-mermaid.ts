/**
 * behold#1060: a compact Mermaid writer for a `behold-graph/1` document, with
 * a character budget per forge (src/mermaid-budgets.ts).
 *
 * The text is deterministic: card ids are `n<index>` over the cards sorted by
 * id, boxes are `g<index>` over the boxes sorted by id, and the same document
 * gives the same bytes. One label line per card, boxes as subgraphs, inferred
 * edges dotted. When the document carries a change (`change` on a card) or a
 * cut's seeds, the cards are painted by `classDef`: added, changed, removed,
 * and neighbour for the cards in the cut that were not asked for or changed.
 *
 * Labels are quoted and escaped with Mermaid's entity codes, so no label can
 * open a tag, a link or a markdown string under the strict security level.
 * Nothing the writer prints contains `&`, so no link chain is ever spent.
 *
 * When the graph does not fit the budget the writer drops neighbours first,
 * then whole boxes (the ones with the fewest changed cards first), and ends
 * with a card saying how many cards are not shown. It never returns text over
 * the budget. This module imports no `node:*`, so a browser host can use it.
 */
import type { GraphDocument, GraphDocumentNode } from "./graph-document.ts";
import { DEFAULT_FORGE, FORGE_BUDGETS, type Forge, type ForgeBudget } from "./mermaid-budgets.ts";

export interface MermaidOptions {
  /** Which forge's budget to fit. Default github. */
  forge?: Forge;
  /** An explicit budget, which wins over `forge`. */
  budget?: ForgeBudget;
}

export interface MermaidResult {
  /** Mermaid source, without a fence. Within the budget. */
  text: string;
  /** Cards drawn. */
  shown: number;
  /** Cards the budget left out. */
  hidden: number;
  /** Edges drawn. */
  edges: number;
}

type ChangeClass = "added" | "changed" | "removed" | "neighbour";

const CLASS_DEFS: Readonly<Record<ChangeClass, string>> = {
  added: "classDef added fill:#dafbe1,stroke:#1a7f37,color:#1f2328",
  changed: "classDef changed fill:#fff8c5,stroke:#9a6700,color:#1f2328",
  removed: "classDef removed fill:#ffebe9,stroke:#cf222e,color:#1f2328",
  neighbour: "classDef neighbour fill:#f6f8fa,stroke:#8c959f,stroke-dasharray:4 2,color:#1f2328",
};

const LABEL_MAX = 48;

/** Mermaid's entity codes for the characters that mean something inside a label. */
const ENTITY: Readonly<Record<string, string>> = { "#": "35", '"': "quot", "<": "lt", ">": "gt", "&": "amp", "`": "96", "%": "37", "\\": "92" };

/** A string as the inside of a quoted Mermaid label. */
export function escapeLabel(text: string, max = LABEL_MAX): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const cut = [...flat].length > max ? `${[...flat].slice(0, max - 3).join("")}...` : flat;
  return cut.replace(/[#"<>&`%\\]/g, (c) => `#${ENTITY[c]};`);
}

function classOf(n: GraphDocumentNode, marked: boolean): ChangeClass | undefined {
  const c = n.change;
  if (c) {
    if (c === "create" || c === "added") return "added";
    if (c === "delete" || c === "removed") return "removed";
    return "changed";
  }
  if (marked && !n.seed) return "neighbour";
  return undefined;
}

/** True when the document marks some cards apart from the rest: a plan's changes, or a cut's seeds. */
function isMarked(doc: GraphDocument): boolean {
  return doc.nodes.some((n) => n.change || n.seed);
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface Model {
  doc: GraphDocument;
  nodes: GraphDocumentNode[];
  nid: Map<string, string>;
  gid: Map<string, string>;
  cls: Map<string, ChangeClass | undefined>;
  marked: boolean;
  /** Distinct edges, `dotted` when every edge between the pair is inferred. */
  edges: { s: string; t: string; dotted: boolean }[];
  /** The outermost box of each box. */
  top: Map<string, string>;
}

function model(doc: GraphDocument): Model {
  const nodes = [...doc.nodes].sort(byId);
  const groups = [...doc.groups].sort(byId);
  const nid = new Map(nodes.map((n, i) => [n.id, `n${i}`]));
  const gid = new Map(groups.map((g, i) => [g.id, `g${i}`]));
  const marked = isMarked(doc);
  const cls = new Map(nodes.map((n) => [n.id, classOf(n, marked)]));
  const pair = new Map<string, { s: string; t: string; dotted: boolean }>();
  for (const e of doc.edges) {
    if (!nid.has(e.source) || !nid.has(e.target)) continue;
    const key = `${e.source}\u0000${e.target}`;
    const seen = pair.get(key);
    if (seen) seen.dotted = seen.dotted && e.inferred;
    else pair.set(key, { s: e.source, t: e.target, dotted: e.inferred });
  }
  const edges = [...pair.values()].sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0) || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const parent = new Map(groups.map((g) => [g.id, g.parent]));
  const top = new Map<string, string>();
  for (const g of groups) {
    let at = g.id;
    for (let guard = 0; guard <= groups.length; guard++) {
      const p = parent.get(at);
      if (p === undefined || !parent.has(p)) break;
      at = p;
    }
    top.set(g.id, at);
  }
  return { doc, nodes, nid, gid, cls, marked, edges, top };
}

function render(m: Model, keep: ReadonlySet<string>, hidden: number): { text: string; edges: number } {
  const lines = ["flowchart TD"];
  const groups = [...m.doc.groups].sort(byId);
  const known = new Set(groups.map((g) => g.id));
  const hasKept = new Map<string, boolean>();
  const children = new Map<string | undefined, string[]>();
  for (const g of groups) {
    const p = g.parent !== undefined && known.has(g.parent) && g.parent !== g.id ? g.parent : undefined;
    children.set(p, [...(children.get(p) ?? []), g.id]);
  }
  const cardsIn = new Map<string | undefined, GraphDocumentNode[]>();
  for (const n of m.nodes) {
    if (!keep.has(n.id)) continue;
    const b = n.box !== undefined && known.has(n.box) ? n.box : undefined;
    cardsIn.set(b, [...(cardsIn.get(b) ?? []), n]);
  }
  const visiting = new Set<string>();
  const has = (g: string): boolean => {
    const cached = hasKept.get(g);
    if (cached !== undefined) return cached;
    if (visiting.has(g)) return false;
    visiting.add(g);
    const r = (cardsIn.get(g)?.length ?? 0) > 0 || (children.get(g) ?? []).some(has);
    visiting.delete(g);
    hasKept.set(g, r);
    return r;
  };
  const card = (n: GraphDocumentNode): string => {
    const c = m.cls.get(n.id);
    return `${m.nid.get(n.id)}["${escapeLabel(n.title || n.id)}"]${c ? `:::${c}` : ""}`;
  };
  const emitted = new Set<string>();
  const walk = (g: string): void => {
    if (emitted.has(g) || !has(g)) return;
    emitted.add(g);
    const title = m.doc.groups.find((x) => x.id === g)?.title ?? g;
    lines.push(`subgraph ${m.gid.get(g)}["${escapeLabel(title)}"]`);
    for (const c of children.get(g) ?? []) walk(c);
    for (const n of cardsIn.get(g) ?? []) lines.push(card(n));
    lines.push("end");
  };
  for (const g of children.get(undefined) ?? []) walk(g);
  // A box whose parent loop never reaches the top still draws once.
  for (const g of groups) walk(g.id);
  for (const n of cardsIn.get(undefined) ?? []) lines.push(card(n));
  let edges = 0;
  for (const e of m.edges) {
    if (!keep.has(e.s) || !keep.has(e.t)) continue;
    edges++;
    lines.push(`${m.nid.get(e.s)} ${e.dotted ? "-.->" : "-->"} ${m.nid.get(e.t)}`);
  }
  if (hidden > 0) lines.push(`more["${hidden} ${hidden === 1 ? "card" : "cards"} not shown"]`);
  if (m.marked) for (const c of Object.keys(CLASS_DEFS) as ChangeClass[]) lines.push(CLASS_DEFS[c]);
  return { text: `${lines.join("\n")}\n`, edges };
}

const fits = (b: ForgeBudget, r: { text: string; edges: number }): boolean =>
  r.text.length <= b.blockChars && (b.maxEdges === undefined || r.edges <= b.maxEdges);

/** The largest k in [0, n] for which `ok(k)` holds, taking `ok` to hold for a prefix of the range. -1 when not even 0 does. */
function largest(n: number, ok: (k: number) => boolean): number {
  if (!ok(0)) return -1;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ok(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The graph as Mermaid within the budget, with how much of it was drawn. */
export function mermaidDiagram(doc: GraphDocument, opts: MermaidOptions = {}): MermaidResult {
  const budget = opts.budget ?? FORGE_BUDGETS[opts.forge ?? DEFAULT_FORGE];
  const m = model(doc);
  const total = m.nodes.length;
  if (total === 0) {
    const text = `flowchart TD\nempty["no cards"]\n`;
    return { text: fits(budget, { text, edges: 0 }) ? text : "", shown: 0, hidden: 0, edges: 0 };
  }
  const draw = (keep: Set<string>): MermaidResult & { ok: boolean } => {
    const hidden = total - keep.size;
    const r = render(m, keep, hidden);
    return { text: r.text, shown: keep.size, hidden, edges: r.edges, ok: fits(budget, r) };
  };

  const core = m.nodes.filter((n) => m.cls.get(n.id) !== "neighbour");
  const coreIds = new Set(core.map((n) => n.id));
  const neighbours = m.nodes.filter((n) => m.cls.get(n.id) === "neighbour");
  const degree = new Map<string, number>();
  for (const e of m.edges) {
    if (coreIds.has(e.s) !== coreIds.has(e.t)) {
      const other = coreIds.has(e.s) ? e.t : e.s;
      degree.set(other, (degree.get(other) ?? 0) + 1);
    }
  }
  neighbours.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || byId(a, b));

  // Phase one: every card that is not a neighbour, and as many neighbours as fit.
  const withNeighbours = (k: number): Set<string> => new Set([...coreIds, ...neighbours.slice(0, k).map((n) => n.id)]);
  const k = largest(neighbours.length, (j) => draw(withNeighbours(j)).ok);
  if (k >= 0) {
    const { ok: _ok, ...r } = draw(withNeighbours(k));
    return r;
  }

  // Phase two: whole boxes, the ones holding the most changed cards first, then the smaller ones.
  const unitOf = (n: GraphDocumentNode): string => (n.box !== undefined && m.top.has(n.box) ? `g:${m.top.get(n.box)}` : `n:${n.id}`);
  const units = new Map<string, { key: string; ids: string[]; marked: number }>();
  for (const n of core) {
    const key = unitOf(n);
    const u = units.get(key) ?? { key, ids: [], marked: 0 };
    u.ids.push(n.id);
    if (n.change || n.seed) u.marked++;
    units.set(key, u);
  }
  const order = [...units.values()].sort((a, b) => b.marked - a.marked || a.ids.length - b.ids.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const withUnits = (j: number): Set<string> => new Set(order.slice(0, j).flatMap((u) => u.ids));
  let j = largest(order.length, (x) => draw(withUnits(x)).ok);
  if (j < 0) {
    const bare = `flowchart TD\n`;
    return { text: fits(budget, { text: bare, edges: 0 }) ? bare : "", shown: 0, hidden: total, edges: 0 };
  }
  for (; j > 0 && !draw(withUnits(j)).ok; j--);
  const { ok: _ok, ...r } = draw(withUnits(j));
  return r;
}

/** `mermaidDiagram`'s text. */
export function toMermaid(doc: GraphDocument, opts: MermaidOptions = {}): string {
  return mermaidDiagram(doc, opts).text;
}

const cell = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|").replace(/`/g, "'");

/** Where a card is applied from: its Terraform root, else the outermost box it is drawn in, else its member. */
function rootOf(doc: GraphDocument, byBox: Map<string, string>, n: GraphDocumentNode): string {
  return n.detail__root ?? (n.box !== undefined ? byBox.get(n.box) : undefined) ?? n.detail__member ?? "(no root)";
}

/**
 * A per-root table in Markdown, for when the diagram does not fit: one row per
 * root (the box a card is drawn in, or its Terraform root or member) with its
 * cards, and its added, changed and removed counts when the document has any
 * change. `maxChars` cuts the rows that do not fit and says how many.
 */
export function rootTable(doc: GraphDocument, maxChars = Infinity): string {
  const groups = new Map(doc.groups.map((g) => [g.id, g]));
  const byBox = new Map<string, string>();
  for (const g of doc.groups) {
    let at = g;
    for (let guard = 0; at.parent !== undefined && groups.has(at.parent) && guard <= doc.groups.length; guard++) at = groups.get(at.parent)!;
    byBox.set(g.id, at.title);
  }
  const rows = new Map<string, { cards: number; added: number; changed: number; removed: number }>();
  let anyChange = false;
  for (const n of doc.nodes) {
    const key = rootOf(doc, byBox, n);
    const r = rows.get(key) ?? { cards: 0, added: 0, changed: 0, removed: 0 };
    r.cards++;
    const c = classOf(n, false);
    if (c === "added" || c === "changed" || c === "removed") {
      r[c]++;
      anyChange = true;
    }
    rows.set(key, r);
  }
  const sorted = [...rows.entries()].sort(([ka, a], [kb, b]) => b.added + b.changed + b.removed - (a.added + a.changed + a.removed) || b.cards - a.cards || (ka < kb ? -1 : ka > kb ? 1 : 0));
  const head = anyChange ? "| Root | Cards | Added | Changed | Removed |\n| --- | ---: | ---: | ---: | ---: |\n" : "| Root | Cards |\n| --- | ---: |\n";
  const line = ([k, r]: [string, (typeof sorted)[number][1]]): string => (anyChange ? `| ${cell(k)} | ${r.cards} | ${r.added} | ${r.changed} | ${r.removed} |\n` : `| ${cell(k)} | ${r.cards} |\n`);
  let out = head;
  for (let i = 0; i < sorted.length; i++) {
    const more = sorted.length - i;
    const tail = `\n${more} more ${more === 1 ? "root" : "roots"} not listed.\n`;
    const next = line(sorted[i]!);
    if (out.length + next.length + (i + 1 < sorted.length ? tail.length : 0) > maxChars) {
      return `${out}${tail}`;
    }
    out += next;
  }
  return out;
}

export interface ForgeComment {
  /** The whole comment body. Under the budget's `commentChars`. */
  text: string;
  /** `diagram` when the whole graph fit its block, `table` when it did not. */
  kind: "diagram" | "table";
  hidden: number;
}

/**
 * The comment body for a forge: a marker line, a count line, and the diagram in
 * a mermaid fence. When the diagram has to leave cards out, or the whole comment
 * would reach the forge's comment limit, the per-root table takes its place.
 */
export function forgeComment(doc: GraphDocument, opts: MermaidOptions & { marker: string }): ForgeComment {
  const budget = opts.budget ?? FORGE_BUDGETS[opts.forge ?? DEFAULT_FORGE];
  const marker = `<!-- ${opts.marker} -->\n`;
  const cards = doc.nodes.length;
  const d = mermaidDiagram(doc, opts);
  const count = `${cards} ${cards === 1 ? "card" : "cards"}, ${doc.edges.length} ${doc.edges.length === 1 ? "edge" : "edges"}`;
  if (d.hidden === 0 && d.text) {
    const text = `${marker}${count}\n\n\`\`\`mermaid\n${d.text}\`\`\`\n`;
    if (text.length < budget.commentChars) return { text, kind: "diagram", hidden: 0 };
  }
  const head = `${marker}${count}, by root\n\n`;
  return { text: `${head}${rootTable(doc, budget.commentChars - head.length - 1)}`, kind: "table", hidden: d.hidden };
}
