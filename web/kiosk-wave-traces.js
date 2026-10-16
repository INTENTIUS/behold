// behold#571: each wave's trace, for the places Watch already shows a wave's
// numbers: the badge on its box, the applied result card (a mini waterfall
// per wave), the drawer, and event-help's "trace ready" tip. Pure: it reads
// /api/traces answers (src/tempo-traces.ts) the kiosk already fetches, one
// per run of the cycle, and keeps the newest trace of each wave.

/** The phases a wave's job runs, in order, as terragucci names them on its stage's spans. */
export const PHASES = ["plan", "gate", "apply", "report", "upload"];

/**
 * The newest trace of each wave across the cycle's runs' answers:
 * `{ [wave]: { run, job, trace } }`. A trace names its wave (`wave`) and its
 * job; a resumed run applies several waves in one job, each its own trace.
 */
export function waveTraces(answers) {
  const out = {};
  for (const a of answers || []) {
    if (!a || a.error || !Array.isArray(a.traces)) continue;
    for (const t of a.traces) {
      const w = Number(t.wave);
      if (!Number.isInteger(w) || !Array.isArray(t.spans) || !t.spans.length) continue;
      if (!out[w] || out[w].trace.start < t.start) out[w] = { run: String(a.run), job: t.job, trace: t };
    }
  }
  return out;
}

const attrs = (s) => s.attrs || {};

/**
 * One wave's trace as phase bars: `[{ phase, ms, at, width, wait }]`, `at` and
 * `width` 0..1 across the stage, in time order. A gate that held a wave for an
 * approval is split: the hold (`phase: "held"`, a wait) and the rest of the
 * gate. Only the phases the trace has; nothing for a trace without them.
 */
export function phaseBars(trace) {
  const spans = trace && Array.isArray(trace.spans) ? trace.spans : [];
  const root = spans.find((s) => !s.parent) || null;
  if (!root || !(root.ms > 0)) return [];
  const t0 = root.start;
  const span = root.ms;
  const bar = (phase, start, ms, wait = false) => ({ phase, ms, at: Math.max(0, (start - t0) / span), width: Math.max(0, Math.min(1, ms / span)), wait });
  const out = [];
  for (const s of spans.filter((x) => x.parent === root.id && attrs(x)["terragucci.phase"]).sort((a, b) => a.start - b.start)) {
    const phase = String(attrs(s)["terragucci.phase"]);
    const held = attrs(s)["terragucci.gate.held_seconds"];
    if (phase === "gate" && typeof held === "number" && held > 0) {
      const heldMs = Math.min(s.ms, held * 1000);
      out.push(bar("held", s.start, heldMs, true));
      if (s.ms - heldMs > 0) out.push(bar("gate", s.start + heldMs, s.ms - heldMs));
    } else out.push(bar(phase, s.start, s.ms, phase === "gate" && attrs(s)["terragucci.gate.status"] === "waiting"));
  }
  return out;
}

/** "70 ms", "1.6 s", "25 s", "2 min 5 s". */
export function msShort(ms) {
  if (!(ms >= 0)) return null;
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 10) return `${Math.round(s * 10) / 10} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return r ? `${m} min ${r} s` : `${m} min`;
}

/** The words a phase bar carries: "plan 1.2 s", "held 25 s for an approval". */
export function phaseWords(b) {
  if (b.phase === "held") return `held ${msShort(b.ms)} for an approval`;
  return `${b.phase} ${msShort(b.ms)}`;
}

/**
 * What a wave's trace shows, in one line, for its "trace ready" tip: how long
 * the job took, and where the time went: the hold when an approval held it,
 * else the longest phase. "wave 2 took 1.6 s, 1.2 s of it in the plan".
 */
export function traceReadyWords(wave, trace) {
  if (!trace || !(trace.ms > 0)) return null;
  const bars = phaseBars(trace);
  const took = `wave ${wave}'s trace is ready; it took ${msShort(trace.ms)}`;
  const held = bars.find((b) => b.phase === "held");
  if (held) return `${took}, ${msShort(held.ms)} of it held for an approval`;
  const longest = bars.filter((b) => !b.wait).sort((a, b) => b.ms - a.ms)[0];
  return longest ? `${took}, ${msShort(longest.ms)} of it in the ${longest.phase}` : took;
}

/**
 * The applied card's mini waterfall: one row per wave that has a trace, in
 * wave order: `{ wave, run, job, ms, words, bars }`. No row for a wave
 * without one.
 */
export function miniWaterfall(traces) {
  return Object.keys(traces || {})
    .map(Number)
    .sort((a, b) => a - b)
    .map((w) => {
      const { run, job, trace } = traces[w];
      const bars = phaseBars(trace);
      return bars.length ? { wave: w, run, job, ms: trace.ms, words: msShort(trace.ms), bars } : null;
    })
    .filter(Boolean);
}
