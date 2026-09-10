/**
 * What a box says about itself, and what it looks like shut (#393 C).
 *
 * Two halves of one idea. A member box that holds 301 cards should be able to
 * tell you it holds 301 cards — the audit's ask is `301 resources` on the
 * source graph and `301 · 85 unowned` over a live one — and it should be
 * possible to read the estate at the level of its members without drawing
 * every card in them. So:
 *
 * - {@link boxBadges} puts the count on the box, through the same
 *   `GroupBox.badge` seam #357 opened for the operator's own box
 *   (pinhole#122). Always on; a badge costs a box nothing and is the one thing
 *   a box of 301 unreadable cards can still say at "fit".
 * - {@link collapseBoxes} is the lens (`?collapse=1`): a box over
 *   {@link COLLAPSE_LIMIT} cards becomes ONE card carrying that same sentence
 *   and the box's colour, and the cards inside it leave the graph. Below the
 *   limit nothing changes at all, so the small estates in the suite render
 *   byte-identical with the flag on.
 *
 * The counts speak the estate's OWN vocabulary. choudoufu's words for the four
 * states are bound / unowned / pending / neutral, and the audit is explicit
 * that painting 84 derived-identity cards as "managed" on an unadopted estate
 * tells a reader a third of it is already theirs. So the words come from the
 * lexicon of the cards being counted, not from one table for everything.
 */
import type { GraphIR, IREdge, IRNode } from "@intentius/chant";
import { CHOUDOUFU_LEXICON } from "./choudoufu-member.ts";
import { TERRAFORM_LEXICON } from "./terraform-lens.ts";

/** Cards above which `?collapse=1` shuts a box. 40 is a screen of cards: below
 * it a box is already readable and collapsing it would hide an estate a person
 * can see whole. */
export const COLLAPSE_LIMIT = 40;

/** The id prefix a summary card carries. The SPA already addresses a BOX as
 * `box:<group id>` (web/app.js, `wrapContainmentBoxes`), so a card standing in
 * for a box is named the same way — and no real node id can collide, because
 * every id in a composed estate is `<member>/<address>`. */
export const SUMMARY_PREFIX = "box:";

/** The lexicon a summary card carries. It is behold's own card, not the
 * estate's, and saying so keeps it out of every lexicon-keyed join (the
 * choudoufu adopt lines, the terraform block filter) rather than nearly
 * matching one. */
export const SUMMARY_LEXICON = "behold";

/** The four `_status` values, in the words the estate uses for them. */
const WORDS: Record<string, Record<string, string>> = {
  // choudoufu's own vocabulary (choudoufu `live-ls`), which #393 asks the
  // legend and the counts to speak on a choudoufu member.
  [CHOUDOUFU_LEXICON]: { good: "bound", warn: "unowned", accent: "pending", neutral: "neutral" },
};
const DEFAULT_WORDS: Record<string, string> = { good: "managed", warn: "foreign", accent: "pending", neutral: "unobserved" };

/** The order counts are read in — what is mine, what is not, what is coming,
 * what was never looked at. */
const STATUS_ORDER = ["good", "warn", "accent", "neutral"] as const;

const RESOURCE_LEXICONS = new Set<string>([CHOUDOUFU_LEXICON, TERRAFORM_LEXICON]);

/**
 * The sentence a box of these cards says about itself.
 *
 * `301 resources` on a source graph; `301 resources · all bound` when the
 * whole box reads one way; `301 resources · 84 bound · 85 unowned · 132
 * neutral` when it does not. A box whose cards carry no `_status` at all is a
 * declared graph and says only the count — inventing "unobserved" there would
 * be a claim about a live read nobody made.
 */
export function boxBadgeText(nodes: readonly Pick<IRNode, "lexicon" | "attrs">[]): string {
  const noun = nodes.length !== 1 ? "resources" : "resource";
  const head = `${nodes.length} ${nodes.every((n) => RESOURCE_LEXICONS.has(n.lexicon ?? "")) ? noun : nodes.length === 1 ? "card" : "cards"}`;
  const words = WORDS[nodes.find((n) => WORDS[n.lexicon ?? ""])?.lexicon ?? ""] ?? DEFAULT_WORDS;
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const s = n.attrs?._status;
    if (typeof s === "string") counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  if (counts.size === 0) return head;
  if (counts.size === 1) {
    const [only] = [...counts.keys()];
    return `${head} · all ${words[only] ?? only}`;
  }
  const parts = [...counts.entries()]
    .sort((a, b) => STATUS_ORDER.indexOf(a[0] as never) - STATUS_ORDER.indexOf(b[0] as never))
    .map(([s, k]) => `${k} ${words[s] ?? s}`);
  return [head, ...parts].join(" · ");
}

/** Badge text per box key, for `renderGraph`/`renderArchitecture`'s
 * `groupBadges`. Reads `groups.byStack` — the member/root boxes — and skips a
 * box whose members are not in the IR. */
export function boxBadges(ir: GraphIR): Record<string, string> {
  const byId = new Map(ir.nodes.map((n) => [n.id, n] as const));
  const out: Record<string, string> = {};
  for (const [key, ids] of Object.entries((ir.groups.byStack ?? {}) as Record<string, string[]>)) {
    const nodes = ids.flatMap((id) => byId.get(id) ?? []);
    if (nodes.length) out[key] = boxBadgeText(nodes);
  }
  return out;
}

/** The colour a shut box paints in: the one its cards agree on, `warn` when
 * any card is foreign to the estate (the fact a summary must not swallow), and
 * neutral otherwise. */
export function summaryStatus(nodes: readonly Pick<IRNode, "attrs">[]): string | undefined {
  const seen = new Set(nodes.map((n) => (typeof n.attrs?._status === "string" ? n.attrs._status : undefined)));
  if (seen.size === 1) return [...seen][0];
  if (seen.has("warn")) return "warn";
  return undefined;
}

export interface CollapseResult {
  ir: GraphIR;
  /** The box keys that were shut, in the order they appear in `byStack`. */
  collapsed: string[];
}

/**
 * Shut every `byStack` box holding more than `limit` cards.
 *
 * The cards leave the graph and one summary card takes their place, keeping
 * the box's key in its id and the box's own sentence on its face. An edge that
 * touched a collapsed card re-points at the summary — so a cross-member
 * reference still draws, from the member as a whole — and an edge that ends up
 * with both feet in the same summary is dropped rather than drawn as a loop.
 *
 * Pure: `ir` is not mutated, and an estate with no box over the limit gets an
 * object equal to the one it passed in.
 */
export function collapseBoxes(ir: GraphIR, opts: { limit?: number } = {}): CollapseResult {
  const limit = opts.limit ?? COLLAPSE_LIMIT;
  const byStack = (ir.groups.byStack ?? {}) as Record<string, string[]>;
  const byId = new Map(ir.nodes.map((n) => [n.id, n] as const));
  const shut = Object.entries(byStack).filter(([, ids]) => ids.filter((id) => byId.has(id)).length > limit);
  if (shut.length === 0) return { ir, collapsed: [] };

  const standsFor = new Map<string, string>(); // card id → summary id
  const summaries: IRNode[] = [];
  const groups = { ...byStack };
  for (const [key, ids] of shut) {
    const nodes = ids.flatMap((id) => byId.get(id) ?? []);
    const id = `${SUMMARY_PREFIX}${key}`;
    for (const n of nodes) standsFor.set(n.id, id);
    const status = summaryStatus(nodes);
    summaries.push({
      id,
      kind: "member",
      lexicon: SUMMARY_LEXICON,
      attrs: {
        box: key,
        summary: boxBadgeText(nodes),
        cards: nodes.length,
        _collapsed: true,
        ...(status ? { _status: status } : {}),
      },
    });
    delete groups[key];
  }

  const nodes = ir.nodes.filter((n) => !standsFor.has(n.id));
  const seen = new Set<string>();
  const edges: IREdge[] = [];
  for (const e of ir.edges) {
    const from = standsFor.get(e.from) ?? e.from;
    const to = standsFor.get(e.to) ?? e.to;
    if (from === to) continue;
    const key = `${from}|${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(from === e.from && to === e.to ? e : { ...e, from, to });
  }
  return {
    ir: { ...ir, nodes: [...nodes, ...summaries], edges, groups: { ...ir.groups, byStack: groups } },
    collapsed: shut.map(([key]) => key),
  };
}

/** The note a collapsed view carries, so a person is never looking at a card
 * that stands for 301 without being told. Undefined when nothing was shut. */
export function collapseNote(collapsed: readonly string[], limit = COLLAPSE_LIMIT): string | undefined {
  if (collapsed.length === 0) return undefined;
  const which = collapsed.length === 1 ? collapsed[0] : `${collapsed.length} boxes`;
  return `collapsed: ${which} drawn as one card — boxes over ${limit} cards are shut (⌘K → Expand all)`;
}

/** The one field a summary card shows: what the box it stands for holds.
 * Registered as `behold`'s presentation pack in src/render.ts — without it the
 * default template would pick `box` and `cards` alphabetically and spend both
 * rows repeating the title. */
export function summaryCardFields(node: { attrs: Record<string, unknown> }): Array<{ label: string; value: string }> | undefined {
  const summary = node.attrs.summary;
  return typeof summary === "string" ? [{ label: "contains", value: summary }] : undefined;
}
