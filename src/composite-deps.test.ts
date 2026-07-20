import { describe, it, expect } from "vitest";
import { kebabKind, addCompositeDeps } from "./composite-deps.ts";
import type { GraphIR } from "@intentius/chant";

describe("kebabKind", () => {
  it("PascalCase composite kind → kebab component name", () => {
    expect(kebabKind("LoomBackend")).toBe("loom-backend");
    expect(kebabKind("SharedFoundation")).toBe("shared-foundation");
    expect(kebabKind("LoomDb")).toBe("loom-db");
  });
});

describe("addCompositeDeps", () => {
  const ir = (): GraphIR => ({
    nodes: [
      { id: "foundation", kind: "SharedFoundation", lexicon: "aws", attrs: {} },
      { id: "backend", kind: "LoomBackend", lexicon: "aws", attrs: {} },
      { id: "byoBackend", kind: "LoomBackend", lexicon: "aws", attrs: {} }, // example twin
      { id: "loomProxy", kind: "Docker::Compose::Service", lexicon: "docker", attrs: {} },
    ],
    edges: [],
    groups: {},
  });
  const componentEdges = [
    { from: "loom-backend", to: "shared-foundation" },
    { from: "downstream-stub", to: "shared-foundation" }, // no composite node → skipped
  ];

  it("overlays dependsOn onto the real composite nodes (not the byo twin)", () => {
    const out = addCompositeDeps(ir(), componentEdges);
    expect(out.edges).toContainEqual({ from: "backend", to: "foundation", kind: "ref", viaAttr: "dependsOn", inferred: true });
    // downstream-stub has no composite node → no dangling edge; byo twin untouched.
    expect(out.edges).toHaveLength(1);
    expect(out.edges.some((e) => e.from === "byoBackend")).toBe(false);
  });

  it("doesn't duplicate an already-declared edge", () => {
    const withEdge = ir();
    withEdge.edges.push({ from: "backend", to: "foundation", kind: "ref" });
    expect(addCompositeDeps(withEdge, componentEdges).edges).toHaveLength(1);
  });
});
