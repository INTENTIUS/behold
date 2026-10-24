import { describe, expect, it } from "vitest";
import { graphFolds, graphPending } from "./kiosk-graph-pane.js";

const base = { vendor: { id: "terragucci" }, ok: false, askOn: false, seen: false, pending: false };

describe("when the graph pane folds away", () => {
  it("folds for a tool with no graph, once the reads are in", () => {
    expect(graphFolds(base)).toBe(true);
  });
  it("never folds while the graph is there", () => {
    expect(graphFolds({ ...base, ok: true })).toBe(false);
  });
  it("not before the page has read the project and the answer (the moment after a reload)", () => {
    expect(graphFolds({ ...base, pending: true })).toBe(false);
  });
  it("not in ask mode: the graph is half of the story", () => {
    expect(graphFolds({ ...base, askOn: true })).toBe(false);
  });
  it("not after the graph has been shown on this page (a stale or failed read keeps it)", () => {
    expect(graphFolds({ ...base, seen: true })).toBe(false);
  });
  it("a page with no tool folds nothing", () => {
    expect(graphFolds({ ...base, vendor: null })).toBe(false);
  });
});

describe("whether a read is still to come", () => {
  it("until /api/project has answered", () => {
    expect(graphPending({ own: false, single: null, answer: { a: 1 } })).toBe(true);
  });
  it("until the terragucci answer is in, for a tool that reads it", () => {
    expect(graphPending({ own: false, single: true, answer: null })).toBe(true);
    expect(graphPending({ own: false, single: true, answer: { error: "x" } })).toBe(false);
  });
  it("a tool with its own reads waits for the project only", () => {
    expect(graphPending({ own: true, single: false, answer: null })).toBe(false);
  });
});

import { graphMayShow, keepsSceneInAsk, mayTellDrawn } from "./kiosk-graph-pane.js";

describe("graphMayShow: ask mode never paints the plain resource graph", () => {
  const ask = { askOn: true, components: false, sceneUp: false, answerSettled: false, answerHasScene: false };
  it("Inspect (not ask mode) always shows the graph", () => {
    expect(graphMayShow({ ...ask, askOn: false })).toBe(true);
  });
  it("the components view always shows", () => {
    expect(graphMayShow({ ...ask, components: true })).toBe(true);
  });
  it("holds before the reports are in", () => {
    expect(graphMayShow(ask)).toBe(false);
  });
  it("holds while the reports have a scene the pin hides for now", () => {
    expect(graphMayShow({ ...ask, answerSettled: true, answerHasScene: true })).toBe(false);
  });
  it("holds on a failed read", () => {
    expect(graphMayShow({ ...ask, answerSettled: false })).toBe(false);
  });
  it("shows once the scene is drawn, and keeps showing when the reads go missing", () => {
    expect(graphMayShow({ ...ask, sceneUp: true })).toBe(true);
  });
  it("a repo whose reports hold no scene shows its own graph", () => {
    expect(graphMayShow({ ...ask, answerSettled: true, answerHasScene: false })).toBe(true);
  });
});

describe("keepsSceneInAsk", () => {
  it("keeps a drawn scene in ask mode, never outside it", () => {
    expect(keepsSceneInAsk({ askOn: true, sceneUp: true })).toBe(true);
    expect(keepsSceneInAsk({ askOn: true, sceneUp: false })).toBe(false);
    expect(keepsSceneInAsk({ askOn: false, sceneUp: true })).toBe(false);
  });
});

describe("mayTellDrawn", () => {
  it("waits for the kiosk's word on ask mode, for a while", () => {
    expect(mayTellDrawn({ askHeard: false, waitedMs: 500, askOn: false, mayShow: true })).toBe(false);
    expect(mayTellDrawn({ askHeard: false, waitedMs: 3500, askOn: false, mayShow: true })).toBe(true);
  });
  it("in ask mode, not until the graph may show", () => {
    expect(mayTellDrawn({ askHeard: true, waitedMs: 9000, askOn: true, mayShow: false })).toBe(false);
    expect(mayTellDrawn({ askHeard: true, waitedMs: 9000, askOn: true, mayShow: true })).toBe(true);
  });
  it("outside ask mode, as before", () => {
    expect(mayTellDrawn({ askHeard: true, waitedMs: 0, askOn: false, mayShow: false })).toBe(true);
  });
});
