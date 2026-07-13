import { describe, it, expect } from "vitest";
import { driftDigest } from "./poll.ts";
import type { GraphIR } from "@intentius/chant";

const ir = (nodes: Array<{ id: string; status?: string }>): GraphIR =>
  ({
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: "K",
      lexicon: "aws",
      attrs: n.status ? { _status: n.status } : {},
    })),
    edges: [],
    groups: {},
  }) as unknown as GraphIR;

describe("driftDigest", () => {
  it("is stable regardless of node order", () => {
    const a = driftDigest(ir([{ id: "vpc", status: "good" }, { id: "sg", status: "warn" }]));
    const b = driftDigest(ir([{ id: "sg", status: "warn" }, { id: "vpc", status: "good" }]));
    expect(a).toBe(b);
  });

  it("changes when a node's drift status changes", () => {
    const before = driftDigest(ir([{ id: "vpc", status: "accent" }]));
    const after = driftDigest(ir([{ id: "vpc", status: "good" }]));
    expect(after).not.toBe(before);
  });

  it("changes when a node appears or disappears", () => {
    const one = driftDigest(ir([{ id: "vpc", status: "good" }]));
    const two = driftDigest(ir([{ id: "vpc", status: "good" }, { id: "sg", status: "warn" }]));
    expect(two).not.toBe(one);
  });
});
