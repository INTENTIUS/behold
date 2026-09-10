import { describe, it, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { withRowChains, withoutRowChains, isRowChain, rowColumns, ROW_MIN_CARDS, LAYOUT_ROW_VIA } from "./edgeless.ts";
import { renderGraph } from "./render.ts";

/** N edgeless cards in one `byStack` box — the shape every choudoufu member
 * and every Terraform root arrives in. */
const edgeless = (n: number, box = "estate", kind = "aws_iam_role"): GraphIR => ({
  nodes: Array.from({ length: n }, (_, i) => ({ id: `${box}/${kind}.r${i}`, kind, lexicon: "choudoufu", attrs: { rung: "tag-governable" } })),
  edges: [],
  groups: { byStack: { [box]: Array.from({ length: n }, (_, i) => `${box}/${kind}.r${i}`) } },
});

const sizes = (ir: GraphIR, w = 200, h = 100) => new Map(ir.nodes.map((n) => [n.id, { w, h }]));
const viewBox = (svg: string): [number, number] => {
  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)!;
  return [Number(m[1]), Number(m[2])];
};

describe("withRowChains — the edgeless wrap (#393)", () => {
  it("chains a box into columns so dagre gives it rows, and leaves the caller's IR alone", () => {
    const ir = edgeless(100);
    const { ir: layout, grids } = withRowChains(ir, ir.groups.byStack as Record<string, string[]>, { sizes: sizes(ir) });
    expect(ir.edges).toHaveLength(0); // the caller's IR is never touched
    expect(layout).not.toBe(ir);
    expect(layout.edges.length).toBeGreaterThan(0);
    expect(layout.edges.every(isRowChain)).toBe(true);
    expect(layout.edges.every((e) => e.viaAttr === LAYOUT_ROW_VIA)).toBe(true);
    const grid = grids.get("estate")!;
    expect(grid.cols).toBeGreaterThan(1);
    expect(grid.cols).toBeLessThan(100);
    // Column chains: card i to card i + cols, so rank is row.
    const ids = (ir.groups.byStack as Record<string, string[]>).estate;
    expect(layout.edges).toContainEqual({ from: ids[0], to: ids[grid.cols], kind: "ref", viaAttr: LAYOUT_ROW_VIA });
  });

  it("leaves a box alone when its own cards reference each other", () => {
    const ir = edgeless(50);
    const ids = (ir.groups.byStack as Record<string, string[]>).estate;
    ir.edges = [{ from: ids[0], to: ids[1], kind: "ref" }];
    const { ir: layout, grids } = withRowChains(ir, ir.groups.byStack as Record<string, string[]>, { sizes: sizes(ir) });
    expect(layout).toBe(ir);
    expect(grids.size).toBe(0);
  });

  it("wraps a box with no internal edges even when the graph has edges elsewhere (waterpark's identity root)", () => {
    // Two roots: `envs` wires its own cards, `identity` does not. One edge
    // crosses between them, which is not `identity`'s structure either.
    const wired = edgeless(20, "envs");
    const loose = edgeless(20, "identity");
    const ir: GraphIR = {
      nodes: [...wired.nodes, ...loose.nodes],
      edges: [
        { from: "envs/aws_iam_role.r0", to: "envs/aws_iam_role.r1", kind: "ref" },
        { from: "envs/aws_iam_role.r2", to: "identity/aws_iam_role.r0", kind: "ref" },
      ],
      groups: { byStack: { envs: wired.groups.byStack!.envs, identity: loose.groups.byStack!.identity } },
    };
    const { grids } = withRowChains(ir, ir.groups.byStack as Record<string, string[]>, { sizes: sizes(ir) });
    expect([...grids.keys()]).toEqual(["identity"]);
  });

  it("leaves a box under the floor exactly as it was", () => {
    const ir = edgeless(ROW_MIN_CARDS - 1);
    const { ir: layout, grids } = withRowChains(ir, ir.groups.byStack as Record<string, string[]>, { sizes: sizes(ir) });
    expect(layout).toBe(ir);
    expect(grids.size).toBe(0);
  });

  it("bands a box, remainder first, and gives each band its own rows", () => {
    const ir = edgeless(30);
    const ids = (ir.groups.byStack as Record<string, string[]>).estate;
    const inModule = new Set(ids.slice(20));
    const { grids } = withRowChains(ir, ir.groups.byStack as Record<string, string[]>, {
      sizes: sizes(ir),
      bandOf: (id) => (inModule.has(id) ? 'module.pod["a"]' : undefined),
    });
    const bands = grids.get("estate")!.bands;
    expect(bands.map((b) => b.key)).toEqual([undefined, 'module.pod["a"]']);
    expect(bands[0].ids).toHaveLength(20);
    expect(bands[1].ids).toHaveLength(10);
  });

  it("strips its own edges back out of an IR that somehow carries them", () => {
    const ir = edgeless(20);
    const { ir: layout } = withRowChains(ir, ir.groups.byStack as Record<string, string[]>, { sizes: sizes(ir) });
    expect(withoutRowChains(layout).edges).toHaveLength(0);
    expect(withoutRowChains(ir)).toBe(ir);
  });
});

describe("rowColumns", () => {
  it("aims at the target aspect for the cards it is given", () => {
    // 100 cards, 200x100 with dagre's default separations: a grid near 2.4:1.
    const cols = rowColumns(100, { w: 200, h: 100 }, { x: 64, y: 72 });
    const rows = Math.ceil(100 / cols);
    expect((cols * 264) / (rows * 172)).toBeGreaterThan(1.5);
    expect((cols * 264) / (rows * 172)).toBeLessThan(4);
  });

  it("never asks for more columns than there are cards", () => {
    expect(rowColumns(3, { w: 1000, h: 20 }, { x: 0, y: 0 })).toBeLessThanOrEqual(3);
    expect(rowColumns(1, { w: 200, h: 100 }, { x: 64, y: 72 })).toBe(1);
  });
});

describe("renderGraph over an edgeless estate (#393)", () => {
  it("lays a 100-card edgeless box out under 4:1 instead of one rank", () => {
    const ir = edgeless(100);
    const [w, h] = viewBox(renderGraph(ir, { boxes: "byStack" }).svg);
    expect(w / h).toBeLessThan(4);
    // The strip this replaces was 100 cards wide — nothing near that survives.
    expect(w).toBeLessThan(10000);
  });

  it("lays an edgeless graph with no boxes at all out under 4:1", () => {
    const ir = edgeless(100);
    const [w, h] = viewBox(renderGraph({ ...ir, groups: {} }).svg);
    expect(w / h).toBeLessThan(4);
  });

  it("paints no synthetic edge and returns no synthetic edge", () => {
    const ir = edgeless(100);
    const before = JSON.stringify(ir);
    const { svg } = renderGraph(ir, { boxes: "byStack" });
    expect(JSON.stringify(ir)).toBe(before); // the route serves this object
    expect(ir.edges).toHaveLength(0);
    expect(svg).not.toContain(LAYOUT_ROW_VIA);
    expect(svg).not.toContain("data-edge-from"); // pinhole stamps every painted edge
  });

  it("leaves a box whose cards reference each other laid out by dagre", () => {
    const ir = edgeless(30);
    const ids = (ir.groups.byStack as Record<string, string[]>).estate;
    const chain: GraphIR = { ...ir, edges: ids.slice(1).map((to, i) => ({ from: ids[i], to, kind: "ref" as const })) };
    const [, h] = viewBox(renderGraph(chain, { boxes: "byStack" }).svg);
    // 30 cards in a dependency chain is 30 dagre ranks — tall, and untouched.
    expect(h).toBeGreaterThan(3000);
  });
});
