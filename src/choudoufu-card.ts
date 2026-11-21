/**
 * A choudoufu card, as the painter draws it: the lexicon every node of a
 * choudoufu member carries, the rows its card shows, and the module instance an
 * address sits in. src/choudoufu-member.ts reads the member and re-exports
 * these; they live here, with no Node imports, so src/render.ts bundles for a
 * browser (#1069).
 */

import { engineOwnershipRows } from "./engine-ownership.ts";

const isRecord =(v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The lexicon every node this member emits carries — the presentation pack
 * (src/render.ts) and the inspect pane key on it. */
export const CHOUDOUFU_LEXICON = "choudoufu";

/** The rung all but a handful of instances sit on: a type whose ownership the
 * account can be asked about directly. It is the default answer, so a card
 * that says it says nothing; the two rare rungs are the interesting ones. */
export const COMMON_RUNG = "tag-governable";

/**
 * The rows a choudoufu card shows (pinhole presentation pack, registered in
 * src/render.ts): the producer for a data source, and for an instance whatever
 * the box it sits in does NOT already say (#393 item 9). Without a pack the
 * card would lead with the first two short attrs alphabetically — `estate`
 * then `rung` by accident today, `reason` the day a refusal appears.
 *
 * `ctx.boxEstate` is the estate the box this card is drawn in already stands
 * for — the one every card in it declares (src/card-face.ts works it out from
 * the boxes actually drawn). Absent — an unboxed render, a box holding two
 * estates, or any caller that reaches the pack directly — means nothing is
 * being repeated and every row is kept, which is what the card said before
 * this rule existed.
 */
export function choudoufuCardFields(
  node: { attrs: Record<string, unknown> },
  ctx: { boxEstate?: string } = {},
): Array<{ label: string; value: string }> | undefined {
  const a = node.attrs;
  const producer = a.producer as { estate?: unknown; address?: unknown } | undefined;
  if (isRecord(producer) && typeof producer.estate === "string") {
    return [{ label: "reads", value: typeof producer.address === "string" ? `${producer.estate} ${producer.address}` : producer.estate }];
  }
  // behold#1227: chant's ownership word, when a choudoufu live root's read put it on the node (chant#5333).
  const rows: Array<{ label: string; value: string }> = [...engineOwnershipRows(node)];
  // The live object at this address belongs to a DIFFERENT estate (#370's
  // `unowned[].tofu_estate`) — the one estate name on a card that is not the
  // box's, and the reason the card is yellow.
  if (typeof a.ownedBy === "string") rows.push({ label: "owned by", value: a.ownedBy });
  if (typeof a.rung === "string" && a.rung !== COMMON_RUNG) rows.push({ label: "rung", value: a.rung });
  if (typeof a.estate === "string" && a.estate !== ctx.boxEstate) rows.push({ label: "estate", value: a.estate });
  // Marked for this estate and declared nowhere: a warn card among bound ones
  // whose reason is otherwise only in the inspect pane.
  if (!rows.length && typeof a.marked === "string") rows.push({ label: "declared", value: "nowhere" });
  return rows.length ? rows : undefined;
}

/**
 * The module INSTANCE an address sits in, or undefined when it sits in the
 * root module (#393 B).
 *
 * `module.team_pod["pod-a"].aws_iam_role.pod_role[2]` →
 * `module.team_pod["pod-a"]`. The instance, not the module: a terralith calls
 * one module twice and the two copies are two boxes, which is the grouping a
 * person reads the estate by — the `["pod-a"]` is the whole point. A nested
 * call keeps only its OUTERMOST instance, so the estate groups by the thing
 * its own root declares rather than by a depth nobody chose.
 *
 * Deliberately not a grouping by TYPE: an estate of 248 identity resources
 * would draw as one box called `aws_iam_role` and say nothing a card does not.
 */
export function moduleInstanceOf(address: string): string | undefined {
  const m = /^module\.[A-Za-z0-9_-]+(\[[^\]]*\])?/.exec(address);
  return m ? m[0] : undefined;
}
