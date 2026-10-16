import { describe, expect, it } from "vitest";
import { noStateFill } from "./frame-fill.js";
import { contrast, frameInks, inkOn, pinTokensFor, tokensFor } from "./theme.js";
import { THEMES } from "./themes.js";

// behold#571: a card in the kiosk's frame with no state yet wears the neutral
// card ground, never its category hue (crimson in Sea Shells, which read as
// "broken"), and stays readable on it in every theme.
describe("the kiosk frame's card fill (behold#571)", () => {
  it("is the neutral ground in the frame, on a graph with no live read", () => {
    expect(noStateFill({ frame: true })).toBe(true);
    expect(noStateFill({ frame: true, live: true })).toBe(false);
    expect(noStateFill({ frame: false })).toBe(false);
  });

  it("was Sea Shells' crimson before, and is its neutral card ground now", () => {
    const th = THEMES["Sea Shells"];
    const fill = pinTokensFor(th).neutralFill;
    expect(fill).not.toBe(tokensFor(th).degraded);
    expect(contrast(fill, "#b8304a")).toBeGreaterThan(1.5);
  });

  it("keeps a card's name and every state's words readable on it, in every theme (frameInks)", () => {
    const short = [];
    for (const th of Object.values(THEMES)) {
      const fill = pinTokensFor(th).neutralFill;
      const name = inkOn(fill);
      if (contrast(name, fill) < 4.5) short.push(`${th.name} name ${name} on ${fill}: ${contrast(name, fill).toFixed(2)}`);
      const inks = frameInks(th).card;
      for (const [s, c] of Object.entries(inks)) if (contrast(c, fill) < 4.5) short.push(`${th.name} ${s} ${c} on ${fill}`);
    }
    expect(short).toEqual([]);
  });
});
