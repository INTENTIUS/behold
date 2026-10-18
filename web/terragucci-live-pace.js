// behold#741: a terragucci apply played at the pace chant's is (web/chant-live-pace.js).
//
// /api/terragucci/progress moves per wave: each read of the run view says
// where every wave stands. On a fast estate two reads apart can take a wave
// from queued to applied, or two waves at once, and the graph would jump.
// This pacer keeps the waves' changes in the order the reads gave them and
// shows them one at a time: a wave shows applying for at least `apply` ms,
// then its outcome for at least `done` ms, before the next wave's change
// shows. A wave seen going straight from queued to applied or failed is
// shown applying first: it did apply between the two reads. Once the run
// view stops moving (`watching` false) the rest plays at the catch-up pace.
//
// - A run first seen (a reload, a late viewer) shows as it stands, with no replay.
// - Only for a kiosk telling a chapter-carrying scenario; every other view
//   reads the progress as it came.
//
// Pure apart from the clock it is given.

import { PACE } from "./chant-live-pace.js";

export { PACE };

const SETTLED = new Set(["applied", "failed", "refused", "blocked"]);
const RAN = new Set(["applied", "failed"]);

/** A run view's key: a new commit's run (the fix's apply) plays from its own start. */
const keyOf = (p) => `${(p.run && p.run.project) || ""}|${(p.run && p.run.commit) || ""}`;

/**
 * A pacer. `progress(p)` answers the progress as it shows now, its waves'
 * states held back to the pace; `pending` says whether more is still to come.
 */
export function createProgressPacer({ now = () => Date.now(), pace = PACE } = {}) {
  const runs = new Map();
  let pending = false;
  const progress = (p) => {
    pending = false;
    if (!p || p.error || !p.run || !p.run.present || !Array.isArray(p.states) || !p.states.length) return p;
    const key = keyOf(p);
    let st = runs.get(key);
    const waves = [...p.states].sort((a, b) => a.number - b.number);
    if (!st) {
      // A wave first seen applying started then, as far as the view knows: its outcome waits its dwell from now.
      const t0 = now();
      st = { target: new Map(waves.map((w) => [w.number, w.state])), shown: new Map(waves.map((w) => [w.number, w.state])), queue: [], waveStart: new Map(waves.filter((w) => w.state === "applying").map((w) => [w.number, t0])), lastSettleAt: null };
      runs.set(key, st);
      if (runs.size > 8) runs.delete(runs.keys().next().value);
      return p;
    }
    // The reads' changes, in wave order, onto the queue.
    for (const w of waves) {
      if (st.target.get(w.number) === w.state) continue;
      const was = st.target.get(w.number);
      st.target.set(w.number, w.state);
      if (RAN.has(w.state) && was !== "applying") st.queue.push({ wave: w.number, state: "applying" });
      st.queue.push({ wave: w.number, state: w.state });
    }
    const t = now();
    const dwellApply = p.watching === false ? pace.catchApply : pace.apply;
    const dwellDone = p.watching === false ? pace.catchDone : pace.done;
    while (st.queue.length) {
      const e = st.queue[0];
      if (e.state === "applying") {
        if (st.lastSettleAt !== null && t - st.lastSettleAt < dwellDone) break;
        st.waveStart.set(e.wave, t);
      } else if (SETTLED.has(e.state)) {
        const started = st.waveStart.get(e.wave);
        if (started !== undefined && t - started < dwellApply) break;
        if (started === undefined && st.lastSettleAt !== null && t - st.lastSettleAt < dwellDone) break;
        st.lastSettleAt = t;
      }
      st.shown.set(e.wave, e.state);
      st.queue.shift();
    }
    pending = st.queue.length > 0;
    if (!pending) return p;
    return { ...p, states: p.states.map((w) => (st.shown.has(w.number) && st.shown.get(w.number) !== w.state ? { ...w, state: st.shown.get(w.number) } : w)), paced: true };
  };
  return {
    progress,
    get pending() {
      return pending;
    },
  };
}

/** The waves as the kiosk's track ticks them: chant's words for a terragucci wave's state. */
const TICK = { "not-started": "waiting", planned: "waiting", waiting: "gated", applying: "running", applied: "applied", failed: "failed", refused: "gated", blocked: "blocked" };
export function trackWaves(progress) {
  if (!progress || progress.error || !Array.isArray(progress.states)) return null;
  return [...progress.states].sort((a, b) => a.number - b.number).map((w) => ({ wave: w.number, state: TICK[w.state] || "waiting" }));
}
