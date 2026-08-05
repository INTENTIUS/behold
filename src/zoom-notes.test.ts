import { describe, expect, it } from "vitest";
import { zoomNote, edgelessNote, notesFor, type NotableGraph } from "./zoom-notes.ts";

const graph = (nodes: number, edges: number, byContainer?: Record<string, string[]>): NotableGraph => ({
  nodes: Array.from({ length: nodes }, (_, i) => ({ id: `n${i}` })),
  edges: Array.from({ length: edges }, (_, i) => ({ from: `n${i}`, to: "n0" })),
  ...(byContainer ? { groups: { byContainer } } : {}),
});

describe("zoomNote", () => {
  it("says nothing about a level that rendered what it promised", () => {
    expect(zoomNote("components", graph(5, 4))).toBeUndefined();
    expect(zoomNote("logical", graph(9, 3))).toBeUndefined();
    expect(zoomNote("runtime", graph(15, 0, { dep: ["pod"] }))).toBeUndefined();
  });

  it("explains an empty components view rather than leaving it blank", () => {
    expect(zoomNote("components", graph(0, 0))).toMatch(/no components discovered/);
  });

  // #74: the projection is AWS-only by design, which is indistinguishable from
  // a broken lens unless it says so.
  it("explains an empty logical view as the AWS-only projection it is", () => {
    expect(zoomNote("logical", graph(0, 0))).toMatch(/AWS projection/);
  });

  // The case that made #131: composites IS resources plus component edges, so
  // with none attached it renders as the level below and looked like the
  // picker had not moved.
  it("says when composites attached no component edges", () => {
    expect(zoomNote("composites", graph(11, 0), 0)).toMatch(/no component ownership/);
  });

  it("says nothing when composites did attach edges", () => {
    expect(zoomNote("composites", graph(11, 4), 4)).toBeUndefined();
  });

  // Not knowing is different from knowing there were none — a caller that
  // cannot count must not produce a note claiming there were zero.
  it("stays silent when the attached-edge count is unknown", () => {
    expect(zoomNote("composites", graph(11, 0), undefined)).toBeUndefined();
  });

  it("says when the runtime tier found nothing below the declaration boundary", () => {
    expect(zoomNote("runtime", graph(11, 0))).toMatch(/below the declaration boundary/);
    expect(zoomNote("runtime", graph(11, 0, {}))).toMatch(/below the declaration boundary/);
  });

  it("has nothing to add about the plain entity levels", () => {
    expect(zoomNote("resources", graph(11, 0))).toBeUndefined();
    expect(zoomNote("attributes", graph(11, 2))).toBeUndefined();
  });
});

describe("edgelessNote", () => {
  // A flat row of nodes reads as a broken renderer; it is an accurate picture
  // of a project that declares no references (#84, chant#1493).
  it("names the reason an entity view is one flat row", () => {
    expect(edgelessNote("resources", graph(11, 0))).toMatch(/no edges/);
    expect(edgelessNote("attributes", graph(11, 0))).toMatch(/no edges/);
    expect(edgelessNote("composites", graph(11, 0))).toMatch(/no edges/);
    expect(edgelessNote("runtime", graph(15, 0))).toMatch(/no edges/);
  });

  it("says nothing when there are edges", () => {
    expect(edgelessNote("resources", graph(11, 3))).toBeUndefined();
  });

  // An empty view has its own note; adding "no edges" to it would be noise.
  it("says nothing about an empty graph", () => {
    expect(edgelessNote("resources", graph(0, 0))).toBeUndefined();
  });

  // Both lay themselves out — waves and nested boxes — so edge count is not a
  // meaningful judgement of either.
  it("exempts the two levels that do not draw edges", () => {
    expect(edgelessNote("components", graph(5, 0))).toBeUndefined();
    expect(edgelessNote("logical", graph(9, 0))).toBeUndefined();
  });
});

describe("notesFor", () => {
  it("joins both notes when both apply", () => {
    const n = notesFor("composites", graph(11, 0), 0);
    expect(n).toMatch(/no component ownership/);
    expect(n).toMatch(/no edges/);
    expect(n).toContain(" · ");
  });

  it("returns undefined for a view with nothing to explain", () => {
    expect(notesFor("resources", graph(11, 5))).toBeUndefined();
  });

  // The real shape of fountain-ops, the project #131 was measured against.
  it("describes a pure-k8s estate at every collapsed level", () => {
    expect(notesFor("components", graph(5, 4))).toBeUndefined();
    expect(notesFor("logical", graph(0, 0))).toMatch(/AWS projection/);
    expect(notesFor("resources", graph(11, 0))).toMatch(/no edges/);
    expect(notesFor("runtime", graph(15, 0, { dep: ["pod"] }))).toMatch(/no edges/);
  });
});
