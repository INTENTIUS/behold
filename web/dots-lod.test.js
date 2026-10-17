import { describe, it, expect } from "vitest";
import { LOD, bandT, smooth, cardMorph, discMorph, morphPoint, discRadius, levelOf, caption, railMarks, railPos } from "./dots-lod.js";

describe("dots level of detail (#712)", () => {
  it("is a card at or above the card size and a dot at or below the dot size", () => {
    expect(cardMorph(LOD.cardPx)).toBe(0);
    expect(cardMorph(200)).toBe(0);
    expect(cardMorph(LOD.dotPx)).toBe(1);
    expect(cardMorph(5)).toBe(1);
  });
  it("morphs in between by the zoom, monotonically, with no jump at either end", () => {
    let prev = 0;
    for (let px = 90; px >= 24; px -= 0.5) {
      const t = cardMorph(px);
      expect(t).toBeGreaterThanOrEqual(prev);
      expect(t - prev).toBeLessThan(0.05);
      prev = t;
    }
    expect(cardMorph(89.9)).toBeLessThan(0.001);
    expect(cardMorph(24.1)).toBeGreaterThan(0.999);
  });
  it("is a function of the size alone, so stopping halfway stays halfway and zooming back reverses it", () => {
    const mid = Math.sqrt(90 * 24);
    expect(cardMorph(mid)).toBeCloseTo(0.5, 5);
    expect(cardMorph(mid)).toBe(cardMorph(mid));
  });
  it("switches at a threshold with no in-between under reduced motion", () => {
    const vals = new Set();
    for (let px = 100; px > 10; px -= 1) vals.add(cardMorph(px, { reduced: true }));
    expect([...vals].sort()).toEqual([0, 1]);
    expect(discMorph(LOD.discPx - 1, { reduced: true })).toBe(1);
    expect(discMorph(LOD.discPx + 1, { reduced: true })).toBe(0);
  });
  it("condenses an estate's dots into a disc below the disc size", () => {
    expect(discMorph(LOD.discFromPx)).toBe(0);
    expect(discMorph(LOD.discPx)).toBe(1);
    expect(discMorph((LOD.discFromPx + LOD.discPx) / 2)).toBeGreaterThan(0);
  });
  it("bandT and smooth stay in [0, 1]", () => {
    expect(bandT(0, 90, 24)).toBe(1);
    expect(bandT(NaN, 90, 24)).toBe(1);
    expect(smooth(-1)).toBe(0);
    expect(smooth(2)).toBe(1);
  });
  it("interpolates a dot from its card through its slot to its disc", () => {
    const card = { x: 0, y: 0 };
    const slot = { x: 10, y: 0 };
    const disc = { x: 10, y: 10 };
    expect(morphPoint(card, slot, disc, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(morphPoint(card, slot, disc, 1, 0)).toEqual({ x: 10, y: 0 });
    expect(morphPoint(card, slot, disc, 0.5, 0)).toEqual({ x: 5, y: 0 });
    expect(morphPoint(card, slot, disc, 1, 1)).toEqual({ x: 10, y: 10 });
    expect(morphPoint(null, slot, disc, 0, 0)).toEqual({ x: 10, y: 0 });
  });
  it("sizes a disc so its area is proportional to its resource count", () => {
    const a = (n) => Math.PI * discRadius(n, 1) ** 2;
    expect(a(400) / a(100)).toBeCloseTo(4, 6);
    expect(discRadius(0, 1)).toBe(0);
  });
  it("names the level and the marks", () => {
    expect(levelOf(0, [])).toBe("cards");
    expect(levelOf(0.4, [0])).toBe("cards-dots");
    expect(levelOf(1, [0, 0])).toBe("dots");
    expect(levelOf(1, [0, 1])).toBe("dots-discs");
    expect(levelOf(1, [1, 1])).toBe("discs");
    expect(caption("dots")).toMatch(/each dot is a resource/);
    expect(caption("discs")).toMatch(/each disc is an estate, sized by resources/);
  });
  it("orders the rail's marks and places the camera on them", () => {
    const m = railMarks({ paneW: 1000, paneH: 800, cardW: 300, sceneW: 20000, sceneH: 8000, smallestBox: 2000, largestBox: 6000 });
    expect(m.cards).toBeLessThan(m.resources);
    expect(m.resources).toBeLessThan(m.estates);
    expect(railPos(m.cards, m)).toBe(0);
    expect(railPos(m.resources, m)).toBeCloseTo(0.5, 6);
    expect(railPos(m.estates, m)).toBe(1);
    expect(railPos(m.estates * 10, m)).toBe(1);
  });
});
