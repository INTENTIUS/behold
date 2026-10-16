import { describe, expect, it } from "vitest";
import { inspectStartsFolded } from "./inspect-pane.js";

// behold#696: on a phone the inspect pane starts folded, so the graph has the width.
describe("inspectStartsFolded", () => {
  it("starts folded on a phone and in a frame, open on a wide screen", () => {
    expect(inspectStartsFolded(null, { phone: true })).toBe(true);
    expect(inspectStartsFolded(null, { embed: true })).toBe(true);
    expect(inspectStartsFolded(null, {})).toBe(false);
  });
  it("keeps the viewer's own choice", () => {
    expect(inspectStartsFolded("0", { phone: true })).toBe(false);
    expect(inspectStartsFolded("1", {})).toBe(true);
  });
});
