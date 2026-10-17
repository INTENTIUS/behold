// The static carve export's page (#712): `npm run export:carve` bundles this
// with the dots layer and the theme into one HTML file, with the card SVG and
// the recording inlined, so it opens from a web host or straight from disk
// with no behold server behind it.
//
// It replays the recording by itself and loops, holding on the result. The
// camera follows the flock until a person takes it (pinch, scroll, drag);
// zooming works as in the app's preview: cards, then dots, then discs.

import { initTheme, mountThemePicker, KIOSK_THEME } from "./theme.js";
import { mountDots, dotsCamera, dotsZoomOutFactor } from "./dots.js";
import { createNarration } from "./carve-narration.js";

async function gunzipBase64(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

async function main() {
  initTheme(KIOSK_THEME);
  mountThemePicker(document.getElementById("cx-theme"));
  const data = JSON.parse(document.getElementById("cx-data").textContent);
  const source = data.kind === "carve" ? { kind: "carve", name: data.name, text: await gunzipBase64(data.gz) } : { kind: "walkthrough", name: data.name, model: data.model };

  const host = document.getElementById("graph");
  const svg = host.querySelector("svg");
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const vbInit = svg.getAttribute("viewBox").split(/\s+/).map(Number);
  // The fit: the whole card graph, at the pane's own aspect, so the pane maps to the viewBox at one scale.
  const fitted = () => {
    const r = host.getBoundingClientRect();
    const s = Math.min(r.width / vbInit[2], r.height / vbInit[3]);
    const w = r.width / s;
    const h = r.height / s;
    return [vbInit[0] - (w - vbInit[2]) / 2, vbInit[1] - (h - vbInit[3]) / 2, w, h];
  };
  let vb = fitted();
  const apply = () => {
    svg.setAttribute("viewBox", vb.join(" "));
    dotsCamera();
  };
  apply();

  // The camera by hand: scroll or pinch zooms at the pointer, a drag pans.
  // The SVG may be out of layout at the dot level; it always fills the host.
  const zoomAt = (cx, cy, f) => {
    const r = host.getBoundingClientRect();
    const px = vb[0] + ((cx - r.left) / r.width) * vb[2];
    const py = vb[1] + ((cy - r.top) / r.height) * vb[3];
    const nw = Math.min(vbInit[2] * (dotsZoomOutFactor() ?? 3), Math.max(vbInit[2] / 60, vb[2] * f));
    const nh = nw * (vb[3] / vb[2]);
    vb = [px - ((px - vb[0]) * nw) / vb[2], py - ((py - vb[1]) * nh) / vb[3], nw, nh];
    apply();
  };
  host.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)));
    },
    { passive: false },
  );
  let drag = null;
  host.addEventListener("mousedown", (e) => {
    if (e.target.closest && e.target.closest("button, select, input")) return;
    drag = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const r = host.getBoundingClientRect();
    vb[0] -= ((e.clientX - drag.x) / r.width) * vb[2];
    vb[1] -= ((e.clientY - drag.y) / r.height) * vb[3];
    drag = { x: e.clientX, y: e.clientY };
    apply();
  });
  window.addEventListener("mouseup", () => (drag = null));
  let touch = null;
  const pts = (e) => [...e.touches].map((t) => ({ x: t.clientX, y: t.clientY }));
  host.addEventListener("touchstart", (e) => (touch = pts(e)), { passive: true });
  host.addEventListener(
    "touchmove",
    (e) => {
      if (!touch) return;
      e.preventDefault();
      const p = pts(e);
      const r = host.getBoundingClientRect();
      if (p.length >= 2 && touch.length >= 2) {
        const d = (q) => Math.hypot(q[0].x - q[1].x, q[0].y - q[1].y) || 1;
        zoomAt((p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2, d(touch) / d(p));
      } else if (p.length === 1 && touch.length === 1) {
        vb[0] -= ((p[0].x - touch[0].x) / r.width) * vb[2];
        vb[1] -= ((p[0].y - touch[0].y) / r.height) * vb[3];
        apply();
      }
      touch = p;
    },
    { passive: false },
  );
  host.addEventListener("touchend", (e) => (touch = e.touches.length ? pts(e) : null));

  const caption = document.getElementById("cx-caption");
  const narration = createNarration({
    bar: document.getElementById("cx-bar"),
    caption,
    tipsHost: document.getElementById("eh-tips"),
    modalHost: document.getElementById("eh-modals"),
    origin: () => host.getBoundingClientRect(),
  });
  await mountDots({
    host,
    svg,
    meta: { dots: { source: data.name } },
    vbInit,
    getVB: () => vb,
    setVB: (a) => {
      vb = a.slice();
      apply();
    },
    source,
    auto: { narrate: (msg) => narration.update(msg), bar: true },
  });
  // The director keeps the boxes clear of the caption over the graph's foot.
  const insets = () => {
    const g = host.getBoundingClientRect();
    const c = caption.getBoundingClientRect();
    const over = c.height && c.top < g.bottom && c.bottom > g.top ? g.bottom - c.top : 0;
    if (window.__dots) window.__dots.setInsets({ top: 0, bottom: Math.max(0, Math.round(over)) });
  };
  insets();
  if (typeof ResizeObserver === "function") new ResizeObserver(insets).observe(caption);
  window.addEventListener("resize", insets);
}

main().catch((err) => {
  const p = document.createElement("p");
  p.className = "cx-error";
  p.textContent = `This page could not start: ${err && err.message ? err.message : err}`;
  document.body.appendChild(p);
});
