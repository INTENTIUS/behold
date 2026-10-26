// behold#1008: how a composed run's member box says whether a preview was made of it.
//
// chant's composed run (src/chant-compose.ts composedView) gives each member a kind in `answer.chant.members`:
//   hole       nothing could be previewed (its change set lists holes); the box is dashed and tagged "no preview";
//   previewed  a preview that reads values known after apply; the box is tagged "previewed";
//   plain      a preview with every value known; no tag.
// The estate scene (web/kiosk-estate-scene.js) draws the marks and the kiosk's "How to read this" (web/kiosk.js
// readingRows) says what they mean, from the words here, so the two never drift apart.

/** The tag on a box of each marked kind. A plain member has none. */
export const KIND_TAGS = { hole: "no preview", previewed: "previewed" };

/** The legend's line for each marked kind, in the order the legend lists them. */
export const KIND_ROWS = [
  { mark: "hole", words: "Dashed box: a stack no preview could be made of." },
  { mark: "previewed", words: "Tag previewed: some values known after apply." },
];

/** The words in a hole's empty box. */
export const HOLE_WORDS = "nothing could be previewed";

/** Each member's kind by path, from a composed answer: `Map<path, { kind, reasons }>`. Empty when the answer has none. */
export function memberKinds(answer) {
  const out = new Map();
  const rows = answer && answer.chant && Array.isArray(answer.chant.members) ? answer.chant.members : [];
  for (const m of rows) {
    if (!m || typeof m.member !== "string" || (m.kind !== "hole" && m.kind !== "previewed" && m.kind !== "plain")) continue;
    out.set(m.member, { kind: m.kind, reasons: Array.isArray(m.reasons) ? m.reasons.filter((r) => typeof r === "string") : [] });
  }
  return out;
}
