// #284 item 2: the pure half of web/run-playhead.js, tested the way
// web/carve-steps.js (#254), web/json-view.js (#259) and web/layout-store.js
// (#245) are — no DOM, no jsdom, no browser. Everything the panel DECIDES
// (what the run's verdict is, how long a gate has been waiting, what the
// approve button POSTs) is a function from data to data; the DOM half is
// smoke/ui-smoke.mjs's job.
import { describe, it, expect } from "vitest";
import { runVerdict, stepRows, gateCardFrom, hasPlayhead, took, waitingFor, stepTook, sourceLabel, pointLine, applyChipText, waitingLine } from "./run-playhead.js";

const base = {
  op: "playhead-probe",
  mode: "temporal",
  status: "running",
  steps: [],
  gate: null,
  gateNote: null,
  startedAt: "2026-08-29T18:00:00.000Z",
  endedAt: null,
  lost: null,
};
const withRecords = (n) => ({
  ...base,
  steps: Array.from({ length: n }, (_, i) => ({ component: null, phase: "P", step: `f${i}`, state: "ok", durationMs: 1000 })),
});

describe("took", () => {
  it("reads sub-second in ms and the rest in seconds", () => {
    expect(took(5)).toBe("5ms");
    expect(took(1062)).toBe("1.1s");
  });
});

describe("waitingFor", () => {
  const now = Date.parse("2026-08-29T18:30:00.000Z");
  it("coarsens the wait, keeping the raw instant for the card", () => {
    expect(waitingFor("2026-08-29T18:29:30.000Z", now)).toBe("30s");
    expect(waitingFor("2026-08-29T18:00:00.000Z", now)).toBe("30m");
    expect(waitingFor("2026-08-29T15:00:00.000Z", now)).toBe("3h");
    expect(waitingFor("2026-08-26T18:00:00.000Z", now)).toBe("3d");
  });

  it("answers nothing rather than a wrong duration for an unreadable instant", () => {
    expect(waitingFor("soon", now)).toBeNull();
    expect(waitingFor("", now)).toBeNull();
  });
});

describe("runVerdict", () => {
  it("has nothing to say before anything has run", () => {
    expect(runVerdict(null)).toBeNull();
    expect(runVerdict({ op: null, status: "idle", steps: [] })).toBeNull();
  });

  it("never calls a lost stream finished", () => {
    const v = runVerdict({ ...withRecords(3), status: "lost", lost: "the stream ended" });
    expect(v.tone).toBe("lost");
    expect(v.text).toContain("frozen at 3 steps settled");
    expect(v.text).not.toMatch(/complete|finished|done/i);
  });

  it("distinguishes a clean exit from a failed step", () => {
    expect(runVerdict({ ...withRecords(2), status: "ok" })).toMatchObject({ tone: "ok" });
    expect(runVerdict({ ...withRecords(2), status: "failed" }).text).toContain("a step failed");
  });

  it("counts settled steps while a local run streams them, not the one running (#679)", () => {
    const run = { ...withRecords(1), steps: [...withRecords(1).steps, { component: null, phase: "P", step: "g", state: "running" }] };
    expect(runVerdict(run).text).toContain("running, 1 step settled");
    expect(runVerdict({ ...run, following: true }).text).toContain("running (followed)");
  });

  it("says a run waiting on a decision point waits on a person, not that it failed (#679)", () => {
    const v = runVerdict({ ...withRecords(1), status: "waiting" });
    expect(v.text).toContain("waiting on a decision point");
    expect(v.tone).toBe("waiting");
  });

  it("says a gated run stopped at its gate and runs again after approval (#459)", () => {
    const v = runVerdict({ ...withRecords(1), status: "gated" });
    expect(v.text).toContain("stopped at a gate");
    expect(v.text).toContain("run the Op again");
    expect(v.text).not.toMatch(/lost|failed/);
  });

  it("doesn't claim to have watched a run it didn't start", () => {
    const v = runVerdict({ ...base, status: "idle" });
    expect(v.text).toContain("this session didn't start the run");
    expect(v.text).not.toContain("0 steps");
  });
});

describe("stepRows", () => {
  it("keeps arrival order and labels a skip as a skip, not a duration", () => {
    const rows = stepRows({
      steps: [
        { component: null, phase: "Build", step: "chantBuild", state: "ok", durationMs: 1062 },
        { component: null, phase: "Verify", step: "httpCheck", state: "failed", durationMs: 15164, error: "fetch failed" },
        { component: null, phase: "Never", step: "httpCheck", state: "skipped", durationMs: 0 },
      ],
    });
    expect(rows.map((r) => `${r.label} ${r.took}`)).toEqual([
      "Build · chantBuild 1.1s",
      "Verify · httpCheck 15.2s",
      "Never · httpCheck skipped",
    ]);
    expect(rows[1].error).toBe("fetch failed");
    expect(rows[0].error).toBeNull();
  });

  it("survives a state with no records at all", () => {
    expect(stepRows(null)).toEqual([]);
    expect(stepRows({})).toEqual([]);
  });
});

describe("gateCardFrom", () => {
  it("is null unless a gate was actually NAMED — a stalled track is not a gate", () => {
    expect(gateCardFrom(base)).toBeNull();
    expect(gateCardFrom({ ...base, gateNote: "no run" })).toBeNull();
  });

  it("points approve at the existing delegated op-signal route", () => {
    const card = gateCardFrom({
      ...base,
      op: "prod-promote",
      gate: { signalName: "approve-promote", description: "Approve the prod promotion", since: "2026-08-29T18:00:12.000Z" },
    });
    expect(card).toEqual({
      op: "prod-promote",
      signalName: "approve-promote",
      description: "Approve the prod promotion",
      since: "2026-08-29T18:00:12.000Z",
      approve: { method: "POST", path: "/api/ops/prod-promote/signal/approve-promote" },
    });
  });

  it("escapes names into the signal path", () => {
    const card = gateCardFrom({ ...base, op: "a b", gate: { signalName: "c/d", since: "x" } });
    expect(card.approve.path).toBe("/api/ops/a%20b/signal/c%2Fd");
  });
});

describe("hasPlayhead", () => {
  it("is false on a fresh session and true once an Op is being watched", () => {
    expect(hasPlayhead(null)).toBe(false);
    expect(hasPlayhead({ op: null, steps: [] })).toBe(false);
    expect(hasPlayhead(base)).toBe(true);
  });
});

// #679: every state chant's run events report, as it happens.
describe("stepTook", () => {
  it("reads each state chant reports, and says why a step skipped", () => {
    expect(stepTook({ state: "running" })).toBe("running");
    expect(stepTook({ state: "ok", durationMs: 6 })).toBe("6ms");
    expect(stepTook({ state: "skipped", skip: "receipt" })).toBe("skipped: already applied (receipt)");
    expect(stepTook({ state: "skipped", skip: "not-run" })).toBe("skipped: not run: an earlier step stopped the run (not-run)");
    expect(stepTook({ state: "skipped", skip: null })).toBe("skipped");
    expect(stepTook({ state: "cached", durationMs: 3 })).toBe("cached");
    expect(stepTook({ state: "gated", durationMs: 680 })).toBe("gated");
    expect(stepTook({ state: "waiting" })).toBe("waiting");
    // The older stream's component steps carry no timing.
    expect(stepTook({ state: "ok", durationMs: null })).toBe("ok");
  });

  it("names the component and who approved a gate on a row", () => {
    const [row] = stepRows({ steps: [{ component: "db", phase: "Apply", step: "gate:approve-db", state: "ok", durationMs: 40, approvedBy: "alex" }] });
    expect(row.label).toBe("db · Apply · gate:approve-db");
    expect(row.approvedBy).toBe("alex");
  });
});

describe("sourceLabel", () => {
  it("labels the classifier path best-effort, and a degraded run with the server's reason", () => {
    expect(sourceLabel("classifier").text).toMatch(/^best-effort: chant did not run this pipeline/);
    expect(sourceLabel("classifier").text).toContain("only the exit code is certain");
    expect(sourceLabel("progress", "degraded: this project's chant (0.124.24) is older than 0.124.28").text).toContain("0.124.24");
    expect(sourceLabel("progress").text).toMatch(/^degraded/);
    expect(sourceLabel("events").text).toBe("from chant's run events");
    expect(sourceLabel("forge").text).toContain("forge");
    expect(sourceLabel(undefined)).toBeNull();
    expect(sourceLabel(null, "a steward run keeps no events on this host").text).toContain("steward");
  });
});

describe("pointLine", () => {
  it("names a decision point and the command that answers it", () => {
    expect(pointLine({ point: { id: "pt-1", since: "2026-10-17T04:24:48.329Z" } })).toBe(
      "waiting on decision point pt-1 since 2026-10-17T04:24:48.329Z; answer it with chant workspace points answer pt-1",
    );
    expect(pointLine({ point: null })).toBeNull();
  });
});

describe("applyChipText", () => {
  it("shows the step a component is on and how it stands, as it happens", () => {
    expect(applyChipText("loom-db", { status: "running", phase: "Apply", step: "cfn-deploy", stepState: "running" })).toBe("loom-db · Apply · cfn-deploy (running)");
    expect(applyChipText("sf", { status: "ok", phase: "Apply", step: "cfn-deploy", stepState: "skipped", skip: "receipt" })).toBe("sf · Apply · cfn-deploy skipped: already applied (receipt) (ok)");
    expect(applyChipText("sf", { status: "running", phase: "Apply", step: "cfn-outputs", stepState: "cached" })).toBe("sf · Apply · cfn-outputs cached (running)");
    expect(applyChipText("db", { status: "gated", phase: "Apply", step: "gate:approve-db", stepState: "gated" })).toBe("db · Apply · gate:approve-db (gated)");
    expect(applyChipText("db", { status: "pending" })).toBe("db (pending)");
  });
});

describe("waitingLine", () => {
  it("names the gate or decision point a component run waits on", () => {
    expect(waitingLine({ gate: "approve-db", point: null, component: "loom-db", since: "t" })).toBe("waiting on gate approve-db (loom-db) since t");
    expect(waitingLine({ gate: null, point: "pt-1", component: null, since: "t", message: "which region?" })).toBe("waiting on decision point pt-1 since t: which region?");
    expect(waitingLine(null)).toBeNull();
  });
});
