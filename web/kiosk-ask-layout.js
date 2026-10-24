// behold#940: where ask mode puts the roots. The graph's own layout packs the
// roots in one row, which at 1920x1080 leaves the cards small. Here the roots
// are stacked, upstream on top, and each root's cards wrap into as many columns
// as make the whole stack fill the room best. Pure: sizes in, positions out.
// web/app.js applies the positions to the drawn graph (layout deltas), and
// web/kiosk-estate-scene.js draws a scene at them.

export const PAD = 18;
/** The room a root's title takes at the top of its box. */
export const TITLE = 36;
/** Between cards of a box. */
export const GAP = 18;
/** Between boxes: room for the state label under each. */
export const BOX_GAP = 56;

/**
 * Upstream first. `edges` are `{from, to}` (from is read by to); a root
 * nothing orders keeps its place. A cycle falls back to the given order.
 */
export function orderRoots(paths, edges = []) {
  const left = [...paths];
  const out = [];
  while (left.length) {
    const ready = left.find((p) => !edges.some((e) => e.to === p && e.from !== p && left.includes(e.from)));
    const next = ready === undefined ? left[0] : ready;
    out.push(next);
    left.splice(left.indexOf(next), 1);
  }
  return out;
}

/**
 * The stack's positions.
 *
 * `roots`: in order, each `{ id, cards: [{ id, w, h }] }`; a card's `h` counts what hangs under it (its slots).
 * `open`: the room the stack should fill, `{ width, height }` in any one unit (only the ratio is used).
 * Returns `{ cols, scale, width, height, boxes, cards }`: `boxes[id]` and `cards[id]` are `{ x, y, w, h }` with the
 * stack's top left at 0,0; `scale` is how much the stack grows to fill `open`.
 */
export function askLayout(roots, open) {
  const list = roots.filter((r) => r && r.cards && r.cards.length);
  if (!list.length) return { cols: 0, scale: 1, width: 0, height: 0, boxes: {}, cards: {} };
  const cw = Math.max(...list.flatMap((r) => r.cards.map((c) => c.w)));
  const most = Math.max(...list.map((r) => r.cards.length));
  const rowH = list.map((r) => Math.max(...r.cards.map((c) => c.h)));
  const room = open && open.width > 0 && open.height > 0 ? open : { width: 16, height: 9 };
  const shape = (cols) => {
    let width = 0;
    let height = 0;
    list.forEach((r, i) => {
      const used = Math.min(cols, r.cards.length);
      const rows = Math.ceil(r.cards.length / cols);
      const w = used * cw + (used - 1) * GAP + 2 * PAD;
      const h = TITLE + rows * rowH[i] + (rows - 1) * GAP + PAD;
      width = Math.max(width, w);
      height += h + (i ? BOX_GAP : 0);
    });
    return { width, height, scale: Math.min(room.width / width, room.height / height) };
  };
  let best = { cols: 1, ...shape(1) };
  for (let cols = 2; cols <= most; cols++) {
    const s = shape(cols);
    // A wider stack only when it is a clear gain: ties keep the narrower one.
    if (s.scale > best.scale * 1.02) best = { cols, ...s };
  }
  const boxes = {};
  const cards = {};
  let y = 0;
  list.forEach((r, i) => {
    const used = Math.min(best.cols, r.cards.length);
    const rows = Math.ceil(r.cards.length / best.cols);
    const w = used * cw + (used - 1) * GAP + 2 * PAD;
    const h = TITLE + rows * rowH[i] + (rows - 1) * GAP + PAD;
    // Each box is centred on the widest one, so a stack of unequal boxes does not hug the left edge.
    const x0 = Math.round((best.width - w) / 2);
    boxes[r.id] = { x: x0, y, w, h };
    r.cards.forEach((c, k) => {
      const col = k % best.cols;
      const row = Math.floor(k / best.cols);
      cards[c.id] = { x: x0 + PAD + col * (cw + GAP), y: y + TITLE + row * (rowH[i] + GAP), w: c.w, h: c.h };
    });
    y += h + BOX_GAP;
  });
  return { cols: best.cols, scale: best.scale, width: best.width, height: best.height, boxes, cards };
}
