// behold#1028: the index diff overlay's pure helpers.
import { describe, expect, it } from "vitest";
import { diffSummary, diffUrl, drawOverlaySvg } from "./index-diff.js";

describe("the overlay", () => {
  it("asks a GET with only the arguments given", () => {
    expect(diffUrl()).toBe("/api/graphdb/index-diff");
    expect(diffUrl("cloud/aws/1/abc", "a.json", "")).toBe("/api/graphdb/index-diff?scope=cloud%2Faws%2F1%2Fabc&from=a.json");
  });

  it("draws each change as a class, and not observed is never drawn as removed", () => {
    const svg = drawOverlaySvg({
      nodes: [
        { key: "a", kind: "k", name: "a", change: "changed", detail: "attrs.x" },
        { key: "b", kind: "k", name: "b", change: "not-observed" },
      ],
      edges: [{ from: "a", to: "b", change: "not-observed" }],
    });
    expect(svg).toContain('class="g-node d-changed"');
    expect(svg).toContain('class="g-node d-not-observed"');
    expect(svg).toContain('class="g-edge d-not-observed"');
    expect(svg).not.toContain("d-removed");
  });

  it("shows both stamps and each changed property", () => {
    const lines = diffSummary({
      scopeKey: "cloud/aws/1/abc",
      from: { version: "v1", observedAt: "t1", digest: "a".repeat(64) },
      to: { version: "v2", observedAt: "t2", digest: "b".repeat(64) },
      unchanged: false,
      counts: { added: 0, removed: 0, changed: 1, properties: 1, notObserved: 0, edgesAdded: 0, edgesRemoved: 0, edgesNotObserved: 0 },
      nodes: { changed: [{ key: "n", properties: [{ path: "attrs.x", before: 1, after: 2 }] }] },
      coverage: [],
    });
    expect(lines[1]).toMatch(/^from v1: observed t1/);
    expect(lines[2]).toMatch(/^to {3}v2: observed t2/);
    expect(lines).toContain("  n attrs.x: 1 -> 2");
  });
});
