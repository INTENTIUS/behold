// behold#764: where a floating dialog goes, kept inside what can be seen.
// On the fan-out kiosks wave 3's cards sit at the very top of the graph, and
// a dialog put above (or levelled with) one of them, or one taller than the
// space left, ran off the top of its window. Every floating thing of the
// kiosk (the frame's card popover, the job box and its log drawer, the
// approval callout, the event-help tips, the tooltip) places itself with
// these: beside its anchor on the first side it fits, else on the side with
// the most room, never past the view's edges less a margin; taller than the
// view, it gets a max height and its body scrolls.
//
// Pure: rects in, a position out. All boxes are `{ left, top, width, height }`
// in one window's pixels; the view is the part of that window that shows (a
// frame's window, or the kiosk's graph above its caption).

/** The room kept between a dialog and the view's edge, in px. */
export const FLOAT_MARGIN = 8;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

/**
 * The smallest move `{ dx, dy }` that puts `rect` inside `view` less `margin`.
 * A rect bigger than the view keeps its top (or left) edge in: what a dialog
 * starts with is what is read first.
 */
export function shiftInto(rect, view, margin = FLOAT_MARGIN) {
  const x0 = view.left + margin;
  const y0 = view.top + margin;
  const x1 = view.left + view.width - margin;
  const y1 = view.top + view.height - margin;
  const left = clamp(rect.left, x0, x1 - rect.width);
  const top = clamp(rect.top, y0, y1 - rect.height);
  return { dx: left - rect.left, dy: top - rect.top };
}

/** Whether `rect` lies inside `view` less `margin` (half a pixel's slack for rounding). */
export function fitsIn(rect, view, margin = FLOAT_MARGIN) {
  return rect.left >= view.left + margin - 0.5 && rect.top >= view.top + margin - 0.5 && rect.left + rect.width <= view.left + view.width - margin + 0.5 && rect.top + rect.height <= view.top + view.height - margin + 0.5;
}

/**
 * Where a dialog of `size` (`{ width, height }`) goes beside `anchor` inside
 * `view`. `sides` is the order to try ("right", "left", "below", "above"):
 * the first side with room for the whole dialog wins. With none, the side
 * with the most room for it, as a share of its size. Along its side the
 * dialog starts level with the anchor's top (beside) or left (above, below),
 * slid as little as keeps it in the view. A dialog taller than the view
 * less its margins gets `maxHeight` (else null): the caller caps it there and
 * lets its body scroll. `arrow` is how far along the dialog's near edge the
 * anchor's middle is (its notch or leader points there), kept 12px off its
 * corners. Returns `{ left, top, side, maxHeight, arrow }`.
 */
export function placeFloat(anchor, size, view, { sides = ["right", "left", "below", "above"], gap = 12, margin = FLOAT_MARGIN } = {}) {
  const vx0 = view.left + margin;
  const vy0 = view.top + margin;
  const vx1 = view.left + view.width - margin;
  const vy1 = view.top + view.height - margin;
  const maxH = Math.max(0, vy1 - vy0);
  const maxW = Math.max(0, vx1 - vx0);
  const h = Math.min(size.height, maxH);
  const w = Math.min(size.width, maxW);
  const right = anchor.left + anchor.width;
  const bottom = anchor.top + anchor.height;
  const room = {
    right: vx1 - (right + gap),
    left: anchor.left - gap - vx0,
    below: vy1 - (bottom + gap),
    above: anchor.top - gap - vy0,
  };
  const need = (side) => (side === "right" || side === "left" ? w : h);
  const at = (side) => {
    if (side === "right") return { left: right + gap, top: clamp(anchor.top, vy0, vy1 - h) };
    if (side === "left") return { left: anchor.left - gap - w, top: clamp(anchor.top, vy0, vy1 - h) };
    if (side === "below") return { left: clamp(anchor.left, vx0, vx1 - w), top: bottom + gap };
    return { left: clamp(anchor.left, vx0, vx1 - w), top: anchor.top - gap - h };
  };
  let side = sides.find((s) => room[s] >= need(s));
  if (!side) side = [...sides].sort((a, b) => room[b] / need(b) - room[a] / need(a))[0];
  const p = at(side);
  const left = clamp(p.left, vx0, vx1 - w);
  const top = clamp(p.top, vy0, vy1 - h);
  const beside = side === "right" || side === "left";
  const mid = beside ? anchor.top + anchor.height / 2 - top : anchor.left + anchor.width / 2 - left;
  const arrow = Math.max(12, Math.min((beside ? h : w) - 12, mid));
  return { left, top, side, maxHeight: size.height > maxH ? maxH : null, arrow };
}
