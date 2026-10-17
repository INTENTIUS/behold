// The timeline of a recorded replay: a recording of a real event stream,
// played on the recording's own clock. Pure: the recording's times in, the
// mapping between replay time and wall-clock time, the ticks, the marks and
// the label out.
//
// Replay time is wall-clock time, one to one, except across an idle stretch
// longer than `maxGap`: that stretch plays as `keep` ms, and the timeline
// draws a break there with the real gap's length ("+48 s skipped"). Nothing is
// compressed without a break to say so. The ticks are the recording's
// wall-clock times, and every mark is a line of the recording (its file and
// line, and its time).

export const GAPS = { maxGap: 10_000, keep: 2_000 };

/**
 * The replay's clock over a recording whose events happened at `times` (ms),
 * from `t0` to `t1`: { length, toReplay(real), toReal(p), breaks, t0, t1 }.
 * Each break is { p, real0, real1, skipped } in replay ms and wall-clock ms.
 */
export function recordedClock(times, t0, t1, { maxGap = GAPS.maxGap, keep = GAPS.keep } = {}) {
  const ts = [...new Set([t0, ...times.filter((x) => Number.isFinite(x) && x >= t0 && x <= t1), t1])].sort((a, b) => a - b);
  const segs = []; // { r0, r1, p0 }: wall-clock [r0, r1] plays from replay p0, one to one
  const breaks = [];
  let p = 0;
  let r0 = ts[0];
  for (let i = 1; i < ts.length; i++) {
    const a = ts[i - 1];
    const b = ts[i];
    if (b - a > maxGap) {
      // Play up to a, then the gap as `keep` ms, the first half before the break and the second after.
      segs.push({ r0, r1: a + keep / 2, p0: p });
      p += a + keep / 2 - r0;
      breaks.push({ p, real0: a + keep / 2, real1: b - keep / 2, skipped: b - a - keep });
      r0 = b - keep / 2;
    }
  }
  segs.push({ r0, r1: ts[ts.length - 1], p0: p });
  p += ts[ts.length - 1] - r0;
  const length = Math.max(1, p);
  const toReplay = (real) => {
    if (real <= segs[0].r0) return 0;
    for (const s of segs) {
      if (real <= s.r1) return real < s.r0 ? s.p0 : s.p0 + (real - s.r0);
    }
    return length;
  };
  const toReal = (q) => {
    let s = segs[0];
    for (const x of segs) if (x.p0 <= q) s = x;
    return Math.min(s.r1, s.r0 + Math.max(0, q - s.p0));
  };
  return { length, toReplay, toReal, breaks, segs, t0: ts[0], t1: ts[ts.length - 1] };
}

const pad = (n) => String(n).padStart(2, "0");
/** A wall-clock time as the timeline shows it, in UTC: "16:37" or, with seconds, "16:37:26". */
export function clockWords(ms, seconds = false) {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? `:${pad(d.getUTCSeconds())}` : ""}`;
}

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);

/** The wall-clock ticks: round times inside the played stretches, about `want` of them, each { p, real, label }. */
export function wallTicks(clock, want = 7) {
  const played = clock.segs.reduce((s, x) => s + (x.r1 - x.r0), 0);
  const step = STEPS.find((s) => played / s <= want) ?? STEPS[STEPS.length - 1];
  const out = [];
  for (const s of clock.segs) {
    for (let r = Math.ceil(s.r0 / step) * step; r <= s.r1; r += step) out.push({ p: s.p0 + (r - s.r0), real: r, label: clockWords(r, step < 60_000) });
  }
  return out;
}

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * The timeline's label: "Recorded 22 Sep 2026, 16:37:26–17:13:00 UTC from
 * behold-terralith-14 · plan domains", from the recording's own header and
 * times. A source the records do not name is left out. `short`: the phone's
 * "Recorded 16:37–17:13 UTC".
 */
export function recordedLabel({ t0, t1, source = null, plan = null }, { short = false } = {}) {
  if (short) return `Recorded ${clockWords(t0)}–${clockWords(t1)} UTC`;
  const from = [source, plan ? `plan ${plan}` : null].filter(Boolean).join(" · ");
  return `Recorded ${DAY.format(new Date(t0))}, ${clockWords(t0, true)}–${clockWords(t1, true)} UTC${from ? ` from ${from}` : ""}`;
}

/** The speed control's words, always its state: "1x real time", "slowed ×10", "sped up ×4". */
export function speedWords(speed) {
  if (speed === 1) return "1x real time";
  if (speed < 1) return `slowed ×${Math.round(1 / speed)}`;
  return `sped up ×${speed}`;
}

/** The speeds a recorded replay offers, real time first. */
export const RECORDED_SPEEDS = [1, 4, 16, 0.5, 0.1];

/** A gap's length in words: "+48 s skipped", "+2 min 5 s skipped". */
export function skippedWords(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `+${s} s skipped` : `+${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""} skipped`;
}

/**
 * The marks on the timeline, each a line of the recording: the first and
 * last move, each keyframe (an estate listing), and the end. Each is
 * { p, real, kind, words, record } where `record` names the file, line and time.
 */
export function recordedMarks(show, clock, file = "the recording") {
  const r = show && show.records;
  if (!r) return [];
  const out = [];
  const add = (real, kind, words, line) => {
    if (!Number.isFinite(real)) return;
    out.push({ p: clock.toReplay(real), real, kind, words, record: `${file}${line ? ` line ${line}` : ""} · ${new Date(real).toISOString()}` });
  };
  const moves = show.events.filter((e) => e.kind === "write");
  if (moves.length) {
    const first = moves.reduce((a, e) => (e.t < a.t ? e : a));
    const last = moves.reduce((a, e) => (e.t > a.t ? e : a));
    add(first.t, "first", `first move: ${first.address}`, first.line);
    add(last.t, "last", `last move: ${last.address}`, last.line);
  }
  for (const k of r.keyframes || []) add(k.t, "keyframe", "keyframe: each estate listed (live-ls)", k.line);
  if (r.end) add(r.end.t, "end", "the recording's end", r.end.line);
  return out.sort((a, b) => a.p - b.p);
}
