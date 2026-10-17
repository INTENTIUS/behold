// The dots layer's scene (#712, #715): where every dot and every estate box is at
// any moment of a replay, and the choreography of the carve.
//
// Each estate has its own box at the dot level. A dot's slot is its unit's
// place inside its estate's box (web/dots-layout.js), so a carved dot leaves
// the terralith's box and lands in its estate's. The boxes have stable slots:
// the source estate keeps the place its cards had on the page, and the new
// estates sit in a grid beside it in name order, each cell sized for what the
// estate holds at the end of the recording. A reset or a replay lays out the
// same way.
//
// The choreography: the recording's moves are flown by unit, the order #457
// recommends ("the recorder should take a move order, and by unit should be
// its default"), so one team's cluster lifts off together as a flock. What
// moves, where to, and whether it landed are the recording's; the order and
// the timing are the replay's. Pure: show in, plain data out. Units are in
// pitches (one dot spacing); the page scales them into the viewBox.

import { unitsOf, unitOf, packBlock, blockWidth, shelfPack } from "./dots-layout.js";

export const CHOREO = { duration: 90_000, flight: 1_300, stagger: 28, lead: 2_500, tail: 3_000 };
export const BOX = { pad: 1.5, title: 3, gap: 5 };

/** A show's own time -> replay ms, linear over [t0, t1]. */
export function replayClock(show, duration = CHOREO.duration) {
  // #715: a live carve's clock is the show's own, one to one; its length grows as the page runs.
  if (show.kind === "live") return { length: Math.max(1, show.t1 - show.t0), at: (t) => t - show.t0, live: true };
  const span = Math.max(1, show.t1 - show.t0);
  return { length: duration, at: (t) => ((t - show.t0) / span) * duration };
}

/**
 * The flights: one per landed or refused move, plus one per follower and per
 * untaggable child that moves with its parent. Sorted by start.
 * Each is { address, from, to, ok, refusal?, start, end, flock, parent? }.
 */
export function choreograph(show, opts = {}) {
  const o = { ...CHOREO, ...opts };
  const clock = replayClock(show, o.duration);
  const writes = show.events.filter((e) => e.kind === "write");
  if (!writes.length) return [];
  // The window the flights fill: the whole replay for a carve recording, the
  // split phase's stretch of it for the walkthrough.
  let a = o.lead;
  let b = o.duration - o.tail - o.flight;
  if (show.kind !== "carve") {
    a = clock.at(Math.min(...writes.map((e) => e.start)));
    b = Math.max(a + o.flight, clock.at(Math.max(...writes.map((e) => e.t))) - o.flight);
  }
  // Children that move with a parent but that no follower record names.
  const kidsOf = new Map();
  for (const [child, parent] of show.parents ?? []) {
    if (!kidsOf.has(parent)) kidsOf.set(parent, []);
    kidsOf.get(parent).push(child);
  }
  // #715: a live carve flies each write when it was seen, in the show's own
  // time (its clock is one to one), never regrouped: the order and the timing
  // are the job's.
  if (show.kind === "live") {
    const out = [];
    for (const w of writes) {
      const start = w.start - show.t0;
      const base = { from: w.from, to: w.to, ok: w.ok, flock: 0, start, end: start + o.flight, at: w.at ?? w.t };
      out.push({ ...base, address: w.address, ...(w.refusal ? { refusal: w.refusal } : {}), ...(w.refusalSummary ? { refusalSummary: w.refusalSummary } : {}) });
      const followers = new Set(w.followers ?? []);
      if (w.ok) for (const c of kidsOf.get(w.address) ?? []) followers.add(c);
      [...followers].forEach((f, m) => {
        const s = start + (m % 3) * 8;
        out.push({ ...base, start: s, end: s + o.flight, address: f, parent: w.address });
      });
    }
    // A resource may move twice (adopted into one estate, then split into another); the same write read twice flies once.
    const seen = new Set();
    return out.sort((x, y) => x.start - y.start).filter((f) => !seen.has(`${f.address}@${f.start}`) && seen.add(`${f.address}@${f.start}`));
  }
  const typeOf = new Map(show.roster.map((r) => [r.address, r.type]));
  const order = new Map(show.roster.map((r, i) => [r.address, i]));
  const unitKey = (addr) => unitOf(addr, typeOf.get(addr));
  const flocks = new Map();
  for (const w of writes) {
    const k = unitKey(w.address);
    if (!flocks.has(k)) flocks.set(k, []);
    flocks.get(k).push(w);
  }
  const keys = [...flocks.keys()].sort();
  // Children that move with a parent but that no follower record names.
  const kids = new Map();
  for (const [child, parent] of show.parents ?? []) {
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(child);
  }
  const flights = [];
  // Each unit lifts off as one flock: its dots a short stagger apart, the
  // flocks evenly spaced, so one team's cluster leaves together.
  const gap = (b - a) / Math.max(1, keys.length);
  keys.forEach((k, fi) => {
    const ws = flocks.get(k).sort((x, y) => (order.get(x.address) ?? 0) - (order.get(y.address) ?? 0));
    const t = a + gap * fi;
    ws.forEach((w, j) => {
      const start = t + j * o.stagger;
      // `at`: when the recording says the move happened, for a viewer who asks.
      const base = { from: w.from, to: w.to, ok: w.ok, flock: fi, start, end: start + o.flight, at: w.t };
      flights.push({ ...base, address: w.address, ...(w.refusal ? { refusal: w.refusal } : {}), ...(w.refusalSummary ? { refusalSummary: w.refusalSummary } : {}) });
      const followers = new Set(w.followers ?? []);
      if (w.ok) for (const c of kids.get(w.address) ?? []) followers.add(c);
      [...followers].forEach((f, m) => {
        const s = start + (m % 3) * 8;
        flights.push({ ...base, start: s, end: s + o.flight, address: f, parent: w.address });
      });
    });
  });
  // A resource flies once: a follower named by two moves goes with the first.
  const seen = new Set();
  const once = flights.sort((x, y) => x.start - y.start).filter((f) => !seen.has(f.address) && seen.add(f.address));
  return once;
}

/**
 * The scene: the flights, and the layout after every takeoff, in pitches.
 * `layoutAt(k)` is the layout once the first k landing flights have taken off
 * (a dot in flight already holds its slot in the box it is flying to).
 */
export function buildScene(show, opts = {}) {
  const o = { ...opts };
  const flights = choreograph(show, opts);
  const landing = flights.filter((f) => f.ok);
  landing.forEach((f, i) => (f.k = i + 1));
  const source = show.source;
  const rosterBy = new Map(show.roster.map((r) => [r.address, r]));
  const end = show.ownersEnd;
  const estates = [...new Set([source, ...show.estates, ...end.values()])];
  const membersOf = (owners, e) => show.roster.filter((r) => owners.get(r.address) === e);
  // Fixed widths: the source's from its first members, each estate's from its last.
  const width = new Map();
  const finalSize = new Map();
  for (const e of estates) {
    const first = e === source ? membersOf(show.owners0, e) : membersOf(end, e);
    if (!first.length && e !== source) continue;
    const us = unitsOf(first);
    // The source's box takes its cards' shape on the page, so a card's dot has a short way to go.
    width.set(e, blockWidth(us, e === source && o.sourceAspect ? o.sourceAspect : 1.3));
    const p = packBlock(us, { width: width.get(e), fromEnd: e === source });
    finalSize.set(e, { w: p.w + 2 * BOX.pad, h: p.h + 2 * BOX.pad + BOX.title });
  }
  const src = finalSize.get(source) ?? { w: 10, h: 10 };
  const dests = estates.filter((e) => e !== source && finalSize.has(e)).sort();
  const area = dests.reduce((s, e) => s + finalSize.get(e).w * finalSize.get(e).h, 0);
  const gridW = Math.max(Math.sqrt(area) * 1.25, ...dests.map((e) => finalSize.get(e).w));
  const cells = shelfPack(
    dests.map((e) => ({ key: e, ...finalSize.get(e) })),
    { width: gridW, gap: BOX.gap },
  );
  const destX = src.w + BOX.gap * 3;
  const origin = new Map([[source, { x: 0, y: 0 }]]);
  for (const e of dests) origin.set(e, { x: destX + cells.get(e).x, y: cells.get(e).y });
  let extentW = destX + gridW;
  let extentH = src.h;
  for (const e of dests) extentH = Math.max(extentH, cells.get(e).y + finalSize.get(e).h);
  if (!dests.length) extentW = src.w;

  const cache = new Map();
  const layoutAt = (k) => {
    const kk = Math.max(0, Math.min(k, landing.length));
    if (cache.has(kk)) return cache.get(kk);
    const owners = new Map(show.owners0);
    for (let i = 0; i < kk; i++) owners.set(landing[i].address, landing[i].to);
    const slots = new Map();
    const boxes = new Map();
    for (const e of estates) {
      if (!width.has(e)) continue;
      const ms = show.roster.filter((r) => owners.get(r.address) === e);
      if (!ms.length && e !== source) continue;
      const fromEnd = e === source;
      const p = packBlock(unitsOf(ms), { width: width.get(e), fromEnd });
      const o = origin.get(e);
      let bx;
      let by;
      if (fromEnd) {
        // Bottom edge fixed: the source loses its top rows as units leave.
        bx = o.x;
        by = o.y + src.h - (p.h + 2 * BOX.pad + BOX.title);
      } else {
        bx = o.x;
        by = o.y;
      }
      const ix = bx + BOX.pad;
      const iy = by + BOX.pad + BOX.title + (fromEnd ? p.h : 0);
      for (const [addr, s] of p.slots) slots.set(addr, { x: ix + s.x, y: iy + s.y, ...(s.parent ? { parent: s.parent } : {}) });
      // The source's box narrows to the dots it still holds once its last row is partial.
      let x0 = bx;
      let w = Math.max(p.w, ms.length ? 0 : 4) + 2 * BOX.pad;
      if (fromEnd && ms.length) {
        let lo = Infinity;
        for (const [, sl] of p.slots) lo = Math.min(lo, sl.x);
        const cellHalf = 1.5;
        const left = Math.max(0, Math.min(p.w, lo - cellHalf));
        x0 = bx + left;
        w = p.w - left + 2 * BOX.pad;
      }
      boxes.set(e, { x: x0, y: by, w, h: p.h + 2 * BOX.pad + BOX.title, members: ms.length });
    }
    const out = { k: kk, slots, boxes, owners };
    if (cache.size > 2000) cache.clear();
    cache.set(kk, out);
    return out;
  };
  return { show, flights, landing, estates, source, layoutAt, extent: { w: extentW, h: extentH }, sourceBox: src, finalSize, rosterBy };
}

/** How many landing flights have taken off by replay time `t` (binary search). */
export function takeoffsBy(scene, t) {
  const l = scene.landing;
  let lo = 0;
  let hi = l.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (l[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Each estate's resource count at `t`: a dot counts where it is until it lands. */
export function countsAt(scene, t) {
  const c = new Map();
  for (const [, e] of scene.show.owners0) c.set(e, (c.get(e) ?? 0) + 1);
  for (const f of scene.landing) {
    if (f.end > t) continue;
    c.set(f.from, (c.get(f.from) ?? 0) - 1);
    c.set(f.to, (c.get(f.to) ?? 0) + 1);
  }
  return c;
}

/** The first landing in each estate (when its box draws in). */
export function firstLandings(scene) {
  const out = new Map();
  for (const f of scene.landing) if (!out.has(f.to) || f.end < out.get(f.to)) out.set(f.to, f.end);
  return out;
}

/** Ease in and out. */
export function easeInOut(t) {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * A point on a flight at progress u in [0, 1]: a gentle arc from a to b,
 * bowed to the left of travel by `bow` of the distance. A refused flight goes
 * out `reach` of the way and comes back to a.
 */
export function flightPoint(a, b, u, { ok = true, bow = 0.18, reach = 0.32 } = {}) {
  const e = easeInOut(u);
  let p = e;
  let tx = b.x;
  let ty = b.y;
  if (!ok) {
    // Out and back: progress rises to `reach` at mid-flight and returns to 0.
    p = Math.sin(Math.PI * e) * reach;
  }
  const dx = tx - a.x;
  const dy = ty - a.y;
  const lift = (ok ? Math.sin(Math.PI * e) : Math.sin(Math.PI * e) * reach) * bow;
  return { x: a.x + dx * p - dy * lift, y: a.y + dy * p + dx * lift };
}
