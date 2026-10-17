import { describe, it, expect } from "vitest";
import { ROSTER_CARD, CARD_TEXT, rosterCardSize, cardLabel, fitFront, cardShape, cardText, cardTextAlpha, pickMark, cardsMark, cardsFrame } from "./dots-cards.js";
import { LOD, cardMorph } from "./dots-lod.js";

// A face about as wide as the UI's: 0.55 em a character.
const measure = (s, px = CARD_TEXT.name) => s.length * px * 0.55;

describe("roster cards: size and words from a roster row", () => {
  it("sizes a card in dot pitches, so two slots a pitch apart never hold cards that meet", () => {
    const c = rosterCardSize(10);
    expect(c.w).toBeCloseTo(ROSTER_CARD.w * 10, 9);
    expect(c.h).toBeCloseTo(ROSTER_CARD.h * 10, 9);
    // Neighbours one pitch apart, in any direction: the rects do not overlap.
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 36) {
      const dx = Math.abs(Math.cos(a) * 10);
      const dy = Math.abs(Math.sin(a) * 10);
      expect(dx >= c.w || dy >= c.h).toBe(true);
    }
  });

  it("labels a card with the resource's name and index, and its type", () => {
    expect(cardLabel({ address: 'module.team_a.aws_s3_bucket.logs["eu"]', type: "aws_s3_bucket" })).toEqual({ name: 'logs["eu"]', type: "aws_s3_bucket", address: 'module.team_a.aws_s3_bucket.logs["eu"]' });
    expect(cardLabel({ address: "aws_iam_role.svc_role[2]", type: "" })).toMatchObject({ name: "svc_role[2]", type: "aws_iam_role" });
    expect(cardLabel({ address: "data.aws_vpc.main", type: "aws_vpc" })).toMatchObject({ name: "main", type: "aws_vpc" });
  });

  it("never shows behold's own suffix for two rows with one address", () => {
    expect(cardLabel({ address: "aws_sqs_queue.jobs#2", type: "aws_sqs_queue" })).toMatchObject({ name: "jobs", address: "aws_sqs_queue.jobs" });
  });

  it("falls back to the whole address when it names no resource", () => {
    expect(cardLabel({ address: "odd", type: "" })).toMatchObject({ name: "odd", type: "" });
    expect(cardLabel(null)).toMatchObject({ name: "", type: "" });
  });
});

describe("fitFront", () => {
  it("keeps a name that fits", () => {
    expect(fitFront("logs", 100, measure)).toBe("logs");
  });
  it("cuts a long name from the front, keeping the longest tail that fits", () => {
    const s = "team_platform_ingest_dead_letter_queue";
    const room = 70;
    const out = fitFront(s, room, measure);
    expect(out.startsWith("…")).toBe(true);
    expect(s.endsWith(out.slice(1))).toBe(true);
    expect(measure(out)).toBeLessThanOrEqual(room);
    // One more character would not fit.
    expect(measure(`…${s.slice(s.length - out.length)}`)).toBeGreaterThan(room);
  });
  it("draws nothing with no room", () => {
    expect(fitFront("logs", 0, measure)).toBe("");
    expect(fitFront("logs", 3, measure)).toBe("");
    expect(fitFront("", 100, measure)).toBe("");
  });
});

describe("the dot grows into its card", () => {
  const sizes = { dotR: 4, cardW: 120, cardH: 57 };
  it("is the dot at 0 and the card at 1, about the same centre", () => {
    expect(cardShape(50, 40, 0, sizes)).toEqual({ x: 46, y: 36, w: 8, h: 8, r: 4 });
    const c = cardShape(50, 40, 1, sizes);
    expect(c.w).toBe(120);
    expect(c.h).toBe(57);
    expect(c.x + c.w / 2).toBe(50);
    expect(c.y + c.h / 2).toBe(40);
    expect(c.r).toBeLessThanOrEqual(6);
  });
  it("grows monotonically in between", () => {
    let prev = 0;
    for (let u = 0; u <= 1; u += 0.05) {
      const c = cardShape(0, 0, u, sizes);
      expect(c.w).toBeGreaterThanOrEqual(prev);
      prev = c.w;
    }
  });
  it("fades the words in only near the end of the morph", () => {
    expect(cardTextAlpha(0)).toBe(0);
    expect(cardTextAlpha(0.6)).toBe(0);
    expect(cardTextAlpha(0.8)).toBeGreaterThan(0);
    expect(cardTextAlpha(1)).toBe(1);
  });
});

describe("the card's text", () => {
  const label = { name: 'logs["eu"]', type: "aws_cloudwatch_log_group" };
  it("is legible at the card level: a card at the card-size threshold holds the name over the type, at their faces' sizes", () => {
    // The pitch at which a roster card is exactly the size the card level starts at.
    const pitch = LOD.cardPx / ROSTER_CARD.w;
    const card = rosterCardSize(pitch);
    expect(cardMorph(card.w)).toBeCloseTo(0, 6);
    const lines = cardText(label, card, measure);
    expect(lines.map((l) => l.ink)).toEqual(["fg", "muted"]);
    expect(lines[0].size).toBeGreaterThanOrEqual(CARD_TEXT.name);
    expect(lines[1].size).toBeGreaterThanOrEqual(CARD_TEXT.type);
    expect(lines[0].text).toBe('logs["eu"]');
    // The type is cut from the front to fit beside the colour bar and padding.
    const room = card.w - CARD_TEXT.pad * 2 - CARD_TEXT.bar;
    for (const l of lines) expect(measure(l.text, l.size)).toBeLessThanOrEqual(room);
    expect(lines[1].text.startsWith("…")).toBe(true);
  });
  it("leaves a line out rather than shrink it", () => {
    expect(cardText(label, { w: 30, h: 60 }, measure)).toEqual([]);
    expect(cardText(label, { w: 200, h: 10 }, measure)).toEqual([]);
    const one = cardText(label, { w: 200, h: 20 }, measure);
    expect(one.map((l) => l.ink)).toEqual(["fg"]);
  });
  it("draws no type line for a row with no type", () => {
    expect(cardText({ name: "x", type: "" }, { w: 200, h: 80 }, measure).length).toBe(1);
  });
});

describe("pickMark: hover, tap and the arrow keys find the card under the pointer", () => {
  const marks = {
    px: [10, 100, 300],
    py: [10, 100, 300],
    pvis: [1, 1, 1],
    pw: [0, 40, 0],
    ph: [0, 20, 0],
  };
  it("picks a card anywhere on it, a dot only near its centre", () => {
    expect(pickMark(135, 115, marks)).toBe(1);
    expect(pickMark(12, 12, marks)).toBe(0);
    expect(pickMark(30, 30, marks)).toBe(-1);
    expect(pickMark(310, 300, marks, { within: 12 })).toBe(2);
  });
  it("skips a mark that is not drawn", () => {
    expect(pickMark(100, 100, { ...marks, pvis: [1, 0, 1] })).toBe(-1);
  });
  it("prefers the card whose centre is nearer where two meet", () => {
    const two = { px: [0, 60], py: [0, 0], pvis: [1, 1], pw: [40, 40], ph: [20, 20] };
    expect(pickMark(35, 0, two)).toBe(1);
    expect(pickMark(25, 0, two)).toBe(0);
  });
});

describe("the rail's Cards mark", () => {
  it("counts the roster's cards when the canvas draws them", () => {
    expect(cardsMark({ resources: 82, seeded: 0, svgCards: 4, own: true })).toEqual({ count: 82, words: "82 cards", enabled: true });
  });
  it("counts the SVG's resource cards, never the roster's, when the SVG draws them", () => {
    expect(cardsMark({ resources: 1041, seeded: 1000, svgCards: 1000, own: false }).words).toBe("1,000 cards");
  });
  it("counts the SVG's own cards (a live carve's roots) when none is a resource's and the stage is the SVG's", () => {
    expect(cardsMark({ resources: 82, seeded: 0, svgCards: 4, own: false })).toEqual({ count: 4, words: "4 cards", enabled: true });
    expect(cardsMark({ resources: 82, seeded: 0, svgCards: 1, own: false }).words).toBe("1 card");
  });
  it("says so, and cannot be pressed, when no card can draw", () => {
    expect(cardsMark({ resources: 82, seeded: 0, svgCards: 0, own: false })).toEqual({ count: 0, words: "no cards", enabled: false });
    expect(cardsMark()).toMatchObject({ enabled: false });
  });
  it("frames the card level centred on a box, at the pane's aspect", () => {
    const vb = cardsFrame({ x: 100, y: 200, w: 40, h: 20 }, 60, 0.5);
    expect(vb).toEqual([90, 195, 60, 30]);
  });
});
