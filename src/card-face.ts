/**
 * What a card says that its box does not (#393 item 9).
 *
 * A choudoufu card inside the `terralith-4` box read:
 *
 *     terralith-4/aws_ecs_cluster.main
 *     aws_ecs_cluster · choudoufu
 *     rung: tag-governable
 *     estate: terralith-4
 *
 * Five lines, three of which the box already says — on 301 cards. The member
 * name is the box's title, the estate is the box's estate, `tag-governable` is
 * what all but a handful of instances are, and the word `choudoufu` is the
 * member kind, which is one fact about the whole box and none about this card.
 * A Terraform card had the same shape (`access/baseline/aws_iam_policy.boundary`
 * inside the `baseline` box).
 *
 * So the card keeps its address, its type and whatever is unusual about it.
 *
 * **The id does not move.** `<member>/<address>` is what the overlay joins on,
 * what `/api/diff` keys, what the move plans name and what the SPA looks a
 * clicked card up by. Only the painted label changes.
 *
 * That distinction is the awkward part: pinhole 0.3.8 titles a card from
 * `node.id` and has no per-node title channel (`NodeOverride` carries `fields`
 * and nothing else), and the sub-line is `kind · lexicon`, also unconditional.
 * So the paint is fed a *display* IR — the same graph with the shortened id and
 * the lexicon dropped where the pack has already said what it means — and the
 * ids are put back on the finished SVG, on the three attributes that carry them
 * (`data-node-id`, `data-edge-from`, `data-edge-to`). Everything else about the
 * render is unchanged, and the IR the route returns to the SPA is the original.
 *
 * That trick sets the one limit here: a label two cards would share is not used
 * for either of them. Not for looks — the boxes would tell those two apart on
 * the canvas — but because the id is how the label gets back to being an id
 * again, and a `data-node-id` that two cards claim restores to one of them.
 * Two members declaring the same address is a real estate, not a corner: the
 * live-mv workbench is one estate split four ways, and every one of its 42
 * addresses is declared twice, so it keeps the full ids and reads exactly as it
 * did. A member whose addresses are its own — the terraliths, a Terraform
 * root — shortens every card.
 */
import type { GraphIR, IRNode } from "@intentius/chant";
import type { NodeOverride } from "@intentius/pinhole";
import { CHOUDOUFU_LEXICON, choudoufuCardFields } from "./choudoufu-member.ts";
import { isTerraformCard } from "./terraform-lens.ts";

/** The three SVG attributes pinhole stamps a node id onto. */
const ID_ATTRS = ["data-node-id", "data-edge-from", "data-edge-to"] as const;

/** pinhole's own attribute escaping (`esc`, paint/svg.ts), so the ids put back
 * on the SVG are byte-identical to the ones taken off it. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The box each node is drawn in, from the boxes actually drawn — not from
 * `groups.byStack` when the render asked for different ones, because the rule
 * here is "what the BOX already says", and an undrawn group says nothing. */
function boxOf(boxes: Record<string, string[]> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const [box, ids] of Object.entries(boxes ?? {})) for (const id of ids) if (!out.has(id)) out.set(id, box);
  return out;
}

/**
 * The estate each box stands for: the one every choudoufu card in it declares.
 *
 * A box's TITLE is the member's short directory name, which is often the
 * estate's name and is never guaranteed to be (the member behold was audited
 * against sits in `behold-audit-t1` and declares `behold-audit-inspect`). What
 * the box actually IS, though, is one estate — that is what a choudoufu member
 * is — so the fact a card would be repeating is the estate its neighbours all
 * carry, not the string on the title row. A box holding two estates gets no
 * answer and every card in it keeps its `estate` row, which is the one case
 * where that row is telling the reader something.
 */
function estateOfBox(ir: GraphIR, boxes: Record<string, string[]> | undefined): Map<string, string> {
  const byId = new Map(ir.nodes.map((n) => [n.id, n] as const));
  const out = new Map<string, string>();
  for (const [box, ids] of Object.entries(boxes ?? {})) {
    const estates = new Set<string>();
    for (const id of ids) {
      const n = byId.get(id);
      if (n?.lexicon === CHOUDOUFU_LEXICON && typeof n.attrs.estate === "string") estates.add(n.attrs.estate);
    }
    if (estates.size === 1) out.set(box, [...estates][0]!);
  }
  return out;
}

/**
 * The label a card paints instead of its id, or undefined to keep the id.
 *
 * The general rule is the box prefix: a composed id is `<box>/<rest>`, and the
 * box's own title is on the box. Terraform's roots are the boxes but its ids
 * are `<member>/<root>/<address>`, and the box is titled `<root>` alone unless
 * two members made it ambiguous — so a terraform entity falls back to the
 * address the lexicon put in `attrs.address`, which is the same string either
 * way.
 */
export function cardLabel(node: Pick<IRNode, "id" | "kind" | "lexicon" | "attrs">, box?: string): string | undefined {
  const choudoufu = node.lexicon === CHOUDOUFU_LEXICON;
  const terraform = isTerraformCard(node);
  if (!choudoufu && !terraform) return undefined;
  if (box && node.id.startsWith(`${box}/`) && node.id.length > box.length + 1) return node.id.slice(box.length + 1);
  if (terraform && typeof node.attrs.address === "string" && node.attrs.address && node.attrs.address !== node.id) return node.attrs.address;
  return undefined;
}

export interface CardFaces {
  /** The IR to lay out and paint — shortened labels, no more. */
  ir: GraphIR;
  /** Per-node field overrides, keyed by the DISPLAY id, for `layoutIr` and
   * `renderSvg` both (they must agree, or spacing and drawing diverge). */
  overrides: Record<string, NodeOverride>;
  /** Put the real ids back on a finished SVG. */
  restore(svg: string): string;
}

/**
 * The display IR, the field overrides and the id restore for one render.
 *
 * A no-op — the same IR object back, no overrides, an identity restore — for a
 * graph with no choudoufu or Terraform cards in it, which is every chant
 * estate.
 */
export function cardFaces(ir: GraphIR, boxes?: Record<string, string[]>): CardFaces {
  const box = boxOf(boxes);
  const boxEstate = estateOfBox(ir, boxes);
  const wanted = new Map<string, string>();
  for (const n of ir.nodes) {
    const label = cardLabel(n, box.get(n.id));
    if (label) wanted.set(n.id, label);
  }
  // A label that names two cards names neither: drop the shortening for every
  // node that would land on a taken name, including one an untouched id holds.
  const taken = new Map<string, number>();
  for (const n of ir.nodes) {
    const display = wanted.get(n.id) ?? n.id;
    taken.set(display, (taken.get(display) ?? 0) + 1);
  }
  for (const [id, label] of [...wanted]) if ((taken.get(label) ?? 0) > 1) wanted.delete(id);

  const overrides: Record<string, NodeOverride> = {};
  const choudoufu = ir.nodes.some((n) => n.lexicon === CHOUDOUFU_LEXICON);
  if (wanted.size === 0 && !choudoufu) return { ir, overrides, restore: (svg) => svg };
  const nodes = ir.nodes.map((n) => {
    const display = wanted.get(n.id) ?? n.id;
    if (n.lexicon !== CHOUDOUFU_LEXICON) return display === n.id ? n : { ...n, id: display };
    // The card's second line is `kind · lexicon`, and for a choudoufu card the
    // kind IS the Terraform type — the thing the icon already stands for — so
    // the lexicon is one more repetition of what the box is. Dropped from the
    // paint only; the inspect pane still names the lexicon, and pinhole's icon
    // chain lands on the same glyph either way (the choudoufu pack has no
    // `iconFor` opinion, so both routes reach the keyword heuristic).
    const inBox = box.get(n.id);
    const fields = choudoufuCardFields(n, inBox ? { boxEstate: boxEstate.get(inBox) } : {});
    overrides[display] = { fields: fields ?? [] };
    return { ...n, id: display, lexicon: "" };
  });
  const back = new Map<string, string>();
  for (const [id, label] of wanted) back.set(esc(label), esc(id));
  const display: GraphIR = {
    ...ir,
    nodes,
    edges: ir.edges.map((e) => ({ ...e, from: wanted.get(e.from) ?? e.from, to: wanted.get(e.to) ?? e.to })),
    groups: Object.fromEntries(
      Object.entries(ir.groups ?? {}).map(([key, value]) => [
        key,
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value as Record<string, string[]>).map(([g, ids]) => [g, (ids ?? []).map((id) => wanted.get(id) ?? id)]))
          : value,
      ]),
    ) as GraphIR["groups"],
  };
  const restore = (svg: string): string =>
    back.size === 0
      ? svg
      : svg.replace(new RegExp(`(${ID_ATTRS.join("|")})="([^"]*)"`, "g"), (whole, attr: string, value: string) => {
          const real = back.get(value);
          return real === undefined ? whole : `${attr}="${real}"`;
        });
  return { ir: display, overrides, restore };
}
