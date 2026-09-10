import { describe, it, expect } from "vitest";
import { CHANT_STATUS_LABELS, CHOUDOUFU_STATUS_LABELS, statusVocabulary } from "./status-vocabulary.ts";

describe("statusVocabulary (#393 item 8)", () => {
  it("speaks choudoufu's words on an estate whose members are all choudoufu", () => {
    const v = statusVocabulary(["choudoufu", "choudoufu"]);
    expect(v.of).toBe("choudoufu");
    expect(v.labels).toEqual(CHOUDOUFU_STATUS_LABELS);
    expect(v.labels.good).toBe("bound");
    expect(v.labels.warn).toBe("unowned");
    expect(v.note).toBeUndefined();
  });

  it("keeps chant's words for a chant estate, a Terraform one, and no members at all", () => {
    for (const kinds of [["chant"], ["terraform"], ["chant", "chant"], []]) {
      expect(statusVocabulary(kinds).labels).toEqual(CHANT_STATUS_LABELS);
      expect(statusVocabulary(kinds).note).toBeUndefined();
    }
  });

  it("keeps chant's words on a mixed estate and says why, because one colour cannot carry two meanings", () => {
    const v = statusVocabulary(["chant", "choudoufu"]);
    expect(v.of).toBe("mixed");
    expect(v.labels).toEqual(CHANT_STATUS_LABELS);
    expect(v.note).toContain("chant and choudoufu");
    expect(v.note).toContain("bound reads as managed");
  });

  it("paints the same four colours either way — this is naming, not a second classification", () => {
    expect(Object.keys(CHOUDOUFU_STATUS_LABELS)).toEqual(Object.keys(CHANT_STATUS_LABELS));
  });
});
