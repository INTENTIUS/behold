import { describe, expect, it } from "vitest";
import { humanMs, readCostLine } from "./read-cost.js";

const sample = (over = {}) => ({ dir: "monolith", what: "graph --live", live: true, queuedMs: 0, runningMs: 1000, outcome: "completed", ...over });

describe("humanMs", () => {
  it("rounds to whole seconds and names a sub-second read rather than showing 0s", () => {
    expect(humanMs(400)).toBe("under a second");
    expect(humanMs(1499)).toBe("1s");
    expect(humanMs(59_400)).toBe("59s");
  });

  it("breaks a minute out, and drops a zero remainder", () => {
    expect(humanMs(60_000)).toBe("1m");
    expect(humanMs(147_000)).toBe("2m 27s");
    expect(humanMs(120_000)).toBe("2m");
  });

  it("refuses a number it cannot render", () => {
    expect(humanMs(NaN)).toBeNull();
    expect(humanMs(-1)).toBeNull();
    expect(humanMs(undefined)).toBeNull();
  });
});

describe("readCostLine (#421)", () => {
  it("reports the slowest member, because that is what the wall clock follows", () => {
    // Summing these would say 2m 30s, a number nobody ever waits for: the reads
    // overlap under the shared budget and the estate is done when the last is.
    const reads = { recent: [
      sample({ dir: "monolith", runningMs: 3_000 }),
      sample({ dir: "team-a", runningMs: 147_000 }),
      sample({ dir: "team-b", runningMs: 500 }),
    ] };
    expect(readCostLine(reads)).toBe("last read: 3 members, slowest 2m 27s (team-a graph --live)");
  });

  it("counts members rather than reads — a member read twice is one member", () => {
    const reads = { recent: [
      sample({ dir: "monolith", what: "graph", runningMs: 900 }),
      sample({ dir: "monolith", what: "graph --live", runningMs: 4_000 }),
    ] };
    expect(readCostLine(reads)).toBe("last read: 1 member, slowest 4s (monolith graph --live)");
  });

  it("says nothing rather than zero when there is nothing behind it", () => {
    expect(readCostLine(null)).toBeNull();
    expect(readCostLine({})).toBeNull();
    expect(readCostLine({ recent: [] })).toBeNull();
  });

  it("says nothing in preview mode, where the totals arrive without the samples", () => {
    // "Slowest member" is a claim about members, and preview mode deliberately
    // withholds them (src/server.ts). Totals alone cannot answer it.
    expect(readCostLine({ runs: 12, live: { runs: 6, runningMs: 900_000 } })).toBeNull();
  });
});

describe("the members the ledger cannot see (#421)", () => {
  it("names them rather than reporting a slowest it did not measure", () => {
    // A choudoufu member spawns its own binary and never reaches ReadScheduler,
    // so "slowest 3s" beside an unmeasured 60s member would be a false claim.
    const line = readCostLine({ unmeasured: 2, recent: [sample({ dir: "app", runningMs: 3000 })] });
    expect(line).toBe("last read: 1 member, slowest 3s (app graph --live) · 2 not measured");
  });

  it("says nothing extra when every member was measured", () => {
    const line = readCostLine({ unmeasured: 0, recent: [sample({ dir: "app", runningMs: 3000 })] });
    expect(line).toBe("last read: 1 member, slowest 3s (app graph --live)");
  });

  it("says nothing extra when the field is absent, as an older payload has it", () => {
    const line = readCostLine({ recent: [sample({ dir: "app", runningMs: 3000 })] });
    expect(line).toBe("last read: 1 member, slowest 3s (app graph --live)");
  });
});
