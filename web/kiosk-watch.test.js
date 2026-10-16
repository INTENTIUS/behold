// behold#571: Watch mode, as words and places. No DOM: which shot each step
// takes, what the caption leads with, the badges, the delivery line, the
// result card, the drawer's folded lines, and where an overlay goes.
import { describe, expect, it } from "vitest";
import { MODE_STORE, activeWave, badgeTitle, badgeWords, badges, captionModel, changeRoots, doraLine, modeStored, placeBeside, resultModel, shotFor, stepTone, tailLines } from "./kiosk-watch.js";

const C = "9f3c2a71d04e5b8c6a1f2e3d4c5b6a7980716253";
const P = "1111111111111111111111111111111111111111";
const demo = (step, more = {}) => ({
  cycle: 12,
  scenario: "a-known",
  title: "A new subnet, approved once its id exists",
  index: 1,
  scenarios: 4,
  step,
  label: `the ${step} line`,
  started_at: "2026-10-16T10:00:00Z",
  next: { action: "approve wave-2", at: "2026-10-16T10:02:00Z" },
  pull: 7,
  commit: step === "pull-request" || step === "planned" ? P : C,
  about: { changes: "A pull request adds a subnet to network.", watch: "Wave 1 builds it.", shows: "Values made during the apply." },
  intro: "Big Terraform setups split what they build across many states.",
  ...more,
});
const answer = {
  roots: [{ path: "network" }, { path: "app" }, { path: "edge" }, { path: "other" }],
  pull_request: {
    run: { pull_request: 7, commit: P },
    roots: ["network", "app"],
    reads: [{ root: "app", upstream: "network", outputs: "planned", unknown: ["subnet_id"] }, { root: "edge", upstream: "app", outputs: "applied", unknown: [] }],
    waves: [],
  },
};
const progress = (states) => ({ run: { present: true, commit: C, updated: "2026-10-16T10:01:00Z" }, states, reads: [] });
const st = (number, state, roots, totals = {}) => ({ number, state, roots, changed: roots, totals });

describe("kiosk watch: the mode", () => {
  it("is Watch until a viewer picks Inspect, and Watch when storage refuses", () => {
    const shelf = (v) => ({ getItem: (k) => (k === MODE_STORE ? v : null) });
    expect(modeStored(shelf(null))).toBe("watch");
    expect(modeStored(shelf("inspect"))).toBe("inspect");
    expect(modeStored(shelf("watch"))).toBe("watch");
    expect(modeStored({ getItem: () => { throw new Error("denied"); } })).toBe("watch");
    expect(modeStored(null)).toBe("watch");
  });
});

describe("kiosk watch: the shot each step takes", () => {
  it("frames the pull request's changing roots and the roots their reads join, before the merge", () => {
    const shot = shotFor(demo("planned"), { answer });
    expect(shot.kind).toBe("change");
    expect(shot.roots.sort()).toEqual(["app", "edge", "network"]);
    expect(changeRoots(demo("pull-request"), answer, null).sort()).toEqual(["app", "edge", "network"]);
  });

  it("frames the held wave while it waits, the active wave while it applies, and the whole graph at the end", () => {
    const p = progress([st(1, "applied", ["network"]), st(2, "waiting", ["app"]), st(3, "not-started", ["edge"])]);
    expect(shotFor(demo("waiting"), { progress: p, held: 2 })).toMatchObject({ kind: "held", waves: [2], whole: false });
    const applying = progress([st(1, "applying", ["network"]), st(2, "not-started", ["app"])]);
    expect(shotFor(demo("applying"), { progress: applying })).toMatchObject({ kind: "active", waves: [1] });
    expect(shotFor(demo("failed"), { progress: progress([st(1, "applied", ["network"]), st(2, "failed", ["app"])]) })).toMatchObject({ kind: "active", waves: [2] });
    expect(shotFor(demo("applied"), { progress: p })).toMatchObject({ kind: "result", whole: true });
    expect(shotFor(demo("reset"))).toMatchObject({ kind: "intro", whole: true });
    expect(shotFor(demo("merged"), { progress: p })).toMatchObject({ kind: "whole", whole: true });
    // One gate for the whole change (chant's pull-request loop): the whole graph, the callout beside it.
    expect(shotFor(demo("waiting"), { gate: true })).toMatchObject({ kind: "held", waves: [], whole: true });
  });

  it("keeps its id while the step and what it frames stay, so the frame moves only when they change", () => {
    const p = progress([st(1, "applying", ["network"])]);
    expect(shotFor(demo("applying"), { progress: p }).id).toBe(shotFor(demo("applying"), { progress: p }).id);
    expect(shotFor(demo("applying"), { progress: p }).id).not.toBe(shotFor(demo("applying"), { progress: progress([st(1, "applied", ["network"]), st(2, "applying", ["app"])]) }).id);
  });

  it("before the run view has the cycle's run, finds the active wave by the pipeline's running job", () => {
    const runDoc = { jobs: [{ name: "check", status: "success" }, { name: "apply-wave-1", status: "success" }, { name: "apply-wave-2", status: "running" }] };
    const waves = [{ job: "apply-wave-1", wave: 1 }, { job: "apply-wave-2", wave: 2 }];
    expect(activeWave(demo("applying"), null, { runDoc, waves })).toBe(2);
    expect(shotFor(demo("applying"), { runDoc, waves })).toMatchObject({ kind: "active", waves: [2] });
    expect(activeWave(demo("applying"), null, {})).toBeNull();
    expect(shotFor(demo("applying"))).toMatchObject({ kind: "whole" });
  });
});

describe("kiosk watch: the caption", () => {
  it("leads with what changes before the merge, and with the step after it", () => {
    const now = new Date("2026-10-16T10:01:30Z");
    const pr = captionModel(demo("pull-request"), { now });
    expect(pr).toMatchObject({ kicker: "Scenario 1 of 4", title: "A new subnet, approved once its id exists", lead: "changes", changes: { label: "What changes", text: "A pull request adds a subnet to network." } });
    expect(pr.step).toMatchObject({ word: "pull request open", text: "the pull-request line", tone: "busy" });
    expect(pr.next).toEqual({ action: "approve wave-2", when: "in 30 s" });
    expect(captionModel(demo("waiting"), { now })).toMatchObject({ lead: "step", step: { word: "waiting for an approval", tone: "wait" } });
  });

  it("gives the intro in place of what changes between scenarios", () => {
    const c = captionModel(demo("reset"));
    expect(c.changes).toBeNull();
    expect(c.intro).toEqual({ label: "What this demo is about", text: "Big Terraform setups split what they build across many states." });
    expect(captionModel(null)).toBeNull();
  });

  it("tones each step as the strip and the boxes do", () => {
    expect(["waiting", "failed", "stalled", "applied", "reset", "applying"].map(stepTone)).toEqual(["wait", "bad", "bad", "ok", "idle", "busy"]);
  });
});

describe("kiosk watch: the numbers", () => {
  const metrics = {
    run: {
      current: true,
      waves: [
        { wave: 1, seconds: "1.6 s", held: null, changed: "1 updated", secondsRaw: 1.6, heldRaw: null, changesRaw: { update: 1 } },
        { wave: 2, seconds: "9.5 s", held: "25 s", changed: "4 created", secondsRaw: 9.5, heldRaw: 25, changesRaw: { create: 4 } },
      ],
    },
    dora: [["Deploys", "19488.7 a week"], ["Lead time", "1 min 56 s"], ["Change failure rate", "1%"], ["Time to restore", "1 min 12 s"]],
  };

  it("puts each wave's time, hold and changes on its badge, and none from an older run", () => {
    expect(badges(metrics)).toEqual({ 1: "1.6 s · 1 updated", 2: "9.5 s · held 25 s · 4 created" });
    expect(badges({ ...metrics, run: { ...metrics.run, current: false } })).toEqual({});
    expect(badges(null)).toEqual({});
    expect(badgeWords({ seconds: null, held: null, changed: null })).toBeNull();
    expect(badgeTitle("1.6 s")).toBe("Pipeline metrics · 1.6 s");
  });

  it("says the delivery numbers on one line, a large rate rounded", () => {
    expect(doraLine(metrics)).toBe("19,489 deploys a week · lead time 1 min 56 s · change failure rate 1% · time to restore 1 min 12 s");
    expect(doraLine({ dora: [["Deploys", "4.5 a week"]] })).toBe("4.5 deploys a week");
    expect(doraLine({ dora: null })).toBeNull();
  });

  it("sums the run on the result card: the step's line, the waves and changes from the run view, the time and the hold from the metrics, each wave's numbers", () => {
    const p = progress([st(1, "applied", ["network"], { update: 1, "no-op": 2 }), st(2, "applied", ["app"], { create: 4 })]);
    expect(resultModel(demo("applied"), metrics, p)).toEqual({
      head: "Applied",
      line: "the applied line",
      counts: ["2 waves applied", "4 created, 1 updated", "11 s of job time", "25 s held for an approval"],
      waves: [{ wave: 1, words: "1.6 s · 1 updated" }, { wave: 2, words: "9.5 s · held 25 s · 4 created" }],
    });
    // Metrics that cover fewer waves than applied say nothing of the time.
    const three = progress([...p.states, st(3, "applied", ["edge"], {})]);
    expect(resultModel(demo("applied"), metrics, three).counts).toEqual(["3 waves applied", "4 created, 1 updated"]);
    expect(resultModel(demo("applying"), metrics, p)).toBeNull();
    expect(resultModel(demo("applied"), null, null)).toBeNull();
  });
});

describe("kiosk watch: the drawer's folded lines", () => {
  it("shows the running job and the last lines its running step wrote, set-up lines and node's warnings left out", () => {
    const runDoc = {
      jobs: [
        { name: "check", status: "success", steps: [{ name: "Set up job", status: "success", log: ["x"] }] },
        {
          name: "apply-wave-2",
          status: "running",
          steps: [
            { name: "Set up job", status: "success", log: ["runner"] },
            { name: "Apply wave 2 of 3", status: "running", log: ["wave 2 of 3: planning app", "", "app: Plan: 4 to add", "(node:41) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.", "wave 2 of 3: apply", "(Use `node --trace-deprecation ...` to show where the warning was created)"] },
          ],
        },
      ],
    };
    expect(tailLines(runDoc)).toEqual({ job: "apply-wave-2", step: "Apply wave 2 of 3", status: "running", lines: ["app: Plan: 4 to add", "wave 2 of 3: apply"] });
    expect(tailLines(null)).toBeNull();
    expect(tailLines({ jobs: [] })).toBeNull();
  });
});

describe("kiosk watch: where an overlay goes", () => {
  const view = { x: 0, y: 0, w: 1600, h: 800 };
  it("goes right of its box when it fits, else left, else below; level with the box's top and inside the view", () => {
    expect(placeBeside({ x: 400, y: 200, w: 300, h: 200 }, { w: 400, h: 300 }, view)).toEqual({ x: 718, y: 200, side: "right" });
    expect(placeBeside({ x: 1000, y: 200, w: 400, h: 200 }, { w: 400, h: 300 }, view)).toEqual({ x: 582, y: 200, side: "left" });
    expect(placeBeside({ x: 100, y: 100, w: 1400, h: 200 }, { w: 400, h: 300 }, view)).toMatchObject({ side: "below", y: 318 });
    // A label of the graph's beside the box: the overlay moves past it.
    expect(placeBeside({ x: 400, y: 200, w: 300, h: 200 }, { w: 400, h: 300 }, view, 18, [{ x: 600, y: 450, w: 200, h: 24 }])).toEqual({ x: 809, y: 200, side: "right" });
    // A box low in the view: the overlay rises to stay in it.
    expect(placeBeside({ x: 400, y: 700, w: 300, h: 80 }, { w: 400, h: 300 }, view).y).toBe(492);
  });
});
