import { describe, expect, it } from "vitest";
import { PACE, createLivePacer, shownAt } from "./chant-live-pace.js";

// behold#631: a fan-out apply that settled in about three seconds (floci),
// faster than its events were uploaded, played at a pace a viewer can follow.
const step = (seq, kind, state, more) => ({ seq, at: null, kind, state, ...more });
const comp = (seq, component, wave, state) => step(seq, "component", state, { component, wave });
const wave = (seq, n, state) => step(seq, "wave", state, { wave: n });
const timeline = [
  comp(0, "network", 1, "waiting"),
  comp(0, "cluster-a", 2, "waiting"),
  comp(0, "app-01", 3, "waiting"),
  wave(0, 1, "waiting"),
  wave(0, 2, "waiting"),
  wave(0, 3, "waiting"),
  wave(1, 1, "running"),
  comp(2, "network", 1, "running"),
  comp(3, "network", 1, "applied"),
  wave(4, 1, "applied"),
  wave(5, 2, "running"),
  comp(6, "cluster-a", 2, "running"),
  comp(7, "cluster-a", 2, "failed"),
  wave(8, 2, "failed"),
  comp(9, "app-01", 3, "blocked"),
];
const final = {
  stage: "apply",
  runId: "r1",
  gitSha: "a".repeat(40),
  source: "s3://r/14/x/pr-apply.events.jsonl",
  seq: 10,
  at: null,
  settled: true,
  status: "failed",
  waves: [
    { wave: 1, state: "applied", components: ["network"], counts: {} },
    { wave: 2, state: "failed", components: ["cluster-a"], counts: {} },
    { wave: 3, state: "blocked", components: ["app-01"], counts: {} },
  ],
  components: {
    network: { component: "network", wave: 1, state: "applied" },
    "cluster-a": { component: "cluster-a", wave: 2, state: "failed", error: "stack reached ROLLBACK_COMPLETE", failedIn: "apply" },
    "app-01": { component: "app-01", wave: 3, state: "blocked", blockedBy: "cluster-a", blockedFrom: "event" },
  },
  timeline,
};
/** The stream as the first upload had it: network applying, nothing settled. */
const early = { ...shownAt(final, 8), paced: undefined, settled: false, status: null, timeline: timeline.slice(0, 8) };

describe("a fast chant apply, played at a viewer's pace (behold#631)", () => {
  it("shows a run first seen settled at once, with no replay", () => {
    const p = createLivePacer({ now: () => 0 });
    expect(p.view(final)).toBe(final);
    expect(p.pending).toBe(false);
  });

  it("plays a run first seen running: each wave applying, then done, before the next wave's states", () => {
    let t = 0;
    const p = createLivePacer({ now: () => t });
    // First read: network applying.
    let v = p.view(early);
    expect(v.components.network.state).toBe("running");
    expect(v.waves[0].state).toBe("running");
    // The next upload has the whole run settled, but wave 1 has not shown applying long enough.
    t = 500;
    v = p.view(final);
    expect(v.components.network.state).toBe("running");
    expect(v.settled).toBe(false);
    expect(p.pending).toBe(true);
    // Settled, the rest plays at the catch-up pace: wave 1 done after its applying dwell.
    t = PACE.catchApply;
    v = p.view(final);
    expect(v.components.network.state).toBe("applied");
    expect(v.waves[0].state).toBe("applied");
    expect(v.waves[1].state).toBe("waiting");
    // Wave 2 starts only after wave 1 showed done.
    t += PACE.catchDone;
    v = p.view(final);
    expect(v.waves[1].state).toBe("running");
    expect(v.components["cluster-a"].state).toBe("running");
    expect(v.components["cluster-a"].error).toBeUndefined();
    // Its failure, with the error it came with, after its applying dwell.
    t += PACE.catchApply;
    v = p.view(final);
    expect(v.components["cluster-a"]).toMatchObject({ state: "failed", error: "stack reached ROLLBACK_COMPLETE" });
    expect(v.components["app-01"]).toMatchObject({ state: "blocked", blockedBy: "cluster-a" });
    // Then the end: the answer as it came.
    t += PACE.catchDone;
    expect(p.view(final)).toBe(final);
    expect(p.pending).toBe(false);
  });

  it("catches up within a few seconds once the stream settled", () => {
    const waves = final.waves.length;
    expect(waves * (PACE.catchApply + PACE.catchDone)).toBeLessThanOrEqual(6000);
  });

  it("never shows a state the events did not give", () => {
    const states = new Set(timeline.map((e) => e.state));
    for (let n = 0; n <= timeline.length; n++) {
      const v = shownAt(final, n);
      for (const c of Object.values(v.components)) expect(states.has(c.state)).toBe(true);
    }
  });

  it("hides the apply's summary while it plays, and the stage reads as running", () => {
    let t = 0;
    const p = createLivePacer({ now: () => t });
    const a = { live: { apply: early }, apply: null, running: { stage: "apply", run: 9, job: "apply", status: "running" } };
    p.answer(a);
    t = 100;
    const b = p.answer({ live: { apply: final }, apply: { stage: "apply", run: 9, status: "failed", members: [] }, running: null });
    expect(b.apply).toBeNull();
    expect(b.running).toMatchObject({ stage: "apply", run: 9, status: "running" });
  });
});
