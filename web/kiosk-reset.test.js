import { describe, expect, it } from "vitest";
import { resetShown } from "./kiosk-reset.js";

describe("the reset modal", () => {
  it("shows for a reset step in ask mode, and for nothing else", () => {
    expect(resetShown({ step: "reset" }, true)).toBe(true);
    expect(resetShown({ step: "reset" }, false)).toBe(false);
    expect(resetShown({ step: "applied" }, true)).toBe(false);
    expect(resetShown(null, true)).toBe(false);
  });
});
