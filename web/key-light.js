/**
 * behold#1163: lighting the estate graph by graph key, with no terragucci
 * report behind it. web/kiosk-light.js lights a step's cards from the
 * terragucci roots it reads; this lights the cards an answer names.
 *
 * An answer names resources by their graph database key (src/graph-db). The
 * estate graph (GET /api/graph) draws a card per resource, or one stacked card
 * for several alike ones (`attrs._stackOf`). So a key, or a string cell of an
 * answer's rows, lights the card whose id it is, or the stacked card it is
 * folded into. A key the estate graph draws no card for (an indexed cloud
 * object, a cluster object) lights nothing here; the /graph pane's drawing
 * shows it. Nothing is guessed: an id that matches no card is left alone.
 *
 * scripts/ask-demo/narration.ts uses the same two functions when it records
 * a turn's `light`, so a recorded turn and a visitor's query light alike.
 * The pure half is tested in web/key-light.test.js; `applyKeyLight` is the
 * one part that touches the SVG, with the `data-kl` marks web/index.html
 * styles for the kiosk.
 */

/** Each id the estate graph can light, to the card that draws it: itself, or the stacked card it is folded into. */
export function cardIndex(nodes) {
  const card = new Map();
  for (const n of nodes || []) {
    if (!n || typeof n.id !== "string") continue;
    card.set(n.id, n.id);
    const stack = n.attrs && Array.isArray(n.attrs._stackOf) ? n.attrs._stackOf : [];
    for (const s of stack) if (s && typeof s.id === "string" && !card.has(s.id)) card.set(s.id, n.id);
  }
  return card;
}

/**
 * The cards to light for an answer: each of its keys, and each string cell of
 * its rows, that names a card or a resource folded into a stacked card, in the
 * order they come.
 */
export function lightKeys(answer, cards) {
  const out = [];
  const add = (v) => {
    if (typeof v !== "string") return;
    const c = cards.get(v);
    if (c && !out.includes(c)) out.push(c);
  };
  for (const k of (answer && answer.keys) || []) add(k);
  for (const r of (answer && answer.rows) || []) if (r && typeof r === "object") for (const v of Object.values(r)) add(v);
  return out;
}

/**
 * Each card's mark: `lit` for the ids in `lit`, `dim` for the rest. With
 * nothing to light, no card is marked (the graph shows as it is drawn), so an
 * answer the estate graph has no card for never dims the whole estate.
 */
export function cardMarks(cardIds, lit) {
  const on = new Set(lit || []);
  const marks = new Map();
  if (!on.size) return marks;
  for (const id of cardIds) marks.set(id, on.has(id) ? "lit" : "dim");
  return marks;
}

/** An edge's mark: `path` between two lit cards, `dim` otherwise; none when nothing is lit. */
export function edgeMark(marks, from, to) {
  if (!marks.size) return null;
  return marks.get(from) === "lit" && marks.get(to) === "lit" ? "path" : "dim";
}

/**
 * The box that frames `boxes` (`{x, y, width, height}`), with `pad` around,
 * kept inside `full` and no smaller than `min` on a side; `full` when there is
 * nothing to frame.
 */
export function frameBox(boxes, full, { pad = 60, min = 420 } = {}) {
  const real = (boxes || []).filter((b) => b && [b.x, b.y, b.width, b.height].every(Number.isFinite));
  if (!real.length) return { ...full };
  let x0 = Math.min(...real.map((b) => b.x)) - pad;
  let y0 = Math.min(...real.map((b) => b.y)) - pad;
  let x1 = Math.max(...real.map((b) => b.x + b.width)) + pad;
  let y1 = Math.max(...real.map((b) => b.y + b.height)) + pad;
  const grow = (lo, hi, want) => {
    const d = Math.max(0, want - (hi - lo)) / 2;
    return [lo - d, hi + d];
  };
  [x0, x1] = grow(x0, x1, Math.min(min, full.width));
  [y0, y1] = grow(y0, y1, Math.min(min, full.height));
  const clamp = (lo, hi, start, size) => {
    const w = Math.min(hi - lo, size);
    const s = Math.max(start, Math.min(lo, start + size - w));
    return [s, w];
  };
  const [x, width] = clamp(x0, x1, full.x, full.width);
  const [y, height] = clamp(y0, y1, full.y, full.height);
  return { x, y, width, height };
}

/** How large a share of the full graph a box is: the larger of its width's and its height's. */
export function viewShare(box, full) {
  return Math.max(box.width / full.width, box.height / full.height);
}

/**
 * behold#1175, behold#1190: the box to frame for the lit cards' `boxes`, in
 * `full`: every lit card, with `pad` around and no smaller than `min` on a
 * side (frameBox). An answer is about all of its cards, both ends of each
 * row, so the frame keeps them all in view even when that zooms in little or
 * not at all; the dimmed cards around them show which ones are lit. With no
 * box, `full`.
 */
export function zoomFrame(boxes, full, { pad = 60, min = 420 } = {}) {
  return frameBox(boxes, full, { pad, min });
}

/** The gap between two boxes: the larger of their horizontal and vertical gaps, 0 when they overlap. */
export function boxGap(a, b) {
  const gx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const gy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.max(gx, gy);
}

/** Reading order: top to bottom, then left to right. */
const readingOrder = (a, b) => a.y - b.y || a.x - b.x;

/** behold#1203: a lit card is easy to read when it is at least this tall on screen, in px. */
export const READABLE_CARD_PX = 40;

/** How many screen px a graph unit is when `box` is shown in a pane of `pane` px (`{ width, height }`), as the estate pane fits it. */
export const paneScale = (box, pane) => Math.min(pane.width / box.width, pane.height / box.height);

/**
 * behold#1203: the answer's cards on their own, drawn close together. `cards`
 * are `{ id, box }` in the estate graph; `edges` (`{ from, to }`) are the
 * estate graph's edges, of which only those between two of the cards are
 * kept. Nothing is added: no card, no edge the estate graph does not draw.
 *
 * The cards fall into groups that sit close together: two cards no more
 * than `near` apart ({@link boxGap}) are in one group, and so is anything
 * near either. Each group keeps its own arrangement, so
 * the edges inside it keep their paths, moved with it (`kept`). The groups
 * are set `gap` apart in reading order, in a row or a column, whichever shows
 * them larger in `pane`. An edge between two groups is drawn straight from
 * one card's side to the other's (`cross`, with its path `d`).
 *
 * Returns `{ shift, box, kept, cross, groups, scale }`: each card's move
 * (`Map id -> { dx, dy }`), the box that frames them with `pad`, the edges,
 * how many groups there were, and the px per unit the box shows at.
 */
export function focusLayout(cards, edges, { pane = { width: 1, height: 1 }, near = 320, gap = 80, pad = 40 } = {}) {
  const real = (cards || []).filter((c) => c && typeof c.id === "string" && c.box && [c.box.x, c.box.y, c.box.width, c.box.height].every(Number.isFinite));
  const ids = new Set(real.map((c) => c.id));
  // Groups by the same rule as boxClusters, keeping each card's id.
  const sorted = [...real].sort((a, b) => readingOrder(a.box, b.box));
  const group = sorted.map((_, i) => i);
  const root = (i) => (group[i] === i ? i : (group[i] = root(group[i])));
  for (let i = 0; i < sorted.length; i++)
    for (let j = i + 1; j < sorted.length; j++) if (boxGap(sorted[i].box, sorted[j].box) <= near) group[root(j)] = root(i);
  const byRoot = new Map();
  sorted.forEach((c, i) => {
    const r = root(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(c);
  });
  const groups = [...byRoot.values()].map((list) => {
    const x0 = Math.min(...list.map((c) => c.box.x));
    const y0 = Math.min(...list.map((c) => c.box.y));
    const x1 = Math.max(...list.map((c) => c.box.x + c.box.width));
    const y1 = Math.max(...list.map((c) => c.box.y + c.box.height));
    return { list, x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  });
  const arrange = (across) => {
    const w = across ? groups.reduce((t, g) => t + g.width, 0) + gap * Math.max(0, groups.length - 1) : Math.max(0, ...groups.map((g) => g.width));
    const h = across ? Math.max(0, ...groups.map((g) => g.height)) : groups.reduce((t, g) => t + g.height, 0) + gap * Math.max(0, groups.length - 1);
    const box = { x: -pad, y: -pad, width: w + 2 * pad, height: h + 2 * pad };
    let at = 0;
    const place = groups.map((g) => {
      // Each group centred across the other way, so a small one sits level with a large one.
      const to = across ? { x: at, y: (h - g.height) / 2 } : { x: (w - g.width) / 2, y: at };
      at += (across ? g.width : g.height) + gap;
      return { dx: to.x - g.x, dy: to.y - g.y };
    });
    return { box, place, scale: groups.length ? paneScale(box, pane) : 0 };
  };
  const row = arrange(true);
  const col = arrange(false);
  const best = col.scale > row.scale ? col : row;
  const shift = new Map();
  const groupOf = new Map();
  groups.forEach((g, i) => {
    for (const c of g.list) {
      shift.set(c.id, best.place[i]);
      groupOf.set(c.id, i);
    }
  });
  const boxOf = new Map(real.map((c) => [c.id, c.box]));
  const moved = (id) => {
    const b = boxOf.get(id);
    const d = shift.get(id);
    return { x: b.x + d.dx, y: b.y + d.dy, width: b.width, height: b.height };
  };
  const kept = [];
  const cross = [];
  const seen = new Set();
  for (const e of edges || []) {
    if (!e || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    if (groupOf.get(e.from) === groupOf.get(e.to)) {
      kept.push({ from: e.from, to: e.to, ...shift.get(e.from) });
      continue;
    }
    if (seen.has(`${e.from}\u0000${e.to}`)) continue;
    seen.add(`${e.from}\u0000${e.to}`);
    const [a, b] = [moved(e.from), moved(e.to)];
    const p = sidePoint(a, b);
    const q = sidePoint(b, a);
    cross.push({ from: e.from, to: e.to, d: `M ${round(p.x)} ${round(p.y)} L ${round(q.x)} ${round(q.y)}` });
  }
  return { shift, box: best.box, kept, cross, groups: groups.length, scale: best.scale };
}

const round = (n) => Math.round(n * 10) / 10;

/** Where the line from `a`'s centre to `b`'s centre leaves `a`'s box. */
function sidePoint(a, b) {
  const cx = a.x + a.width / 2;
  const cy = a.y + a.height / 2;
  const dx = b.x + b.width / 2 - cx;
  const dy = b.y + b.height / 2 - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const k = Math.min(dx ? a.width / 2 / Math.abs(dx) : Infinity, dy ? a.height / 2 / Math.abs(dy) : Infinity);
  return { x: cx + dx * k, y: cy + dy * k };
}

/**
 * behold#1203: `box` grown to the pane's shape so that, fitted to a pane of
 * `pane` px, it shows whole with `top` px clear above it and `bottom` px
 * below (where the pane's controls and caption sit), centred across.
 * Returns the box and the px per unit it shows at.
 */
export function reserveBox(box, pane, { top = 0, bottom = 0 } = {}) {
  const room = Math.max(1, pane.height - top - bottom);
  const scale = Math.min(pane.width / box.width, room / box.height);
  const width = pane.width / scale;
  const height = pane.height / scale;
  const x = box.x - (width - box.width) / 2;
  const y = box.y - top / scale - (room / scale - box.height) / 2;
  return { box: { x, y, width, height }, scale };
}

/**
 * behold#1203: whether an answer gets the focused view. Its `cards` are a
 * few of the `drawn` cards (fewer than half), framing every one of them in
 * `full` would leave the shortest under {@link READABLE_CARD_PX} in `pane`,
 * and the focused layout shows them at least half as large again.
 */
export function wantsFocus(cards, drawn, full, pane, layout) {
  const real = (cards || []).filter((c) => c && c.box);
  if (real.length < 2 || real.length * 2 > drawn || !layout || layout.groups < 2) return false;
  const all = frameBox(real.map((c) => c.box), full);
  const shortest = Math.min(...real.map((c) => c.box.height));
  const scale = paneScale(all, pane);
  return shortest * scale < READABLE_CARD_PX && layout.scale >= scale * 1.5;
}

/* c8 ignore start: the DOM half, driven by the page */
/** Take the marks off. */
export function clearKeyLight(svg) {
  if (!svg) return;
  for (const el of svg.querySelectorAll("[data-kl]")) el.removeAttribute("data-kl");
  for (const el of svg.querySelectorAll("[data-kl-pulse]")) el.removeAttribute("data-kl-pulse");
}

/** Mark the cards (`[data-node-id]`) and edges (`g[data-edge-from]`) of `svg` for `lit`; lit cards pulse once when `pulse`. Returns the lit card elements. */
export function applyKeyLight(svg, lit, { pulse = true } = {}) {
  clearKeyLight(svg);
  if (!svg) return [];
  const cards = [...svg.querySelectorAll("[data-node-id]")];
  const marks = cardMarks(
    cards.map((g) => g.getAttribute("data-node-id")),
    lit,
  );
  const on = [];
  for (const g of cards) {
    const m = marks.get(g.getAttribute("data-node-id"));
    if (!m) continue;
    g.setAttribute("data-kl", m);
    if (m === "lit") {
      on.push(g);
      if (pulse) g.setAttribute("data-kl-pulse", "1");
    }
  }
  for (const e of svg.querySelectorAll("g[data-edge-from]")) {
    const m = edgeMark(marks, e.getAttribute("data-edge-from"), e.getAttribute("data-edge-to"));
    if (m) e.setAttribute("data-kl", m);
  }
  return on;
}
/* c8 ignore stop */
