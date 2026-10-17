// The dots preview's page layer (#712). Mounted only when /api/graph's meta
// carries `dots`, which only the local preview server (scripts/dots-preview.ts)
// sends; everywhere else every export here is a no-op and the app behaves as
// it always has.
//
// Cards stay in pinhole's SVG. Dots, estate boxes and discs are drawn on one
// Canvas 2D layer under it, through the same viewBox camera. Each mark picks
// its form from its size on screen (web/dots-lod.js), and the morph follows
// the zoom. The replay plays a real recording (web/dots-recording.js) through
// the choreography in web/dots-scene.js.

import { readCarve, carveShow, walkthroughShow, phaseAt } from "./dots-recording.js";
import { parentsOf } from "./dots-layout.js";
import { buildScene, takeoffsBy, firstLandings, flightPoint, easeInOut, replayClock, BOX } from "./dots-scene.js";
import { cardMorph, discMorph, discRadius, levelOf, caption, railMarks, railPos, lerp } from "./dots-lod.js";
import { perimeter, pointAt, nearestS, segment } from "./dots-border.js";
import { getTokens, onThemeChange, contrast, hexToOklch, oklchToHex } from "./theme.js";

let S = null;
let styleAdded = false;

const RIPPLE_MS = 650;
const PULSE_MS = 520;
const DRAW_MS = 650;
const LINGER_MS = 2600;

export function dotsActive() {
  return !!S;
}

/** How far past the fit the zoom may go out, as a multiple of the fit's width; null when not mounted. */
export function dotsZoomOutFactor() {
  return S ? S.zoomOut : null;
}

/** The camera moved: draw at the new zoom. */
export function dotsCamera() {
  if (S) S.dirty = true;
}

export function unmountDots() {
  if (!S) return;
  cancelAnimationFrame(S.raf);
  S.off.forEach((f) => f());
  for (const el of [S.canvas, S.ui]) el.remove();
  S.host.classList.remove("dots-on");
  S.host.style.removeProperty("--dots-card-a");
  if (S.svg) S.svg.style.visibility = "";
  S = null;
}

function addStyle() {
  if (styleAdded) return;
  styleAdded = true;
  const st = document.createElement("style");
  st.textContent = `
  .dots-on > svg { position: relative; z-index: 1; background: transparent; }
  .dots-on > svg > rect[fill^="url(#pin-"] { display: none; }
  .dots-on > svg [data-node-id], .dots-on > svg rect[data-group-id], .dots-on > svg text { opacity: var(--dots-card-a, 1); }
  #dots-canvas { position: absolute; left: 0; top: 0; z-index: 0; pointer-events: none; }
  #dots-ui { position: absolute; inset: 0; pointer-events: none; z-index: 3; font: var(--t-body, 13px)/1.3 var(--font-ui, system-ui); color: var(--fg); }
  #dots-ui > * { pointer-events: auto; }
  .dots-rail { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); width: 132px; height: 190px; padding: 0 0 0 0; border-radius: 8px; background: color-mix(in srgb, var(--panel) 88%, transparent); border: 1px solid var(--line); box-sizing: content-box; padding: 6px 8px 6px 4px; }
  .dots-rail-track { position: absolute; right: 8px; top: 8px; bottom: 8px; width: 3px; border-radius: 2px; background: var(--line); }
  .dots-rail-cam { position: absolute; right: 2px; width: 15px; height: 15px; margin-top: -7.5px; border-radius: 50%; border: 2px solid var(--focus); background: var(--panel); pointer-events: none; }
  .dots-rail-mark { position: absolute; right: 0; transform: translateY(-50%); display: flex; align-items: center; gap: 6px; background: none; border: 0; color: var(--fg); cursor: pointer; padding: 3px 0; text-align: right; font: inherit; }
  .dots-rail-mark span { display: block; }
  .dots-rail-mark b { display: block; font-weight: 600; }
  .dots-rail-mark small { display: block; color: var(--muted); font-size: 11px; }
  .dots-rail-mark i { width: 11px; height: 11px; border-radius: 50%; border: 2px solid var(--muted); background: var(--bg); flex: none; margin-right: 4px; }
  .dots-rail-mark:hover i, .dots-rail-mark:focus-visible i { border-color: var(--focus); }
  .dots-bottom { position: absolute; left: 50%; transform: translateX(-50%); bottom: 12px; display: flex; flex-direction: column; align-items: center; gap: 6px; max-width: calc(100% - 24px); pointer-events: none; }
  .dots-bottom > * { pointer-events: auto; }
  .dots-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; max-width: calc(100% - 24px); background: color-mix(in srgb, var(--panel) 92%, transparent); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; box-sizing: border-box; }
  .dots-bar button, .dots-bar select { background: var(--well); color: var(--fg); border: 1px solid var(--line); border-radius: 5px; padding: 3px 8px; font: inherit; cursor: pointer; }
  .dots-bar input[type=range] { width: min(320px, 40vw); accent-color: var(--focus); }
  .dots-time { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 12em; }
  .dots-caption { padding: 3px 10px; border-radius: 6px; background: color-mix(in srgb, var(--bg) 80%, transparent); color: var(--fg); white-space: nowrap; max-width: calc(100% - 24px); overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; }
  .dots-tip { position: absolute; pointer-events: none; padding: 3px 7px; border-radius: 5px; background: var(--panel); border: 1px solid var(--line); white-space: nowrap; display: none; font-size: 12px; }
  @media (max-width: 640px) {
    .dots-rail { top: 52px; transform: none; width: 84px; height: 112px; right: 6px; padding: 4px 6px 4px 2px; }
    .dots-rail-mark { font-size: 11px; }
    .dots-rail-mark small { display: none; }
    .dots-bottom { bottom: 6px; }
    .dots-bar { gap: 6px; padding: 5px 8px; }
    .dots-bar input[type=range] { width: 100%; order: 9; }
    .dots-time { min-width: 0; }
    .dots-caption { font-size: 12px; white-space: normal; text-align: center; }
  }`;
  document.head.appendChild(st);
}

// --- colours ---------------------------------------------------------------

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A colour moved in OKLCH lightness until it clears `floor` against bg. */
function clear(hex, bg, floor = 3) {
  if (!/^#[0-9a-f]{6}$/i.test(hex) || !/^#[0-9a-f]{6}$/i.test(bg)) return hex;
  const c = hexToOklch(hex);
  const up = hexToOklch(bg).L < 0.6;
  let out = hex;
  for (let i = 0; i < 40 && contrast(out, bg) < floor; i++) out = oklchToHex({ ...c, L: Math.max(0, Math.min(1, c.L + (up ? 1 : -1) * 0.02 * (i + 1))) });
  return out;
}

/**
 * The estates' colours, from the theme: the source estate wears the neutral
 * bar; the others take hues spread round OKLCH at the lightness and chroma of
 * the theme's own state colours, skipping the reds the failure flare uses,
 * each lifted to 3:1 on the page.
 */
function estateColours(estates, source) {
  const t = getTokens();
  const bg = cssVar("--bg") || (t && t.bg) || "#000000";
  const out = new Map([[source, cssVar("--bar-neutral") || (t && t.neutral)]]);
  const refs = t ? [t.managed, t.pending, t.runtime, t.foreign].filter(Boolean).map(hexToOklch) : [];
  const L = refs.length ? refs.reduce((s, c) => s + c.L, 0) / refs.length : 0.7;
  const C = refs.length ? Math.max(0.09, refs.reduce((s, c) => s + c.C, 0) / refs.length) : 0.12;
  const others = estates.filter((e) => e !== source);
  others.forEach((e, i) => {
    // 60..340 degrees: everything but red.
    const H = 60 + (280 * i) / Math.max(1, others.length);
    out.set(e, clear(oklchToHex({ L, C, H }), bg, 3));
  });
  return out;
}

function readColours() {
  const bg = cssVar("--bg") || "#000000";
  const st = {
    bg,
    fg: cssVar("--fg"),
    muted: cssVar("--muted-ink") || cssVar("--muted"),
    surface: cssVar("--surface-box") || cssVar("--panel"),
    pending: cssVar("--bar-pending"),
    managed: cssVar("--bar-managed"),
    degraded: cssVar("--bar-degraded"),
    runtime: cssVar("--bar-runtime"),
    foreign: cssVar("--bar-foreign"),
    neutral: cssVar("--bar-neutral"),
  };
  st.estate = estateColours(S.scene.estates, S.scene.source);
  return st;
}

function rgba(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

// --- mount -----------------------------------------------------------------

/**
 * host: #graph; svg: the card SVG on the page; meta: /api/graph's meta;
 * getVB / setVB: the app's viewBox camera.
 */
export async function mountDots({ host, svg, meta, getVB, setVB, vbInit }) {
  const name = meta.dots.source;
  let show = S && S.name === name ? S.show : null;
  const keep = S && S.name === name ? { t: S.t, playing: S.playing, speed: S.speed } : null;
  unmountDots();
  if (!show) {
    const res = await fetch(`/api/dots/source?name=${encodeURIComponent(name)}`);
    const src = await res.json();
    if (!res.ok) throw new Error(src.error || "dots source unreadable");
    if (src.kind === "carve") {
      const rec = readCarve(src.text);
      show = carveShow(rec, parentsOf(rec.roster));
    } else show = walkthroughShow(src.model);
  }
  addStyle();
  const prefix = `${show.source}/`;
  // Seeds: each card's centre, read from where pinhole painted it.
  const cards = new Map();
  const widths = [];
  for (const g of svg.querySelectorAll("[data-node-id]")) {
    const id = g.getAttribute("data-node-id");
    const r = g.querySelector("rect");
    if (!r || !id.startsWith(prefix)) continue;
    const x = +r.getAttribute("x");
    const y = +r.getAttribute("y");
    const w = +r.getAttribute("width");
    const h = +r.getAttribute("height");
    cards.set(id.slice(prefix.length), { x: x + w / 2, y: y + h / 2 });
    widths.push(w);
  }
  widths.sort((a, b) => a - b);
  const cardW = widths[widths.length >> 1] || 200;
  const boxEl = svg.querySelector(`rect[data-group-id="${CSS.escape(show.source)}"]`) || svg.querySelector("rect[data-group-id]");
  const mbox = boxEl
    ? { x: +boxEl.getAttribute("x"), y: +boxEl.getAttribute("y"), w: +boxEl.getAttribute("width"), h: +boxEl.getAttribute("height") }
    : { x: vbInit[0], y: vbInit[1], w: vbInit[2], h: vbInit[3] };
  // The source estate's box takes its cards' box's place and shape on the page.
  const scene = buildScene(show, { sourceAspect: mbox.w / Math.max(1, mbox.h) });
  const src = scene.sourceBox;
  // One dot pitch is a fixed share of a card's width, so a dot is legible exactly
  // when its card stops being: at the dot size a pitch is about 8 px, whatever
  // the estate's size. The source box sits centred on its cards' box.
  const pitch = cardW * 0.35;
  const origin = { x: mbox.x + (mbox.w - src.w * pitch) / 2, y: mbox.y + (mbox.h - src.h * pitch) / 2 };

  const canvas = document.createElement("canvas");
  canvas.id = "dots-canvas";
  host.prepend(canvas);
  host.classList.add("dots-on");
  const ui = document.createElement("div");
  ui.id = "dots-ui";
  host.appendChild(ui);

  const reducedQ = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  const n = show.roster.length;
  S = {
    name,
    host,
    svg,
    canvas,
    ui,
    ctx: canvas.getContext("2d"),
    scene,
    show,
    clock: replayClock(show),
    cards,
    cardW,
    pitch,
    origin,
    getVB,
    setVB,
    vbInit,
    zoomOut: 3,
    t: keep ? keep.t : 0,
    playing: keep ? keep.playing : false,
    speed: keep ? keep.speed : 1,
    reduced: !!(reducedQ && reducedQ.matches),
    dirty: true,
    lastWall: 0,
    raf: 0,
    off: [],
    disp: new Map(),
    boxDisp: new Map(),
    phase: new Map(),
    activity: new Map(),
    firsts: firstLandings(scene),
    addrs: show.roster.map((r) => r.address),
    idx: new Map(show.roster.map((r, i) => [r.address, i])),
    px: new Float32Array(n),
    py: new Float32Array(n),
    pvis: new Uint8Array(n),
    stats: { draw: [], frame: [] },
    snap: true,
    fly: null,
    hover: null,
    svgHidden: false,
    cardA: 1,
  };
  S.col = readColours();
  // The page's own UI face; a canvas cannot read var() in its font.
  S.font = (cssVar("--font-ui") || "system-ui, sans-serif").replace(/;$/, "");
  S.off.push(onThemeChange(() => {
    if (!S) return;
    S.col = readColours();
    S.dirty = true;
  }));
  if (reducedQ) {
    const onRM = () => {
      if (S) {
        S.reduced = reducedQ.matches;
        S.dirty = true;
      }
    };
    reducedQ.addEventListener("change", onRM);
    S.off.push(() => reducedQ.removeEventListener("change", onRM));
  }
  // The zoom goes out until the whole scene is a handful of discs.
  const ext = scene.extent;
  S.zoomOut = Math.max(3, (Math.max(ext.w, ext.h) * pitch * 40) / Math.max(1, vbInit[2]) / 8);
  buildUi();
  const onMove = (e) => hoverAt(e);
  host.addEventListener("mousemove", onMove);
  S.off.push(() => host.removeEventListener("mousemove", onMove));
  const params = new URLSearchParams(location.search);
  // Past a few hundred cards the fit is already below card size, so a large
  // source opens on its resources; the rail and the fit button still go to cards.
  if (!keep && !params.has("dotsAt") && show.roster.length > 300) flyNow("resources");
  if (params.has("dotsAt")) flyNow(params.get("dotsAt"));
  if (params.has("dotsT")) seek(Number(params.get("dotsT")) || 0);
  if (params.get("dotsPlay") === "1") play(true);
  if (params.has("dotsSpeed")) setSpeed(Number(params.get("dotsSpeed")) || 1);
  // A frame-exact step for recording frame sequences: advance the replay by ms and draw with that dt.
  const step = (ms) => {
    if (!S) return;
    S.playing = false;
    S.t = Math.min(S.clock.length, S.t + ms);
    draw(ms);
    S.dirty = false;
  };
  // Zoom to a viewBox width about the scene's centre, for screenshots of a morph halfway.
  const zoomTo = (w, onSource = false) => {
    const vb = S.getVB();
    const P = S.pitch;
    const ext = onSource ? S.scene.sourceBox : S.scene.extent;
    const cx = S.origin.x + (ext.w * P) / 2;
    const cy = S.origin.y + (ext.h * P) / 2;
    const h = (w * vb[3]) / vb[2];
    S.setVB([cx - w / 2, cy - h / 2, w, h]);
  };
  // The same, by the size a card would be on screen.
  const zoomCardPx = (px) => zoomTo((S.svg.getBoundingClientRect().width * S.cardW) / px, true);
  window.__dots = { seek, play, step, zoomTo, zoomCardPx, pause: () => play(false), fly, setSpeed, stats: () => S && S.stats, length: () => S && S.clock.length, marks: () => S && currentMarks(), state: () => S && { t: S.t, level: S.level, reduced: S.reduced, cardPx: S.cardPx, pitchPx: S.pitchPx } };
  const loop = (wall) => {
    if (!S) return;
    S.raf = requestAnimationFrame(loop);
    const dt = S.lastWall ? Math.min(100, wall - S.lastWall) : 16;
    S.lastWall = wall;
    if (S.fly) stepFly(wall);
    if (S.playing) {
      S.t = Math.min(S.clock.length, S.t + dt * S.speed);
      if (S.t >= S.clock.length) play(false);
      S.dirty = true;
    }
    if (!S.dirty && !S.settling) return;
    S.stats.frame.push(dt);
    const t0 = performance.now();
    draw(dt);
    S.stats.draw.push(performance.now() - t0);
    if (S.stats.draw.length > 4000) {
      S.stats.draw.splice(0, 2000);
      S.stats.frame.splice(0, 2000);
    }
    S.dirty = false;
  };
  S.raf = requestAnimationFrame(loop);
}

// --- playback --------------------------------------------------------------

function seek(t) {
  if (!S) return;
  S.t = Math.max(0, Math.min(S.clock.length, t));
  S.snap = true;
  S.dirty = true;
  syncUi();
}
function play(on) {
  if (!S) return;
  if (on && S.t >= S.clock.length) seek(0);
  S.playing = !!on;
  S.dirty = true;
  syncUi();
}
function setSpeed(v) {
  if (!S) return;
  S.speed = v;
  syncUi();
}

// --- camera ----------------------------------------------------------------

function camera() {
  const r = S.svg.getBoundingClientRect();
  const hr = S.host.getBoundingClientRect();
  const vb = S.getVB();
  const s = Math.min(r.width / vb[2], r.height / vb[3]);
  const ox = r.left - hr.left + S.host.scrollLeft + (r.width - vb[2] * s) / 2 - vb[0] * s;
  const oy = r.top - hr.top + S.host.scrollTop + (r.height - vb[3] * s) / 2 - vb[1] * s;
  return { s, ox, oy, r, vb, left: r.left - hr.left + S.host.scrollLeft, top: r.top - hr.top + S.host.scrollTop };
}

/** The pane's width not covered by the floating panel, and how much it covers. */
function band() {
  const r = S.svg.getBoundingClientRect();
  const pe = document.getElementById("panel");
  let left = 0;
  if (pe && !pe.classList.contains("collapsed") && getComputedStyle(pe).display !== "none") {
    const pr = pe.getBoundingClientRect();
    if (pr.width && pr.right > r.left && pr.left < r.left + r.width / 2) left = Math.min(r.width * 0.45, pr.right - r.left);
  }
  // The rail sits on the right edge; keep the scene clear of it too.
  const rail = S.ui && S.ui.querySelector(".dots-rail");
  const right = rail ? Math.min(r.width * 0.3, r.right - rail.getBoundingClientRect().left + 8) : 0;
  return { r, left, right, w: Math.max(1, r.width - left - right) };
}

function currentMarks() {
  const { r, w: bw } = band();
  let big = 0;
  let small = Infinity;
  // Every box the replay will draw: the ones on screen now and each estate's final one.
  const sizes = [];
  for (const b of S.scene.layoutAt(takeoffsBy(S.scene, S.t)).boxes.values()) if (b.members) sizes.push(Math.max(b.w, b.h));
  for (const [e, f] of S.scene.finalSize) if (e !== S.scene.source) sizes.push(Math.max(f.w, f.h));
  for (const v of sizes) {
    big = Math.max(big, v);
    small = Math.min(small, v);
  }
  const sorted = [...sizes].sort((a, b) => a - b);
  const typical = sorted.length ? sorted[sorted.length >> 1] : 0;
  const P = S.pitch;
  return railMarks({ paneW: bw, paneH: r.height || 1, cardW: S.cardW, sceneW: S.scene.extent.w * P, sceneH: S.scene.extent.h * P, smallestBox: Number.isFinite(small) ? small * P : 0, largestBox: big * P, typicalBox: typical * P });
}

/** Fly the camera to a rail mark, centred on the scene (or the cards for Cards). */
function fly(mark) {
  if (!S) return;
  const marks = currentMarks();
  const w = marks[mark];
  if (!w) return;
  const vb = S.getVB();
  const ext = S.scene.extent;
  const P = S.pitch;
  const cx = mark === "cards" ? Math.max(S.origin.x + w / 2, Math.min(vb[0] + vb[2] / 2, S.origin.x + S.scene.sourceBox.w * P - w / 2)) : S.origin.x + (ext.w * P) / 2;
  const cy = mark === "cards" ? Math.max(S.origin.y + (w * vb[3]) / vb[2] / 2, Math.min(vb[1] + vb[3] / 2, S.origin.y + S.scene.sourceBox.h * P)) : S.origin.y + (ext.h * P) / 2;
  // Centre in the part of the pane the floating panel leaves uncovered.
  const { r, left, right, w: bw } = band();
  const ww = mark === "cards" ? w : (w * r.width) / bw;
  const shift = (((left - right) / 2) * ww) / Math.max(1, r.width);
  const to = [cx - ww / 2 - shift, cy - (ww * vb[3]) / vb[2] / 2, ww, (ww * vb[3]) / vb[2]];
  if (S.reduced) {
    S.setVB(to);
    return;
  }
  S.fly = { from: vb.slice(), to, start: performance.now(), dur: 900 };
}

function flyNow(mark) {
  fly(mark);
  if (S && S.fly) {
    S.setVB(S.fly.to);
    S.fly = null;
  }
}

function stepFly(wall) {
  const f = S.fly;
  const u = easeInOut((wall - f.start) / f.dur);
  // Width interpolates in log space so the zoom feels even; the centre linearly.
  const w = Math.exp(lerp(Math.log(f.from[2]), Math.log(f.to[2]), u));
  const h = (w * f.from[3]) / f.from[2];
  const cx = lerp(f.from[0] + f.from[2] / 2, f.to[0] + f.to[2] / 2, u);
  const cy = lerp(f.from[1] + f.from[3] / 2, f.to[1] + f.to[3] / 2, u);
  S.setVB([cx - w / 2, cy - h / 2, w, h]);
  if (u >= 1) S.fly = null;
}

// --- UI ----------------------------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function buildUi() {
  const ui = S.ui;
  const rail = el("div", "dots-rail");
  rail.setAttribute("role", "group");
  rail.setAttribute("aria-label", "Zoom levels");
  rail.appendChild(el("div", "dots-rail-track"));
  S.railCam = el("div", "dots-rail-cam");
  rail.appendChild(S.railCam);
  S.railMarks = {};
  for (const [k, label, pos] of [["cards", "Cards", 0], ["resources", "Resources", 0.5], ["estates", "Estates", 1]]) {
    const b = el("button", "dots-rail-mark");
    b.type = "button";
    b.style.top = `calc(8px + ${pos} * (100% - 16px))`;
    const txt = el("span");
    txt.append(el("b", "", label), el("small", "", ""));
    b.append(txt, el("i"));
    b.title = `Fly to ${label.toLowerCase()}`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      fly(k);
    });
    b.addEventListener("mousedown", (e) => e.stopPropagation());
    rail.appendChild(b);
    S.railMarks[k] = b;
  }
  ui.appendChild(rail);
  const bottom = el("div", "dots-bottom");
  S.capEl = el("div", "dots-caption");
  S.capEl.setAttribute("aria-live", "polite");
  bottom.appendChild(S.capEl);
  ui.appendChild(bottom);
  const bar = el("div", "dots-bar");
  bar.addEventListener("mousedown", (e) => e.stopPropagation());
  S.playBtn = el("button", "", "Play");
  S.playBtn.type = "button";
  S.playBtn.addEventListener("click", () => play(!S.playing));
  S.speedSel = el("select");
  S.speedSel.setAttribute("aria-label", "Replay speed");
  for (const v of [0.5, 1, 2, 4]) {
    const o = el("option", "", `${v}×`);
    o.value = String(v);
    S.speedSel.appendChild(o);
  }
  S.speedSel.addEventListener("change", () => setSpeed(Number(S.speedSel.value)));
  S.range = el("input");
  S.range.type = "range";
  S.range.min = "0";
  S.range.max = String(Math.round(S.clock.length));
  S.range.step = "10";
  S.range.setAttribute("aria-label", "Replay position");
  S.range.addEventListener("input", () => seek(Number(S.range.value)));
  S.timeEl = el("span", "dots-time");
  bar.append(S.playBtn, S.speedSel, S.range, S.timeEl);
  bottom.appendChild(bar);
  S.tip = el("div", "dots-tip");
  ui.appendChild(S.tip);
  syncUi();
}

const fmt = (n) => n.toLocaleString("en-US");

function syncUi() {
  if (!S || !S.playBtn) return;
  S.playBtn.textContent = S.playing ? "Pause" : S.t >= S.clock.length ? "Replay" : "Play";
  S.speedSel.value = String(S.speed);
  S.range.value = String(Math.round(S.t));
}

function shortName(e) {
  const src = S.scene.source;
  return e !== src && e.startsWith(`${src}-`) ? e.slice(src.length + 1) : e;
}

function updateUiFrame(counts, level) {
  const sc = S.scene;
  const moves = sc.flights.filter((f) => !f.parent);
  const done = moves.filter((f) => f.end <= S.t);
  const refused = done.filter((f) => !f.ok).length;
  const estatesNow = [...counts.values()].filter((c) => c > 0).length;
  let label = `move ${fmt(done.length)} of ${fmt(moves.length)}`;
  if (moves.some((f) => !f.ok)) label += ` · ${refused} refused`;
  if (S.show.kind === "walkthrough") {
    const p = phaseAt(S.show, S.show.t0 + (S.t / S.clock.length) * (S.show.t1 - S.show.t0));
    label = `${p ? p.id : "stock"} · ${label}`;
  }
  if (S.timeEl.textContent !== label) S.timeEl.textContent = label;
  if (S.playing && Math.abs(Number(S.range.value) - S.t) > 100) S.range.value = String(Math.round(S.t));
  const marks = currentMarks();
  const sub = { cards: `${fmt(S.show.roster.length)} cards`, resources: `${fmt(S.show.roster.length)} resources`, estates: `${estatesNow} estate${estatesNow === 1 ? "" : "s"}` };
  for (const k of Object.keys(S.railMarks)) {
    const sm = S.railMarks[k].querySelector("small");
    if (sm.textContent !== sub[k]) sm.textContent = sub[k];
  }
  const b = band();
  const pos = railPos((S.getVB()[2] * b.w) / Math.max(1, b.r.width), marks);
  S.railCam.style.top = `calc(8px + ${pos.toFixed(4)} * (100% - 16px))`;
  const capText = caption(level);
  if (S.capEl.textContent !== capText) S.capEl.textContent = capText;
}

function hoverAt(e) {
  if (!S) return;
  const hr = S.host.getBoundingClientRect();
  const x = e.clientX - hr.left + S.host.scrollLeft;
  const y = e.clientY - hr.top + S.host.scrollTop;
  if (S.cardA > 0.5) {
    S.tip.style.display = "none";
    return;
  }
  let best = -1;
  let bd = 100;
  for (let i = 0; i < S.addrs.length; i++) {
    if (!S.pvis[i]) continue;
    const d = (S.px[i] - x) ** 2 + (S.py[i] - y) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  if (best < 0) {
    S.tip.style.display = "none";
    return;
  }
  const a = S.addrs[best];
  S.tip.textContent = `${a} · ${shortName(S.ownersNow.get(a) ?? S.scene.source)}`;
  S.tip.style.display = "block";
  S.tip.style.left = `${Math.min(x + 12, S.host.clientWidth - S.tip.offsetWidth - 4)}px`;
  S.tip.style.top = `${y + 14}px`;
}

// --- drawing -----------------------------------------------------------------

/** Flights near `t`: in the air, or landed within the ripple, or refused (they stay lit). */
function flightsNear(t) {
  const fl = S.scene.flights;
  let lo = 0;
  let hi = fl.length;
  const from = t - 1100 - RIPPLE_MS - 50;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (fl[m].start < from) lo = m + 1;
    else hi = m;
  }
  const out = [];
  for (let i = lo; i < fl.length && fl[i].start <= t; i++) out.push(fl[i]);
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, rr);
  else ctx.rect(x, y, w, h);
}

function polyline(ctx, pts) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function draw(dt) {
  const { ctx, canvas, scene, pitch: P, origin: O, col } = S;
  const cam = camera();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(cam.r.width);
  const H = Math.round(cam.r.height);
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
  }
  canvas.style.left = `${cam.left}px`;
  canvas.style.top = `${cam.top}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const s = cam.s;
  // Scene pitch units -> canvas px.
  const sx = (u) => (O.x + u * P) * s + cam.ox - cam.left;
  const sy = (u) => (O.y + u * P) * s + cam.oy - cam.top;
  // viewBox units -> canvas px (the cards' centres).
  const vx = (x) => x * s + cam.ox - cam.left;
  const vy = (y) => y * s + cam.oy - cam.top;

  const t = S.t;
  const reduced = S.reduced;
  const tc = cardMorph(S.cardW * s, { reduced });
  S.cardPx = S.cardW * s;
  S.pitchPx = P * s;
  S.cardA = 1 - tc;
  // Cards fade faster than the dots grow, so the dots under them read by the middle of the morph.
  const cardA = Math.pow(1 - tc, 2).toFixed(3);
  if (S.host.style.getPropertyValue("--dots-card-a") !== cardA) S.host.style.setProperty("--dots-card-a", cardA);
  const hide = tc >= 1;
  if (hide !== S.svgHidden) {
    S.svg.style.visibility = hide ? "hidden" : "";
    S.svgHidden = hide;
  }

  const k = takeoffsBy(scene, t);
  const L = scene.layoutAt(k);
  const near = flightsNear(t);
  const inAir = new Map();
  for (const f of near) if (t < f.end) inAir.set(f.address, f);
  const owners = new Map(scene.show.owners0);
  for (const f of scene.landing) if (f.end <= t) owners.set(f.address, f.to);
  S.ownersNow = owners;
  // A dot counts where it is until it lands.
  const counts = new Map();
  for (const e of owners.values()) counts.set(e, (counts.get(e) ?? 0) + 1);

  // Smoothing toward the layout: boxes and resting dots slide when a box re-packs.
  const ease = S.snap || reduced ? 1 : 1 - Math.exp(-dt / 140);
  let moving = false;
  const boxes = new Map();
  for (const [e, b] of L.boxes) {
    const prev = S.boxDisp.get(e);
    const cur = prev && !S.snap ? { x: lerp(prev.x, b.x, ease), y: lerp(prev.y, b.y, ease), w: lerp(prev.w, b.w, ease), h: lerp(prev.h, b.h, ease) } : { ...b };
    if (prev && Math.abs(cur.h - b.h) + Math.abs(cur.y - b.y) + Math.abs(cur.w - b.w) > 0.01) moving = true;
    S.boxDisp.set(e, cur);
    boxes.set(e, cur);
  }
  for (const e of [...S.boxDisp.keys()]) if (!L.boxes.has(e)) S.boxDisp.delete(e);

  // Per-estate disc morph from the box's size on screen.
  const td = new Map();
  // A new estate's form is judged by the box it is growing into, so it does not
  // flip from disc to dots as its first dots land.
  for (const [e, b] of boxes) {
    const fin = e === scene.source ? null : scene.finalSize.get(e);
    const size = Math.max(b.w, b.h, fin ? Math.max(fin.w, fin.h) : 0);
    td.set(e, discMorph(size * P * s, { reduced }));
  }
  const level = levelOf(tc, td.values());
  S.level = level;
  const dotLayerA = tc;

  // Activity per estate: dots in the air toward it (or leaving it), for the running light.
  const act = new Map();
  for (const f of inAir.values()) {
    if (!f.ok) continue;
    act.set(f.to, (act.get(f.to) ?? 0) + 1);
    act.set(f.from, (act.get(f.from) ?? 0) - 1);
  }

  const boxPx = (b) => ({ x: sx(b.x), y: sy(b.y), w: b.w * P * s, h: b.h * P * s });
  const centre = (e) => {
    const b = boxes.get(e);
    return b ? { x: b.x + b.w / 2, y: b.y + (BOX.title + b.h) / 2 } : { x: 0, y: 0 };
  };
  const rDot = Math.max(1.2, Math.min(6, P * s * 0.36));
  const firsts = S.firsts;

  // Labels claim their space first come, first served; one that would overlap is left out.
  const taken = [];
  const claim = (x, y, w, h) => {
    for (const q of taken) if (x < q.x + q.w && x + w > q.x && y < q.y + q.h && y + h > q.y) return false;
    taken.push({ x, y, w, h });
    return true;
  };
  // Discs hold their ground before any label is placed.
  for (const [e] of boxes) {
    const tdE = td.get(e) ?? 0;
    const cnt = counts.get(e) ?? 0;
    if (tdE < 0.5 || !cnt) continue;
    const d = centre(e);
    const r = Math.max(2.5, discRadius(cnt, P) * s);
    taken.push({ x: sx(d.x) - r, y: sy(d.y) - r, w: 2 * r, h: 2 * r, disc: e });
  }
  // --- boxes: fill, outline, the lights on their borders ---
  const titlePx = BOX.title * P * s;
  for (const [e, b] of boxes) {
    const a = dotLayerA * (1 - (td.get(e) ?? 0));
    if (a <= 0.01) continue;
    const c = col.estate.get(e) || col.neutral;
    const bp = boxPx(b);
    const first = firsts.get(e);
    // The draw-in: from the moment before its first landing, a head traces the outline.
    let drawIn = 1;
    if (e !== scene.source && first !== undefined) drawIn = Math.max(0, Math.min(1, (t - (first - DRAW_MS)) / DRAW_MS));
    if (e !== scene.source && first !== undefined && t < first - DRAW_MS) continue;
    ctx.globalAlpha = a * (0.35 + 0.65 * drawIn);
    roundRect(ctx, bp.x, bp.y, bp.w, bp.h, Math.min(16, 1.2 * P * s));
    ctx.fillStyle = rgba(col.surface, 0.55);
    ctx.fill();
    const P0 = perimeter(bp);
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = rgba(c, 0.6);
    if (drawIn >= 1 || reduced) {
      ctx.stroke();
    } else {
      // From the border point nearest the first dot's slot, clockwise.
      const anyLanding = scene.landing.find((f) => f.to === e);
      const slot = anyLanding && L.slots.get(anyLanding.address);
      const s0 = slot ? nearestS(bp, { x: sx(slot.x), y: sy(slot.y) }) : 0;
      ctx.strokeStyle = c;
      polyline(ctx, segment(bp, s0, P0 * drawIn));
      const head = pointAt(bp, s0 + P0 * drawIn);
      ctx.fillStyle = col.fg;
      ctx.beginPath();
      ctx.arc(head.x, head.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // The running light: speed follows the dots in the air; the source runs the other way.
    if (!reduced && drawIn >= 1) {
      const target = Math.min(12, Math.abs(act.get(e) ?? 0));
      const cur = S.snap ? target : lerp(S.activity.get(e) ?? 0, target, 1 - Math.exp(-dt / 400));
      S.activity.set(e, cur);
      if (cur > 0.05) {
        moving = true;
        // Clockwise while receiving; the other way while giving dots up.
        const dir = (act.get(e) ?? 0) < 0 || (e === scene.source && (act.get(e) ?? 0) === 0) ? -1 : 1;
        const speed = (0.08 + 0.05 * cur) * P0; // perimeter fractions per second
        const ph = (S.phase.get(e) ?? 0) + (dir * speed * dt) / 1000;
        S.phase.set(e, ph);
        ctx.strokeStyle = col.pending;
        ctx.lineWidth = 2.4;
        ctx.globalAlpha = a * Math.min(1, cur);
        const len = Math.min(P0 * 0.09, 120);
        for (const off of [0, P0 / 2]) polyline(ctx, segment(bp, ph + off, -dir * len));
      }
    }
    // Labels: the name, then the live count. Inside the title row when the row
    // and the box have room, else just above the outline (it may run past a
    // narrow box's edge), so a label never sits on the dots.
    const fs = 11.5;
    if (tc > 0.6 && (td.get(e) ?? 0) < 0.5) {
      ctx.font = `700 ${fs}px ${S.font}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const nm = shortName(e);
      const cnt = fmt(Math.max(0, counts.get(e) ?? 0));
      const nw = ctx.measureText(nm).width;
      const tw = nw + fs * 0.5 + ctx.measureText(cnt).width;
      const inside = titlePx >= fs * 1.5 && tw + fs * 1.6 <= bp.w;
      const lx = bp.x + (inside ? fs * 0.8 : 1);
      let ly = inside ? bp.y + titlePx * 0.55 : bp.y - fs * 0.75;
      let ok = claim(lx, ly - fs * 0.6, tw, fs * 1.2);
      // No room above: try just below the outline.
      if (!ok && !inside) {
        ly = bp.y + bp.h + fs * 0.8;
        ok = claim(lx, ly - fs * 0.6, tw, fs * 1.2);
      }
      if (ok) {
        ctx.globalAlpha = a * drawIn;
        ctx.fillStyle = c;
        ctx.fillText(nm, lx, ly);
        ctx.fillStyle = col.muted;
        ctx.fillText(cnt, lx + nw + fs * 0.5, ly);
      }
    }
  }
  ctx.globalAlpha = 1;

  // --- threads between estates (cross-estate reads), dashes marching reader -> source ---
  const tShow = S.show.t0 + (t / S.clock.length) * (S.show.t1 - S.show.t0);
  const threadsOn = S.show.threads.length && S.show.events.some((ev) => ev.kind === "handoff" && ev.start <= tShow);
  if (threadsOn) {
    ctx.lineWidth = 1.2;
    for (const th of S.show.threads) {
      if (!boxes.has(th.from) || !boxes.has(th.to)) continue;
      const a = centre(th.to);
      const b = centre(th.from);
      ctx.globalAlpha = 0.55 * Math.max(dotLayerA, 0.5);
      ctx.strokeStyle = col.runtime;
      ctx.setLineDash([6, 6]);
      ctx.lineDashOffset = reduced ? 0 : -((performance.now() / 40) % 12);
      ctx.beginPath();
      ctx.moveTo(sx(a.x), sy(a.y));
      ctx.lineTo(sx(b.x), sy(b.y));
      ctx.stroke();
      ctx.setLineDash([]);
      if (!reduced) moving = true;
    }
    // A hand-off: one bright pulse from the source (wave 1) along each thread to its reader (wave 2).
    for (const ev of S.show.events) {
      if (ev.kind !== "handoff" || tShow < ev.start || tShow > ev.t + (ev.t - ev.start)) continue;
      const u = Math.min(1, (tShow - ev.start) / Math.max(1, ev.t - ev.start));
      const a = centre(ev.from);
      const b = centre(ev.to);
      const x = sx(lerp(a.x, b.x, u));
      const y = sy(lerp(a.y, b.y, u));
      ctx.globalAlpha = 1 - Math.max(0, u - 0.85) / 0.15;
      ctx.fillStyle = col.runtime;
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // --- dots ---
  const addrs = S.addrs;
  const discAt = (e) => centre(e);
  const slotOf = (Lx, a) => Lx.slots.get(a);
  const lit = new Map(); // estate -> resources lit now (for a disc's brightness)
  const markLit = (e) => lit.set(e, (lit.get(e) ?? 0) + 1);
  const events = S.show.events;
  const glow = new Map(); // address -> {colour, a}
  const rings = new Set();
  for (const ev of events) {
    if (!ev.address || ev.start > tShow) continue;
    if (ev.kind === "adopt") rings.add(ev.address);
    if ((ev.kind === "read" || ev.kind === "planned") && tShow <= ev.t + LINGER_MS) {
      const u = Math.min(1, (tShow - ev.start) / 300);
      const fade = tShow > ev.t ? 1 - (tShow - ev.t) / LINGER_MS : 1;
      const prev = glow.get(ev.address);
      const g = { colour: ev.kind === "planned" ? col.foreign : col.runtime, a: (ev.kind === "planned" ? 0.9 : 0.45) * u * fade };
      if (!prev || g.a > prev.a) glow.set(ev.address, g);
    }
  }
  ctx.globalAlpha = 1;
  const refusedLit = [];
  for (let i = 0; i < addrs.length; i++) {
    const a = addrs[i];
    const f = inAir.get(a);
    const owner = owners.get(a) ?? scene.source;
    let p;
    let colour = col.estate.get(owner) || col.neutral;
    let alpha = 1;
    let est = owner;
    if (f && f.ok && !reduced) {
      const Lb = scene.layoutAt(f.k - 1);
      const La = scene.layoutAt(f.k);
      const from = slotOf(Lb, a) ?? slotOf(L, a);
      const to = slotOf(La, a) ?? from;
      const u = (t - f.start) / (f.end - f.start);
      if (f.parent && inAir.get(f.parent)) {
        // A child keeps orbiting its parent along the parent's arc.
        const pf = inAir.get(f.parent);
        const pFrom = slotOf(scene.layoutAt(pf.k - 1), f.parent) ?? from;
        const pTo = slotOf(scene.layoutAt(pf.k), f.parent) ?? to;
        const pu = (t - pf.start) / (pf.end - pf.start);
        const pp = flightPoint(pFrom, pTo, pu);
        const e = easeInOut(u);
        const ox = lerp(from.x - pFrom.x, to.x - pTo.x, e);
        const oy = lerp(from.y - pFrom.y, to.y - pTo.y, e);
        const th = Math.sin(Math.PI * e) * Math.PI * 0.9;
        p = { x: pp.x + ox * Math.cos(th) - oy * Math.sin(th), y: pp.y + ox * Math.sin(th) + oy * Math.cos(th) };
      } else p = flightPoint(from, to, u);
      colour = u < 0.5 ? col.estate.get(f.from) || col.neutral : col.estate.get(f.to) || col.neutral;
      est = u < 0.5 ? f.from : f.to;
      // The trail: where it was a moment ago, fading, in the destination's colour.
      if (dotLayerA > 0.05 && !f.parent) {
        ctx.strokeStyle = col.estate.get(f.to) || col.neutral;
        ctx.lineCap = "round";
        let prev = p;
        for (let j = 1; j <= 4; j++) {
          const q = flightPoint(from, to, Math.max(0, u - j * 0.025));
          ctx.globalAlpha = dotLayerA * (1 - j / 5) * 0.7;
          ctx.lineWidth = rDot * (1.4 - j * 0.2);
          ctx.beginPath();
          ctx.moveTo(sx(prev.x), sy(prev.y));
          ctx.lineTo(sx(q.x), sy(q.y));
          ctx.stroke();
          prev = q;
        }
        ctx.lineCap = "butt";
      }
      moving = true;
    } else if (f && f.ok && reduced) {
      // No flight: out of the old slot, into the new one.
      const u = (t - f.start) / (f.end - f.start);
      const from = slotOf(scene.layoutAt(f.k - 1), a) ?? slotOf(L, a);
      const to = slotOf(scene.layoutAt(f.k), a) ?? from;
      p = u < 0.5 ? from : to;
      alpha = u < 0.5 ? 1 - u * 2 : (u - 0.5) * 2;
      colour = col.estate.get(u < 0.5 ? f.from : f.to) || col.neutral;
    } else if (f && !f.ok && !reduced) {
      const here = slotOf(L, a);
      const there = boxes.get(f.to) ? centre(f.to) : here;
      p = flightPoint(here, there, (t - f.start) / (f.end - f.start), { ok: false });
      moving = true;
    } else {
      const target = slotOf(L, a);
      if (!target) continue;
      const prev = S.disp.get(a);
      if (prev && !S.snap && ease < 1) {
        const nx = lerp(prev.x, target.x, ease);
        const ny = lerp(prev.y, target.y, ease);
        if (Math.abs(nx - target.x) + Math.abs(ny - target.y) > 0.01) moving = true;
        p = { x: nx, y: ny };
      } else p = target;
    }
    S.disp.set(a, p);
    const tdE = td.get(est) ?? 0;
    // Card centre -> slot -> disc, by the zoom.
    const card = S.cards.get(a);
    const d = discAt(est);
    const slotPx = { x: sx(p.x), y: sy(p.y) };
    const cardPx = card ? { x: vx(card.x), y: vy(card.y) } : slotPx;
    const discPx = { x: sx(d.x), y: sy(d.y) };
    const q = {
      x: lerp(lerp(cardPx.x, slotPx.x, tc), discPx.x, tdE),
      y: lerp(lerp(cardPx.y, slotPx.y, tc), discPx.y, tdE),
    };
    const vis = tdE > 0.97 ? 0 : dotLayerA * (1 - tdE) * alpha;
    S.px[i] = q.x;
    S.py[i] = q.y;
    S.pvis[i] = vis > 0.2 ? 1 : 0;
    if (q.x < -20 || q.y < -20 || q.x > W + 20 || q.y > H + 20) continue;
    const g = glow.get(a);
    if (f || g) markLit(est);
    if (vis <= 0.01) continue;
    if (g) {
      ctx.globalAlpha = vis * g.a * 0.6;
      ctx.fillStyle = g.colour;
      ctx.beginPath();
      ctx.arc(q.x, q.y, rDot * 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    const flying = f && f.ok && !reduced;
    if (flying) {
      // A dot in the air is lifted: larger, with a soft halo in the colour it is turning.
      ctx.globalAlpha = vis * 0.25;
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(q.x, q.y, rDot * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = vis;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(q.x, q.y, flying ? rDot * 1.6 : rDot, 0, Math.PI * 2);
    ctx.fill();
    if (rings.has(a)) {
      ctx.strokeStyle = col.managed;
      ctx.lineWidth = Math.max(1, rDot * 0.35);
      ctx.beginPath();
      ctx.arc(q.x, q.y, rDot * 1.7, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Takeoff: a ring in the in-progress colour while the write starts.
    if (f && f.ok && !reduced) {
      const u = (t - f.start) / (f.end - f.start);
      if (u < 0.2) {
        ctx.strokeStyle = col.pending;
        ctx.globalAlpha = vis * (1 - u / 0.2);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(q.x, q.y, rDot * (1.6 + u * 4), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
  // Landings: a small pulse at the dot and a ripple along the nearest border.
  for (const f of near) {
    if (t < f.end || t > f.end + RIPPLE_MS) continue;
    const u = (t - f.end) / RIPPLE_MS;
    const i = S.idx.get(f.address);
    if (f.ok) {
      const tdE = td.get(f.to) ?? 0;
      const a = dotLayerA * (1 - tdE);
      if (a < 0.02) continue;
      const qx = S.px[i];
      const qy = S.py[i];
      if (u < PULSE_MS / RIPPLE_MS && !f.parent) {
        ctx.strokeStyle = col.estate.get(f.to) || col.neutral;
        ctx.globalAlpha = a * (1 - u);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(qx, qy, rDot * (1.2 + u * 5), 0, Math.PI * 2);
        ctx.stroke();
      }
      const b = boxes.get(f.to);
      if (b && !f.parent && !reduced) {
        const bp = boxPx(b);
        const s0 = nearestS(bp, { x: qx, y: qy });
        const len = Math.min(perimeter(bp) * 0.12, 90) * Math.sqrt(u);
        ctx.strokeStyle = col.estate.get(f.to) || col.neutral;
        ctx.lineWidth = 2.2;
        ctx.globalAlpha = a * (1 - u) * 0.9;
        polyline(ctx, segment(bp, s0, len));
        polyline(ctx, segment(bp, s0, -len));
      }
      moving = true;
    }
  }
  // Refused moves stay lit: a red flare at the dot and a red segment on its box's border.
  for (const f of scene.flights) {
    if (f.ok || f.end > t) continue;
    const i = S.idx.get(f.address);
    if (i < 0 || !S.pvis[i]) continue;
    refusedLit.push(f);
    const qx = S.px[i];
    const qy = S.py[i];
    const u = Math.min(1, (t - f.end) / PULSE_MS);
    ctx.globalAlpha = dotLayerA * (0.35 + 0.4 * (1 - u));
    ctx.fillStyle = col.degraded;
    ctx.beginPath();
    ctx.arc(qx, qy, rDot * (2.2 + 1.5 * (1 - u)), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = dotLayerA;
    ctx.beginPath();
    ctx.arc(qx, qy, rDot, 0, Math.PI * 2);
    ctx.fill();
    const b = boxes.get(owners.get(f.address) ?? scene.source);
    if (b) {
      const bp = boxPx(b);
      const s0 = nearestS(bp, { x: qx, y: qy });
      ctx.strokeStyle = col.degraded;
      ctx.lineWidth = 2.4;
      ctx.globalAlpha = dotLayerA * (1 - (td.get(owners.get(f.address)) ?? 0)) * 0.9;
      polyline(ctx, segment(bp, s0 - 6, 12));
    }
  }

  // --- discs ---
  for (const [e, b] of boxes) {
    const tdE = td.get(e) ?? 0;
    const a = tdE * Math.max(dotLayerA, 0);
    const cnt = Math.max(0, counts.get(e) ?? 0);
    if (a <= 0.01 || cnt === 0) continue;
    const c = col.estate.get(e) || col.neutral;
    const d = centre(e);
    const x = sx(d.x);
    const y = sy(d.y);
    const r = Math.max(2.5, discRadius(cnt, P) * s);
    const share = Math.min(1, (lit.get(e) ?? 0) / Math.max(1, cnt));
    ctx.globalAlpha = a * (0.45 + 0.5 * Math.min(1, share * 6));
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (share > 0) {
      ctx.globalAlpha = a * Math.min(0.6, share * 4);
      ctx.strokeStyle = col.pending;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    const fs = 10.5;
    if (tdE >= 0.5) {
      ctx.globalAlpha = a;
      ctx.font = `600 ${fs}px ${S.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const lw = Math.max(ctx.measureText(shortName(e)).width, ctx.measureText(fmt(cnt)).width);
      // Big enough to carry its own label, at a size that fits inside it.
      const fin = Math.min(fs, (fs * r * 1.85) / Math.max(1, lw));
      if (fin >= 8 && r >= fin * 1.3) {
        ctx.font = `600 ${fin}px ${S.font}`;
        ctx.textBaseline = "middle";
        ctx.fillStyle = col.fg;
        ctx.fillText(shortName(e), x, y - fin * 0.55);
        ctx.globalAlpha = a * 0.75;
        ctx.fillText(fmt(cnt), x, y + fin * 0.65);
      } else {
        // Below it, unless that would sit on another disc or label.
        const mine = taken.findIndex((q) => q.disc === e);
        const saved = mine >= 0 ? taken.splice(mine, 1)[0] : null;
        if (claim(x - lw / 2, y + r + 3, lw, fs * 2 + 3)) {
          ctx.fillStyle = col.fg;
          ctx.fillText(shortName(e), x, y + r + 3);
          ctx.fillStyle = col.muted;
          ctx.fillText(fmt(cnt), x, y + r + 4 + fs);
        }
        if (saved) taken.push(saved);
      }
    }
  }
  // At the disc level a move is a comet from one disc to the other.
  for (const f of inAir.values()) {
    if (!f.ok || f.parent || reduced) continue;
    const a = Math.min(td.get(f.from) ?? 0, td.get(f.to) ?? 0) * dotLayerA;
    if (a < 0.05) continue;
    const u = easeInOut((t - f.start) / (f.end - f.start));
    const A = centre(f.from);
    const B = centre(f.to);
    const pt = (v) => flightPoint(A, B, v);
    const head = pt(u);
    ctx.strokeStyle = col.estate.get(f.to) || col.neutral;
    ctx.lineCap = "round";
    let prev = head;
    for (let j = 1; j <= 5; j++) {
      const q = pt(Math.max(0, u - j * 0.05));
      ctx.globalAlpha = a * (1 - j / 6);
      ctx.lineWidth = 3 - j * 0.4;
      ctx.beginPath();
      ctx.moveTo(sx(prev.x), sy(prev.y));
      ctx.lineTo(sx(q.x), sy(q.y));
      ctx.stroke();
      prev = q;
    }
    ctx.lineCap = "butt";
    ctx.globalAlpha = a;
    ctx.fillStyle = col.fg;
    ctx.beginPath();
    ctx.arc(sx(head.x), sy(head.y), 2.2, 0, Math.PI * 2);
    ctx.fill();
    moving = true;
  }
  ctx.globalAlpha = 1;
  S.snap = false;
  S.settling = moving;
  updateUiFrame(counts, level);
}
