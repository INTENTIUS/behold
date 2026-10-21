import { describe, expect, it } from "vitest";
import { manifestNote, noteSegments, renderExportNote } from "./export-note.js";

// #824: the line under an exported page.
describe("an export's note", () => {
  it("splits backticked spans out as code", () => {
    expect(noteSegments("Run this yourself: `npx @intentius/behold demo three-cloud`")).toEqual([
      { code: false, text: "Run this yourself: " },
      { code: true, text: "npx @intentius/behold demo three-cloud" },
    ]);
    expect(noteSegments("`a` and `b`.")).toEqual([
      { code: true, text: "a" },
      { code: false, text: " and " },
      { code: true, text: "b" },
      { code: false, text: "." },
    ]);
  });

  it("keeps an unclosed backtick as text", () => {
    expect(noteSegments("run `this")).toEqual([{ code: false, text: "run `this" }]);
  });

  it("reads the note from the manifest, and nothing when it has none", () => {
    expect(manifestNote({ note: "  hi  " })).toBe("hi");
    expect(manifestNote({})).toBe(null);
    expect(manifestNote(null)).toBe(null);
    expect(manifestNote({ note: 3 })).toBe(null);
  });

  it("sets the note as text, never as markup", () => {
    const made = [];
    const doc = {
      createElement: (tag) => ({ tag, textContent: "" }),
      createTextNode: (text) => ({ text }),
    };
    const el = { hidden: true, textContent: "old", appendChild: (n) => made.push(n) };
    renderExportNote(el, doc, { note: "<b>x</b> `y`" });
    expect(el.hidden).toBe(false);
    expect(made).toEqual([{ text: "<b>x</b> " }, { tag: "code", textContent: "y" }]);

    renderExportNote(el, doc, {});
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe("");
  });
});
