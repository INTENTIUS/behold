import { describe, expect, it } from "vitest";
import { sceneHoldsOn } from "./kiosk-estate-scene.js";

// A stand-in for an svg: `scene` is whether a drawn scene sits in it, `stash` the graph's own elements set aside.
const el = (cards) => ({ hasAttribute: () => false, querySelector: () => (cards ? {} : null) });
const svg = ({ scene = true, stash = [] } = {}) => ({ __klStash: stash, querySelector: () => (scene ? {} : null) });

describe("a scene that stays when its data goes missing", () => {
  it("stays when the graph's own drawing has no cards to go back to (a composed run)", () => {
    expect(sceneHoldsOn(svg({ stash: [el(false)] }))).toBe(true);
  });
  it("goes back to the graph when it has cards of its own", () => {
    expect(sceneHoldsOn(svg({ stash: [el(true)] }))).toBe(false);
    expect(sceneHoldsOn(svg({ stash: [{ hasAttribute: (a) => a === "data-node-id" }] }))).toBe(false);
  });
  it("is not a scene when none is drawn", () => {
    expect(sceneHoldsOn(svg({ scene: false }))).toBe(false);
    expect(sceneHoldsOn({ __klStash: null, querySelector: () => null })).toBe(false);
    expect(sceneHoldsOn(null)).toBe(false);
  });
});
