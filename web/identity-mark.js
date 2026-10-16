// The marker-vs-derived mark: how a card shows where its identity comes from.
//
// choudoufu keeps two facts apart, and so does the mark:
//
// - how the plan found the live object (`live-plan`'s `bound[].source`):
//   `marker` when the estate-wide tag sweep bound it, `derived` when the
//   configuration names it (an IAM role's name, a log group's name);
// - whether the object wears this estate's marker (`live-ls` lists it under
//   the estate's tag).
//
// A stamped log group is derived AND marked; an inline policy is derived and
// has no tags argument to carry a marker. A stock root has neither: its
// identity is the state file's.
//
// The glyph is a tag: filled when the object wears the marker, outlined when
// it does not, absent for a stock root. Pure data and functions; app.js and
// terralith.js draw.

/** Every mark, keyed. `label` is the card's word, `tip` its hover. */
export const IDENTITY_MARKS = {
  state: { label: "state file", glyph: "none", tip: "A stock root keeps this resource's identity in its state file." },
  marker: { label: "marker", glyph: "solid", tip: "The tag sweep found it by the marker on the resource (tofu-estate, tofu-address)." },
  "derived-marked": { label: "derived · marked", glyph: "solid", tip: "Its name in the code identifies it, and it wears the marker too." },
  derived: { label: "derived", glyph: "outline", tip: "Matched by name alone; it has no tags argument to carry a marker." },
  record: { label: "record", glyph: "outline", tip: "Its identity comes from the estate's record store." },
  cache: { label: "cache", glyph: "outline", tip: "Answered from the local state cache." },
  unbound: { label: "not bound yet", glyph: "outline", tip: "The plan has bound no live object to it yet." },
};

/** The mark's key for an identity `{source, marked}`, or null for none. */
export function identityKey(identity) {
  if (!identity || typeof identity !== "object") return null;
  const { source, marked } = identity;
  if (source === "state") return "state";
  if (source === "marker") return "marker";
  if (source === "derived") return marked ? "derived-marked" : "derived";
  if (source === "record" || source === "cache") return source;
  if (source === "unbound") return "unbound";
  return null;
}

/** The mark for an identity: `{key, label, glyph, tip}`, or null. */
export function identityMark(identity) {
  const key = identityKey(identity);
  return key ? { key, ...IDENTITY_MARKS[key] } : null;
}

/** The tag glyph as SVG markup at (x, y), `size` px tall, in `color`. */
export function tagGlyphSvg(glyph, x, y, size, color) {
  if (glyph === "none") return "";
  const s = size / 12;
  const p = (px, py) => `${(x + px * s).toFixed(2)},${(y + py * s).toFixed(2)}`;
  // A luggage tag: a pentagon pointing left, with its eyelet.
  const body = [p(0, 6), p(4, 1), p(12, 1), p(12, 11), p(4, 11)].join(" ");
  const fill = glyph === "solid" ? color : "none";
  const hole = glyph === "solid" ? "var(--bg, #000)" : color;
  return (
    `<polygon points="${body}" fill="${fill}" stroke="${color}" stroke-width="${(1.2 * s).toFixed(2)}" stroke-linejoin="round"/>` +
    `<circle cx="${(x + 4.6 * s).toFixed(2)}" cy="${(y + 6 * s).toFixed(2)}" r="${(1.2 * s).toFixed(2)}" fill="${hole}"/>`
  );
}
