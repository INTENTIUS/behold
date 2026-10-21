// #240: a few pathological palettes (Darkermatrix and friends) leave --muted
// illegible on --panel because the quieted fg/panel mix lands well under a
// readable ratio. tokensFor() pushes --muted's OKLCH L away from --panel's
// until a real WCAG contrast() clears the floor (#229's guaranteed-visible
// trick for --active, generalised to an actual ratio). smoke/ui-smoke.mjs
// sweeps all 552 palettes for the same assertion; this pins the exact
// palette the issue was filed against, with no browser involved.
import { describe, it, expect } from "vitest";
import { BAR_FLOOR, BAR_STATES, EDGE_FLOOR, FRAME_STATES, INK2_FLOOR, KIOSK_THEME, MIN_STEP, MUTED_FLOOR, SURFACE_CHROMA, barGrounds, barInks, barVars, SOFT_CEILING, ZEBRA, contrast, desaturate, frameGrounds, frameInks, hexToOklch, ink2Grounds, mix, PAINT_KEY, paintFor, pinTokensFor, themeStep, tokensFor } from "./theme.js";
import { THEMES } from "./themes.js";

describe("themeStep — the kiosk's < and > (behold#755)", () => {
  const names = ["A", "B", "C"];
  it("steps forward and back", () => {
    expect(themeStep(names, "B", 1)).toBe("C");
    expect(themeStep(names, "B", -1)).toBe("A");
  });
  it("wraps at both ends", () => {
    expect(themeStep(names, "C", 1)).toBe("A");
    expect(themeStep(names, "A", -1)).toBe("C");
  });
  it("starts at the first for a name not in the list, and has nothing for no names", () => {
    expect(themeStep(names, "Z", 1)).toBe("A");
    expect(themeStep([], "A", 1)).toBe(null);
  });
  it("the kiosk opens on Box, a theme that exists (behold#758)", () => {
    expect(KIOSK_THEME).toBe("Box");
    expect(THEMES[KIOSK_THEME]).toBeTruthy();
  });
});

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

  // behold#725 raised the floor from 3:1 to 4.5:1.
  it("clears the 4.5:1 floor on Darkermatrix after the push", () => {
    expect(MUTED_FLOOR).toBe(4.5);
    const t = tokensFor(THEMES["Darkermatrix"]);
    expect(contrast(t.muted, t.panel)).toBeGreaterThanOrEqual(4.5);
  });

  it("holds the floor across every shipped palette, not just the one reported", () => {
    const short = Object.values(THEMES).map((th) => [th.name, tokensFor(th)]).filter(([, t]) => contrast(t.muted, t.panel) < 4.5).map(([n, t]) => `${n} ${contrast(t.muted, t.panel).toFixed(2)}`);
    expect(short).toEqual([]);
  });
});

// behold#725: --ink2, the secondary prose ink, between --fg and --muted.
describe("tokensFor — the --ink2 level (behold#725)", () => {
  const worst = (c, gs) => Math.min(...gs.map((g) => contrast(c, g)));

  it("reads at 7:1 or better on every ground, or, where neither white nor black can, as well as the better of them", () => {
    expect(INK2_FLOOR).toBe(7);
    const bad = [];
    for (const th of Object.values(THEMES)) {
      const t = tokensFor(th);
      const gs = ink2Grounds(th, { panel: t.panel, well: t.well, kiosk: t });
      const w = worst(t.ink2, gs);
      const reach = Math.max(worst("#ffffff", gs), worst("#000000", gs));
      if (w < 7 && w < reach - 0.05) bad.push(`${th.name} ${t.ink2} ${w.toFixed(2)} (white or black reach ${reach.toFixed(2)})`);
    }
    expect(bad).toEqual([]);
  });

  it("sits between --muted and --fg on Catppuccin Mocha, quieter than --fg and louder than --muted", () => {
    const t = tokensFor(THEMES["Catppuccin Mocha"]);
    expect(t.ink2).not.toBe(t.fg);
    expect(contrast(t.ink2, t.panel)).toBeLessThan(contrast(t.fg, t.panel));
    expect(contrast(t.ink2, t.panel)).toBeGreaterThan(contrast(t.muted, t.panel));
  });

  it("is held on the page, the app's panel and well, the kiosk's surfaces and their zebra rows", () => {
    const th = THEMES["Sea Shells"];
    const t = tokensFor(th);
    const gs = ink2Grounds(th, { panel: t.panel, well: t.well, kiosk: t });
    for (const g of [th.bg, t.panel, t.well, t.surfaceBox, t.surfacePaneA, t.surfacePaneB, mix(t.surfacePaneB, th.fg, ZEBRA)]) expect(gs).toContain(g);
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

  // behold#725 raised the floor from 3:1 to 4.5:1.
  it("keeps secondary ink at 4.5:1 or better on every surface and zebra row", () => {
    expect(each((t, _th, { grounds }) => grounds.filter((g) => contrast(t.mutedInk, g) < 4.5).map((g) => `${t.mutedInk} on ${g} is ${contrast(t.mutedInk, g).toFixed(2)}`)[0])).toEqual([]);
  });

  // behold#725: a saturated ground stacked three levels high reads loud, so the surfaces keep under half its colour.
  it("keeps at most SURFACE_CHROMA of --bg's chroma on each derived surface, and leaves --bg alone", () => {
    expect(SURFACE_CHROMA).toBe(0.4);
    expect(each((t, th) => {
      expect(t.bg).toBe(th.bg);
      const c = hexToOklch(th.bg).C;
      // 8-bit rounding moves chroma a little, most of all near black.
      const over = [t.surfaceBox, t.surfacePaneA, t.surfacePaneB].find((s) => hexToOklch(s).C > c * SURFACE_CHROMA + 0.012);
      return over ? `${over} keeps ${hexToOklch(over).C.toFixed(3)} of ${c.toFixed(3)}` : null;
    })).toEqual([]);
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

// behold#571: the graph frame's state colours, as text and thin lines, in every theme.
describe("the graph frame's state colours", () => {
  const all = Object.values(THEMES);
  const hueGap = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

  it("read at WCAG AA (4.5:1) on the ground their words sit on, and 3:1 as a line on every other, in every theme", () => {
    const short = [];
    for (const th of all) {
      const inks = frameInks(th);
      const g = frameGrounds(th);
      for (const side of ["box", "card"]) {
        for (const s of FRAME_STATES) {
          const c = inks[side][s];
          for (const gr of g[side]) if (contrast(c, gr) < 4.5) short.push(`${th.name} ${side} ${s} ${c} on ${gr}: ${contrast(c, gr).toFixed(2)}`);
          // And as a line, 3:1 on every ground of the frame.
          for (const gr of [...g.box, ...g.card]) if (contrast(c, gr) < 3) short.push(`${th.name} ${side} ${s} line ${c} on ${gr}: ${contrast(c, gr).toFixed(2)}`);
        }
      }
    }
    expect(short).toEqual([]);
  });

  it("draw a status outline at 3:1 or better on the background and the wave box, in every theme", () => {
    const short = [];
    for (const th of all) {
      const pin = pinTokensFor(th);
      for (const k of ["accentStroke", "goodStroke", "warnStroke", "runtimeStroke", "selectedStroke"]) {
        for (const g of [pin.bg0, pin.bg1]) if (contrast(pin[k], g) < 3) short.push(`${th.name} ${k} ${pin[k]} on ${g}: ${contrast(pin[k], g).toFixed(2)}`);
      }
    }
    expect(short).toEqual([]);
  });

  it("keep each state's hue where it has one, moving its lightness", () => {
    const off = [];
    for (const th of all) {
      const t = tokensFor(th);
      const inks = frameInks(th);
      for (const s of FRAME_STATES) for (const side of ["box", "card"]) {
        const a = hexToOklch(t[s]);
        const b = hexToOklch(inks[side][s]);
        if (a.C < 0.04 || b.C < 0.04) continue;
        if (hueGap(a.H, b.H) > 20) off.push(`${th.name} ${side} ${s} ${t[s]} -> ${inks[side][s]}`);
      }
    }
    expect(off).toEqual([]);
  });

  it("fixes Sea Shells' planned text, which read dark blue on a dark card", () => {
    const th = THEMES["Sea Shells"];
    expect(contrast(tokensFor(th).pending, pinTokensFor(th).neutralFill)).toBeLessThan(2);
    expect(contrast(frameInks(th).card.pending, pinTokensFor(th).neutralFill)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the left bars (behold#571)", () => {
  const themes = Object.values(THEMES);

  it("clear 3:1 on every ground a bar sits on, in every theme, for every state and the neutral bar", () => {
    expect(BAR_FLOOR).toBe(3);
    const bad = [];
    for (const th of themes) {
      const grounds = barGrounds(th);
      const inks = barInks(th);
      for (const s of BAR_STATES) {
        const worst = Math.min(...grounds.map((g) => contrast(inks[s], g)));
        if (worst < BAR_FLOOR) bad.push(`${th.name} ${s} ${inks[s]} ${worst.toFixed(2)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("sit on the page, the kiosk's panes, the app's panel and well, their zebra rows and the selected, hovered and held fills", () => {
    const th = THEMES["Sea Shells"];
    const t = tokensFor(th);
    const g = barGrounds(th);
    for (const c of [th.bg, t.surfaceBox, t.surfacePaneA, t.surfacePaneB, t.panel, t.well, t.active, mix(t.surfacePaneB, th.fg, ZEBRA)]) expect(g).toContain(c);
  });

  it("keep each state's hue where it has one, moving its lightness", () => {
    let kept = 0;
    let total = 0;
    for (const th of themes) {
      const t = tokensFor(th);
      const inks = barInks(th);
      for (const s of ["managed", "foreign", "pending", "degraded"]) {
        const a = hexToOklch(t[s]);
        if (a.C < 0.05) continue;
        total++;
        const b = hexToOklch(inks[s]);
        const dH = Math.abs(((a.H - b.H + 540) % 360) - 180);
        if (dH < 20 || b.C < 0.02) kept++;
      }
    }
    expect(kept / total).toBeGreaterThan(0.97);
  });

  it("are emitted as --bar-<state>, one per state", () => {
    expect(Object.keys(barVars(THEMES["Catppuccin Mocha"]))).toEqual(BAR_STATES.map((s) => `bar-${s}`));
  });

  it("lift Royal's neutral, which sat at about 1.4:1 on its panes, where the zebra row reads at 1.02:1", () => {
    const th = THEMES["Royal"];
    const t = tokensFor(th);
    expect(contrast(mix(t.surfacePaneB, th.fg, ZEBRA), t.surfacePaneB)).toBeLessThan(1.05);
    expect(contrast(t.neutral, t.surfacePaneB)).toBeLessThan(1.5);
    expect(contrast(barInks(th).neutral, t.surfacePaneB)).toBeGreaterThanOrEqual(3);
  });
});

// behold#725: the record the pre-paint script in index.html and kiosk.html applies before theme.js runs.
describe("paintFor — the theme before first paint (behold#725)", () => {
  it("names the theme, its colour scheme and every custom property applyTheme sets, --ink2 and the bars among them", () => {
    const th = THEMES["Sea Shells"];
    const t = tokensFor(th);
    const p = paintFor(t, th);
    expect(PAINT_KEY).toBe("behold.theme.paint");
    expect(p.name).toBe("Sea Shells");
    expect(p.scheme).toBe(th.dark ? "dark" : "light");
    expect(p.vars["--ink2"]).toBe(t.ink2);
    expect(p.vars["--muted"]).toBe(t.muted);
    expect(p.vars["--surface-pane-a"]).toBe(t.surfacePaneA);
    expect(p.vars["--bar-neutral"]).toBe(barInks(th).neutral);
    expect(p.vars["--frame-focus"]).toBe(frameInks(th).box.focus);
    expect(Object.keys(p.vars).every((k) => k.startsWith("--"))).toBe(true);
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});

describe("edges (behold#824)", () => {
  it("draws an edge at 3:1 or better on the background, on every theme", () => {
    const weak = [];
    for (const th of Object.values(THEMES)) {
      const pin = pinTokensFor(th);
      const css = tokensFor(th);
      if (contrast(pin.edge, th.bg) < EDGE_FLOOR || contrast(css.edge, th.bg) < EDGE_FLOOR) weak.push(th.name);
    }
    expect(weak).toEqual([]);
  });
});
