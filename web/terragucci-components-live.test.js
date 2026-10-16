import { describe, expect, it } from "vitest";
import { JOB_WORDS, componentMarks, jobStatus, runsCommit, waveOfKey, waveStatus, waveTitle } from "./terragucci-components-live.js";

// #571: the live marks on a terragucci repo's components zoom. The facets are
// the components graph's (src/__fixtures__/terragucci-components: network and
// other in wave 1, app in 2, edge in 3), the run view and the runs shaped as
// the kiosk's demo fixtures have them.
const MERGE = "f0e1d2c3b4a5968778695a4b3c2d1e0f12345678";
const facets = {
  jobs: [
    { component: "network", jobName: "apply-wave-1", needs: ["check"], wave: 1 },
    { component: "other", jobName: "apply-wave-1", needs: ["check"], wave: 1 },
    { component: "app", jobName: "apply-wave-2", needs: ["apply-wave-1"], wave: 2 },
    { component: "edge", jobName: "apply-wave-3", needs: ["apply-wave-2"], wave: 3 },
  ],
  roots: { network: "network", other: "other", app: "app", edge: "edge" },
};
const answer = {
  roots: ["app", "edge", "network", "other"].map((name) => ({ member: "demo", name, path: name })),
  pull_request: {
    run: { pull_request: "41", commit: "a1b2c3d4", finished: "2026-10-20T10:01:40.000Z" },
    roots: ["network", "app", "edge"],
    reads: [{ root: "app", upstream: "network", data: "network", outputs: "planned", unknown: ["subnet_id"] }],
    waves: [
      { number: 1, roots: ["network"], set_digest: "jcs1-sha256:aaaaaaaaaaaaaaaa" },
      { number: 2, roots: ["app"], replans_after: [1], waits: true },
      { number: 3, roots: ["edge"], set_digest: "jcs1-sha256:bbbbbbbbbbbbbbbb" },
    ],
    blast: { roots: ["network", "app", "edge"], downstream: [] },
  },
};
const progress = (wave2) => ({
  run: { present: true, commit: MERGE, updated: "2026-10-20T10:05:00.000Z" },
  states: [
    { number: 1, state: "applied", roots: ["network"], reads: [], digest: "jcs1-sha256:4444", totals: { create: 1 }, changed: ["network"] },
    { number: 2, state: wave2, roots: ["app"], reads: [1], digest: "jcs1-sha256:555555555555555555", totals: { create: 4 }, changed: ["app"] },
    { number: 3, state: "not-started", roots: ["edge"], reads: [2] },
  ],
  reads: [
    { root: "app", wave: 2, reads: ["network"] },
    { root: "edge", wave: 3, reads: ["app"] },
  ],
});
const job = (name, status) => ({ name, status });
const runs = (...list) => ({ doc: { runs: list } });
const run = (id, commit, jobs) => ({ id, commit, jobs });

describe("a wave job's status from the pipeline's runs (#571)", () => {
  it("takes the newest run on the commit in which the job ran or waits", () => {
    const index = runs(
      run(12, MERGE, [job("apply-wave-1", "skipped"), job("apply-wave-2", "running")]), // the resume
      run(11, MERGE, [job("apply-wave-1", "success"), job("apply-wave-2", "waiting")]), // the merge, held at the gate
      run(10, "0000000", [job("apply-wave-2", "failure")]),
    );
    expect(jobStatus(index, MERGE, "apply-wave-2")).toEqual({ status: "running", words: "running", tone: "busy", run: 12 });
    // The resume skipped wave 1: the merge's run says how it went, and that a later run went on from it.
    expect(jobStatus(index, MERGE, "apply-wave-1")).toEqual({ status: "success", words: "succeeded", tone: "ok", run: 11, superseded: 12 });
    // A short sha names the same commit.
    expect(jobStatus(index, MERGE.slice(0, 8), "apply-wave-2").run).toBe(12);
  });

  it("says skipped when every run on the commit skipped the job, and nothing without one", () => {
    const index = runs(run(12, MERGE, [job("apply-wave-3", "skipped")]));
    expect(jobStatus(index, MERGE, "apply-wave-3")).toMatchObject({ status: "skipped", words: "skipped" });
    expect(jobStatus(index, MERGE, "apply-wave-9")).toBe(null);
    expect(jobStatus(index, "1234567", "apply-wave-3")).toBe(null);
    expect(jobStatus(null, MERGE, "apply-wave-3")).toBe(null);
    expect(jobStatus({ error: "no runs" }, MERGE, "apply-wave-3")).toBe(null);
  });

  it("calls a job held at the gate that, never a failure", () => {
    expect(JOB_WORDS.waiting).toBe("held at the gate");
    expect(waveTitle("apply-wave-2", { words: JOB_WORDS.waiting })).toBe("apply-wave-2 · held at the gate");
    expect(waveTitle("apply-wave-2", null)).toBe("apply-wave-2");
  });

  it("reads the runs of the pinned commit, of the run view's without a pin, and of none under a pin off every run", () => {
    expect(runsCommit(MERGE, null)).toBe(MERGE);
    expect(runsCommit(null, progress("waiting"))).toBe(MERGE);
    expect(runsCommit(null, null)).toBe(null);
    for (const pin of ["base", "none", "pull", "pull-41", `pull-41-${MERGE}`]) expect(runsCommit(pin, progress("waiting"))).toBe(null);
  });

  it("reads a wave from chant's box key", () => {
    expect(waveOfKey("wave-2")).toBe(2);
    expect(waveOfKey("wave-12")).toBe(12);
    expect(waveOfKey("network")).toBe(null);
    expect(waveOfKey(undefined)).toBe(null);
  });
});

describe("the component marks (#571)", () => {
  it("colours each card by its wave's state, and puts the waiting wave's digest and its job's status on its box", () => {
    const index = runs(run(11, MERGE, [job("apply-wave-1", "success"), job("apply-wave-2", "waiting"), job("apply-wave-3", "queued")]));
    const m = componentMarks(answer, progress("waiting"), facets, { runs: index, pin: MERGE });
    expect(m.stage).toBe("apply");
    expect(Object.fromEntries(Object.entries(m.cards).map(([c, x]) => [c, [x.state, x.tone, x.words]]))).toEqual({
      network: ["applied", "ok", "applied"],
      other: ["outside", "idle", "not in this run"],
      app: ["waiting", "wait", "waiting for an approval"],
      edge: ["not-started", "idle", "queued"],
    });
    expect(m.cards.app.short).toBe("waiting");
    expect(m.waves[2]).toMatchObject({ job: "apply-wave-2", state: "waiting", tone: "wait", title: "apply-wave-2 · held at the gate" });
    expect(m.waves[2].facts[0]).toBe("approve plan 555555555555");
    expect(m.waves[1].title).toBe("apply-wave-1 · succeeded");
    expect(m.waves[3]).toMatchObject({ state: "not-started", title: "apply-wave-3 · queued", facts: [] });
  });

  it("says first on a failed wave's box that the waves before it stay applied", () => {
    const index = runs(run(11, MERGE, [job("apply-wave-1", "success"), job("apply-wave-2", "failure"), job("apply-wave-3", "skipped")]));
    const m = componentMarks(answer, progress("failed"), facets, { runs: index, pin: MERGE });
    expect(m.cards.app).toMatchObject({ state: "failed", tone: "bad" });
    expect(m.waves[2].facts[0]).toBe("wave 1 stays applied");
    expect(m.waves[2].title).toBe("apply-wave-2 · failed");
    expect(m.waves[3].title).toBe("apply-wave-3 · skipped");
  });

  it("titles a wave a re-run applied with the latest run's state, not the merge's failure (behold#571)", () => {
    // As the demo's failure scenario has them: the merge's run fails wave 2; each
    // /terragucci apply re-run applies the waves in its apply-comment job and skips the wave jobs.
    const comment = (id, status) => run(id, MERGE, [job("apply-comment", status), job("apply-wave-1", "skipped"), job("apply-wave-2", "skipped"), job("apply-wave-3", "skipped")]);
    const merge = run(11, MERGE, [job("apply-comment", "skipped"), job("apply-wave-1", "success"), job("apply-wave-2", "failure"), job("apply-wave-3", "queued")]);
    const applied = { ...progress("applied"), states: progress("applied").states.map((w) => ({ ...w, state: "applied" })) };
    const m = componentMarks(answer, applied, facets, { runs: runs(comment(13, "success"), comment(12, "waiting"), merge), pin: MERGE });
    expect(m.cards.app).toMatchObject({ state: "applied" });
    expect(m.waves[2]).toMatchObject({ state: "applied", tone: "ok", title: "apply-wave-2 · applied" });
    expect(m.waves[3].title).toBe("apply-wave-3 · applied");
    // While the re-run waits at the gate, the box says so.
    const held = componentMarks(answer, progress("waiting"), facets, { runs: runs(comment(12, "waiting"), merge), pin: MERGE });
    expect(held.waves[2].title).toBe("apply-wave-2 · held at the gate");
    // Before any re-run, the merge's own failure.
    const failed = componentMarks(answer, progress("failed"), facets, { runs: runs(merge), pin: MERGE });
    expect(failed.waves[2].title).toBe("apply-wave-2 · failed");
  });

  it("keeps the job's status when no later run took the wave over, or the run view has no state for it", () => {
    const st = { status: "failure", words: "failed", tone: "bad", run: 11 };
    expect(waveStatus(st, "applied")).toBe(st);
    expect(waveStatus({ ...st, superseded: 12 }, null)).toMatchObject({ status: "failure" });
    expect(waveStatus({ ...st, superseded: 12 }, "applied")).toEqual({ status: "applied", words: "applied", tone: "ok", run: 12 });
    expect(waveStatus(null, "applied")).toBe(null);
  });

  it("draws the pull request's plan before the merge, with no job status", () => {
    const m = componentMarks(answer, null, facets, { runs: runs(run(11, MERGE, [job("apply-wave-2", "waiting")])), pin: `pull-41-a1b2c3d4` });
    expect(m.stage).toBe("pull-request");
    expect(m.cards.network).toMatchObject({ state: "planned", words: "planned" });
    expect(m.cards.other).toMatchObject({ state: "outside", words: "unchanged" });
    expect(m.waves[2]).toMatchObject({ state: "planned", status: null, title: "apply-wave-2" });
    expect(m.waves[1].facts).toEqual(["plan aaaaaaaaaaaa"]);
  });

  it("marks nothing at rest", () => {
    const m = componentMarks({ ...answer, pull_request: null }, null, facets, { runs: null, pin: "base" });
    expect(m.stage).toBe("none");
    expect(m.cards).toEqual({});
    expect(Object.values(m.waves).map((w) => [w.title, w.state])).toEqual([
      ["apply-wave-1", null],
      ["apply-wave-2", null],
      ["apply-wave-3", null],
    ]);
  });

  it("joins a component to the root it applies, and to its own name without one", () => {
    const renamed = { jobs: [{ component: "net", jobName: "apply-wave-1", wave: 1 }, { component: "app", jobName: "apply-wave-2", wave: 2 }], roots: { net: "network" } };
    const m = componentMarks(answer, progress("applying"), renamed, { runs: null, pin: MERGE });
    expect(m.cards.net).toMatchObject({ root: "network", state: "applied" });
    expect(m.cards.app).toMatchObject({ root: "app", state: "applying", tone: "busy" });
  });
});
