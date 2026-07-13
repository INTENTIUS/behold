import { describe, it, expect } from "vitest";
import { FrameBuffer, frameDigest } from "./frames.ts";
import type { GraphIR } from "@intentius/chant";

const ir = (nodes: Array<{ id: string; lexicon?: string; status?: string }>, edges: Array<[string, string]> = []): GraphIR =>
  ({
    nodes: nodes.map((n) => ({ id: n.id, kind: "K", lexicon: n.lexicon ?? "aws", attrs: n.status ? { _status: n.status } : {} })),
    edges: edges.map(([from, to]) => ({ from, to, kind: "ref" })),
    groups: {},
  }) as unknown as GraphIR;

describe("frameDigest", () => {
  it("is order-independent and reflects nodes, status, edges", () => {
    expect(frameDigest(ir([{ id: "a" }, { id: "b" }]))).toBe(frameDigest(ir([{ id: "b" }, { id: "a" }])));
    expect(frameDigest(ir([{ id: "a", status: "good" }]))).not.toBe(frameDigest(ir([{ id: "a", status: "warn" }])));
    expect(frameDigest(ir([{ id: "a" }], [["a", "b"]]))).not.toBe(frameDigest(ir([{ id: "a" }])));
  });
});

describe("FrameBuffer", () => {
  it("captures distinct frames and dedupes consecutive identical ones", () => {
    let t = 100;
    const b = new FrameBuffer(100, () => t);
    expect(b.capture(ir([{ id: "a" }]))).not.toBeNull(); // frame 0
    t = 200;
    expect(b.capture(ir([{ id: "a" }]))).toBeNull(); // identical → skipped
    expect(b.capture(ir([{ id: "a" }, { id: "b" }]))).not.toBeNull(); // frame 1
    expect(b.size).toBe(2);
    expect(b.all().map((f) => f.t)).toEqual([100, 200]);
  });

  it("summaries carry per-substrate counts", () => {
    const b = new FrameBuffer();
    b.capture(ir([{ id: "vpc", lexicon: "aws" }, { id: "svc", lexicon: "k8s" }]));
    const [s] = b.summaries();
    expect(s.nodes).toBe(2);
    expect(s.byLexicon).toEqual({ aws: 1, k8s: 1 });
  });

  it("caps the buffer at max, keeping the newest", () => {
    let t = 0;
    const b = new FrameBuffer(2, () => ++t);
    b.capture(ir([{ id: "a" }]));
    b.capture(ir([{ id: "b" }]));
    b.capture(ir([{ id: "c" }]));
    expect(b.size).toBe(2);
    expect(b.all().map((f) => f.ir.nodes[0].id)).toEqual(["b", "c"]);
  });
});
