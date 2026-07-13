/**
 * The lanes view (#5): pinhole's frame morph (the graph, driven by a playhead)
 * with a per-substrate filmstrip injected below it. behold owns the temporal
 * control; pinhole owns the graph morph (renderMorphHtml, #81). The playhead calls
 * the morph doc's global `applyView(i)`, so scrubbing steps the graph between
 * cached keyframe IRs with stable identity.
 */
import { renderMorphHtml, layoutIr, type MorphView } from "@intentius/pinhole";
import type { Frame, FrameSummary } from "./frames.ts";

/** `<`-safe JSON for embedding in a <script>. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const LANES_CSS = `
#behold-lanes { position: fixed; left: 0; right: 0; bottom: 0; background: #0d1117;
  border-top: 1px solid #30363d; padding: 8px 12px 10px; font: 12px ui-sans-serif, system-ui, sans-serif; color: #8b949e; }
#behold-lanes .hd { display: flex; justify-content: space-between; margin-bottom: 4px; }
#behold-lanes canvas { display: block; width: 100%; cursor: pointer; }
body { padding-bottom: 150px; }`;

/** The filmstrip drawing + playhead, wired to the morph engine's applyView(i). */
function laneStripScript(summaries: FrameSummary[]): string {
  return `<script>
const FRAMES = ${safeJson(summaries)};
(function () {
  const host = document.getElementById("behold-lanes-canvas");
  if (!host || !FRAMES.length) return;
  const subs = [...new Set(FRAMES.flatMap(f => Object.keys(f.byLexicon)))].sort();
  const rowH = 22, padL = 96, padR = 16, padT = 6;
  const H = padT + subs.length * rowH + 24;
  const t0 = FRAMES[0].t, tN = FRAMES[FRAMES.length - 1].t, span = Math.max(1, tN - t0);
  let cur = 0;
  function xOf(i) {
    const W = host.clientWidth - padL - padR;
    // spread by real time; if all captured at once, fall back to even spacing
    const frac = span > 1 ? (FRAMES[i].t - t0) / span : (FRAMES.length > 1 ? i / (FRAMES.length - 1) : 0);
    return padL + frac * W;
  }
  function draw() {
    const dpr = window.devicePixelRatio || 1;
    host.width = host.clientWidth * dpr; host.height = H * dpr;
    host.style.height = H + "px";
    const c = host.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, host.clientWidth, H);
    c.font = "12px ui-sans-serif, system-ui, sans-serif";
    subs.forEach((s, r) => {
      const y = padT + r * rowH + rowH / 2;
      c.fillStyle = "#8b949e"; c.textAlign = "left"; c.fillText(s, 8, y + 4);
      c.strokeStyle = "#21262d"; c.beginPath(); c.moveTo(padL, y); c.lineTo(host.clientWidth - padR, y); c.stroke();
      FRAMES.forEach((f, i) => {
        const n = f.byLexicon[s]; if (!n) return;
        c.fillStyle = i === cur ? "#58a6ff" : "#3fb950";
        c.beginPath(); c.arc(xOf(i), y, i === cur ? 5 : 3.5, 0, 7); c.fill();
      });
    });
    // playhead
    const px = xOf(cur);
    c.strokeStyle = "#58a6ff"; c.lineWidth = 1.5; c.beginPath(); c.moveTo(px, padT - 2); c.lineTo(px, padT + subs.length * rowH); c.stroke();
    c.fillStyle = "#e6edf3"; c.textAlign = "center";
    c.fillText(FRAMES[cur].name || "t" + cur, px, padT + subs.length * rowH + 16);
    document.getElementById("behold-lanes-meta").textContent =
      FRAMES.length + " frames · frame " + (cur + 1) + "/" + FRAMES.length;
  }
  function nearest(clientX) {
    const rect = host.getBoundingClientRect(); const x = clientX - rect.left;
    let best = 0, bd = Infinity;
    for (let i = 0; i < FRAMES.length; i++) { const d = Math.abs(xOf(i) - x); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  function go(i) { cur = Math.max(0, Math.min(FRAMES.length - 1, i)); if (window.applyView) window.applyView(cur); draw(); }
  host.addEventListener("click", (e) => go(nearest(e.clientX)));
  let dragging = false;
  host.addEventListener("mousedown", () => (dragging = true));
  window.addEventListener("mouseup", () => (dragging = false));
  host.addEventListener("mousemove", (e) => { if (dragging) go(nearest(e.clientX)); });
  window.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") go(cur - 1); if (e.key === "ArrowRight") go(cur + 1); });
  window.addEventListener("resize", draw);
  go(FRAMES.length - 1); // start at newest
})();
</script>`;
}

/** Render the lanes page: the frame morph + the filmstrip strip. */
export function renderLanes(frames: Frame[], summaries: FrameSummary[]): string {
  const views: MorphView[] = frames.map((f, i) => ({
    name: summaries[i]?.t ? new Date(summaries[i].t).toISOString().slice(11, 19) : `t${i}`,
    ir: f.ir,
    layout: layoutIr(f.ir),
  }));
  const doc = renderMorphHtml(views, { title: "Deployment lanes" });
  const strip =
    `<style>${LANES_CSS}</style>` +
    `<div id="behold-lanes"><div class="hd"><span>deployment lanes</span><span id="behold-lanes-meta"></span></div>` +
    `<canvas id="behold-lanes-canvas"></canvas></div>` +
    laneStripScript(summaries);
  return doc.includes("</body>") ? doc.replace("</body>", `${strip}</body>`) : doc + strip;
}
