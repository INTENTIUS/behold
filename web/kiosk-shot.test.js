// behold#571: Watch mode's camera, as arithmetic: where a shot puts its
// target, how a move goes, and which messages the frame takes.
import { describe, expect, it } from "vitest";
import { SHOT_MS, ease, sameViewBox, shotFromMessage, shotMessage, shotViewBox, tweenViewBox, unionBox } from "./kiosk-shot.js";

const pane = { width: 1600, height: 900 };

describe("kiosk shot: where the target lands", () => {
  it("centres the target in the pane's open part, the overlays' insets left out", () => {
    const target = { x: 100, y: 100, x2: 300, y2: 200 };
    const vb = shotViewBox(target, pane, { right: 400, bottom: 200 }, { pad: 0, maxScale: 100 });
    // The open part is 1200 x 700 pixels; the target is 200 x 100 units: 6 pixels a unit, by its width.
    const s = pane.width / vb[2];
    expect(s).toBeCloseTo(6);
    expect(vb[3]).toBeCloseTo(pane.height / s);
    // Its centre (200, 150) sits at the open part's centre, (600, 350) in pixels.
    expect((200 - vb[0]) * s).toBeCloseTo(600);
    expect((150 - vb[1]) * s).toBeCloseTo(350);
  });

  it("zooms in no further than its cap, and keeps the pane's aspect ratio", () => {
    const vb = shotViewBox({ x: 0, y: 0, x2: 10, y2: 10 }, pane, {}, { pad: 0, maxScale: 1.5 });
    expect(pane.width / vb[2]).toBeCloseTo(1.5);
    expect(vb[2] / vb[3]).toBeCloseTo(pane.width / pane.height);
  });

  it("drops insets that would leave less than a third of the pane", () => {
    const wide = shotViewBox({ x: 0, y: 0, x2: 100, y2: 100 }, pane, { right: 1200 }, { pad: 0, maxScale: 100 });
    const none = shotViewBox({ x: 0, y: 0, x2: 100, y2: 100 }, pane, {}, { pad: 0, maxScale: 100 });
    expect(wide).toEqual(none);
  });

  it("answers nothing without a target or a pane", () => {
    expect(shotViewBox(null, pane)).toBeNull();
    expect(shotViewBox({ x: 0, y: 0, x2: 1, y2: 1 }, { width: 0, height: 10 })).toBeNull();
  });

  it("unions boxes, skipping the ones it cannot read", () => {
    expect(unionBox([{ x: 0, y: 5, x2: 10, y2: 6 }, null, { x: -2, y: 1, x2: 3, y2: 4 }])).toEqual({ x: -2, y: 1, x2: 10, y2: 6 });
    expect(unionBox([null])).toBeNull();
  });
});

describe("kiosk shot: the move", () => {
  it("eases in and out, from 0 to 1", () => {
    expect([ease(-1), ease(0), ease(0.5), ease(1), ease(2)]).toEqual([0, 0, 0.5, 1, 1]);
    expect(ease(0.25)).toBeLessThan(0.25);
    expect(ease(0.75)).toBeGreaterThan(0.75);
  });

  it("starts at the first viewBox, ends at the second, and zooms on a log scale between", () => {
    const a = [0, 0, 1000, 500];
    const b = [400, 200, 250, 125];
    expect(tweenViewBox(a, b, 0)).toEqual(a);
    expect(tweenViewBox(a, b, 1)).toEqual(b);
    const mid = tweenViewBox(a, b, 0.5);
    // Halfway in time is halfway in zoom: the geometric mean of the widths.
    expect(mid[2]).toBeCloseTo(500);
    expect(mid[2] / mid[3]).toBeCloseTo(2);
    expect(sameViewBox(tweenViewBox(a, b, 1), b)).toBe(true);
    expect(sameViewBox(a, b)).toBe(false);
  });
});

describe("kiosk shot: the messages", () => {
  const host = "https://demo.intentius.io";
  it("says what to frame, the whole graph when it names nothing", () => {
    expect(shotMessage({ waves: [2], insets: { right: 420.4, bottom: 160 } })).toEqual({ type: "behold:shot", id: null, roots: [], waves: [2], whole: false, insets: { top: 0, right: 420, bottom: 160, left: 0 }, ms: SHOT_MS });
    expect(shotMessage({}).whole).toBe(true);
  });

  it("takes a shot only from the host, and Inspect's release as it is", () => {
    const data = shotMessage({ roots: ["app", 3], waves: [1, "x"] });
    expect(shotFromMessage({ origin: host, data }, host)).toMatchObject({ roots: ["app"], waves: [1], whole: false });
    expect(shotFromMessage({ origin: "https://elsewhere.example", data }, host)).toBeNull();
    expect(shotFromMessage({ origin: host, data: { type: "behold:view" } }, host)).toBeNull();
    expect(shotFromMessage({ origin: host, data: { type: "behold:shot", release: true } }, host)).toEqual({ type: "behold:shot", release: true });
  });
});
