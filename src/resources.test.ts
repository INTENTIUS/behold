import { describe, it, expect } from "vitest";
import { resourcesByComponent } from "./resources.ts";
import type { GraphIR } from "@intentius/chant";

// Fixture mirrors the entity-graph IR shape #59's /api/resources correlates
// against — nodes with a `sourceLoc.file` under `src/<component>/…`.
const ir: GraphIR = {
  nodes: [
    {
      id: "loom-db-instance",
      kind: "RdsInstance",
      lexicon: "aws",
      attrs: {},
      sourceLoc: { file: "src/loom-db/database.ts", line: 12 },
    },
    {
      id: "loom-db-secret",
      kind: "SecretsManagerSecret",
      lexicon: "aws",
      attrs: {},
      sourceLoc: { file: "src/loom-db/database.ts", line: 20 },
      physicalId: "arn:aws:secretsmanager:...",
      ownership: "owned",
    },
    {
      id: "loom-backend-service",
      kind: "EcsService",
      lexicon: "aws",
      attrs: {},
      sourceLoc: { file: "src/loom-backend/service.ts", line: 5 },
    },
    // No sourceLoc at all — shouldn't crash, just excluded.
    { id: "no-source", kind: "Thing", lexicon: "aws", attrs: {} },
    // A top-level file with no component subdir ("src/<file>", not
    // "src/<dir>/<file>") — the convention this module documents as a miss.
    { id: "top-level", kind: "Thing", lexicon: "aws", attrs: {}, sourceLoc: { file: "src/root.ts", line: 1 } },
    // Outside src/ entirely.
    { id: "outside-src", kind: "Thing", lexicon: "aws", attrs: {}, sourceLoc: { file: "ops/deploy.ts", line: 1 } },
  ],
  edges: [],
  groups: {},
};

describe("resourcesByComponent", () => {
  it("groups nodes by the src/<component>/ segment of sourceLoc.file", () => {
    const byComponent = resourcesByComponent(ir);
    expect(Object.keys(byComponent).sort()).toEqual(["loom-backend", "loom-db"]);
    expect(byComponent["loom-db"]).toHaveLength(2);
    expect(byComponent["loom-backend"]).toHaveLength(1);
  });

  it("carries id/kind/lexicon and optional physicalId/ownership", () => {
    const byComponent = resourcesByComponent(ir);
    const secret = byComponent["loom-db"]!.find((r) => r.id === "loom-db-secret")!;
    expect(secret).toEqual({
      id: "loom-db-secret",
      kind: "SecretsManagerSecret",
      lexicon: "aws",
      physicalId: "arn:aws:secretsmanager:...",
      ownership: "owned",
    });
    const instance = byComponent["loom-db"]!.find((r) => r.id === "loom-db-instance")!;
    expect(instance.physicalId).toBeUndefined();
    expect(instance.ownership).toBeUndefined();
  });

  it("skips nodes with no sourceLoc, a top-level src/ file, or a file outside src/", () => {
    const byComponent = resourcesByComponent(ir);
    const allIds = Object.values(byComponent).flat().map((r) => r.id);
    expect(allIds).not.toContain("no-source");
    expect(allIds).not.toContain("top-level");
    expect(allIds).not.toContain("outside-src");
  });

  it("returns {} for an empty node set", () => {
    expect(resourcesByComponent({ nodes: [], edges: [], groups: {} })).toEqual({});
  });
});
