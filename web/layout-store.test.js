// #228: the hand-layout delta store, checked without a browser. The pointer
// work and the SVG live in app.js and are covered by smoke/ui-smoke.mjs; every
// rule that decides WHAT gets stored and under which key lives here.
import { describe, expect, it } from "vitest";
import {
  applicable,
  clearLayout,
  isEmpty,
  layoutKey,
  lensKeyOf,
  normalize,
  projectKeyOf,
  readLayout,
  setDelta,
  slug,
  writeLayout,
} from "./layout-store.js";

/** A localStorage stand-in; `fail` makes every operation throw (private mode). */
function fakeStorage(seed = {}, fail = false) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem(k) {
      if (fail) throw new Error("nope");
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (fail) throw new Error("nope");
      map.set(k, v);
    },
    removeItem(k) {
      if (fail) throw new Error("nope");
      map.delete(k);
    },
  };
}

describe("keys", () => {
  it("slugs a project dir and a lens into one readable key", () => {
    expect(layoutKey("/estates/stub-estate", "components")).toBe("behold.layout.estates-stub-estate.components");
  });

  it("takes the project half from /api/project's projectDir", () => {
    expect(projectKeyOf({ projectDir: "/Users/me/work/My Estate" })).toBe("users-me-work-my-estate");
    expect(projectKeyOf(null)).toBe("unknown");
    expect(projectKeyOf({})).toBe("unknown");
  });

  it("gives the logical lens and the plain graph independent keys (#228 acceptance)", () => {
    const p = "/estates/x";
    expect(layoutKey(p, lensKeyOf({ zoom: "logical" }))).not.toBe(layoutKey(p, lensKeyOf({ zoom: "resources" })));
  });

  it("separates radial from straight, and one stack from another", () => {
    expect(lensKeyOf({ zoom: "resources", radial: true })).toBe("resources+radial");
    expect(lensKeyOf({ zoom: "resources", stack: "edge" })).toBe("resources+stack-edge");
    expect(lensKeyOf({ zoom: "resources" })).toBe("resources");
    expect(layoutKey("/e", lensKeyOf({ zoom: "resources", radial: true }))).not.toBe(layoutKey("/e", lensKeyOf({ zoom: "resources" })));
  });

  it("keeps the env OUT of the key — an overlay recolours, it does not re-place", () => {
    expect(lensKeyOf({ zoom: "components", env: "prod" })).toBe(lensKeyOf({ zoom: "components" }));
  });

  it("never produces an empty segment", () => {
    expect(slug("///")).toBe("unknown");
    expect(layoutKey("", "")).toBe("behold.layout.unknown.unknown");
  });
});

describe("normalize", () => {
  it("keeps finite non-zero deltas only", () => {
    expect(normalize({ a: { dx: 10, dy: 0, dw: 4 } })).toEqual({ a: { dx: 10, dw: 4 } });
  });

  it("drops junk without throwing", () => {
    expect(normalize(null)).toEqual({});
    expect(normalize("nope")).toEqual({});
    expect(normalize({ a: 5, b: null, c: { dx: NaN }, d: { dx: "x" }, e: { nope: 1 } })).toEqual({});
  });

  it("parses numeric strings (JSON round-trips are not always clean)", () => {
    expect(normalize({ a: { dx: "12.5" } })).toEqual({ a: { dx: 12.5 } });
  });

  it("isEmpty ignores entries that normalize away", () => {
    expect(isEmpty({ a: { dx: 0, dy: 0 } })).toBe(true);
    expect(isEmpty({ a: { dx: 1 } })).toBe(false);
  });
});

describe("setDelta", () => {
  it("replaces one id and leaves the rest alone", () => {
    const next = setDelta({ a: { dx: 1 }, b: { dy: 2 } }, "a", { dx: 9, dy: 9 });
    expect(next).toEqual({ a: { dx: 9, dy: 9 }, b: { dy: 2 } });
  });

  it("prunes an id dragged back to where dagre put it", () => {
    expect(setDelta({ a: { dx: 1 } }, "a", { dx: 0, dy: 0 })).toEqual({});
  });

  it("does not mutate its input", () => {
    const before = { a: { dx: 1 } };
    setDelta(before, "a", { dx: 4 });
    expect(before).toEqual({ a: { dx: 1 } });
  });

  it("carries a box's size delta alongside its position delta", () => {
    expect(setDelta({}, "box:vpc", { dx: 3, dy: 0, dw: 40, dh: -20 })).toEqual({ "box:vpc": { dx: 3, dw: 40, dh: -20 } });
  });
});

describe("applicable", () => {
  it("silently drops a delta for a node that left the estate", () => {
    expect(applicable({ gone: { dx: 5 }, here: { dy: 3 } }, ["here"])).toEqual({ here: { dy: 3 } });
  });

  it("takes a Set as well as an array", () => {
    expect(applicable({ a: { dx: 1 } }, new Set(["a"]))).toEqual({ a: { dx: 1 } });
  });

  it("is a no-op filter when nothing is live", () => {
    expect(applicable({ a: { dx: 1 } }, [])).toEqual({});
  });
});

describe("storage", () => {
  it("round-trips through a storage", () => {
    const s = fakeStorage();
    const key = layoutKey("/estates/x", "components");
    writeLayout(s, key, { api: { dx: 12, dy: -4 } });
    expect(readLayout(s, key)).toEqual({ api: { dx: 12, dy: -4 } });
  });

  it("removes the key rather than storing an empty layout", () => {
    const s = fakeStorage();
    writeLayout(s, "k", { api: { dx: 1 } });
    writeLayout(s, "k", {});
    expect(s.map.has("k")).toBe(false);
    expect(readLayout(s, "k")).toEqual({});
  });

  it("survives a corrupt value", () => {
    expect(readLayout(fakeStorage({ k: "{not json" }), "k")).toEqual({});
  });

  it("survives a storage that throws (private mode, quota, file://)", () => {
    const s = fakeStorage({}, true);
    expect(() => writeLayout(s, "k", { a: { dx: 1 } })).not.toThrow();
    expect(readLayout(s, "k")).toEqual({});
    expect(() => clearLayout(s, "k")).not.toThrow();
  });

  it("clearLayout drops just this lens's key", () => {
    const s = fakeStorage();
    writeLayout(s, layoutKey("/e", "components"), { a: { dx: 1 } });
    writeLayout(s, layoutKey("/e", "logical"), { a: { dy: 2 } });
    clearLayout(s, layoutKey("/e", "components"));
    expect(readLayout(s, layoutKey("/e", "components"))).toEqual({});
    expect(readLayout(s, layoutKey("/e", "logical"))).toEqual({ a: { dy: 2 } });
  });
});
