// #399 M2 / #401 M4 of #397 — the colour-by modes' arithmetic, without a
// browser. The smoke drives the same decisions through the real SPA; this pins
// the rules that are easy to get subtly wrong and impossible to see in a
// screenshot: an unpriced card never landing at the zero end of a scale, a
// headroom axis the engine did not report never reading as a saturated one,
// the engine's own total outranking behold's sum, and a badge over two engines
// refusing to pick one of them.
import { describe, it, expect } from "vitest";
import { THEMES } from "./themes.js";
import { tokensFor, hexToOklch } from "./theme.js";
import {
  badgeFor,
  blockOf,
  countFigures,
  countsText,
  domainFor,
  effectiveMode,
  figureOf,
  fillFor,
  fmtCost,
  fmtHeadroom,
  headroomOf,
  median,
  modeAvailability,
  positionOf,
  rampColor,
  rampFor,
  scaleEnds,
  totalsFor,
  totalsText,
} from "./behaviour-scale.js";

const prov = (over = {}) => ({ engine: "acme-sim", version: "1.4.2", tolerance: "±15%", basis: "modeled", ...over });
const block = (over = {}) => ({
  at: { traffic: "100 rps, p50" },
  cost: { perHour: 0.05, currency: "USD" },
  headroom: { cpu: 0.6, latency: 0.4 },
  errorRate: 0.001,
  resilience: { failure: "one zone lost", verdict: "survives" },
  provenance: prov(),
  ...over,
});

describe("reading a figure off a block", () => {
  it("takes headroom as the LOWER of the axes present", () => {
    expect(headroomOf(block({ headroom: { cpu: 0.6, latency: 0.4 } }))).toBe(0.4);
    expect(headroomOf(block({ headroom: { cpu: 0.2, latency: 0.9 } }))).toBe(0.2);
  });

  it("reads a block with one axis on that axis alone — a missing axis is absent, not zero", () => {
    // The whole point of #398's "a missing axis is absent, not 0": a block that
    // reports only latency must not read as a card with no CPU left.
    expect(headroomOf(block({ headroom: { latency: 0.8 } }))).toBe(0.8);
    expect(headroomOf(block({ headroom: { cpu: 0.8 } }))).toBe(0.8);
  });

  it("has no figure at all for an entity with no block", () => {
    expect(blockOf({ id: "a", attrs: {} })).toBeUndefined();
    expect(figureOf("cost", undefined)).toBeUndefined();
    expect(figureOf("headroom", undefined)).toBeUndefined();
    expect(figureOf("drift", block())).toBeUndefined();
  });
});

describe("the domain each mode spans", () => {
  it("stretches cost over the estate's own min and max", () => {
    const d = domainFor("cost", [0.01, 0.5, 0.25]);
    expect(d).toMatchObject({ min: 0.01, max: 0.5, n: 3, absolute: false });
  });

  it("keeps headroom absolute at 0..1, so a comfortable estate's best card is not painted as its worst", () => {
    const d = domainFor("headroom", [0.7, 0.8, 0.9]);
    expect(d).toMatchObject({ min: 0, max: 1, absolute: true });
    // 0.7 free is high on the axis, not the bottom of a 0.7..0.9 stretch.
    expect(positionOf(0.7, d)).toBeCloseTo(0.7, 6);
  });

  it("has no cost domain when nothing in scope carries a price", () => {
    expect(domainFor("cost", [])).toBeNull();
    expect(positionOf(0.5, null)).toBeUndefined();
  });

  it("puts a flat domain mid-scale rather than at an end", () => {
    expect(positionOf(4, domainFor("cost", [4, 4, 4]))).toBe(0.5);
  });
});

describe("the neutral-not-zero rule (#399's own acceptance test)", () => {
  const tokens = tokensFor(THEMES.Argonaut || Object.values(THEMES)[0]);
  const NEUTRAL = "#3a3a3a";

  it("draws an entity with no block in the drift overlay's neutral, never the zero end of the cost scale", () => {
    const ramp = rampFor("cost", tokens);
    const domain = domainFor("cost", [0.01, 0.5]);
    const unpriced = fillFor(undefined, domain, ramp, NEUTRAL);
    const cheapest = fillFor(0.01, domain, ramp, NEUTRAL);
    expect(unpriced).toEqual({ fill: NEUTRAL, unpriced: true });
    expect(cheapest.unpriced).toBe(false);
    expect(cheapest.fill).not.toBe(NEUTRAL);
    // The distinction the rule exists for: "nothing priced this" must not
    // render as "this is the cheapest thing in the estate".
    expect(unpriced.fill).not.toBe(cheapest.fill);
  });

  it("does the same in headroom mode, where the zero end would read as saturated", () => {
    const ramp = rampFor("headroom", tokens);
    const domain = domainFor("headroom", [0.4]);
    expect(fillFor(undefined, domain, ramp, NEUTRAL)).toEqual({ fill: NEUTRAL, unpriced: true });
    expect(fillFor(0, domain, ramp, NEUTRAL).fill).not.toBe(NEUTRAL);
  });

  it("counts the unpriced rather than dropping them", () => {
    const blocks = [block(), undefined, block({ cost: { perHour: 1, currency: "USD" } })];
    expect(countFigures("cost", blocks)).toEqual({ priced: 2, unpriced: 1 });
    expect(countsText(countFigures("cost", blocks))).toBe("2 priced · 1 unpriced");
  });
});

describe("the ramps, derived from the theme", () => {
  it("no mode owns a fixed colour — every ramp stop comes out of the active palette", () => {
    for (const name of ["Argonaut", "Builtin Solarized Light", "Hot Dog Stand"]) {
      const th = THEMES[name];
      if (!th) continue;
      const t = tokensFor(th);
      for (const mode of ["cost", "headroom"]) {
        for (const stop of rampFor(mode, t)) expect(stop).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it("gives every one of the 552 palettes a cost ramp you can tell low from high", () => {
    const bad = [];
    for (const th of Object.values(THEMES)) {
      const ramp = rampFor("cost", tokensFor(th));
      const low = rampColor(0, ramp);
      const high = rampColor(1, ramp);
      // The two ends have to differ perceptibly in lightness, or the scale is
      // one flat colour and says nothing at all.
      if (Math.abs(hexToOklch(low).L - hexToOklch(high).L) < 0.1) bad.push(th.name);
    }
    expect(bad).toEqual([]);
  });

  it("takes the headroom ramp's three stops from the drift overlay's own anchors, in every palette", () => {
    // Not a separation assertion. A handful of palettes (Retro, Hot Dog Stand
    // (Mustard)) paint slots 1 and 2 the same colour, so their red and their
    // green ARE one colour — the drift legend reads alike on them too. That is
    // the palette's choice; what this scale owes is that its ends are those
    // anchors and nothing of its own invention.
    const bad = [];
    for (const th of Object.values(THEMES)) {
      const t = tokensFor(th);
      const ramp = rampFor("headroom", t);
      if (rampColor(0, ramp) !== t.degraded || rampColor(1, ramp) !== t.managed || ramp[1] !== t.foreign) bad.push(th.name);
    }
    expect(bad).toEqual([]);
  });

  it("walks a hue the short way round, so a green-to-red ramp never swings through blue", () => {
    // Two stops straddling 0°: red at ~29°, a green at ~145°. Midway must land
    // in the yellows between them, not on the far side of the wheel.
    const mid = hexToOklch(rampColor(0.5, ["#d02020", "#20b020"]));
    expect(mid.H).toBeGreaterThan(29);
    expect(mid.H).toBeLessThan(145);
  });
});

describe("the totals row", () => {
  const sum = { perHour: 0.5669, currency: "USD", priced: 41, unpriced: 4 };

  it("is absent in drift mode — drift counts states, and the legend already does", () => {
    expect(totalsFor("drift", [block()], sum, undefined)).toBeNull();
  });

  it("quotes the server's sum of engine figures, with its own priced/unpriced counts", () => {
    const t = totalsFor("cost", [block()], sum, undefined);
    expect(t.source).toBe("sum");
    expect(t.computed).toBe(false);
    expect(totalsText(t)).toBe("0.5669 USD/h · 41 priced · 4 unpriced");
  });

  it("lets the ENGINE's own total outrank behold's sum, and says whose it is", () => {
    const t = totalsFor("cost", [block(), block()], sum, { perHour: 12.31, currency: "USD" });
    expect(t.source).toBe("engine total");
    expect(t.value).toBe("12.31 USD/h");
  });

  it("says nothing rather than adding figures the server withheld (mixed currencies)", () => {
    const t = totalsFor("cost", [block()], undefined, undefined);
    expect(t.missing).toBe(true);
    expect(t.value).toBe("—");
  });

  it("computes headroom itself — no engine states an aggregate — and labels it computed", () => {
    const blocks = [
      block({ headroom: { cpu: 0.2, latency: 0.9 } }),
      block({ headroom: { cpu: 0.6, latency: 0.7 } }),
      block({ headroom: { cpu: 0.9, latency: 0.8 } }),
      undefined,
    ];
    const t = totalsFor("headroom", blocks, sum, undefined);
    expect(t.computed).toBe(true);
    expect(t.value).toBe("min 20% free · median 60% free");
    expect(totalsText(t)).toBe("min 20% free · median 60% free · 3 priced · 1 unpriced · computed");
  });

  it("takes the ordinary median of an even set", () => {
    expect(median([0.1, 0.3, 0.5, 0.7])).toBeCloseTo(0.4, 6);
    expect(median([])).toBeUndefined();
  });

  it("prints a small per-hour figure at four decimals and a large one at two", () => {
    expect(fmtCost(0.0416, "USD")).toBe("0.0416 USD/h");
    expect(fmtCost(12.3, "EUR")).toBe("12.30 EUR/h");
    expect(fmtHeadroom(0.415)).toBe("42% free");
  });

  it("labels the cost scale's ends with the estate's own extremes", () => {
    expect(scaleEnds("cost", domainFor("cost", [0.01, 0.5]), "USD")).toEqual({ low: "0.0100 USD/h", high: "0.5000 USD/h" });
    expect(scaleEnds("headroom", domainFor("headroom", [0.5]))).toEqual({ low: "0% free", high: "100% free" });
  });
});

describe("the provenance badge (#401)", () => {
  it("reads {engine} {version} · {tolerance} · {basis} off one entity's own block", () => {
    const b = badgeFor([block()], { engine: "acme-sim", version: "1.4.2", at: { traffic: "100 rps, p50" } });
    expect(b.text).toBe("acme-sim 1.4.2 · ±15% · modeled");
  });

  it("spells `modeled` out as `modeled, not billed` on hover — the sentence #397 turns on", () => {
    const b = badgeFor([block()], null);
    expect(b.title).toContain("modeled, not billed");
    expect(b.title).toContain("100 rps, p50");
  });

  it("says `validated against a bill` for a figure that was", () => {
    const b = badgeFor([block({ provenance: prov({ basis: "validated" }) })], null);
    expect(b.text).toContain("validated");
    expect(b.title).toContain("validated against a bill");
  });

  it("refuses to pick one engine when a scope was priced by two", () => {
    const b = badgeFor([block(), block({ provenance: prov({ engine: "other-sim", version: "2.0", tolerance: "±5%", basis: "validated" }) })], null);
    expect(b.text).toBe("2 engines · mixed · mixed");
    expect(b.engines).toEqual(["acme-sim 1.4.2", "other-sim 2.0"]);
    expect(b.title).toContain("acme-sim 1.4.2, other-sim 2.0");
  });

  it("falls back to the graph-level engine when no entity in scope carries provenance", () => {
    const b = badgeFor([], { engine: "acme-sim", version: "1.4.2" });
    expect(b.text).toBe("acme-sim 1.4.2");
    expect(b.title).toContain("Provenance rides each figure");
  });

  it("has nothing to badge when there is neither", () => {
    expect(badgeFor([], null)).toBeNull();
  });
});

describe("which modes a graph can offer", () => {
  it("offers nothing off the overlay at all — there is no behaviour block on the source graph", () => {
    const a = modeAvailability({ mode: "graph" }, "cost");
    expect(a.available).toBe(false);
    expect(a.reason).toContain("pick an environment");
  });

  it("keeps a picked mode alive when the overlay can serve it", () => {
    const meta = { behaviour: { engine: "acme-sim", version: "1.4.2", sum: { perHour: 1, currency: "USD", priced: 2, unpriced: 0 } } };
    expect(effectiveMode("cost", meta)).toBe("cost");
    expect(effectiveMode("headroom", meta)).toBe("headroom");
  });

  it("falls back to drift rather than painting a scale over figures nobody sent — the PICK survives, so a live env that IS priced comes back in cost", () => {
    expect(effectiveMode("cost", { behaviour: { absent: "…" } })).toBe("drift");
    expect(effectiveMode("drift", null)).toBe("drift");
  });
});

describe("what a refusal and an absence do to the modes (#401)", () => {
  const refusal = { reason: "no behavioural engine is configured for this lexicon.", remedy: "Set CHANT_BEHAVIOUR_ENGINE." };

  it("disables both behaviour modes on a refusal and hands back the lexicon's own words", () => {
    // The reason a disabled control carries is the LEXICON's sentence, not a
    // generic "unavailable" — that is the whole of #401's refusal half.
    const meta = { behaviour: { refusal } };
    for (const mode of ["cost", "headroom"]) {
      const a = modeAvailability(meta, mode);
      expect(a.available).toBe(false);
      expect(a.reason).toContain("no behavioural engine is configured");
      expect(a.reason).toContain("Set CHANT_BEHAVIOUR_ENGINE.");
      expect(a.refusal).toEqual(refusal);
    }
  });

  it("keeps drift painting through a refusal — drift never depended on an engine", () => {
    expect(effectiveMode("drift", { behaviour: { refusal } })).toBe("drift");
    expect(effectiveMode("cost", { behaviour: { refusal } })).toBe("drift");
  });

  it("disables the modes on an absence too, with the absent line as the reason and no refusal to print", () => {
    const absent = "no behaviour block: no node carries attrs._behaviour, and no report document at monolith/behaviour.live.json";
    const a = modeAvailability({ behaviour: { absent } }, "cost");
    expect(a.available).toBe(false);
    expect(a.reason).toBe(absent);
    expect(a.refusal).toBeNull();
  });
});
