/**
 * The words the legend, the statusbar and the Model tab put on the four
 * overlay colours (#393 item 8).
 *
 * behold paints one palette — `good | warn | accent | neutral` — and until now
 * spoke one vocabulary over it: managed / foreign / pending / unobserved,
 * chant's words for a chant estate. On an estate whose members are choudoufu
 * those words are wrong in a way that matters: choudoufu's `bound` is not
 * "managed" (a resource bound BY DERIVED IDENTITY carries no marker yet, and
 * "managed" claims it does), and its `unowned` is the adoption case, not a
 * foreign one. The unadopted terralith reads 84 cards as "managed" before any
 * adoption has happened — a third of the estate claimed as already yours.
 *
 * So the labels are derived from what the estate's members ARE. The colours do
 * not move: this is naming, not a second classification.
 *
 * The neutral bucket's word is the one choice here that is not simply
 * choudoufu's own. choudoufu has no single word for it: behold paints neutral
 * for live-ls's `gaps[]` (the listing cannot see it), for the live-plan
 * omission reasons that mean "could not answer" (FAILED, CYCLE,
 * NEEDS_DISCOVERY, …) and for an address neither document mentions at all.
 * `omitted` — choudoufu's own noun for an `omissions[]` entry — is the near
 * miss, and it is a miss: `ABSENT` is an omission too, and behold paints that
 * one `accent`/pending. So the bucket keeps a plain phrase, "not observed",
 * which is what every member of it has in common and what the inspect pane's
 * `_unobserved` row already says.
 */

/** The four colours a card can wear, plus chant's fifth runtime bucket. */
export type StatusKey = "good" | "warn" | "accent" | "neutral" | "runtime";

export type StatusLabels = Record<StatusKey, string>;

/** chant's words — the default, and what a mixed estate keeps. */
export const CHANT_STATUS_LABELS: StatusLabels = {
  good: "managed",
  warn: "foreign",
  accent: "pending",
  neutral: "unobserved",
  runtime: "runtime child",
};

/** choudoufu's words: `bound[]`, `unowned[]`, an absent instance the plan
 * would create, and everything the tool did not answer for. */
export const CHOUDOUFU_STATUS_LABELS: StatusLabels = {
  good: "bound",
  warn: "unowned",
  accent: "pending",
  neutral: "not observed",
  runtime: "runtime child",
};

/** What the SPA renders the legend, the counts and the inspect status row
 * from. `note` is the legend's tooltip — present only when the choice needs
 * explaining, which is exactly the mixed estate. */
export interface StatusVocabulary {
  /** Whose words these are: a member kind, or `mixed`. */
  of: string;
  labels: StatusLabels;
  note?: string;
}

const CHANT: StatusVocabulary = { of: "chant", labels: CHANT_STATUS_LABELS };

/**
 * The vocabulary for an estate of these member kinds.
 *
 * One kind, and behold knows its words: those words. Anything else — several
 * kinds, or a kind with no vocabulary of its own — keeps chant's, because two
 * vocabularies on one legend would put two meanings on one colour, and the
 * legend says so in its tooltip rather than leaving the reader to notice.
 */
export function statusVocabulary(kinds: readonly string[]): StatusVocabulary {
  const distinct = [...new Set(kinds)];
  if (distinct.length === 1 && distinct[0] === "choudoufu") return { of: "choudoufu", labels: CHOUDOUFU_STATUS_LABELS };
  if (distinct.length > 1 && distinct.includes("choudoufu")) {
    return {
      of: "mixed",
      labels: CHANT_STATUS_LABELS,
      note: `This estate mixes ${distinct.join(" and ")} members, so the legend keeps chant's words — bound reads as managed and unowned as foreign on the choudoufu members.`,
    };
  }
  return CHANT;
}
