import { describe, it, expect } from "vitest";
import { danglingFor, danglingRows, danglingHeading } from "../web/dangling.js";

// #554: the shape chant 0.124.20 writes (chant#3912) for a job calling another
// repo's reusable workflow and a step using a local composite action.
const IR = {
  nodes: [{ id: "build" }, { id: "release" }, { id: "ci" }],
  edges: [],
  dangling: [
    { from: "build", kind: "calls", path: "steps.uses", value: "./.github/actions/setup" },
    { from: "release", kind: "calls", path: "uses", value: "octo/shared/.github/workflows/release.yml@main", crossPipeline: true },
  ],
};

describe("dangling references on a card (#554)", () => {
  it("lists only the references the card holds", () => {
    expect(danglingFor(IR, "build").map((d) => d.value)).toEqual(["./.github/actions/setup"]);
    expect(danglingFor(IR, "ci")).toEqual([]);
  });

  it("is empty on an IR without the field, or with none", () => {
    expect(danglingFor({ nodes: [], edges: [] }, "build")).toEqual([]);
    expect(danglingFor(null, "build")).toEqual([]);
  });

  it("shows kind, path and the value as written, and marks a cross-pipeline one", () => {
    expect(danglingRows(danglingFor(IR, "build"))).toEqual([["calls · steps.uses", "./.github/actions/setup"]]);
    expect(danglingRows(danglingFor(IR, "release"))).toEqual([["calls · uses", "octo/shared/.github/workflows/release.yml@main (cross-pipeline)"]]);
  });

  it("counts them in the heading", () => {
    expect(danglingHeading(IR.dangling)).toBe("not declared here · 2");
  });
});
