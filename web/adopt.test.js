import { describe, expect, it } from "vitest";
import { reportGroups, reportSummary } from "./adopt.js";

// behold#999: the Adopt tab's grouping of promote's report.
const report = {
  claimed: 2,
  total: 4,
  leftOut: { MISSING: 1, UNTAGGABLE: 1 },
  entries: [
    { address: "a.one", fate: "claimed", status: "VERIFIED" },
    { address: "a.two", fate: "left-out", status: "MISSING" },
    { address: "a.three", fate: "claimed", status: "DRIFTED" },
    { address: "a.four", fate: "left-out", status: "UNTAGGABLE" },
  ],
};

describe("the Adopt tab (behold#999)", () => {
  it("groups every entry by fate, claimed first, none dropped", () => {
    const g = reportGroups(report);
    expect(g.map((x) => x.title)).toEqual(["claimed (2)", "left out (2)"]);
    expect(g.flatMap((x) => x.rows.map((r) => r.address))).toEqual(["a.one", "a.three", "a.two", "a.four"]);
  });
  it("counts what is claimed and what is left out, by status", () => {
    expect(reportSummary(report)).toBe("2 of 4 resource instance(s) claimed; left out: 1 MISSING, 1 UNTAGGABLE.");
    expect(reportSummary(null)).toBe("");
  });
});
