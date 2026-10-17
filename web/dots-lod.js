// Level of detail for the dots layer (#712, #715): each mark picks its form from
// how many pixels it covers at the current zoom, and the morph between two
// forms follows the zoom position, never a clock. Stopping halfway stays
// halfway; zooming back in runs it backwards. Pure.

/** Starting points, in CSS pixels on screen. */
export const LOD = {
  /** A card at least this wide stays a card. */
  cardPx: 90,
  /** A card narrower than this is a dot. */
  dotPx: 24,
  /** An estate box at least this wide (its larger side) is still all dots. */
  discFromPx: 72,
  /** An estate box smaller than this is one disc. */
  discPx: 48,
};

/** 0 at or above `hi`, 1 at or below `lo`, linear in log(px) between. */
export function bandT(px, hi, lo) {
  if (!(px > 0)) return 1;
  if (px >= hi) return 0;
  if (px <= lo) return 1;
  return Math.log(hi / px) / Math.log(hi / lo);
}

/** Smoothstep, so a morph starts and ends at rest. */
export function smooth(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/**
 * Card to dot: 0 is a card, 1 a dot. Under reduced motion it switches at the
 * geometric middle of the band, with no in-between.
 */
export function cardMorph(cardPx, { reduced = false, lod = LOD } = {}) {
  if (reduced) return cardPx < Math.sqrt(lod.cardPx * lod.dotPx) ? 1 : 0;
  return smooth(bandT(cardPx, lod.cardPx, lod.dotPx));
}

/** Dots to disc for one estate box: 0 is dots, 1 a disc. Reduced motion switches at `discPx`. */
export function discMorph(boxPx, { reduced = false, lod = LOD } = {}) {
  if (reduced) return boxPx < lod.discPx ? 1 : 0;
  return smooth(bandT(boxPx, lod.discFromPx, lod.discPx));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** A dot between its card's centre, its slot and its estate's disc. */
export function morphPoint(card, slot, disc, tCard, tDisc) {
  const from = card ?? slot;
  const x = lerp(from.x, slot.x, tCard);
  const y = lerp(from.y, slot.y, tCard);
  return { x: lerp(x, disc.x, tDisc), y: lerp(y, disc.y, tDisc) };
}

/**
 * A disc's radius in the same units as `pitch`: its area is the area its
 * resources cover as dots, so area stays proportional to the count.
 */
export function discRadius(count, pitch) {
  return Math.sqrt(Math.max(0, count) / Math.PI) * pitch * 1.8;
}

/** What the marks on screen are, from the card morph and every box's disc morph. */
export function levelOf(tCard, tDiscs) {
  const ds = [...tDiscs];
  const allDisc = ds.length > 0 && ds.every((t) => t >= 1);
  const anyDisc = ds.some((t) => t > 0);
  if (tCard <= 0) return "cards";
  if (tCard < 1) return "cards-dots";
  if (allDisc) return "discs";
  if (anyDisc) return "dots-discs";
  return "dots";
}

/** The line naming the marks at a level. */
export function caption(level) {
  switch (level) {
    case "cards":
      return "each card is a resource";
    case "cards-dots":
      return "cards shrinking to dots: each dot is a resource";
    case "dots":
      return "each dot is a resource, in its estate's box and colour";
    case "dots-discs":
      return "each dot is a resource; each disc is an estate, sized by resources";
    case "discs":
      return "each disc is an estate, sized by resources";
    default:
      return "";
  }
}

/**
 * The rail's three marks as viewBox widths, for a pane `paneW` x `paneH` px:
 * Cards puts a card at `cardAt` px; Resources fits the whole scene
 * (`sceneW` x `sceneH` viewBox units) while the smallest estate box is still
 * dots; Estates puts the typical box (default: the largest) under the disc threshold.
 */
export function railMarks({ paneW, paneH = paneW, cardW, sceneW, sceneH = 0, smallestBox, largestBox, typicalBox = largestBox, lod = LOD, cardAt = 140 }) {
  const cards = (paneW * cardW) / cardAt;
  let resources = Math.max(sceneW, (sceneH * paneW) / Math.max(1, paneH)) * 1.12;
  // Far enough that the cards have all but become dots, however few there are.
  resources = Math.max(resources, cards * 1.5, (paneW * cardW) / (lod.dotPx * 1.25));
  // Close enough that the smallest box stays dots: that wins over the cards, so
  // a small estate is still dots at this mark even when its cards are large.
  if (smallestBox > 0) resources = Math.min(resources, (smallestBox * paneW) / (lod.discFromPx * 1.1));
  resources = Math.max(resources, cards * 1.2);
  // The typical box just under the disc size: most estates are discs, and a far larger one may still be dots.
  const estates = Math.max((paneW * typicalBox) / (lod.discPx * 0.98), resources * 1.5);
  return { cards, resources, estates };
}

/** Where a viewBox width sits on the rail: 0 at Cards, 0.5 at Resources, 1 at Estates (log scale, clamped). */
export function railPos(vbW, marks) {
  const l = (v) => Math.log(Math.max(1e-9, v));
  if (vbW <= marks.resources) return Math.max(0, Math.min(0.5, (0.5 * (l(vbW) - l(marks.cards))) / (l(marks.resources) - l(marks.cards))));
  return Math.max(0.5, Math.min(1, 0.5 + (0.5 * (l(vbW) - l(marks.resources))) / (l(marks.estates) - l(marks.resources))));
}

/** How much past the legible card size the director may frame a small stage: enough to fill it, not so much that a card is a poster. */
export const CARDS_FRAME_GROW = 1.6;

/**
 * The director's zoom (screen px per viewBox unit) for a box it frames.
 * `fit`: the zoom that fits the box in the stage; `dotsCap`: the closest it
 * goes while dots must stay dots; `cardsAt`: the zoom at which each card is
 * wide enough to read its name (the rail's Cards mark), or null when the
 * layer draws no cards. A few resources fit the stage at that zoom: the
 * director frames them as cards, up to CARDS_FRAME_GROW past it. `small`: a
 * small stage (web/dots.js SMALL_STAGE), framed at the zoom that fits even
 * when its cards are still part way to dots, never at the dots cap, which
 * would leave it a third of the size that fits. A big estate keeps the dots
 * framing.
 */
export function directorScale({ fit, dotsCap, cardsAt = null, small = false, grow = CARDS_FRAME_GROW }) {
  if (cardsAt > 0 && (small || fit >= cardsAt)) return Math.min(fit, cardsAt * grow);
  return Math.min(fit, dotsCap);
}
