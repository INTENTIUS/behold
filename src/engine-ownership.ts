/**
 * The ownership row a card shows, from chant's `facts.ownership` (behold#1227).
 *
 * An ownership engine's read puts its verdict on the node: a plunge member's
 * checked-in `engine-graph.json` on each resource it lists, and a choudoufu
 * live root's `chant graph --live --overlay` on each declared block
 * (INTENTIUS/chant#5333, `ENGINE_OWNERSHIP_FLOOR`). The word is chant's,
 * `bound`, `pending`, `unowned` or `foreign`, and the card prints it as it is.
 * A node with no facts gets no row: nothing was read, so nothing is said.
 *
 * No Node imports: src/render.ts bundles this for a browser.
 */

/** The four words chant's graph enum gives `facts.ownership`. */
export const ENGINE_OWNERSHIP_WORDS = ["bound", "pending", "unowned", "foreign"] as const;

/** chant's ownership word for a node, or undefined when no engine said one. */
export function engineOwnershipOf(node: unknown): string | undefined {
  const facts = (node as { facts?: { ownership?: unknown } } | null | undefined)?.facts;
  const o = facts?.ownership;
  return typeof o === "string" && (ENGINE_OWNERSHIP_WORDS as readonly string[]).includes(o) ? o : undefined;
}

/** The card row for it: `ownership: bound`. Empty when the node carries no verdict. */
export function engineOwnershipRows(node: unknown): Array<{ label: string; value: string }> {
  const o = engineOwnershipOf(node);
  return o ? [{ label: "ownership", value: o }] : [];
}
