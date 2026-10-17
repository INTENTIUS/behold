import { describe, it, expect } from "vitest";
import {
  GRID,
  CARD_TEXT,
  bestFit,
  innerOf,
  membersOf,
  gridScale,
  gridSlots,
  cardSize,
  shortType,
  cardLabel,
  cardNeed,
  rosterLod,
  fitFront,
  wrapType,
  cardShape,
  cardText,
  cardTextAlpha,
  pickMark,
  cardsMark,
  cardsEstate,
  middleCard,
  cardsFrame,
  minViewWidth,
  tipSpot,
} from "./dots-cards.js";
import { LOD, cardMorph } from "./dots-lod.js";
import { BOX } from "./dots-scene.js";

// A face about as wide as the UI's: 0.55 em a character.
const measure = (s, px = CARD_TEXT.name) => s.length * px * 0.55;

// A layout as web/dots-scene.js's layoutAt makes one: slots, boxes and owners.
function layout(estates) {
  const slots = new Map();
  const boxes = new Map();
  const owners = new Map();
  for (const [e, { box, addrs }] of Object.entries(estates)) {
    boxes.set(e, box);
    for (const a of addrs) {
      slots.set(a, { x: box.x + 2, y: box.y + 5 });
      owners.set(a, e);
    }
  }
  return { slots, boxes, owners };
}
const box = (x, y, w, h) => ({ x, y, w, h, members: 1 });
const ids = (pre, n) => Array.from({ length: n }, (_, i) => `${pre}.r${String(i).padStart(2, "0")}`);

describe("the card grid fills each estate's box", () => {
  it("finds the largest cell that fits n cells in rows", () => {
    // 4 cells 2 wide in a 4 x 2 box: two rows of two, each 1 high.
    expect(bestFit(4, 2, 4, 2)).toBe(1);
    expect(bestFit(10, 1, 1, 2)).toBe(1);
    expect(bestFit(0, 5, 3)).toBe(0);
    expect(bestFit(5, 5, 0)).toBe(0);
  });

  it("puts every card inside its box's inner rect, none overlapping, in unit order", () => {
    const L = layout({ a: { box: box(0, 0, 30, 20), addrs: ids("a", 9) }, b: { box: box(40, 0, 12, 14), addrs: ids("b", 3) } });
    const k = gridScale([L], (x) => x);
    const cells = gridSlots(L, k, (x) => x);
    const c = cardSize(k);
    expect(cells.size).toBe(12);
    for (const [e] of L.boxes) {
      const r = innerOf(L.boxes.get(e));
      const mine = [...cells].filter(([a]) => L.owners.get(a) === e).map(([, p]) => p);
      for (const p of mine) {
        expect(p.x - c.w / 2).toBeGreaterThanOrEqual(r.x - 1e-9);
        expect(p.x + c.w / 2).toBeLessThanOrEqual(r.x + r.w + 1e-9);
        expect(p.y - c.h / 2).toBeGreaterThanOrEqual(r.y - 1e-9);
        expect(p.y + c.h / 2).toBeLessThanOrEqual(r.y + r.h + 1e-9);
      }
      for (let i = 0; i < mine.length; i++)
        for (let j = i + 1; j < mine.length; j++) expect(Math.abs(mine[i].x - mine[j].x) >= c.w || Math.abs(mine[i].y - mine[j].y) >= c.h).toBe(true);
    }
    // Reading order is unit order: the first card is top-left.
    const first = cells.get("a.r00");
    for (const a of ids("a", 9)) expect(cells.get(a).y >= first.y && (cells.get(a).y > first.y || cells.get(a).x >= first.x)).toBe(true);
  });

  it("takes one cell size for every estate and moment: the tightest box's, capped", () => {
    const roomy = layout({ a: { box: box(0, 0, 200, 200), addrs: ids("a", 1) } });
    expect(gridScale([roomy], (x) => x)).toBe(GRID.maxK);
    const tight = layout({ a: { box: box(0, 0, 200, 200), addrs: ids("a", 1) }, b: { box: box(0, 0, 3 + 2 * BOX.pad, 3 + 2 * BOX.pad + BOX.title), addrs: ids("b", 1) } });
    expect(gridScale([roomy, tight], (x) => x)).toBeCloseTo(3 / GRID.aspect, 9);
  });

  it("gives a card several times the room of a dot's slot", () => {
    // A one-unit box: an anchor and its ring, as web/dots-layout.js packs it (a 9-pitch cell holds about 6).
    const L = layout({ a: { box: box(0, 0, 9 + 2 * BOX.pad, 9 + 2 * BOX.pad + BOX.title), addrs: ids("a", 6) } });
    const c = cardSize(gridScale([L], (x) => x));
    expect(c.w).toBeGreaterThan(3 * 0.88);
  });

  it("groups an estate's members by the key it is given", () => {
    const L = layout({ a: { box: box(0, 0, 30, 20), addrs: ["z", "y", "x"] } });
    expect(membersOf(L, (a) => ({ z: "1", y: "2", x: "3" })[a]).get("a")).toEqual(["z", "y", "x"]);
    expect(membersOf(L).get("a")).toEqual(["x", "y", "z"]);
  });
});

describe("roster cards: words from a roster row", () => {
  it("labels a card with the resource's name and index, and its type without the provider's prefix", () => {
    expect(cardLabel({ address: 'module.team_a.aws_s3_bucket.logs["eu"]', type: "aws_s3_bucket" })).toEqual({ name: 'logs["eu"]', type: "s3_bucket", address: 'module.team_a.aws_s3_bucket.logs["eu"]' });
    expect(cardLabel({ address: "aws_iam_role.svc_role[2]", type: "" })).toMatchObject({ name: "svc_role[2]", type: "iam_role" });
    expect(cardLabel({ address: "data.aws_vpc.main", type: "aws_vpc" })).toMatchObject({ name: "main", type: "vpc" });
  });
  it("keeps a type that is all prefix, and terraform's own", () => {
    expect(shortType("aws_iam_role_policy_attachment")).toBe("iam_role_policy_attachment");
    expect(shortType("terraform_data")).toBe("terraform_data");
    expect(shortType("null")).toBe("null");
    expect(shortType("")).toBe("");
  });
  it("never shows behold's own suffix for two rows with one address", () => {
    expect(cardLabel({ address: "aws_sqs_queue.jobs#2", type: "aws_sqs_queue" })).toMatchObject({ name: "jobs", address: "aws_sqs_queue.jobs" });
  });
  it("falls back to the whole address when it names no resource", () => {
    expect(cardLabel({ address: "odd", type: "" })).toMatchObject({ name: "odd", type: "" });
    expect(cardLabel(null)).toMatchObject({ name: "", type: "" });
  });
});

describe("the card level starts where the names fit", () => {
  const labels = [
    { name: "team_0001_managed_attach", type: "iam_role_policy_attachment" },
    { name: "team_0001_role", type: "iam_role" },
  ];
  it("is wide enough for the longest name at the name's face and the longest type at the type's", () => {
    const need = cardNeed(labels, measure);
    const room = need - CARD_TEXT.pad * 2 - CARD_TEXT.bar;
    expect(measure("team_0001_managed_attach", CARD_TEXT.name)).toBeLessThanOrEqual(room);
    expect(measure("iam_role_policy_attachment", CARD_TEXT.type)).toBeLessThanOrEqual(room);
  });
  it("is clamped", () => {
    expect(cardNeed([{ name: "a", type: "" }], measure)).toBe(CARD_TEXT.minW);
    expect(cardNeed([{ name: "x".repeat(200), type: "" }], measure)).toBe(CARD_TEXT.maxW);
  });
  it("scales the card's level of detail to it", () => {
    const lod = rosterLod(180);
    expect(cardMorph(180, { lod })).toBe(0);
    expect(cardMorph((180 * LOD.dotPx) / LOD.cardPx, { lod })).toBe(1);
  });
  it("shows a whole name and a whole type on a card at that width", () => {
    const need = cardNeed(labels, measure);
    const h = (need * cardSize(1).h) / cardSize(1).w;
    const lines = cardText({ name: "team_0001_managed_attach", type: "iam_role_policy_attachment" }, { w: need, h, need }, measure);
    expect(lines.map((l) => l.text)).toEqual(["team_0001_managed_attach", "iam_role_policy_attachment"]);
    expect(lines[0].size).toBe(CARD_TEXT.name);
    expect(lines[1].size).toBe(CARD_TEXT.type);
  });
  it("keeps what fits at that width fitting as the card grows", () => {
    const need = cardNeed(labels, measure);
    for (const k of [1.2, 1.5, 2]) {
      const w = need * k;
      const lines = cardText({ name: "team_0001_managed_attach", type: "iam_role" }, { w, h: w * 0.29, need }, measure);
      expect(lines[0].text).toBe("team_0001_managed_attach");
      for (const l of lines) expect(measure(l.text, l.size)).toBeLessThanOrEqual(w - CARD_TEXT.pad * 2 - CARD_TEXT.bar);
    }
  });
});

describe("fitting the words", () => {
  it("keeps a name that fits", () => {
    expect(fitFront("logs", 100, measure)).toBe("logs");
  });
  it("cuts a name still too long from the front, keeping the longest tail that fits", () => {
    const s = "team_platform_ingest_dead_letter_queue";
    const room = 70;
    const out = fitFront(s, room, measure);
    expect(out.startsWith("…")).toBe(true);
    expect(s.endsWith(out.slice(1))).toBe(true);
    expect(measure(out)).toBeLessThanOrEqual(room);
    expect(measure(`…${s.slice(s.length - out.length)}`)).toBeGreaterThan(room);
  });
  it("draws nothing with no room", () => {
    expect(fitFront("logs", 0, measure)).toBe("");
    expect(fitFront("logs", 3, measure)).toBe("");
    expect(fitFront("", 100, measure)).toBe("");
  });
  it("wraps a type after an underscore, near the middle, when it does not fit one line", () => {
    const m = (s) => measure(s, CARD_TEXT.type);
    const two = wrapType("iam_role_policy_attachment", 100, m);
    expect(two).toEqual(["iam_role_policy_", "attachment"]);
    expect(wrapType("iam_role_policy_attachment", 10, m)).toBeNull();
    expect(wrapType("nounderscore", 100, m)).toBeNull();
  });
  it("puts a too-wide type on two lines on a tall card, and cuts it on a short one", () => {
    const label = { name: "role", type: "iam_role_policy_attachment" };
    const tall = cardText(label, { w: 120, h: 60, need: 120 }, measure);
    expect(tall.map((l) => l.text)).toEqual(["role", "iam_role_policy_", "attachment"]);
    const short = cardText(label, { w: 120, h: 36, need: 120 }, measure);
    expect(short.length).toBe(2);
    expect(short[1].text.startsWith("…")).toBe(true);
  });
  it("leaves a line out rather than shrink it", () => {
    const label = { name: 'logs["eu"]', type: "cloudwatch_log_group" };
    expect(cardText(label, { w: 30, h: 60 }, measure)).toEqual([]);
    expect(cardText(label, { w: 200, h: 10 }, measure)).toEqual([]);
    expect(cardText(label, { w: 200, h: 20 }, measure).map((l) => l.ink)).toEqual(["fg"]);
    expect(cardText({ name: "x", type: "" }, { w: 200, h: 80 }, measure).length).toBe(1);
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
    expect(cardTextAlpha(0.6)).toBe(0);
    expect(cardTextAlpha(0.8)).toBeGreaterThan(0);
    expect(cardTextAlpha(1)).toBe(1);
  });
});

describe("pickMark: hover, tap and the arrow keys find the card under the pointer", () => {
  const marks = { px: [10, 100, 300], py: [10, 100, 300], pvis: [1, 1, 1], pw: [0, 40, 0], ph: [0, 20, 0] };
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
  it("counts the SVG's resource cards when the SVG draws them", () => {
    expect(cardsMark({ resources: 1041, seeded: 1000, svgCards: 1000, own: false }).words).toBe("1,000 cards");
  });
  it("counts the SVG's own cards (a live carve's roots) when none is a resource's and the stage is the SVG's", () => {
    expect(cardsMark({ resources: 82, seeded: 0, svgCards: 4, own: false })).toEqual({ count: 4, words: "4 cards", enabled: true });
    expect(cardsMark({ resources: 82, seeded: 0, svgCards: 1, own: false }).words).toBe("1 card");
  });
  it("says so, and cannot be pressed, when no card can draw", () => {
    expect(cardsMark({ resources: 82, seeded: 0, svgCards: 0, own: false })).toEqual({ count: 0, words: "no cards", enabled: false });
  });
  it("lands on the director's estate when it holds cards, else the source, else the fullest", () => {
    const counts = new Map([["src", 0], ["team-a", 12], ["team-b", 30]]);
    expect(cardsEstate("team-a", "src", counts)).toBe("team-a");
    expect(cardsEstate("gone", "src", counts)).toBe("team-b");
    expect(cardsEstate(null, "team-a", counts)).toBe("team-a");
    expect(cardsEstate(null, "src", new Map())).toBeNull();
  });
  it("centres on a card, never on the gap between cards", () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 4, y: 6 }];
    expect(middleCard(pts)).toEqual({ x: 4, y: 6 });
    expect(middleCard([])).toBeNull();
    expect(cardsFrame({ x: 120, y: 210 }, 60, 0.5)).toEqual([90, 195, 60, 30]);
  });
  it("lands where the cards are fully drawn, and the zoom in stops a little past it", () => {
    const paneW = 1300;
    const cardW = 40;
    const need = 180;
    // A card at the Cards mark (web/dots-lod.js railMarks, cardAt = need * 1.1) is fully drawn.
    const markW = (paneW * cardW) / (need * 1.1);
    expect(cardMorph((cardW * paneW) / markW, { lod: rosterLod(need) })).toBe(0);
    // The narrowest view keeps the mark within reach, and stops not far past it.
    const minW = minViewWidth(paneW, cardW, need);
    expect(minW).toBeLessThan(markW);
    expect((cardW * paneW) / minW).toBeCloseTo(need * 1.8, 6);
  });
});

describe("a card's tip", () => {
  const pane = { tipW: 300, tipH: 40, paneW: 1440, paneH: 900 };
  it("sits right of and under the mark", () => {
    expect(tipSpot(100, 100, pane)).toEqual({ left: 112, top: 114 });
  });
  it("keeps clear of the rail on the right", () => {
    const s = tipSpot(1300, 100, { ...pane, rightInset: 160 });
    expect(s.left + pane.tipW).toBeLessThanOrEqual(1440 - 160);
  });
  it("goes over the mark when the pane's foot leaves no room under it", () => {
    const s = tipSpot(100, 880, { ...pane, above: 840 });
    expect(s.top + pane.tipH).toBeLessThanOrEqual(840);
  });
});
