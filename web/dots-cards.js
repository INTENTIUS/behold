// The dots layer's resource cards from the roster: the card level where the
// page's SVG has no card for a resource. A live carve framed at the kiosk's
// Components zoom draws one SVG card per root, never one per resource, so the
// cards a dot grows into are drawn on the canvas instead, from the roster row
// alone: its address, its type and the estate that owns it now.
//
// A dot's slot leaves about one pitch round it, far too little for a card that
// can hold a name. So at the card level each estate's resources move from
// their slots into a grid of cards that fills the estate's own box, in unit
// order: a dot grows into its card as it slides to its cell, and the boxes
// never move. One card size serves every estate and every moment of the show,
// so a card never changes size as the carve moves resources about. Pure: rows,
// layouts and sizes in, plain data out.

import { unitOf, parseAddress } from "./dots-layout.js";
import { BOX } from "./dots-scene.js";
import { LOD, lerp, smooth } from "./dots-lod.js";

/**
 * A grid cell is `aspect` cell heights wide; the card leaves `gap` cell
 * heights to its neighbours. `maxK` caps a cell's height in pitches, so a box
 * with few resources does not get giant cards.
 */
export const GRID = { aspect: 3.2, gap: 0.12, maxK: 3 };

/**
 * The label's faces, in CSS px: the name over the type, growing with the card
 * up to `max`; `pad` and `bar` (the estate's colour down the left) in px.
 * `need` is clamped to [minW, maxW]: the card width at which the card level
 * starts.
 */
export const CARD_TEXT = { name: 11.5, type: 10.5, max: 15, pad: 7, bar: 3, minW: 90, maxW: 230 };

/** The largest cell height (in the box's units) at which `n` cells `aspect` heights wide fit a W x H box in rows. */
export function bestFit(W, H, n, aspect = GRID.aspect) {
  if (!(n > 0) || !(W > 0) || !(H > 0)) return 0;
  let best = 0;
  for (let c = 1; c <= n; c++) {
    const k = Math.min(W / (c * aspect), H / Math.ceil(n / c));
    if (k > best) best = k;
  }
  return best;
}

/** A box's inner rect, where its resources go: inside its padding, under its title row. */
export function innerOf(b) {
  return { x: b.x + BOX.pad, y: b.y + BOX.pad + BOX.title, w: Math.max(0, b.w - 2 * BOX.pad), h: Math.max(0, b.h - 2 * BOX.pad - BOX.title) };
}

/** Each estate's resources in a layout, in unit order (web/dots-layout.js), so a unit's cards sit together. */
export function membersOf(layout, keyOf = (a) => a) {
  const by = new Map();
  for (const a of layout.slots.keys()) {
    const e = layout.owners.get(a);
    if (!layout.boxes.has(e)) continue;
    if (!by.has(e)) by.set(e, []);
    by.get(e).push(a);
  }
  for (const list of by.values()) list.sort((x, y) => {
    const kx = keyOf(x);
    const ky = keyOf(y);
    return kx < ky ? -1 : kx > ky ? 1 : x < y ? -1 : x > y ? 1 : 0;
  });
  return by;
}

/**
 * The one cell height (in pitches) every estate's cards fit at, across the
 * given layouts: the tightest box's best fit, capped at GRID.maxK.
 */
export function gridScale(layouts, keyOf, { aspect = GRID.aspect, maxK = GRID.maxK } = {}) {
  let k = maxK;
  for (const L of layouts) {
    for (const [e, list] of membersOf(L, keyOf)) {
      const r = innerOf(L.boxes.get(e));
      const f = bestFit(r.w, r.h, list.length, aspect);
      if (f > 0) k = Math.min(k, f);
    }
  }
  return k;
}

/** A card's size in pitches for cell height `k`. */
export function cardSize(k, { aspect = GRID.aspect, gap = GRID.gap } = {}) {
  return { w: k * (aspect - gap), h: k * (1 - gap) };
}

/**
 * Each resource's card centre in a layout, in pitches: its estate's
 * resources in rows of cells `aspect * k` wide and `k` high, centred in the
 * box's inner rect, in unit order.
 */
export function gridSlots(layout, k, keyOf, { aspect = GRID.aspect } = {}) {
  const out = new Map();
  if (!(k > 0)) return out;
  const cw = aspect * k;
  for (const [e, list] of membersOf(layout, keyOf)) {
    const r = innerOf(layout.boxes.get(e));
    const n = list.length;
    const cols = Math.max(1, Math.min(n, Math.floor(r.w / cw + 1e-9)));
    const rows = Math.ceil(n / cols);
    const x0 = r.x + (r.w - cols * cw) / 2;
    const y0 = r.y + Math.max(0, (r.h - rows * k) / 2);
    list.forEach((a, i) => out.set(a, { x: x0 + ((i % cols) + 0.5) * cw, y: y0 + (Math.floor(i / cols) + 0.5) * k }));
  }
  return out;
}

/** The unit-order key of a roster row, for {@link membersOf}. */
export function unitKeyOf(rosterBy) {
  return (a) => {
    const r = rosterBy.get(a);
    return unitOf(r ? r.address : a, r ? r.type : "");
  };
}

/**
 * The type as a card shows it: without its provider's prefix
 * (`aws_iam_role` is `iam_role`), since every card on the stage is the same
 * provider's. `terraform_data` and the like keep theirs, and a type that is
 * all prefix stays whole.
 */
export function shortType(type) {
  const t = String(type || "");
  const m = /^([a-z0-9]+)_(.+)$/.exec(t);
  if (!m || m[1] === "terraform") return t;
  return m[2];
}

/**
 * What a roster row's card says: the short address (the resource's name and
 * index, without its module path or type) and the type without its
 * provider's prefix. A live dot's id may carry behold's own `#2` suffix (two
 * rows with one address); that is not the roster's, so it is not shown.
 */
export function cardLabel(row) {
  const address = String((row && row.address) || "").replace(/#\d+$/, "");
  const parts = parseAddress(address);
  const name = parts.name ? `${parts.name}${parts.index}` : address;
  return { name, type: shortType((row && row.type) || (parts.name ? parts.type : "")), address };
}

/**
 * The card width, in CSS px, at which the card level starts: wide enough for
 * the longest name at the name's face and the longest type at the type's,
 * clamped to [minW, maxW]. A name still wider than that is cut from the front.
 * `measure(text, px, weight)` is the text's width.
 */
export function cardNeed(labels, measure) {
  const t = CARD_TEXT;
  let w = 0;
  for (const l of labels) {
    w = Math.max(w, measure(l.name, t.name, 600));
    if (l.type) w = Math.max(w, measure(l.type, t.type, 400));
  }
  return Math.max(t.minW, Math.min(t.maxW, Math.ceil(w + t.pad * 2 + t.bar + 2)));
}

/** The level of detail for roster cards: a card at `need` px, a dot at the same share of it a card's dot is. */
export function rosterLod(need) {
  return { ...LOD, cardPx: need, dotPx: (need * LOD.dotPx) / LOD.cardPx };
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
 * A type too wide for its line, on two lines broken after an underscore,
 * each fitting `room`; null when no break fits.
 */
export function wrapType(text, room, measure) {
  const s = String(text || "");
  let best = null;
  for (let i = s.indexOf("_"); i > 0; i = s.indexOf("_", i + 1)) {
    const a = s.slice(0, i + 1);
    const b = s.slice(i + 1);
    if (!b || measure(a) > room || measure(b) > room) continue;
    // The break nearest the middle.
    if (!best || Math.abs(a.length - b.length) < Math.abs(best[0].length - best[1].length)) best = [a, b];
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
 * The card's text, laid out for a card `w` x `h` px whose card level starts
 * at `need` px: the name, then the type in muted ink. The faces are their
 * sizes at `need` and grow with the card, so whatever fits at `need` fits at
 * every size past it. A type too wide goes onto two lines when the card is
 * tall enough, and is cut from the front when it is not; a name too wide is
 * cut from the front. The words never shrink below their faces: a line the
 * card has no room for is left out. `measure(text, px, weight)` is the
 * text's width.
 */
export function cardText(label, { w, h, need = w }, measure) {
  const t = CARD_TEXT;
  const grow = Math.max(1, w / Math.max(1, need));
  const fs = Math.min(t.max, t.name * grow);
  const ft = Math.min(t.max - 1, t.type * grow);
  const room = w - t.pad * 2 - t.bar;
  const lines = [];
  if (room < fs * 2 || h < fs * 1.3 + 2) return lines;
  const name = fitFront(label.name, room, (s) => measure(s, fs, 600));
  if (name) lines.push({ text: name, size: fs, weight: 600, ink: "fg" });
  const lineH = (n) => (fs + ft * n) * 1.25 + 6;
  if (label.type && h >= lineH(1)) {
    const m = (s) => measure(s, ft, 400);
    const two = m(label.type) > room && h >= lineH(2) ? wrapType(label.type, room, m) : null;
    if (two) for (const part of two) lines.push({ text: part, size: ft, weight: 400, ink: "muted" });
    else {
      const type = fitFront(label.type, room, m);
      if (type) lines.push({ text: type, size: ft, weight: 400, ink: "muted" });
    }
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
 * Which estate the Cards mark lands on: the director's estate when it holds
 * resources, else the source estate when it does, else the estate holding
 * the most. null when no estate holds any.
 */
export function cardsEstate(focusEstate, source, counts) {
  if (focusEstate && (counts.get(focusEstate) ?? 0) > 0) return focusEstate;
  if ((counts.get(source) ?? 0) > 0) return source;
  let best = null;
  for (const [e, n] of counts) if (n > 0 && (best === null || n > counts.get(best))) best = e;
  return best;
}

/** The card nearest the middle of a set of cards: where the Cards mark centres, so it always lands on one. */
export function middleCard(points) {
  if (!points.length) return null;
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= points.length;
  cy /= points.length;
  let best = points[0];
  let bd = Infinity;
  for (const p of points) {
    const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

/** A viewBox `w` wide centred on a point, at the pane's aspect (height / width). */
export function cardsFrame(at, w, aspect) {
  const h = w * aspect;
  return [at.x - w / 2, at.y - h / 2, w, h];
}

/**
 * How far in the zoom may go while the canvas draws the roster's cards: a
 * viewBox no narrower than the one where a card is `past` times the width at
 * which it is fully drawn. `paneW` px, `cardW` in viewBox units.
 */
export function minViewWidth(paneW, cardW, need, past = 1.8) {
  return (paneW * cardW) / (need * past);
}

/**
 * Where a tip goes beside a point: right of and below it, kept inside the
 * pane less the rail on its right (`rightInset`), and over the mark when the
 * pane's foot leaves no room under it.
 */
export function tipSpot(x, y, { tipW, tipH, paneW, paneH, rightInset = 0, gap = 12, below = 14, above = y }) {
  const left = Math.max(4, Math.min(x + gap, paneW - rightInset - tipW - 4));
  // No room under the mark: over it, from `above` (the mark's top edge).
  const top = y + below + tipH > paneH - 4 ? Math.max(4, above - 6 - tipH) : y + below;
  return { left, top };
}
