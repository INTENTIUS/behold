import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agoWords, defaultJob, defaultStep, durationWords, jobOrder, liveRun, placeWords, sidebarRuns, splitSkipped, STATUS_TONE, triggerWords } from "./kiosk-runs.js";

const FIX = join(import.meta.dirname, "..", "src", "__fixtures__", "terragucci-demo", "runs");
const run = (id) => JSON.parse(readFileSync(join(FIX, `${id}.json`), "utf8"));
const index = () => JSON.parse(readFileSync(join(FIX, "index.json"), "utf8"));

describe("the runs, as a CI page lists them (#569)", () => {
  it("names what started each run", () => {
    expect(triggerWords({ trigger: "plan", pull: 278 })).toBe("Plan of pull request #278");
    expect(triggerWords({ trigger: "merge", pull: 278 })).toBe("Merge of #278 to main");
    expect(triggerWords({ trigger: "resume", pull: 278 })).toBe("/terragucci apply on #278");
    expect(triggerWords({ trigger: "reset", pull: null })).toBe("Reset to the base");
    expect(triggerWords({ trigger: "base", pull: null })).toBe("The base, pushed");
    expect(triggerWords({ trigger: "push", pull: null, ref: "main" })).toBe("Push to main");
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
