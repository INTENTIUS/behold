// The colour-by modes' arithmetic (#399 M2, #401 M4 of #397) — everything the
// behaviour overlay DECIDES, with no DOM and no fetch in it, so it can be unit
// tested beside the file the way web/theme.js is.
//
// The one rule the whole module exists to keep: behold states no figure of its
// own. Every number below arrives from a `attrs._behaviour` block a lexicon's
// engine wrote (src/behaviour.ts validates it against #398's contract), and
// what happens here is positioning on an axis, a min, a median, and a count.
// Where a figure IS computed here rather than read — the headroom min and
// median a box's totals row shows — the label says "computed", because
// `meta.behaviour` carries only cost sums and the engine stated no headroom
// aggregate for behold to quote.
import { hexToOklch, oklchToHex } from "./theme.js";

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** The block a node carries, or undefined. One reader, so a rename is one edit. */
export function blockOf(node) {
  return (node && node.attrs && node.attrs._behaviour) || undefined;
}

/**
 * Headroom, as the mode paints it: **the lower of the axes present**.
 *
 * A missing axis is absent, never 0 (#398) — "the engine did not report cpu"
 * and "there is no cpu left" are opposite claims. So a block with only
 * `latency` is read on latency alone, and a block whose `headroom` somehow
 * carries neither is not a headroom figure at all (the M1 validator already
 * refuses one, so this returns undefined rather than inventing a floor).
 */
export function headroomOf(block) {
  if (!block || !block.headroom) return undefined;
  const axes = [block.headroom.cpu, block.headroom.latency].filter((v) => typeof v === "number");
  return axes.length ? Math.min(...axes) : undefined;
}

/** The figure the active mode reads off one block. `drift` reads none. */
export function figureOf(mode, block) {
  if (mode === "cost") return block && block.cost ? block.cost.perHour : undefined;
  if (mode === "headroom") return headroomOf(block);
  return undefined;
}

/**
 * The domain a mode's scale spans, over the entities that carry a figure.
 *
 * `cost` has no absolute range — a per-hour figure means nothing until you know
 * what the rest of the estate costs — so its domain is the estate's own min and
 * max. `headroom` is already a fraction of capacity, so its domain is fixed at
 * 0..1: half free is half free whether the estate is one box or forty, and
 * stretching it to the observed range would make a comfortable estate's best
 * card read as its worst.
 */
export function domainFor(mode, values) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (mode === "headroom") return { min: 0, max: 1, n: xs.length, absolute: true };
  if (!xs.length) return null;
  return { min: Math.min(...xs), max: Math.max(...xs), n: xs.length, absolute: false };
}

/** Where a figure sits on its domain, 0..1. A flat domain (every entity the
 * same price) puts everything mid-scale rather than at an end — an end would
 * claim a spread the figures do not have. */
export function positionOf(value, domain) {
  if (!domain || typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (domain.max === domain.min) return 0.5;
  return clamp((value - domain.min) / (domain.max - domain.min), 0, 1);
}

/**
 * A colour at `t` on a ramp of anchor colours, interpolated in OKLCH so the
 * steps read as even brightness rather than as even RGB arithmetic — the same
 * space theme.js already does its perceptual work in.
 */
export function rampColor(t, stops) {
  if (!stops.length) return "#888888";
  if (stops.length === 1) return stops[0];
  const x = clamp(t, 0, 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  const a = hexToOklch(stops[i]);
  const b = hexToOklch(stops[i + 1]);
  // Hue takes the short way round the wheel, or a green→red ramp would swing
  // backwards through blue on a palette whose two anchors straddle 0°.
  let dH = b.H - a.H;
  if (dH > 180) dH -= 360;
  if (dH < -180) dH += 360;
  return oklchToHex({ L: a.L + (b.L - a.L) * f, C: a.C + (b.C - a.C) * f, H: (a.H + dH * f + 360) % 360 });
}

/**
 * The two modes' ramps, DERIVED from the active theme the way #229 derives the
 * chrome — no mode owns a fixed colour, and all 552 palettes have to come out
 * of here with a scale you can read low from high.
 *
 * `cost` is a SINGLE-HUE ramp on the accent's own hue and chroma, walked in
 * lightness away from the theme's background: quiet and close to the ground at
 * the cheap end, full strength at the expensive one. Deliberately not a
 * green-to-red ramp — expensive is not a verdict, and behold has no standing to
 * paint an estate's bill as a fault. Magnitude is all the engine stated, so
 * magnitude is all the colour says.
 *
 * Anchored to the BACKGROUND's lightness rather than to the accent's own, for
 * the reason #229 pushes `--active` off the panel: a palette whose blue slot
 * happens to sit where a fixed offset would land (Hot Dog Stand's, on a red
 * ground) otherwise derives two ends you cannot tell apart. Walking outward
 * from the ground gives every one of the 552 palettes a spread, and it is the
 * spread, not the offset, that the scale is for.
 *
 * `headroom` IS a good-to-bad axis — #399 says so in as many words — so it
 * rides the three status hues the drift overlay already anchors across every
 * palette: degraded at no headroom, foreign in the middle, managed at plenty.
 * The card's drift bar keeps its own colour underneath, so the two never occupy
 * the same pixel. Where a palette paints red and green alike (Retro, Hot Dog
 * Stand's mustard), the drift overlay reads alike there too — that is the
 * palette's own choice and not a thing this scale may overrule.
 */
export function rampFor(mode, tokens) {
  if (mode === "cost") {
    const { C, H } = hexToOklch(tokens.pending);
    const ground = hexToOklch(tokens.bg).L;
    const away = ground < 0.5 ? 1 : -1;
    // How far there is to walk before the walk runs out of sRGB. A ground
    // sitting almost exactly mid-lightness (Grass) has barely half the room a
    // near-black one does, so the span is what's actually available rather than
    // a constant that silently clips at one end.
    const room = away > 0 ? 0.95 - ground : ground - 0.05;
    const span = Math.min(0.62, room);
    return [atLightness(ground + away * span * 0.32, C * 0.35, H), atLightness(ground + away * span, C, H)];
  }
  if (mode === "headroom") return [tokens.degraded, tokens.foreign, tokens.managed];
  return [];
}

/**
 * The colour at a requested OKLCH lightness, with chroma eased off until the
 * result actually LANDS there in sRGB.
 *
 * Without this a saturated hue near either end of the range clips on the way
 * out, and the ramp's two ends come back closer together than they were asked
 * to be — which on one palette (Grass, whose background sits within a
 * thousandth of mid-lightness) collapsed the scale to two shades of the same
 * navy. Lightness is the thing the eye reads a sequential scale by, so
 * lightness is the thing that is honoured and chroma is the thing that gives.
 */
function atLightness(L, C, H) {
  const want = clamp(L, 0.05, 0.95);
  let c = C;
  let out = oklchToHex({ L: want, C: c, H });
  for (let i = 0; i < 10 && Math.abs(hexToOklch(out).L - want) > 0.01; i++) {
    c *= 0.75;
    out = oklchToHex({ L: want, C: c, H });
  }
  return out;
}

/**
 * The fill one card draws in a colour-by mode.
 *
 * An entity with no block draws the drift overlay's own neutral — pinhole's
 * `neutralFill`, the ground a card rides when chant could not read it — and
 * NEVER the zero end of the scale. The zero end of a cost ramp says "free" and
 * the zero end of a headroom ramp says "saturated"; both are claims about an
 * entity nothing priced. `unpriced` comes back beside the colour so a caller
 * can mark the card rather than infer the state back out of a hex.
 */
export function fillFor(value, domain, ramp, neutralFill) {
  const t = positionOf(value, domain);
  if (t === undefined) return { fill: neutralFill, unpriced: true };
  return { fill: rampColor(t, ramp), unpriced: false };
}

/** How many entities in a set carry a figure for this mode, and how many don't. */
export function countFigures(mode, blocks) {
  let priced = 0;
  let unpriced = 0;
  for (const b of blocks) {
    if (figureOf(mode, b) === undefined) unpriced++;
    else priced++;
  }
  return { priced, unpriced };
}

/** The middle value of a sorted set — the even case averages the two middles,
 * which is the ordinary definition and the only place this module produces a
 * number no engine stated. Its caller labels it "computed" for that reason. */
export function median(values) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return undefined;
  const i = xs.length >> 1;
  return xs.length % 2 ? xs[i] : (xs[i - 1] + xs[i]) / 2;
}

/** A per-hour cost, at the precision a cost that small deserves. */
export function fmtCost(perHour, currency) {
  if (typeof perHour !== "number" || !Number.isFinite(perHour)) return "—";
  const digits = Math.abs(perHour) >= 1 ? 2 : 4;
  return `${perHour.toFixed(digits)} ${currency}/h`;
}

/** A headroom fraction as the percentage of capacity still free. */
export function fmtHeadroom(v) {
  return typeof v === "number" && Number.isFinite(v) ? `${Math.round(v * 100)}% free` : "—";
}

/**
 * The totals row for one scope (a box, or the whole estate), in the active
 * mode's own terms.
 *
 * `cost` quotes arithmetic the server already did — `meta.behaviour.sum` or
 * `.boxes[key]`, both of which are additions of engine figures — and, when the
 * ENGINE stated an estate total, quotes that instead and says whose it is.
 * That is the #398 precedence rule: `total` is the engine's word, `sum` is
 * behold's, and the engine outranks the arithmetic.
 *
 * `headroom` has no server-side aggregate at all, because no engine stated one
 * and adding fractions of capacity would be meaningless. The SPA takes the
 * worst card and the middle card of the scope and says, in the row, that it
 * computed them.
 *
 * `drift` gets no row: the drift overlay counts states, and a count of states
 * is what the Model tab's legend has always shown.
 */
export function totalsFor(mode, blocks, sum, engineTotal) {
  if (mode === "drift") return null;
  const counts = countFigures(mode, blocks);
  if (mode === "cost") {
    // The engine's own total wins, and says so. Otherwise the server's sum;
    // otherwise nothing to quote — never a figure computed here, because a
    // currency behold cannot convert is exactly why the sum was withheld.
    if (engineTotal) {
      return {
        mode,
        source: "engine total",
        value: fmtCost(engineTotal.perHour, engineTotal.currency),
        counts,
        computed: false,
      };
    }
    if (!sum) return { mode, source: "sum", value: "—", counts, computed: false, missing: true };
    return {
      mode,
      source: "sum",
      value: fmtCost(sum.perHour, sum.currency),
      counts: { priced: sum.priced, unpriced: sum.unpriced },
      computed: false,
    };
  }
  const xs = blocks.map((b) => headroomOf(b)).filter((v) => v !== undefined);
  if (!xs.length) return { mode, source: "computed", value: "—", counts, computed: true, missing: true };
  return {
    mode,
    source: "computed",
    value: `min ${fmtHeadroom(Math.min(...xs))} · median ${fmtHeadroom(median(xs))}`,
    counts,
    computed: true,
  };
}

/** The `n priced · m unpriced` tail every totals row and every legend carries. */
export function countsText(counts) {
  return `${counts.priced} priced · ${counts.unpriced} unpriced`;
}

/** The whole totals row as one line of text — what the smoke asserts, and what
 * a narrow panel row renders. */
export function totalsText(totals) {
  if (!totals) return "";
  return `${totals.value} · ${countsText(totals.counts)}${totals.computed ? " · computed" : ""}`;
}

/**
 * The provenance badge (#401): `{engine} {version} · {tolerance} · {basis}`,
 * beside every figure rather than once per page.
 *
 * `provenance` is per ENTITY in #398's contract, because one estate can be
 * priced by two engines — so a badge over a SET of entities can only say what
 * that set agrees on. Where they disagree the badge says `mixed` on the field
 * that disagrees rather than picking one, and the tooltip names the engines.
 * A badge over one entity is just that entity's own four fields.
 *
 * `modeled` is spelled out on hover as "modeled, not billed": the whole of #397
 * turns on a prediction never being presented as a bill, and the badge is where
 * that sentence has to live.
 */
export function badgeFor(blocks, meta) {
  const provs = blocks.map((b) => b && b.provenance).filter(Boolean);
  if (!provs.length) {
    // No entity provenance in scope: the graph-level engine, when the lexicon
    // stated one, is all there is to show — and it carries no tolerance or
    // basis, because #398 puts those on the entity.
    if (meta && meta.engine) return { text: `${meta.engine} ${meta.version}`, title: engineTitle(meta), engines: [`${meta.engine} ${meta.version}`] };
    return null;
  }
  const one = (pick) => {
    const vs = [...new Set(provs.map(pick))];
    return vs.length === 1 ? vs[0] : "mixed";
  };
  const engines = [...new Set(provs.map((p) => `${p.engine} ${p.version}`))].sort();
  const enginePart = engines.length === 1 ? engines[0] : `${engines.length} engines`;
  const tolerance = one((p) => p.tolerance);
  const basis = one((p) => p.basis);
  const parts = [];
  if (engines.length === 1) parts.push(`${provs[0].engine} ${provs[0].version}`);
  else parts.push(enginePart);
  parts.push(tolerance);
  parts.push(basis);
  const bases = [...new Set(provs.map((p) => p.basis))];
  const title =
    (engines.length === 1 ? `Stated by ${engines[0]}` : `Stated by ${engines.join(", ")}`) +
    `, tolerance ${tolerance === "mixed" ? [...new Set(provs.map((p) => p.tolerance))].join(" / ") : tolerance}. ` +
    (bases.length === 1
      ? bases[0] === "modeled"
        ? "modeled, not billed — a prediction from list prices, never a bill."
        : "validated against a bill."
      : "mixed basis — some figures are modeled, not billed; some are validated against a bill.") +
    (meta && meta.at && meta.at.traffic ? ` At ${meta.at.traffic}.` : provs[0] && blocks[0] && blocks[0].at ? ` At ${blocks[0].at.traffic}.` : "");
  return { text: parts.join(" · "), title, engines };
}

function engineTitle(meta) {
  return `Stated by ${meta.engine} ${meta.version}.${meta.at && meta.at.traffic ? ` At ${meta.at.traffic}.` : ""} Provenance rides each figure; this scope carries none.`;
}

/**
 * Which colour-by modes this graph can offer, and why not.
 *
 * A refusal or an absence disables both behaviour modes and hands back the
 * lexicon's own sentence for the tooltip — the disabled control is where a
 * person asks "why not", so that is where the answer goes. `drift` is never
 * disabled: it does not depend on an engine, which is the whole reason #401
 * says the drift overlay keeps rendering through a refusal.
 */
export function modeAvailability(meta, mode) {
  const b = (meta && meta.behaviour) || null;
  const overlay = !!b;
  if (!overlay) {
    return { available: false, reason: "the behaviour overlay is only on a live overlay — pick an environment on the Scope tab", refusal: null };
  }
  if (b.refusal) {
    return { available: false, reason: `${b.refusal.reason} ${b.refusal.remedy}`, refusal: b.refusal };
  }
  if (b.absent) return { available: false, reason: b.absent, refusal: null };
  return { available: true, reason: "", refusal: null };
}

/** The mode the SPA may actually paint in, given what the overlay carries.
 * A picked mode outlives an overlay that cannot serve it — switch envs back
 * and the pick is still there — but it never paints a scale over figures that
 * are not on the page. */
export function effectiveMode(picked, meta) {
  if (picked === "drift") return "drift";
  return modeAvailability(meta, picked).available ? picked : "drift";
}

export const COLOUR_MODES = ["drift", "cost", "headroom"];

/** The legend's own words for a mode. */
export const MODE_LABEL = { drift: "drift", cost: "cost", headroom: "headroom" };

/** The two ends of a mode's ramp, in words — the legend's axis labels. */
export function scaleEnds(mode, domain, currency = "") {
  if (mode === "cost") {
    if (!domain) return null;
    return { low: fmtCost(domain.min, currency), high: fmtCost(domain.max, currency) };
  }
  if (mode === "headroom") return { low: "0% free", high: "100% free" };
  return null;
}

/** A colour-mix-free CSS gradient over a ramp — sampled, so the stops are the
 * same OKLCH walk the cards took rather than the browser's own sRGB blend. */
export function rampGradient(ramp, steps = 12) {
  const stops = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    stops.push(`${rampColor(t, ramp)} ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}
