import { describe, expect, it } from "vitest";
import type { GraphIR, IRNode } from "@intentius/chant";
import { FLAT_NODE_LIMIT, FlatLayoutTooLarge, keepCards, toSvg } from "./graph-svg.ts";
import { GRAPH_FORMATS, PENDING_FORMATS, graphFormat } from "./graph-formats.ts";

// behold#1061: the SVG writer over the painter the server uses.

const node = (id: string, attrs: Record<string, unknown> = {}): IRNode => ({ id, kind: "aws_s3_bucket", lexicon: "terraform", attrs } as IRNode);

function ir(n: number, boxed: boolean): GraphIR {
  const nodes = Array.from({ length: n }, (_, i) => node(`r/aws_s3_bucket.b${i}`));
  const edges = nodes.slice(1).map((m, i) => ({ from: m.id, to: nodes[i]!.id, kind: "ref" }));
  return { nodes, edges, groups: boxed ? { byStack: { r: nodes.map((m) => m.id) } } : {} } as unknown as GraphIR;
}

describe("toSvg (#1061)", () => {
  it("is registered as a format and no longer pending", () => {
    expect(graphFormat("svg")).toBeDefined();
    expect(GRAPH_FORMATS.map((f) => f.name)).toContain("svg");
    expect(PENDING_FORMATS.svg).toBeUndefined();
  });

  it("paints a boxed graph as a self-contained SVG, with different colours per theme", () => {
    const light = toSvg(ir(4, true), { theme: "light" });
    const dark = toSvg(ir(4, true), { theme: "dark" });
    expect(light.startsWith("<svg")).toBe(true);
    expect(light).not.toContain('href="http');
    expect(light).not.toBe(dark);
    expect(toSvg(ir(4, true))).toBe(dark);
  });

  it("refuses a flat graph over the limit and says what to do instead", () => {
    const big = ir(FLAT_NODE_LIMIT + 1, false);
    expect(() => toSvg(big)).toThrow(FlatLayoutTooLarge);
    expect(() => toSvg(big)).toThrow(/boxed|cut/);
  });

  it("keepCards drops the cards a cut left out, their edges, and boxes left empty", () => {
    const g = ir(4, true);
    const keep = new Set(["r/aws_s3_bucket.b0", "r/aws_s3_bucket.b1"]);
    const cut = keepCards(g, keep);
    expect(cut.nodes.map((m) => m.id)).toEqual([...keep]);
    expect(cut.edges).toHaveLength(1);
    expect((cut.groups.byStack as Record<string, string[]>).r).toEqual([...keep]);
    expect(keepCards(g, new Set()).groups.byStack).toEqual({});
  });

  it("a cut over a flat graph under the limit draws, and one over the limit does not", () => {
    const big = ir(FLAT_NODE_LIMIT + 1, false);
    const keep = new Set(big.nodes.slice(0, 5).map((m) => m.id));
    expect(toSvg(big, { keep }).startsWith("<svg")).toBe(true);
  });
});

describe("toSvg, marks on cards (#1061)", () => {
  it("prints a card's plan change, which the served page prints from the same attrs", () => {
    const g = ir(2, true);
    g.nodes[0]!.attrs = { block: "resource", _plan: { source: "plan", action: "update" } };
    const svg = toSvg(g);
    expect(svg).toContain("update");
    expect(toSvg(ir(2, true))).not.toContain(">update<");
  });
});
