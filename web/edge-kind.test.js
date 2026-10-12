import { describe, expect, it } from "vitest";
import { edgeLabel, edgeLegend, edgeTitle } from "./edge-kind.js";

// The edges chant 0.124.20's GitHub lexicon writes (lexicons/github/src/
// graph-edges.ts) and one from its GitLab lexicon.
const needs = { from: "Test", to: "Build", kind: "needs", viaAttr: "needs" };
const calls = { from: "Ci", to: "Release", kind: "calls", viaAttr: "uses", crossPipeline: true };
const triggers = { from: "Deploy", to: "Ci", kind: "triggers", viaAttr: "workflow_run", crossPipeline: true };
const stage = { from: "test", to: "build", kind: "needs", viaAttr: "stage" };
const ref = { from: "api", to: "db", kind: "ref", viaAttr: "data dependency" };

const title = (e) => edgeTitle(e.from, e.to, { kind: e.kind, via: e.viaAttr, cross: e.crossPipeline });

describe("edgeLabel (#553)", () => {
  it("names a CI edge by its kind, with the attribute only when it adds something", () => {
    expect(edgeLabel({ kind: "needs", via: "needs" })).toBe("needs");
    expect(edgeLabel({ kind: "needs", via: "stage" })).toBe("needs (stage)");
    expect(edgeLabel({ kind: "calls", via: "uses" })).toBe("calls (uses)");
    expect(edgeLabel({ kind: "triggers", via: "workflow_run" })).toBe("triggers (workflow_run)");
    expect(edgeLabel({ kind: "includes" })).toBe("includes");
  });

  it("names a reference by the attribute it flows through", () => {
    expect(edgeLabel({ kind: "ref", via: "role" })).toBe("role");
    expect(edgeLabel({ via: "role", toAttr: "arn" })).toBe("role → arn");
    expect(edgeLabel({ kind: "ref" })).toBe("");
  });
});

describe("edgeTitle, the hover tooltip (#553)", () => {
  it("says a needs edge's kind and what it means", () => {
    expect(title(needs)).toBe("Test → Build\nneeds: waits for the other job to finish");
    expect(title(stage)).toBe("test → build\nneeds (stage): waits for the other job to finish");
  });

  it("says a call to a reusable workflow leaves its pipeline", () => {
    expect(title(calls)).toBe(
      "Ci → Release\ncalls (uses): runs the other workflow as a reusable workflow\ncross-pipeline: leaves its own workflow or pipeline",
    );
    expect(title(triggers)).toBe(
      "Deploy → Ci\ntriggers (workflow_run): starts the other workflow or pipeline\ncross-pipeline: leaves its own workflow or pipeline",
    );
  });

  it("keeps a reference's reason as it was", () => {
    expect(title(ref)).toBe("api → db\ndata dependency — reads/uses this store");
    expect(edgeTitle("a", "b", { kind: "ref", via: "role" })).toBe("a → b\nrole");
    expect(edgeTitle("a", "b", {})).toBe("a → b");
  });

  it("names a kind it has no sentence for", () => {
    expect(edgeTitle("a", "b", { kind: "waits", via: "on" })).toBe("a → b\nwaits (on)");
  });
});

describe("edgeLegend (#553)", () => {
  it("lists the CI kinds the graph holds, then the cross-pipeline edges", () => {
    const rows = edgeLegend([needs, needs, calls, triggers, ref]);
    expect(rows.map((r) => [r.label, r.count, r.cross])).toEqual([
      ["needs", 2, false],
      ["calls", 1, true],
      ["triggers", 1, true],
      ["cross-pipeline (dashed)", 2, true],
    ]);
  });

  it("is empty for a graph of references", () => {
    expect(edgeLegend([ref, { from: "a", to: "b", kind: "ref" }])).toEqual([]);
  });
});
