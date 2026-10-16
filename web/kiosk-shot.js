// behold#571: the kiosk's Watch mode moves the framed graph like a camera.
// The kiosk says what a step is about (a `behold:shot`: some roots, some
// waves, or the whole graph, and how much of the pane its own overlays
// cover), and the frame pans and zooms its viewBox there. This module is the
// arithmetic, with no DOM: the frame (web/app.js) measures, this decides.

/** How long a shot's pan and zoom takes, in ms. */
export const SHOT_MS = 750;

/** The most a shot zooms in: one svg unit to this many pixels. */
export const SHOT_MAX_SCALE = 1.3;

/** Room kept round a shot's target, in svg units. */
export const SHOT_PAD = 36;

/** A `behold:shot` message: what to frame, and the pane's covered edges in pixels. */
export function shotMessage({ roots = [], waves = [], whole = false, insets = {}, ms = SHOT_MS, id = null } = {}) {
  const px = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  return {
    type: "behold:shot",
    id,
    roots: roots.filter((r) => typeof r === "string" && r),
    waves: waves.filter((w) => Number.isInteger(w)),
    whole: !!whole || (!roots.length && !waves.length),
    insets: { top: px(insets.top), right: px(insets.right), bottom: px(insets.bottom), left: px(insets.left) },
    ms: Number.isFinite(ms) && ms >= 0 ? ms : SHOT_MS,
  };
}

/** A `behold:shot` from a message event, or null: only from the host's origin, only well formed. */
export function shotFromMessage(event, host) {
  if (!event || !host || event.origin !== host) return null;
  const d = event.data;
  if (!d || typeof d !== "object" || d.type !== "behold:shot") return null;
  // Inspect: no shot; the frame fits the graph as it always has.
  if (d.release === true) return { type: "behold:shot", release: true };
  const list = (v) => (Array.isArray(v) ? v : []);
  return shotMessage({ roots: list(d.roots), waves: list(d.waves), whole: d.whole, insets: d.insets && typeof d.insets === "object" ? d.insets : {}, ms: d.ms, id: d.id ?? null });
}

/** The smallest box round several `{x, y, x2, y2}`, or null for none. */
export function unionBox(boxes) {
  const ok = boxes.filter((b) => b && [b.x, b.y, b.x2, b.y2].every(Number.isFinite));
  if (!ok.length) return null;
  return { x: Math.min(...ok.map((b) => b.x)), y: Math.min(...ok.map((b) => b.y)), x2: Math.max(...ok.map((b) => b.x2)), y2: Math.max(...ok.map((b) => b.y2)) };
}

/**
 * The viewBox `[x, y, w, h]` that puts `target` (svg units) in the middle of
 * the pane's open part: the pane (`{width, height}` in pixels) less the
 * `insets` the kiosk's overlays cover. The box keeps the pane's aspect
 * ratio, so a pixel is the same number of units both ways. It zooms in no
 * further than `maxScale` pixels a unit.
 */
export function shotViewBox(target, pane, insets = {}, { pad = SHOT_PAD, maxScale = SHOT_MAX_SCALE } = {}) {
  if (!target || !pane || !(pane.width > 0 && pane.height > 0)) return null;
  const i = { top: insets.top || 0, right: insets.right || 0, bottom: insets.bottom || 0, left: insets.left || 0 };
  // An inset that leaves less than a third of the pane is dropped: the overlay then lies over the graph.
  if (pane.width - i.left - i.right < pane.width / 3) i.left = i.right = 0;
  if (pane.height - i.top - i.bottom < pane.height / 3) i.top = i.bottom = 0;
  const openW = pane.width - i.left - i.right;
  const openH = pane.height - i.top - i.bottom;
  const tw = Math.max(1, target.x2 - target.x + 2 * pad);
  const th = Math.max(1, target.y2 - target.y + 2 * pad);
  const s = Math.min(openW / tw, openH / th, maxScale);
  const w = pane.width / s;
  const h = pane.height / s;
  // The target's centre on the open part's centre.
  const cx = (target.x + target.x2) / 2;
  const cy = (target.y + target.y2) / 2;
  const ox = (i.left + openW / 2) / s;
  const oy = (i.top + openH / 2) / s;
  return [cx - ox, cy - oy, w, h];
}

/** Ease in and out, 0..1 to 0..1. */
export function ease(t) {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * The viewBox a fraction `t` of the way from `a` to `b`: the zoom moves on a
 * log scale and the centre with it, so a pull back and a push in read as
 * one calm move.
 */
export function tweenViewBox(a, b, t) {
  const k = ease(t);
  if (k <= 0) return a.slice();
  if (k >= 1) return b.slice();
  const w = Math.exp(Math.log(a[2]) + (Math.log(b[2]) - Math.log(a[2])) * k);
  const h = w * (b[3] / b[2]);
  const ca = [a[0] + a[2] / 2, a[1] + a[3] / 2];
  const cb = [b[0] + b[2] / 2, b[1] + b[3] / 2];
  const cx = ca[0] + (cb[0] - ca[0]) * k;
  const cy = ca[1] + (cb[1] - ca[1]) * k;
  return [cx - w / 2, cy - h / 2, w, h];
}

/** Whether two viewBoxes are the same to within half a unit. */
export function sameViewBox(a, b) {
  return !!a && !!b && a.length === 4 && b.length === 4 && a.every((v, i) => Math.abs(v - b[i]) < 0.5);
}
