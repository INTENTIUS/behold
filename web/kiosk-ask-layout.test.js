import { describe, expect, it } from "vitest";
import { BOX_GAP, PAD, TITLE, askLayout, orderRoots } from "./kiosk-ask-layout.js";
import { askDeltas } from "./kiosk-estate-scene.js";

const card = (id, w = 200, h = 64) => ({ id, w, h });

describe("ask mode's stack of roots (behold#940)", () => {
  it("puts upstream first, and keeps the given order where nothing orders it", () => {
    expect(orderRoots(["edge", "app", "network"], [{ from: "network", to: "app" }, { from: "app", to: "edge" }])).toEqual(["network", "app", "edge"]);
    expect(orderRoots(["b", "a", "c"], [])).toEqual(["b", "a", "c"]);
    // A cycle does not hang: the given order.
    expect(orderRoots(["a", "b"], [{ from: "a", to: "b" }, { from: "b", to: "a" }])).toEqual(["a", "b"]);
  });

  it("stacks the roots in order, each box holding its cards", () => {
    const l = askLayout([{ id: "n", cards: [card("n1"), card("n2")] }, { id: "a", cards: [card("a1"), card("a2"), card("a3")] }], { width: 1920, height: 760 });
    expect(l.boxes.n.y).toBe(0);
    expect(l.boxes.a.y).toBeGreaterThan(l.boxes.n.y + l.boxes.n.h);
    for (const [id, box] of [["n1", "n"], ["a3", "a"]]) {
      const c = l.cards[id];
      const b = l.boxes[box];
      expect(c.x).toBeGreaterThanOrEqual(b.x + PAD);
      expect(c.x + c.w).toBeLessThanOrEqual(b.x + b.w);
      expect(c.y).toBeGreaterThanOrEqual(b.y + TITLE);
      expect(c.y + c.h).toBeLessThanOrEqual(b.y + b.h);
    }
  });

  it("uses the height of a 1920x1080 screen: three roots of 3, 6 and 3 cards do not sit in one row", () => {
    const roots = [{ id: "n", cards: ["a", "b", "c"].map((k) => card(`n${k}`)) }, { id: "a", cards: ["a", "b", "c", "d", "e", "f"].map((k) => card(`a${k}`, 200, 110)) }, { id: "e", cards: ["a", "b", "c"].map((k) => card(`e${k}`)) }];
    const room = { width: 1920, height: 740 };
    const stacked = askLayout(roots, room);
    // The graph's own layout: the roots side by side in one row.
    const oneRow = 12 * 218 + 3 * 2 * PAD + 2 * BOX_GAP;
    const rowScale = Math.min(room.width / oneRow, room.height / (TITLE + 110 + PAD));
    expect(stacked.scale).toBeGreaterThan(rowScale * 1.5);
    expect(stacked.height).toBeGreaterThan(stacked.width / 4);
    // Every box is as wide as its cards need, and the stack fits the room's shape.
    expect(stacked.width * stacked.scale).toBeLessThanOrEqual(room.width + 0.5);
    expect(stacked.height * stacked.scale).toBeLessThanOrEqual(room.height + 0.5);
  });

  it("wraps into columns only when it gains", () => {
    const one = askLayout([{ id: "a", cards: [card("a")] }], { width: 1000, height: 1000 });
    expect(one.cols).toBe(1);
    const tall = askLayout([{ id: "a", cards: Array.from({ length: 8 }, (_, i) => card(`c${i}`)) }], { width: 1900, height: 300 });
    expect(tall.cols).toBeGreaterThan(3);
  });

  it("leaves room under a card for what hangs from it", () => {
    const l = askLayout([{ id: "a", cards: [card("x", 200, 64 + 66), card("y", 200, 64)] }], { width: 400, height: 1000 });
    // One column: the second card starts below the first's slots.
    expect(l.cols).toBe(1);
    expect(l.cards.y.y).toBeGreaterThanOrEqual(l.cards.x.y + 130);
  });
});

describe("the deltas that stack the drawn graph (behold#940)", () => {
  const roots = [{ member: "m", name: "app", path: "app" }, { member: "m", name: "network", path: "network" }];
  const nodes = new Map([
    ["m/app/a", { rect: { x: 400, y: 100, w: 150, h: 60 } }],
    ["m/app/b", { rect: { x: 560, y: 100, w: 150, h: 60 } }],
    ["m/network/n", { rect: { x: 40, y: 100, w: 150, h: 60 } }],
    ["stray", { rect: { x: 0, y: 0, w: 10, h: 10 } }],
  ]);
  const boxes = new Map([["box:app", { x: 380, y: 60, w0: 350, h0: 120 }], ["box:network", { x: 20, y: 60, w0: 190, h0: 120 }]]);

  it("moves each root below the one it reads, and each card into its box", () => {
    const got = askDeltas({ roots, nodes, boxes, edges: [{ from: "network", to: "app" }], open: { width: 800, height: 600 } });
    const at = (id, base) => ({ x: base.x + got.deltas[id].dx, y: base.y + got.deltas[id].dy });
    const net = { ...at("box:network", boxes.get("box:network")), w: boxes.get("box:network").w0 + got.deltas["box:network"].dw };
    const app = at("box:app", boxes.get("box:app"));
    expect(net.y).toBeLessThan(app.y);
    const n = at("m/network/n", nodes.get("m/network/n").rect);
    expect(n.x).toBeGreaterThanOrEqual(net.x);
    expect(n.y).toBeGreaterThan(net.y);
    expect(got.deltas.stray).toBeUndefined();
  });

  it("is null when no root has a box and cards", () => {
    expect(askDeltas({ roots, nodes: new Map(), boxes, open: { width: 1, height: 1 } })).toBeNull();
  });
});
