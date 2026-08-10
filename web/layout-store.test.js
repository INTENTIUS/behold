// #228: the hand-layout delta store, checked without a browser. The pointer
// work and the SVG live in app.js and are covered by smoke/ui-smoke.mjs; every
// rule that decides WHAT gets stored and under which key lives here.
import { describe, expect, it, vi } from "vitest";
import {
  applicable,
  clearLayout,
  debounce,
  fetchServerLayout,
  isEmpty,
  layoutKey,
  lensKeyOf,
  mergeLayouts,
  nodeTransform,
  normalize,
  pathAnchors,
  postServerLayout,
  projectKeyOf,
  readLayout,
  setDelta,
  slug,
  straightEdge,
  writeLayout,
} from "./layout-store.js";
// The server half of #228 — imported here on purpose: this is the one file
// that can hold both copies of the delta→SVG math at once (tsconfig excludes
// web/, so a src/*.test.ts couldn't import the browser module), and the
// parity block at the bottom is what keeps them from drifting.
import * as server from "../src/layout.ts";

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

// --- The server tier (#228, second half) ------------------------------------

describe("mergeLayouts", () => {
  it("local wins where both tiers have the same id", () => {
    expect(mergeLayouts({ api: { dx: 10 } }, { api: { dx: -99 } })).toEqual({ api: { dx: 10 } });
  });

  it("an id only the sidecar has still comes through — that's the point of sharing", () => {
    expect(mergeLayouts({ api: { dx: 10 } }, { worker: { dy: 4 } })).toEqual({ api: { dx: 10 }, worker: { dy: 4 } });
  });

  it("is the whole server layout when nothing is local (a fresh browser)", () => {
    expect(mergeLayouts({}, { api: { dx: 1 } })).toEqual({ api: { dx: 1 } });
  });

  it("normalizes both sides, so junk from either can't reach the SVG", () => {
    expect(mergeLayouts({ a: { dx: 0 } }, { b: "nope", c: { dy: 3 } })).toEqual({ c: { dy: 3 } });
  });
});

describe("fetchServerLayout", () => {
  const res = (body, ok = true) => ({ ok, json: async () => body });

  it("asks for one lens and normalizes what comes back", async () => {
    const fetchFn = vi.fn(async () => res({ lens: "components", deltas: { api: { dx: "5" }, junk: { dx: 0 } }, writable: true }));
    expect(await fetchServerLayout(fetchFn, "components")).toEqual({ deltas: { api: { dx: 5 } }, writable: true });
    expect(fetchFn).toHaveBeenCalledWith("/api/layout?lens=components");
  });

  it("encodes the lens key (a stack name can be anything)", async () => {
    const fetchFn = vi.fn(async () => res({ deltas: {}, writable: false }));
    await fetchServerLayout(fetchFn, "resources+stack-edge");
    expect(fetchFn).toHaveBeenCalledWith("/api/layout?lens=resources%2Bstack-edge");
  });

  it("a refusal is an empty, unwritable answer — never a throw", async () => {
    expect(await fetchServerLayout(async () => res({ error: "read-only" }, false), "components")).toEqual({ deltas: {}, writable: false });
    expect(await fetchServerLayout(async () => {
      throw new Error("offline");
    }, "components")).toEqual({ deltas: {}, writable: false });
  });
});

describe("postServerLayout", () => {
  it("posts the normalized lens map as JSON", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true }));
    expect(await postServerLayout(fetchFn, "components", { api: { dx: 3, dy: 0 } })).toBe(true);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/layout");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.keepalive).toBe(true); // survives a flush on the way out of the page
    expect(JSON.parse(init.body)).toEqual({ lens: "components", deltas: { api: { dx: 3 } } });
  });

  it("a rejection is false, not an exception (offline is fine — localStorage has it)", async () => {
    expect(await postServerLayout(async () => ({ ok: false }), "components", {})).toBe(false);
    expect(
      await postServerLayout(async () => {
        throw new Error("offline");
      }, "components", {}),
    ).toBe(false);
  });
});

describe("debounce", () => {
  const fakeTimers = () => {
    const timers = [];
    return { timers, set: (cb) => timers.push(cb) - 1, clear: (i) => (timers[i] = null), run: () => timers.forEach((cb) => cb && cb()) };
  };

  it("fires once, with the last arguments — a drag is one write, not sixty", () => {
    const t = fakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100, t.set, t.clear);
    d("a");
    d("b");
    d("c");
    t.run();
    expect(fn.mock.calls).toEqual([["c"]]);
  });

  it("flush runs a pending call now — what a page leaving mid-debounce needs", () => {
    const t = fakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100, t.set, t.clear);
    d("a");
    d.flush();
    expect(fn.mock.calls).toEqual([["a"]]);
    t.run(); // the cancelled timer must not fire it a second time
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flush with nothing pending does nothing", () => {
    const t = fakeTimers();
    const fn = vi.fn();
    debounce(fn, 100, t.set, t.clear).flush();
    expect(fn).not.toHaveBeenCalled();
  });
});

// --- Parity with src/layout.ts ----------------------------------------------
// The client paints the deltas in the browser; the server bakes the same ones
// into an exported SVG. If these two ever disagree, an export stops matching
// the screen it was taken from — silently. So they are checked against each
// other here, on the same table.
describe("the delta→SVG math matches the server's copy", () => {
  const CASES = [
    ["translate(40, 80)", { dx: 12, dy: -4 }],
    ["translate(40, 80) scale(0.9)", { dx: 0.5, dy: 0 }],
    ["", { dx: 3, dy: 4 }],
    ["translate(1, 2)", { dx: 0, dy: 0 }],
    ["translate(1, 2)", { dw: 20, dh: 10 }],
    ["translate(1, 2)", {}],
  ];
  it("nodeTransform", () => {
    for (const [base, d] of CASES) expect(nodeTransform(base, d)).toBe(server.nodeTransform(base, d));
    expect(nodeTransform("translate(40, 80)", { dx: 12, dy: -4 })).toBe("translate(12, -4) translate(40, 80)");
    expect(nodeTransform("translate(1, 2)", { dw: 5 })).toBe("translate(1, 2)");
  });

  it("pathAnchors", () => {
    const DS = ["M 115 112 C 115 112, 305 112, 305 112", "M1 2L3 4", "M 1e2 -3.5 L 7 8", "M 1 2", "", null];
    for (const d of DS) expect(pathAnchors(d)).toEqual(server.pathAnchors(d));
    expect(pathAnchors("M 115 112 C 115 112, 305 112, 305 112")).toEqual({ sx: 115, sy: 112, ex: 305, ey: 112 });
  });

  it("straightEdge", () => {
    const a = { sx: 115, sy: 112, ex: 305, ey: 112 };
    for (const [from, to] of [
      [{ dx: 10, dy: 5 }, undefined],
      [undefined, { dx: -2.5, dy: 0 }],
      [{ dx: 1 }, { dy: 2 }],
      [undefined, undefined],
    ]) {
      expect(straightEdge(a, from, to)).toBe(server.straightEdge(a, from, to));
    }
    expect(straightEdge(a, { dx: 10, dy: 5 }, undefined)).toBe("M 125 117 L 305 112");
  });

  it("slug and normalize agree, so a key written by one is read by the other", () => {
    for (const s of ["/estates/stub-estate", "Resources+Radial", "///", "", "stack-edge"]) expect(slug(s)).toBe(server.slug(s));
    for (const raw of [{ a: { dx: 1, dy: 0 } }, { a: { dx: "12.5" } }, { a: 5 }, null, "nope", { a: { dx: NaN } }]) {
      expect(normalize(raw)).toEqual(server.normalizeDeltas(raw));
    }
  });

  it("the lens key the client stores under is the one the server derives from a request", () => {
    const q = (s) => new URLSearchParams(s);
    expect(server.lensFromQuery(q("components=1"))).toBe(lensKeyOf({ zoom: "components" }));
    expect(server.lensFromQuery(q("logical=1"))).toBe(lensKeyOf({ zoom: "logical" }));
    expect(server.lensFromQuery(q("env=prod&runtime=1&detail=3"))).toBe(lensKeyOf({ zoom: "runtime" }));
    expect(server.lensFromQuery(q("detail=1"))).toBe(lensKeyOf({ zoom: "composites" }));
    expect(server.lensFromQuery(q("detail=3"))).toBe(lensKeyOf({ zoom: "attributes" }));
    expect(server.lensFromQuery(q(""))).toBe(lensKeyOf({ zoom: "resources" }));
    expect(server.lensFromQuery(q("detail=2&radial=1"))).toBe(lensKeyOf({ zoom: "resources", radial: true }));
    expect(server.lensFromQuery(q("detail=2&stack=edge"))).toBe(lensKeyOf({ zoom: "resources", stack: "edge" }));
    // The env is in neither — an overlay recolours the same nodes (#228).
    expect(server.lensFromQuery(q("components=1&env=prod&tier=dev"))).toBe(server.lensFromQuery(q("components=1")));
  });
});
