import { describe, expect, it } from "vitest";
import { BEAT_MS, installMotion, motionMark, motionReduced } from "./motion.js";

// behold#725: a stand-in document, enough for installMotion: a hidden flag, a root's attributes, and its listeners.
const fakeDoc = (hidden = false) => {
  const attrs = new Map();
  const listeners = new Map();
  return {
    hidden,
    documentElement: {
      setAttribute: (k, v) => attrs.set(k, String(v)),
      removeAttribute: (k) => attrs.delete(k),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
    fire: (type) => listeners.get(type) && listeners.get(type)(),
    listening: (type) => listeners.has(type),
  };
};

describe("the page's motion (behold#725)", () => {
  it("keeps the stylesheets' beat", () => {
    expect(BEAT_MS).toBe(1200);
  });

  it("marks the root paused while the tab is hidden and clears the mark when it shows again", () => {
    const doc = fakeDoc(false);
    installMotion(doc);
    expect(doc.documentElement.getAttribute("data-motion")).toBe(null);
    doc.hidden = true;
    doc.fire("visibilitychange");
    expect(doc.documentElement.getAttribute("data-motion")).toBe("paused");
    doc.hidden = false;
    doc.fire("visibilitychange");
    expect(doc.documentElement.getAttribute("data-motion")).toBe(null);
  });

  it("starts paused on a page that opens in a background tab", () => {
    const doc = fakeDoc(true);
    installMotion(doc);
    expect(doc.documentElement.getAttribute("data-motion")).toBe("paused");
  });

  it("stops listening when asked", () => {
    const doc = fakeDoc(false);
    const stop = installMotion(doc);
    expect(doc.listening("visibilitychange")).toBe(true);
    stop();
    expect(doc.listening("visibilitychange")).toBe(false);
  });

  it("does nothing without a document", () => {
    expect(() => installMotion(null)()).not.toThrow();
    expect(motionMark(null)).toBe(null);
  });

  it("reads reduced motion from the media query, and a window that can't answer as no", () => {
    expect(motionReduced({ matchMedia: (q) => ({ matches: q === "(prefers-reduced-motion: reduce)" }) })).toBe(true);
    expect(motionReduced({ matchMedia: () => ({ matches: false }) })).toBe(false);
    expect(motionReduced({ matchMedia: () => { throw new Error("no"); } })).toBe(false);
    expect(motionReduced(null)).toBe(false);
  });
});
