/**
 * behold#1061: the graph as one self-contained SVG, from the painter the
 * server uses (`renderGraph`, src/render.ts). `behold graph --svg` prints it.
 *
 * The picture is the one `/api/graph` answers for the same view: a view with
 * Terraform roots or workspace members is boxed by them (`byStack`, with the
 * count badges), and a view with no boxes is laid out flat. A flat layout is
 * slow (see FLAT_NODE_LIMIT), so a graph over the limit is refused with the
 * two ways out, a boxed view or a cut, instead of left to run for minutes.
 *
 * A cut works on the document (src/graph-cut.ts). The painter takes the
 * graph IR, so the cut is applied here as a filter: the cards, edges and boxes
 * the cut kept. What a card carries (`attrs._plan`, the plan facts the
 * served page prints as the change row) rides through, so a plan's change
 * shows on the card as it does in the page. The painter has no mark for
 * `seed` yet: the cards a cut was asked for are drawn like their neighbours.
 */
import type { GraphIR } from "@intentius/chant";
import { getTheme } from "@intentius/pinhole";
import { boxBadges } from "./collapse-lens.ts";
import { renderGraph } from "./render.ts";

/** The themes `--theme` takes. */
export const SVG_THEMES = ["light", "dark"] as const;
export type SvgTheme = (typeof SVG_THEMES)[number];

export function isSvgTheme(v: string): v is SvgTheme {
  return (SVG_THEMES as readonly string[]).includes(v);
}

/**
 * The most cards laid out as one flat graph, with no boxes. dagre's cost grows
 * faster than the card count. Measured on the first n cards of the 609-card
 * k8s.io infra read with the boxes taken off (Apple silicon, paint only):
 * 100 cards 0.1 s, 200 2.6 s, 300 5.2 s, 400 10.5 s, 500 36 s. The same 609
 * cards boxed by root paint in 16 s. The limit is the last size under about
 * 10 s.
 */
export const FLAT_NODE_LIMIT = 400;

export interface ToSvgOptions {
  /** pinhole's theme name. Default is the painter's own (dark). */
  theme?: SvgTheme;
  /** The ids of the cards a cut kept. Absent is the whole graph. */
  keep?: ReadonlySet<string>;
  /** Draw a flat graph over FLAT_NODE_LIMIT instead of refusing it. */
  allowFlat?: boolean;
}

/** The error `toSvg` throws for a flat graph over the limit. */
export class FlatLayoutTooLarge extends Error {
  constructor(public readonly cards: number) {
    super(
      `${cards} cards with no boxes is too many to lay out flat (the limit is ${FLAT_NODE_LIMIT}); ` +
        "read a workspace or a folder with Terraform roots so the cards are boxed, or cut the graph first",
    );
    this.name = "FlatLayoutTooLarge";
  }
}

/** The graph IR with only the cards in `keep`, the edges between them, and the boxes that still hold a card. */
export function keepCards(ir: GraphIR, keep: ReadonlySet<string>): GraphIR {
  const groups: Record<string, unknown> = {};
  for (const [kind, boxes] of Object.entries(ir.groups as Record<string, unknown>)) {
    if (boxes === null || typeof boxes !== "object" || Array.isArray(boxes)) {
      groups[kind] = boxes;
      continue;
    }
    const kept: Record<string, unknown> = {};
    for (const [key, members] of Object.entries(boxes as Record<string, unknown>)) {
      if (!Array.isArray(members)) {
        kept[key] = members;
        continue;
      }
      const inside = members.filter((m) => typeof m !== "string" || keep.has(m));
      if (inside.length) kept[key] = inside;
    }
    groups[kind] = kept;
  }
  return {
    ...ir,
    nodes: ir.nodes.filter((n) => keep.has(n.id)),
    edges: ir.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    groups: groups as GraphIR["groups"],
  };
}

/** The picture of `ir` as SVG text. */
export function toSvg(irIn: GraphIR, opts: ToSvgOptions = {}): string {
  const ir = opts.keep ? keepCards(irIn, opts.keep) : irIn;
  const byStack = ir.groups.byStack && Object.keys(ir.groups.byStack).length > 0;
  if (!byStack && !opts.allowFlat && ir.nodes.length > FLAT_NODE_LIMIT) throw new FlatLayoutTooLarge(ir.nodes.length);
  const { svg } = renderGraph(ir, {
    ...(byStack ? { boxes: "byStack" as const, groupBadges: boxBadges(ir) } : {}),
    // renderGraph hands `theme` to pinhole as it is, and pinhole takes the resolved theme, not its name.
    ...(opts.theme ? { theme: getTheme(opts.theme) as never } : {}),
  });
  return svg;
}
