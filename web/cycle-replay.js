// A recorded demo cycle, played condensed (behold#571, #711): the kiosk's
// replay of a cycle the loop driver recorded (`cycles/<tool>/<n>.json`,
// demo.cycle/v1) and, for a tour's cycle, the carve read of that cycle
// (`/api/terragucci/carve?cycle=<tool>&n=<n>`: its rosters, its migrations'
// progress lines and its tour's events).
//
// The whole replay runs on one clock, the condensed one: the kiosk's
// narration, step strip, trail and runs pane read the time it stands for
// (`real`), and the framed dots layer draws the tour, the cards and the moves
// at that same time. Replay time is recorded time one to one, except
//   - an idle stretch longer than `maxGapMs` plays as `keepMs`, and the
//     timeline marks it with the real gap ("+48 s skipped");
//   - a write's flight (`flightMs` after its line) and the first
//     `chapterMinMs` of each chapter are never cut;
//   - a chapter whose recorded stretch is still shorter than `chapterMinMs`
//     holds at its start until it has had that long;
//   - the end holds `endHoldMs` on the closing chapter, then it starts again.
// The values are the tour file's `replay` (behold.tour/v1), else REPLAY.
//
// Pure: the cycle and the carve answer in, the clock and plain data out.
// Nothing here reads the wall clock; the player is handed the time.

import { recordedClock } from "./dots-timeline.js";
import { firedBy } from "./tour-player.js";

/** The defaults, in ms, for a cycle whose tour sets no `replay` (or a cycle with no tour). */
export const REPLAY = { maxGapMs: 4_000, keepMs: 1_500, chapterMinMs: 6_000, endHoldMs: 8_000, flightMs: 1_800 };

/** A tour's replay settings over the defaults; a value that is not a number of ms is ignored. */
export function replaySettings(tour) {
  const r = tour && tour.replay && typeof tour.replay === "object" ? tour.replay : {};
  const out = { ...REPLAY };
  for (const k of Object.keys(REPLAY)) if (Number.isFinite(r[k]) && r[k] >= 0) out[k] = r[k];
  out.maxGapMs = Math.max(500, out.maxGapMs);
  out.keepMs = Math.min(out.keepMs, out.maxGapMs);
  return out;
}

const ms = (v) => (typeof v === "number" ? v : Date.parse(v || ""));

/** The cycle's steps, oldest first, each with its time in ms. */
export function cycleSteps(cycle) {
  return ((cycle && cycle.steps) || []).map((s) => ({ ...s, t: ms(s.at) })).filter((s) => Number.isFinite(s.t));
}

/** The tour's events: the answer's, which a recorded read gives for every step; else one beat event per step. */
export function cycleEvents(cycle, tour) {
  if (tour && Array.isArray(tour.events) && tour.events.length) return tour.events;
  return cycleSteps(cycle).map((s) => ({ kind: "beat", beat: s.beat ?? null, step: s.step, at: s.t }));
}

/**
 * Where each chapter starts in recorded time: the first time its trigger
 * fired. The current chapter is the last in the file's order that has fired
 * (web/tour-player.js chapterAt), so a chapter starts only once it is later
 * than the one before it. [{ index, id, title, at }], in time order.
 */
export function chapterStarts(tour, events) {
  const out = [];
  let last = -Infinity;
  ((tour && tour.chapters) || []).forEach((c, index) => {
    const e = firedBy(c.trigger, events);
    if (!e || !(e.at > last)) return;
    last = e.at;
    out.push({ index, id: c.id, title: c.title, at: e.at });
  });
  return out;
}

/** Every time the clock must keep: each step, each progress line and its flight, each wave job's edge. */
export function cycleTimes(cycle, answer, set = REPLAY) {
  const times = cycleSteps(cycle).map((s) => s.t);
  for (const m of (answer && answer.migrations) || []) {
    for (const l of m.lines || []) {
      const t = ms(l.at);
      if (Number.isFinite(t)) times.push(t, t + set.flightMs);
    }
  }
  // A wave's edge fires a visual (a pulse, a value travelling along its read threads): it plays whole too.
  for (const e of (answer && answer.tour && answer.tour.events) || []) if (Number.isFinite(e.at)) times.push(e.at, ...(e.kind === "wave" ? [e.at + set.flightMs] : []));
  return times;
}

/**
 * The condensed clock of a recorded cycle. `cycle`: demo.cycle/v1's
 * { started, ended, steps }; `answer`: the carve read of that cycle, or null.
 * Returns { clock, set, chapters, t0, t1, length, condensed, real }:
 * `clock` is web/dots-timeline.js recordedClock's (its breaks and holds);
 * `length` the whole loop in replay ms, the end's hold with it, and
 * `condensed` the cycle's own length before that hold; each chapter carries
 * its start `p` and its length `len` in replay ms.
 */
export function cycleClock(cycle, answer = null) {
  const tour = answer && answer.tour ? answer.tour : null;
  const set = replaySettings(tour);
  const steps = cycleSteps(cycle);
  const t0 = Number.isFinite(ms(cycle && cycle.started)) ? Math.min(ms(cycle.started), steps.length ? steps[0].t : Infinity) : steps.length ? steps[0].t : 0;
  const t1 = Math.max(t0 + 1, Number.isFinite(ms(cycle && cycle.ended)) ? ms(cycle.ended) : steps.length ? steps[steps.length - 1].t : t0 + 1);
  const times = cycleTimes(cycle, answer, set);
  const starts = tour ? chapterStarts(tour, cycleEvents(cycle, tour)).filter((c) => c.at >= t0 && c.at <= t1) : [];
  // Each chapter's first chapterMinMs is never cut: a point every half gap keeps the clock from skipping inside it.
  const step = Math.max(250, set.maxGapMs / 2);
  starts.forEach((c, i) => {
    const end = Math.min(c.at + set.chapterMinMs, i + 1 < starts.length ? starts[i + 1].at : t1);
    for (let t = c.at; t < end; t += step) times.push(t);
    times.push(end);
  });
  const opts = { maxGap: set.maxGapMs, keep: set.keepMs };
  const plain = recordedClock(times, t0, t1, opts);
  // A chapter still shorter than chapterMinMs holds at its start for the rest.
  const holds = [];
  starts.forEach((c, i) => {
    const next = i + 1 < starts.length ? starts[i + 1].at : t1;
    const len = plain.toReplay(next) - plain.toReplay(c.at);
    if (len < set.chapterMinMs) holds.push({ at: c.at, ms: set.chapterMinMs - len });
  });
  const condensedClock = recordedClock(times, t0, t1, { ...opts, holds });
  const condensed = condensedClock.length;
  // The end holds on the closing chapter, then the loop starts again.
  const clock = set.endHoldMs > 0 ? recordedClock(times, t0, t1, { ...opts, holds: [...holds, { at: t1, ms: set.endHoldMs }] }) : condensedClock;
  const chapters = starts.map((c, i) => {
    // A held chapter starts where its hold does.
    const p = clock.toReplay(c.at);
    const next = i + 1 < starts.length ? clock.toReplay(starts[i + 1].at) : condensed;
    return { ...c, p, len: next - p };
  });
  return {
    clock,
    set,
    chapters,
    t0,
    t1,
    length: clock.length,
    condensed,
    endHold: clock.length - condensed,
    /** The recorded time replay position `p` stands for, clamped to the cycle. */
    real: (p) => Math.max(t0, Math.min(t1, clock.toReal(Math.max(0, Math.min(clock.length, p))))),
    /** The replay position of a recorded time. */
    at: (real) => clock.toReplay(real),
  };
}

/** The step a recorded time is in: the last step written at or before it (the first before any). */
export function stepIndexAt(cycle, real) {
  const steps = cycleSteps(cycle);
  let at = 0;
  for (let i = 0; i < steps.length; i++) if (steps[i].t <= real) at = i;
  return at;
}

/**
 * The replay's playhead, on whatever clock the page hands it: the position
 * moves with the time handed in, times the speed, from the last seek. It
 * never reads a clock of its own, so a test (or a frame between the kiosk's
 * syncs) moves it exactly.
 */
export function createPlayhead(length, { at = 0, speed = 1, playing = true } = {}) {
  let p0 = 0;
  let w0 = at;
  let v = speed;
  let on = playing;
  const position = (w) => Math.max(0, p0 + (on ? (w - w0) * v : 0));
  return {
    position,
    get speed() {
      return v;
    },
    get playing() {
      return on;
    },
    get length() {
      return length;
    },
    seek(p, w) {
      p0 = Math.max(0, Math.min(length, p));
      w0 = w;
    },
    setSpeed(s, w) {
      p0 = position(w);
      w0 = w;
      v = s > 0 ? s : 1;
    },
    play(yes, w) {
      p0 = position(w);
      w0 = w;
      on = !!yes;
    },
    /** Past the end: back to the start, for the next loop. True when it wrapped. */
    wrap(w) {
      if (position(w) < length) return false;
      p0 = 0;
      w0 = w;
      return true;
    },
  };
}

/**
 * One tick of a replay at page time `w`: `replay` is { cycle, cc, player }
 * and `next` a newer latest cycle read meanwhile (or null). At the loop's end
 * the next cycle takes over, with the speed the viewer chose; before the end
 * it waits, so a new cycle never starts mid-replay. Returns { replay, next,
 * swapped, p, real, index }: the replay playing now, the one still waiting,
 * the playhead, the recorded time it stands for, and the step then.
 */
export function replayFrame(replay, next, w) {
  let r = replay;
  let n = next;
  let swapped = false;
  if (r.player.wrap(w) && n) {
    r = { ...n, player: createPlayhead(n.cc.length, { at: w, speed: r.player.speed }) };
    n = null;
    swapped = true;
  }
  const p = Math.min(r.cc.length, r.player.position(w));
  const real = r.cc.real(p);
  return { replay: r, next: n, swapped, p, real, index: stepIndexAt(r.cycle, real) };
}

/**
 * The timeline's marks for a recorded cycle: where each chapter starts, and
 * the first and last write of each migration, each with the record it stands
 * on. { p, real, kind, words, record }.
 */
export function cycleMarks(cc, cycle, answer = null) {
  const out = [];
  const n = cycle && cycle.cycle;
  for (const c of cc.chapters) out.push({ p: c.p, real: c.at, kind: "chapter", words: `chapter ${c.index + 1}: ${c.title}`, record: `cycle ${n}'s steps · ${new Date(c.at).toISOString()}` });
  for (const m of (answer && answer.migrations) || []) {
    const ts = (m.lines || []).map((l) => ms(l.at)).filter(Number.isFinite);
    if (!ts.length) continue;
    const a = Math.min(...ts);
    const b = Math.max(...ts);
    out.push({ p: cc.at(a), real: a, kind: "first", words: `${m.name}: first write`, record: `${m.progress || m.name} · ${new Date(a).toISOString()}` });
    if (b > a) out.push({ p: cc.at(b), real: b, kind: "last", words: `${m.name}: last write`, record: `${m.progress || m.name} · ${new Date(b).toISOString()}` });
  }
  return out.sort((x, y) => x.p - y.p);
}

/** The cycle's "Recorded …" source words: the demo cycle it is, as the record names it. */
export function cycleSource(cycle) {
  return cycle && Number.isInteger(cycle.cycle) ? `demo cycle ${cycle.cycle}` : null;
}
