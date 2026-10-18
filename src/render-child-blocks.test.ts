import { describe, expect, it } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { alignChildBlocks } from "./render.ts";

// behold#631: chant's fan-out estate, as the components zoom boxes it: wave 3's
// twelve apps wrapped 4 to a row in name order, cluster-a's six split across
// rows and mixed with cluster-b's.
const appsA = ["app-01", "app-02", "app-03", "app-04", "app-05", "app-06"];
const appsB = ["app-07", "app-08", "app-09", "app-10", "app-11", "app-12"];
const apps = [...appsA, ...appsB];
const boxes = { "wave-1": ["network"], "wave-2": ["cluster-a", "cluster-b"], "wave-3": apps };
const edges = [
  { from: "cluster-a", to: "network", kind: "ref" },
  { from: "cluster-b", to: "network", kind: "ref" },
  ...appsA.map((a) => ({ from: a, to: "cluster-a", kind: "ref" })),
  ...appsB.map((a) => ({ from: a, to: "cluster-b", kind: "ref" })),
];
const ir = { nodes: ["network", "cluster-a", "cluster-b", ...apps].map((id) => ({ id })), edges, groups: {} } as unknown as GraphIR;
const size = new Map<string, { w: number; h: number }>();

/** The wrapped layout, y-up: wave 3 on top in rows of four. */
function layout() {
  const nodes = [
    { id: "network", x: 900, y: 100 },
    { id: "cluster-a", x: 700, y: 400 },
    { id: "cluster-b", x: 1100, y: 400 },
    ...apps.map((id, i) => ({ id, x: 300 + (i % 4) * 250, y: 1100 - Math.floor(i / 4) * 150 })),
  ];
  const groups = [
    { id: "wave-1", x: 900, y: 100, w: 400, h: 180, title: "wave-1" },
    { id: "wave-2", x: 900, y: 400, w: 800, h: 180, title: "wave-2" },
    { id: "wave-3", x: 700, y: 950, w: 1100, h: 520, title: "wave-3" },
  ];
  return { nodes, groups, width: 1800, height: 1300 } as never as Parameters<typeof alignChildBlocks>[0];
}

describe("a fan-out wave laid out as one block per parent (behold#631)", () => {
  it("puts each cluster's six apps in a 3 x 2 block lined up with it", () => {
    const l = layout();
    expect(alignChildBlocks(l, ir, boxes, size)).toBe(12);
    const at = (id: string) => l.nodes.find((n) => n.id === id)!;
    const xs = (ids: string[]) => ids.map((id) => at(id).x);
    const ys = (ids: string[]) => [...new Set(ids.map((id) => at(id).y))];
    // Two rows of three each.
    expect(ys(appsA)).toHaveLength(2);
    expect(new Set(xs(appsA)).size).toBe(3);
    // Every cluster-a app left of every cluster-b app.
    expect(Math.max(...xs(appsA))).toBeLessThan(Math.min(...xs(appsB)));
    // Each parent at its block's centre.
    const mid = (ids: string[]) => (Math.min(...xs(ids)) + Math.max(...xs(ids))) / 2;
    expect(at("cluster-a").x).toBeCloseTo(mid(appsA));
    expect(at("cluster-b").x).toBeCloseTo(mid(appsB));
    // The box holds its two rows, no taller than it was.
    const box = (l as unknown as { groups: { id: string; h: number }[] }).groups.find((g) => g.id === "wave-3")!;
    expect(box.h).toBeLessThanOrEqual(520);
  });

  it("leaves a wave alone when a member depends on two components of the wave before", () => {
    const l = layout();
    const before = JSON.stringify(l);
    const crossed = { ...ir, edges: [...edges, { from: "app-01", to: "cluster-b", kind: "ref" }] } as unknown as GraphIR;
    expect(alignChildBlocks(l, crossed, boxes, size)).toBe(0);
    expect(JSON.stringify(l)).toBe(before);
  });

  it("leaves a wave alone when all its members share one parent", () => {
    const l = layout();
    const one = { ...ir, edges: [...edges.filter((e) => !appsB.includes(e.from)), ...appsB.map((a) => ({ from: a, to: "cluster-a", kind: "ref" }))] } as unknown as GraphIR;
    expect(alignChildBlocks(l, one, boxes, size)).toBe(0);
  });
});
