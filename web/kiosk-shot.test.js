// behold#571: Watch mode's camera, as arithmetic: where a shot puts its
// target, how a move goes, and which messages the frame takes.
import { describe, expect, it } from "vitest";
import { ASK_MAX_SCALE, HELD_CAPTION_PX, HELD_FILL, HELD_MAX_SCALE, HELD_PAD, HOLD_RESERVE_PX, SHOT_MS, SMALL_STAGE_CARD_PX, ease, heldFrame, heldInsets, heldTarget, holdsStage, medianWidth, sameViewBox, shotFromMessage, shotMessage, shotViewBox, smallStage, tweenViewBox, unionBox } from "./kiosk-shot.js";
import { captionRoom, shotFor } from "./kiosk-watch.js";

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



// One framing on a small stage: three roots' cards in two wave boxes, at the kiosk's 1280 x 800, as web/app.js
// kioskShotBox frames it (heldTarget, heldInsets, heldFrame, the tab's session storage between frames). Nothing a
// step shows sits over the graph in Watch, so the graph has the stage's whole width less the margins.
describe("one framing on a small stage", () => {
  const pane = { width: 1280, height: 720 };
  const key = "demo-cone|components";
  const boxes = [{ x: 0, y: 0, x2: 240, y2: 110 }, { x: 300, y: 0, x2: 620, y2: 110 }];
  const cards = [{ x: 20, y: 30, x2: 220, y2: 95 }, { x: 320, y: 30, x2: 460, y2: 95 }, { x: 470, y: 30, x2: 600, y2: 95 }];
  const whole = heldTarget(boxes, cards);
  const STEPS = ["pull-request", "planned", "merged", "applying", "waiting", "approved", "applied", "reset"];
  const demo = (cycle, step) => ({ cycle, scenario: "cone", step, label: "", started_at: "2026-10-17T10:00:00Z", pull: cycle, commit: step === "pull-request" || step === "planned" ? "2222222" : "3333333" });
  /**
   * What the kiosk's shot carries at each step (web/kiosk.js shotInsets): the caption under the stage, taller with
   * the cone line at planned, the quiet line at the waves and the approval, the counts at applied, and event-help's
   * trail over it as the cycle's beats come in. The right inset is a drawer the viewer opened on a wave at applying.
   * The merge frame's pane is half a pixel off the plan frame's.
   */
  const shot = (step) => {
    const trail = { "pull-request": 0, planned: 0, merged: 22, applying: 22, waiting: 44, approved: 44, applied: 44, reset: 0 }[step];
    const lines = { planned: 22, applying: 20, waiting: 20, applied: 20 }[step] || 0;
    const caption = 150 + lines + trail;
    const right = step === "applying" ? Math.round(0.46 * 1280) + 44 : 0;
    return { insets: { top: 20, right, bottom: caption + 16, left: 20 }, pane: step === "merged" || step === "applying" ? { width: 1280, height: 719.5 } : pane };
  };

  it("counts the stage small when the whole graph draws its cards readably, and a big graph not", () => {
    expect(smallStage(whole, pane, heldInsets({ bottom: 192 }), 140)).toBe(true);
    // 60 roots in a row: the whole graph is a strip of specks.
    expect(smallStage({ x: 0, y: 0, x2: 60 * 220, y2: 500 }, pane, { bottom: 176 }, 180)).toBe(false);
    expect(smallStage(whole, pane, {}, 0)).toBe(false);
    expect(SMALL_STAGE_CARD_PX).toBe(90);
    expect(medianWidth([180, 0, 175, 190])).toBe(180);
  });

  it("holds one viewBox through every step of three cycles, across the frames the kiosk swaps in", () => {
    let stored = null;
    const seen = [];
    for (const cycle of [111, 112, 113]) {
      for (const step of STEPS) {
        expect(typeof shotFor(demo(cycle, step), {}).id).toBe("string");
        const { insets, pane: p } = shot(step);
        const held = stored ? JSON.parse(stored) : null;
        // The kiosk measures the caption's tallest (kiosk-watch.js captionRoom) and sends it with every shot: 150 px, two extra rows, the trail at two lines, 16.
        const ins = heldInsets(insets, 150 + 2 * 22 + 2 * 26 + 16);
        expect(smallStage(whole, p, held ? held.insets : ins, 140)).toBe(true);
        // A frame drawn from another checkout lays the boxes a few units off.
        const target = step === "merged" ? { x: 2, y: 1, x2: 621, y2: 109 } : whole;
        const next = heldFrame(held, { key, pane: p, insets: ins, target });
        stored = JSON.stringify(next);
        seen.push(next);
      }
    }
    expect(seen).toHaveLength(24);
    expect(seen.map((h) => h.reason)).toEqual(["first", ...Array(23).fill("held")]);
    for (const h of seen) expect(sameViewBox(h.vb, seen[0].vb)).toBe(true);
    const [x, y, w, h] = seen[0].vb;
    const s = pane.width / w;
    // Every box stays in view, clear of the tallest caption and of the run's caption at the top.
    expect(x <= whole.x && x + w >= whole.x2).toBe(true);
    expect(y + (20 + HELD_CAPTION_PX) / s <= whole.y + 36).toBe(true);
    expect(y + h - (150 + 22 + 44 + 16) / s >= whole.y2).toBe(true);
  });

  it("would have moved at the merge with a step's own card at the right, the 48 px reserve and an exact pane", () => {
    // Round 3's inputs: the shot's right inset growing at the waves, and the trail's growth past 48 px.
    const a = heldFrame(null, { key, pane, insets: { top: 52, right: 450, bottom: 166 }, target: whole });
    const b = heldFrame(a, { key, pane: { width: 1280, height: 719.5 }, insets: { top: 52, right: 454, bottom: 166 + 70 }, target: whole });
    expect(b.reason).toBe("insets");
    const ha = heldFrame(null, { key, pane, insets: heldInsets({ top: 20, bottom: 166, left: 20 }, 262), target: whole });
    const hb = heldFrame(ha, { key, pane: { width: 1280, height: 719.5 }, insets: heldInsets({ top: 20, right: 454, bottom: 166 + 70, left: 20 }, 262), target: whole });
    expect(hb.reason).toBe("held");
    expect(sameViewBox(hb.vb, ha.vb)).toBe(true);
  });

  it("frames again for another repo or view, or a resized pane, and never for an overlay it kept room for", () => {
    const a = heldFrame(null, { key, pane, insets: { bottom: 150 }, target: whole });
    expect(heldFrame(a, { key, pane, insets: { bottom: 150 + HOLD_RESERVE_PX }, target: whole }).reason).toBe("held");
    expect(heldFrame(a, { key: "demo-cone|resources", pane, insets: { bottom: 150 }, target: whole }).reason).toBe("key");
    expect(heldFrame(a, { key, pane: { width: 1200, height: 720 }, insets: { bottom: 150 }, target: whole }).reason).toBe("pane");
    expect(heldFrame(a, { key, pane, insets: { bottom: 150 }, target: { ...whole, x2: 2400 } }).reason).toBe("target");
  });

  it("keeps no card's room at the side: the right margin is the left's, whatever the shot says", () => {
    expect(heldInsets({ top: 20, right: 600, bottom: 160, left: 20 })).toEqual({ top: 20 + HELD_CAPTION_PX, right: 20, bottom: 160, left: 20 });
    expect(shotMessage({ whole: true })).not.toHaveProperty("dock");
    expect(shotFromMessage({ origin: "https://k", data: { type: "behold:shot", whole: true, dock: 450 } }, "https://k")).not.toHaveProperty("dock");
  });
});

// Round 5, cycles 111-112: the held framing used a third of the stage (two wave boxes about 220 x 100 px in
// 1280 x 800). Round 6: with nothing at the side, it fills the stage less the caption and the margins.
describe("a held small stage fills the stage", () => {
  const pane = { width: 1280, height: 760 };
  const ins = heldInsets({ top: 20, bottom: 192, left: 20 });
  const boxes = [{ x: 0, y: 0, x2: 240, y2: 110 }, { x: 300, y: 0, x2: 620, y2: 110 }];
  const cards = [{ x: 20, y: 30, x2: 220, y2: 95 }, { x: 320, y: 30, x2: 460, y2: 95 }, { x: 470, y: 30, x2: 600, y2: 95 }];
  // A box round every box (a member's, the page's) and a mark far off the graph are not what it spans.
  const outer = { x: -400, y: -200, x2: 1600, y2: 900 };

  it("frames the innermost boxes that hold the cards, and the cards", () => {
    expect(heldTarget([...boxes, outer], cards)).toEqual({ x: 0, y: 0, x2: 620, y2: 110 });
    expect(heldTarget([{ x: 2000, y: 2000, x2: 2100, y2: 2100 }, ...boxes], cards)).toEqual({ x: 0, y: 0, x2: 620, y2: 110 });
    expect(heldTarget(boxes, [])).toBeNull();
  });

  it("zooms in as far as the stage area allows, so the boxes fill its width", () => {
    const target = heldTarget([...boxes, outer], cards);
    const h = heldFrame(null, { key: "demo-cone|components", pane, insets: ins, target });
    const s = pane.width / h.vb[2];
    const openW = pane.width - ins.left - ins.right;
    const openH = pane.height - ins.top - (ins.bottom + HOLD_RESERVE_PX);
    expect(Math.max(((target.x2 - target.x + 72) * s) / openW, ((target.y2 - target.y + 72) * s) / openH)).toBeGreaterThan(0.98);
    expect(s).toBeGreaterThan(1.7);
    expect(s).toBeLessThanOrEqual(HELD_MAX_SCALE);
    // apply-wave-2's box is about 2.5 times the 220 px it was.
    expect((boxes[1].x2 - boxes[1].x) * s).toBeGreaterThan(550);
  });

  it("a framing kept from before, wider than the graph needs, frames again once to fill, then holds", () => {
    const target = heldTarget(boxes, cards);
    const wide = heldFrame(null, { key: "demo-cone|components", pane, insets: ins, target: { x: -180, y: -13, x2: 1222, y2: 826 } });
    const filled = heldFrame(JSON.parse(JSON.stringify(wide)), { key: "demo-cone|components", pane, insets: ins, target });
    expect(filled.reason).toBe("fill");
    expect(filled.vb[2]).toBeLessThan(wide.vb[2] * HELD_FILL);
    expect(heldFrame(filled, { key: "demo-cone|components", pane, insets: ins, target }).reason).toBe("held");
  });
});

describe("which stage may be held", () => {
  it("an estate whose every root runs on choudoufu; b-waves, failure and tg-planned-outputs (tofu) keep a shot per step", () => {
    expect(holdsStage({ network: "choudoufu", "service-a": "choudoufu", "service-b": "choudoufu" })).toBe(true);
    expect(holdsStage({ network: "tofu", app: "tofu", edge: "tofu" })).toBe(false);
    expect(holdsStage({ network: "choudoufu", app: "tofu" })).toBe(false);
    expect(holdsStage({})).toBe(false);
    expect(holdsStage(null)).toBe(false);
  });
});

// Cycle 122: the held viewBox was -339,-10,1325,793 in a 1270 px frame (0.96 px a unit), the wave boxes at about
// x 200..640 of the window and the right 45% of the stage empty: the target reached past the boxes. It is the boxes.
describe("the held frame fits the graph's boxes to the open stage", () => {
  const pane = { width: 1270, height: 800 };
  const ins = heldInsets({ top: 20, bottom: 224, left: 20 });
  // network's box, and apply-wave-2's with service-a and service-b, as drawn at x -131..328 of the svg.
  const boxes = [{ x: -131, y: 0, x2: 89, y2: 104 }, { x: 108, y: 0, x2: 328, y2: 104 }];
  const cards = [{ x: -121, y: 30, x2: 79, y2: 90 }, { x: 118, y: 30, x2: 214, y2: 90 }, { x: 222, y: 30, x2: 318, y2: 90 }];
  // What inflated it: a card no box holds, far to the right, and a card's hover ring wider than its box.
  const stray = { x: 700, y: 380, x2: 780, y2: 420 };
  const ring = { x: -160, y: 20, x2: 100, y2: 100 };

  it("takes the boxes that hold the cards, and nothing in no box", () => {
    expect(heldTarget(boxes, [...cards, stray, ring])).toEqual({ x: -131, y: 0, x2: 328, y2: 104 });
    // No box at all: the cards are the graph.
    expect(heldTarget([], cards)).toEqual({ x: -121, y: 30, x2: 318, y2: 90 });
  });

  it("scales the boxes up to the open stage's width, about 1230 px here, from 440", () => {
    const target = heldTarget(boxes, [...cards, stray, ring]);
    const h = heldFrame(null, { key: "demo-cone|components", pane, insets: ins, target });
    const s = pane.width / h.vb[2];
    const openW = pane.width - ins.left - ins.right;
    // The boxes and their pad span the open width (the height has room to spare at this shape).
    expect(((target.x2 - target.x + 72) * s) / openW).toBeGreaterThan(0.99);
    expect((target.x2 - target.x) * s).toBeGreaterThan(1000);
    expect(s).toBeGreaterThan(2);
    // Centred: as much room left of the boxes as right of them.
    const left = (target.x - h.vb[0]) * s;
    const right = (h.vb[0] + h.vb[2] - target.x2) * s;
    expect(Math.abs(left - right)).toBeLessThan(2);
  });

  it("a framing from the inflated target frames again once, then holds", () => {
    const wide = heldFrame(null, { key: "demo-cone|components", pane, insets: ins, target: unionBox([...boxes, stray, ring]) });
    const target = heldTarget(boxes, [...cards, stray, ring]);
    const fit = heldFrame(JSON.parse(JSON.stringify(wide)), { key: "demo-cone|components", pane, insets: ins, target });
    expect(fit.reason).toBe("fill");
    expect(heldFrame(fit, { key: "demo-cone|components", pane, insets: ins, target }).reason).toBe("held");
  });
});

// Cycle 122 at 80a8867e, from window.__kioskHeld(): pane 1270 x 760, insets {top 52, right 20, bottom 271, left 20},
// target 488 x 384 units (wave 2 stacked over wave 1), vb 1325 wide: 0.958 px a unit, the 36-unit pad included.
describe("the held scale is the open stage over the graph, nothing else", () => {
  const pane = { width: 1270, height: 760 };
  const key = "demo-choudoufu|components";
  const stacked = { x: 80, y: 80, x2: 568, y2: 464 };

  it("applies min(openW / targetW, openH / targetH): no pad, the same insets that judged it", () => {
    const insets = { top: 52, right: 20, bottom: 271, left: 20 };
    const h = heldFrame(null, { key, pane, insets: { ...insets, bottom: 271 - HOLD_RESERVE_PX }, target: stacked });
    const s = pane.width / h.vb[2];
    expect(h.insets.bottom).toBe(271);
    expect(s).toBeCloseTo(Math.min((1270 - 40) / 488, (760 - 52 - 271) / 384, HELD_MAX_SCALE), 6);
    expect(HELD_PAD).toBe(0);
  });

  it("the waves in a row, with the caption's measured tallest plus 24: about twice the scale", () => {
    // captionRoom: a 150 px caption showing one 22 px row and no trail, at most two rows and a two-line trail.
    const room = captionRoom({ capHeight: 150, extras: [22], rowH: 22, trailH: 0, trailLineH: 26, below: 5 });
    expect(room).toBe(5 + 128 + 44 + 52 + 16);
    const insets = heldInsets({ top: 20, bottom: 175, left: 20 }, room);
    expect(insets.bottom).toBe(room);
    // network | service-a, service-b: the same boxes side by side, 900 x 190 units.
    const row = { x: 0, y: 0, x2: 900, y2: 190 };
    const h = heldFrame(null, { key, pane, insets, target: row });
    const s = pane.width / h.vb[2];
    const was = pane.width / 1325.2;
    expect(s).toBeCloseTo(Math.min((1270 - 40) / 900, (760 - 52 - (room + HOLD_RESERVE_PX)) / 190, HELD_MAX_SCALE), 6);
    expect(s / was).toBeGreaterThan(1.4);
  });

  it("carries the room with the shot, only when there is some", () => {
    expect(shotMessage({ whole: true, room: 245 }).room).toBe(245);
    expect(shotMessage({ whole: true })).not.toHaveProperty("room");
    expect(shotFromMessage({ origin: "https://k", data: { type: "behold:shot", whole: true, room: 245 } }, "https://k").room).toBe(245);
    expect(heldInsets({ bottom: 300 }, 245).bottom).toBe(300);
  });
});

describe("a prompt-driven step's shot (behold#939)", () => {
  it("carries ask only when true, and reads it back", () => {
    expect(shotMessage({ whole: true })).not.toHaveProperty("ask");
    expect(shotMessage({ whole: true, ask: true }).ask).toBe(true);
    const ev = { origin: "http://h", data: shotMessage({ whole: true, ask: true }) };
    expect(shotFromMessage(ev, "http://h").ask).toBe(true);
    expect(shotFromMessage({ origin: "http://h", data: shotMessage({ whole: true }) }, "http://h")).not.toHaveProperty("ask");
  });

  it("zooms a small graph up to fill the room when allowed, and not past the usual cap otherwise", () => {
    const target = { x: 0, y: 0, x2: 400, y2: 300 };
    const pane = { width: 1920, height: 1080 };
    const insets = { top: 20, bottom: 340, left: 20, right: 20 };
    const usual = shotViewBox(target, pane, insets);
    const ask = shotViewBox(target, pane, insets, { maxScale: ASK_MAX_SCALE });
    expect(pane.width / usual[2]).toBeCloseTo(1.3, 5);
    expect(pane.width / ask[2]).toBeGreaterThan(1.8);
    // The graph still sits in the open part: its scaled height is within the room above the pane.
    expect((300 + 72) * (pane.width / ask[2])).toBeLessThanOrEqual(1080 - 340 - 20 + 0.5);
  });
});
