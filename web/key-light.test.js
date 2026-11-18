// behold#1163: lighting the estate graph by graph key.
import { describe, expect, it } from "vitest";
import { boxClusters, boxGap, cardIndex, cardMarks, edgeMark, frameBox, lightKeys, viewShare, zoomFrame } from "./key-light.js";

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

describe("zoomFrame (#1175)", () => {
  // The ask demo's estate, and the cards its DNS question lights: one at the top, four together near the bottom.
  const full = { x: 0, y: 0, width: 2576, height: 3234 };
  const record = { x: 457, y: 116, width: 202, height: 68 };
  const gcp = [
    { x: 1076, y: 2146, width: 190, height: 68 },
    { x: 1330, y: 2146, width: 237, height: 68 },
    { x: 1185, y: 1954, width: 249, height: 84 },
    { x: 1356, y: 2286, width: 184, height: 68 },
  ];

  it("measures gaps and shares", () => {
    expect(boxGap({ x: 0, y: 0, width: 10, height: 10 }, { x: 30, y: 5, width: 10, height: 10 })).toBe(20);
    expect(boxGap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(0);
    expect(viewShare({ x: 0, y: 0, width: 1288, height: 323.4 }, full)).toBe(0.5);
  });

  it("groups cards that sit close together, in reading order", () => {
    const groups = boxClusters([...gcp, record, { x: Number.NaN, y: 0, width: 1, height: 1 }], 320);
    expect(groups.map((g) => g.length)).toEqual([1, 4]);
    expect(groups[0]).toEqual([record]);
    expect(groups[1][0]).toEqual(gcp[2]);
  });

  it("frames every lit card when that zooms in enough", () => {
    const near = [gcp[0], gcp[1]];
    expect(zoomFrame(near, full)).toEqual(frameBox(near, full));
  });

  it("frames the largest group when every lit card would hardly zoom, and the cards outside it stay out of the frame", () => {
    expect(viewShare(frameBox([record, ...gcp], full), full)).toBeGreaterThan(0.6);
    const box = zoomFrame([record, ...gcp], full);
    expect(box).toEqual(frameBox(gcp, full));
    expect(viewShare(box, full)).toBeLessThan(0.3);
  });

  it("takes the group read first when two are as large", () => {
    const top = { x: 100, y: 100, width: 200, height: 60 };
    const bottom = { x: 2200, y: 3000, width: 200, height: 60 };
    expect(zoomFrame([bottom, top], full)).toEqual(frameBox([top], full));
  });

  it("still zooms in when the largest group is spread wide, keeping its first card in view", () => {
    // A chain of cards across the whole graph: one group, as wide as the graph.
    const chain = Array.from({ length: 12 }, (_, i) => ({ x: i * 210, y: 1500, width: 200, height: 60 }));
    const box = zoomFrame(chain, full);
    expect(viewShare(box, full)).toBeCloseTo(0.6);
    expect(box.x).toBeLessThanOrEqual(chain[0].x);
    expect(box.x + box.width).toBeGreaterThanOrEqual(chain[0].x + chain[0].width);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeLessThanOrEqual(1500);
    expect(box.y + box.height).toBeGreaterThanOrEqual(1560);
  });

  it("zooms in on a small graph too, where `min` would cover it", () => {
    const small = { x: 0, y: 0, width: 500, height: 400 };
    const box = zoomFrame([{ x: 40, y: 40, width: 100, height: 50 }], small);
    expect(viewShare(box, small)).toBeCloseTo(0.6);
    expect(box).toMatchObject({ x: 0, y: 0 });
  });

  it("is the whole graph with nothing to frame", () => {
    expect(zoomFrame([], full)).toEqual(full);
    expect(zoomFrame(null, full)).toEqual(full);
  });
});
