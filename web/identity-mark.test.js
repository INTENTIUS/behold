import { describe, it, expect } from "vitest";
import { IDENTITY_MARKS, identityKey, identityMark, tagGlyphSvg } from "./identity-mark.js";

describe("the marker-vs-derived mark", () => {
  it("tells a marker-found card from a derived one, and a derived one that wears the marker from one that does not", () => {
    expect(identityKey({ source: "marker", marked: true })).toBe("marker");
    expect(identityKey({ source: "derived", marked: true })).toBe("derived-marked");
    expect(identityKey({ source: "derived", marked: false })).toBe("derived");
    expect(identityKey({ source: "state", marked: false })).toBe("state");
  });

  it("fills the tag only when the object wears the marker", () => {
    expect(identityMark({ source: "derived", marked: true }).glyph).toBe("solid");
    expect(identityMark({ source: "derived", marked: false }).glyph).toBe("outline");
    expect(identityMark({ source: "state", marked: false }).glyph).toBe("none");
  });

  it("has no mark for an identity it does not know", () => {
    expect(identityMark(undefined)).toBeNull();
    expect(identityMark({ source: "guess" })).toBeNull();
  });

  it("keeps every label short enough for a card's corner", () => {
    for (const m of Object.values(IDENTITY_MARKS)) expect(m.label.length).toBeLessThanOrEqual(16);
  });

  it("draws a filled tag, an outlined tag, or nothing", () => {
    expect(tagGlyphSvg("solid", 0, 0, 12, "red")).toContain('fill="red"');
    expect(tagGlyphSvg("outline", 0, 0, 12, "red")).toContain('fill="none"');
    expect(tagGlyphSvg("none", 0, 0, 12, "red")).toBe("");
  });
});
