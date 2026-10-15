import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FOLLOW_LINES, followsLog, logKey, nearEnd, mergeRun, newerOf, agoWords, defaultJob, defaultStep, durationWords, jobOrder, liveRun, placeWords, sidebarRuns, splitSkipped, STATUS_TONE, triggerWords } from "./kiosk-runs.js";

const FIX = join(import.meta.dirname, "..", "src", "__fixtures__", "terragucci-demo", "runs");
const run = (id) => JSON.parse(readFileSync(join(FIX, `${id}.json`), "utf8"));
const index = () => JSON.parse(readFileSync(join(FIX, "index.json"), "utf8"));

describe("the runs, as a CI page lists them (#569)", () => {
  it("names what started each run", () => {
    expect(triggerWords({ trigger: "plan", pull: 278 })).toBe("Plan of pull request #278");
    expect(triggerWords({ trigger: "merge", pull: 278, ref: "main" })).toBe("Merge of #278 to main");
    expect(triggerWords({ trigger: "resume", pull: 278, ref: "main" })).toBe("/terragucci apply on #278");
    expect(triggerWords({ trigger: "reset", pull: null, ref: "main" })).toBe("Reset main to the base");
    expect(triggerWords({ trigger: "base", pull: null, ref: "main" })).toBe("The base, pushed to main");
    expect(triggerWords({ trigger: "push", pull: null, ref: "main" })).toBe("Push to main");
    expect(triggerWords({ trigger: "push", pull: null, ref: "demo-a-known" })).toBe("Push to branch demo-a-known");
  });
  it("never draws a wave held at the gate as a failure", () => {
    expect(STATUS_TONE.waiting).toBe("wait");
    expect(STATUS_TONE.waiting).not.toBe(STATUS_TONE.failure);
  });
  it("follows the newest run still going, pinned first", () => {
    const runs = index().runs;
    expect(liveRun(runs).id).toBe(448);
    expect(liveRun(runs.filter((r) => r.id !== 448)).id).toBe(447); // nothing going: the newest
    // Held at a gate: followed while it is the newest, a recent run once another came after it.
    expect(liveRun([{ id: 8, status: "waiting" }, { id: 7, status: "success" }]).id).toBe(8);
    expect(liveRun([{ id: 9, status: "success" }, { id: 8, status: "waiting" }]).id).toBe(9);
    expect(sidebarRuns([{ id: 9, status: "success" }, { id: 8, status: "running" }]).map((r) => r.id)).toEqual([8, 9]);
    expect(liveRun([])).toBe(null);
  });
  it("orders jobs by their needs and folds the skipped ones", () => {
    const jobs = jobOrder(run(444).jobs);
    const { shown, skipped } = splitSkipped(jobs);
    expect(shown.map((j) => `${j.name}@${j.depth}`)).toEqual(["check@0", "apply-wave-1@1", "apply-wave-2@2"]);
    expect(skipped.map((j) => j.name)).toContain("apply-wave-3");
    expect(jobOrder([{ name: "b", needs: ["a"] }, { name: "a", needs: ["b"] }]).map((j) => j.name).sort()).toEqual(["a", "b"]); // a cycle still lists every job
  });
  it("shows the job that runs, waits or failed, else the one with the most to say", () => {
    expect(defaultJob(run(448).jobs).name).toBe("apply-wave-2");
    expect(defaultJob(run(444).jobs).name).toBe("apply-wave-2");
    expect(defaultJob(run(447).jobs).status).toBe("failure");
    expect(defaultJob(run(443).jobs).name).toBe("plan");
  });
  it("opens the step with the job's own output, not the first one", () => {
    const step = (id, job) => {
      const steps = run(id).jobs.find((j) => j.name === job).steps;
      return steps[defaultStep(steps)];
    };
    expect(step(444, "apply-wave-2")).toMatchObject({ name: "Apply wave 2 of 3", status: "waiting" });
    expect(step(448, "apply-wave-2")).toMatchObject({ name: "Apply wave 2 of 3", status: "running" });
    expect(step(447, "apply-wave-2").status).toBe("failure");
    expect(step(443, "plan").name).toBe("Plan the roots the change reaches and write the plan report");
    expect(step(444, "apply-wave-1").name).toBe("Apply wave 1 of 3");
    expect(defaultStep([])).toBe(-1);
  });
  it("says durations and ages", () => {
    const now = new Date("2026-10-15T04:10:00Z");
    expect(durationWords("2026-10-15T04:09:28Z", "2026-10-15T04:09:45Z", now)).toBe("17 s");
    expect(durationWords("2026-10-15T04:07:55Z", null, now)).toBe("2 m 05 s");
    expect(durationWords(null, null, now)).toBe(null);
    expect(agoWords("2026-10-15T04:09:58Z", now)).toBe("just now");
    expect(agoWords("2026-10-15T04:07:00Z", now)).toBe("3 m ago");
    expect(placeWords({ scenario: "a-output", cycle: 90 }, { "a-output": { name: "A, read through .output" } })).toBe("A, read through .output · cycle 90");
    expect(placeWords({ scenario: null, cycle: null }, {})).toBe("");
  });
});

describe("one run, from the index and its own document (#569)", () => {
  // The host's #528: index.json says running on demo-a-known; the run's own
  // document, written later, says success and carries no ref.
  const entry = { id: 528, trigger: "push", ref: "demo-a-known", status: "running", started_at: "2026-10-15T04:49:19Z", ended_at: null, jobs: [{ id: 1, name: "check", needs: [], status: "running", started_at: "2026-10-15T04:49:19Z", ended_at: null }] };
  const doc = { id: 528, trigger: "push", status: "success", started_at: "2026-10-15T04:49:19Z", ended_at: "2026-10-15T04:49:25Z", jobs: [{ id: 1, name: "check", needs: [], status: "success", started_at: "2026-10-15T04:49:19Z", ended_at: "2026-10-15T04:49:25Z", steps: [{ name: "Set up job", status: "success", log: [] }] }] };
  it("names the run's real ref and takes the newer status", () => {
    const m = mergeRun(entry, doc);
    expect(m.ref).toBe("demo-a-known");
    expect(triggerWords(m)).toBe("Push to branch demo-a-known");
    expect(m.status).toBe("success");
    expect(m.ended_at).toBe("2026-10-15T04:49:25Z");
    expect(m.jobs[0].steps.length).toBe(1);
  });
  it("takes the index's status when the document lags it, keeping the document's steps", () => {
    const lagging = { ...doc, status: "running", ended_at: null, jobs: [{ ...doc.jobs[0], status: "running", ended_at: null }] };
    const ahead = { ...entry, status: "failure", ended_at: "2026-10-15T04:49:30Z", jobs: [{ ...entry.jobs[0], status: "failure", ended_at: "2026-10-15T04:49:30Z" }] };
    const m = mergeRun(ahead, lagging);
    expect(m.status).toBe("failure");
    expect(m.jobs[0]).toMatchObject({ status: "failure", ended_at: "2026-10-15T04:49:30Z" });
    expect(m.jobs[0].steps.length).toBe(1);
  });
  it("never moves a status back, and a held run is ahead of a running one", () => {
    expect(newerOf({ status: "success" }, { status: "running" }).status).toBe("success");
    expect(newerOf({ status: "running" }, { status: "waiting" }).status).toBe("waiting");
    expect(mergeRun(null, doc)).toBe(doc);
    expect(mergeRun(entry, null)).toBe(entry);
  });
});

describe("the log pane follows its end, like a CI page's log", () => {
  const key = logKey(448, "apply-wave-2", 2);
  it("follows a log that just opened: another run, job or step", () => {
    expect(followsLog(null, key, false)).toBe(true);
    expect(followsLog(logKey(447, "apply-wave-2", 2), key, false)).toBe(true);
    expect(followsLog(logKey(448, "apply-wave-1", 2), key, false)).toBe(true);
    expect(followsLog(logKey(448, "apply-wave-2", 1), key, false)).toBe(true);
  });
  it("on the same log, keeps what the viewer chose", () => {
    expect(followsLog(key, key, true)).toBe(true);
    expect(followsLog(key, key, false)).toBe(false);
  });
  it("counts a view within a few lines of the end as at the end", () => {
    const slack = 18 * FOLLOW_LINES;
    expect(nearEnd({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 }, slack)).toBe(true);
    expect(nearEnd({ scrollTop: 600 - slack, clientHeight: 400, scrollHeight: 1000 }, slack)).toBe(true);
    expect(nearEnd({ scrollTop: 600 - slack - 1, clientHeight: 400, scrollHeight: 1000 }, slack)).toBe(false);
    expect(nearEnd({ scrollTop: 0, clientHeight: 400, scrollHeight: 1000 }, slack)).toBe(false);
  });
});
