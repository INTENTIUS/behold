import { describe, expect, it } from "vitest";
import { OUTSIDE_TAG, outsideCard, outsideModel, outsideSpots } from "./tg-outside.js";

// behold#743: terragucci#1163's fan-out-choudoufu, chapter 3: an operator applies a queue to app-01's estate (fo-app-01)
// while the pipeline's wave 3 applies app-01.
const ids = ["network", "cluster-a", "cluster-b", ...Array.from({ length: 12 }, (_, i) => `app-${String(i + 1).padStart(2, "0")}`)];
const outside = (over = {}) => ({
  who: "an operator",
  estate: "fo-app-01",
  command: "choudoufu apply -target=aws_sqs_queue.alarms",
  state: "applying",
  started_at: "2026-10-19T00:31:14Z",
  ended_at: null,
  resources: ["aws_sqs_queue.alarms"],
  log: [],
  ...over,
});
const texts = (m) => m.lines.map((l) => l.text);

describe("the card an outside apply is on (behold#743)", () => {
  it("is the card the estate names, or the one its name ends with after a prefix", () => {
    expect(outsideCard("app-01", ids)).toBe("app-01");
    expect(outsideCard("fo-app-01", ids)).toBe("app-01");
    expect(outsideCard("fo-cluster-a", ids)).toBe("cluster-a");
  });
  it("is none when no card is it, or a suffix without a separator", () => {
    expect(outsideCard("fo-app-13", ids)).toBe(null);
    expect(outsideCard("xapp-01", ids)).toBe(null);
    expect(outsideCard("", ids)).toBe(null);
    expect(outsideCard(null, ids)).toBe(null);
    expect(outsideCard("fo-app-01", [])).toBe(null);
  });
  it("takes the longest name when one name ends another", () => {
    expect(outsideCard("fo-x-app-01", ["app-01", "x-app-01"])).toBe("x-app-01");
    expect(outsideCard("fo-app-01", ["app-01", "app-01"])).toBe("app-01");
  });
});

describe("the outside apply's mark (behold#743)", () => {
  it("is nothing without one", () => {
    expect(outsideModel(null)).toBe(null);
    expect(outsideModel(undefined, { pipeline: "applying" })).toBe(null);
  });
  it("says who, the command, the resources and what the pipeline does meanwhile, while it applies", () => {
    const m = outsideModel(outside(), { pipeline: "applying", card: "app-01", wave: 3 });
    expect(m.tag).toBe(OUTSIDE_TAG);
    expect(m.tag).toBe("outside the pipeline");
    expect(texts(m)).toEqual(["an operator is applying to app-01", "$ choudoufu apply -target=aws_sqs_queue.alarms", "+ aws_sqs_queue.alarms", "the pipeline's wave 3 applies app-01 at the same time"]);
    expect(m).toMatchObject({ tone: "busy", pulse: true, both: false, card: "app-01" });
  });
  it("says the pipeline's wave is coming before it applies, and that it landed without waiting once it has", () => {
    expect(texts(outsideModel(outside(), { pipeline: "not-started", card: "app-01", wave: 3 })).at(-1)).toBe("the pipeline's wave 3 applies app-01 too");
    expect(texts(outsideModel(outside(), { pipeline: "applied", card: "app-01", wave: 3 })).at(-1)).toBe("the pipeline's wave 3 applied app-01 too, and did not wait");
    // Without a wave, the pipeline.
    expect(texts(outsideModel(outside(), { pipeline: "applying", card: "app-01" })).at(-1)).toBe("the pipeline applies app-01 at the same time");
    expect(texts(outsideModel(outside(), { pipeline: "blocked", card: "app-01" }))).toHaveLength(3);
  });
  it("says both changes landed, with no lock or wait, once both ended", () => {
    const m = outsideModel(outside({ state: "applied", ended_at: "2026-10-19T00:31:42Z" }), { pipeline: "applied", card: "app-01", change: "1 to change", wave: 3 });
    expect(m).toMatchObject({ tone: "ok", pulse: false, both: true });
    expect(texts(m)).toEqual(["both landed on app-01, and neither waited", "the pipeline's wave 3: its planned change, 1 to change", "an operator: + aws_sqs_queue.alarms", "$ choudoufu apply -target=aws_sqs_queue.alarms"]);
    expect(texts(m).join(" ")).not.toMatch(/\block(ed)?\b|waiting|blocked/);
    // A fix's later step reads the pipeline's earlier apply as landed too.
    const later = outsideModel(outside({ state: "applied" }), { pipeline: "applied-earlier", card: "app-01" });
    expect(later.both).toBe(true);
    expect(texts(later)[1]).toBe("the pipeline: its planned change");
  });
  it("says it landed alone while the pipeline's apply has not", () => {
    const m = outsideModel(outside({ state: "applied" }), { pipeline: "applying", card: "app-01" });
    expect(m.both).toBe(false);
    expect(texts(m)[0]).toBe("an operator's apply to app-01 landed");
  });
  it("says a failure in its tone", () => {
    const m = outsideModel(outside({ state: "failed" }), { pipeline: "applied", card: "app-01" });
    expect(m).toMatchObject({ tone: "bad", pulse: false, both: false });
    expect(texts(m)[0]).toBe("an operator's apply to app-01 failed");
  });
  it("names the estate when no card is given, and counts resources past two", () => {
    const m = outsideModel(outside({ resources: ["a.b", "c.d", "e.f", "g.h"] }));
    expect(texts(m)[0]).toBe("an operator is applying to fo-app-01");
    expect(texts(m)).toContain("+ a.b, c.d and 2 more");
    expect(texts(outsideModel(outside({ resources: [] }))).some((t) => t.startsWith("+"))).toBe(false);
  });
});

describe("where the mark may go (behold#743)", () => {
  const card = { x: 100, y: 100, x2: 260, y2: 180 };
  it("offers spots on every side, none on the card", () => {
    const spots = outsideSpots(card, 300, 90);
    expect(new Set(spots.map((s) => s.side))).toEqual(new Set(["top", "left", "bottom", "right"]));
    const hits = (r) => r.x < card.x2 && r.x2 > card.x && r.y < card.y2 && r.y2 > card.y;
    expect(spots.some((s) => hits(s.r))).toBe(false);
    for (const s of spots) expect(s.r.x2 - s.r.x).toBe(300);
  });
  it("says how far each sits from the card", () => {
    const top = outsideSpots(card, 300, 90, { gaps: [12], slides: [0] }).find((s) => s.side === "top");
    expect(top.r).toEqual({ x: 30, y: -2, x2: 330, y2: 88 });
    expect(top.far).toBe(12);
  });
});
