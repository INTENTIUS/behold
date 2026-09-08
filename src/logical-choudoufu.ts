/**
 * The choudoufu lens (#370): the logical topology's projection for a
 * choudoufu member. One box per estate (the `live { estate = … }` name every
 * node carries in `attrs.estate`), every instance and data source a card in
 * it, and the edges the member's own document stated — reader to data source
 * (`reads`), and the cross-member ones the estate passes drew (`tofu-estate`,
 * `owned-by`). No inference: choudoufu's `references[]` are the tool's own
 * claim, and a lens that guessed more would be the HCL parse behold does not
 * do. Every other lens filters its own lexicon and ignores the rest, so a
 * mixed estate merges byte-for-byte as before; `retainCrossLensEdges` keeps
 * the edge between a choudoufu card and a chant one.
 */
import type { GraphIR, IREdge } from "@intentius/chant";
import { CHOUDOUFU_LEXICON } from "./choudoufu-member.ts";
import type { ByContainer, LogicalProjection } from "./logical.ts";

export function estateBoxTitle(estate: string): string {
  return `estate ${estate}`;
}

export function projectChoudoufuLogical(ir: GraphIR): LogicalProjection {
  const cards = ir.nodes.filter((n) => n.lexicon === CHOUDOUFU_LEXICON);
  if (cards.length === 0) return { ir: { nodes: [], edges: [], groups: {} }, byContainer: {} };
  const kept = new Set(cards.map((n) => n.id));
  const byContainer: ByContainer = {};
  for (const n of cards) {
    const estate = n.attrs.estate;
    if (typeof estate !== "string") continue;
    (byContainer[estateBoxTitle(estate)] ??= []).push(n.id);
  }
  const edges: IREdge[] = [];
  const seen = new Set<string>();
  for (const e of ir.edges) {
    if (!kept.has(e.from) || !kept.has(e.to) || seen.has(`${e.from}|${e.to}`)) continue;
    seen.add(`${e.from}|${e.to}`);
    edges.push(e);
  }
  return { ir: { nodes: cards, edges, groups: {} }, byContainer };
}
