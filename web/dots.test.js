// #712: unmounted, the dots layer changes nothing in the app. app.js calls
// these on every camera move and every wheel event; with no preview mounted
// they must be no-ops and leave today's 3x zoom-out limit in place.
import { describe, it, expect } from "vitest";
import { dotsActive, dotsZoomOutFactor, dotsCamera, unmountDots } from "./dots.js";

describe("the dots layer when the preview is off (#712)", () => {
  it("is inactive, sets no zoom limit and ignores the camera", () => {
    expect(dotsActive()).toBe(false);
    expect(dotsZoomOutFactor()).toBe(null);
    expect(() => dotsCamera()).not.toThrow();
    expect(() => unmountDots()).not.toThrow();
    expect(dotsActive()).toBe(false);
  });
});
