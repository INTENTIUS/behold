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
