import { describe, it, expect } from "vitest";
import { nodeDiff, type LiveDiffJson } from "./diff.ts";

const json: LiveDiffJson = {
  environment: "prod",
  lexicons: {
    aws: {
      resources: {
        missing: ["gone"],
        orphan: ["stray"],
        disappeared: ["vanished"],
        newlyObserved: ["fresh"],
        driftedSinceSnapshot: [
          { name: "store", changes: [{ path: "attributes.tags.env", oldValue: "dev", newValue: "prod" }] },
        ],
        unchanged: ["stable"],
      },
    },
  },
};

describe("nodeDiff", () => {
  it("returns drifted with field changes for a resource that drifted since snapshot", () => {
    expect(nodeDiff(json, "store")).toEqual({
      category: "drifted",
      changes: [{ path: "attributes.tags.env", oldValue: "dev", newValue: "prod" }],
    });
  });

  it("classifies presence categories with no field changes", () => {
    expect(nodeDiff(json, "gone")).toEqual({ category: "missing", changes: [] });
    expect(nodeDiff(json, "stray")).toEqual({ category: "orphan", changes: [] });
    expect(nodeDiff(json, "vanished")).toEqual({ category: "disappeared", changes: [] });
    expect(nodeDiff(json, "fresh")).toEqual({ category: "newlyObserved", changes: [] });
    expect(nodeDiff(json, "stable")).toEqual({ category: "unchanged", changes: [] });
  });

  it("returns null for a node absent from the diff", () => {
    expect(nodeDiff(json, "nope")).toBeNull();
  });

  it("tolerates a lexicon with no resources block (artifacts-only) and empty input", () => {
    expect(nodeDiff({ environment: "prod", lexicons: { helm: { artifacts: {} } } }, "x")).toBeNull();
    expect(nodeDiff({ environment: "prod", lexicons: {} }, "x")).toBeNull();
  });
});
