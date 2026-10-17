// The dots layer (#712, #715): the zoom past the cards, where each resource
// is a dot in its estate's box and each estate, further out, a disc. It is
// mounted by two drivers and nothing else:
//
// - live (#715): the estate has choudoufu roots or estate rosters, and
//   /api/terragucci/carve answers its rosters and migration progress
//   (web/dots-live.js). The layer polls that route and plays each line as it
//   arrives. In the kiosk's frame it also directs the camera while a
//   migration runs and tells the kiosk what to say (web/kiosk-carve.js).
// - a recording: the local preview server's meta carries `dots`
//   (scripts/dots-preview.ts), or the static carve export hands one in
//   (web/carve-export.js).
//
// With neither, every export here is a no-op and the app behaves as it always
// has.
//
// Cards stay in pinhole's SVG. Dots, estate boxes and discs are drawn on one
// Canvas 2D layer under it, through the same viewBox camera. Each mark picks
// its form from its size on screen (web/dots-lod.js), and the morph follows
// the zoom. The replay plays a real recording (web/dots-recording.js) through
// the choreography in web/dots-scene.js.

import { readCarve, carveShow, walkthroughShow, phaseAt } from "./dots-recording.js";
import { parentsOf } from "./dots-layout.js";
import { buildScene, takeoffsBy, firstLandings, flightPoint, easeInOut, replayClock, BOX } from "./dots-scene.js";
import { cardMorph, discMorph, discRadius, levelOf, caption, railMarks, railPos, lerp, LOD } from "./dots-lod.js";
import { perimeter, pointAt, nearestS, segment } from "./dots-border.js";
import { getTokens, onThemeChange, contrast, hexToOklch, oklchToHex } from "./theme.js";
import { LOOP, carveStory, beatAt, tipsBetween, directorFocus, shortName as shortOf, liveBeat, liveTipsBetween, liveEndTip, LIVE_HOLD_MS } from "./dots-kiosk.js";
import { liveShow, stampArrivals, showKey, currentMigration, boxName, playedCounts, landedWrite } from "./dots-live.js";
import { provenanceText, migrationTool, stepMsFor } from "./tour-player.js";
import { tourNow, tourFocus, tourFx, fxKey, tourMessage } from "./dots-tour.js";
import { wallTicks, recordedLabel, recordedMarks, speedWords, skippedWords, clockWords, RECORDED_SPEEDS } from "./dots-timeline.js";
import { cardLabel, cardShape, cardText, cardTextAlpha, pickMark, cardsMark, cardsFrame, cardsEstate, middleCard, gridScale, gridSlots, cardSize, cardNeed, rosterLod, unitKeyOf, minViewWidth, tipSpot, CARD_TEXT } from "./dots-cards.js";

/** #715: how often the live layer asks for the carve. The route shares one read for 1.5 s while a migration runs. */
export const LIVE_POLL_MS = 2_000;
/** The live carve as last read, kept across a remount (a graph re-render), so arrivals keep their times. */
let liveMemo = null;
/** Slowed playback (the kiosk's "slowed ×N"): 1 is real time, the default; kept across a remount, never stored. */
let liveSlowed = 1;

let S = null;
let styleAdded = false;

const RIPPLE_MS = 650;
const PULSE_MS = 520;
const DRAW_MS = 650;
const LINGER_MS = 2600;
/** A viewer's hand on the camera (a wheel, a pinch, a drag, a rail mark) holds the director and the tour off until this long after their last input. */
export const VIEWER_HOLD_MS = 8_000;

export function dotsActive() {
  return !!S;
}

/** How far past the fit the zoom may go out, as a multiple of the fit's width; null when not mounted. */
export function dotsZoomOutFactor() {
  return S ? S.zoomOut : null;
}

/**
 * How far in the zoom may go, as the narrowest viewBox width: a little past where the roster's cards are fully drawn,
 * while the canvas draws them; null otherwise (the app's own limit holds).
 */
export function dotsMinViewWidth() {
  if (!S || !S.own) return null;
  return minViewWidth(paneRect().width, S.rc.w, S.need);
}

/** #715: whether the live carve's director holds the camera (a migration is running in the kiosk's frame). */
export function dotsCarving() {
  return !!(S && S.live && S.carving);
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
  if (S.svg) {
    S.svg.style.visibility = "";
    S.svg.style.display = "";
  }
  S = null;
}

function addStyle() {
  if (styleAdded) return;
  styleAdded = true;
  const st = document.createElement("style");
  st.textContent = `
  .dots-on > svg { position: relative; z-index: 1; background: transparent; }
  /* Once the cards are out of the paint a touch lands on the host: a pinch there is the camera's, never the page's zoom. */
  .dots-on { touch-action: none; }
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
  .dots-rail-mark small { display: block; color: var(--muted); font-size: 11.5px; }
  .dots-rail-mark i { width: 11px; height: 11px; border-radius: 50%; border: 2px solid var(--muted); background: var(--bg); flex: none; margin-right: 4px; }
  .dots-rail-mark:hover i, .dots-rail-mark:focus-visible i { border-color: var(--focus); }
  .dots-rail-mark:disabled { cursor: default; color: var(--muted); }
  .dots-rail-mark:disabled:hover i { border-color: var(--muted); }
  .dots-bottom { position: absolute; left: 50%; transform: translateX(-50%); bottom: 12px; display: flex; flex-direction: column; align-items: center; gap: 6px; max-width: calc(100% - 24px); pointer-events: none; }
  .dots-bottom > * { pointer-events: auto; }
  .dots-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; max-width: calc(100% - 24px); background: color-mix(in srgb, var(--panel) 92%, transparent); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; box-sizing: border-box; }
  .dots-bar button, .dots-bar select { background: var(--well); color: var(--fg); border: 1px solid var(--line); border-radius: 5px; padding: 3px 8px; font: inherit; cursor: pointer; }
  .dots-bar input[type=range] { width: min(320px, 40vw); accent-color: var(--focus); }
  .dots-time { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 12em; }
  .dots-caption { padding: 3px 8px; border-radius: 6px; background: color-mix(in srgb, var(--bg) 80%, transparent); color: var(--fg); white-space: nowrap; max-width: calc(100% - 24px); overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; }
  .dots-kiosk .dots-caption { display: none; }
  /* #715: a live carve has no playback head: it plays as it is written. */
  .dots-live .dots-bar { display: none; }
  .dots-live.dots-carving .dots-caption { display: none; }
  /* The kiosk's replay runs and loops by itself, like a live scenario: no playback head. */
  .dots-kiosk:not(.dots-keep-bar) .dots-bar { display: none; }
  .dots-keep-bar .dots-bar { opacity: 0.55; transition: opacity 0.2s; }
  .dots-rail { transition: opacity 0.4s; }
  .dots-directing .dots-rail { opacity: 0; pointer-events: none; }
  .dots-keep-bar .dots-bar:hover, .dots-keep-bar .dots-bar:focus-within { opacity: 1; }
  /* In Watch the director holds the camera; the rail is Inspect's. */
  .dots-kiosk.dots-watch:not(.dots-keep-bar) .dots-rail { display: none; }
  .dots-tip { position: absolute; pointer-events: none; padding: 3px 6px; border-radius: 5px; background: var(--panel); border: 1px solid var(--line); white-space: nowrap; display: none; font-size: 12px; max-width: min(560px, calc(100% - 16px)); }
  .dots-tip .dots-prov { white-space: normal; color: var(--ink2, var(--muted)); font: 11.5px/1.35 var(--font-mono, monospace); margin-top: 2px; }
  /* A recording's timeline (#711): the label on the timeline itself, wall-clock ticks, the marks the records give, the breaks it skips. */
  .dots-bar-rec { flex-direction: column; align-items: stretch; gap: 4px; width: min(860px, calc(100vw - 48px)); }
  .dots-tl-label { font: 600 12px var(--font-ui, system-ui); color: var(--fg); }
  .dots-tl-short { display: none; }
  .dots-tl-row { display: flex; align-items: flex-end; gap: 16px; }
  /* Break labels sit in their own row above the track; tick labels sit in the track, so the two never meet. */
  .dots-tl-track { position: relative; flex: 1; height: 30px; margin-top: 16px; border-bottom: 1px solid var(--line); }
  .dots-bar input.dots-tl-range { position: absolute; left: 0; right: 0; bottom: -8px; width: 100%; margin: 0; accent-color: var(--focus); background: transparent; }
  .dots-tl-tick { position: absolute; bottom: 10px; transform: translateX(-50%); font: 11.5px var(--font-mono, monospace); color: var(--muted); white-space: nowrap; pointer-events: none; }
  .dots-tl-tick::after { content: ""; position: absolute; left: 50%; top: 100%; width: 1px; height: 4px; background: var(--line); }
  .dots-tl-break { position: absolute; top: 0; bottom: 0; width: 8px; transform: translateX(-50%); background: repeating-linear-gradient(135deg, var(--muted) 0 1.5px, transparent 1.5px 4px); opacity: 0.8; cursor: help; z-index: 1; }
  .dots-tl-break small { position: absolute; bottom: calc(100% + 2px); left: 50%; transform: translateX(-50%); font: 11.5px var(--font-mono, monospace); color: var(--muted); white-space: nowrap; }
  .dots-tl-break-end small { left: auto; right: 0; transform: none; }
  .dots-bar .dots-tl-mark { position: absolute; top: 2px; width: 9px; height: 9px; padding: 0; margin-left: -4.5px; transform: rotate(45deg); border: 1.5px solid var(--focus); background: var(--focus); border-radius: 2px; cursor: pointer; z-index: 2; }
  .dots-bar .dots-tl-keyframe { border-color: var(--muted); background: var(--muted); }
  /* The reminder that this is a recording stays readable: the timeline never fades with the quiet controls. */
  .dots-keep-bar .dots-bar.dots-bar-rec { opacity: 1; background: var(--panel); }
  .dots-bar .dots-tl-first, .dots-bar .dots-tl-last { border-color: var(--bar-managed, var(--focus)); }
  .dots-speed { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .dots-tip.dots-tip-go { pointer-events: auto; cursor: pointer; border-color: var(--focus); }
  .dots-prov-go { font: 11.5px var(--font-ui, system-ui); color: var(--focus); margin-top: 2px; }
  @media (max-width: 640px) { .dots-tl-long { display: none; } .dots-tl-short { display: inline; } .dots-tl-break small { display: none; } .dots-bar-rec { width: calc(100vw - 24px); } .dots-tl-row { flex-wrap: wrap; } .dots-tl-track { order: -1; flex: 1 1 100%; } }
  .dots-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .dots-keys { position: absolute; left: 8px; top: 8px; opacity: 0; pointer-events: none; font: 12px var(--font-ui, system-ui); background: var(--panel); color: var(--fg); border: 1px solid var(--focus); border-radius: 6px; padding: 3px 8px; }
  .dots-keys:focus-visible { opacity: 1; pointer-events: auto; }
  .dots-prov-link { position: absolute; left: 8px; bottom: 8px; font: 12px var(--font-ui, system-ui); color: var(--focus); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; }
  .dots-prov-link[hidden] { display: none; }
  @media (max-width: 640px) {
    .dots-rail { top: 52px; transform: none; width: 84px; height: 112px; right: 6px; padding: 4px 6px 4px 2px; }
    .dots-rail-mark { font-size: 11px; }
    .dots-rail-mark small { display: none; }
    .dots-bottom { bottom: 6px; }
    .dots-bar { gap: 6px; padding: 4px 8px; }
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
export async function mountDots({ host, svg, meta, getVB, setVB, vbInit, source = null, auto = null, live = null, kiosk = false, onCarving = null }) {
  const name = live ? "live" : meta.dots.source;
  let show = S && S.name === name && !live ? S.show : null;
  const keep = S && S.name === name && !live ? { t: S.t, playing: S.playing, speed: S.speed } : null;
  unmountDots();
  // A remount (the graph re-rendered) starts from the newest read, not the one the page was given.
  if (live && liveMemo && liveMemo.answer) live = liveMemo.answer;
  if (live) {
    // Arrivals keep the times they were first seen across a remount; the first read's lines are the past.
    const now = Date.now();
    const seen = stampArrivals(live, liveMemo ? liveMemo.seen : new Map(), now, { first: !liveMemo, stepMs: stepMsFor(liveSlowed) });
    show = liveShow(live, seen, now, { t0: liveMemo ? liveMemo.t0 : null });
    liveMemo = { seen, answer: live, t0: show.t0 };
  } else if (!show) {
    // A static export hands the source in; the preview server answers it.
    let src = source;
    if (!src) {
      const res = await fetch(`/api/dots/source?name=${encodeURIComponent(name)}`);
      src = await res.json();
      if (!res.ok) throw new Error(src.error || "dots source unreadable");
    }
    if (src.kind === "carve") {
      const rec = readCarve(src.text);
      show = carveShow(rec, parentsOf(rec.roster));
    } else show = walkthroughShow(src.model);
  }
  addStyle();
  const prefix = `${show.source}/`;
  // Seeds: each card's centre, read from where pinhole painted it. A live
  // carve's cards are the served roots' (`<member>/<address>`), joined by address.
  const cards = new Map();
  const widths = [];
  // The cards the SVG draws of its own: what the card level shows when none of them is a resource's.
  let svgCards = 0;
  for (const g of svg.querySelectorAll("[data-node-id]")) {
    const id = g.getAttribute("data-node-id");
    const r = g.querySelector("rect");
    if (!r) continue;
    svgCards++;
    const slash = id.indexOf("/");
    if (live ? slash < 0 : !id.startsWith(prefix)) continue;
    const addr = live ? id.slice(slash + 1) : id.slice(prefix.length);
    if (live && cards.has(addr)) continue;
    const x = +r.getAttribute("x");
    const y = +r.getAttribute("y");
    const w = +r.getAttribute("width");
    const h = +r.getAttribute("height");
    cards.set(addr, { x: x + w / 2, y: y + h / 2 });
    widths.push(w);
  }
  widths.sort((a, b) => a - b);
  const cardW = widths[widths.length >> 1] || 200;
  const boxEl = svg.querySelector(`rect[data-group-id="${CSS.escape(show.source)}"]`) || svg.querySelector("rect[data-group-id]");
  const mbox = boxEl
    ? { x: +boxEl.getAttribute("x"), y: +boxEl.getAttribute("y"), w: +boxEl.getAttribute("width"), h: +boxEl.getAttribute("height") }
    : { x: vbInit[0], y: vbInit[1], w: vbInit[2], h: vbInit[3] };
  // The source estate's box takes its cards' box's place and shape on the page.
  const scene = buildScene(show, { sourceAspect: mbox.w / Math.max(1, mbox.h), ...labelRoom(host) });
  const src = scene.sourceBox;
  // One dot pitch is a fixed share of a card's width, so a dot is legible exactly
  // when its card stops being: at the dot size a pitch is about 8 px, whatever
  // the estate's size. The source box sits centred on its cards' box.
  const pitch = cardW * 0.35;
  const origin = { x: mbox.x + (mbox.w - src.w * pitch) / 2, y: mbox.y + (mbox.h - src.h * pitch) / 2 };
  if (!show.roster.length) return;

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
    // No SVG card is a resource's (a live carve at the Components zoom draws one per root): the canvas draws the roster's.
    seedless: cards.size === 0,
    svgCards,
    // The roster's cards (fitRosterCards): their size in viewBox units, the width in px their card level starts at.
    rc: { w: 1, h: 1 },
    need: LOD.cardPx,
    lodR: LOD,
    gridK: 0,
    grids: new WeakMap(),
    gdisp: new Map(),
    ownA: 0,
    own: false,
    labels: new Map(),
    fits: new Map(),
    origin,
    mbox,
    live: !!live,
    answer: live,
    onCarving,
    carving: false,
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
    pw: new Float32Array(n),
    ph: new Float32Array(n),
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
  fitRosterCards();
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
  const onMove = (e) => {
    if (S && S.selected) return;
    hoverAt(e);
  };
  host.addEventListener("mousemove", onMove);
  S.off.push(() => host.removeEventListener("mousemove", onMove));
  // A tap (or a click) on a landed dot selects it: its tip stays, and its line is read out. A tap elsewhere lets it go.
  let down = null;
  const onDown = (e) => {
    down = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e) => {
    if (!S || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || S.cardA > 0.5) return;
    const i = nearestDot(e, 144);
    if (i < 0) {
      S.selected = null;
      S.tip.style.display = "none";
      if (S.provLink) S.provLink.hidden = true;
      return;
    }
    selectDot(S.addrs[i]);
  };
  host.addEventListener("pointerdown", onDown);
  host.addEventListener("pointerup", onUp);
  S.off.push(() => {
    host.removeEventListener("pointerdown", onDown);
    host.removeEventListener("pointerup", onUp);
  });
  const params = new URLSearchParams(location.search);
  if (S.live) startLive(kiosk);
  // Past a few hundred cards the fit is already below card size, so a large
  // source opens on its resources; the rail and the fit button still go to cards.
  // #712: in the kiosk's frame the replay loops by itself and the director frames it.
  // `auto` (the static carve export): the same loop and director, narrated in the page itself.
  S.kiosk = !S.live && (params.get("dotsKiosk") === "1" || !!auto);
  S.narrate = auto && auto.narrate ? auto.narrate : null;
  S.auto = !!auto;
  S.keepBar = !!(auto && auto.bar);
  if (S.kiosk) startKiosk();
  else if (!S.live && !keep && !params.has("dotsAt") && show.roster.length > 300) flyNow("resources");
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
  const zoomCardPx = (px) => zoomTo((paneRect().width * S.cardW) / px, true);
  const setInsets = (ins) => {
    if (S) S.insets = { top: Number(ins.top) || 0, bottom: Number(ins.bottom) || 0 };
  };
  window.__dots = { select: (id) => selectDot(id), landed: () => S && landedIds(), seek, play, step, zoomTo, zoomCardPx, setInsets, pause: () => play(false), fly, setSpeed, stats: () => S && S.stats, length: () => S && S.clock.length, marks: () => S && currentMarks(), state: () => S && { t: S.t, level: S.level, reduced: S.reduced, cardPx: S.cardPx, pitchPx: S.pitchPx, rosterCards: S.own, rosterCardPx: S.rosterCardPx, directing: !!S.directing }, debug: () => S && { band: (({ left, right, w }) => ({ left, right, w }))(band()), svg: S.svg.getBoundingClientRect().toJSON(), rail: S.ui.querySelector('.dots-rail').getBoundingClientRect().toJSON(), vb: S.getVB(), dir: S.dir, directing: S.directing, focusBox: S.dir && focusBox(S.dir.focus), want: S.dir && frameBox(focusBox(S.dir.focus)), pitch: S.pitch, origin: S.origin }, story: () => S && S.story && { start: S.story.start, end: S.story.end, firstRefusal: S.story.firstRefusal ? S.story.firstRefusal.end : null } };
  const loop = (wall) => {
    if (!S) return;
    S.raf = requestAnimationFrame(loop);
    const dt = S.lastWall ? Math.min(100, wall - S.lastWall) : 16;
    S.lastWall = wall;
    if (S.fly) stepFly(wall);
    if (S.live) {
      // The live clock is the wall's: a line flies from when it was seen.
      S.t = Date.now() - S.show.t0;
      S.clock.length = Math.max(S.clock.length, S.t);
      if (S.t <= S.busyUntil) S.dirty = true;
      liveTick(wall, dt);
    } else if (S.playing) {
      S.t = Math.min(S.clock.length, S.t + dt * S.speed);
      if (S.t >= S.clock.length) play(false);
      S.dirty = true;
    }
    if (S.kiosk) kioskTick(wall, dt);
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
  // In the kiosk a seek keeps the loop playing.
  if (S.kiosk && t < S.clock.length) {
    S.holdUntil = null;
    S.playing = true;
  }
  S.t = Math.max(0, Math.min(S.clock.length, t));
  // Tips fire for what plays, not for what a seek skips.
  S.tipFrom = S.t;
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

/** Where the card SVG sits on the page. Read off the SVG while it shows; once it is
 * out of the paint the host stands in for it (the SVG fills it), so a moving camera
 * never makes the browser lay a 1,041-card SVG out just to be measured. */
/**
 * What the scene's layout needs to leave each box's label room (web/dots-scene.js): the label's width on screen, in
 * the face the boxes are labelled in, and the screen area the director frames the boxes in.
 */
function labelRoom(host) {
  if (typeof document === "undefined" || !host || !host.getBoundingClientRect) return {};
  const r = host.getBoundingClientRect();
  if (!r.width || !r.height) return {};
  const cv = document.createElement("canvas").getContext("2d");
  if (!cv) return {};
  const font = (S && S.font) || getComputedStyle(document.body).fontFamily || "sans-serif";
  cv.font = `700 11.5px ${font}`;
  const ins = S && S.insets ? S.insets : { top: 0, bottom: 0 };
  return {
    labelPx: (e) => cv.measureText(`${e} 000`).width + 12,
    labelH: 18,
    avail: { w: r.width * 0.72, h: Math.max(80, r.height - (ins.top || 0) - (ins.bottom || 0) - 32) },
  };
}

function paneRect() {
  return S.svgHidden && S.svgGone ? S.host.getBoundingClientRect() : S.svg.getBoundingClientRect();
}

function camera() {
  const r = paneRect();
  const hr = S.host.getBoundingClientRect();
  const vb = S.getVB();
  const s = Math.min(r.width / vb[2], r.height / vb[3]);
  const ox = r.left - hr.left + S.host.scrollLeft + (r.width - vb[2] * s) / 2 - vb[0] * s;
  const oy = r.top - hr.top + S.host.scrollTop + (r.height - vb[3] * s) / 2 - vb[1] * s;
  return { s, ox, oy, r, vb, left: r.left - hr.left + S.host.scrollLeft, top: r.top - hr.top + S.host.scrollTop };
}

/** The pane's width not covered by the floating panel, and how much it covers. */
function band() {
  const r = paneRect();
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
  // The card level is where the cards that draw are legible: the roster's own when the canvas draws them.
  return railMarks({ paneW: bw, paneH: r.height || 1, cardW: S.own ? S.rc.w : S.cardW, ...(S.own ? { lod: S.lodR, cardAt: S.need * 1.1 } : {}), sceneW: S.scene.extent.w * P, sceneH: S.scene.extent.h * P, smallestBox: Number.isFinite(small) ? small * P : 0, largestBox: big * P, typicalBox: typical * P });
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
  if (mark === "cards" && S.own) {
    // The roster's cards: the one nearest the middle of the director's estate's cards, else the source estate's, else
    // the fullest estate's, at the width where a card is just fully drawn.
    const sc = S.scene;
    const L = sc.layoutAt(takeoffsBy(sc, S.t));
    const grid = gridOf(L);
    const counts = new Map();
    for (const a of grid.keys()) counts.set(L.owners.get(a), (counts.get(L.owners.get(a)) ?? 0) + 1);
    const f = S.dir && S.dir.focus;
    const e = cardsEstate(f && f.kind === "estate" ? f.estate : null, sc.source, counts);
    const at = e === null ? null : middleCard([...grid].filter(([a]) => L.owners.get(a) === e).map(([, p]) => p));
    if (!at) return;
    const { r, left, right } = band();
    const to = cardsFrame({ x: S.origin.x + at.x * P, y: S.origin.y + at.y * P }, w, vb[3] / vb[2]);
    to[0] -= (((left - right) / 2) * w) / Math.max(1, r.width);
    if (S.reduced) S.setVB(to);
    else S.fly = { from: vb.slice(), to, start: performance.now(), dur: 900 };
    return;
  }
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
      // A mark is a viewer's hand on the camera: the director waits while it flies and reads.
      viewerHold();
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
  if (S.clock.recorded) {
    // A recording of a real event stream: the timeline says so, on itself, with the recording's wall-clock times,
    // its marks (each a line of the recording), its breaks (each idle stretch it compresses, with the real gap), and the
    // speed beside the playhead, always in words.
    bar.classList.add("dots-bar-rec");
    const rec = S.show.records || {};
    const lab = el("div", "dots-tl-label");
    const facts = { t0: S.show.timeline.t0, t1: S.show.timeline.t1, source: rec.header ? rec.header.source : null, plan: rec.header ? rec.header.plan : null };
    lab.append(el("span", "dots-tl-long", recordedLabel(facts)), el("span", "dots-tl-short", recordedLabel(facts, { short: true })));
    const track = el("div", "dots-tl-track");
    const L = S.clock.length;
    const at = (p) => `${((p / L) * 100).toFixed(3)}%`;
    const narrow = typeof innerWidth === "number" && innerWidth < 640;
    // The track's width on screen, near enough to keep labels apart: the bar less the play and speed buttons.
    const trackW = Math.max(160, Math.min(860, (typeof innerWidth === "number" ? innerWidth : 1200) - 48) - (narrow ? 24 : 230));
    const px = (p) => (p / L) * trackW;
    const breaks = S.show.timeline.breaks;
    // A tick label that would sit under a break's hatch or label is left out; its time is still on the track.
    for (const tk of wallTicks(S.show.timeline, narrow ? 3 : 7)) {
      if (breaks.some((b) => Math.abs(px(tk.p) - px(b.p)) < 26)) continue;
      const t = el("span", "dots-tl-tick", tk.label);
      t.style.left = at(tk.p);
      track.appendChild(t);
    }
    for (const b of breaks) {
      const k = el("span", `dots-tl-break${b.p / L > 0.9 ? " dots-tl-break-end" : ""}`);
      k.style.left = at(b.p);
      k.title = `${skippedWords(b.skipped)}: from ${clockWords(b.real0, true)} to ${clockWords(b.real1, true)} UTC nothing was written, and the replay skips it`;
      k.appendChild(el("small", "", skippedWords(b.skipped).replace(/ skipped$/, "")));
      track.appendChild(k);
    }
    const file = S.name ? `${String(S.name).replace(/^carve:/, "")}.jsonl` : "the recording";
    for (const m of recordedMarks(S.show, S.show.timeline, file)) {
      const b = el("button", `dots-tl-mark dots-tl-${m.kind}`);
      b.type = "button";
      b.style.left = at(m.p);
      b.title = `${m.words} · ${m.record}`;
      b.setAttribute("aria-label", `${m.words}, ${m.record}`);
      b.addEventListener("click", () => seek(m.p));
      track.appendChild(b);
    }
    S.range.classList.add("dots-tl-range");
    track.appendChild(S.range);
    S.speedBtn = el("button", "dots-speed", speedWords(S.speed));
    S.speedBtn.type = "button";
    S.speedBtn.setAttribute("aria-label", "Replay speed");
    S.speedBtn.addEventListener("click", () => {
      const i = RECORDED_SPEEDS.indexOf(S.speed);
      setSpeed(RECORDED_SPEEDS[(i + 1) % RECORDED_SPEEDS.length]);
    });
    const row = el("div", "dots-tl-row");
    row.append(S.playBtn, track, S.speedBtn);
    bar.append(lab, row, S.timeEl);
    S.speedSel.hidden = true;
  } else bar.append(S.playBtn, S.speedSel, S.range, S.timeEl);
  bottom.appendChild(bar);
  S.tip = el("div", "dots-tip");
  S.tip.addEventListener("click", (e) => {
    if (!S || S.tipSeek === null || S.tipSeek === undefined) return;
    e.stopPropagation();
    seek(S.clock.at(S.tipSeek));
    play(false);
  });
  S.tip.addEventListener("pointerup", (e) => e.stopPropagation());
  ui.appendChild(S.tip);
  // A landed dot's provenance without a pointer: the arrow keys step through the writes, the live region reads each out.
  S.sr = el("div", "dots-sr");
  S.sr.setAttribute("aria-live", "polite");
  S.sr.setAttribute("role", "status");
  ui.appendChild(S.sr);
  const keys = el("button", "dots-keys", "← → the writes that landed");
  keys.type = "button";
  keys.setAttribute("aria-label", "Step through the writes that landed with the left and right arrow keys; each is read out");
  keys.addEventListener("keydown", (e) => {
    if (!S || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const ids = landedIds();
    if (!ids.length) {
      S.sr.textContent = "No write has landed yet in this cycle.";
      return;
    }
    const at = ids.indexOf(S.selected);
    const next = at < 0 ? (e.key === "ArrowRight" ? 0 : ids.length - 1) : (at + (e.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length;
    selectDot(ids[next]);
  });
  ui.appendChild(keys);
  S.provLink = el("a", "dots-prov-link", "Open the job");
  S.provLink.target = "_blank";
  S.provLink.rel = "noopener";
  S.provLink.hidden = true;
  ui.appendChild(S.provLink);
  syncUi();
}

const fmt = (n) => n.toLocaleString("en-US");

function syncUi() {
  if (!S || !S.playBtn) return;
  S.playBtn.textContent = S.playing ? "Pause" : S.t >= S.clock.length ? "Replay" : "Play";
  S.speedSel.value = String(S.speed);
  if (S.speedBtn && S.speedBtn.textContent !== speedWords(S.speed)) S.speedBtn.textContent = speedWords(S.speed);
  S.range.value = String(Math.round(S.t));
}

/** The show's own time at replay time `t`: the wall clock for a live carve and for a recording with its own clock. */
function showTime(t) {
  if (S.live) return S.show.t0 + t;
  if (S.clock.real) return S.clock.real(t);
  return S.show.t0 + (t / S.clock.length) * (S.show.t1 - S.show.t0);
}

function shortName(e) {
  const src = S.scene.source;
  // An adopted stock root's box takes its estate's name once the first stamp plays (web/dots-live.js).
  const nm = boxName(S.show, e, S.show.t0 + S.t);
  if (nm !== e) return nm;
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
  // The zoom goes out a little past the estates mark and no further.
  S.zoomOut = Math.max(3, (marks.estates * 1.4) / Math.max(1, S.vbInit[2]));
  // The Cards mark counts the cards that can draw at its zoom, never more.
  const cm = cardsMark({ resources: S.show.roster.length, seeded: S.cards.size, svgCards: S.svgCards, own: S.own });
  if (S.railMarks.cards.disabled === cm.enabled) {
    S.railMarks.cards.disabled = !cm.enabled;
    S.railMarks.cards.title = cm.enabled ? "Fly to cards" : "No cards draw here";
  }
  const sub = { cards: cm.words, resources: `${fmt(S.show.roster.length)} resources`, estates: `${estatesNow} estate${estatesNow === 1 ? "" : "s"}` };
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
  // A roster card is hit anywhere on it; a dot within 10 px of its centre.
  const best = pickMark(x, y, S, { within: 10 });
  if (best < 0) {
    S.tip.style.display = "none";
    return;
  }
  showTip(S.addrs[best], x, S.ph[best] > 0 ? S.py[best] + S.ph[best] : y, S.ph[best] > 0 ? S.py[best] - S.ph[best] : y);
}

/** A landed dot's provenance: what its newest write was, from its progress line and the migration's run; null for a dot no line names. */
function provenanceOf(id) {
  if (!S) return null;
  if (!S.live) return recordedProvenance(id);
  const w = landedWrite(S.show, id, S.show.t0 + S.t);
  if (!w) return null;
  const m = ((S.answer && S.answer.migrations) || []).find((x) => x.name === w.migration);
  const run = m && m.run ? m.run : null;
  return { text: provenanceText({ ...w, tool: run ? run.tool : migrationTool(m && m.change), job: run ? run.job : null }), url: run && run.job_url ? run.job_url : null };
}

/** A recorded dot's provenance: the move line of the recording that landed it, with its line and time, and where the playhead goes on a click. */
function recordedProvenance(id) {
  if (!S.clock.recorded) return null;
  const now = showTime(S.t);
  let best = null;
  for (const ev of S.show.events) {
    if (ev.kind !== "write" || ev.t > now) continue;
    if (ev.address !== id && !(ev.followers || []).includes(id)) continue;
    if (!best || ev.t >= best.t) best = ev;
  }
  if (!best) return null;
  const file = S.name ? `${String(S.name).replace(/^carve:/, "")}.jsonl` : "the recording";
  const text = provenanceText({ outcome: best.ok ? "moved" : "refused", tool: "live-mv", address: best.address === id ? id : `${id} (with ${best.address})`, from: best.from, to: best.to, at: best.t, reason: best.refusalSummary || null });
  return { text: `${text} · ${file}${best.line ? ` line ${best.line}` : ""}`, url: null, seek: best.t };
}

function showTip(a, x, y, top = y) {
  const prov = provenanceOf(a);
  S.tip.replaceChildren(el("div", "", `${a} · ${shortName(S.ownersNow.get(a) ?? S.scene.source)}`));
  if (prov) {
    const p = el("div", "dots-prov", prov.text);
    S.tip.appendChild(p);
    if (prov.seek !== undefined && S.selected === a) S.tip.appendChild(el("div", "dots-prov-go", "Click to move the playhead to this write"));
  }
  // A selected recorded dot's tip is a control: a click moves the playhead to its write.
  S.tip.classList.toggle("dots-tip-go", !!(prov && prov.seek !== undefined && S.selected === a));
  S.tipSeek = prov && prov.seek !== undefined ? prov.seek : null;
  S.tip.style.display = "block";
  // Clear of the rail on the right, and over the mark when the pane's foot leaves no room under it.
  const spot = tipSpot(x, y, { tipW: S.tip.offsetWidth, tipH: S.tip.offsetHeight, paneW: S.host.clientWidth, paneH: S.host.clientHeight, rightInset: band().right, above: top });
  S.tip.style.left = `${spot.left}px`;
  S.tip.style.top = `${spot.top}px`;
}

/** The dots that a write of this cycle landed, in the order they were written: what the keys step through. */
function landedIds() {
  const out = [];
  const t = showTime(S.t);
  const seen = new Set();
  for (const ev of S.show.events) {
    if (ev.before || (S.live ? !ev.line || ev.start > t : ev.kind !== "write" || ev.t > t)) continue;
    for (const id of [ev.address, ...(ev.followers || [])]) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Select a dot: its tip stays up, and its provenance is read out in the live region, for a reader without a pointer. */
function selectDot(id) {
  if (!S) return;
  S.selected = id;
  const i = S.idx.get(id);
  const prov = provenanceOf(id);
  const words = prov ? prov.text : `${id} · ${shortName(S.ownersNow.get(id) ?? S.scene.source)}`;
  if (S.sr && S.sr.textContent !== words) S.sr.textContent = words;
  if (S.provLink) {
    S.provLink.hidden = !(prov && prov.url);
    if (prov && prov.url) S.provLink.href = prov.url;
  }
  if (i !== undefined && S.pvis[i]) showTip(id, S.px[i], S.py[i] + S.ph[i], S.py[i] - S.ph[i]);
  S.dirty = true;
}

function nearestDot(e, within = 100) {
  const hr = S.host.getBoundingClientRect();
  const x = e.clientX - hr.left + S.host.scrollLeft;
  const y = e.clientY - hr.top + S.host.scrollTop;
  // `within` is a squared distance, as it always was here.
  return pickMark(x, y, S, { within: Math.sqrt(within) });
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

/**
 * The roster's cards for the scene now: one cell size every estate's grid fits at across the show (sampled at its
 * start, its end and 39 moments between), the card size and the width in px at which a card is fully drawn: wide
 * enough for the longest name and type. Only a scene with no SVG card for any resource draws them.
 */
function fitRosterCards() {
  S.grids = new WeakMap();
  S.gdisp = new Map();
  S.labels.clear();
  S.fits.clear();
  if (!S.seedless) return;
  const sc = S.scene;
  S.unitKey = unitKeyOf(sc.rosterBy);
  const n = sc.landing.length;
  const ks = new Set([0, n]);
  for (let j = 1; j < 40; j++) ks.add(Math.round((n * j) / 40));
  S.gridK = gridScale([...ks].map((k) => sc.layoutAt(k)), S.unitKey);
  const c = cardSize(S.gridK);
  S.rc = { w: c.w * S.pitch, h: c.h * S.pitch };
  const ctx = S.ctx;
  S.need = cardNeed(
    S.show.roster.map((r) => labelOf(r.address)),
    (txt, px, weight) => {
      ctx.font = `${weight} ${px}px ${S.font}`;
      return ctx.measureText(txt).width;
    },
  );
  S.lodR = rosterLod(S.need);
}

/** Each roster card's cell in a layout, in pitches (web/dots-cards.js gridSlots), kept per layout. */
function gridOf(layout) {
  let g = S.grids.get(layout);
  if (!g) {
    g = gridSlots(layout, S.gridK, S.unitKey);
    S.grids.set(layout, g);
  }
  return g;
}

/**
 * Where a resource's card is now, in pitches: flying from its cell in the box it leaves to its cell in the box it
 * lands in, or at rest in its cell, sliding when a box re-packs as its dots do.
 */
function cellOf(a, f, L, t, ease) {
  if (f && f.ok) {
    const from = gridOf(S.scene.layoutAt(f.k - 1)).get(a);
    const to = gridOf(S.scene.layoutAt(f.k)).get(a) ?? from;
    if (!from) return to ?? null;
    const uf = (t - f.start) / (f.end - f.start);
    if (S.reduced) return uf < 0.5 ? from : to;
    S.cellMoving = true;
    return flightPoint(from, to, uf);
  }
  const target = gridOf(L).get(a);
  if (!target) return null;
  const prev = S.gdisp.get(a);
  const out = prev && !S.snap && ease < 1 ? { x: lerp(prev.x, target.x, ease), y: lerp(prev.y, target.y, ease) } : target;
  if (Math.abs(out.x - target.x) + Math.abs(out.y - target.y) > 0.01) S.cellMoving = true;
  S.gdisp.set(a, out);
  return out;
}

/** A roster row's card words, from its address and type alone (web/dots-cards.js). */
function labelOf(a) {
  let l = S.labels.get(a);
  if (!l) {
    l = cardLabel(S.scene.rosterBy.get(a) || { address: a });
    S.labels.set(a, l);
  }
  return l;
}

/** A card's lines at its size now, kept by size: fitting a name measures it several times. */
function linesOf(ctx, a, sh) {
  const key = `${a}|${Math.round(sh.w)}|${Math.round(sh.h)}`;
  let lines = S.fits.get(key);
  if (!lines) {
    lines = cardText(labelOf(a), { w: sh.w, h: sh.h, need: S.need }, (txt, px, weight) => {
      ctx.font = `${weight} ${px}px ${S.font}`;
      return ctx.measureText(txt).width;
    });
    if (S.fits.size > 4000) S.fits.clear();
    S.fits.set(key, lines);
  }
  return lines;
}

/**
 * A resource's roster card, `u` of the way from its dot (0) to its card (1): the dot's disc grows into a rounded
 * rect in its estate's colour, which pales to a tint on the page's surface as the name and the type fade in. The
 * marks a dot wears (a tour's light, the adoption's ring, the selection, a takeoff) go round the card.
 */
function drawRosterCard(ctx, a, sh, u, { vis, colour, glow, ring, selected, takeoff }) {
  const col = S.col;
  const round = (o) => roundRect(ctx, sh.x - o, sh.y - o, sh.w + 2 * o, sh.h + 2 * o, sh.r + o);
  if (glow) {
    ctx.globalAlpha = vis * glow.a * 0.7;
    ctx.strokeStyle = glow.colour;
    ctx.lineWidth = 3;
    round(3);
    ctx.stroke();
  }
  round(0);
  ctx.globalAlpha = vis * Math.min(1, u * 2);
  ctx.fillStyle = col.surface || col.bg;
  ctx.fill();
  ctx.globalAlpha = vis * lerp(1, 0.12, u);
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.globalAlpha = vis * Math.min(1, u * 1.5);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  const ta = cardTextAlpha(u);
  if (u > 0.5) {
    ctx.save();
    round(0);
    ctx.clip();
    ctx.globalAlpha = vis;
    ctx.fillStyle = colour;
    ctx.fillRect(sh.x, sh.y, CARD_TEXT.bar, sh.h);
    const lines = ta > 0 ? linesOf(ctx, a, sh) : [];
    if (lines.length) {
      const total = lines.reduce((n, l) => n + l.size * 1.25, 0);
      let y = sh.y + (sh.h - total) / 2;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.globalAlpha = vis * ta;
      for (const l of lines) {
        ctx.font = `${l.weight} ${l.size}px ${S.font}`;
        ctx.fillStyle = l.ink === "muted" ? col.muted : col.fg;
        ctx.fillText(l.text, sh.x + CARD_TEXT.bar + CARD_TEXT.pad, y + l.size * 0.625);
        y += l.size * 1.25;
      }
    }
    ctx.restore();
  }
  if (ring) {
    // It wears its estate's tags now: a ring round the dot, a tag on the card's corner.
    ctx.globalAlpha = vis;
    if (u < 0.5) {
      ctx.strokeStyle = col.managed;
      ctx.lineWidth = 1.2;
      round(2);
      ctx.stroke();
    } else {
      ctx.fillStyle = col.managed;
      ctx.beginPath();
      ctx.arc(sh.x + sh.w - 6, sh.y + 6, Math.max(2, Math.min(3.5, sh.h * 0.08)), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (glow && glow.ring) {
    ctx.globalAlpha = vis;
    ctx.strokeStyle = glow.colour;
    ctx.lineWidth = 2;
    round(5);
    ctx.stroke();
  }
  if (selected) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = col.fg;
    ctx.lineWidth = 1.6;
    round(4);
    ctx.stroke();
  }
  if (takeoff < 0.2) {
    ctx.globalAlpha = vis * (1 - takeoff / 0.2);
    ctx.strokeStyle = col.pending;
    ctx.lineWidth = 1.4;
    round(2 + takeoff * 20);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
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
  // With no SVG card for any resource, the canvas draws the roster's cards: while the carve holds the stage (a live
  // carve's director or tour), or always for a recording. The SVG's own cards (a live carve's roots) stay out of the
  // paint then, and come back, eased, when the stage is theirs again.
  const ownWant = S.seedless && (!S.live || S.carving) ? 1 : 0;
  S.ownA = S.snap || reduced ? ownWant : lerp(S.ownA, ownWant, 1 - Math.exp(-dt / 300));
  if (Math.abs(S.ownA - ownWant) < 0.01) S.ownA = ownWant;
  const ownA = S.ownA;
  S.own = ownA >= 0.5;
  // The roster's cards grow from the dots in their slots: their own size on screen picks their form, as a card's does.
  const rcW = S.rc.w * s;
  const rcH = S.rc.h * s;
  S.rosterCardPx = rcW;
  const tr = cardMorph(rcW, { reduced, lod: S.lodR });
  const layerA = lerp(tc, 1, ownA);
  S.cardA = 1 - layerA;
  // Cards fade faster than the dots grow, so the dots under them read by the middle of the morph.
  const cardA = (Math.pow(1 - tc, 2) * (1 - ownA)).toFixed(3);
  if (S.host.style.getPropertyValue("--dots-card-a") !== cardA) S.host.style.setProperty("--dots-card-a", cardA);
  const hide = tc >= 1 || ownA >= 1;
  if (hide !== S.svgHidden) {
    // The export owns its camera and measures the host, so it takes the SVG out of
    // layout altogether; the app's own wheel handler measures the SVG, so there it stays in layout.
    if (S.auto) S.svg.style.display = hide ? "none" : "";
    else S.svg.style.visibility = hide ? "hidden" : "";
    S.svgHidden = hide;
    S.svgGone = hide && !!S.auto;
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
  const level = levelOf(S.own ? tr : tc, td.values());
  // Reaching the estate level by hand fits the estates, so they are not a speck in a corner.
  if (level === "discs" && S.level && S.level !== "discs" && !S.fly && !S.directing) queueMicrotask(() => fly("estates"));
  S.level = level;
  const dotLayerA = layerA;
  // How far a resource with no SVG card has grown into its roster card: 0 its dot, 1 its card.
  const rosterU = ownA * (1 - tr);
  if (ownA !== ownWant) moving = true;

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
  // Where each box's label went, so a Tips bubble keeps off it (web/carve-narration.js).
  const labelPx = new Map();
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
    if (dotLayerA > 0.6 && (td.get(e) ?? 0) < 0.5) {
      ctx.font = `700 ${fs}px ${S.font}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      let nm = shortName(e);
      const cnt = fmt(Math.max(0, counts.get(e) ?? 0));
      let nw = ctx.measureText(nm).width;
      const cw = ctx.measureText(cnt).width;
      const tw = nw + fs * 0.5 + cw;
      const inside = titlePx >= fs * 1.5 && tw + fs * 1.6 <= bp.w;
      const lx = bp.x + (inside ? fs * 0.8 : 1);
      // Outside the box, a label runs no further than the next box along its row, with a gap, so two never touch.
      let room = Infinity;
      if (!inside) {
        for (const [o, ob] of boxes) {
          if (o === e) continue;
          const op = boxPx(ob);
          if (op.x > bp.x + 1 && op.y < bp.y + fs && op.y + op.h > bp.y - fs * 2.4) room = Math.min(room, op.x - lx - fs);
        }
      }
      // Too wide for its room: the count goes under the name, and a name still too wide is shortened.
      const stacked = !inside && tw > room;
      if (stacked && nw > room) {
        while (nm.length > 4 && ctx.measureText(`${nm}…`).width > room) nm = nm.slice(0, -1);
        nm = `${nm}…`;
        nw = ctx.measureText(nm).width;
      }
      const lw = stacked ? Math.max(nw, cw) : tw;
      const lh = stacked ? fs * 2.4 : fs * 1.2;
      let ly = inside ? bp.y + titlePx * 0.55 : bp.y - fs * 0.75 - (stacked ? fs * 1.2 : 0);
      let ok = claim(lx, ly - fs * 0.6, lw, lh);
      // No room above: try just below the outline.
      if (!ok && !inside) {
        ly = bp.y + bp.h + fs * 0.8;
        ok = claim(lx, ly - fs * 0.6, lw, lh);
      }
      if (ok) {
        ctx.globalAlpha = a * drawIn;
        ctx.fillStyle = c;
        ctx.fillText(nm, lx, ly);
        ctx.fillStyle = col.muted;
        if (stacked) ctx.fillText(cnt, lx, ly + fs * 1.2);
        else ctx.fillText(cnt, lx + nw + fs * 0.5, ly);
        labelPx.set(e, { x: lx, y: ly - fs * 0.6, w: lw, h: lh });
      }
    }
  }
  ctx.globalAlpha = 1;

  // --- threads between estates (cross-estate reads), dashes marching reader -> source ---
  const tShow = showTime(t);
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
  // The tour's lights: each resource the chapter's plan planned, brighter where the plan changes it.
  const fx = currentFx(owners);
  if (fx) for (const [id, l] of fx.lights) {
    const prev = glow.get(id);
    const g = { colour: col.foreign, a: l.changed ? 1 : 0.85, ring: l.changed };
    if (!prev || g.a >= prev.a) glow.set(id, g);
  }
  ctx.globalAlpha = 1;
  const refusedLit = [];
  S.cellMoving = false;
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
      // At the card level the cards fly cell to cell, not along the slots' path: no trail then.
      if (dotLayerA > 0.05 && !f.parent && rosterU < 0.5) {
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
    // A resource the SVG has no card for grows into its roster card as it slides from its slot to its cell in its
    // estate's grid of cards (web/dots-cards.js).
    const u = card ? 0 : rosterU * (1 - tdE);
    if (u > 0.001) {
      const cell = cellOf(a, f, L, t, ease);
      if (cell) p = { x: lerp(p.x, cell.x, u), y: lerp(p.y, cell.y, u) };
    }
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
    const flying = f && f.ok && !reduced;
    const shape = u > 0.01 ? cardShape(q.x, q.y, u, { dotR: flying ? rDot * 1.6 : rDot, cardW: rcW, cardH: rcH }) : null;
    S.pw[i] = shape ? shape.w / 2 : 0;
    S.ph[i] = shape ? shape.h / 2 : 0;
    const margin = shape ? 20 + shape.w / 2 : 20;
    if (q.x < -margin || q.y < -margin || q.x > W + margin || q.y > H + margin) continue;
    const g = glow.get(a);
    if (f || g) markLit(est);
    if (vis <= 0.01) continue;
    if (shape) {
      drawRosterCard(ctx, a, shape, u, { vis, colour, glow: g, ring: rings.has(a), selected: a === S.selected, takeoff: flying ? (t - f.start) / (f.end - f.start) : 1 });
      continue;
    }
    if (g) {
      ctx.globalAlpha = vis * g.a * 0.6;
      ctx.fillStyle = g.colour;
      ctx.beginPath();
      ctx.arc(q.x, q.y, rDot * 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
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
    if (g && g.ring) {
      ctx.globalAlpha = vis;
      ctx.strokeStyle = g.colour;
      ctx.lineWidth = Math.max(1.2, rDot * 0.45);
      ctx.beginPath();
      ctx.arc(q.x, q.y, rDot * 2.3, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (a === S.selected) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = col.fg;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(q.x, q.y, rDot * 2.8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = vis;
    }
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
  if (S.cellMoving) moving = true;
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
        if (S.pw[i] > 0) {
          // A card's landing: its outline swells and fades.
          const grow = 2 + u * 10;
          roundRect(ctx, qx - S.pw[i] - grow, qy - S.ph[i] - grow, 2 * (S.pw[i] + grow), 2 * (S.ph[i] + grow), 6 + grow / 2);
        } else {
          ctx.beginPath();
          ctx.arc(qx, qy, rDot * (1.2 + u * 5), 0, Math.PI * 2);
        }
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
    if (S.pw[i] > 0) {
      // A refused card: its outline in the failure colour, so its words stay readable.
      const out = 2 + 3 * (1 - u);
      ctx.globalAlpha = dotLayerA * (0.6 + 0.4 * (1 - u));
      ctx.strokeStyle = col.degraded;
      ctx.lineWidth = 2.2;
      roundRect(ctx, qx - S.pw[i] - out, qy - S.ph[i] - out, 2 * (S.pw[i] + out), 2 * (S.ph[i] + out), 7);
      ctx.stroke();
    } else {
      ctx.globalAlpha = dotLayerA * (0.35 + 0.4 * (1 - u));
      ctx.fillStyle = col.degraded;
      ctx.beginPath();
      ctx.arc(qx, qy, rDot * (2.2 + 1.5 * (1 - u)), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = dotLayerA;
      ctx.beginPath();
      ctx.arc(qx, qy, rDot, 0, Math.PI * 2);
      ctx.fill();
    }
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
  drawTour(ctx, fx, boxes, boxPx, centre, sx, sy, dotLayerA, td, (e) => Math.max(2.5, discRadius(Math.max(1, counts.get(e) ?? 0), P) * s));
  ctx.globalAlpha = 1;
  S.snap = false;
  S.settling = moving;
  S.boxPx = new Map([...boxes].map(([e, b]) => [e, boxPx(b)]));
  S.labelPx = labelPx;
  updateUiFrame(counts, level);
}

// --- the kiosk (#712) ----------------------------------------------------------

/** A box and its label on the page, in the kiosk frame's pixels: a Tips bubble points at it and keeps off it. */
function boxRect(e, b) {
  const l = S.labelPx && S.labelPx.get(e);
  const x0 = l ? Math.min(b.x, l.x) : b.x;
  const y0 = l ? Math.min(b.y, l.y) : b.y;
  const x1 = l ? Math.max(b.x + b.w, l.x + l.w) : b.x + b.w;
  const y1 = l ? Math.max(b.y + b.h, l.y + l.h) : b.y + b.h;
  return { left: x0 + (S.canvas.offsetLeft || 0), top: y0 + (S.canvas.offsetTop || 0), width: x1 - x0, height: y1 - y0 };
}

function toParent(msg) {
  if (S && S.narrate) return S.narrate(msg);
  try {
    if (window.parent && window.parent !== window) window.parent.postMessage(msg, location.origin);
  } catch {
    /* no parent */
  }
}

function startKiosk() {
  S.story = carveStory(S.scene);
  S.mode = "watch";
  S.insets = { top: 0, bottom: 0 };
  S.ui.classList.add("dots-kiosk", "dots-watch");
  if (S.keepBar) S.ui.classList.add("dots-keep-bar");
  S.userUntil = 0;
  S.holdUntil = null;
  S.tipFrom = -1;
  S.lastPost = 0;
  S.dir = null;
  const onMsg = (e) => {
    if (!S || e.origin !== location.origin || !e.data) return;
    if (e.data.type === "behold:dots-speed") {
      setSpeed(Number(e.data.speed) || 1);
      return;
    }
    if (e.data.type !== "behold:dots-mode") return;
    S.mode = e.data.mode === "inspect" ? "inspect" : "watch";
    S.ui.classList.toggle("dots-watch", S.mode === "watch");
    if (e.data.insets) S.insets = { top: Number(e.data.insets.top) || 0, bottom: Number(e.data.insets.bottom) || 0 };
    S.dirty = true;
  };
  window.addEventListener("message", onMsg);
  S.off.push(() => window.removeEventListener("message", onMsg));
  // The director never moves while a person has the graph in hand.
  watchViewer();
  S.camAt = null;
  play(true);
  toParent({ type: "behold:dots-ready", source: S.name });
}

/** A viewer has the camera: the director and the tour's framing wait until VIEWER_HOLD_MS after their last input, then ease back. */
function viewerHold() {
  if (S) S.userUntil = performance.now() + VIEWER_HOLD_MS;
}

/**
 * The director never moves while a person has the graph in hand: every input that moves the camera holds it, a wheel
 * or a trackpad pinch (a wheel with ctrlKey), a touch and each move of a pinch, a press and each move of a drag.
 */
function watchViewer() {
  const host = S.host;
  const dragging = (e) => {
    if (e.buttons) viewerHold();
  };
  for (const [ev, f] of [["wheel", viewerHold], ["pointerdown", viewerHold], ["mousedown", viewerHold], ["touchstart", viewerHold], ["touchmove", viewerHold], ["pointermove", dragging]]) {
    host.addEventListener(ev, f, { passive: true });
    S.off.push(() => host.removeEventListener(ev, f));
  }
}

/** A box in scene pitches, as the viewBox that frames it clear of the rail and the parent's caption. */
function frameBox(b) {
  const { r, left, right } = band();
  const P = S.pitch;
  const pad = 3.5;
  const bx = S.origin.x + (b.x - pad) * P;
  const by = S.origin.y + (b.y - pad) * P;
  const bw = (b.w + 2 * pad) * P;
  const bh = (b.h + 2 * pad) * P;
  const top = S.insets.top + 8;
  // The quiet controls at the foot, when the page keeps them, are furniture the boxes stay clear of.
  const foot = S.keepBar ? (S.ui.querySelector(".dots-bottom")?.offsetHeight ?? 0) + 12 : 0;
  const bottom = S.insets.bottom + 8 + foot;
  const aw = Math.max(40, r.width - left - right - 16);
  const ah = Math.max(40, r.height - top - bottom);
  // Never so close that a card shows again: dots stay dots.
  let s = Math.min(aw / bw, ah / bh, 20 / S.cardW);
  const vw = r.width / s;
  const vh = r.height / s;
  const vx = bx + bw / 2 - (left + 8 + aw / 2) / s;
  const vy = by + bh / 2 - (top + ah / 2) / s;
  return [vx, vy, vw, vh];
}

function unionBox(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function focusBox(focus) {
  const sc = S.scene;
  const now = sc.layoutAt(takeoffsBy(sc, S.t)).boxes;
  const fin = sc.layoutAt(sc.landing.length).boxes;
  const src = now.get(sc.source) || sc.layoutAt(0).boxes.get(sc.source);
  if (focus.kind === "all") return { x: 0, y: 0, w: sc.extent.w, h: sc.extent.h };
  if (focus.kind === "source" || focus.estate === sc.source) return src;
  // The estate receiving the flock, with the box it leaves, so the flight is in the shot.
  return unionBox(src, fin.get(focus.estate) || now.get(focus.estate));
}

function kioskTick(wall, dt) {
  // The loop: play, hold on the result, start again.
  if (S.t >= S.clock.length) {
    if (S.holdUntil === null) S.holdUntil = wall + LOOP.holdMs;
    else if (wall >= S.holdUntil) {
      S.holdUntil = null;
      seek(0);
      S.tipFrom = -1;
      play(true);
    }
  }
  const beat = beatAt(S.story, S.scene, S.t);
  // On a phone the scene is framed whole, so no estate sits under the timeline (estates compact to discs there).
  if (typeof innerWidth === "number" && innerWidth < 640) beat.focus = { kind: "all" };
  // The director: what the beat is about, eased in, never against a person's hand.
  S.directing = wall >= S.userUntil;
  // While the director holds the camera the rail steps aside, so no box is ever under it;
  // it comes back the moment a person takes the camera.
  S.ui.classList.toggle("dots-directing", S.directing);
  if (S.directing) {
    S.dir = directorFocus(S.dir, beat.focus, wall);
    const want = frameBox(focusBox(S.dir.focus));
    const cur = S.getVB();
    const k = S.camAt === null || S.reduced ? 1 : 1 - Math.exp(-dt / 650);
    S.camAt = wall;
    const w = Math.exp(lerp(Math.log(cur[2]), Math.log(want[2]), k));
    const h = (w * cur[3]) / cur[2];
    const cx = lerp(cur[0] + cur[2] / 2, want[0] + want[2] / 2, k);
    const cy = lerp(cur[1] + cur[3] / 2, want[1] + want[3] / 2, k);
    if (Math.abs(w - cur[2]) / cur[2] > 0.0005 || Math.abs(cx - cur[0] - cur[2] / 2) > cur[2] * 0.0005 || Math.abs(cy - cur[1] - cur[3] / 2) > cur[3] * 0.0005) {
      S.setVB([cx - w / 2, cy - h / 2, w, h]);
    }
  }
  // Tips for what has just played.
  const tips = S.playing || S.t >= S.clock.length ? tipsBetween(S.story, S.tipFrom, S.t) : [];
  S.tipFrom = S.t;
  if (wall - S.lastPost < 200 && !tips.length) return;
  S.lastPost = wall;
  const rects = {};
  for (const [e, b] of S.boxPx || []) rects[e] = boxRect(e, b);
  const counts = {};
  for (const [e, c] of countsNowMap()) counts[e] = c;
  const moves = S.story.moves;
  const done = moves.filter((f) => f.end <= S.t);
  toParent({
    type: "behold:dots-state",
    source: S.name,
    src: S.scene.source,
    t: S.t,
    length: S.clock.length,
    playing: S.playing,
    speed: S.speed,
    holdLeft: S.holdUntil === null ? null : Math.max(0, Math.ceil((S.holdUntil - wall) / 1000)),
    beat,
    counts,
    names: Object.fromEntries(S.scene.estates.map((e) => [e, shortOf(e, S.scene.source)])),
    recording: { kind: S.show.kind, resources: S.show.roster.length, recordedAt: S.show.recordedAt || null },
    colours: Object.fromEntries([...S.col.estate]),
    totals: { moves: moves.length, done: done.length, refused: done.filter((f) => !f.ok).length, estates: S.story.dests.length },
    log: done.slice(-14).reverse().map((f) => ({ address: f.address, to: shortOf(f.to, S.scene.source), ok: f.ok, refusal: f.refusal || null })),
    rects,
    tips,
  });
}

function countsNowMap() {
  return S.ownersNow ? [...S.ownersNow.values()].reduce((m, e) => m.set(e, (m.get(e) ?? 0) + 1), new Map()) : new Map();
}

// --- the live carve (#715) -------------------------------------------------------

/** Start following /api/terragucci/carve. `kiosk`: in the kiosk's frame, direct the camera while a migration runs. */
function startLive(kiosk) {
  S.ui.classList.add("dots-live");
  S.tipFrom = S.t = Date.now() - S.show.t0;
  S.clock.length = Math.max(S.clock.length, S.t);
  S.kioskLive = !!kiosk;
  S.liveEndAt = null;
  // What the first read holds already ended happened before the page looked: no end tip for it.
  S.ended = new Set((S.answer.migrations || []).filter((m) => !m.running).map((m) => m.name));
  S.wasActive = false;
  S.wasRunning = new Map((S.answer.migrations || []).map((m) => [m.name, m.running]));
  S.userUntil = 0;
  S.insets = { top: 0, bottom: 0 };
  S.mode = "watch";
  S.dir = null;
  S.camAt = null;
  S.lastPost = 0;
  S.pendingTips = [];
  busy();
  const poll = setInterval(() => void readLive(), LIVE_POLL_MS);
  S.off.push(() => clearInterval(poll));
  if (S.kioskLive) {
    const onMsg = (e) => {
      if (!S || e.origin !== location.origin || !e.data) return;
      if (e.data.type === "behold:dots-slowed") {
        liveSlowed = Number(e.data.n) || 1;
        return;
      }
      if (e.data.type !== "behold:dots-mode") return;
      S.mode = e.data.mode === "inspect" ? "inspect" : "watch";
      if (e.data.insets) S.insets = { top: Number(e.data.insets.top) || 0, bottom: Number(e.data.insets.bottom) || 0 };
      S.dirty = true;
    };
    window.addEventListener("message", onMsg);
    S.off.push(() => window.removeEventListener("message", onMsg));
    // The director never moves while a person has the graph in hand.
    watchViewer();
    toParent({ type: "behold:dots-ready", source: S.name, live: true });
  }
}

/** Until when something is in the air or about to be: the loop draws every frame until then. */
function busy() {
  let until = 0;
  for (const f of S.scene.flights) until = Math.max(until, f.end + 700);
  for (const e of S.show.events) if (e.kind === "adopt" && !e.before) until = Math.max(until, e.t - S.show.t0 + 400);
  S.busyUntil = until;
}

let liveReading = false;
async function readLive() {
  if (!S || !S.live || liveReading) return;
  liveReading = true;
  try {
    const res = await fetch("/api/terragucci/carve", { headers: { accept: "application/json" } });
    const a = await res.json();
    if (S && S.live && a && a.live === true) takeLive(a);
  } catch {
    /* the next poll asks again */
  } finally {
    liveReading = false;
  }
}

/** A new read of the carve: stamp what arrived, and rebuild the scene when the show changed. */
function takeLive(answer) {
  const now = Date.now();
  const seen = stampArrivals(answer, liveMemo ? liveMemo.seen : new Map(), now, { stepMs: stepMsFor(liveSlowed) });
  const show = liveShow(answer, seen, now, { t0: S.show.t0 });
  liveMemo = { seen, answer, t0: show.t0 };
  S.answer = answer;
  if (!show.roster.length) return;
  if (showKey(show) === showKey(S.show) && show.t0 === S.show.t0) {
    S.show.t1 = now;
    return;
  }
  const scene = buildScene(show, { sourceAspect: S.mbox.w / Math.max(1, S.mbox.h), ...labelRoom(S.host) });
  const n = show.roster.length;
  const src = scene.sourceBox;
  S.show = show;
  S.scene = scene;
  S.clock = replayClock(show);
  S.t = now - show.t0;
  S.clock.length = Math.max(S.clock.length, S.t);
  S.origin = { x: S.mbox.x + (S.mbox.w - src.w * S.pitch) / 2, y: S.mbox.y + (S.mbox.h - src.h * S.pitch) / 2 };
  S.firsts = firstLandings(scene);
  S.addrs = show.roster.map((r) => r.address);
  S.idx = new Map(show.roster.map((r, i) => [r.address, i]));
  S.px = new Float32Array(n);
  S.py = new Float32Array(n);
  S.pvis = new Uint8Array(n);
  S.pw = new Float32Array(n);
  S.ph = new Float32Array(n);
  // A later read may name a type the first did not, and the boxes the cards fill are the new scene's.
  fitRosterCards();
  S.col = readColours();
  busy();
  S.dirty = true;
}

/** Each frame of a live carve: whether the director has the camera, and what the kiosk is told. */
function liveTick(wall, dt) {
  const answer = S.answer || {};
  const m = currentMigration(answer);
  const now = Date.now();
  // A migration that stopped running ends its beat: Watch holds on the result, then hands the camera back.
  for (const x of answer.migrations || []) {
    const was = S.wasRunning.get(x.name);
    if (was && !x.running && !S.ended.has(x.name)) {
      S.ended.add(x.name);
      S.liveEndAt = now;
      S.pendingTips.push(liveEndTip(x, S.t));
    }
    S.wasRunning.set(x.name, x.running);
  }
  const running = !!(answer.running || (m && m.running));
  // Lines still playing count as running: an adoption on floci writes its 82 lines in under a second, and the record
  // says applied by the read that brings them, so the beat is the 50 ms pacing of those lines (web/dots-live.js).
  const playing = S.t < (S.busyUntil ?? 0);
  const active = running || playing;
  // When the last of it has played, Watch holds on the result, then hands the camera back.
  if (S.wasActive && !active) {
    S.liveEndAt = now;
    // A migration that was done by the read that brought its lines ends here, once they have played.
    for (const x of answer.migrations || []) {
      if (x.running || S.ended.has(x.name) || !x.lines.length) continue;
      S.ended.add(x.name);
      S.pendingTips.push(liveEndTip(x, S.t));
    }
  }
  S.wasActive = active;
  // The tour (behold.tour/v1), in Watch: the chapter the cycle's events have reached. While it runs, the carve keeps the camera.
  const tn = tourNow(answer);
  S.tourOn = !!(S.kioskLive && tn && tn.at && S.mode === "watch");
  S.tn = tn;
  const carving = S.kioskLive && (S.tourOn || active || (S.liveEndAt !== null && now - S.liveEndAt < LIVE_HOLD_MS));
  if (carving !== S.carving) {
    S.carving = carving;
    S.ui.classList.toggle("dots-carving", carving);
    S.dir = null;
    S.camAt = null;
    if (S.onCarving) S.onCarving(carving);
  }
  if (!S.kioskLive) return;
  // The counts the page has played so far: the caption, the next line and the tally all follow the paced lines,
  // and show the record's own once every line has played.
  const shown = m ? playedCounts(m, liveMemo ? liveMemo.seen : new Map(), S.show.t0 + S.t) : null;
  const beat = liveBeat(S.scene, S.t, { demo: answer.demo, migration: m, shown });
  // In Inspect too: while a migration runs its boxes and dots are the story, so the director frames them there as well,
  // unless a person has the graph in hand.
  S.directing = carving && performance.now() >= S.userUntil;
  S.ui.classList.toggle("dots-directing", S.directing);
  if (S.directing) {
    // On a tour, the chapter says what to frame, except while a migration's writes are landing: the flock leads then.
    const focus = S.tourOn && !active ? tourFocus(tn, S.scene.estates, answer.adopted) : beat.focus;
    S.dir = directorFocus(S.dir, focus, wall);
    const want = frameBox(focusBox(S.dir.focus));
    const cur = S.getVB();
    const k = S.camAt === null || S.reduced ? 1 : 1 - Math.exp(-dt / 650);
    S.camAt = wall;
    const w = Math.exp(lerp(Math.log(cur[2]), Math.log(want[2]), k));
    const h = (w * cur[3]) / cur[2];
    const cx = lerp(cur[0] + cur[2] / 2, want[0] + want[2] / 2, k);
    const cy = lerp(cur[1] + cur[3] / 2, want[1] + want[3] / 2, k);
    if (Math.abs(w - cur[2]) / cur[2] > 0.0005 || Math.abs(cx - cur[0] - cur[2] / 2) > cur[2] * 0.0005 || Math.abs(cy - cur[1] - cur[3] / 2) > cur[3] * 0.0005) {
      S.setVB([cx - w / 2, cy - h / 2, w, h]);
    }
  }
  // A tour's pulses and travelling values animate: draw every frame while one is on.
  if (S.tourOn && S.fx && (S.fx.pulses.length || S.fx.travel)) S.dirty = true;
  // A chapter or visual that has just fired is drawn now, not at the next camera move.
  const tk = S.tourOn ? fxKey(tn) : "";
  if (tk !== S.tourKey) {
    S.tourKey = tk;
    S.dirty = true;
  }
  // Tips for what has just been written: never for what the first read already held.
  const tips = [...liveTipsBetween(S.scene, S.tipFrom, S.t), ...S.pendingTips.splice(0)];
  S.tipFrom = S.t;
  if (wall - S.lastPost < 250 && !tips.length) return;
  S.lastPost = wall;
  const rects = {};
  for (const [e, b] of S.boxPx || []) rects[e] = boxRect(e, b);
  const counts = {};
  for (const [e, c] of countsNowMap()) counts[e] = c;
  const story = carveStory(S.scene);
  const done = story.moves.filter((f) => f.end <= S.t);
  const mc = shown ? shown.counts : null;
  toParent({
    type: "behold:dots-state",
    live: true,
    carving,
    source: S.name,
    src: S.scene.source,
    t: S.t,
    length: S.clock.length,
    playing: true,
    speed: 1,
    holdLeft: null,
    beat,
    counts,
    names: Object.fromEntries(S.scene.estates.map((e) => [e, shortOf(e, S.scene.source)])),
    recording: { kind: "live", resources: S.show.roster.length, recordedAt: null, from: answer.source || null, migration: m ? m.name : null },
    colours: Object.fromEntries([...S.col.estate]),
    totals: mc
      ? { moves: mc.moved + mc.stamped + mc.refused + mc.skipped + (mc.left ?? 0), done: mc.moved + mc.stamped + mc.refused + mc.skipped, refused: mc.refused, estates: story.dests.length, moved: mc.moved, stamped: mc.stamped, skipped: mc.skipped }
      : { moves: story.moves.length, done: done.length, refused: done.filter((f) => !f.ok).length, estates: story.dests.length },
    log: done.slice(-14).reverse().map((f) => ({ address: f.address, to: shortOf(f.to, S.scene.source), ok: f.ok, refusal: f.refusal || null })),
    rects,
    tips,
    // The live badge's lag: the newest line's time, and whether a migration runs (web/tour-player.js lagText).
    lastWriteAt: newestLineAt(answer),
    running,
    slowed: liveSlowed,
    ...(S.tourOn ? { tour: tourMessage(tn, { counts: countsNowMap(), names: S.scene.estates, adopted: answer.adopted, source: S.scene.source, short: tourShort }) } : {}),
  });
}

/** A box's name in the tour's notes: as the box shows it, less the prefix every box's name shares (a cycle's `tl56-`). */
function tourShort(e) {
  const shown = S.scene.estates.map((x) => shortName(x));
  const nm = shortName(e);
  let pre = shown.length > 1 ? shown[0] : "";
  for (const x of shown) while (pre && !x.startsWith(pre)) pre = pre.slice(0, -1);
  const cut = pre.lastIndexOf("-");
  return cut > 0 && nm.length > cut + 1 ? nm.slice(cut + 1) : nm;
}

/** The newest progress line's time across the cycle's migrations, in ms; null with none. */
function newestLineAt(answer) {
  let at = null;
  for (const m of (answer && answer.migrations) || [])
    for (const l of m.lines) {
      const t = Date.parse(l.at);
      if (!Number.isNaN(t) && (at === null || t > at)) at = t;
    }
  return at;
}

/** The tour's visuals for this frame, rebuilt only when the chapter, its visuals or the dots' owners change. */
function currentFx(owners) {
  if (!S.tourOn || !S.tn) return null;
  const key = fxKey(S.tn, `${S.show.events.length}|${S.scene.estates.join(",")}|${[...countsNowOf(owners)].join(",")}`);
  if (S.fxKey !== key) {
    S.fx = tourFx(S.tn, { ids: S.addrs, owners, names: S.scene.estates, adopted: S.answer && S.answer.adopted, source: S.scene.source });
    S.fxKey = key;
  }
  return S.fx;
}

function countsNowOf(owners) {
  const m = new Map();
  for (const e of owners.values()) m.set(e, (m.get(e) ?? 0) + 1);
  return m;
}

/** A small chip in the canvas: a rounded box with words, in a colour; returns its width. */
function chip(ctx, x, y, words, colour, { align = "left", fg = null } = {}) {
  ctx.font = `600 11px ${S.font}`;
  const w = ctx.measureText(words).width + 14;
  const h = 18;
  const x0 = align === "right" ? x - w : x;
  ctx.globalAlpha = 0.92;
  roundRect(ctx, x0, y, w, h, 5);
  ctx.fillStyle = S.col.bg;
  ctx.fill();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = fg || colour;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(words, x0 + 7, y + h / 2 + 0.5);
  return w;
}

/** The tour's own marks over the boxes: a wave's pulse, the value along the read threads, the state file, the checks. */
function drawTour(ctx, fx, boxes, boxPx, centre, sx, sy, dotLayerA, td, discR) {
  if (!fx || dotLayerA < 0.3) return;
  const col = S.col;
  const now = Date.now();
  // A box drawn as its disc (far out, or a phone) takes its marks beside the disc.
  const disc = (e) => (td.get(e) ?? 0) >= 0.5;
  const discSpot = (e) => {
    const c = centre(e);
    return { x: sx(c.x) + discR(e) + 6, y: sy(c.y) - 9 };
  };
  // A wave's pulse: the box's outline breathes in the in-progress colour while its plan runs.
  for (const e of fx.pulses) {
    const b = boxes.get(e);
    if (!b) continue;
    const bp = boxPx(b);
    const u = S.reduced ? 0.6 : 0.5 + 0.5 * Math.sin(now / 260);
    if (disc(e)) {
      const c = centre(e);
      ctx.globalAlpha = 0.35 + 0.55 * u;
      ctx.strokeStyle = col.pending;
      ctx.lineWidth = 2 + 2 * u;
      ctx.beginPath();
      ctx.arc(sx(c.x), sy(c.y), discR(e) + 5, 0, Math.PI * 2);
      ctx.stroke();
      continue;
    }
    ctx.globalAlpha = 0.35 + 0.55 * u;
    ctx.strokeStyle = col.pending;
    ctx.lineWidth = 2 + 2.5 * u;
    roundRect(ctx, bp.x - 3, bp.y - 3, bp.w + 6, bp.h + 6, 14);
    ctx.stroke();
  }
  // The read threads, reader to source, and the output's planned value travelling along them to each reader.
  if (fx.travel) {
    for (const th of fx.travel.threads) {
      if (!boxes.has(th.from) || !boxes.has(th.to)) continue;
      const a = centre(th.from);
      const b = centre(th.to);
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = col.runtime;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([6, 6]);
      ctx.lineDashOffset = S.reduced ? 0 : -((performance.now() / 40) % 12);
      ctx.beginPath();
      ctx.moveTo(sx(a.x), sy(a.y));
      ctx.lineTo(sx(b.x), sy(b.y));
      ctx.stroke();
      ctx.setLineDash([]);
      if (fx.travel.value === null || fx.travel.value === undefined) continue;
      // From when the wave's job ended (its event), 1.8 s along the thread; then it rests at the reader.
      const u = S.reduced || fx.travel.at === null ? 1 : Math.max(0, Math.min(1, (now - fx.travel.at) / 1800));
      const e = easeInOut(u);
      const x = sx(lerp(a.x, b.x, e));
      const y = sy(lerp(a.y, b.y, e));
      ctx.globalAlpha = 1;
      ctx.fillStyle = col.runtime;
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      chip(ctx, x + 8, y - 9, String(fx.travel.value), col.runtime, { fg: col.fg });
    }
  }
  // The state file the adoption bound: its version id, and "unchanged" once the stamps are done.
  if (fx.state) {
    const b = boxes.get(fx.state.box);
    if (b) {
      const bp = boxPx(b);
      const words = `state file · ${String(fx.state.version).slice(0, 8)}${fx.state.unchanged ? " · unchanged" : ""}`;
      if (disc(fx.state.box)) {
        const p = discSpot(fx.state.box);
        chip(ctx, p.x, p.y, words, fx.state.unchanged ? col.managed : col.muted, { fg: col.fg });
      } else {
        // Above the box's right end when there is room beside its label; else under the box, so it never covers the label.
        ctx.font = `600 11px ${S.font}`;
        const room = ctx.measureText(words).width + 14 <= bp.w * 0.55;
        if (room) chip(ctx, bp.x + bp.w, bp.y - 24, words, fx.state.unchanged ? col.managed : col.muted, { align: "right", fg: col.fg });
        else chip(ctx, bp.x, bp.y + bp.h + 6, words, fx.state.unchanged ? col.managed : col.muted, { fg: col.fg });
      }
    }
  }
  // The post-write check: each root that plans no change after the write.
  for (const [e, ok] of fx.checks) {
    const b = boxes.get(e);
    if (!b) continue;
    const bp = boxPx(b);
    if (disc(e)) {
      const p = discSpot(e);
      chip(ctx, p.x, p.y + 20, ok ? "✓" : "✗", ok ? col.managed : col.degraded, { fg: col.fg });
      continue;
    }
    // Inside the box's foot, so it never sits on the box below; a box too narrow for the words takes the mark alone.
    ctx.font = `600 11px ${S.font}`;
    const words = ok ? "✓ plans no change" : "plans a change";
    const fits = ctx.measureText(words).width + 26 <= bp.w;
    chip(ctx, bp.x + 6, bp.y + bp.h - 24, fits ? words : ok ? "✓" : "✗", ok ? col.managed : col.degraded, { fg: col.fg });
  }
  ctx.globalAlpha = 1;
}
