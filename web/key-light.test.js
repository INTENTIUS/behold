// behold#1163: lighting the estate graph by graph key.
import { describe, expect, it } from "vitest";
import { cardIndex, cardMarks, edgeMark, frameBox, lightKeys, viewShare, zoomFrame } from "./key-light.js";

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
