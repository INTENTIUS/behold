/**
 * behold#1070: draw a `behold-graph/1` document, the work the viewer hands
 * its Web Worker. The same renderGraph and box badges `/api/graph` draws
 * with, over the IR src/viewer/document-ir.ts rebuilds from the document.
 *
 * A boxed document is laid out box by box (pinhole lays each box's cards out
 * and then packs the boxes), which is what keeps a large estate quick. A
 * document with no boxes is one layout over every card, which grows much
 * faster than the card count, so above {@link FLAT_LIMIT} cards it is
 * refused with the reason rather than left to hang the page.
 *
 * The picture is painted in pinhole's default theme. Every colour in it is a
 * `--pin-<token>` variable, so the viewer themes it by setting those.
 */
import { checkGraphDocument, type GraphDocument } from "../graph-document.ts";
import { boxBadges } from "../collapse-lens.ts";
import { renderGraph } from "../render.ts";
import { documentToIr } from "./document-ir.ts";

/**
 * The most cards drawn as one flat layout. Measured on the `kubernetes/k8s.io`
 * `infra/` document with its boxes taken off, the first n cards and the edges
 * between them, on a laptop: 300 cards lay out in 1.2 s, 400 in 12 s, 600 in
 * 42 s and 800 in 164 s. A boxed document has no such limit.
 */
export const FLAT_LIMIT = 300;

export type PaintResult =
  | { ok: true; svg: string; cards: number; ms: number }
  | { ok: false; error: string; code: "not-a-document" | "too-flat" | "paint-failed" };

export interface PaintOptions {
  /** Override {@link FLAT_LIMIT}. */
  flatLimit?: number;
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function paintDocument(value: unknown, opts: PaintOptions = {}): PaintResult {
  const checked = checkGraphDocument(value);
  if (!checked.ok) return { ok: false, error: checked.error, code: "not-a-document" };
  const doc: GraphDocument = checked.document;
  const { ir, boxes, flat } = documentToIr(doc);
  const limit = opts.flatLimit ?? FLAT_LIMIT;
  if (flat && ir.nodes.length > limit) {
    return {
      ok: false,
      code: "too-flat",
      error: `${ir.nodes.length} cards and no boxes to lay them out in: the viewer draws at most ${limit} cards as one layout. Cut it around a card or a root first.`,
    };
  }
  const t0 = now();
  try {
    const { svg } = renderGraph(ir, {
      ...(boxes ? { boxes } : {}),
      ...(boxes === "byStack" ? { groupBadges: boxBadges(ir) } : {}),
    });
    return { ok: true, svg, cards: ir.nodes.length, ms: Math.round(now() - t0) };
  } catch (e) {
    return { ok: false, code: "paint-failed", error: `the painter failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
