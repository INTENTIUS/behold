import { describe, it, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { directionOf, routeEdge, routeEdges, samplePath, segmentHits, svgGeometry, type Rect } from "./edge-route.ts";
import { renderArchitecture, renderGraph } from "./render.ts";

// #571: pinhole draws an edge centre to centre, so cards stacked in one column
// (a terragucci repo's components zoom: one root per wave) got a line straight
// down through every card's text. These check the router against what it is
// for: no line over a card that is not one of its ends, both ends on a border.

const inRect = (r: Rect, p: { x: number; y: number }): boolean => p.x > r.x + 0.5 && p.x < r.x + r.w - 0.5 && p.y > r.y + 0.5 && p.y < r.y + r.h - 0.5;
const onBorder = (r: Rect, p: { x: number; y: number }): boolean => {
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.6;
  const inX = p.x >= r.x - 0.6 && p.x <= r.x + r.w + 0.6;
  const inY = p.y >= r.y - 0.6 && p.y <= r.y + r.h + 0.6;
  return ((near(p.y, r.y) || near(p.y, r.y + r.h)) && inX) || ((near(p.x, r.x) || near(p.x, r.x + r.w)) && inY);
};

interface DrawnEdge {
  from: string;
  to: string;
  d: string;
  hit: string;
}

function drawnEdges(svg: string): DrawnEdge[] {
  return [...svg.matchAll(/<g data-edge-from="([^"]*)" data-edge-to="([^"]*)"[^>]*><path class="pin-edge-line[^"]*" d="([^"]*)"[^>]*\/><path d="([^"]*)"/g)].map((m) => ({
    from: m[1]!,
    to: m[2]!,
    d: m[3]!,
    hit: m[4]!,
  }));
}

/** Every edge in `svg` clears every card but its own two, starts on its source
 * card's border and ends on its target's, and its hit-path matches its line. */
function expectClear(svg: string): void {
  const { cards } = svgGeometry(svg);
  const edges = drawnEdges(svg);
  expect(edges.length).toBeGreaterThan(0);
  for (const e of edges) {
    const pts = samplePath(e.d);
    for (const [id, r] of cards) {
      if (id === e.from || id === e.to) continue;
      expect(pts.filter((p) => inRect(r, p)), `${e.from} -> ${e.to} crosses ${id}`).toEqual([]);
    }
    expect(onBorder(cards.get(e.from)!, pts[0]!), `${e.from} -> ${e.to} starts on ${e.from}'s border`).toBe(true);
    expect(onBorder(cards.get(e.to)!, pts[pts.length - 1]!), `${e.from} -> ${e.to} ends on ${e.to}'s border`).toBe(true);
    // Both ends' own cards: only the endpoints touch them.
    for (const id of [e.from, e.to]) expect(pts.filter((p) => inRect(cards.get(id)!, p))).toEqual([]);
    expect(e.hit).toBe(e.d);
  }
}

describe("segmentHits", () => {
  const r = { x: 10, y: 10, w: 20, h: 20 };
  it("a segment through the rect hits it; one beside, short of, or along its edge does not", () => {
    expect(segmentHits({ x: 20, y: 0 }, { x: 20, y: 40 }, r)).toBe(true);
    expect(segmentHits({ x: 0, y: 20 }, { x: 40, y: 20 }, r)).toBe(true);
    expect(segmentHits({ x: 5, y: 0 }, { x: 5, y: 40 }, r)).toBe(false);
    expect(segmentHits({ x: 20, y: 0 }, { x: 20, y: 9 }, r)).toBe(false);
    expect(segmentHits({ x: 10, y: 0 }, { x: 10, y: 40 }, r)).toBe(false);
    expect(segmentHits({ x: 0, y: 0 }, { x: 40, y: 40 }, r)).toBe(true);
  });
});

describe("directionOf", () => {
  const a = { x: 0, y: 0, w: 100, h: 50 };
  it("runs down to a card below, up to one above, sideways to one beside, and nowhere when they overlap", () => {
    expect(directionOf(a, { x: 0, y: 200, w: 100, h: 50 })).toBe("down");
    expect(directionOf(a, { x: 0, y: -200, w: 100, h: 50 })).toBe("up");
    expect(directionOf(a, { x: 300, y: 0, w: 100, h: 50 })).toBe("right");
    expect(directionOf(a, { x: -300, y: 10, w: 100, h: 50 })).toBe("left");
    expect(directionOf(a, { x: 50, y: 20, w: 100, h: 50 })).toBeNull();
  });
});

describe("routeEdge", () => {
  const top = { x: 100, y: 0, w: 200, h: 80 };
  const middle = { x: 100, y: 200, w: 200, h: 80 };
  const bottom = { x: 100, y: 400, w: 200, h: 80 };

  it("two cards in one column: a straight line from the upper card's bottom to the lower card's top", () => {
    const r = routeEdge({ from: top, to: middle, obstacles: [] })!;
    const pts = samplePath(r.d);
    expect(pts[0]).toEqual({ x: 200, y: 80 });
    expect(pts[pts.length - 1]).toEqual({ x: 200, y: 200 });
    expect(pts.every((p) => p.x === 200)).toBe(true);
    expect(r.crossings).toBe(0);
  });

  it("the same, drawn upward: the lower card's top to the upper card's bottom", () => {
    const pts = samplePath(routeEdge({ from: middle, to: top, obstacles: [] })!.d);
    expect(pts[0]).toEqual({ x: 200, y: 200 });
    expect(pts[pts.length - 1]).toEqual({ x: 200, y: 80 });
  });

  it("an edge that skips a card in the same column goes around it, not through it", () => {
    const r = routeEdge({ from: top, to: bottom, obstacles: [middle] })!;
    expect(r.crossings).toBe(0);
    expect(r.curved).toBe(false);
    const pts = samplePath(r.d);
    expect(pts.filter((p) => inRect(middle, p))).toEqual([]);
    expect(onBorder(top, pts[0]!)).toBe(true);
    expect(onBorder(bottom, pts[pts.length - 1]!)).toBe(true);
    // Through a gutter beside the card, with room to spare.
    const gutter = pts.filter((p) => p.y > middle.y && p.y < middle.y + middle.h);
    expect(gutter.every((p) => p.x <= middle.x - 12 || p.x >= middle.x + middle.w + 12)).toBe(true);
  });

  it("a box title in the way is avoided too", () => {
    const title = { x: 150, y: 170, w: 100, h: 20 };
    const r = routeEdge({ from: top, to: middle, obstacles: [], labels: [title] })!;
    expect(r.crossings).toBe(0);
    expect(samplePath(r.d).filter((p) => inRect(title, p))).toEqual([]);
  });

  it("side by side: from the right border to the left border", () => {
    const right = { x: 500, y: 0, w: 200, h: 80 };
    const pts = samplePath(routeEdge({ from: top, to: right, obstacles: [] })!.d);
    expect(pts[0]).toEqual({ x: 300, y: 40 });
    expect(pts[pts.length - 1]).toEqual({ x: 500, y: 40 });
  });
});

// A pinhole-shaped SVG, as `Canvas` writes it: boxes, then edges (with a chip on
// one), then cards. Centre-to-centre lines, as pinhole 0.5 draws them.
function pinholeSvg(): string {
  const card = (id: string, x: number, y: number): string =>
    `<g data-node-id="${id}"><rect x="${x}" y="${y}" width="200" height="80" rx="12" fill="#111" stroke="#222" stroke-width="1.2"/><text x="${x + 46}" y="${y + 30}">${id}</text></g>`;
  const box = (title: string, x: number, y: number): string =>
    `<rect data-group-id="${title}" x="${x}" y="${y}" width="300" height="160" rx="16" fill="#000" fill-opacity="0.6" stroke="#333" stroke-width="1.2"/><text x="${x + 18}" y="${y + 23}" fill="#777" font-size="12" font-weight="700" letter-spacing=".5">${title}</text>`;
  const edge = (from: string, to: string, d: string): string =>
    `<g data-edge-from="${from}" data-edge-to="${to}"><path class="pin-edge-line" d="${d}" fill="none" stroke="#444" stroke-width="1.4" stroke-linecap="round"/><path d="${d}" fill="none" stroke="transparent" stroke-width="14" stroke-linecap="round" pointer-events="stroke"/></g>`;
  const chip = (from: string, to: string, via: string, x: number, y: number): string => {
    const w = via.length * 5.7 + 14;
    return `<g data-edge-from="${from}" data-edge-to="${to}" data-edge-via="${via}"><rect x="${(x - w / 2).toFixed(1)}" y="${y - 9}" width="${w.toFixed(1)}" height="18" rx="9" fill="#000" stroke="#333" stroke-width="1"/><text x="${x.toFixed(1)}" y="${y + 3.5}" text-anchor="middle" fill="#777" font-size="10.5">${via}</text></g>`;
  };
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800">` +
    box("wave-3", 50, 50) +
    box("wave-2", 50, 300) +
    box("wave-1", 50, 550) +
    edge("edge", "app", "M 200 140 C 200 265, 200 265, 200 390") +
    edge("app", "network", "M 200 390 C 200 515, 200 515, 200 640") +
    edge("edge", "network", "M 200 140 C 200 390, 200 390, 200 640") +
    `<g data-edge-from="edge" data-edge-to="network" data-edge-via="output"><path class="pin-edge-line" d="M 200 140 C 200 390, 200 390, 200 640" fill="none" stroke="#444" stroke-width="1.4" stroke-linecap="round"/><path d="M 200 140 C 200 390, 200 390, 200 640" fill="none" stroke="transparent" stroke-width="14"/></g>` +
    chip("edge", "network", "output", 200, 390) +
    card("edge", 100, 100) +
    card("app", 100, 350) +
    card("network", 100, 600) +
    `</svg>`
  );
}

describe("routeEdges over a pinhole SVG", () => {
  it("leaves an SVG with no edges byte-identical", () => {
    const svg = `<svg><g data-node-id="a"><rect x="0" y="0" width="10" height="10" rx="12"/></g></svg>`;
    expect(routeEdges(svg)).toBe(svg);
  });

  it("three cards in one column (#571): every line clears the cards it does not join", () => {
    const before = pinholeSvg();
    // The bug: pinhole's lines run through the middle card.
    const { cards } = svgGeometry(before);
    expect(samplePath(drawnEdges(before).find((e) => e.from === "edge" && e.to === "network")!.d).some((p) => inRect(cards.get("app")!, p))).toBe(true);
    const after = routeEdges(before);
    expectClear(after);
    // Cards and boxes are not moved.
    expect(svgGeometry(after).cards).toEqual(cards);
  });

  it("two lines leaving one side of a card leave from different points", () => {
    const edges = drawnEdges(routeEdges(pinholeSvg())).filter((e) => e.from === "edge");
    const starts = new Set(edges.map((e) => samplePath(e.d)[0]!.x));
    expect(starts.size).toBeGreaterThan(1);
  });

  it("a label chip moves off every card and box title", () => {
    const after = routeEdges(pinholeSvg());
    const { cards, labels } = svgGeometry(after);
    const chip = /<g data-edge-from="edge" data-edge-to="network" data-edge-via="output"><rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="18"[^>]*\/><text x="([-\d.]+)" y="([-\d.]+)"/.exec(after);
    expect(chip).not.toBeNull();
    const r = { x: +chip![1]!, y: +chip![2]!, w: +chip![3]!, h: 18 };
    const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    for (const [id, c] of cards) expect(overlaps(r, c), `chip over ${id}`).toBe(false);
    for (const t of labels) expect(overlaps(r, t), "chip over a box title").toBe(false);
    // The text stays centred in its chip.
    expect(+chip![4]!).toBeCloseTo(r.x + r.w / 2, 0);
    expect(+chip![5]!).toBeCloseTo(r.y + 9 + 3.5, 0);
  });
});

describe("the components zoom, rendered (#571)", () => {
  // One root per wave, so dagre stacks the three cards in one column inside
  // stacked wave boxes: the picture behold#571 reported. edge → network skips
  // a wave, so its line has to get past app.
  const column: GraphIR = {
    nodes: [
      { id: "network", kind: "Component", lexicon: "chant", attrs: { archetype: "infra", wave: 1 } },
      { id: "other", kind: "Component", lexicon: "chant", attrs: { archetype: "infra", wave: 1 } },
      { id: "app", kind: "Component", lexicon: "chant", attrs: { archetype: "infra", wave: 2 } },
      { id: "edge", kind: "Component", lexicon: "chant", attrs: { archetype: "infra", wave: 3 } },
    ],
    edges: [
      { from: "app", to: "network", kind: "ref" },
      { from: "edge", to: "app", kind: "ref" },
      { from: "edge", to: "network", kind: "ref" },
    ],
    groups: { byWave: { "wave-1": ["network", "other"], "wave-2": ["app"], "wave-3": ["edge"] } } as GraphIR["groups"],
  };

  it("no edge passes over a card that is not one of its ends", () => {
    expectClear(renderGraph(column, { waveTitles: { "wave-1": "apply-wave-1", "wave-2": "apply-wave-2", "wave-3": "apply-wave-3" } }).svg);
  });

  it("no edge passes over a box title", () => {
    const svg = renderGraph(column, { waveTitles: { "wave-1": "apply-wave-1", "wave-2": "apply-wave-2", "wave-3": "apply-wave-3" } }).svg;
    const { labels } = svgGeometry(svg);
    for (const e of drawnEdges(svg)) {
      const pts = samplePath(e.d);
      for (const t of labels) expect(pts.filter((p) => inRect(t, p)), `${e.from} -> ${e.to} over a title`).toEqual([]);
    }
  });

  it("the plain wave view (no wave titles) is routed the same way", () => {
    expectClear(renderGraph(column).svg);
  });

  it("the logical lens routes its edges too", () => {
    const ir: GraphIR = {
      nodes: [
        { id: "a", kind: "AWS::EC2::VPC", lexicon: "aws", attrs: {} },
        { id: "b", kind: "AWS::EC2::Subnet", lexicon: "aws", attrs: {} },
        { id: "c", kind: "AWS::EC2::Instance", lexicon: "aws", attrs: {} },
      ],
      edges: [
        { from: "c", to: "b", kind: "ref" },
        { from: "b", to: "a", kind: "ref" },
        { from: "c", to: "a", kind: "ref" },
      ],
      groups: {},
    };
    expectClear(renderArchitecture(ir, { box: ["a", "b", "c"] }).svg);
  });
});
