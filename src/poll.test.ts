import { describe, it, expect } from "vitest";
import { driftDigest, driftDigestsByLexicon, changedLexicons, UNKNOWN_LEXICON } from "./poll.ts";
import type { GraphIR } from "@intentius/chant";

const ir = (nodes: Array<{ id: string; status?: string; lexicon?: string }>): GraphIR =>
  ({
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: "K",
      lexicon: n.lexicon ?? "aws",
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

describe("driftDigestsByLexicon", () => {
  const mixed = ir([
    { id: "vpc", status: "good", lexicon: "aws" },
    { id: "svc", status: "accent", lexicon: "k8s" },
  ]);

  it("keeps one digest per substrate", () => {
    expect(Object.keys(driftDigestsByLexicon(mixed)).sort()).toEqual(["aws", "k8s"]);
  });

  // The whole point of #117: the estate-wide digest could not tell these apart,
  // so a drifted Service and a drifted security group were the same event.
  it("moves only the substrate that actually moved", () => {
    const after = ir([
      { id: "vpc", status: "good", lexicon: "aws" },
      { id: "svc", status: "warn", lexicon: "k8s" },
    ]);
    expect(changedLexicons(driftDigestsByLexicon(mixed), driftDigestsByLexicon(after))).toEqual(["k8s"]);
  });

  it("is stable regardless of node order", () => {
    const flipped = ir([
      { id: "svc", status: "accent", lexicon: "k8s" },
      { id: "vpc", status: "good", lexicon: "aws" },
    ]);
    expect(driftDigestsByLexicon(flipped)).toEqual(driftDigestsByLexicon(mixed));
  });

  it("buckets a node with no lexicon on its own, never onto a real substrate", () => {
    // Built directly rather than through `ir` above, whose default would supply
    // the very lexicon this asserts is absent.
    const orphan = {
      nodes: [{ id: "mystery", kind: "K", attrs: { _status: "warn" } }],
      edges: [],
      groups: {},
    } as unknown as GraphIR;
    expect(Object.keys(driftDigestsByLexicon(orphan))).toEqual([UNKNOWN_LEXICON]);
  });
});

describe("changedLexicons", () => {
  it("reports nothing when the estate is unchanged", () => {
    expect(changedLexicons({ aws: "a", k8s: "b" }, { aws: "a", k8s: "b" })).toEqual([]);
  });

  it("reports a substrate whose first node appeared", () => {
    expect(changedLexicons({ aws: "a" }, { aws: "a", k8s: "b" })).toEqual(["k8s"]);
  });

  it("reports a substrate that vanished entirely", () => {
    expect(changedLexicons({ aws: "a", k8s: "b" }, { aws: "a" })).toEqual(["k8s"]);
  });

  it("is sorted, so routing and logs are deterministic", () => {
    expect(changedLexicons({}, { k8s: "b", azure: "c", aws: "a" })).toEqual(["aws", "azure", "k8s"]);
  });
});
