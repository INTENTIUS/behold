import { describe, it, expect } from "vitest";
import { PHASES, boxSubtitle, cardFace, cardNews, flipDelta, legendFor, shownPhase, stepperItems } from "./terralith-steps.js";

const card = (id, identity, extra = {}) => ({ id, type: id.split(".")[0], root: "terralith", identity, ...extra });
const phase = (id, boxes, counts = {}) => ({ id, n: PHASES.find((p) => p.id === id).n, boxes, counts: { cards: 0, marked: 0, moved: 0, ...counts }, notes: [] });

describe("the walkthrough's phases", () => {
  const model = {
    phases: [phase("stock", []), phase("adopt", [])],
    next: { id: "split", n: 3, command: "bash scripts/terralith-step.sh split" },
  };

  it("shows the phase the URL names when it ran, else the newest", () => {
    expect(shownPhase(model, "stock").id).toBe("stock");
    expect(shownPhase(model, "split").id).toBe("adopt");
    expect(shownPhase(model, null).id).toBe("adopt");
    expect(shownPhase({ phases: [] }, "stock")).toBeNull();
  });

  it("marks each step ran, shown or next", () => {
    expect(stepperItems(model, "adopt").map((s) => [s.id, s.ran, s.shown, s.next])).toEqual([
      ["stock", true, false, false],
      ["adopt", true, true, false],
      ["split", false, false, true],
    ]);
  });

  it("counts what each phase changed in its own line", () => {
    const adopt = PHASES.find((p) => p.id === "adopt");
    expect(adopt.facts(phase("adopt", [], { cards: 23, marked: 17 }))).toBe(
      "17 of 23 resources now carry the marker. The other 6 have no tags argument, and ride the role they belong to.",
    );
    const split = PHASES.find((p) => p.id === "split");
    const boxes = [{ spawned: false }, { spawned: true }, { spawned: true }, { spawned: true }];
    expect(split.facts(phase("split", boxes, { moved: 21 }))).toBe("21 resources moved into 3 new estates. The terralith keeps the network.");
  });
});

describe("a card", () => {
  it("reads its type without the provider and its resource name", () => {
    expect(cardFace(card("aws_iam_role_policy.team_a_inline", {}))).toEqual({ kind: "iam_role_policy", name: "team_a_inline" });
  });

  it("carries live-import's verdict in adopt, and its retag in split", () => {
    const c = card("aws_iam_role.team_a", {}, { ratified: "verified", moved: { from: "terralith", to: "team-a" } });
    expect(cardNews(c, "adopt")).toBe("verified");
    expect(cardNews(c, "split")).toBe("from terralith");
    expect(cardNews({ ...c, moved: { from: "terralith", to: "team-a", follows: "aws_iam_role.team_a" } }, "split")).toBe("follows its role");
    expect(cardNews(c, "stock")).toBe("");
  });
});

describe("boxes and the legend", () => {
  it("says a stock root keeps a state file and a spawned estate is new", () => {
    expect(boxSubtitle({ stock: true })).toBe("stock root · state file on S3");
    expect(boxSubtitle({ stock: false, estate: "team-a", spawned: true })).toBe("estate team-a · new");
  });

  it("lists only the marks the phase uses", () => {
    const p = phase("adopt", [{ cards: [card("aws_vpc.main", { source: "marker", marked: true }), card("aws_iam_role_policy.x", { source: "derived", marked: false })] }]);
    expect(legendFor(p).map((l) => l.key)).toEqual(["marker", "derived"]);
  });
});

describe("FLIP", () => {
  it("is the offset back to where the card was, or nothing when it stayed", () => {
    expect(flipDelta({ left: 10, top: 20 }, { left: 110, top: 20 })).toEqual({ dx: -100, dy: 0 });
    expect(flipDelta({ left: 10, top: 20 }, { left: 10.2, top: 20 })).toBeNull();
    expect(flipDelta(undefined, { left: 0, top: 0 })).toBeNull();
  });
});
