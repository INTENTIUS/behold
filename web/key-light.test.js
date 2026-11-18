// behold#1163: lighting the estate graph by graph key.
import { describe, expect, it } from "vitest";
import { READABLE_CARD_PX, boxGap, cardIndex, cardMarks, edgeMark, focusLayout, frameBox, lightKeys, paneScale, reserveBox, viewShare, wantsFocus, zoomFrame } from "./key-light.js";

const NODES = [
  { id: "dns/zone" },
  { id: "dns/RecordSet ×2", attrs: { _stackOf: [{ id: "dns/awsRecord" }, { id: "dns/gcpRecord" }, { id: 7 }] } },
  { id: "gcp/webRule" },
  { attrs: {} },
];

describe("cardIndex", () => {
  it("maps each card to itself and each folded resource to its stacked card", () => {
    const cards = cardIndex(NODES);
    expect([...cards]).toEqual([
      ["dns/zone", "dns/zone"],
      ["dns/RecordSet ×2", "dns/RecordSet ×2"],
      ["dns/awsRecord", "dns/RecordSet ×2"],
      ["dns/gcpRecord", "dns/RecordSet ×2"],
      ["gcp/webRule", "gcp/webRule"],
    ]);
  });

  it("keeps a card's own id when a stack also names it", () => {
    const cards = cardIndex([{ id: "a" }, { id: "s", attrs: { _stackOf: [{ id: "a" }] } }]);
    expect(cards.get("a")).toBe("a");
  });
});

describe("lightKeys", () => {
  const cards = cardIndex(NODES);
  it("lights the cards an answer's keys and string cells name, once each, in order", () => {
    expect(lightKeys({ keys: ["dns/gcpRecord", "cloud/aws/x/i-1"], rows: [{ reaches: "gcp/webRule", n: 3, again: "dns/awsRecord" }] }, cards)).toEqual(["dns/RecordSet ×2", "gcp/webRule"]);
  });
  it("lights nothing for an answer of indexed objects only", () => {
    expect(lightKeys({ keys: ["cloud/aws/000000000000/x/aws/000000000000/us-east-1/AWS::S3::Bucket/b"], rows: [{ key: "cloud/aws/x", kind: "AWS::S3::Bucket" }] }, cards)).toEqual([]);
    expect(lightKeys({}, cards)).toEqual([]);
  });
});

describe("cardMarks and edgeMark", () => {
  it("marks lit and dim cards, and the edges between lit cards as a path", () => {
    const marks = cardMarks(["a", "b", "c"], ["a", "c"]);
    expect([...marks]).toEqual([
      ["a", "lit"],
      ["b", "dim"],
      ["c", "lit"],
    ]);
    expect(edgeMark(marks, "a", "c")).toBe("path");
    expect(edgeMark(marks, "a", "b")).toBe("dim");
  });
  it("marks nothing when nothing is lit, so an index-only answer leaves the estate as drawn", () => {
    expect(cardMarks(["a", "b"], []).size).toBe(0);
    expect(edgeMark(new Map(), "a", "b")).toBeNull();
  });
});

describe("frameBox", () => {
  const full = { x: 0, y: 0, width: 2000, height: 3000 };
  it("is the whole graph when there is nothing to frame", () => {
    expect(frameBox([], full)).toEqual(full);
  });
  it("frames the boxes with padding, at least `min` on a side, inside the graph", () => {
    expect(frameBox([{ x: 100, y: 100, width: 200, height: 100 }], full, { pad: 50, min: 400 })).toEqual({ x: 0, y: 0, width: 400, height: 400 });
    expect(frameBox([{ x: 1000, y: 1000, width: 200, height: 100 }, { x: 1500, y: 1400, width: 100, height: 100 }], full, { pad: 50, min: 400 })).toEqual({ x: 950, y: 950, width: 700, height: 600 });
    expect(frameBox([{ x: 1900, y: 2950, width: 100, height: 50 }], full, { pad: 50, min: 400 })).toEqual({ x: 1600, y: 2600, width: 400, height: 400 });
  });
  it("is never larger than the graph", () => {
    expect(frameBox([{ x: -10, y: -10, width: 5000, height: 5000 }], full)).toEqual(full);
  });
});

describe("zoomFrame (#1175, #1190)", () => {
  // The ask demo's estate, and the cards its DNS question lights: the records at the top, four GCP cards near the bottom.
  const full = { x: 0, y: 0, width: 2576, height: 3234 };
  const record = { x: 457, y: 116, width: 202, height: 68 };
  const gcp = [
    { x: 1076, y: 2146, width: 190, height: 68 },
    { x: 1330, y: 2146, width: 237, height: 68 },
    { x: 1185, y: 1954, width: 249, height: 84 },
    { x: 1356, y: 2286, width: 184, height: 68 },
  ];
  const inside = (b, v) => b.x >= v.x && b.y >= v.y && b.x + b.width <= v.x + v.width && b.y + b.height <= v.y + v.height;

  it("measures shares", () => {
    expect(viewShare({ x: 0, y: 0, width: 1288, height: 323.4 }, full)).toBe(0.5);
  });

  it("frames every lit card", () => {
    const near = [gcp[0], gcp[1]];
    expect(zoomFrame(near, full)).toEqual(frameBox(near, full));
  });

  it("keeps both ends of an answer in view when they sit far apart, though that zooms in little", () => {
    const box = zoomFrame([record, ...gcp], full);
    expect(box).toEqual(frameBox([record, ...gcp], full));
    for (const b of [record, ...gcp]) expect(inside(b, box)).toBe(true);
    expect(viewShare(box, full)).toBeLessThan(1);
  });

  it("is the whole graph with nothing to frame", () => {
    expect(zoomFrame([], full)).toEqual(full);
    expect(zoomFrame(null, full)).toEqual(full);
  });
});

describe("the focused view of a spread answer (behold#1203)", () => {
  const b = (x, y, width = 200, height = 68) => ({ x, y, width, height });
  // The DNS answer as recorded: the records' stack at the top, the GCP cards near the bottom.
  const cards = [
    { id: "dns/RecordSet ×4", box: b(457, 116, 202, 68) },
    { id: "gcp/webRule", box: b(1185, 1954, 249, 84) },
    { id: "gcp/webAddress", box: b(1076, 2146, 190, 68) },
    { id: "gcp/webProxy", box: b(1330, 2146, 237, 68) },
    { id: "gcp/webUrlMap", box: b(1356, 2286, 184, 68) },
  ];
  const edges = [
    { from: "gcp/webRule", to: "gcp/webAddress" },
    { from: "gcp/webRule", to: "gcp/webProxy" },
    { from: "gcp/webProxy", to: "gcp/webUrlMap" },
    { from: "dns/zone", to: "gcp/webRule" },
  ];
  const full = { x: 0, y: 0, width: 2576, height: 3234 };

  it("keeps each group's arrangement, sets the groups close in a row or a column, and keeps only the estate graph's edges between the cards", () => {
    const wide = focusLayout(cards, edges, { pane: { width: 860, height: 525 } });
    expect(wide.groups).toBe(2);
    const at = (l, id) => {
      const c = cards.find((x) => x.id === id).box;
      const d = l.shift.get(id);
      return { x: c.x + d.dx, y: c.y + d.dy };
    };
    // Inside a group, the cards keep where they sit to each other.
    expect(at(wide, "gcp/webProxy").x - at(wide, "gcp/webRule").x).toBe(1330 - 1185);
    expect(at(wide, "gcp/webUrlMap").y - at(wide, "gcp/webProxy").y).toBe(2286 - 2146);
    // A wide pane: the groups side by side, 80 apart, in reading order.
    expect(at(wide, "gcp/webAddress").x).toBe(202 + 80);
    expect(wide.box).toEqual({ x: -40, y: -40, width: 202 + 80 + 491 + 80, height: 400 + 80 });
    // A tall pane: one under the other.
    const tall = focusLayout(cards, edges, { pane: { width: 390, height: 500 } });
    expect(at(tall, "dns/RecordSet ×4").y).toBe(0);
    expect(at(tall, "gcp/webRule").y).toBe(68 + 80);
    // The three edges between two of the cards move with their group; the one to a card that is not lit is left out.
    expect(wide.kept.map((e) => `${e.from} ${e.to}`)).toEqual(["gcp/webRule gcp/webAddress", "gcp/webRule gcp/webProxy", "gcp/webProxy gcp/webUrlMap"]);
    expect(wide.kept[0]).toMatchObject(wide.shift.get("gcp/webRule"));
    expect(wide.cross).toEqual([]);
  });

  it("draws an edge between two groups straight, from one card's side to the other's", () => {
    const l = focusLayout([{ id: "a", box: b(0, 0, 100, 50) }, { id: "z", box: b(2000, 0, 100, 50) }], [{ from: "a", to: "z" }, { from: "a", to: "z" }], { pane: { width: 800, height: 400 } });
    expect(l.groups).toBe(2);
    expect(l.cross).toEqual([{ from: "a", to: "z", d: "M 100 25 L 180 25" }]);
    expect(focusLayout([], [], {}).groups).toBe(0);
  });

  it("is wanted only for a few cards that framing whole would leave too small, where it shows them half as large again", () => {
    const pane = { width: 860, height: 525 };
    const layout = focusLayout(cards, edges, { pane });
    expect(READABLE_CARD_PX).toBe(40);
    expect(wantsFocus(cards, 50, full, pane, layout)).toBe(true);
    // Most of the estate lit (the load turn): the whole estate.
    expect(wantsFocus(cards, 8, full, pane, layout)).toBe(false);
    // Cards that sit together: one group, framing reads.
    const near = cards.slice(1);
    expect(wantsFocus(near, 50, full, pane, focusLayout(near, edges, { pane }))).toBe(false);
    // A pane big enough to read the whole frame.
    expect(wantsFocus(cards, 50, full, { width: 4000, height: 5000 }, focusLayout(cards, edges, { pane: { width: 4000, height: 5000 } }))).toBe(false);
    expect(wantsFocus([cards[0]], 50, full, pane, layout)).toBe(false);
  });

  it("leaves room for the pane's controls and caption, centred across", () => {
    const { box, scale } = reserveBox({ x: 0, y: 0, width: 400, height: 200 }, { width: 800, height: 600 }, { top: 50, bottom: 50 });
    expect(scale).toBe(2);
    expect(box).toEqual({ x: 0, y: -50, width: 400, height: 300 });
    expect(paneScale({ width: 100, height: 50 }, { width: 300, height: 300 })).toBe(3);
    expect(boxGap(b(0, 0, 10, 10), b(30, 5, 10, 10))).toBe(20);
  });
});
