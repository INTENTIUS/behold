import { describe, expect, it } from "vitest";
import { queryFrame, readShotFrame, shotCaption, shotLit, shotProvenance, shotState } from "./shot-frame.js";

const box = (x, y, w = 100, h = 60) => ({ x, y, x2: x + w, y2: y + h });
const cards = [
  { id: "a", box: box(0, 0) },
  { id: "b", box: box(200, 0) },
  { id: "c", box: box(0, 300) },
];
const groups = [{ id: "top", box: { x: -10, y: -10, x2: 320, y2: 80 } }];

describe("readShotFrame (behold#915)", () => {
  it("is on only in a bare embed frame that asks for frame=matches", () => {
    expect(readShotFrame("?embed=1&bare=1&frame=matches")).toBe("matches");
    expect(readShotFrame("?embed=1&frame=matches")).toBeNull();
    expect(readShotFrame("?bare=1&frame=matches")).toBeNull();
    expect(readShotFrame("?embed=1&bare=1&frame=whole")).toBeNull();
    expect(readShotFrame("")).toBeNull();
  });
});

describe("shotLit", () => {
  it("lights a query's matches when they are given, whatever the view selects", () => {
    expect(shotLit({ node: "a" }, cards, groups, ["b", "c", "gone"])).toEqual({ ids: ["b", "c"], asked: true, label: null });
  });

  it("lights the node the view names, and nothing for a card the graph lacks", () => {
    expect(shotLit({ node: "b" }, cards, groups).ids).toEqual(["b"]);
    expect(shotLit({ node: "zzz" }, cards, groups)).toMatchObject({ ids: [], asked: true });
  });

  it("lights the cards inside the boxes focus names, or the cards it names", () => {
    expect(shotLit({ focus: "top" }, cards, groups).ids).toEqual(["a", "b"]);
    expect(shotLit({ focus: "c, nope" }, cards, groups).ids).toEqual(["c"]);
  });

  it("asks for nothing with no selection", () => {
    expect(shotLit({}, cards, groups)).toEqual({ ids: [], asked: false, label: null });
  });
});

describe("shotState", () => {
  it("says failed, no-matches or drawn", () => {
    expect(shotState({ failed: true, lit: { ids: ["a"], asked: true } })).toBe("failed");
    expect(shotState({ lit: { ids: [], asked: true } })).toBe("no-matches");
    expect(shotState({ lit: { ids: ["a"], asked: true } })).toBe("drawn");
    expect(shotState({ lit: { ids: [], asked: false } })).toBe("drawn");
  });
});

describe("the caption", () => {
  const at = new Date("2026-10-23T14:02:11.250Z");
  it("says a plan-depth answer is at the plan depth, in the words of the tab's query line", () => {
    const line = shotCaption({ query: "attr:planAction=replace", provenance: "observed live · bound 1/1", at, plan: true });
    expect(line).toBe('"attr:planAction=replace"  ·  observed live · bound 1/1  ·  at the plan depth  ·  2026-10-23T14:02:11Z');
    expect(shotCaption({ query: "a", at })).not.toContain("plan depth");
  });
  it("is one line: what was asked, from where, when", () => {
    expect(shotCaption({ query: "kind:Bucket", provenance: shotProvenance({ env: "prod" }), at })).toBe('"kind:Bucket"  ·  env prod, live  ·  2026-10-23T14:02:11Z');
    expect(shotCaption({ label: "node a", provenance: shotProvenance({}), at, state: "no-matches" })).toBe("no matches for node a  ·  source graph  ·  2026-10-23T14:02:11Z");
  });

  it("puts a failure first, and never breaks the line", () => {
    const line = shotCaption({ query: "a\nb", failure: "graph failed: chant\nexited 1", provenance: shotProvenance({ env: "prod", snapshot: "latest" }), at, state: "failed" });
    expect(line).not.toContain("\n");
    expect(line.startsWith("graph failed: chant exited 1")).toBe(true);
    expect(line).toContain("env prod, snapshot latest");
  });
});

describe("queryFrame (#908 stage 3)", () => {
  it("lights the lit cards and frames them with the path cards, leaving the dimmed out", () => {
    const marks = [
      { id: "bastion", mark: "lit" },
      { id: "subnet", mark: "path" },
      { id: "igw", mark: "path" },
      { id: "vpc", mark: "dim" },
      { id: "roles ×31", mark: "lit" },
      { id: "plain", mark: null },
    ];
    expect(queryFrame(marks)).toEqual({ lit: ["bastion", "roles ×31"], frame: ["bastion", "subnet", "igw", "roles ×31"] });
    expect(shotState({ lit: shotLit({}, marks, [], queryFrame(marks).lit) })).toBe("drawn");
  });

  it("frames nothing and reports no matches when nothing is lit", () => {
    const marks = [{ id: "vpc", mark: "dim" }];
    expect(queryFrame(marks)).toEqual({ lit: [], frame: [] });
    expect(shotState({ lit: shotLit({}, marks, [], queryFrame(marks).lit) })).toBe("no-matches");
  });
});
