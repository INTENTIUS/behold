// Points along an estate box's border, for the lights that run around it
// (#712): the draw-in head, the running light, the landing ripple and a
// failure's red segment. A box is {x, y, w, h}; a position on the border is
// its distance `s` clockwise from the top-left corner. Pure.

export function perimeter(b) {
  return 2 * (Math.max(0, b.w) + Math.max(0, b.h));
}

/** The point at distance s (wrapped) clockwise from the top-left corner. */
export function pointAt(b, s) {
  const P = perimeter(b);
  if (!(P > 0)) return { x: b.x, y: b.y };
  let d = ((s % P) + P) % P;
  if (d <= b.w) return { x: b.x + d, y: b.y };
  d -= b.w;
  if (d <= b.h) return { x: b.x + b.w, y: b.y + d };
  d -= b.h;
  if (d <= b.w) return { x: b.x + b.w - d, y: b.y + b.h };
  d -= b.w;
  return { x: b.x, y: b.y + b.h - d };
}

/** The distance along the border of the border point nearest p. */
export function nearestS(b, p) {
  const cx = Math.max(b.x, Math.min(b.x + b.w, p.x));
  const cy = Math.max(b.y, Math.min(b.y + b.h, p.y));
  const dl = Math.abs(cx - b.x);
  const dr = Math.abs(b.x + b.w - cx);
  const dt = Math.abs(cy - b.y);
  const db = Math.abs(b.y + b.h - cy);
  // Inside the box, project onto the nearest side; outside, the clamp is already on it.
  const inside = p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;
  const m = inside ? Math.min(dl, dr, dt, db) : -1;
  if ((inside && m === dt) || (!inside && cy === b.y)) return cx - b.x;
  if ((inside && m === dr) || (!inside && cx === b.x + b.w)) return b.w + (cy - b.y);
  if ((inside && m === db) || (!inside && cy === b.y + b.h)) return b.w + b.h + (b.x + b.w - cx);
  return 2 * b.w + b.h + (b.y + b.h - cy);
}

/**
 * A polyline along the border from s0 for `len` (negative runs anticlockwise),
 * with a vertex at every corner it passes, so it bends where the box does.
 */
export function segment(b, s0, len) {
  const P = perimeter(b);
  if (!(P > 0) || !len) return [];
  const L = Math.max(-P, Math.min(P, len));
  const corners = [0, b.w, b.w + b.h, 2 * b.w + b.h];
  const pts = [pointAt(b, s0)];
  const dir = Math.sign(L);
  const a = s0;
  const z = s0 + L;
  // Every corner strictly between a and z, in travel order.
  const between = [];
  for (let k = Math.floor(Math.min(a, z) / P) - 1; k <= Math.ceil(Math.max(a, z) / P) + 1; k++) {
    for (const c of corners) {
      const s = c + k * P;
      if ((dir > 0 && s > a && s < z) || (dir < 0 && s < a && s > z)) between.push(s);
    }
  }
  between.sort((p, q) => (dir > 0 ? p - q : q - p));
  for (const s of between) pts.push(pointAt(b, s));
  pts.push(pointAt(b, z));
  return pts;
}
