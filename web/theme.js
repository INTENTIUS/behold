// Theme engine for behold — adopted from spicypath's FG-040 engine. Parses/holds Ghostty
// themes (vendored in ./themes.js from mbadolato/iTerm2-Color-Schemes), derives behold's
// semantic UI + drift tokens from the 16-color palette, applies them as CSS custom
// properties (so the inlined pinhole SVG and all chrome recolour live), and picks readable
// text on any coloured fill. Pure browser JS, no build step. See INTENTIUS/behold#62.
import { THEMES, DEFAULT_THEME } from "./themes.js";

const STORE_KEY = "behold.theme";

// --- low-level colour math (from spicypath) ------------------------------
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export function hexToRgb(hex) {
  let h = String(hex).trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
}
export function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}
export function luminance(hex) { const [r, g, b] = hexToRgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }
export const isDark = (hex) => luminance(hex) < 0.5;

// The headline contrast feature (#62): readable text on any coloured background —
// white on a dark fill, black on a light one, so labels never vanish across 552 themes.
export function readableOn(bg) { return isDark(bg) ? "#ffffff" : "#000000"; }

// --- OKLCH (perceptual hue rotation for category counts > palette slots) --
const s2l = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const l2s = (c) => { const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055; return clamp(v, 0, 1) * 255; };
// A real WCAG contrast ratio (#240) — sRGB→linear via s2l (the same EOTF step
// hexToOklch already does below), unlike the quick luminance() above, which
// skips gamma correction and is only good enough for a light/dark coin-flip
// (isDark/readableOn). The floor --muted has to clear is a real accessibility
// number, and luminance()'s shortcut proved too far off it on the exact
// palette that opened this issue (Darkermatrix: quick metric said 3.03,
// actual WCAG was 2.13) to be worth the savings.
function relLuminance(hex) { const [r, g, b] = hexToRgb(hex).map(s2l); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
export function contrast(a, b) {
  const A = relLuminance(a), B = relLuminance(b);
  return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05);
}
// behold#571: white or black, whichever reads better on `bg` by the real ratio
// above. readableOn's quick coin-flip picks white on a mid-tone ground where
// black reads better (Grass's and Blue Dolphin's neutral card).
export function inkOn(bg) { return contrast("#ffffff", bg) >= contrast("#000000", bg) ? "#ffffff" : "#000000"; }
export function hexToOklch(hex) {
  const [R, G, B] = hexToRgb(hex).map(s2l);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return { L, C: Math.hypot(a, bb), H: (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360 };
}
export function oklchToHex({ L, C, H }) {
  const h = H * Math.PI / 180, a = C * Math.cos(h), bb = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * bb) ** 3;
  return rgbToHex(
    l2s(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    l2s(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    l2s(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s));
}

// behold#571: the most chroma an OKLCH lightness and hue holds inside sRGB,
// so a lightness walk keeps its hue by giving up chroma, not by clipping.
function oklchInGamut({ L, C, H }) {
  const h = H * Math.PI / 180, a = C * Math.cos(h), bb = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * bb) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  return rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
}
export function oklchToHexMapped({ L, C, H }) {
  if (oklchInGamut({ L, C, H })) return oklchToHex({ L, C, H });
  let lo = 0, hi = C;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (oklchInGamut({ L, C: mid, H })) lo = mid;
    else hi = mid;
  }
  return oklchToHex({ L, C: lo, H });
}

// Drop a colour's chroma without touching its lightness — the chrome's one
// "quieter" step (#229). Used on the tokens that SURROUND the drift hues, never
// on the drift hues themselves.
export function desaturate(hex, k) {
  const { L, C, H } = hexToOklch(hex);
  return oklchToHex({ L, C: C * k, H });
}

// #240: the same guaranteed-visible trick #229 used for --active (push OKLCH
// L away from a reference until it clears a bar), generalised from a fixed L
// delta to an actual contrast() floor — because unlike --active's "just don't
// land on the same fill", secondary text has a real legibility target.
//
// Tries `dark`'s intended direction first (lighter text on a dark theme,
// darker on a light one — the direction a person would actually pick, and
// the one #229's --active push uses). luminance() isn't gamma-corrected, so
// its contrast() ratio is asymmetric in a way real perceived contrast isn't
// — it overstates how much headroom the near-black end has. Chasing that
// headroom blindly is how a dark theme's muted text ends up pushed to
// near-black-on-dark-panel, technically clearing the ratio while reading as
// invisible. So the "chase more headroom" fallback only fires if the
// intended direction's own gamut-limited walk can't reach the floor at all
// (a saturated, nominally-dark bg like Hot Dog Stand's red, whose panel ends
// up mid-bright once mixed toward fg) — never as a first choice. Chroma
// eases toward 0 as L walks away so a saturated start doesn't clip out of
// gamut and stall short of the target.
function pushForContrast(hex, against, floor, dark) {
  if (contrast(hex, against) >= floor) return hex;
  const tok = hexToOklch(hex);
  const walk = (dir) => {
    let best = hex, bestRatio = contrast(hex, against);
    for (let step = 1; step <= 100; step++) {
      const t = step / 100;
      const L = clamp(tok.L + dir * step * 0.01, 0, 1);
      const out = oklchToHex({ L, C: tok.C * (1 - t * 0.6), H: tok.H });
      const ratio = contrast(out, against);
      if (ratio > bestRatio) { bestRatio = ratio; best = out; }
      if (ratio >= floor) return { hex: out, ratio, reached: true };
      if (L === 0 || L === 1) break;
    }
    return { hex: best, ratio: bestRatio, reached: false };
  };
  const primary = walk(dark ? 1 : -1);
  if (primary.reached) return primary.hex;
  const fallback = walk(dark ? -1 : 1);
  return fallback.ratio > primary.ratio ? fallback.hex : primary.hex;
}

// --- behold's semantic tokens derived from a theme -----------------------
// Drift states are ANCHORED to palette slots so "coloured by drift" stays meaningful across
// every theme (green=managed … red=degraded); only the shades change. Chrome is derived from
// bg/fg mixes. `cat` are the chromatic slots that colorForCategory cycles for substrates.
//
// #229: the chrome tokens (line/muted/rule/focus/active/well/shadow) are one
// step quieter than the palette that feeds them — the status hues are behold's
// actual message, so everything around them gives up chroma to let them land.
// Every one of them is still DERIVED: no chrome constant is a fixed colour, and
// all 552 palettes have to come out of here legible.
/** behold#725: the least contrast --muted and --muted-ink keep on the grounds they sit on (WCAG AA). */
export const MUTED_FLOOR = 4.5;
/** behold#725: the least contrast --ink2, the secondary prose ink, keeps on every ground (WCAG AAA). */
export const INK2_FLOOR = 7;
/** behold#725: how far --ink2 starts from --fg toward --bg before the floor holds it. */
export const INK2_EASE = 0.22;

export function tokensFor(th) {
  const fgMix = (t) => mix(th.bg, th.fg, t);
  const P = th.palette;
  const panel = fgMix(0.09);
  const kiosk = kioskSurfaces(th);
  // The recessed ground (see `well` below), computed first so --ink2 can be held on it.
  const well = (() => {
    const b = hexToOklch(th.bg);
    return oklchToHex({ ...b, L: clamp(b.L + (b.L < 0.16 ? 0.06 : -0.06), 0, 1) });
  })();
  // The active-control fill (tab strip, the picked option) — the panel pulled
  // toward the accent, then pushed AWAY from the panel's own lightness so the
  // fill is visible even on a palette whose blue slot happens to sit exactly at
  // the panel's lightness (Red Sands, CGA). It stays within one step of the
  // panel, so `--fg` reads on the fill exactly as it reads on the panel — no
  // second ink token to keep legible across the corpus.
  const panelL = hexToOklch(panel).L;
  const rawActive = hexToOklch(mix(panel, P[4], 0.17));
  const active = oklchToHex({
    ...rawActive,
    L: clamp(panelL + (th.dark ? 1 : -1) * clamp(Math.abs(rawActive.L - panelL), 0.055, 0.1), 0.05, 0.95),
  });
  return {
    dark: th.dark,
    bg: th.bg,
    panel,
    line: desaturate(fgMix(0.16), 0.75),
    fg: th.fg,
    // #240: secondary text needs an actual floor, not just "quieter than
    // fg" — a handful of low-range palettes (Darkermatrix and friends) mix
    // fg/panel close enough that the quieted 0.5 mix reads at ~1.25:1.
    // Push its OKLCH L away from --panel's until it clears MUTED_FLOOR
    // (behold#725: 4.5:1, WCAG AA for body text; it was 3:1).
    muted: pushForContrast(desaturate(fgMix(0.5), 0.75), panel, MUTED_FLOOR, th.dark),
    edge: fgMix(0.32),
    // The structural border — the panel shell, the pane edge, the footer rule.
    // Tinted by the palette's OWN bright-black slot instead of being one more
    // fg/bg mix, but anchored to a guaranteed-visible mix so a theme whose
    // slot 8 sits on the panel's lightness still draws an edge.
    rule: mix(fgMix(0.22), P[8], 0.45),
    // Interaction chrome (hover/focus borders, the load spinner): the accent
    // with most of its chroma taken off, so hover doesn't compete with a
    // pending node for the same blue.
    focus: desaturate(P[4], 0.4),
    active,
    // The recessed ground — the nowline log, the ⌘K input. One perceptual step
    // off the background (down, or UP on the near-black palettes where there is
    // no "darker" left), keeping the bg's own hue so it never reads as a patch
    // of a different theme.
    well,
    // Shadow/scrim base, used through color-mix() at the call site — a light
    // theme's drop shadow must not be the same slab of black a dark one wants.
    shadow: mix(th.bg, "#000000", th.dark ? 0.85 : 0.6),
    managed: th.palette[2],   // green  — good / managed
    foreign: th.palette[3],   // yellow — warn / foreign
    pending: th.palette[4],   // blue   — accent / pending
    degraded: th.palette[1],  // red    — degraded / failed
    neutral: fgMix(0.45),     // grey   — not deployed / unknown
    // chant#1180 (#1077, behold#86): a live, undeclared node whose owner
    // chain reaches a declared entity — expected runtime (a Pod its
    // Deployment created), never drift and never foreign. Cyan keeps it
    // clearly apart from foreign (yellow) and degraded (red) — "informational,
    // not a problem" — while still being its own colour, not a reuse of
    // managed/pending (which would misreport it as chant-declared or as a
    // pending change).
    runtime: th.palette[6],   // cyan   — runtime child (expected, not drift)
    cat: [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14].map((i) => th.palette[i]),
    ...kiosk,
    ink2: ink2For(th, ink2Grounds(th, { panel, well, kiosk })),
  };
}

/**
 * behold#725: every ground --ink2 is read on: the page, the app's panel and
 * well, the kiosk's surfaces, and each of those under the zebra tint.
 */
export function ink2Grounds(th, { panel, well, kiosk }) {
  const plain = [th.bg, panel, well, kiosk.surfaceBox, kiosk.surfacePaneA, kiosk.surfacePaneB];
  return [...plain, ...plain.map((g) => mix(g, th.fg, ZEBRA))];
}

/**
 * behold#725: the secondary prose ink. Sentences that sit under a heading or
 * beside a value read in it, where --muted stays for keys and captions. It is
 * --fg eased INK2_EASE of the way toward --bg, then pushed back until it
 * clears INK2_FLOOR on every ground. Where --fg itself sits under the floor
 * (a low-contrast palette), the push goes past --fg, as far as the gamut
 * allows.
 */
function ink2For(th, grounds) {
  const up = hexToOklch(th.fg).L >= hexToOklch(th.bg).L;
  const pushed = pushAll(mix(th.fg, th.bg, INK2_EASE), grounds, INK2_FLOOR, up);
  if (worstOn(pushed, grounds) >= INK2_FLOOR) return pushed;
  // A mid-tone palette (Grass, Hot Dog Stand and nine others) where not even
  // white or black reaches the floor on every ground: the best of the three.
  return [pushed, "#ffffff", "#000000"].reduce((a, b) => (worstOn(b, grounds) > worstOn(a, grounds) + 0.01 ? b : a));
}

// --- the kiosk's surfaces (behold#571) -------------------------------------
// The kiosk lays several panes side by side; on one flat near-black they run
// together. Each region gets its own calm level instead: the page, a step up
// for the header's boxes, and two alternating pane levels, with a zebra tint
// for list rows and softened ink for text. All derived from the palette, so
// every theme gets them; theme.test.js holds the floors across the corpus.

/** The zebra row's tint: this share of --fg over the row's surface. */
export const ZEBRA = 0.035;
/** The surfaces' steps in OKLCH lightness from --bg, toward --fg's side. */
export const SURFACE_STEPS = { box: 0.03, paneA: 0.055, paneB: 0.08 };
/** How bright body ink may get against --bg: softer than a pure white on near-black. */
export const SOFT_CEILING = 13;
/** The least OKLCH lightness between two neighbouring levels, so each reads as its own box. */
export const MIN_STEP = 0.02;
/**
 * behold#725: the share of --bg's OKLCH chroma the derived surfaces keep. A
 * saturated ground (a deep blue or red) stacked three steps high reads loud;
 * the surfaces keep its hue at under half its colour. --bg itself is left alone.
 */
export const SURFACE_CHROMA = 0.4;

/** The root dots' hues, by theme (behold#571): violet, orange, orchid, silver, tan. Never a state's. */
export const ROOT_HUES = {
  dark: ["#b392f0", "#ff9f5a", "#e66ce8", "#e4e4e4", "#c89b6d"],
  light: ["#7c3aed", "#c2410c", "#a21caf", "#334155", "#8b5a2b"],
};

/** A colour pushed until it clears `floor` against every one of `against` (worst first). */
function pushAll(hex, against, floor, dark) {
  let out = hex;
  for (let i = 0; i < 4; i++) {
    const worst = against.reduce((w, b) => (contrast(out, b) < contrast(out, w) ? b : w), against[0]);
    if (contrast(out, worst) >= floor) return out;
    out = pushForContrast(out, worst, floor, dark);
  }
  return out;
}

/**
 * The surfaces and the ink that reads on them: `surfaceBox` (the header's
 * boxes), `surfacePaneA` and `surfacePaneB` (the panes, alternating), each a
 * step further from --bg in OKLCH lightness (lighter on a dark theme, darker
 * on a light one; the other way where the palette leaves no room), `zebra`
 * (the tint list rows alternate with), `soft` (body ink: --fg, eased toward
 * --bg where it would glare, and never under 4.5:1 on any surface or zebra
 * row), `mutedInk` (keys and captions, MUTED_FLOOR on all of them; behold#725
 * raised it from 3:1), each state colour's
 * `*Ink` (3:1 on all of them) and `roots` (the root dots, 3:1 on all of them).
 */
export function kioskSurfaces(th) {
  const b = hexToOklch(th.bg);
  const f = hexToOklch(th.fg);
  // Toward fg's side (lighter on a dark theme), unless that runs out of room or
  // eats the text's headroom on a mid-tone ground (Blue Dolphin, Hot Dog Stand).
  // The ink's side: --fg's, unless even the far end of it can't clear 4.5:1 with
  // room to spare (white on Hot Dog Stand's red): then the other side.
  let inkUp = f.L >= b.L;
  if (contrast(inkUp ? "#ffffff" : "#000000", th.bg) < 5.5) inkUp = !inkUp;
  const fgSide = inkUp === f.L >= b.L;
  const towardInk = inkUp ? 1 : -1;
  const roomFor = (d) => (d > 0 ? b.L + 0.12 <= 0.97 : b.L - 0.12 >= 0.03);
  const want = fgSide && contrast(th.fg, th.bg) >= 7 ? towardInk : -towardInk;
  const dir = roomFor(want) ? want : -want;
  // Each level at least MIN_STEP of OKLCH lightness past the one before, as the
  // colour rounds to 8 bits (near black, small steps all round to #000000).
  const levels = [];
  const ground = { ...b, C: b.C * SURFACE_CHROMA };
  let prev = b.L;
  for (const dl of [SURFACE_STEPS.box, SURFACE_STEPS.paneA - SURFACE_STEPS.box, SURFACE_STEPS.paneB - SURFACE_STEPS.paneA]) {
    let want = prev + dir * dl;
    let hex = oklchToHex({ ...ground, L: clamp(want, 0, 1) });
    for (let i = 0; i < 40 && Math.abs(hexToOklch(hex).L - prev) < MIN_STEP; i++) {
      want += dir * 0.005;
      hex = oklchToHex({ ...ground, L: clamp(want, 0, 1) });
    }
    levels.push(hex);
    prev = hexToOklch(hex).L;
  }
  const [surfaceBox, surfacePaneA, surfacePaneB] = levels;
  const surfaces = [th.bg, surfaceBox, surfacePaneA, surfacePaneB];
  const grounds = [...surfaces, ...surfaces.map((s) => mix(s, th.fg, ZEBRA))];
  const lightInk = inkUp;
  // Body ink: --fg eased toward --bg until it sits at SOFT_CEILING, then held at 4.5:1 on every ground.
  let soft = fgSide ? th.fg : inkUp ? "#ffffff" : "#000000";
  if (fgSide && contrast(th.fg, th.bg) > SOFT_CEILING) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 20; i++) {
      const t = (lo + hi) / 2;
      if (contrast(mix(th.fg, th.bg, t), th.bg) > SOFT_CEILING) lo = t;
      else hi = t;
    }
    soft = mix(th.fg, th.bg, lo);
  }
  soft = pushAll(soft, grounds, 4.5, lightInk);
  const muted = pushAll(desaturate(mix(th.bg, th.fg, 0.5), 0.75), grounds, MUTED_FLOOR, lightInk);
  const P = th.palette;
  const ink = (c) => pushAll(c, grounds, 3, lightInk);
  const hues = th.dark ? ROOT_HUES.dark : ROOT_HUES.light;
  return {
    surfaceBox,
    surfacePaneA,
    surfacePaneB,
    zebra: th.fg,
    soft,
    mutedInk: muted,
    managedInk: ink(P[2]),
    foreignInk: ink(P[3]),
    pendingInk: ink(P[4]),
    degradedInk: ink(P[1]),
    runtimeInk: ink(P[6]),
    roots: hues.map(ink),
  };
}

// CSS custom properties behold's chrome (:root) reads. The pre-paint fallback
// block in index.html mirrors these for the DEFAULT theme — smoke/ui-smoke.mjs
// recomputes it from here and fails if the two ever drift apart.
const CSS_VARS = ["bg", "panel", "line", "fg", "muted", "ink2", "edge", "managed", "foreign", "pending", "degraded", "neutral", "runtime", "rule", "focus", "active", "well", "shadow"];
// behold#571: the kiosk's surfaces and ink, as --surface-box, --soft, --managed-ink and the like; the root dots as --root-0 … --root-4.
const KIOSK_VARS = { surfaceBox: "surface-box", surfacePaneA: "surface-pane-a", surfacePaneB: "surface-pane-b", zebra: "zebra", soft: "soft", mutedInk: "muted-ink", managedInk: "managed-ink", foreignInk: "foreign-ink", pendingInk: "pending-ink", degradedInk: "degraded-ink", runtimeInk: "runtime-ink" };

// pinhole (the graph painter) reads its OWN vars, `--pin-<token>` (emitted as
// `var(--pin-token, <baked default>)`). Derive them from the active Ghostty theme so the graph
// recolours with everything else. Keep pinhole's status intent (good=green, warn=red,
// accent=blue). Node cards are a PANEL clearly distinct from the bg — else neutral nodes
// blend into the background and look transparent — tinted toward the status hue; node text
// (--pin-text = fg) stays readable on them.
export function pinTokensFor(th) {
  const P = th.palette, fgMix = (t) => mix(th.bg, th.fg, t);
  const good = P[2], warn = P[1], accent = P[4], runtime = P[6]; // P[6] = the cyan the CSS --runtime var rides
  // behold#571: a card a state's words can read on at 4.5:1. A mid-tone palette
  // (Blue Dolphin, Grass) mixes a card even white or black can't reach that on;
  // its lightness steps away from the text's side until one of them can.
  const panel = (() => {
    const p0 = fgMix(0.18);
    const best = (c) => Math.max(contrast(c, "#ffffff"), contrast(c, "#000000"));
    if (best(p0) >= 4.8) return p0;
    const o = hexToOklch(p0);
    const dir = contrast(p0, "#ffffff") >= contrast(p0, "#000000") ? -1 : 1;
    for (let step = 1; step <= 40; step++) {
      const c = oklchToHexMapped({ ...o, L: clamp(o.L + dir * step * 0.005, 0, 1) });
      if (best(c) >= 4.8) return c;
    }
    return p0;
  })();                                      // node card base — elevated well off the bg
  const fill = (c) => mix(panel, c, 0.4);    // panel pulled strongly toward the status hue
  // behold#571: a status outline is a thin line on the background and the wave box: 3:1 on both, its hue kept.
  const up = hexToOklch(th.bg).L < 0.6;
  const line = (c) => lightnessFor(c, [th.bg, fgMix(0.045)], 3, up);
  const stroke = (c) => line(mix(th.bg, c, 0.62));
  return {
    bg0: th.bg, bg1: fgMix(0.045), dots: fgMix(0.12),
    text: th.fg, textMuted: fgMix(0.5), textFaint: fgMix(0.38), edge: fgMix(0.3),
    neutralFill: panel, neutralStroke: fgMix(0.3), neutralBar: fgMix(0.5),
    accentFill: fill(accent), accentStroke: stroke(accent), accentBar: accent,
    goodFill: fill(good), goodStroke: stroke(good), goodBar: good,
    warnFill: fill(warn), warnStroke: stroke(warn), warnBar: warn,
    runtimeFill: fill(runtime), runtimeStroke: stroke(runtime), runtimeBar: runtime,
    selectedStroke: line(accent),
  };
}
/**
 * behold#571: the state colours as the graph frame draws them as text and thin
 * lines: a card's state words and its outline, a wave box's job status and
 * outline, a read's line. Each is the state's hue with its OKLCH lightness
 * moved until it reads at WCAG AA (4.5:1) on the ground its words sit on, and
 * at 3:1 (a line's floor) on every other ground of the frame: `box` inks for
 * the background and the wave boxes, `card` inks for the cards.
 */
export const FRAME_STATES = ["managed", "foreign", "pending", "degraded", "runtime", "neutral", "focus", "muted"];
export function frameGrounds(th) {
  const pin = pinTokensFor(th);
  return { box: [th.bg, pin.bg1], card: [pin.neutralFill] };
}
const worstOn = (c, grounds) => Math.min(...grounds.map((g) => contrast(c, g)));
/**
 * `hex` with its OKLCH lightness walked, its hue kept, until it clears
 * `floor` on each of `grounds` and `lineFloor` on each of `others`. Chroma
 * gives way only where sRGB can't hold it at that lightness; a theme whose
 * grounds leave no room at all gets white or black.
 */
function lightnessFor(hex, grounds, floor, up, others = [], lineFloor = 3) {
  const ok = (c) => worstOn(c, grounds) >= floor && (!others.length || worstOn(c, others) >= lineFloor);
  if (ok(hex)) return hex;
  const o = hexToOklch(hex);
  const walk = (dir) => {
    for (let step = 1; step <= 200; step++) {
      const L = clamp(o.L + dir * step * 0.005, 0, 1);
      const out = oklchToHexMapped({ L, C: o.C, H: o.H });
      if (ok(out)) return out;
      if (L === 0 || L === 1) break;
    }
    return null;
  };
  const found = walk(up ? 1 : -1) || walk(up ? -1 : 1);
  if (found) return found;
  const ends = up ? ["#ffffff", "#000000"] : ["#000000", "#ffffff"];
  return ends.find(ok) || ends.reduce((a, b) => (worstOn(b, grounds) > worstOn(a, grounds) ? b : a));
}
export function frameInks(th) {
  const t = tokensFor(th);
  const g = frameGrounds(th);
  const all = [...g.box, ...g.card];
  // Lighter on a ground that is dark, darker on a light one.
  const up = (gs) => hexToOklch(gs[0]).L < 0.6;
  const box = {};
  const card = {};
  for (const s of FRAME_STATES) {
    box[s] = lightnessFor(t[s], g.box, 4.5, up(g.box), all);
    card[s] = lightnessFor(t[s], g.card, 4.5, up(g.card), all);
  }
  return { box, card };
}

/**
 * behold#571: the left bars. Every listed item in the kiosk, the app and the
 * lanes strip (a run, a job, a step, a wave card, a panel row) carries a bar
 * down its left edge, so the eye can tell one item from the next where the
 * zebra tint barely shows. An item with a state wears the state's colour
 * (running in the accent, held in the waiting amber, failed, applied), one
 * with none the neutral bar. Each is the state's hue with its OKLCH lightness
 * moved, as frameInks does, until it clears BAR_FLOOR on every ground a bar
 * sits on (barGrounds): the page, the panes, the app's panel and well, each
 * with its zebra row, and the selected, hovered and held rows' fills.
 */
export const BAR_STATES = ["managed", "foreign", "pending", "degraded", "runtime", "neutral"];
/** The least WCAG contrast a bar keeps on every ground: a graphical object's floor (1.4.11). */
export const BAR_FLOOR = 3;
export function barGrounds(th) {
  const t = tokensFor(th);
  const plain = [th.bg, t.surfaceBox, t.surfacePaneA, t.surfacePaneB, t.panel, t.well];
  return [
    ...plain,
    ...plain.map((s) => mix(s, th.fg, ZEBRA)),
    // A selected or hovered row (--active, whole and half), a hover-linked one (--focus at 24%), a held one (the waiting tone at 14%).
    ...[t.surfacePaneA, t.surfacePaneB, t.panel].flatMap((s) => [t.active, mix(s, t.active, 0.5), mix(s, t.focus, 0.24), mix(s, t.foreign, 0.14)]),
  ];
}
export function barInks(th) {
  const t = tokensFor(th);
  const grounds = barGrounds(th);
  const up = hexToOklch(th.bg).L < 0.6;
  const out = {};
  for (const s of BAR_STATES) out[s] = lightnessFor(t[s], grounds, BAR_FLOOR, up);
  return out;
}
/**
 * The bar for an item whose state is drawn today as a colour (`var(--managed)`
 * on its dot, say): that state's bar, or the neutral one for anything else
 * (--muted, a hex, nothing).
 */
export function barVarFor(color) {
  const m = /^var\(--(\w+)\)$/.exec(String(color || "").trim());
  return m && BAR_STATES.includes(m[1]) ? `var(--bar-${m[1]})` : "var(--bar-neutral)";
}
/** The bars as CSS custom properties: `--bar-managed` … `--bar-neutral`. */
export function barVars(th) {
  const inks = barInks(th);
  return Object.fromEntries(BAR_STATES.map((s) => [`bar-${s}`, inks[s]]));
}

const PIN_VARS = ["bg0", "bg1", "dots", "text", "textMuted", "textFaint", "edge", "neutralFill", "neutralStroke", "neutralBar", "accentFill", "accentStroke", "accentBar", "goodFill", "goodStroke", "goodBar", "warnFill", "warnStroke", "warnBar", "runtimeFill", "runtimeStroke", "runtimeBar", "selectedStroke"];

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
// A substrate/lexicon (aws, k8s, gcp, …) gets one of the theme's categorical hues, perturbed
// in OKLCH deterministically so families stay distinct past the ~12 slot count (spicypath pattern).
// The active theme name is folded into the hash (#62): each theme redistributes categories across
// different palette slots, so switching themes visibly re-maps every node's colour rather than
// keeping a category anchored to one slot (which stayed e.g. teal in every terminal palette).
export function colorForCategory(key) {
  const cat = _tokens.cat;
  const h = hash((_active ? _active.name : "") + " " + String(key));
  const { L, C, H } = hexToOklch(cat[h % cat.length]);
  const dH = (((h >>> 4) % 31) - 15) * 1.6;
  const dL = (((h >>> 9) % 5) - 2) * 0.035;
  return oklchToHex({ L: clamp(L + dL, 0.2, 0.92), C, H: (H + dH + 360) % 360 });
}

// --- active theme state + application -------------------------------------
let _active = THEMES[DEFAULT_THEME] || Object.values(THEMES)[0] || null;
let _tokens = _active ? tokensFor(_active) : null;
const _subs = new Set();

export function listThemes() { return Object.keys(THEMES); }
export function getTheme() { return _active; }
export function getTokens() { return _tokens; }
export function getThemeName() { return _active && _active.name; }
export function onThemeChange(cb) { _subs.add(cb); return () => _subs.delete(cb); }

/**
 * behold#725: every custom property applyTheme sets for `tokens`, as
 * { "--name": value }. One list, so the page and the pre-paint copy
 * (paintFor) can't drift apart.
 */
export function themeVars(tokens, th = _active) {
  const vars = {};
  for (const k of CSS_VARS) vars["--" + k] = tokens[k];
  for (const [k, v] of Object.entries(KIOSK_VARS)) if (tokens[k]) vars["--" + v] = tokens[k];
  (tokens.roots || []).forEach((c, i) => { vars[`--root-${i}`] = c; });
  if (th) {
    const pin = pinTokensFor(th);
    for (const k of PIN_VARS) vars["--pin-" + k] = pin[k];
    // behold#571: the state colours the graph frame draws as text and lines, legible on every ground (frameInks).
    const inks = frameInks(th);
    for (const k of FRAME_STATES) {
      vars["--frame-" + k] = inks.box[k];
      vars["--frame-card-" + k] = inks.card[k];
    }
    // behold#571: the left bars' colours, shared by the app, the kiosk and the lanes strip (barInks).
    for (const [k, v] of Object.entries(barVars(th))) vars["--" + k] = v;
  }
  return vars;
}

/**
 * behold#725: where applyTheme keeps the last theme it painted, for the
 * inline script at the top of index.html and kiosk.html. theme.js is a module
 * and runs after the first frame, so a viewer's own theme would open on the
 * page's default for a moment. That script reads this record first and
 * applies it when it belongs to the stored theme.
 */
export const PAINT_KEY = "behold.theme.paint";
/** The record applyTheme keeps under PAINT_KEY. */
export function paintFor(tokens, th = _active) {
  return { name: th ? th.name : null, scheme: tokens.dark ? "dark" : "light", vars: themeVars(tokens, th) };
}

export function applyTheme(tokens = _tokens) {
  if (!tokens || typeof document === "undefined") return;
  const root = document.documentElement;
  const paint = paintFor(tokens, _active);
  for (const [k, v] of Object.entries(paint.vars)) root.style.setProperty(k, v);
  root.style.setProperty("color-scheme", paint.scheme);
  try { localStorage.setItem(PAINT_KEY, JSON.stringify(paint)); } catch { /* private mode or a full store: the next load opens on the default first */ }
}

export function setTheme(nameOrObj, { persist = true } = {}) {
  const th = typeof nameOrObj === "string" ? THEMES[nameOrObj] : nameOrObj;
  if (!th) return false;
  _active = th; _tokens = tokensFor(th);
  applyTheme(_tokens);
  if (persist) { try { localStorage.setItem(STORE_KEY, th.name); } catch { /* private mode */ } }
  for (const cb of _subs) cb(th, _tokens);
  return true;
}

/** behold#571: the kiosk's theme for a viewer who hasn't picked one; the app keeps DEFAULT_THEME. */
export const KIOSK_THEME = "Sea Shells";

// Restore the persisted theme (or `fallback`, else the default) and apply. Call once on boot.
export function initTheme(fallback = null) {
  let saved = null;
  try { saved = localStorage.getItem(STORE_KEY); } catch { /* private mode */ }
  const first = fallback && THEMES[fallback] ? fallback : (_active ? _active.name : DEFAULT_THEME);
  setTheme(saved && THEMES[saved] ? saved : first, { persist: false });
  return getThemeName();
}

// A minimal, searchable picker (native <select>; type-to-search over 552 themes). Grouped
// dark/light. Mount it into any container; it stays in sync with programmatic setTheme.
export function mountThemePicker(container) {
  if (!container || typeof document === "undefined") return null;
  const sel = document.createElement("select");
  sel.setAttribute("aria-label", "Color theme");
  sel.title = "Color theme";
  sel.style.cssText =
    "background:var(--well);color:var(--fg);border:1px solid var(--line);border-radius:var(--r-ctl);padding:4px 8px;font:var(--t-body)/1.3 var(--font-ui);max-width:220px";
  const groups = { Dark: document.createElement("optgroup"), Light: document.createElement("optgroup") };
  groups.Dark.label = "Dark"; groups.Light.label = "Light";
  for (const name of listThemes()) {
    const o = document.createElement("option");
    o.value = name; o.textContent = name;
    (THEMES[name].dark ? groups.Dark : groups.Light).appendChild(o);
  }
  sel.appendChild(groups.Dark); sel.appendChild(groups.Light);
  sel.value = getThemeName();
  sel.addEventListener("change", () => setTheme(sel.value));
  onThemeChange(() => { if (sel.value !== getThemeName()) sel.value = getThemeName(); });
  container.appendChild(sel);
  return sel;
}
