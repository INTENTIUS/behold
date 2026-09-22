// One benchmark run in the page (#457): ?renderer=&n=&scenario=&frames=
// Leaves its result on window.benchResult for scripts/dot-bench/run.mjs.
//
// Scenarios, every one run for the same number of animation frames:
//   recolour  10% of dots take a new colour each frame, nothing moves. A replay
//             played fast: each frame lands a batch of ownership changes.
//   travel    the same recolour, and 2% of dots are travelling to a new slot
//             at any moment, each trip 60 frames long.
//   orbit     every dot moves every frame. The worst case for "untaggable
//             children orbit their parent" if the orbit is animated.
//
// Measured: `create` (first paint, ms), per-frame `js` (the renderer's own
// frame() call, ms), per-frame `interval` (rAF to rAF, ms, which is where SVG's
// style, layout and paint cost lands since none of it is script), and hit
// testing (`hitMs`, per query, over 2000 random points after the run).

import { RENDERERS } from "./renderers.js";

const PALETTE = ["#4c78a8", "#f58518", "#54a24b", "#e45756", "#72b7b2", "#b279a2"];

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantiles(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { p50: q(0.5), p95: q(0.95), max: s[s.length - 1], mean };
}

function makeState(n, w, h, rand) {
  const cols = Math.ceil(Math.sqrt((n * w) / h));
  const rows = Math.ceil(n / cols);
  const sx = w / (cols + 1);
  const sy = h / (rows + 1);
  const state = {
    n, w, h, palette: PALETTE,
    r: Math.max(1.5, Math.min(sx, sy) * 0.3),
    x: new Float32Array(n), y: new Float32Array(n),
    homeX: new Float32Array(n), homeY: new Float32Array(n),
    color: new Uint8Array(n),
  };
  for (let i = 0; i < n; i++) {
    state.homeX[i] = state.x[i] = ((i % cols) + 1) * sx;
    state.homeY[i] = state.y[i] = (Math.floor(i / cols) + 1) * sy;
    state.color[i] = Math.floor(rand() * PALETTE.length);
  }
  return state;
}

function nextFrame() { return new Promise((r) => requestAnimationFrame(r)); }

async function baselineInterval(frames = 60) {
  let last = await nextFrame();
  const xs = [];
  for (let i = 0; i < frames; i++) { const t = await nextFrame(); xs.push(t - last); last = t; }
  return quantiles(xs).p50;
}

async function run() {
  const p = new URLSearchParams(location.search);
  const name = p.get("renderer");
  const n = Number(p.get("n"));
  const scenario = p.get("scenario") || "recolour";
  const frames = Number(p.get("frames") || 240);
  const host = document.getElementById("host");
  const w = host.clientWidth;
  const h = host.clientHeight;
  const rand = mulberry32(457);
  const state = makeState(n, w, h, rand);

  const refresh = await baselineInterval();

  const t0 = performance.now();
  const r = await RENDERERS[name](host, state);
  await nextFrame();
  const create = performance.now() - t0;

  const recolour = Math.max(1, Math.round(n * 0.1));
  const travellers = scenario === "travel" ? Math.max(1, Math.round(n * 0.02)) : 0;
  const trips = [];
  for (let k = 0; k < travellers; k++) trips.push({ i: Math.floor(rand() * n), t: Math.floor(rand() * 60), fx: 0, fy: 0, tx: 0, ty: 0 });
  const js = [];
  const intervals = [];
  let last = await nextFrame();
  for (let f = 0; f < frames; f++) {
    const changed = new Set();
    for (let k = 0; k < recolour; k++) {
      const i = Math.floor(rand() * n);
      state.color[i] = (state.color[i] + 1 + Math.floor(rand() * (PALETTE.length - 1))) % PALETTE.length;
      changed.add(i);
    }
    let moved = false;
    for (const trip of trips) {
      if (trip.t % 60 === 0) {
        trip.i = Math.floor(rand() * n);
        trip.fx = state.homeX[trip.i]; trip.fy = state.homeY[trip.i];
        const j = Math.floor(rand() * n);
        trip.tx = state.homeX[j]; trip.ty = state.homeY[j];
      }
      const u = (trip.t % 60) / 59;
      state.x[trip.i] = trip.fx + (trip.tx - trip.fx) * u;
      state.y[trip.i] = trip.fy + (trip.ty - trip.fy) * u;
      trip.t++;
      changed.add(trip.i);
      moved = true;
    }
    if (scenario === "orbit") {
      const a = f * 0.1;
      for (let i = 0; i < n; i++) {
        state.x[i] = state.homeX[i] + Math.cos(a + i) * state.r;
        state.y[i] = state.homeY[i] + Math.sin(a + i) * state.r;
        changed.add(i);
      }
      moved = true;
    }
    const s = performance.now();
    r.frame(changed, moved);
    js.push(performance.now() - s);
    const t = await nextFrame();
    intervals.push(t - last);
    last = t;
  }

  const rect = host.getBoundingClientRect();
  const queries = 2000;
  let found = 0;
  const hs = performance.now();
  for (let q = 0; q < queries; q++) {
    const i = Math.floor(rand() * n);
    const x = state.x[i] + (rand() - 0.5) * state.r;
    const y = state.y[i] + (rand() - 0.5) * state.r;
    if (r.hit(rect.left + x, rect.top + y) === i || r.hit(x, y) === i) found++;
  }
  const hitMs = (performance.now() - hs) / queries;

  let glRenderer = null;
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    glRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl && gl.getParameter(gl.RENDERER);
  } catch { /* none */ }

  r.destroy();
  const iv = quantiles(intervals);
  window.benchResult = {
    renderer: name, n, scenario, frames, w, h, dpr: window.devicePixelRatio, refresh, glRenderer,
    create, js: quantiles(js), interval: iv,
    fps: 1000 / iv.mean,
    isolated: window.crossOriginIsolated,
    dropped: intervals.filter((x) => x > refresh * 1.5).length,
    hitMs, hitFound: found / queries,
  };
}

run().catch((err) => { window.benchResult = { error: String(err && err.stack || err) }; });
