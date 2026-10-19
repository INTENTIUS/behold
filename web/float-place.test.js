// behold#764: every floating dialog of the kiosk stays inside what can be seen.
import { describe, expect, it } from "vitest";
import { FLOAT_MARGIN, fitsIn, placeFloat, shiftInto } from "./float-place.js";
import { placePopover } from "./kiosk-popover.js";
import { placeBeside } from "./kiosk-watch.js";
import { placeTip } from "./tooltip.js";
import { tipSpot } from "./kiosk-event-help-ui.js";

const box = (left, top, width, height) => ({ left, top, width, height });
const overlaps = (a, b) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

describe("shiftInto", () => {
  const view = box(0, 0, 1000, 600);
  it("leaves a rect inside alone, and moves one outside by as little as brings it in", () => {
    expect(shiftInto(box(100, 100, 200, 100), view)).toEqual({ dx: 0, dy: 0 });
    expect(shiftInto(box(100, -331, 262, 31), view)).toEqual({ dx: 0, dy: 339 });
    expect(shiftInto(box(-105, 373, 390, 46), view)).toEqual({ dx: 113, dy: 0 });
    expect(shiftInto(box(900, 580, 200, 40), view)).toEqual({ dx: -108, dy: -28 });
  });
  it("keeps the top and left edges in for a rect bigger than the view", () => {
    expect(shiftInto(box(50, -94, 2000, 900), view)).toEqual({ dx: -42, dy: 102 });
  });
  it("works in a view that does not start at 0", () => {
    expect(shiftInto(box(0, 0, 50, 50), box(100, 80, 400, 300), 4)).toEqual({ dx: 104, dy: 84 });
  });
});

describe("placeFloat", () => {
  const view = box(0, 0, 1356, 686); // the kiosk's graph frame at 1366x768
  const size = { width: 412, height: 141 };
  const sides = [["right"], ["left"], ["below"], ["above"]];

  it("a wave 3 card at the very top of the view: no side puts the dialog past the top", () => {
    const card = box(574, 8, 110, 50);
    for (const [s] of sides) {
      const p = placeFloat(card, size, view, { sides: [s, "below"] });
      expect(fitsIn({ ...p, ...size }, view)).toBe(true);
    }
    // Asked for above first, with no room there, it goes below.
    expect(placeFloat(card, size, view, { sides: ["above", "below"] }).side).toBe("below");
  });

  it("flips to the side with room: below when there is none above, beside when that fits better", () => {
    expect(placeFloat(box(500, 20, 300, 60), { width: 300, height: 200 }, box(0, 0, 1000, 700), { sides: ["above", "below"] })).toMatchObject({ side: "below", top: 92 });
    // A card as wide as the view, at its top: no room above or below for a tall dialog; to its side when that has room.
    const p = placeFloat(box(20, 10, 600, 650), { width: 300, height: 400 }, box(0, 0, 1000, 700), { sides: ["above", "below", "right"] });
    expect(p.side).toBe("right");
    expect(fitsIn({ ...p, width: 300, height: 400 }, box(0, 0, 1000, 700))).toBe(true);
  });

  it("never covers its anchor when a side has room, and keeps its leader's end on the anchor", () => {
    const card = box(574, 84, 110, 50);
    const p = placeFloat(card, size, view);
    expect(overlaps({ ...p, ...size }, card)).toBe(false);
    expect(p.side).toBe("right");
    // The notch points at the card's middle, along the dialog's near edge.
    expect(p.top + p.arrow).toBe(card.top + card.height / 2);
  });

  it("a dialog taller than the view is capped there, its top inside the view", () => {
    const p = placeFloat(box(400, 300, 300, 80), { width: 442, height: 900 }, view);
    expect(p.maxHeight).toBe(686 - 2 * FLOAT_MARGIN);
    expect(p.top).toBe(FLOAT_MARGIN);
    expect(fitsIn({ left: p.left, top: p.top, width: 442, height: p.maxHeight }, view)).toBe(true);
    expect(placeFloat(box(400, 300, 300, 80), size, view).maxHeight).toBeNull();
  });

  it("stays inside the view for any anchor, at both kiosk sizes", () => {
    for (const v of [box(0, 0, 1910, 981), box(0, 0, 1356, 686), box(5, 77, 1356, 400)]) {
      for (let x = -200; x < v.width + 200; x += 97) {
        for (let y = -200; y < v.height + 200; y += 89) {
          for (const s of [size, { width: 535, height: 771 }, { width: 30, height: 20 }]) {
            const p = placeFloat(box(x, y, 110, 50), s, v);
            const h = p.maxHeight || s.height;
            expect(fitsIn({ left: p.left, top: p.top, width: Math.min(s.width, v.width - 16), height: h }, v)).toBe(true);
          }
        }
      }
    }
  });
});

describe("the dialogs that use it", () => {
  it("the card popover: right of a top-row card, inside the frame, capped when taller", () => {
    const frame = { width: 1356, height: 686 };
    const p = placePopover(box(574, 84, 110, 50), { width: 412, height: 141 }, frame);
    expect(p).toMatchObject({ side: "right", left: 696, top: 84, maxHeight: null });
    const tall = placePopover(box(574, 0, 110, 50), { width: 412, height: 900 }, frame);
    expect(tall.top).toBe(8);
    expect(tall.maxHeight).toBe(670);
  });

  it("the job box's drawer, opened taller than the graph above the caption: kept below the view's top, capped (was 94px off it)", () => {
    // 1366x768: the graph shows from 77px to the caption's top at 480px; the drawer opened is 569px tall.
    const view = { x: 5, y: 77, w: 1356, h: 403 };
    const p = placeBeside({ x: 120, y: 250, w: 920, h: 300 }, { w: 442, h: 569 }, view);
    expect(p.y).toBeGreaterThanOrEqual(view.y + 8);
    expect(p.maxHeight).toBe(403 - 16);
    expect(p.y + p.maxHeight).toBeLessThanOrEqual(view.y + view.h - 8);
    // Its old "below" spot was 18px under a wave box low in the view: now it never runs past the top for that either.
    const low = placeBeside({ x: 0, y: 300, w: 1356, h: 160 }, { w: 442, h: 300 }, view);
    expect(low.y).toBeGreaterThanOrEqual(view.y + 8);
    expect(low.y + 300).toBeLessThanOrEqual(view.y + view.h - 8);
  });

  it("the tooltip: inside the window when it fits neither below nor above", () => {
    const p = placeTip({ left: 100, right: 140, top: 300, bottom: 320 }, { width: 200, height: 500 }, { width: 800, height: 600 });
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + 500).toBeLessThanOrEqual(600 - 8 + 0.5);
  });

  it("an event-help tip under a card low in the window stays inside its bottom", () => {
    const p = tipSpot({ left: 400, top: 10, width: 300, height: 700 }, { w: 240, h: 30 }, { w: 1440, h: 760 });
    expect(p.below).toBe(true);
    expect(p.y + 30).toBeLessThanOrEqual(760 - 8);
  });
});
