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
