// behold#1180: what a bundle's /graph page reads from its #g-bundle block, and what it changes.
import { describe, expect, it } from "vitest";
import { DEFAULT_BUNDLE, applyBundle, paneOptions, readBundle } from "./graph-static.js";

/** The few elements the helpers touch, as a document would hold them. */
function fakeDoc(bundleText) {
  const els = {
    "g-bundle": bundleText === undefined ? null : { textContent: bundleText },
    "g-back": { attrs: { href: "/" }, textContent: "Back to the estate", setAttribute(k, v) { this.attrs[k] = v; } },
    "g-cypher": { value: "MATCH (a) RETURN a" },
    "g-params": { value: "" },
    "d-section": { removed: false, remove() { this.removed = true; } },
  };
  return { els, getElementById: (id) => els[id] ?? null };
}

describe("readBundle", () => {
  it("reads the block, keeping only the fields it knows", () => {
    const b = { estate: null, back: { href: "./", label: "Back to the demo" }, searches: ["a", 3], indexVersions: false, cypher: { query: "MATCH (r) RETURN r", params: { key: "k" } }, extra: 1 };
    expect(readBundle(fakeDoc(JSON.stringify(b)))).toEqual({ estate: null, back: { href: "./", label: "Back to the demo" }, searches: ["a"], indexVersions: false, cypher: { query: "MATCH (r) RETURN r", params: { key: "k" } } });
  });

  it("takes an estate view beside the page where the block is missing or not JSON", () => {
    expect(readBundle(fakeDoc(undefined))).toBe(DEFAULT_BUNDLE);
    expect(readBundle(fakeDoc("{"))).toBe(DEFAULT_BUNDLE);
    expect(readBundle(fakeDoc("{}"))).toEqual({ estate: null, back: DEFAULT_BUNDLE.back, searches: [], indexVersions: false });
  });
});

describe("paneOptions", () => {
  it("hides the estate links only when the bundle has no estate view", () => {
    expect(paneOptions(DEFAULT_BUNDLE)).toEqual({ bundle: { estate: { href: "./" }, searches: [] }, viewLinks: true });
    expect(paneOptions({ ...DEFAULT_BUNDLE, estate: null, searches: ["q"] })).toEqual({ bundle: { estate: null, searches: ["q"] }, viewLinks: false });
  });
});

describe("applyBundle", () => {
  it("points the header link back, starts the Cypher box, and leaves out the diff without index versions", () => {
    const doc = fakeDoc();
    applyBundle(doc, { estate: null, back: { href: "./", label: "Back to the demo" }, searches: [], indexVersions: false, cypher: { query: "MATCH (r {key: $key}) RETURN r.key", params: { key: "gcp/webRule" } } });
    expect(doc.els["g-back"].attrs.href).toBe("./");
    expect(doc.els["g-back"].textContent).toBe("Back to the demo");
    expect(doc.els["g-cypher"].value).toBe("MATCH (r {key: $key}) RETURN r.key");
    expect(doc.els["g-params"].value).toBe('{"key":"gcp/webRule"}');
    expect(doc.els["d-section"].removed).toBe(true);
  });

  it("keeps the page's query, and the diff with index versions", () => {
    const doc = fakeDoc();
    applyBundle(doc, { ...DEFAULT_BUNDLE, indexVersions: true });
    expect(doc.els["g-cypher"].value).toBe("MATCH (a) RETURN a");
    expect(doc.els["d-section"].removed).toBe(false);
    applyBundle(doc, { ...DEFAULT_BUNDLE, cypher: { query: "MATCH (b) RETURN b", params: {} } });
    expect(doc.els["g-params"].value).toBe("");
  });
});
