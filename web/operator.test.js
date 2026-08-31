// #234 joins 3 + 1: the pure half of web/operator.js, tested the way
// web/run-playhead.js (#284) is — no DOM, no jsdom, no browser. Everything the
// strip DECIDES (which loops get a row, how a lease reads, what the approve
// button says it does) is a function from data to data; the DOM half is
// smoke/ui-smoke.mjs's job.
import { describe, it, expect } from "vitest";
import {
  hasOperator,
  operatorRefusal,
  operatorRows,
  leaseText,
  operatorHeadline,
  convergeGates,
  APPROVE_SEMANTICS,
  APPROVED_SEMANTICS,
  CONVERGE_LOOP_LINE,
  ONE_TICK_CAVEAT,
  LEASE_LABEL,
  shortTickId,
  TICK_ID_CHARS,
} from "./operator.js";

/** src/operator.ts's OperatorState, as the server broadcasts it. Values trace to
 * chant's own operator tests — see src/operator.test.ts's provenance note. */
const declared = [{ name: "staging-converge", env: "staging", dial: "apply" }];
const stripRow = {
  op: "staging-converge",
  env: "staging",
  log: "converge(staging): drifted=1 remediated=0 reported=0 skipped-budget=0 skipped-flap=0 gated=1 unobserved=0 adopted=0",
  at: "2026-01-01T00:00:00.000Z",
  lease: "held",
  leaseHolder: "op-a",
  leaseExpiresAt: "2026-01-01T00:05:00.000Z",
  // chant#2027's tick id, as src/operator.ts's `operatorStrip` carries it —
  // whole, for the renderer to truncate.
  tickId: "9f1c7a52-3b64-4d0e-8a71-2e5c6d90b4af",
  pendingGates: 1,
};
const gate = {
  loop: "converge",
  rule: "drift-apply",
  op: "fountain-apply",
  gate: "rollout-gate",
  convergeOp: "staging-converge",
  env: "staging",
  since: "2026-01-01T00:00:00.000Z",
  semantics: APPROVE_SEMANTICS,
  approve: {
    method: "POST",
    path: "/api/operator/approve/fountain-apply/rollout-gate",
    command: "chant approve fountain-apply rollout-gate",
  },
};
const state = {
  declared,
  strip: { rows: [stripRow], pendingGates: 1 },
  gates: [gate],
  note: null,
  code: null,
  readAt: "2026-01-01T00:02:00.000Z",
};
const NOW = Date.parse("2026-01-01T00:02:00.000Z");

describe("hasOperator", () => {
  it("gates the strip on a DECLARED loop, never on a status read having answered", () => {
    expect(hasOperator(null)).toBe(false);
    expect(hasOperator({ declared: [] })).toBe(false);
    // Declared, never read: the strip still appears and says so.
    expect(hasOperator({ declared, strip: null })).toBe(true);
  });
});

describe("operatorRefusal", () => {
  it("is null on a clean read", () => {
    expect(operatorRefusal(state)).toBeNull();
  });

  it("states a refusal plainly for each of the three ways a read can fail", () => {
    for (const code of ["no-operator", "no-operator-cli", "operator-status"]) {
      const r = operatorRefusal({ ...state, strip: null, gates: [], note: `something about ${code}`, code });
      expect(r).toEqual({ code, text: `something about ${code}` });
    }
  });
});

describe("operatorRows", () => {
  it("prints chant's own tick line verbatim, with the instant and a coarse age", () => {
    const [row] = operatorRows(state, NOW);
    expect(row.log).toBe(stripRow.log);
    expect(row.at).toBe("2026-01-01T00:00:00.000Z");
    expect(row.ago).toBe("2m");
  });

  it("keeps a declared loop the last read didn't mention, rather than undercounting", () => {
    const rows = operatorRows({ ...state, declared: [...declared, { name: "prod-observe", env: "prod" }] }, NOW);
    expect(rows.map((r) => r.op)).toEqual(["staging-converge", "prod-observe"]);
    expect(rows[1]).toMatchObject({ log: null, at: null, leaseText: "not in the last status read" });
  });

  it("says a declared loop has not been read yet before the first ask", () => {
    const [row] = operatorRows({ ...state, strip: null, gates: [] }, NOW);
    expect(row.leaseText).toBe("not read yet");
  });

  it("carries the tick id whole and truncated (chant#2027)", () => {
    const [row] = operatorRows(state, NOW);
    expect(row.tickId).toBe("9f1c7a52-3b64-4d0e-8a71-2e5c6d90b4af");
    expect(row.tick).toBe("9f1c7a52");
  });

  it("says nothing about a tick id a pre-0.53.1 chant never wrote", () => {
    // The row must read exactly as it did before the field existed — a
    // placeholder would show an identity that does not exist.
    const older = { ...stripRow, tickId: null };
    const [row] = operatorRows({ ...state, strip: { rows: [older], pendingGates: 1 } }, NOW);
    expect(row.tickId).toBeNull();
    expect(row.tick).toBeNull();
  });

  it("says nothing about a tick id on a loop the last read didn't mention", () => {
    const rows = operatorRows({ ...state, declared: [...declared, { name: "prod-observe", env: "prod" }] }, NOW);
    expect(rows[1]).toMatchObject({ tickId: null, tick: null });
  });
});

describe("shortTickId", () => {
  it("keeps the first block of chant's randomUUID mint", () => {
    expect(shortTickId("9f1c7a52-3b64-4d0e-8a71-2e5c6d90b4af")).toBe("9f1c7a52");
    expect(TICK_ID_CHARS).toBe(8);
  });

  it("shows a shorter id whole rather than padding one chant didn't write", () => {
    expect(shortTickId("tick-fix")).toBe("tick-fix");
    expect(shortTickId("abc")).toBe("abc");
  });

  it("is null in, null out — an absent id is not an id to shorten", () => {
    expect(shortTickId(null)).toBeNull();
    expect(shortTickId(undefined)).toBeNull();
    expect(shortTickId("")).toBeNull();
  });
});

describe("leaseText", () => {
  it("always names the holder — 'held' with nobody named is unactionable", () => {
    expect(leaseText(stripRow)).toBe("lease held by op-a until 2026-01-01T00:05:00.000Z");
  });

  it("says an expired lease will be reclaimed, not that it is free", () => {
    expect(leaseText({ ...stripRow, lease: "expired" })).toMatch(/expired \(op-a until .+\) — the next round reclaims it/);
  });

  it("reads a lease-less row as free", () => {
    expect(leaseText({ ...stripRow, lease: "free", leaseHolder: null })).toBe(LEASE_LABEL.free);
  });
});

describe("operatorHeadline", () => {
  it("counts the loops, and the gates when a human is owed one", () => {
    expect(operatorHeadline(state)).toBe("⟳ operating loop — 1 ConvergeOp · 1 gate pending");
    expect(operatorHeadline({ ...state, gates: [] })).toBe("⟳ operating loop — 1 ConvergeOp");
  });
});

describe("the one-tick caveat", () => {
  it("says the strip is not a timeline, and why", () => {
    expect(ONE_TICK_CAVEAT).toMatch(/only the last one/);
    expect(ONE_TICK_CAVEAT).toMatch(/chant#2029/);
    expect(ONE_TICK_CAVEAT).toMatch(/strip, not a timeline/);
  });
});

describe("the converge gate card's words", () => {
  it("says approving records a fact and does not unblock the dispatch", () => {
    expect(APPROVE_SEMANTICS).toMatch(/records a fact/);
    expect(APPROVE_SEMANTICS).toMatch(/does not unblock the dispatch/);
    expect(APPROVE_SEMANTICS).toMatch(/next tick reads it/);
    expect(APPROVED_SEMANTICS).toBe("recorded; the next tick acts on it");
  });

  it("names its loop, so it can't be read as the Temporal run gate", () => {
    expect(CONVERGE_LOOP_LINE).toMatch(/converge loop/);
    expect(CONVERGE_LOOP_LINE).toMatch(/chant approve/);
    expect(CONVERGE_LOOP_LINE).toMatch(/not the Temporal run gate/);
  });

  it("carries the delegated write it performs, and no URL (chant#2028)", () => {
    const [g] = convergeGates(state);
    expect(g.approve).toEqual({
      method: "POST",
      path: "/api/operator/approve/fountain-apply/rollout-gate",
      command: "chant approve fountain-apply rollout-gate",
    });
    expect(JSON.stringify(g)).not.toMatch(/https?:/);
  });

  it("has no cards when nothing is pending", () => {
    expect(convergeGates({ ...state, gates: [] })).toEqual([]);
    expect(convergeGates(null)).toEqual([]);
  });
});
