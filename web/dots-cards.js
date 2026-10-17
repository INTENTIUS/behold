// The dots layer's resource cards from the roster: the card level where the
// page's SVG has no card for a resource. A live carve framed at the kiosk's
// Components zoom draws one SVG card per root, never one per resource, so the
// cards a dot grows into are drawn on the canvas instead, from the roster row
// alone: its address, its type and the estate that owns it now. Each card sits
// at its dot's slot in its estate's box, so the morph is the dot growing in
// place. Pure: rows and sizes in, plain data out.

import { parseAddress } from "./dots-layout.js";
import { lerp, smooth } from "./dots-lod.js";

/**
 * A roster card's size in dot pitches. A slot's neighbours are at least about
 * one pitch apart (web/dots-layout.js rings), and two cards this size only
 * meet when their slots are under 0.97 pitches apart.
 */
export const ROSTER_CARD = { w: 0.88, h: 0.42 };

/** The label's faces, in CSS px: the name over the type, growing with the card up to `max`; `pad` and `bar` (the estate's colour down the left) in px. */
export const CARD_TEXT = { name: 11.5, type: 10.5, max: 15, pad: 7, bar: 3 };

/** A roster card's width and height in the units `pitch` is in. */
export function rosterCardSize(pitch) {
  return { w: ROSTER_CARD.w * pitch, h: ROSTER_CARD.h * pitch };
}

/**
 * What a roster row's card says: the short address (the resource's name and
 * index, without its module path or type) and the type. A live dot's id may
 * carry behold's own `#2` suffix (two rows with one address); that is not the
 * roster's, so it is not shown.
 */
export function cardLabel(row) {
  const address = String((row && row.address) || "").replace(/#\d+$/, "");
  const a = parseAddress(address);
  const name = a.name ? `${a.name}${a.index}` : address;
  return { name, type: (row && row.type) || (a.name ? a.type : ""), address };
}

/**
 * `text` cut from the front until `measure(text)` fits `room`, with an
 * ellipsis where the cut is: the end of a name is the part that tells two
 * apart. Returns "" when not even the ellipsis and one character fit.
 */
export function fitFront(text, room, measure) {
  const s = String(text || "");
  if (!s || !(room > 0)) return "";
  if (measure(s) <= room) return s;
  let lo = 1;
  let hi = s.length - 1;
  let best = "";
  // The longest tail that fits, by halving: measure is the costly part.
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cand = `…${s.slice(s.length - mid)}`;
    if (measure(cand) <= room) {
      best = cand;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/**
 * The form a resource is drawn in, from `u`: 0 is its dot, 1 its card. The
 * dot's disc grows into the card's rounded rect about the same centre. Sizes
 * are in screen px.
 */
export function cardShape(cx, cy, u, { dotR, cardW, cardH }) {
  const k = Math.max(0, Math.min(1, u));
  const w = lerp(dotR * 2, Math.max(dotR * 2, cardW), k);
  const h = lerp(dotR * 2, Math.max(dotR * 2, cardH), k);
  const r = lerp(dotR, Math.min(6, h * 0.22), k);
  return { x: cx - w / 2, y: cy - h / 2, w, h, r };
}

/** How far a card's words have faded in at morph `u`: none until most of the way, so a growing dot never shows half-sized text. */
export function cardTextAlpha(u) {
  return smooth((u - 0.6) / 0.35);
}

/**
 * The card's text, laid out for a card `w` x `h` px: the name, then the type
 * in muted ink, each cut from the front to fit. The words never shrink below
 * their faces' sizes: a line the card has no room for is left out.
 * `measure(text, px, weight)` is the text's width.
 */
export function cardText(label, { w, h }, measure) {
  const t = CARD_TEXT;
  const fs = Math.max(t.name, Math.min(t.max, h * 0.27));
  const ft = Math.max(t.type, Math.min(t.max - 1, h * 0.24));
  const room = w - t.pad * 2 - t.bar;
  const lines = [];
  if (room < fs * 2 || h < fs * 1.3 + 2) return lines;
  const name = fitFront(label.name, room, (s) => measure(s, fs, 600));
  if (name) lines.push({ text: name, size: fs, weight: 600, ink: "fg" });
  if (h >= (fs + ft) * 1.25 + 6 && label.type) {
    const type = fitFront(label.type, room, (s) => measure(s, ft, 400));
    if (type) lines.push({ text: type, size: ft, weight: 400, ink: "muted" });
  }
  return lines;
}

/**
 * Which drawn mark a point is on: a card when the point is inside its rect
 * (with `slack` px round it), else the nearest dot within `within` px. `pw`
 * and `ph` are each mark's half width and height on screen, 0 for a dot.
 * Returns the index, or -1.
 */
export function pickMark(x, y, { px, py, pvis, pw, ph }, { within = 10, slack = 2 } = {}) {
  let best = -1;
  let bd = within * within;
  let inside = -1;
  let insideD = Infinity;
  for (let i = 0; i < px.length; i++) {
    if (!pvis[i]) continue;
    const dx = px[i] - x;
    const dy = py[i] - y;
    const d = dx * dx + dy * dy;
    if (pw && pw[i] > 0 && Math.abs(dx) <= pw[i] + slack && Math.abs(dy) <= ph[i] + slack) {
      // Two cards that meet: the one whose centre is nearer.
      if (d < insideD) {
        insideD = d;
        inside = i;
      }
      continue;
    }
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return inside >= 0 ? inside : best;
}

/**
 * The rail's Cards mark: how many cards can draw at the card level, and its
 * words. `own`: the canvas draws the roster's cards (the page's SVG has none
 * for these resources), so every resource has one. Else the cards are the
 * SVG's: the resources it has a card for (`seeded`), or, when it has a card
 * for none of them, the cards it draws of its own (`svgCards`, a live carve's
 * roots).
 */
export function cardsMark({ resources = 0, seeded = 0, svgCards = 0, own = false } = {}) {
  const count = own ? resources : seeded > 0 ? seeded : svgCards;
  const n = count.toLocaleString("en-US");
  return { count, words: count === 0 ? "no cards" : `${n} card${count === 1 ? "" : "s"}`, enabled: count > 0 };
}

/**
 * The card-level framing the rail's Cards mark flies to: a viewBox `w` wide
 * centred on a box (in the viewBox's units), the pane's aspect kept. The box
 * is the director's focus when it is one estate, else the source estate's.
 */
export function cardsFrame(box, w, aspect) {
  const h = w * aspect;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return [cx - w / 2, cy - h / 2, w, h];
}
