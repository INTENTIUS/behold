import { describe, it, expect } from "vitest";
import { recordedWords, mergeLandings } from "./carve-narration.js";

describe("the carve export's narration (#712)", () => {
  it("says what the recording is", () => {
    expect(recordedWords({ src: "behold-terralith-14", recording: { kind: "carve", resources: 1041, recordedAt: Date.parse("2026-09-22T16:37:26Z") } })).toBe(
      "recorded carve of behold-terralith-14, 1,041 resources, recorded 2026-09-22, replayed",
    );
    expect(recordedWords({ src: "terralith", recording: { kind: "walkthrough" } })).toBe("recorded walkthrough of terralith, replayed");
  });
  it("puts first landings that queue together in one bubble, on the newest box", () => {
    const t = (e, at) => ({ key: `land:${e}`, estate: e, at, text: e });
    expect(mergeLandings([t("a", 1)])).toEqual(t("a", 1));
    const m = mergeLandings([t("x-a", 1), t("x-b", 2), t("x-c", 3)], { "x-a": "a", "x-b": "b", "x-c": "c" });
    expect(m.estate).toBe("x-c");
    expect(m.text).toMatch(/^a, b and c: their first resources land/);
  });
});
