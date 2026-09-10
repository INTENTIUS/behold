/**
 * A layout for edgeless boxes (#393).
 *
 * dagre lays a graph out in ranks, and a rank is a row. A box whose cards
 * reference nothing therefore has one rank: every card on the same line. On
 * `terralith-4` — 301 choudoufu cards, zero edges, one member box — that is an
 * SVG of **144010 x 316**, a 455:1 strip where "fit to view" shows a
 * one-pixel line and nothing is clickable. waterpark's `identity` root has the
 * same shape at a smaller width, in a graph that has 49 edges elsewhere, so
 * this is not a property of the graph: it is a property of the box.
 *
 * WHAT PINHOLE OFFERS. `ConceptLayoutOptions` (dist/concept.d.ts) is
 * `rankdir` / `ranksep` / `nodesep` / `groups` / `fit` / `overrides`. `rankdir`
 * turns the strip on its side (316 x 144010 is not an improvement); the two
 * separations scale it. There is no grid mode and no rank constraint, and
 * `layoutIr` reads ranks from `ir.edges` and nothing else — so the one lever
 * that puts a card on row 2 is an edge into it.
 *
 * SO: SYNTHETIC EDGES, FOR THE LAYOUT ONLY. Chain each card to the card
 * `cols` positions later — column chains, so card i lands on rank
 * `floor(i / cols)` — and dagre draws the same box as a grid. `cols` comes
 * from the cards' own painted footprints and a target aspect ({@link
 * ROW_ASPECT}), so a box lands near 2.4:1 whatever its cards are, and never
 * near the 4:1 the audit asks for as a ceiling.
 *
 * These edges are never painted and never returned. {@link withRowChains}
 * builds a COPY of the IR with them appended (`{ ...ir, edges: [...] }`) and
 * the caller passes that copy to `layoutIr`/`layoutArchitecture` and nothing
 * else: `renderSvg` paints edges from the caller's own IR, the route returns
 * the caller's own IR, and `edgelessNote` still reads a real zero. Copying
 * rather than mutate-and-strip is what makes that a property of the code
 * rather than a discipline — there is no window in which the estate's IR
 * carries an edge behold invented. They are flagged all the same
 * ({@link LAYOUT_ROW_VIA}), so a synthetic edge that somehow reached a painted
 * graph would be recognisable rather than mysterious, and
 * {@link withoutRowChains} strips them for a caller that has only the merged
 * IR to hand.
 *
 * MEASURED on the workbench (`/api/graph`'s `svg` viewBox):
 *
 *   terralith-4, detail 2 and 3, source and `env=live` — 301 choudoufu cards,
 *   one member box, no edges anywhere:
 *     before  144010 x 316   455.7:1
 *     after     8186 x 3436    2.4:1
 *
 *   waterpark, five Terraform roots — every root has edges inside it, so no
 *   box here wraps. What moved is the ownership rule below and its twin in
 *   `packMemberBoxes`: waterpark's cards are listed twice (once under the
 *   served directory, once under the root that really holds them), which made
 *   the member box look edgeless AND made its packing block the whole canvas.
 *     detail 2   before 15833 x 1164  13.6:1   after  7499 x 1798   4.2:1
 *     detail 3   before 60230 x 1404  42.9:1   after 29958 x 1982  15.1:1
 *
 *   waterpark at detail 3 was the case this module does NOT answer, and the
 *   number said so. Its `prod` root is 104 cards in 37 connected components —
 *   five clusters and 32 loose cards — and dagre puts all 37 side by side on
 *   three ranks. That is a wide rank, not a single one: the box has plenty of
 *   edges and every one of them is real. `packBoxComponents` (src/render.ts,
 *   #393 item 1) is that fix, a post-layout move with a box resize behind it
 *   rather than an edge, and it took the same two pictures to 3536 x 3138 and
 *   7142 x 6974. It had to exist the moment a choudoufu member grew its own
 *   references: an estate with edges never reaches this module at all, so
 *   `terralith-4` came back a 176:1 strip the day the join landed.
 */
import type { GraphIR, IREdge } from "@intentius/chant";

/** `viaAttr` on an edge this module invented. Not a real attribute name and
 * not a vocabulary anything else reads — the leading underscore is the same
 * convention `_status` uses for a field that is presentation, not estate. */
export const LAYOUT_ROW_VIA = "_layout-row";

/** The aspect a wrapped box aims at, width / height. Wider than a screen
 * (the graph pane is landscape once the inspect pane takes its share) and
 * comfortably under the 4:1 ceiling #393 sets, since the box's own padding and
 * title band only ever make the drawn box taller than the cards it holds. */
export const ROW_ASPECT = 2.4;

/** Below this, a box is left exactly as it laid out. Five cards in a row is a
 * readable row; six is where the strip starts. The point of a floor is that
 * every small picture in the suite stays byte-identical. */
export const ROW_MIN_CARDS = 6;

/** How many columns `n` cards of this size want, to land near `aspect`. The
 * separations are dagre's own (`nodesep` between cards in a rank, `ranksep`
 * between ranks), so the estimate is of the box the layout will actually
 * produce, not of the cards alone. */
export function rowColumns(n: number, cell: { w: number; h: number }, sep: { x: number; y: number }, aspect = ROW_ASPECT): number {
  if (n < 2) return Math.max(1, n);
  const cols = Math.round(Math.sqrt((n * (cell.h + sep.y) * aspect) / (cell.w + sep.x)));
  return Math.max(1, Math.min(n, cols));
}

/** One run of cards laid out on rows of its own inside a box — #393's module
 * sub-boxes are bands, and a box nobody bands is one band of everything. */
export interface RowBand {
  /** The band's key, as `bandOf` returned it; undefined is the box's own
   * remainder, which always sorts first (so a titled band is never the top
   * row, where its title would meet the box's). */
  key: string | undefined;
  ids: string[];
}

/** What {@link withRowChains} did to one box, for a caller that draws
 * something over the result (the module sub-boxes, #393 B). */
export interface RowGrid {
  cols: number;
  rows: number;
  bands: RowBand[];
}

export interface RowChainOptions {
  /** Painted footprints by node id — pinhole's `cardSizes`, the same map the
   * layout sizes cards from, so the column estimate is about the real cards. */
  sizes: ReadonlyMap<string, { w: number; h: number }>;
  /** dagre's separations for the layout this feeds. Defaults are pinhole's
   * `layoutIr` defaults. */
  nodesep?: number;
  ranksep?: number;
  /** Which band a card belongs to inside its box. Cards sharing a band get
   * their own whole rows, in first-appearance order, the remainder first. */
  bandOf?: (id: string) => string | undefined;
  aspect?: number;
  /** Cards below which a box is left alone ({@link ROW_MIN_CARDS}). */
  min?: number;
}

export interface RowChainResult {
  /** The IR to LAY OUT — the caller's nodes and edges plus the synthetic ones.
   * The caller's own object when nothing was chained. Never paint it. */
  ir: GraphIR;
  /** The order each wrapped box's cards were chained in, and its grid. Keyed
   * by the box key the caller passed in `groups`. Empty when nothing wrapped. */
  grids: Map<string, RowGrid>;
}

const FALLBACK = { w: 175, h: 104 };

/**
 * Wrap the edgeless boxes of `groups` into rows.
 *
 * A box qualifies when NO edge in the IR has both ends inside it — which is
 * asked per box, not of the graph, so waterpark's `identity` root wraps while
 * the four roots around it that do reference their own cards keep the layout
 * dagre gave them. `groups` is the same `{ key: [nodeIds] }` map the layout
 * takes (`groups.byStack`, `byContainer`); a key with no entry here is
 * untouched. Pass `{ "": everyId }` to ask it of the whole graph.
 */
export function withRowChains(ir: GraphIR, groups: Readonly<Record<string, readonly string[]>>, opts: RowChainOptions): RowChainResult {
  const min = opts.min ?? ROW_MIN_CARDS;
  const sep = { x: opts.nodesep ?? 64, y: opts.ranksep ?? 72 };
  const known = new Set(ir.nodes.map((n) => n.id));
  // A node can appear in more than one group — a served Terraform directory is
  // a member box AND its roots are boxes, so waterpark's 58 cards are listed
  // twice. pinhole's `layoutIr` parents a node to the LAST group that claims
  // it (`setParent` in insertion order, dist/concept.d.ts: "a node may sit in
  // one group"), so that is the ownership this reads too. Without it the outer
  // box looks edgeless — its cards' edges all count as somebody else's — and
  // gets chained into a grid that fights the boxes actually holding them.
  const boxOf = new Map<string, string>();
  for (const [key, ids] of Object.entries(groups)) for (const id of ids) if (known.has(id)) boxOf.set(id, key);

  // An edge with both ends in one box is that box's own structure, and dagre
  // ranks it better than a grid would. One pass for every box.
  const wired = new Set<string>();
  for (const e of ir.edges) {
    const a = boxOf.get(e.from);
    if (a !== undefined && a === boxOf.get(e.to)) wired.add(a);
  }

  const grids = new Map<string, RowGrid>();
  const chained: IREdge[] = [];
  for (const [key, all] of Object.entries(groups)) {
    const ids = all.filter((id) => boxOf.get(id) === key);
    if (wired.has(key) || ids.length < min) continue;

    const cell = ids.reduce(
      (m, id) => {
        const s = opts.sizes.get(id) ?? FALLBACK;
        return { w: Math.max(m.w, s.w), h: Math.max(m.h, s.h) };
      },
      { w: 0, h: 0 },
    );
    const cols = rowColumns(ids.length, cell.w ? cell : FALLBACK, sep, opts.aspect);
    if (cols >= ids.length) continue; // already one readable row

    const bands = bandsOf(ids, opts.bandOf);
    let rows = 0;
    let previous: RowBand | undefined;
    for (const band of bands) {
      // Column chains: card i of the band gets an edge to card i + cols, so
      // its rank IS its row and dagre's ordering keeps the columns as columns.
      for (let i = 0; i + cols < band.ids.length; i++) chained.push(rowEdge(band.ids[i], band.ids[i + cols]));
      // A band starts on the row after the one before it ends, and the link is
      // a COLUMN-WISE MATCHING: each column's last card to the head of the
      // column below it. Both halves of that matter.
      //
      // dagre ranks by longest path from the sinks, so a chain with nothing
      // under it hangs from the graph's FLOOR. Left unlinked, a band's columns
      // fall past the band below and land beside it: terralith-4's last four
      // rows each held 14 loose cards next to 15 module ones — a 29-card row,
      // 14700 units wide. And the link has to be one edge per column rather
      // than a fan from one card into every head, which constrains the ranks
      // just as well and then drags dagre's x-assignment across the picture:
      // measured at 19116 units for the same 15-card rows. A matching is
      // fifteen short vertical edges and costs the layout nothing.
      //
      // Hanging from the floor also decides where a band's ragged row goes:
      // the columns bottom-align, so a band that does not fill its last row is
      // short at the TOP. Every column then ends on the same rank, which is
      // what lets the matching put the next band's heads all on the next one.
      if (previous) {
        const heads = band.ids.slice(0, cols);
        const tails = columnTails(previous.ids, cols);
        tails.forEach((tail, c) => chained.push(rowEdge(tail, heads[Math.min(c, heads.length - 1)])));
        for (const tail of tails) chained.push(rowEdge(tail, heads[0]));
      }
      rows += Math.ceil(band.ids.length / cols);
      previous = band;
    }
    grids.set(key, { cols, rows, bands });
  }

  return { ir: chained.length ? { ...ir, edges: [...ir.edges, ...chained] } : ir, grids };
}

/** The remainder first, then each band in first-appearance order. */
function bandsOf(ids: readonly string[], bandOf: RowChainOptions["bandOf"]): RowBand[] {
  if (!bandOf) return [{ key: undefined, ids: [...ids] }];
  const rest: string[] = [];
  const banded = new Map<string, string[]>();
  for (const id of ids) {
    const key = bandOf(id);
    if (key === undefined) rest.push(id);
    else (banded.get(key) ?? banded.set(key, []).get(key)!).push(id);
  }
  return [...(rest.length ? [{ key: undefined, ids: rest }] : []), ...[...banded].map(([key, band]) => ({ key, ids: band }))];
}

/** `kind` is chant's `"ref"` literal — the IR has no third edge class and this
 * edge exists for one dagre call, so it borrows the one there is and says what
 * it really is in `viaAttr`. */
function rowEdge(from: string, to: string): IREdge {
  return { from, to, kind: "ref", viaAttr: LAYOUT_ROW_VIA };
}

/** Is this one of ours? */
export function isRowChain(e: Pick<IREdge, "viaAttr">): boolean {
  return e.viaAttr === LAYOUT_ROW_VIA;
}

/** The IR without any layout row chain. {@link withRowChains} never puts one
 * in the caller's IR, so this is a belt for a caller holding a merged one —
 * and the assertion a test can make about any IR behold serves. */
export function withoutRowChains(ir: GraphIR): GraphIR {
  return ir.edges.some(isRowChain) ? { ...ir, edges: ir.edges.filter((e) => !isRowChain(e)) } : ir;
}

/** The last card of each column of a `cols`-wide grid laid out in reading
 * order — the cards at the bottom edge of the band. */
function columnTails(ids: readonly string[], cols: number): string[] {
  const tails: string[] = [];
  for (let c = 0; c < Math.min(cols, ids.length); c++) {
    let last = c;
    for (let i = c; i < ids.length; i += cols) last = i;
    tails.push(ids[last]);
  }
  return tails;
}
