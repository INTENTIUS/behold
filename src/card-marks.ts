/**
 * The attribute keys and lexicons the painter (src/render.ts) reads off a card,
 * for the cards made by modules that also read disk or spawn processes
 * (src/logical.ts, src/component-releases.ts). Those modules re-export them;
 * they live here so src/render.ts imports no Node built-in and bundles for a
 * browser (#1069).
 */

/** The card lines the logical zoom adds (behold#873, #874), drawn by src/render.ts. */
export const CARD_WITH = "_with";
export const CARD_IN = "_in";

/** The lexicon of the card that stands for everyone outside the estate
 * (behold#876): its own, so its card reads in words rather than as a resource. */
export const OUTSIDE_LEXICON = "outside";

/** The lexicon of a member's run card in an estate's components picture (#997),
 * src/component-releases.ts. */
export const MEMBER_RUNS_LEXICON = "member-runs";
