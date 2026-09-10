import { describe, it, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { boxBadgeText, boxBadges, collapseBoxes, collapseNote, summaryStatus, COLLAPSE_LIMIT, SUMMARY_LEXICON, SUMMARY_PREFIX } from "./collapse-lens.ts";
import { renderGraph } from "./render.ts";

const member = (box: string, n: number, status?: (i: number) => string | undefined): GraphIR => ({
  nodes: Array.from({ length: n }, (_, i) => ({
    id: `${box}/aws_iam_role.r${i}`,
    kind: "aws_iam_role",
    lexicon: "choudoufu",
    attrs: { rung: "tag-governable", ...(status?.(i) ? { _status: status(i) } : {}) },
  })),
  edges: [],
  groups: { byStack: { [box]: Array.from({ length: n }, (_, i) => `${box}/aws_iam_role.r${i}`) } },
});

describe("boxBadgeText — what a box says about itself (#393)", () => {
  it("counts the cards on a declared graph and claims nothing about live state", () => {
    expect(boxBadgeText(member("terralith-4", 301).nodes)).toBe("301 resources");
  });

  it("says so once when the whole box reads one way", () => {
    expect(boxBadgeText(member("terralith-4", 301, () => "good").nodes)).toBe("301 resources · all bound");
  });

  it("speaks choudoufu's words, not the overlay legend's, on a choudoufu member", () => {
    // The unadopted terralith: 84 bound by derived identity, 85 unowned, 132
    // neutral. "managed" here would tell a reader a third of the estate is
    // already theirs (#393).
    const nodes = member("terralith-4-adopt", 301, (i) => (i < 84 ? "good" : i < 169 ? "warn" : "neutral")).nodes;
    expect(boxBadgeText(nodes)).toBe("301 resources · 84 bound · 85 unowned · 132 neutral");
  });

  it("uses the overlay's own words for a lexicon that has none of its own", () => {
    const nodes = [
      { lexicon: "k8s", attrs: { _status: "good" } },
      { lexicon: "k8s", attrs: { _status: "warn" } },
    ];
    expect(boxBadgeText(nodes)).toBe("2 cards · 1 managed · 1 foreign");
  });

  it("keys badges by box, and skips a box whose members are not in the IR", () => {
    const ir = member("terralith-4", 12);
    ir.groups.byStack = { ...(ir.groups.byStack as Record<string, string[]>), ghost: ["nope/x"] };
    expect(boxBadges(ir)).toEqual({ "terralith-4": "12 resources" });
  });
});

describe("summaryStatus", () => {
  it("takes the colour the box agrees on, and warns when anything is foreign", () => {
    expect(summaryStatus(member("m", 5, () => "good").nodes)).toBe("good");
    expect(summaryStatus(member("m", 5, (i) => (i ? "good" : "warn")).nodes)).toBe("warn");
    expect(summaryStatus(member("m", 5, (i) => (i ? "good" : "neutral")).nodes)).toBeUndefined();
  });
});

describe("collapseBoxes — the collapse lens (#393)", () => {
  it("leaves a box at or below the limit exactly as it was", () => {
    const ir = member("small", COLLAPSE_LIMIT);
    const { ir: out, collapsed } = collapseBoxes(ir);
    expect(out).toBe(ir);
    expect(collapsed).toEqual([]);
    expect(collapseNote(collapsed)).toBeUndefined();
  });

  it("replaces a box over the limit with one summary card carrying its counts and its colour", () => {
    const ir = member("terralith-4", COLLAPSE_LIMIT + 1, () => "good");
    const { ir: out, collapsed } = collapseBoxes(ir);
    expect(collapsed).toEqual(["terralith-4"]);
    expect(out.nodes).toHaveLength(1);
    const [card] = out.nodes;
    expect(card.id).toBe(`${SUMMARY_PREFIX}terralith-4`);
    expect(card.lexicon).toBe(SUMMARY_LEXICON);
    expect(card.attrs.summary).toBe("41 resources · all bound");
    expect(card.attrs._status).toBe("good");
    expect(card.attrs.cards).toBe(41);
    // The box is gone: it IS the card now.
    expect(out.groups.byStack).toEqual({});
    // And the caller's IR is untouched.
    expect(ir.nodes).toHaveLength(41);
  });

  it("re-points a cross-member edge at the summary and drops one that folds into itself", () => {
    const big = member("big", COLLAPSE_LIMIT + 1);
    const small = member("small", 2);
    const ir: GraphIR = {
      nodes: [...big.nodes, ...small.nodes],
      edges: [
        { from: "big/aws_iam_role.r0", to: "small/aws_iam_role.r0", kind: "ref", viaAttr: "reads" },
        { from: "big/aws_iam_role.r1", to: "small/aws_iam_role.r0", kind: "ref", viaAttr: "reads" },
        { from: "big/aws_iam_role.r2", to: "big/aws_iam_role.r3", kind: "ref", viaAttr: "reads" },
      ],
      groups: { byStack: { big: big.groups.byStack!.big, small: small.groups.byStack!.small } },
    };
    const { ir: out } = collapseBoxes(ir);
    expect(out.edges).toEqual([{ from: "box:big", to: "small/aws_iam_role.r0", kind: "ref", viaAttr: "reads" }]);
    expect(out.groups.byStack).toEqual({ small: small.groups.byStack!.small });
  });

  it("takes the limit from the caller", () => {
    expect(collapseBoxes(member("m", 8), { limit: 5 }).collapsed).toEqual(["m"]);
    expect(collapseBoxes(member("m", 8), { limit: 20 }).collapsed).toEqual([]);
  });

  it("draws the summary as a card with the count on its face", () => {
    const { ir } = collapseBoxes(member("terralith-4", 301, () => "good"));
    const { svg } = renderGraph(ir, { boxes: "byStack" });
    expect(svg).toContain('data-node-id="box:terralith-4"');
    expect(svg).toContain("301 resources · all bound");
  });
});

describe("boxBadges over the render (#393)", () => {
  it("puts the count on the box it belongs to", () => {
    const ir = member("terralith-4", 60);
    const { svg } = renderGraph(ir, { boxes: "byStack", groupBadges: boxBadges(ir) });
    expect(svg).toContain("60 resources");
    expect(svg).toContain('data-group-id="terralith-4"');
  });

  it("renders byte-identical without the badges", () => {
    const ir = member("terralith-4", 60);
    expect(renderGraph(ir, { boxes: "byStack" }).svg).not.toContain("60 resources");
  });
});
