// #240: a few pathological palettes (Darkermatrix and friends) leave --muted
// illegible on --panel because the quieted fg/panel mix lands well under a
// readable ratio. tokensFor() pushes --muted's OKLCH L away from --panel's
// until a real WCAG contrast() clears the floor (#229's guaranteed-visible
// trick for --active, generalised to an actual ratio). smoke/ui-smoke.mjs
// sweeps all 552 palettes for the same assertion; this pins the exact
// palette the issue was filed against, with no browser involved.
import { describe, it, expect } from "vitest";
import { contrast, desaturate, mix, tokensFor } from "./theme.js";
import { THEMES } from "./themes.js";

describe("tokensFor — the --muted contrast floor (#240)", () => {
  it("Darkermatrix's naive fg/panel mix reads at ~1.25:1, the issue's reported ratio — the floor push has to move it", () => {
    const th = THEMES["Darkermatrix"];
    const panel = tokensFor(th).panel;
    // What tokensFor() derived --muted from before #240's floor push:
    // fg mixed to 0.5, one chroma step down.
    const naiveMuted = desaturate(mix(th.bg, th.fg, 0.5), 0.75);
    const ratio = contrast(naiveMuted, panel);
    expect(ratio).toBeGreaterThan(1.2);
    expect(ratio).toBeLessThan(1.3);
  });

  it("clears the 3:1 floor on Darkermatrix after the push", () => {
    const t = tokensFor(THEMES["Darkermatrix"]);
    expect(contrast(t.muted, t.panel)).toBeGreaterThanOrEqual(3);
  });

  it("holds the floor across every shipped palette, not just the one reported", () => {
    for (const th of Object.values(THEMES)) {
      const t = tokensFor(th);
      expect(contrast(t.muted, t.panel)).toBeGreaterThanOrEqual(3);
    }
  });
});
