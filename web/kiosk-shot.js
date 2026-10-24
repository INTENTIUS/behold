// behold#571: the kiosk's Watch mode moves the framed graph like a camera.
// The kiosk says what a step is about (a `behold:shot`: some roots, some
// waves, or the whole graph, and how much of the pane its own overlays
// cover), and the frame pans and zooms its viewBox there. This module is the
// arithmetic, with no DOM: the frame (web/app.js) measures, this decides.

/** How long a shot's pan and zoom takes, in ms. */
export const SHOT_MS = 750;

/** The most a shot zooms in: one svg unit to this many pixels. */
export const SHOT_MAX_SCALE = 1.3;

/** behold#939: the most a prompt-driven step zooms in, so the graph fills the room above the pane. */
export const ASK_MAX_SCALE = 8;

/** Room kept round a shot's target, in svg units. */
export const SHOT_PAD = 36;

/**
 * A `behold:shot` message: what to frame, and the pane's covered edges in
 * pixels. `room`: the caption's tallest in the cycle, as a bottom inset in px
 * (web/kiosk-watch.js captionRoom), which only a held small stage keeps.
 */
export function shotMessage({ roots = [], waves = [], whole = false, insets = {}, ms = SHOT_MS, id = null, room = 0, ask = false } = {}) {
  const px = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  return {
    type: "behold:shot",
    id,
    roots: roots.filter((r) => typeof r === "string" && r),
    waves: waves.filter((w) => Number.isInteger(w)),
    whole: !!whole || (!roots.length && !waves.length),
    insets: { top: px(insets.top), right: px(insets.right), bottom: px(insets.bottom), left: px(insets.left) },
    ms: Number.isFinite(ms) && ms >= 0 ? ms : SHOT_MS,
    ...(px(room) ? { room: px(room) } : {}),
    // behold#939: a prompt-driven step's shot fills the room (the frame zooms in further, and drops its own caption line).
    ...(ask === true ? { ask: true } : {}),
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
  return shotMessage({ roots: list(d.roots), waves: list(d.waves), whole: d.whole, insets: d.insets && typeof d.insets === "object" ? d.insets : {}, ms: d.ms, id: d.id ?? null, room: d.room, ask: d.ask === true });
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

// --- one framing on a small stage --------------------------------------------
// When the whole graph fits the stage with its cards drawn readably (a card
// at least SMALL_STAGE_CARD_PX wide on screen, the width the dots layer's
// cards are fully drawn at: web/dots-lod.js LOD.cardPx), Watch holds one shot
// of the whole graph: every step's shot frames the whole
// graph, and the viewBox stays where it is from step to step and cycle to
// cycle while the graph and the pane stay, so a root no
// step is about stays in view and emphasis is by light and dim only. A bigger
// graph keeps the per-step framing.

/**
 * Whether a stage may be held at all: an estate whose every root runs on
 * choudoufu's live backend, by the reports (`binaries`, root to binary). The
 * scenarios on any other binary (b-waves, failure, tg-planned-outputs) keep
 * Watch as it always was: a shot per step, and their cards over the graph.
 */
export function holdsStage(binaries) {
  const b = binaries && typeof binaries === "object" ? Object.values(binaries) : [];
  return b.length > 0 && b.every((x) => x === "choudoufu");
}

/** The width in px a card needs on screen for the stage to count as small: dots-lod.js LOD.cardPx. */
export const SMALL_STAGE_CARD_PX = 90;

/**
 * Room kept under the whole graph beyond the caption first seen, in px: the
 * caption's extra rows (the cone line, the quiet line) and event-help's trail
 * over it, which grows by a line or two as the cycle's beats come in, all fit
 * in it, so none of them moves the frame.
 */
export const HOLD_RESERVE_PX = 24;

/** Room kept at the top for the run's caption over the boxes ("Showing the plan of …"), in px. */
export const HELD_CAPTION_PX = 32;

/**
 * The most a held stage zooms in, px per svg unit: as large as the stage area
 * (the pane less the caption and its reserve) allows, up to this.
 */
export const HELD_MAX_SCALE = 2.4;

/** A held framing at least this share of the width the graph needs is kept; a wider one frames again, to fill the stage. */
export const HELD_FILL = 0.9;

const boxInside = (a, b) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x2 <= b.x2 + 0.5 && a.y2 <= b.y2 + 0.5;

/**
 * What a held stage frames, from the boxes' rects and the cards' own rects
 * (svg units): the graph's boxes, each innermost box that holds a card (a box
 * round other boxes, a member's or the page's, is not what the graph spans),
 * and the cards inside them. A card in no box, a rect bigger than its card
 * (a hover ring) or anything else on the page counts only when no box holds a
 * card at all: then the cards are the graph. Null with no card.
 */
export function heldTarget(boxes, cards) {
  const cs = (cards || []).filter(Boolean);
  if (!cs.length) return null;
  const centre = (c) => ({ x: (c.x + c.x2) / 2, y: (c.y + c.y2) / 2 });
  const holds = (b, c) => { const m = centre(c); return m.x > b.x && m.x < b.x2 && m.y > b.y && m.y < b.y2; };
  const cand = (boxes || []).filter((b) => b && cs.some((c) => holds(b, c)));
  const inner = cand.filter((b) => !cand.some((o) => o !== b && boxInside(o, b) && !boxInside(b, o)));
  return inner.length ? unionBox(inner) : unionBox(cs);
}

/** How far the pane's size may differ, in px, and still be the same pane (a swapped-in frame's box can round otherwise). */
export const PANE_SLACK_PX = 2;

/**
 * The insets a held stage frames clear of, from a shot's: the run's caption's
 * room at the top, the caption under the stage, and the same margin at the
 * right as at the left. Nothing a step shows sits over the graph in Watch
 * (web/kiosk-watch.js watchOverlays), so no card's room is kept at the side,
 * and the graph has the stage's whole width; a drawer a viewer opens lies
 * over it until they fold it, and never moves the frame.
 */
export function heldInsets(insets = {}, room = 0) {
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  return { top: n(insets.top) + HELD_CAPTION_PX, right: n(insets.left), bottom: Math.max(n(insets.bottom), n(room)), left: n(insets.left) };
}

/**
 * Room kept round a held stage's graph, in svg units: none. The insets'
 * margins (20 px at the sides, the run's caption's room at the top) keep the
 * boxes off the edges, so the scale applied is min(openW / targetW, openH /
 * targetH), up to HELD_MAX_SCALE.
 */
export const HELD_PAD = 0;

/** How far, in svg units, the graph may lie past a held framing's open part and still be held: a few units, inside the margins. */
export const HELD_SLACK = 4;

/** The middle of a list of card widths, in svg units; 0 for none. */
export function medianWidth(widths) {
  const w = widths.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  return w.length ? w[w.length >> 1] : 0;
}

/**
 * Whether the stage is small: the whole graph (`whole`, svg units), framed on
 * `pane` clear of `insets`, draws a card `cardW` units wide at least `minPx` on screen.
 */
export function smallStage(whole, pane, insets, cardW, { minPx = SMALL_STAGE_CARD_PX } = {}) {
  if (!(cardW > 0)) return false;
  const vb = shotViewBox(whole, pane, insets, { pad: HELD_PAD, maxScale: HELD_MAX_SCALE });
  return !!vb && (cardW * pane.width) / vb[2] >= minPx;
}

/**
 * The held whole-graph framing: `held` from the last call (or null), `key`
 * naming the graph drawn (the repo and the view), the pane, the overlays'
 * insets now (heldInsets) and the whole graph's box. The viewBox stays put
 * from step to step and from cycle to cycle while the key and the pane's size
 * stay (to PANE_SLACK_PX), the overlays fit in the room it kept, and the graph
 * still lies in the open part of it (a badge, a label or a box a few units
 * off moves nothing). Otherwise it is framed again, round the graph as it was
 * and as it is, with room for the largest overlay seen so far, and
 * HOLD_RESERVE_PX more under the graph. `{ key, pane, insets, target, vb,
 * reason }`, `reason` saying why it was framed: "first", "key", "pane",
 * "insets", "target", or "held" when it was not.
 */
export function heldFrame(held, { key, pane, insets = {}, target }) {
  const i = { top: insets.top || 0, right: insets.right || 0, bottom: insets.bottom || 0, left: insets.left || 0 };
  const samePane = !!held && !!held.pane && Math.abs(held.pane.width - pane.width) <= PANE_SLACK_PX && Math.abs(held.pane.height - pane.height) <= PANE_SLACK_PX;
  const same = !!held && !!held.vb && held.key === key && samePane;
  const roomy = same && ["top", "right", "bottom", "left"].every((k) => i[k] <= held.insets[k]);
  if (roomy && target) {
    const [x, y, w, h] = held.vb;
    const s = held.pane.width / w;
    const open = { x: x + held.insets.left / s, y: y + held.insets.top / s, x2: x + w - held.insets.right / s, y2: y + h - held.insets.bottom / s };
    // A box a few units off (a frame drawn from another checkout) moves nothing: the side margins hold it.
    const inside = target.x >= open.x - HELD_SLACK && target.y >= open.y - HELD_SLACK && target.x2 <= open.x2 + HELD_SLACK && target.y2 <= open.y2 + HELD_SLACK;
    // And it still fills the stage: a framing much wider than the graph needs (the graph got smaller) frames again.
    const ideal = shotViewBox(target, held.pane, held.insets, { pad: HELD_PAD, maxScale: HELD_MAX_SCALE });
    const fills = !ideal || ideal[2] >= held.vb[2] * HELD_FILL;
    if (inside && fills) return held.reason === "held" ? held : { ...held, reason: "held" };
  }
  const reason = !held ? "first" : held.key !== key ? "key" : !samePane ? "pane" : !roomy ? "insets" : !target || !held.target || !boxInside(target, held.target) ? "target" : "fill";
  const keep = same ? held.insets : { top: 0, right: 0, bottom: 0, left: 0 };
  const room = {
    top: Math.max(keep.top, i.top),
    right: Math.max(keep.right, i.right),
    bottom: i.bottom > keep.bottom ? i.bottom + HOLD_RESERVE_PX : keep.bottom,
    left: Math.max(keep.left, i.left),
  };
  // Round the graph as it was and as it is, so a box a few units off never frames twice; a graph that shrank is framed as it is.
  const box = same && target && reason !== "fill" ? unionBox([held.target, target]) : target;
  return { key, pane: { width: pane.width, height: pane.height }, insets: room, target: box, vb: shotViewBox(box, pane, room, { pad: HELD_PAD, maxScale: HELD_MAX_SCALE }), reason };
}

/** How long after the last size change a refit waits, in ms: a drag or a Firefox resize burst refits once, at its end. */
export const REFIT_WAIT_MS = 120;

/**
 * `fn` run once, `wait` ms after the last call (trailing debounce). `.cancel()` drops a pending run. `timers` is for tests.
 * The refit it guards sets the view directly: it never changes the box the observers watch, so it cannot loop.
 */
export function debounced(fn, wait = REFIT_WAIT_MS, timers = { set: setTimeout, clear: clearTimeout }) {
  let t = null;
  const run = (...args) => {
    if (t !== null) timers.clear(t);
    t = timers.set(() => {
      t = null;
      fn(...args);
    }, wait);
  };
  run.cancel = () => {
    if (t !== null) timers.clear(t);
    t = null;
  };
  return run;
}

/** `fn` once, after `n` animation frames (two by default: layout and paint of what was just drawn have settled). */
export function afterFrames(raf, fn, n = 2) {
  const step = (left) => raf(() => (left > 1 ? step(left - 1) : fn()));
  step(n);
}
