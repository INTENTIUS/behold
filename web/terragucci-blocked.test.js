import { describe, expect, it } from "vitest";
import { blockedHeader, blockedOf, outcomesOf, rootStates, waveRows } from "./terragucci-change.js";
import { componentMarks, tgReachOf } from "./terragucci-components-live.js";
import { createProgressPacer, trackWaves } from "./terragucci-live-pace.js";

// behold#741 (terragucci#1161): a failed root blocks only its dependents. The
// wave reports carry `waves[].blocked: [{ root, blocked_by }]` (minor 41),
// which /api/terragucci answers as `blocked: { commit, roots }`, and the run
// view a wave state `blocked` for a wave none of whose roots ran. A fan-out:
// network in wave 1; cluster-a and cluster-b in wave 2; app-01..03 under
// cluster-a and app-04..06 under cluster-b in wave 3. All of it is a story's
// alone (a kiosk telling a chapter-carrying scenario): without one, the
// states read exactly as on main, whatever the reports carry.
const MERGE = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
const apps = ["app-01", "app-02", "app-03", "app-04", "app-05", "app-06"];
const all = ["network", "cluster-a", "cluster-b", ...apps];
const facets = {
  jobs: [
    { component: "network", jobName: "apply-wave-1", wave: 1 },
    { component: "cluster-a", jobName: "apply-wave-2", wave: 2 },
    { component: "cluster-b", jobName: "apply-wave-2", wave: 2 },
    ...apps.map((a) => ({ component: a, jobName: "apply-wave-3", wave: 3 })),
  ],
  roots: Object.fromEntries(all.map((r) => [r, r])),
};
const base = { roots: all.map((name) => ({ member: "demo", name, path: name })) };
const reads = [
  { root: "cluster-a", wave: 2, reads: ["network"] },
  { root: "cluster-b", wave: 2, reads: ["network"] },
  ...apps.map((a, i) => ({ root: a, wave: 3, reads: [i < 3 ? "cluster-a" : "cluster-b"] })),
];
const progress = (w2, w3, w3changed = ["app-04", "app-05", "app-06"]) => ({
  run: { present: true, project: "demo", commit: MERGE, updated: "2026-10-18T10:05:00.000Z" },
  watching: false,
  states: [
    { number: 1, state: "applied", roots: ["network"], reads: [], changed: ["network"], totals: { update: 1 } },
    { number: 2, state: w2, roots: ["cluster-a", "cluster-b"], reads: [1], changed: ["cluster-a", "cluster-b"], totals: { update: 2 } },
    { number: 3, state: w3, roots: apps, reads: [2], ...(w3 === "not-started" ? {} : { changed: w3changed, totals: { update: w3changed.length } }) },
  ],
  reads,
});
const story = { story: true };
const blocked = (commit = MERGE) => ({ commit, roots: Object.fromEntries(apps.slice(0, 3).map((a) => [a, { wave: 3, by: "cluster-a" }])) });

describe("a blocked root, from the wave reports (behold#741)", () => {
  it("reads blocked and blocked_by when the reports carry them", () => {
    const st = rootStates({ ...base, blocked: blocked() }, progress("failed", "applied"), story);
    expect(st.roots["app-01"]).toMatchObject({ wave: 3, state: "blocked", tone: "wait", words: "wave 3 · blocked by cluster-a", blockedBy: "cluster-a" });
    // The roots its failure did not reach apply.
    expect(st.roots["app-04"]).toMatchObject({ state: "applied" });
  });

  it("names the original failure, whatever the report says of the roots between", () => {
    const b = { commit: MERGE, roots: { "app-01": { wave: 3, by: "network" } } };
    expect(blockedOf({ blocked: b }, progress("blocked", "blocked")).get("app-01")).toEqual({ wave: 3, by: "network" });
  });

  it("is nothing without a story, even on reports that carry the field (b-waves, failure, tg-planned-outputs)", () => {
    const data = { ...base, blocked: blocked() };
    const p = progress("failed", "applied");
    expect(rootStates(data, p)).toEqual(rootStates(base, p));
    expect(componentMarks(data, p, facets)).toEqual(componentMarks(base, p, facets));
    // The run view's own blocked state reads as main reads it: its word, in the idle tone.
    expect(rootStates(base, progress("failed", "blocked")).roots["app-05"]).toMatchObject({ state: "blocked", tone: "idle", words: "wave 3 · blocked" });
    expect(waveRows(data, p)[2].text).toBe("wave 3 applied: app-01, app-02, app-03, app-04, app-05, app-06");
  });

  it("is nothing for an older report without the field: the states read exactly as before", () => {
    const before = rootStates(base, progress("failed", "not-started"), story);
    expect(Object.values(before.roots).some((r) => r.state === "blocked")).toBe(false);
    expect(blockedOf(base, progress("failed", "not-started")).size).toBe(0);
    // And the components' marks carry no blocked header.
    const m = componentMarks(base, progress("failed", "not-started"), facets);
    expect(m.waves[3].status).toBe(null);
    expect(m.cards["app-01"].state).not.toBe("blocked");
    expect(m.reach).toBeUndefined();
  });

  it("ignores another commit's blocked roots, and a wave not yet started", () => {
    expect(blockedOf({ ...base, blocked: blocked("deadbeef") }, progress("failed", "applied")).size).toBe(0);
    expect(blockedOf({ ...base, blocked: blocked() }, progress("failed", "not-started")).size).toBe(0);
  });

  it("holds every root of a wave the run view says is blocked, by nobody named until its report is read", () => {
    const st = rootStates(base, progress("failed", "blocked"), story);
    expect(st.roots["app-05"]).toMatchObject({ state: "blocked", tone: "wait", words: "wave 3 · blocked" });
  });

  it("says the wave's header as N applied, N blocked by X, and a blocked wave as blocked by X", () => {
    const b = blockedOf({ ...base, blocked: blocked() }, progress("failed", "applied"));
    expect(blockedHeader(apps, b, "applied")).toBe("3 applied, 3 blocked by cluster-a");
    expect(blockedHeader(apps.slice(0, 3), b, "blocked")).toBe("3 blocked by cluster-a");
    expect(blockedHeader(["network"], b, "applied")).toBe(null);
    const m = componentMarks({ ...base, blocked: blocked() }, progress("failed", "applied"), facets, { story: {} });
    expect(m.waves[3].status).toMatchObject({ status: "done", words: "3 applied, 3 blocked by cluster-a" });
    expect(m.waves[3].title).toBe("apply-wave-3 · 3 applied, 3 blocked by cluster-a");
    expect(m.cards["app-02"]).toMatchObject({ state: "blocked", words: "blocked by cluster-a", short: "blocked", tone: "wait", blockedBy: "cluster-a" });
  });

  it("says a wave none of whose roots ran as blocked by X", () => {
    const b = { commit: MERGE, roots: Object.fromEntries(apps.map((a) => [a, { wave: 3, by: "network" }])) };
    const m = componentMarks({ ...base, blocked: b }, progress("blocked", "blocked"), facets, { story: {} });
    expect(m.waves[3]).toMatchObject({ state: "blocked", tone: "wait", status: { status: "blocked", words: "6 blocked by network" } });
  });
});

// behold#741: each root's own outcome in its wave, asked of terragucci#1164 in
// one of two shapes until its field is named (src/terragucci-reports.ts
// waveOutcomes), and answered by /api/terragucci as `outcomes`.
describe("a root's own outcome in a failed wave (behold#741)", () => {
  const outcomes = { commit: MERGE, roots: { "cluster-a": { wave: 2, outcome: "failed", error: "Error: creating EKS cluster cluster-a: InvalidParameterException: subnet is full" }, "cluster-b": { wave: 2, outcome: "applied" } } };
  it("reads cluster-b applied beside a failed cluster-a, and the failure's error as chant's cards say it", () => {
    const m = componentMarks({ ...base, blocked: blocked(), outcomes }, progress("failed", "applied"), facets, { story: { kiosk: true } });
    expect(m.cards["cluster-b"]).toMatchObject({ state: "applied", tone: "ok", words: "applied" });
    expect(m.cards["cluster-a"]).toMatchObject({ state: "failed", tone: "bad" });
    expect(m.cards["cluster-a"].words).toMatch(/^failed: /);
    expect(m.cards["cluster-a"].facts[0]).toBe("failed: Error: creating EKS cluster cluster-a: InvalidParameterException: subnet is full");
    expect(m.waves[2].status).toMatchObject({ status: "failed", words: "1 failed, 1 applied", tone: "bad" });
    expect(m.waves[2].facts[0]).toMatch(/^cluster-a failed: /);
    // The reach now starts at the one root that failed.
    expect(m.reach).toMatchObject({ roots: ["cluster-a"], covered: ["app-01", "app-02", "app-03"] });
  });
  it("waits for the wave to settle, and is nothing without a story or another commit's", () => {
    const p = progress("failed", "applied");
    expect(outcomesOf({ outcomes }, { ...p, states: p.states.map((w) => (w.number === 2 ? { ...w, state: "applying" } : w)) }).size).toBe(2);
    expect(rootStates({ ...base, outcomes }, { ...p, states: p.states.map((w) => (w.number === 2 ? { ...w, state: "applying" } : w)) }, story).roots["cluster-b"].state).toBe("applying");
    expect(rootStates({ ...base, outcomes }, p).roots["cluster-b"].state).toBe("failed");
    expect(outcomesOf({ outcomes: { ...outcomes, commit: "deadbeef" } }, p).size).toBe(0);
    expect(outcomesOf(base, p).size).toBe(0);
  });
});

describe("a terragucci story's marks (behold#741)", () => {
  it("draws the failure's reach over the roots it blocked, from the run view's reads", () => {
    const m = componentMarks({ ...base, blocked: blocked() }, progress("failed", "applied"), facets, { story: { kiosk: true } });
    // cluster-a failed: the wave says failed for both of its roots, as before.
    expect(m.reach).toMatchObject({ tone: "bad", label: "3 blocked", roots: ["cluster-a", "cluster-b"] });
    expect(m.reach.covered).toEqual(["app-01", "app-02", "app-03"]);
    expect(m).toMatchObject({ cardFont: 15, waveFont: 18, statusRight: true });
  });

  it("draws the plan's reach from the changed root, over the planned roots downstream of it", () => {
    const pr = {
      run: { pull_request: "12", commit: "aa", finished: "2026-10-18T10:00:00Z" },
      roots: all,
      reads: [],
      upstreams: Object.fromEntries(reads.map((r) => [r.root, r.reads])),
      counts: { network: { update: 1 } },
      waves: [
        { number: 1, roots: ["network"], set_digest: "jcs1-sha256:1111" },
        { number: 2, roots: ["cluster-a", "cluster-b"], set_digest: "jcs1-sha256:2222" },
        { number: 3, roots: apps, set_digest: "jcs1-sha256:3333" },
      ],
      // Every root's plan changes: the network change reaches them all.
      blast: { roots: all, downstream: [] },
    };
    const m = componentMarks({ ...base, pull_request: pr }, null, facets, { story: { kiosk: true } });
    expect(m.reach).toMatchObject({ tone: "plan", roots: ["network"], label: "reaches 9 roots" });
    expect(m.cards.network.facts).toContain("plans 1 update");
    // A later pull request of the cycle (the fix): what landed before reads applied earlier.
    const fix = { ...pr, roots: ["cluster-a", ...apps.slice(0, 3)], waves: [{ number: 2, roots: ["cluster-a"], set_digest: "x" }, { number: 3, roots: apps.slice(0, 3), set_digest: "y" }], blast: { roots: ["cluster-a", ...apps.slice(0, 3)], downstream: [] } };
    const f = componentMarks({ ...base, pull_request: fix }, null, facets, { story: { kiosk: true, earlier: new Set(["network", "cluster-b", "app-04"]) } });
    expect(f.cards.network).toMatchObject({ state: "applied-earlier", words: "applied earlier", tone: "ok" });
    expect(f.reach).toMatchObject({ label: "the fix reaches 4", roots: ["cluster-a"] });
  });

  it("has no reach without a story, and none once the apply runs without a failure", () => {
    expect(tgReachOf({ a: { root: "a", state: "applying" } }, { stage: "apply" })).toBe(null);
  });
});

describe("the paced run view (behold#741)", () => {
  it("shows a run first seen as it stands, then each wave's change at the pace", () => {
    let t = 0;
    const pacer = createProgressPacer({ now: () => t, pace: { apply: 3000, done: 1500, catchApply: 1200, catchDone: 600 } });
    const p0 = { ...progress("not-started", "not-started"), watching: true };
    p0.states[0].state = "applying";
    expect(pacer.progress(p0)).toBe(p0);
    // One read later wave 1 applied and wave 2 failed: wave 1 settles once it showed applying long enough.
    const p1 = { ...progress("failed", "not-started"), watching: true };
    t = 500;
    expect(trackWaves(pacer.progress(p1)).map((w) => w.state)).toEqual(["running", "waiting", "waiting"]);
    expect(pacer.pending).toBe(true);
    t = 3000;
    expect(trackWaves(pacer.progress(p1)).map((w) => w.state)).toEqual(["applied", "waiting", "waiting"]);
    t = 4600;
    expect(trackWaves(pacer.progress(p1)).map((w) => w.state)).toEqual(["applied", "running", "waiting"]);
    t = 7700;
    expect(trackWaves(pacer.progress(p1)).map((w) => w.state)).toEqual(["applied", "failed", "waiting"]);
    expect(pacer.pending).toBe(false);
  });
});
