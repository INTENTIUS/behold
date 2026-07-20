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

// --- behold's semantic tokens derived from a theme -----------------------
// Drift states are ANCHORED to palette slots so "coloured by drift" stays meaningful across
// every theme (green=managed … red=degraded); only the shades change. Chrome is derived from
// bg/fg mixes. `cat` are the chromatic slots that colorForCategory cycles for substrates.
export function tokensFor(th) {
  const fgMix = (t) => mix(th.bg, th.fg, t);
  return {
    dark: th.dark,
    bg: th.bg,
    panel: fgMix(0.09),
    line: fgMix(0.16),
    fg: th.fg,
    muted: fgMix(0.5),
    edge: fgMix(0.32),
    managed: th.palette[2],   // green  — good / managed
    foreign: th.palette[3],   // yellow — warn / foreign
    pending: th.palette[4],   // blue   — accent / pending
    degraded: th.palette[1],  // red    — degraded / failed
    neutral: fgMix(0.45),     // grey   — not deployed / unknown
    cat: [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14].map((i) => th.palette[i]),
  };
}

// CSS custom properties behold's chrome (:root) reads.
const CSS_VARS = ["bg", "panel", "line", "fg", "muted", "edge", "managed", "foreign", "pending", "degraded", "neutral"];

// pinhole (the graph painter) reads its OWN vars, `--pin-<token>` (emitted as
// `var(--pin-token, <baked default>)`). Derive them from the active Ghostty theme so the graph
// recolours with everything else. Keep pinhole's status intent (good=green, warn=red,
// accent=blue). Node cards are a PANEL clearly distinct from the bg — else neutral nodes
// blend into the background and look transparent — tinted toward the status hue; node text
// (--pin-text = fg) stays readable on them.
export function pinTokensFor(th) {
  const P = th.palette, fgMix = (t) => mix(th.bg, th.fg, t);
  const good = P[2], warn = P[1], accent = P[4];
  const panel = fgMix(0.12);                 // node card base — visibly distinct from the bg
  const fill = (c) => mix(panel, c, 0.22);   // panel tinted toward a status hue
  const stroke = (c) => mix(th.bg, c, 0.5);
  return {
    bg0: th.bg, bg1: fgMix(0.045), dots: fgMix(0.12),
    text: th.fg, textMuted: fgMix(0.5), textFaint: fgMix(0.38), edge: fgMix(0.3),
    neutralFill: panel, neutralStroke: fgMix(0.26), neutralBar: fgMix(0.45),
    accentFill: fill(accent), accentStroke: stroke(accent), accentBar: accent,
    goodFill: fill(good), goodStroke: stroke(good), goodBar: good,
    warnFill: fill(warn), warnStroke: stroke(warn), warnBar: warn,
    selectedStroke: accent,
  };
}
const PIN_VARS = ["bg0", "bg1", "dots", "text", "textMuted", "textFaint", "edge", "neutralFill", "neutralStroke", "neutralBar", "accentFill", "accentStroke", "accentBar", "goodFill", "goodStroke", "goodBar", "warnFill", "warnStroke", "warnBar", "selectedStroke"];

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
// A substrate/lexicon (aws, k8s, gcp, …) gets one of the theme's categorical hues, perturbed
// in OKLCH deterministically so families stay distinct past the ~12 slot count (spicypath pattern).
export function colorForCategory(key) {
  const cat = _tokens.cat;
  const h = hash(String(key));
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

export function applyTheme(tokens = _tokens) {
  if (!tokens || typeof document === "undefined") return;
  const root = document.documentElement;
  for (const k of CSS_VARS) root.style.setProperty("--" + k, tokens[k]);
  if (_active) { const pin = pinTokensFor(_active); for (const k of PIN_VARS) root.style.setProperty("--pin-" + k, pin[k]); }
  root.style.setProperty("color-scheme", tokens.dark ? "dark" : "light");
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

// Restore the persisted theme (or default) and apply. Call once on boot.
export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(STORE_KEY); } catch { /* private mode */ }
  setTheme(saved && THEMES[saved] ? saved : (_active ? _active.name : DEFAULT_THEME), { persist: false });
  return getThemeName();
}

// A minimal, searchable picker (native <select>; type-to-search over 552 themes). Grouped
// dark/light. Mount it into any container; it stays in sync with programmatic setTheme.
export function mountThemePicker(container) {
  if (!container || typeof document === "undefined") return null;
  const sel = document.createElement("select");
  sel.setAttribute("aria-label", "Color theme");
  sel.title = "Color theme";
  sel.style.cssText = "background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 8px;font-size:12px;max-width:220px";
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
