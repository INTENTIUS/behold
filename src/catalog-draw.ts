/**
 * behold#1080: what chant's reference catalog found, drawn.
 *
 * `applyReferenceCatalog` (src/reference-catalog.ts) puts the catalog on the
 * composed estate. This module draws the three things it says that a plain
 * edge cannot:
 *
 *  - a joined edge, one chant drew by a catalog rule (an exact match, not the
 *    name guess behold's `inferred` edges are), weighed "joined" apart from
 *    "inferred" (web/edge-weight.js) and carrying its rule in its tooltip;
 *  - a dangling reference, a value that names a node nothing declares, as a
 *    dashed placeholder card beside its holder, titled with the value and
 *    saying the rule, with a dashed edge to it. One card stands for every
 *    holder in a member that names the same kind and value;
 *  - an ambiguous reference, a value that names several nodes, as one dotted
 *    edge to each candidate, labelled "one of N". chant draws none, and neither
 *    does behold pick one.
 *
 * A dangling reference through a `containment` rule (an object whose namespace
 * is not declared here) is left to the note and the card's own list: a
 * placeholder for each namespace would draw a card nobody asked about on every
 * estate of plain manifests.
 *
 * {@link drawCatalog} adds the cards and edges to the IR the route answers and
 * the document writes; {@link stampCatalogSvg} marks them on the finished SVG
 * (data attributes the page's styles take, inline strokes a static export
 * keeps, a tooltip each) and appends the key.
 */
import type { GraphIR, IREdge, IRNode } from "@intentius/chant";
import { CATALOG_WEIGHTS, WEIGHTS, edgeWeights, weightLegend } from "../web/edge-weight.js";
import { catalogOfIr, type CatalogDangling, type CatalogIr, type IrCatalog } from "./reference-catalog-shape.ts";

type Rec = Record<string, unknown>;

/** The lexicon a placeholder card is drawn under. */
export const PLACEHOLDER_LEXICON = "behold";

/** The attr that marks a placeholder card, holding the value it names. */
export const PLACEHOLDER_ATTR = "_placeholder";

/** Whether a card is a dangling reference's placeholder. */
export function isPlaceholder(n: Pick<IRNode, "attrs">): boolean {
  return typeof n.attrs?.[PLACEHOLDER_ATTR] === "string";
}

/** The words of a rule: its label when the catalog has one, else the attribute it reads. */
function ruleWords(catalog: IrCatalog, rule: string, fallback = ""): string {
  return catalog.rules[rule]?.label || fallback || rule;
}

const boxOf = (ir: GraphIR): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [box, ids] of Object.entries((ir.groups.byStack ?? {}) as Record<string, string[]>)) for (const id of ids) if (!out.has(id)) out.set(id, box);
  return out;
};

/** The id of the placeholder card for a dangling reference, one per box, kind and value. */
export function placeholderId(box: string | undefined, d: Pick<CatalogDangling, "targetKind" | "value">): string {
  return `dangling:${box ?? ""}:${d.targetKind ?? "?"}:${d.value}`;
}

/**
 * The IR with the catalog's dangling and ambiguous references drawn. Pure.
 * An IR with no catalog, or one already drawn, comes back as it is.
 */
export function drawCatalog(ir: GraphIR): GraphIR {
  const catalog = catalogOfIr(ir);
  if (!catalog || ir.nodes.some(isPlaceholder)) return ir;
  const ids = new Set(ir.nodes.map((n) => n.id));
  const box = boxOf(ir);
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  const byStack: Record<string, string[]> = {};
  const pairs = new Set(ir.edges.map((e) => `${e.from}\0${e.to}`));

  const add = (e: Rec & { from: string; to: string }): void => {
    const key = `${e.from}\0${e.to}`;
    if (pairs.has(key)) return;
    pairs.add(key);
    edges.push({ kind: "ref", ...e } as unknown as IREdge);
  };

  const cards = new Map<string, IRNode>();
  for (const d of catalog.dangling) {
    if (!ids.has(d.from)) continue;
    const rule = catalog.rules[d.rule];
    if (rule?.relation === "containment") continue;
    const holderBox = box.get(d.from);
    const id = placeholderId(holderBox, d);
    let card = cards.get(id);
    if (!card) {
      card = {
        id,
        kind: d.targetKind ?? "Unresolved",
        lexicon: PLACEHOLDER_LEXICON,
        attrs: {
          [PLACEHOLDER_ATTR]: d.value,
          // The card prints the rule in words; its id is on the tooltip and in the inspect pane.
          _rule: d.rule,
          rule: ruleWords(catalog, d.rule, d.path),
          ...(d.through ? { through: d.through } : {}),
          ...(d.cluster ? { cluster: d.cluster } : {}),
        },
      } as unknown as IRNode;
      cards.set(id, card);
      nodes.push(card);
      if (holderBox !== undefined) (byStack[holderBox] ??= []).push(id);
    }
    add({ from: d.from, to: id, viaAttr: ruleWords(catalog, d.rule, d.path), inferred: true, rule: d.rule, dangling: true, ...(d.path ? { path: d.path } : {}) });
  }

  for (const a of catalog.ambiguous) {
    if (!ids.has(a.from)) continue;
    const of = a.candidates.length;
    for (const to of a.candidates) {
      if (!ids.has(to) || to === a.from) continue;
      add({ from: a.from, to, viaAttr: `one of ${of}`, inferred: true, rule: a.rule, ambiguous: { of, rule: a.rule, value: a.value, path: a.path } });
    }
  }

  if (nodes.length === 0 && edges.length === 0) return ir;
  const groups = { ...ir.groups } as Record<string, unknown>;
  if (Object.keys(byStack).length) {
    const stacks: Record<string, string[]> = { ...((ir.groups.byStack ?? {}) as Record<string, string[]>) };
    for (const [b, extra] of Object.entries(byStack)) stacks[b] = [...(stacks[b] ?? []), ...extra];
    groups.byStack = stacks;
  }
  const out = { ...ir, nodes: [...ir.nodes, ...nodes], edges: [...ir.edges, ...edges], groups: groups as GraphIR["groups"] } as CatalogIr;
  return out;
}

/** The catalog weight of each drawn edge (`from→to`), for the three weights the catalog adds. */
export function catalogEdgeWeights(ir: GraphIR): Map<string, string> {
  const catalog = catalogOfIr(ir);
  const all = edgeWeights(ir.edges as never, new Map(ir.nodes.map((n) => [n.id, n.kind])), catalog?.rules);
  const out = new Map<string, string>();
  for (const [k, w] of all) if (CATALOG_WEIGHTS.includes(w)) out.set(k, w);
  return out;
}

/** The key's rows for what the catalog drew: one per weight present. Empty when it drew none. */
export function catalogLegend(ir: GraphIR): Array<{ weight: string; label: string; title: string; count: number }> {
  const weights = catalogEdgeWeights(ir);
  return weightLegend(weights).filter((r) => CATALOG_WEIGHTS.includes(r.weight));
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The tooltip of an edge the catalog drew: who points at whom, then why. */
export function catalogEdgeTitle(ir: GraphIR, e: IREdge & Rec, weight: string): string {
  const catalog = catalogOfIr(ir);
  const rule = typeof e.rule === "string" ? e.rule : "";
  const words = catalog && rule ? ruleWords(catalog, rule) : "";
  const lines = [`${e.from} → ${e.to}`];
  if (weight === "joined") lines.push(`${words ? `${words}: ` : ""}joined by rule ${rule}`);
  else if (weight === "dangling") lines.push(`${words ? `${words}: ` : ""}names nothing declared, rule ${rule}`);
  else {
    const amb = (e.ambiguous ?? {}) as { of?: number; value?: string };
    lines.push(`one of ${amb.of ?? "several"} nodes that "${amb.value ?? ""}" could mean, rule ${rule}; no edge is drawn by chant`);
  }
  return lines.join("\n");
}

/** The tooltip of a placeholder card. */
export function placeholderTitle(n: IRNode): string {
  const a = n.attrs as Rec;
  const kind = n.kind && n.kind !== "Unresolved" ? ` ${n.kind}` : "";
  return `names${kind} "${String(a[PLACEHOLDER_ATTR])}", which nothing in the workspace declares\nrule ${String(a._rule ?? "")}`;
}

/** `stroke-width` and `stroke-dasharray` as the page's styles set them, for a static SVG that has no page. */
function strokeFor(weight: string): { width: string; dash?: string } {
  if (weight === "joined") return { width: "2.2" };
  if (weight === "dangling") return { width: "1.4", dash: "6 4" };
  return { width: "2.4", dash: "0.5 5" };
}

/**
 * Mark the catalog's edges and placeholder cards on a finished SVG and append
 * the key. An IR the catalog drew nothing on gives the SVG back byte for byte.
 */
export function stampCatalogSvg(svg: string, ir: GraphIR): string {
  const weights = catalogEdgeWeights(ir);
  const placeholders = new Map(ir.nodes.filter(isPlaceholder).map((n) => [esc(n.id), n] as const));
  if (weights.size === 0 && placeholders.size === 0) return svg;
  const edgeOf = new Map<string, { e: IREdge & Rec; weight: string }>();
  for (const e of ir.edges as Array<IREdge & Rec>) {
    const weight = weights.get(`${e.from}→${e.to}`);
    if (weight) edgeOf.set(`${esc(e.from)}→${esc(e.to)}`, { e, weight });
  }

  let out = svg.replace(/<g data-edge-from="([^"]*)" data-edge-to="([^"]*)"([^>]*)>([\s\S]*?)<\/g>/g, (whole, from: string, to: string, rest: string, body: string) => {
    // pinhole may paint an edge either way round relative to the IR.
    const found = edgeOf.get(`${from}→${to}`) ?? edgeOf.get(`${to}→${from}`);
    if (!found) return whole;
    const { e, weight } = found;
    // The chip carries the label and no line; only the group with the line is restyled.
    const line = /<path class="pin-edge-line"/.test(body);
    const { width, dash } = strokeFor(weight);
    const styled = line
      ? body.replace(/(<path class="pin-edge-line"[^>]*?)stroke-width="[^"]*"/, `$1stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}`)
      : body;
    const title = line ? `<title>${esc(catalogEdgeTitle(ir, e, weight))}</title>` : "";
    return `<g data-edge-from="${from}" data-edge-to="${to}"${rest} data-edge-weight="${weight}" data-edge-rule="${esc(String(e.rule ?? ""))}">${title}${styled}</g>`;
  });

  out = out.replace(/<g data-node-id="([^"]*)">([\s\S]*?<rect [^>]*?)\/>/g, (whole, id: string, head: string) => {
    const n = placeholders.get(id);
    if (!n) return whole;
    const rect = head.replace(/stroke-width="[^"]*"/, (m) => `${m} stroke-dasharray="6 4"`);
    return `<g data-node-id="${id}" data-node-dangling="true"><title>${esc(placeholderTitle(n))}</title>${rect}/>`;
  });

  return withKey(out, catalogLegend(ir));
}

/** The viewBox and size of the root `<svg>`, or undefined for markup that is not one painter's. */
function frameOf(svg: string): { x: number; y: number; w: number; h: number } | undefined {
  const m = /<svg [^>]*?viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg);
  return m ? { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) } : undefined;
}

const ROW = 20;

/** The key as a group under the picture, with the frame grown to hold it. */
function withKey(svg: string, rows: Array<{ weight: string; title: string; count: number }>): string {
  const frame = frameOf(svg);
  if (!frame || rows.length === 0) return svg;
  const height = rows.length * ROW + 16;
  const top = frame.y + frame.h;
  const body = rows
    .map((r, i) => {
      const y = top + 14 + i * ROW;
      const s = strokeFor(r.weight);
      return (
        `<g data-legend-row="${r.weight}"><path d="M ${frame.x + 16} ${y} L ${frame.x + 52} ${y}" fill="none" stroke="var(--pin-textMuted, #7A8699)" stroke-width="${s.width}"` +
        `${s.dash ? ` stroke-dasharray="${s.dash}"` : ""} stroke-linecap="round"/>` +
        `<text x="${frame.x + 62}" y="${y + 4}" fill="var(--pin-textMuted, #7A8699)" font-size="12">${esc(WEIGHTS[r.weight] ?? r.weight)} · ${r.count}</text></g>`
      );
    })
    .join("");
  const grown = svg
    .replace(/(<svg [^>]*?viewBox=")[^"]*(")/, `$1${frame.x} ${frame.y} ${frame.w} ${frame.h + height}$2`)
    .replace(/(<svg [^>]*?\sheight=")[\d.]+(")/, `$1${frame.h + height}$2`);
  return grown.replace(/<\/svg>\s*$/, `<g data-legend="catalog"><rect x="${frame.x}" y="${top}" width="${frame.w}" height="${height}" fill="var(--pin-bg0, #0B0E14)"/>${body}</g></svg>`);
}
