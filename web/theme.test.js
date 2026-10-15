// #240: a few pathological palettes (Darkermatrix and friends) leave --muted
// illegible on --panel because the quieted fg/panel mix lands well under a
// readable ratio. tokensFor() pushes --muted's OKLCH L away from --panel's
// until a real WCAG contrast() clears the floor (#229's guaranteed-visible
// trick for --active, generalised to an actual ratio). smoke/ui-smoke.mjs
// sweeps all 552 palettes for the same assertion; this pins the exact
// palette the issue was filed against, with no browser involved.
import { describe, it, expect } from "vitest";
import { MIN_STEP, SOFT_CEILING, ZEBRA, contrast, desaturate, hexToOklch, mix, tokensFor } from "./theme.js";
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

// behold#571: the kiosk's surfaces. The page, the header's boxes and two
// alternating pane levels, a zebra tint for list rows, softened body ink, and
// the state and root colours as ink: every shipped palette has to come out
// of tokensFor() with each region its own box and every word legible on it.
describe("tokensFor — the kiosk's surfaces (behold#571)", () => {
  const each = (fn) => {
    const bad = [];
    for (const th of Object.values(THEMES)) {
      const t = tokensFor(th);
      const surfaces = [th.bg, t.surfaceBox, t.surfacePaneA, t.surfacePaneB];
      const grounds = [...surfaces, ...surfaces.map((x) => mix(x, t.zebra, ZEBRA))];
      const why = fn(t, th, { surfaces, grounds });
      if (why) bad.push(`${th.name}: ${why}`);
    }
    return bad;
  };

  it("keeps body ink at 4.5:1 or better on every surface and zebra row", () => {
    expect(each((t, _th, { grounds }) => grounds.filter((g) => contrast(t.soft, g) < 4.5).map((g) => `${t.soft} on ${g} is ${contrast(t.soft, g).toFixed(2)}`)[0])).toEqual([]);
  });

  it("keeps secondary ink at 3:1 or better on every surface and zebra row", () => {
    expect(each((t, _th, { grounds }) => grounds.filter((g) => contrast(t.mutedInk, g) < 3).map((g) => `${t.mutedInk} on ${g} is ${contrast(t.mutedInk, g).toFixed(2)}`)[0])).toEqual([]);
  });

  it("keeps the state colours and the root colours at 3:1 or better on every surface and zebra row", () => {
    const inks = (t) => [t.managedInk, t.foreignInk, t.pendingInk, t.degradedInk, t.runtimeInk, ...t.roots];
    expect(each((t, _th, { grounds }) => inks(t).flatMap((c) => grounds.filter((g) => contrast(c, g) < 3).map((g) => `${c} on ${g}`))[0])).toEqual([]);
  });

  it("tells each surface from the one beside it: at least MIN_STEP of OKLCH lightness apart", () => {
    expect(each((_t, _th, { surfaces }) => {
      const L = surfaces.map((x) => hexToOklch(x).L);
      const i = L.findIndex((l, k) => k > 0 && Math.abs(l - L[k - 1]) < MIN_STEP - 1e-9);
      return i > 0 ? `${surfaces[i - 1]} and ${surfaces[i]} are ${Math.abs(L[i] - L[i - 1]).toFixed(3)} apart` : null;
    })).toEqual([]);
  });

  it("softens a glaring white on near-black and leaves a calm --fg as it is", () => {
    const glare = Object.values(THEMES).find((th) => th.fg.toLowerCase() === "#ffffff" && th.bg.toLowerCase() === "#000000");
    const t = tokensFor(glare);
    expect(t.soft.toLowerCase()).not.toBe("#ffffff");
    // At the ceiling, give or take the 8-bit rounding of the eased colour.
    expect(contrast(t.soft, glare.bg)).toBeLessThanOrEqual(SOFT_CEILING + 0.15);
    expect(contrast(t.soft, glare.bg)).toBeLessThan(contrast(glare.fg, glare.bg));
    const mocha = tokensFor(THEMES["Catppuccin Mocha"]);
    expect(mocha.soft).toBe(THEMES["Catppuccin Mocha"].fg);
  });
});
