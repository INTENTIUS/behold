// The kiosk's frame for a live carve (#715). When the estate has choudoufu
// roots or estate rosters, the framed app mounts the dots layer's live driver
// (web/dots.js, web/dots-live.js). While a migration runs it directs the
// camera and tells the kiosk, twice a second, what is happening: the beat
// (title and next line from demo.json, the line under them from the newest
// progress line), the counts, and where each estate's box is.
//
// This draws that: a caption in Watch's place with a "live" badge, and Tips
// bubbles on the first landing in each estate, the first refusal and the end.
// It hides Watch's own caption only while the carve has the camera, and tells
// the frame which mode the kiosk is in, so Inspect keeps the camera a
// person's. A kiosk whose frame never mounts the layer gets no message, and
// this draws nothing: the kiosk is as it was.

import { createNarration } from "./carve-narration.js";

const STYLE = `
#k-carve { display: none; }
body.k-carving #k-caption { display: none; }
body.k-carving.k-watch #k-carve { display: grid; }
#k-carve { position: absolute; left: 5px; right: 5px; bottom: 5px; z-index: 6; gap: 4px; padding: 10px 18px 12px; border-radius: 8px; background: color-mix(in srgb, var(--panel) 94%, transparent); border: 1px solid var(--line); box-shadow: 0 2px 10px rgb(0 0 0 / 0.18); }
body.k-watch #k-carve { position: static; order: 1; border-radius: 0; box-shadow: none; border: 0; border-top: 1px solid var(--line); }
#k-carve .cx-top { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
#k-carve .cx-title { margin: 0; font-size: 21px; line-height: 1.2; min-width: 0; }
#k-carve .cx-next { margin: 0 0 0 auto; color: var(--muted); font: 13px var(--font-mono); position: relative; padding-bottom: 7px; white-space: nowrap; }
#k-carve .cx-nbar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; border-radius: 2px; background: color-mix(in srgb, var(--rule, var(--line)) 55%, transparent); overflow: hidden; }
#k-carve .cx-nbar-in { position: absolute; left: 0; top: 0; bottom: 0; background: var(--bar, var(--bar-pending)); border-radius: inherit; }
#k-carve .cx-row { margin: 0; display: grid; grid-template-columns: 6.5em minmax(0, 1fr); gap: 10px; padding-left: 10px; box-shadow: inset 3px 0 0 var(--bar, var(--bar-neutral)); }
#k-carve .cx-label { font: 600 11px var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--bar, var(--muted)); padding-top: 3px; }
#k-carve .cx-lead { font-size: 16px; font-weight: 600; }
#k-carve .cx-rec { display: inline-block; font: 600 11px var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted-ink, var(--muted)); border: 1px solid var(--rule, var(--line)); border-radius: 999px; padding: 1px 8px; cursor: help; vertical-align: 0.15em; margin-right: 10px; }
#k-carve .cx-badge-live { color: var(--bar-managed); border-color: var(--bar-managed); }
#k-carve .cx-badge-live::before { content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: currentColor; margin-right: 6px; vertical-align: 0.05em; }
#k-carve .cx-tone-busy { --bar: var(--bar-pending); }
#k-carve .cx-tone-ok { --bar: var(--bar-managed); }
#k-carve .cx-tone-bad { --bar: var(--bar-degraded); }
#k-carve .cx-tone-idle { --bar: var(--bar-neutral); }
@media (max-width: 640px) {
  #k-carve { padding: 8px 12px 10px; }
  #k-carve .cx-title { font-size: 16px; }
  #k-carve .cx-next { margin-left: 0; flex: 1 1 100%; }
  #k-carve .cx-row { grid-template-columns: 5em minmax(0, 1fr); }
  #k-carve .cx-lead { font-size: 14px; }
}
`;

/** Whether a message is the framed dots layer's live state, from this origin. */
export function liveCarveMessage(e, origin) {
  return !!(e && e.origin === origin && e.data && e.data.type === "behold:dots-state" && e.data.live === true);
}

/**
 * Start listening. `frame()`: the iframe shown now; `watch`: Watch's
 * elements (its layer and caption); `eh`: the Tips hosts; `isWatch()`: whether
 * the kiosk is in Watch. Returns `tellMode()`, for the kiosk to call when its
 * mode changes.
 */
export function startKioskCarve({ frame, watch, eh, origin = location.origin, isWatch = () => true }) {
  if (typeof window === "undefined" || typeof document === "undefined" || !watch || !watch.layer) return { tellMode() {} };
  let node = null;
  let narration = null;
  let carving = false;
  // The frame last told the kiosk's mode: a frame swapped in (a new view) is told again.
  let told = null;
  const ensure = () => {
    if (node) return;
    const st = document.createElement("style");
    st.textContent = STYLE;
    document.head.appendChild(st);
    node = document.createElement("footer");
    node.id = "k-carve";
    node.setAttribute("aria-live", "polite");
    node.setAttribute("aria-label", "The live carve");
    // Beside Watch's own caption, so it takes the same place in the layout.
    if (watch.caption && watch.caption.parentNode) watch.caption.parentNode.insertBefore(node, watch.caption.nextSibling);
    else watch.layer.appendChild(node);
    narration = createNarration({
      bar: null,
      caption: node,
      tipsHost: eh && eh.tipsHost ? eh.tipsHost : null,
      modalHost: eh && eh.modalHost ? eh.modalHost : null,
      origin: () => {
        const f = frame();
        return f ? f.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      },
    });
  };
  const insets = () => {
    const f = frame();
    if (!f || !node || !carving) return { top: 0, bottom: 0 };
    const g = f.getBoundingClientRect();
    const c = node.getBoundingClientRect();
    const over = c.height && c.top < g.bottom && c.bottom > g.top ? g.bottom - c.top : 0;
    return { top: 0, bottom: Math.max(0, Math.round(over)) };
  };
  const tellMode = () => {
    const f = frame();
    try {
      if (f && f.contentWindow) f.contentWindow.postMessage({ type: "behold:dots-mode", mode: isWatch() ? "watch" : "inspect", insets: insets() }, origin);
    } catch {
      /* the frame went away */
    }
  };
  window.addEventListener("message", (e) => {
    if (e.origin !== origin || !e.data) return;
    if (e.data.type === "behold:dots-ready" && e.data.live) return void tellMode();
    if (!liveCarveMessage(e, origin)) return;
    const f = frame();
    if (f && e.source && e.source !== f.contentWindow) return;
    ensure();
    if (e.source && e.source !== told) {
      told = e.source;
      tellMode();
    }
    if (!!e.data.carving !== carving) {
      carving = !!e.data.carving;
      document.body.classList.toggle("k-carving", carving);
      tellMode();
    }
    // The caption shows only while the carve has the camera (body.k-carving); the Tips come either way.
    narration.update(e.data);
  });
  return { tellMode };
}
