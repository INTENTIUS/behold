import { describe, it, expect } from "vitest";
import { perimeter, pointAt, nearestS, segment } from "./dots-border.js";

const b = { x: 0, y: 0, w: 10, h: 4 };
describe("estate box borders (#712)", () => {
  it("walks the border clockwise from the top-left corner", () => {
    expect(perimeter(b)).toBe(28);
    expect(pointAt(b, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAt(b, 10)).toEqual({ x: 10, y: 0 });
    expect(pointAt(b, 12)).toEqual({ x: 10, y: 2 });
    expect(pointAt(b, 19)).toEqual({ x: 5, y: 4 });
    expect(pointAt(b, 26)).toEqual({ x: 0, y: 2 });
    expect(pointAt(b, 28 + 12)).toEqual({ x: 10, y: 2 });
    expect(pointAt(b, -2)).toEqual({ x: 0, y: 2 });
  });
  it("finds the nearest border point, inside or outside", () => {
    expect(nearestS(b, { x: 5, y: -3 })).toBe(5);
    expect(nearestS(b, { x: 9.5, y: 2 })).toBe(12);
    expect(pointAt(b, nearestS(b, { x: 5, y: 3.8 }))).toEqual({ x: 5, y: 4 });
    expect(pointAt(b, nearestS(b, { x: 0.2, y: 2 }))).toEqual({ x: 0, y: 2 });
  });
  it("bends a segment round the corners it passes, either way", () => {
    expect(segment(b, 8, 4)).toEqual([{ x: 8, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 2 }]);
    expect(segment(b, 2, -4)).toEqual([{ x: 2, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 2 }]);
    expect(segment(b, 3, 0)).toEqual([]);
  });
});
