// The replay prototype (#457): one dot per resource of a carve recording,
// coloured by owner at the scrubber's position. ?rec=<path to .jsonl>
//
// Positions come from ./layout.js and never change; a move recolours its dot
// (and its followers) in place, and draws a short trail from the dot to its
// new estate's legend entry that fades over ~0.5 s. Canvas 2D, because the
// measurements in docs/design/dot-estates.md put it far inside a frame at 1k
// with no library. Hover is ./grid.js.

import { layout } from "./layout.js";
import { readRecording, ownersAt } from "./recording.js";
import { GridIndex } from "./grid.js";

const PALETTE = ["#9aa0a6", "#4c78a8", "#f58518", "#54a24b", "#e45756", "#72b7b2", "#b279a2", "#eeca3b", "#9d755d"];

const params = new URLSearchParams(location.search);
const src = params.get("rec");
const res = await fetch(src);
// The committed recording is gzipped (scripts/dot-bench/carve-terralith-14.jsonl.gz).
const text = src.endsWith(".gz") || params.get("gz") === "1"
  ? await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text()
  : await res.text();
const rec = readRecording(text);
const host = document.getElementById("host");
const W = host.clientWidth;
const H = host.clientHeight;
const { positions } = layout(rec.roster, { spacing: 9, width: W - 220 });
const parentOf = (a) => positions.get(a)?.parent;

const colour = new Map(rec.estates.map((e, i) => [e, PALETTE[i % PALETTE.length]]));
const legend = document.getElementById("legend");
const legendAt = new Map();
rec.estates.forEach((e, i) => {
  const row = document.createElement("div");
  row.innerHTML = `<i style="background:${colour.get(e)}"></i><span></span>`;
  row.querySelector("span").textContent = e === rec.header.source ? `${e} (source)` : e.replace(`${rec.header.source}-`, "");
  legend.appendChild(row);
});

const dpr = window.devicePixelRatio || 1;
const canvas = document.createElement("canvas");
canvas.width = W * dpr; canvas.height = H * dpr;
canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
host.appendChild(canvas);
const ctx = canvas.getContext("2d");

const addrs = rec.roster.map((r) => r.address);
const state = { n: addrs.length, w: W, h: H, r: 3.2, x: new Float32Array(addrs.length), y: new Float32Array(addrs.length) };
addrs.forEach((a, i) => { const p = positions.get(a); state.x[i] = p.x + 10; state.y[i] = p.y + 10; });
const grid = new GridIndex(state);
const index = new Map(addrs.map((a, i) => [a, i]));

for (const [i, row] of [...legend.children].entries()) {
  const r = row.getBoundingClientRect();
  legendAt.set(rec.estates[i], { x: r.left + 8, y: r.top + r.height / 2 });
}

let upto = 0;
let owners = ownersAt(rec, 0, parentOf);
const trails = [];

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const buckets = new Map();
  for (let i = 0; i < state.n; i++) {
    const e = owners.get(addrs[i]) ?? rec.header.source;
    let b = buckets.get(e);
    if (!b) buckets.set(e, (b = []));
    b.push(i);
  }
  for (const [e, idx] of buckets) {
    ctx.beginPath();
    for (const i of idx) { ctx.moveTo(state.x[i] + state.r, state.y[i]); ctx.arc(state.x[i], state.y[i], state.r, 0, Math.PI * 2); }
    ctx.fillStyle = colour.get(e) ?? "#000";
    ctx.fill();
  }
  const now = performance.now();
  for (let k = trails.length - 1; k >= 0; k--) {
    const tr = trails[k];
    const age = (now - tr.born) / 500;
    if (age >= 1) { trails.splice(k, 1); continue; }
    ctx.strokeStyle = tr.colour;
    ctx.globalAlpha = 1 - age;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(tr.x, tr.y); ctx.lineTo(tr.x + (tr.tx - tr.x) * Math.min(1, age * 2), tr.y + (tr.ty - tr.y) * Math.min(1, age * 2)); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  document.getElementById("clock").textContent = `move ${upto} / ${rec.timeline.length}`;
}

function seek(k, animate = false) {
  const prev = upto;
  upto = Math.max(0, Math.min(rec.timeline.length, k));
  owners = ownersAt(rec, upto, parentOf);
  if (animate) {
    for (const m of rec.timeline) {
      if (m.seq <= prev || m.seq > upto || !m.ok) continue;
      const i = index.get(m.address);
      const to = legendAt.get(m.to);
      if (i === undefined || !to) continue;
      trails.push({ x: state.x[i], y: state.y[i], tx: to.x, ty: to.y, colour: colour.get(m.to), born: performance.now() });
    }
  }
  scrub.value = String(upto);
}

const scrub = document.getElementById("scrub");
scrub.max = String(rec.timeline.length);
scrub.addEventListener("input", () => seek(Number(scrub.value)));
let playing = false;
document.getElementById("play").addEventListener("click", () => { playing = !playing; });

canvas.addEventListener("mousemove", (ev) => {
  const r = canvas.getBoundingClientRect();
  const i = grid.nearest(state, ev.clientX - r.left, ev.clientY - r.top);
  const tip = document.getElementById("tip");
  if (i < 0) { tip.style.display = "none"; return; }
  const a = addrs[i];
  tip.textContent = `${a} · ${owners.get(a)}${parentOf(a) ? ` · child of ${parentOf(a)}` : ""}`;
  tip.style.left = `${ev.clientX + 12}px`; tip.style.top = `${ev.clientY + 12}px`; tip.style.display = "block";
});

let last = performance.now();
function tick(t) {
  if (playing && t - last > 16) { seek(upto + 2, true); last = t; if (upto >= rec.timeline.length) playing = false; }
  draw();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
window.replay = { seek, rec, count: () => ({ dots: state.n, moves: rec.timeline.length }) };
