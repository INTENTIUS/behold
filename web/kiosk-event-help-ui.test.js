import { describe, expect, it } from "vitest";
import { tipSpot } from "./kiosk-event-help-ui.js";

// behold#695: a tip stands clear of the frame's edge labels where it can.
describe("tipSpot", () => {
  const box = { left: 400, top: 300, width: 300, height: 200 }; // a wave box
  const size = { w: 240, h: 30 };
  const win = { w: 1440 };

  it("stands above the box, centred, when nothing is in the way", () => {
    expect(tipSpot(box, size, win)).toEqual({ x: 430, y: 258, below: false, arrow: 120 });
  });

  it("goes below when there is no room above", () => {
    expect(tipSpot({ ...box, top: 20 }, size, win)).toMatchObject({ y: 232, below: true });
  });

  it("moves along the box's top when the centred spot covers an edge label", () => {
    // A read's label over the middle of the box's top, as the demo's "edge reads app's applied state" sits.
    const label = { x: 520, y: 255, w: 90, h: 24 };
    const p = tipSpot(box, size, win, [label]);
    expect(p.below).toBe(false);
    expect(p.y).toBe(258);
    const clear = p.x + size.w <= label.x || p.x >= label.x + label.w || p.y + size.h <= label.y || p.y >= label.y + label.h;
    expect(clear).toBe(true);
    // The notch still points at the box's middle as far as the tip reaches.
    expect(p.arrow).toBe(Math.max(12, Math.min(size.w - 12, 550 - p.x)));
  });

  it("lifts the tip above a label that spans the box's top", () => {
    const wide = { x: 380, y: 360, w: 360, h: 24 };
    const p = tipSpot({ ...box, top: 400 }, size, win, [wide, { x: 380, y: 615, w: 360, h: 24 }]);
    expect(p).toMatchObject({ y: 360 - 30 - 6, below: false });
  });

  it("takes the spot covering least when none is clear", () => {
    // Above, the tip overlaps the label by 32px of its height; below, by 10px.
    const labels = [{ x: 0, y: 0, w: 1440, h: 290 }, { x: 0, y: 532, w: 1440, h: 400 }];
    const p = tipSpot(box, size, win, labels);
    expect(p).toMatchObject({ y: 512, below: true });
  });
});
