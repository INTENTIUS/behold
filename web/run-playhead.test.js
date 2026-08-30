// #284 item 2: the pure half of web/run-playhead.js, tested the way
// web/carve-steps.js (#254), web/json-view.js (#259) and web/layout-store.js
// (#245) are — no DOM, no jsdom, no browser. Everything the panel DECIDES
// (what the run's verdict is, how long a gate has been waiting, what the
// approve button POSTs) is a function from data to data; the DOM half is
// smoke/ui-smoke.mjs's job.
import { describe, it, expect } from "vitest";
import { runVerdict, stepRows, gateCardFrom, hasPlayhead, took, waitingFor } from "./run-playhead.js";

const base = {
  op: "playhead-probe",
  mode: "temporal",
  status: "running",
  records: [],
  gate: null,
  gateNote: null,
  startedAt: "2026-08-29T18:00:00.000Z",
  endedAt: null,
  lost: null,
};
const withRecords = (n) => ({
  ...base,
  records: Array.from({ length: n }, (_, i) => ({ phase: "P", fn: `f${i}`, status: "ok", durationMs: 1000 })),
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
    expect(runVerdict({ op: null, status: "idle", records: [] })).toBeNull();
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

  it("explains why a local run shows nothing until it ends", () => {
    expect(runVerdict({ ...base, mode: "local" }).text).toContain("steps arrive together when it ends");
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
      records: [
        { phase: "Build", fn: "chantBuild", status: "ok", durationMs: 1062 },
        { phase: "Verify", fn: "httpCheck", status: "fail", durationMs: 15164, error: "fetch failed" },
        { phase: "Never", fn: "httpCheck", status: "skipped", durationMs: 0 },
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
    expect(hasPlayhead({ op: null, records: [] })).toBe(false);
    expect(hasPlayhead(base)).toBe(true);
  });
});
