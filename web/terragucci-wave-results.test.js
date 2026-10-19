// behold#751: a terragucci wave's result is worded from its own report, not
// its Forgejo job's status. terragucci ends the job of a wave that applied
// what it planned and blocked the rest as a failure (terragucci#1161), so the
// commit status isn't green while roots are unapplied. On the fan-out kiosks
// that read "wave 3 failed" in the fix chapter, where cluster-a broke in wave
// 2 and wave 3 applied cluster-b's six apps and blocked cluster-a's six.
//
// The reports and runs are a real fan-out-choudoufu cycle's
// (src/__fixtures__/terragucci-wave-results: run 6745, the change's merge,
// and 6748, the fix's), read the way /api/terragucci reads them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { readTerragucci } from "../src/terragucci-reports.ts";
import { terragucciSource } from "../src/terragucci-source.ts";
import { cycleFacts, ehSnapshot, storyTrail } from "./kiosk-event-help.js";
import { componentMarks, reportStatus } from "./terragucci-components-live.js";
import { blockedOf, outcomesOf, resultWords, rootStates, waveResultOf } from "./terragucci-change.js";

const FIXTURE = join(import.meta.dirname, "..", "src", "__fixtures__", "terragucci-wave-results");
const CHANGE = "2a615596a4f0ed954bdcaa83f77e575eaf2cb5ab";
const FIX = "5cfbdb79c7a45d4b4d80e4c8e2a200afcc9c225e";
const FIX_PR = "57fcc6ed000000000000000000000000000000aa";
const APPS_A = ["app-01", "app-02", "app-03", "app-04", "app-05", "app-06"];
const APPS_B = ["app-07", "app-08", "app-09", "app-10", "app-11", "app-12"];
const run6745 = JSON.parse(readFileSync(join(FIXTURE, "run-6745.json"), "utf8"));
const run6748 = JSON.parse(readFileSync(join(FIXTURE, "run-6748.json"), "utf8"));
// The fix's pull request's plan run: its apply jobs skipped.
const run6746 = { schema: "demo.run/v1", id: 6746, commit: FIX_PR, cycle: 605, pull: 56, status: "success", jobs: [1, 2, 3].map((n) => ({ name: `apply-wave-${n}`, status: "skipped", steps: [] })) };
const waves = [
  { job: "apply-wave-1", wave: 1, roots: ["network"] },
  { job: "apply-wave-2", wave: 2, roots: ["cluster-a", "cluster-b"] },
  { job: "apply-wave-3", wave: 3, roots: [...APPS_A, ...APPS_B] },
];
const demo = (step, more = {}) => ({ cycle: 605, scenario: "fan-out-choudoufu", step, label: "", started_at: "2026-10-19T01:57:00Z", pull: 55, commit: CHANGE, ...more });
// The run views as terragucci wrote them: the change's (wave 2 failed, wave 3 applied) and the fix's.
const runView = (commit, updated, states) => ({ run: { present: true, commit, updated }, states: states.map(([number, state, roots]) => ({ number, state, roots, changed: roots, totals: {} })), reads: [] });
const changeView = runView(CHANGE, "2026-10-19T01:58:52.600Z", [[1, "applied", ["network"]], [2, "failed", ["cluster-a", "cluster-b"]], [3, "applied", [...APPS_A, ...APPS_B]]]);
const fixView = runView(FIX, "2026-10-19T02:01:47.800Z", [[1, "applied", ["network"]], [2, "applied", ["cluster-a", "cluster-b"]], [3, "applied", [...APPS_A, ...APPS_B]]]);

let answer;
let read;
beforeAll(async () => {
  const structural = { validation: { by: "structural" }, check: (_n, doc) => (doc && typeof doc === "object" ? undefined : "not an object") };
  const r = await readTerragucci(terragucciSource(FIXTURE), { validator: structural });
  answer = { roots: [], pull_request: null, results: r.results };
  read = r;
});

const facts = (snap) => cycleFacts(ehSnapshot({ waves, ...snap }));
const byId = (fs, tail) => fs.find((f) => f.id.endsWith(tail));
const failedWaves = (fs) => fs.filter((f) => f.kind === "failed").map((f) => f.subjects.wave);

describe("a wave's result from its report (behold#751)", () => {
  it("words run 6745's wave 3 as its report does, and its wave 2 as failed", () => {
    expect(resultWords(waveResultOf(answer, CHANGE, 3))).toBe("applied 6, 6 blocked by cluster-a");
    expect(resultWords(waveResultOf(answer, CHANGE.slice(0, 8), 2))).toBe("1 failed, 1 applied");
    expect(resultWords(waveResultOf(answer, FIX, 3))).toBe("applied");
    // A report finished before the job started is an earlier run's: the job's status speaks.
    expect(waveResultOf(answer, CHANGE, 3, { after: "2026-10-19T02:30:00Z" })).toBeNull();
    expect(waveResultOf(answer, CHANGE, 3, { after: run6745.jobs.find((j) => j.name === "apply-wave-3").started_at })).not.toBeNull();
    expect(waveResultOf({ roots: [] }, CHANGE, 3)).toBeNull();
  });
});

describe("event-help: the failure chapter and the fix chapter (behold#751)", () => {
  it("in the failure chapter, wave 2 failed and wave 3 applied 6 with 6 blocked, never 'wave 3 failed'", () => {
    const fs = facts({ demo: demo("failed"), answer, progress: changeView, runDoc: run6745, runDocs: [run6745] });
    expect(failedWaves(fs)).toEqual([2]);
    expect(byId(fs, "|w2|failed")).toMatchObject({ text: "wave 2 failed", critical: true });
    expect(byId(fs, "|w3|blocked")).toMatchObject({ kind: "blocked", text: "wave 3 applied 6, 6 blocked by cluster-a", critical: false, subjects: { wave: 3, job: "apply-wave-3", run: 6745 } });
    // The run view's "wave 3 applied" is the blocked fact's to say, with what it held back.
    expect(byId(fs, "|w3|applied")).toBeUndefined();
    expect(storyTrail(fs).map((f) => f.text)).toEqual(expect.arrayContaining(["wave 2 failed", "wave 3 applied 6, 6 blocked by cluster-a"]));
  });

  it("in the fix chapter, the pill and trail say the same of the change's run, now an earlier one", () => {
    const fs = facts({ demo: demo("planned", { pull: 56, commit: FIX_PR }), answer, progress: changeView, runDoc: run6746, runDocs: [run6745, run6746] });
    expect(failedWaves(fs)).toEqual([2]);
    expect(fs.some((f) => f.text === "wave 3 failed")).toBe(false);
    expect(byId(fs, "|w3|blocked")).toMatchObject({ text: "wave 3 applied 6, 6 blocked by cluster-a", subjects: { wave: 3, job: "apply-wave-3", run: 6745 } });
  });

  it("in the fix's apply, wave 3 runs again and applies", () => {
    const fs = facts({ demo: demo("applied", { pull: 56, commit: FIX }), answer, progress: fixView, runDoc: run6748, runDocs: [run6745, run6746, run6748] });
    expect(fs.some((f) => f.text === "wave 3 failed")).toBe(false);
    expect(byId(fs, "|w3|rerun")).toMatchObject({ text: "wave 3 runs again" });
    expect(byId(fs, "|w3|applied")).toMatchObject({ text: "wave 3 applied" });
  });

  it("falls back to the job's status where no report of the wave is read", () => {
    const fs = facts({ demo: demo("failed"), answer: { roots: [] }, progress: changeView, runDoc: run6745, runDocs: [run6745] });
    expect(failedWaves(fs)).toEqual([2, 3]);
    const later = facts({ demo: demo("planned", { pull: 56, commit: FIX_PR }), answer: { roots: [] }, progress: changeView, runDoc: run6746, runDocs: [run6745, run6746] });
    expect(failedWaves(later)).toEqual([2, 3]);
  });
});

describe("the wave box's title (behold#751)", () => {
  const facets = {
    jobs: [
      { component: "network", jobName: "apply-wave-1", wave: 1 },
      { component: "cluster-a", jobName: "apply-wave-2", wave: 2 },
      { component: "cluster-b", jobName: "apply-wave-2", wave: 2 },
      ...[...APPS_A, ...APPS_B].map((c) => ({ component: c, jobName: "apply-wave-3", wave: 3 })),
    ],
  };
  const runs = { doc: { runs: [{ id: 6745, commit: CHANGE, jobs: run6745.jobs.map(({ name, status }) => ({ name, status })) }] } };

  it("says wave 3 applied 6 with 6 blocked, and wave 2 failed, on run 6745", () => {
    const m = componentMarks(answer, changeView, facets, { runs });
    expect(m.waves[3].title).toBe("apply-wave-3 · applied 6, 6 blocked by cluster-a");
    expect(m.waves[3].tone).toBe("wait");
    expect(m.waves[2].title).toBe("apply-wave-2 · failed");
    expect(m.waves[2].tone).toBe("bad");
    expect(m.waves[1].title).toBe("apply-wave-1 · succeeded");
  });

  it("keeps the job's status with no report of the wave, and for any job that did not fail", () => {
    expect(componentMarks({ roots: [] }, changeView, facets, { runs }).waves[3].title).toBe("apply-wave-3 · failed");
    const ok = { status: "success", words: "succeeded", tone: "ok", run: 6748 };
    expect(reportStatus(ok, waveResultOf(answer, CHANGE, 3))).toBe(ok);
    const failed = { status: "failure", words: "failed", tone: "bad", run: 6745 };
    expect(reportStatus(failed, waveResultOf(answer, CHANGE, 2))).toBe(failed);
    expect(reportStatus(failed, null)).toBe(failed);
  });
});

// behold#770: a tool page's replay of the cycle (kiosk-vendor.js) pins the
// change's run view (wave 2 failed) after the fix applied, so /api/terragucci's
// `outcomes` and `blocked` are the fix's, the newest apply's. The replay read
// cluster-b "failed" and wave 2 "2 failed" from the wave's state, where live it
// read cluster-b applied beside a failed cluster-a. The change's own reports,
// in `results`, say how each root came out.
describe("the replay of the failure, after the fix applied (behold#770)", () => {
  const facets = {
    jobs: [
      { component: "network", jobName: "apply-wave-1", wave: 1 },
      { component: "cluster-a", jobName: "apply-wave-2", wave: 2 },
      { component: "cluster-b", jobName: "apply-wave-2", wave: 2 },
      ...[...APPS_A, ...APPS_B].map((c) => ({ component: c, jobName: "apply-wave-3", wave: 3 })),
    ],
  };
  // /api/terragucci as it answers after the fix's apply: its outcomes are the fix's, and nothing of it is blocked.
  const replayAnswer = () => ({ roots: [], pull_request: null, ...(read.outcomes ? { outcomes: read.outcomes } : {}), ...(read.blocked ? { blocked: read.blocked } : {}), results: read.results });
  const runs = { doc: { runs: [{ id: 6745, commit: CHANGE, jobs: run6745.jobs.map(({ name, status }) => ({ name, status })) }] } };

  it("is the fixture's case: the read's outcomes are the fix's, not the change's", () => {
    expect(read.outcomes.commit).toBe(FIX);
    expect(read.blocked).toBeUndefined();
    expect(Object.keys(read.results)).toEqual(expect.arrayContaining([CHANGE, FIX]));
  });

  it("reads each root of the change's run from the change's own reports", () => {
    const o = outcomesOf(replayAnswer(), changeView);
    expect(o.get("cluster-a")).toMatchObject({ wave: 2, outcome: "failed" });
    expect(o.get("cluster-a").error).toMatch(/QueueAlreadyExists/);
    expect(o.get("cluster-b")).toEqual({ wave: 2, outcome: "applied" });
    expect([...blockedOf(replayAnswer(), changeView).keys()].sort()).toEqual(APPS_A);
    expect(blockedOf(replayAnswer(), changeView).get("app-01")).toEqual({ wave: 3, by: "cluster-a" });
  });

  it("draws cluster-a failed, cluster-b applied, cluster-a's apps blocked and cluster-b's applied", () => {
    const m = componentMarks(replayAnswer(), changeView, facets, { runs, story: { kiosk: true } });
    expect(m.cards["cluster-a"]).toMatchObject({ state: "failed", tone: "bad" });
    expect(m.cards["cluster-b"]).toMatchObject({ state: "applied", tone: "ok", words: "applied" });
    for (const a of APPS_A) expect(m.cards[a]).toMatchObject({ state: "blocked", blockedBy: "cluster-a" });
    for (const a of APPS_B) expect(m.cards[a]).toMatchObject({ state: "applied" });
    expect(m.waves[2].status).toMatchObject({ status: "failed", words: "1 failed, 1 applied", tone: "bad" });
    expect(m.waves[3].title).toBe("apply-wave-3 · 6 applied, 6 blocked by cluster-a");
  });

  it("holds a wave the paced replay hasn't started, and falls back to the wave's state for a commit the read kept no result of", () => {
    const paced = { ...changeView, states: changeView.states.map((w) => (w.number === 3 ? { ...w, state: "not-started" } : w)) };
    expect(blockedOf(replayAnswer(), paced).size).toBe(0);
    expect(outcomesOf(replayAnswer(), paced).has("app-07")).toBe(false);
    const gone = { ...replayAnswer(), results: { [FIX]: read.results[FIX] } };
    expect(rootStates(gone, changeView, { story: true }).roots["cluster-b"].state).toBe("failed");
  });
});
