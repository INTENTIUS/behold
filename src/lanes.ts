/**
 * The lanes view (#5) + lanes↔graph coupling (#6). pinhole's frame morph is the
 * graph; behold injects a per-substrate filmstrip and the coupling below it.
 *
 * Two cursors (concept): a **time** cursor (the playhead — scrubs, drives the morph
 * via `applyView(i)`) and a **focus** cursor (a selected graph node — highlights the
 * frames where it changed). Plus a **frame-pair diff** (shift-click two frames →
 * added/removed/changed, computed from behold's own frame IRs) and per-lane
 * **offset** (drag a row in time; graph-inert — the graph always reflects real time).
 */
import { renderMorphHtml, layoutIr, type MorphView } from "@intentius/pinhole";
import type { Frame, FrameSummary } from "./frames.ts";

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Per-frame data the coupling needs: node → drift status, node → substrate. */
interface LaneFrame {
  t: number;
  name: string;
  byLexicon: Record<string, number>;
  status: Record<string, string>;
  lexicon: Record<string, string>;
}

const LANES_CSS = `
#behold-lanes { position: fixed; left: 0; right: 0; bottom: 0; background: #0d1117;
  border-top: 1px solid #30363d; padding: 8px 12px 10px; font: 12px ui-sans-serif, system-ui, sans-serif; color: #8b949e; }
#behold-lanes .hd { display: flex; gap: 14px; align-items: baseline; margin-bottom: 4px; }
#behold-lanes .hd .rt { color: #d29922; }
#behold-lanes canvas { display: block; width: 100%; cursor: pointer; }
#behold-diff { position: fixed; right: 12px; bottom: 156px; width: 260px; max-height: 40vh; overflow: auto;
  background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 10px 12px; font: 12px ui-sans-serif, system-ui, sans-serif;
  color: #e6edf3; display: none; }
#behold-diff h4 { margin: 0 0 6px; font-size: 12px; color: #8b949e; }
#behold-diff .a { color: #3fb950; } #behold-diff .r { color: #f85149; } #behold-diff .c { color: #d29922; }
body { padding-bottom: 150px; }`;

function laneStripScript(frames: LaneFrame[]): string {
  return `<script>
const LF = ${safeJson(frames)};
(function () {
  const host = document.getElementById("behold-lanes-canvas");
  if (!host || LF.length < 1) return;
  const subs = [...new Set(LF.flatMap(f => Object.keys(f.byLexicon)))].sort();
  const rowH = 22, padL = 96, padR = 16, padT = 6;
  const H = padT + subs.length * rowH + 24;
  const t0 = LF[0].t, tN = LF[LF.length - 1].t, span = Math.max(1, tN - t0);
  const offset = {}; // per-substrate time offset (graph-inert)
  let cur = LF.length - 1, focus = null, pair = null;

  function baseX(i) { const W = host.clientWidth - padL - padR;
    const frac = span > 1 ? (LF[i].t - t0) / span : (LF.length > 1 ? i / (LF.length - 1) : 0); return padL + frac * W; }
  function xOf(i, sub) { const W = host.clientWidth - padL - padR; return baseX(i) + ((offset[sub] || 0) / span) * W; }
  const anyOffset = () => subs.some(s => offset[s]);

  function changedAt(id, i) { // node changed vs previous frame (appear/vanish/status)
    const now = LF[i].status[id], prev = i > 0 ? LF[i-1].status[id] : undefined;
    const inNow = now !== undefined, inPrev = prev !== undefined;
    return inNow !== inPrev || (inNow && inPrev && now !== prev);
  }
  const color = s => s === "good" ? "#3fb950" : s === "warn" ? "#d29922" : s === "accent" ? "#58a6ff" : "#6e7681";

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    host.width = host.clientWidth * dpr; host.height = H * dpr; host.style.height = H + "px";
    const c = host.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, host.clientWidth, H); c.font = "12px ui-sans-serif, system-ui, sans-serif";
    subs.forEach((s, r) => {
      const y = padT + r * rowH + rowH / 2;
      c.fillStyle = offset[s] ? "#d29922" : "#8b949e"; c.textAlign = "left"; c.fillText(s, 8, y + 4);
      c.strokeStyle = "#21262d"; c.beginPath(); c.moveTo(padL, y); c.lineTo(host.clientWidth - padR, y); c.stroke();
      LF.forEach((f, i) => {
        if (!f.byLexicon[s]) return;
        // dot per substrate; brighter when a node in this substrate changed at i
        const changed = Object.keys(f.status).some(id => f.lexicon[id] === s && changedAt(id, i));
        const hi = focus && f.lexicon[focus] === s && changedAt(focus, i);
        c.fillStyle = hi ? "#f0f6fc" : changed ? color(mode(f, s)) : "#30363d";
        c.beginPath(); c.arc(xOf(i, s), y, i === cur ? 5 : hi ? 4.5 : 3.5, 0, 7); c.fill();
      });
    });
    const px = baseX(cur); c.strokeStyle = "#58a6ff"; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(px, padT - 2); c.lineTo(px, padT + subs.length * rowH); c.stroke();
    if (pair != null) { const qx = baseX(pair); c.strokeStyle = "#d29922"; c.setLineDash([3,3]);
      c.beginPath(); c.moveTo(qx, padT - 2); c.lineTo(qx, padT + subs.length * rowH); c.stroke(); c.setLineDash([]); }
    c.fillStyle = "#e6edf3"; c.textAlign = "center"; c.fillText(LF[cur].name, px, padT + subs.length * rowH + 16);
    document.getElementById("behold-lanes-meta").textContent =
      LF.length + " frames · frame " + (cur + 1) + "/" + LF.length + (focus ? " · focus " + focus : "");
    document.getElementById("behold-lanes-rt").style.display = anyOffset() ? "inline" : "none";
  }
  function mode(f, s) { for (const id in f.status) if (f.lexicon[id] === s) return f.status[id]; return ""; }

  function nearest(clientX) { const rect = host.getBoundingClientRect(); const x = clientX - rect.left;
    let best = 0, bd = Infinity; for (let i = 0; i < LF.length; i++) { const d = Math.abs(baseX(i) - x); if (d < bd) { bd = d; best = i; } } return best; }
  function rowAt(clientY) { const rect = host.getBoundingClientRect(); const r = Math.floor((clientY - rect.top - padT) / rowH); return subs[r]; }
  function go(i) { cur = Math.max(0, Math.min(LF.length - 1, i)); if (window.applyView) window.applyView(cur); draw(); }

  function showDiff() {
    const panel = document.getElementById("behold-diff");
    if (pair == null) { panel.style.display = "none"; return; }
    const a = LF[Math.min(cur, pair)].status, b = LF[Math.max(cur, pair)].status;
    const added = [], removed = [], changed = [];
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(id in a)) added.push(id); else if (!(id in b)) removed.push(id); else if (a[id] !== b[id]) changed.push(id);
    }
    panel.innerHTML = "<h4>frame diff " + (Math.min(cur,pair)+1) + " → " + (Math.max(cur,pair)+1) + "</h4>" +
      added.map(x => '<div class="a">+ ' + x + '</div>').join("") +
      removed.map(x => '<div class="r">- ' + x + '</div>').join("") +
      changed.map(x => '<div class="c">~ ' + x + '</div>').join("") ||
      "<h4>frame diff</h4><div>no change</div>";
    panel.style.display = "block";
  }

  // playhead (time cursor) + shift-click = pair diff + drag a row = offset (graph-inert)
  let dragRow = null;
  host.addEventListener("mousedown", (e) => {
    if (e.clientX - host.getBoundingClientRect().left < padL) { dragRow = rowAt(e.clientY); return; } // label gutter → offset drag
    if (e.shiftKey) { pair = nearest(e.clientX); showDiff(); draw(); }
    else { pair = null; showDiff(); go(nearest(e.clientX)); }
  });
  window.addEventListener("mousemove", (e) => { if (dragRow) { const W = host.clientWidth - padL - padR;
    offset[dragRow] = ((e.movementX) / W) * span + (offset[dragRow] || 0); draw(); } });
  window.addEventListener("mouseup", () => (dragRow = null));
  window.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") go(cur - 1); if (e.key === "ArrowRight") go(cur + 1);
    if (e.key === "Escape") { focus = null; pair = null; showDiff(); draw(); } });
  window.addEventListener("resize", draw);

  // focus cursor: click a graph node → highlight where it changed (graph → lanes)
  function wireNodes() { document.querySelectorAll("[data-node-id]").forEach(el => {
    el.style.cursor = "pointer";
    el.addEventListener("click", () => { focus = el.getAttribute("data-node-id"); draw(); }, true); }); }
  wireNodes();

  go(LF.length - 1);
})();
</script>`;
}

/** Render the lanes page: the frame morph (graph) + the coupled filmstrip. */
export function renderLanes(frames: Frame[], summaries: FrameSummary[]): string {
  const views: MorphView[] = frames.map((f, i) => ({
    name: summaries[i]?.t ? new Date(summaries[i].t).toISOString().slice(11, 19) : `t${i}`,
    ir: f.ir,
    layout: layoutIr(f.ir),
  }));
  const doc = renderMorphHtml(views, { title: "Deployment lanes" });

  const laneFrames: LaneFrame[] = frames.map((f, i) => ({
    t: summaries[i].t,
    name: new Date(summaries[i].t).toISOString().slice(11, 19),
    byLexicon: summaries[i].byLexicon,
    status: Object.fromEntries(f.ir.nodes.map((n) => [n.id, (n.attrs as { _status?: string })?._status ?? ""])),
    lexicon: Object.fromEntries(f.ir.nodes.map((n) => [n.id, n.lexicon])),
  }));

  const strip =
    `<style>${LANES_CSS}</style>` +
    `<div id="behold-diff"></div>` +
    `<div id="behold-lanes"><div class="hd"><span>deployment lanes</span>` +
    `<span id="behold-lanes-meta"></span><span class="rt" id="behold-lanes-rt" style="display:none">offset — graph shows real time</span></div>` +
    `<canvas id="behold-lanes-canvas"></canvas></div>` +
    laneStripScript(laneFrames);
  return doc.includes("</body>") ? doc.replace("</body>", `${strip}</body>`) : doc + strip;
}
