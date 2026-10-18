// behold#631: a chant apply played at a pace a viewer can follow.
//
// On a fast estate (floci) a whole pr-apply settles in about three seconds,
// less than the time between two uploads of its events, so the view would
// jump from the first wave applying straight to everything settled. The
// answer's `live.apply.timeline` (src/chant-pr-events.ts) holds every change
// of state in stream order. This plays it: each wave shows applying for at
// least `apply` ms, then done for at least `done` ms, before the next wave's
// states show. Nothing is invented: every state shown is one the events gave,
// at a step no later than the stream has reached.
//
// - Once the stream has settled, the rest plays at the catch-up pace, so the
//   view reaches the end within a few seconds.
// - A run first seen already settled (a reload, a late viewer) shows its
//   settled state at once, with no replay.
// - Without a timeline (an older answer, a repo without events) the answer
//   is shown as it came.
//
// Pure apart from the clock it is given.

/** Minimum dwell per wave, in ms: applying, then done. The catch-up pace applies once the stream settled. */
export const PACE = { apply: 3000, done: 1500, catchApply: 1200, catchDone: 600 };

const SETTLE = new Set(["applied", "failed", "gated"]);
const WAVE_SETTLE = new Set(["applied", "failed", "gated"]);

/** A run's key: a new run (a re-run, the fix's apply) plays from its own start. */
const keyOf = (live) => `${live.stage}|${live.runId || ""}|${live.gitSha || ""}|${live.source || ""}`;

/**
 * A pacer. `view(live)` answers what to show of that stage's events now, and
 * `pending` whether more is still to come (so a caller keeps redrawing).
 */
export function createLivePacer({ now = () => Date.now(), pace = PACE } = {}) {
  const runs = new Map();
  let pending = false;

  const view = (live) => {
    pending = false;
    if (!live || !Array.isArray(live.timeline) || !live.timeline.length) return live;
    const tl = live.timeline;
    const key = keyOf(live);
    let st = runs.get(key);
    if (!st) {
      // First seen settled: no replay. First seen running: play from its start.
      st = { cursor: live.settled ? tl.length : 0, waveStart: new Map(), lastSettleAt: null, lastSettleWave: null };
      runs.set(key, st);
      if (runs.size > 8) runs.delete(runs.keys().next().value);
    }
    const t = now();
    const dwellApply = live.settled ? pace.catchApply : pace.apply;
    const dwellDone = live.settled ? pace.catchDone : pace.done;
    while (st.cursor < tl.length) {
      const e = tl[st.cursor];
      if (e.kind === "wave" && e.state === "running") {
        // The next wave waits until the one before showed done long enough.
        if (st.lastSettleAt !== null && t - st.lastSettleAt < dwellDone) break;
        st.waveStart.set(e.wave, t);
      } else if ((e.kind === "wave" && WAVE_SETTLE.has(e.state)) || (e.kind === "component" && SETTLE.has(e.state))) {
        // A wave's results wait until it showed applying long enough.
        const started = st.waveStart.get(e.wave);
        if (started !== undefined && t - started < dwellApply) break;
        if (e.kind === "wave") {
          st.lastSettleAt = t;
          st.lastSettleWave = e.wave;
        }
      }
      st.cursor++;
    }
    pending = st.cursor < tl.length;
    if (st.cursor >= tl.length) return live;
    return shownAt(live, st.cursor);
  };

  return {
    view,
    /**
     * The answer with its `live.apply` as it shows now. While the play is
     * behind the stream, the apply's summary waits too (it would say how
     * every card ended), and the stage reads as still running.
     */
    answer(a) {
      if (!a || !a.live || !a.live.apply) {
        pending = false;
        return a;
      }
      const apply = view(a.live.apply);
      if (apply === a.live.apply) return a;
      const running = a.running || (a.apply ? { stage: "apply", run: a.apply.run || null, job: "apply", status: "running", started_at: null } : null);
      return { ...a, apply: null, running, live: { ...a.live, apply } };
    },
    get pending() {
      return pending;
    },
  };
}

/** The stage as its first `n` steps leave it: each state the last step gave, nothing settled yet. */
export function shownAt(live, n) {
  const tl = live.timeline.slice(0, n);
  const compState = new Map();
  const waveState = new Map();
  for (const e of tl) {
    if (e.kind === "component") compState.set(e.component, e.state);
    else waveState.set(e.wave, e.state);
  }
  const components = {};
  for (const [name, c] of Object.entries(live.components || {})) {
    const state = compState.get(name) || "waiting";
    // An error or a blocker belongs to the state it came with.
    const same = state === c.state;
    components[name] = {
      component: name,
      wave: c.wave,
      ...(c.waveFrom ? { waveFrom: c.waveFrom } : {}),
      ...(Number.isInteger(c.graphWave) ? { graphWave: c.graphWave } : {}),
      state,
      ...(same && c.error ? { error: c.error } : {}),
      ...(same && c.failedIn ? { failedIn: c.failedIn } : {}),
      ...(same && c.blockedBy ? { blockedBy: c.blockedBy, blockedFrom: c.blockedFrom } : {}),
    };
  }
  const waves = (live.waves || []).map((w) => {
    const counts = { applied: 0, failed: 0, blocked: 0, alreadyApplied: 0, running: 0, waiting: 0 };
    for (const name of w.components) {
      const s = components[name] ? components[name].state : "waiting";
      if (s === "applied") counts.applied++;
      else if (s === "failed") counts.failed++;
      else if (s === "blocked") counts.blocked++;
      else if (s === "already-applied") counts.alreadyApplied++;
      else if (s === "running") counts.running++;
      else if (s !== "gated" && s !== "not-run") counts.waiting++;
    }
    return { ...w, state: waveState.get(w.wave) || "waiting", counts };
  });
  const last = tl[tl.length - 1];
  return { ...live, settled: false, status: null, seq: last ? last.seq : live.seq, at: last ? last.at : live.at, waves, components, paced: true };
}
