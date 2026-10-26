import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composedReportOf, composedView } from "../src/chant-compose.ts";
import { drawScene, sceneModel } from "./kiosk-estate-scene.js";
import { readingRows } from "./kiosk.js";
import { planOf } from "./kiosk-light.js";
import { HOLE_WORDS, KIND_ROWS, KIND_TAGS, memberKinds } from "./member-kind.js";

// behold#1008: a composed chant run draws a hole member's box and a previewed member's box differently, and the
// kiosk's "How to read this" says what each mark means. The run is behold#969's create plan
// (src/__fixtures__/chant-compose/create-plan.json): network creates subnetB, app reads its id unknown (previewed),
// edge reads app's known values (plain). As src/chant-compose.test.ts does, edge is made a hole.
const FIX = join(import.meta.dirname, "..", "src", "__fixtures__", "chant-compose");
const plan = () => JSON.parse(readFileSync(join(FIX, "create-plan.json"), "utf8"));
const REASON = "no preview: CloudFormation refused the stand-in";
const OPEN = { width: 1900, height: 740 };

function withHole(entriesToo) {
  const doc = plan();
  doc.changeSet.members.find((m) => m.member === "edge").holes = [{ address: "allowlist", reason: REASON }];
  if (!entriesToo) doc.changeSet.entries = doc.changeSet.entries.filter((e) => e.member !== "edge");
  return composedView(composedReportOf(doc), undefined);
}

// A stand-in for the svg drawScene writes into: elements with attributes, children and text, enough to walk.
function fakeNode(tag) {
  const n = {
    tagName: tag,
    attrs: {},
    children: [],
    parent: null,
    textContent: "",
    setAttribute: (k, v) => void (n.attrs[k] = v),
    getAttribute: (k) => (k in n.attrs ? n.attrs[k] : null),
    hasAttribute: (k) => k in n.attrs,
    appendChild: (c) => {
      if (c.parent) c.remove();
      c.parent = n;
      n.children.push(c);
      return c;
    },
    remove: () => {
      if (!n.parent) return;
      n.parent.children = n.parent.children.filter((x) => x !== n);
      n.parent = null;
    },
    querySelectorAll: (sel) => {
      const m = /^:scope > \[([\w-]+)\]$/.exec(sel);
      return m ? n.children.filter((c) => c.hasAttribute(m[1])) : [];
    },
    querySelector: (sel) => n.querySelectorAll(sel)[0] || null,
  };
  return n;
}
const walk = (n) => [n, ...n.children.flatMap(walk)];
const drawn = (model) => {
  const svg = fakeNode("svg");
  drawScene(svg, model);
  return walk(svg);
};
const withAttr = (nodes, k, v) => nodes.filter((n) => n.attrs[k] === v);

let was;
beforeEach(() => {
  was = globalThis.document;
  globalThis.document = { createElementNS: (_ns, tag) => fakeNode(tag) };
});
afterEach(() => {
  globalThis.document = was;
});

describe("a hole member and a previewed member, drawn apart (behold#1008)", () => {
  it("reads each member's kind from the composed answer", () => {
    const v = withHole(true);
    expect([...memberKinds(v.answer)].map(([m, k]) => [m, k.kind])).toEqual([["app", "previewed"], ["edge", "hole"], ["network", "plain"]]);
    expect(memberKinds(v.answer).get("edge").reasons).toEqual([REASON]);
    expect(memberKinds(null).size).toBe(0);
  });

  it("puts one hole mark on edge's box and the previewed mark on app's, and none on network's", () => {
    const v = withHole(true);
    const nodes = drawn(sceneModel(v.answer, planOf(v.answer), null, OPEN));
    const boxes = nodes.filter((n) => n.hasAttribute("data-layout-box"));
    expect(boxes.map((b) => [b.attrs["data-layout-box"], b.attrs["data-member-kind"]])).toEqual([
      ["box:network", "plain"],
      ["box:app", "previewed"],
      ["box:edge", "hole"],
    ]);
    const holes = withAttr(nodes, "data-kl-kind-mark", "hole");
    const previewed = withAttr(nodes, "data-kl-kind-mark", "previewed");
    expect(holes).toHaveLength(1);
    expect(previewed).toHaveLength(1);
    expect(holes[0].parent.attrs["data-layout-box"]).toBe("box:edge");
    expect(previewed[0].parent.attrs["data-layout-box"]).toBe("box:app");
    expect(walk(holes[0]).some((n) => n.textContent === KIND_TAGS.hole)).toBe(true);
    expect(walk(previewed[0]).some((n) => n.textContent === KIND_TAGS.previewed)).toBe(true);
    // The hole's box is dashed; the others are not.
    const outline = (name) => nodes.find((n) => n.attrs["data-group-id"] === name);
    expect(outline("edge").attrs["stroke-dasharray"]).toBeTruthy();
    expect(outline("app").attrs["stroke-dasharray"]).toBeUndefined();
    expect(outline("network").attrs["stroke-dasharray"]).toBeUndefined();
    // Every member's cards are still there: network's subnet, app's interface, edge's allowlist.
    expect(nodes.filter((n) => n.hasAttribute("data-node-id")).map((n) => n.attrs["data-node-id"])).toEqual(["chant/network/subnetB", "chant/app/workerInterface", "chant/edge/allowlist"]);
  });

  it("keeps a hole's box when nothing was previewed in it, with an empty slot saying so and why", () => {
    const v = withHole(false);
    const m = sceneModel(v.answer, planOf(v.answer), null, OPEN);
    expect(m.roots.map((r) => [r.path, r.kind, r.cards.length])).toEqual([["network", "plain", 1], ["app", "previewed", 1], ["edge", "hole", 0]]);
    const edge = m.roots[2];
    expect(edge.hole).toMatchObject({ words: HOLE_WORDS, reasons: [REASON] });
    expect(edge.hole.y).toBeGreaterThanOrEqual(edge.y);
    expect(edge.hole.y + edge.hole.h).toBeLessThanOrEqual(edge.y + edge.h);
    const nodes = drawn(m);
    const slot = nodes.filter((n) => n.attrs["data-kl-hole"] === "edge");
    expect(slot).toHaveLength(1);
    expect(walk(slot[0]).map((n) => n.textContent)).toContain(HOLE_WORDS);
    expect(walk(slot[0]).map((n) => n.textContent)).toContain(REASON);
    expect(withAttr(nodes, "data-kl-kind-mark", "hole")).toHaveLength(1);
  });

  it("draws no mark on a run with no kinds (a composed choudoufu run)", () => {
    const v = withHole(true);
    const answer = { ...v.answer, chant: undefined };
    const nodes = drawn(sceneModel(answer, planOf(answer), null, OPEN));
    expect(nodes.filter((n) => n.hasAttribute("data-member-kind"))).toEqual([]);
    expect(nodes.filter((n) => n.hasAttribute("data-kl-kind-mark"))).toEqual([]);
  });

  it("says in the legend what the hole mark and the previewed mark mean, on chant's composed page alone", () => {
    const rows = readingRows("resources", "chant-compose");
    expect(rows.filter((r) => r.mark === "hole")).toEqual([KIND_ROWS[0]]);
    expect(rows.filter((r) => r.mark === "previewed")).toEqual([KIND_ROWS[1]]);
    expect(KIND_ROWS[0].words).toMatch(/^Dashed box: a stack no preview could be made of\.$/);
    expect(KIND_ROWS[1].words).toMatch(/^Tag previewed: some values known after apply\.$/);
    for (const r of KIND_ROWS) expect(r.words.length, r.words).toBeLessThanOrEqual(50);
    for (const tool of [null, "chant", "terragrunt", "choudoufu-compose"]) for (const view of ["components", "resources"]) expect(readingRows(view, tool).some((r) => r.mark === "hole" || r.mark === "previewed")).toBe(false);
  });
});
