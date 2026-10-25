import { describe, expect, it } from "vitest";
import { pulumiGroups, pulumiSummary } from "./adopt-pulumi.js";

// behold#999: the Adopt tab's grouping of plunge stack adopt's classification.
const report = {
  claimed: 4,
  total: 5,
  byOwnership: { pending: 2, marker: 1, record: 1, borrowed: 1 },
  entries: [
    { urn: "u:bucket", ownership: "pending", fate: "claimed" },
    { urn: "u:dep", ownership: "marker", fate: "claimed" },
    { urn: "u:role", ownership: "record", fate: "claimed" },
    { urn: "u:odd", ownership: "borrowed", fate: "unknown" },
    { urn: "u:fn", ownership: "pending", fate: "claimed" },
  ],
};

describe("the Adopt tab's pulumi card (behold#999)", () => {
  it("groups every entry by ownership, marker first, an unknown ownership last, none dropped", () => {
    const g = pulumiGroups(report);
    expect(g.map((x) => x.title)).toEqual(["claimed, by marker (1)", "claimed, by record (1)", "claimed, by pending (2)", "unknown ownership, by borrowed (1)"]);
    expect(g.flatMap((x) => x.rows.map((r) => r.urn))).toEqual(["u:dep", "u:role", "u:bucket", "u:fn", "u:odd"]);
  });
  it("counts what is claimed, by ownership", () => {
    expect(pulumiSummary(report)).toBe("4 of 5 resource(s) claimed (2 by pending, 1 by marker, 1 by record, 1 by borrowed).");
    expect(pulumiSummary(null)).toBe("");
  });
});
