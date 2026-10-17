// The kiosk's frame for a live carve (#715). When the estate has choudoufu
// roots or estate rosters, the framed app mounts the dots layer's live driver
// (web/dots.js, web/dots-live.js). While a migration runs it directs the
// camera and tells the kiosk, twice a second, what is happening: the beat
// (title and next line from demo.json, the line under them from the newest
// progress line), the counts, and where each estate's box is.
//
// This draws that: a caption in Watch's caption's place and size (along the
// stage's bottom on a desktop, under the graph on a phone) with a "live"
// badge, and Tips bubbles on the first landing in each estate, the first
// refusal and the end. It hides Watch's own caption only while the carve has
// the camera, and tells the frame which mode the kiosk is in and how much of
// it the caption and the cycle's trail cover, so the boxes are framed clear
// of them. In Inspect the director frames the boxes too while the carve has
// the camera, unless a person has the graph in hand. A kiosk whose frame
// never mounts the layer gets no message, and this draws nothing: the kiosk
// is as it was.

import { createNarration } from "./carve-narration.js";

const STYLE = `
#k-carve { display: none; }
body.k-carving #k-caption { display: none; }
body.k-carving.k-watch #k-carve { display: grid; }
/* The same place and size as Watch's own caption (web/kiosk.html #k-caption): along the bottom of the stage on a desktop, in the flow under the graph on a phone. */
#k-carve { position: absolute; left: 5px; right: 5px; bottom: 5px; z-index: 6; grid-template-rows: auto calc(2 * 1.25em * 1.3) calc(2 * 1.25em * 1.3); gap: 0.25em; padding: 0.7em 1.4em 0.8em; background: var(--surface-pane-b, var(--panel)); border-top: 1px solid var(--rule, var(--line)); border-radius: 0 0 8px 8px; box-shadow: 0 -10px 30px color-mix(in srgb, var(--bg) 70%, transparent); }
#k-carve .cx-top { display: flex; align-items: baseline; gap: 0.8em; min-width: 0; }
#k-carve .cx-title { margin: 0; font-size: 1.55em; line-height: 1.2; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#k-carve .cx-next { margin: 0 0 0 auto; color: var(--muted); font: 0.92em var(--font-mono); position: relative; padding-bottom: 6px; white-space: nowrap; flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; }
#k-carve .cx-nbar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; border-radius: 2px; background: color-mix(in srgb, var(--rule, var(--line)) 55%, transparent); overflow: hidden; }
#k-carve .cx-nbar-in { position: absolute; left: 0; top: 0; bottom: 0; background: var(--bar, var(--bar-pending)); border-radius: inherit; }
#k-carve .cx-row { margin: 0; display: grid; grid-template-columns: var(--k-label-w, 6.5em) minmax(0, 1fr); column-gap: 0.8em; align-items: start; align-self: stretch; padding-left: 0.75em; line-height: 1.25; box-shadow: inset 3px 0 0 var(--bar, var(--bar-neutral)); color: color-mix(in srgb, var(--fg) 78%, var(--muted)); }
#k-carve .cx-row:first-of-type { box-shadow: inset 5px 0 0 var(--bar, var(--bar-neutral)); }
#k-carve .cx-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; max-width: 72ch; }
#k-carve .cx-label { font: 600 0.66rem/1.3 var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--bar, var(--muted)); padding-top: 0.6em; }
#k-carve .cx-lead { font-size: 1.3em; font-weight: 600; color: var(--fg); }
#k-carve .cx-rec { display: inline-block; font: 600 11px var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted-ink, var(--muted)); border: 1px solid var(--rule, var(--line)); border-radius: 999px; padding: 1px 8px; cursor: help; vertical-align: 0.15em; margin-right: 10px; }
#k-carve .cx-badge-live { color: var(--bar-managed); border-color: var(--bar-managed); }
#k-carve .cx-badge-live::before { content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: currentColor; margin-right: 6px; vertical-align: 0.05em; }
#k-carve .cx-tone-busy { --bar: var(--bar-pending); }
#k-carve .cx-tone-ok { --bar: var(--bar-managed); }
#k-carve .cx-tone-bad { --bar: var(--bar-degraded); }
#k-carve .cx-tone-idle { --bar: var(--bar-neutral); }
/* A phone: in the page's flow under the graph, where Watch's caption goes (web/kiosk.html). */
@media (max-width: 600px) {
  body.k-watch #k-carve { position: static; order: 1; flex-direction: column; gap: 4px; border-radius: 0; box-shadow: none; border: 0; border-top: 1px solid var(--line); padding: 8px 12px 10px; }
  body.k-carving.k-watch #k-carve { display: flex; }
  #k-carve .cx-top { flex-wrap: wrap; gap: 4px 16px; }
  #k-carve .cx-title { font-size: 16px; white-space: normal; }
  #k-carve .cx-next { margin-left: 0; flex: 1 1 100%; max-width: none; font-size: 13px; padding-bottom: 7px; }
  #k-carve .cx-row { grid-template-columns: 5em minmax(0, 1fr); gap: 10px; padding-left: 10px; }
  #k-carve .cx-row:first-of-type { box-shadow: inset 3px 0 0 var(--bar, var(--bar-neutral)); }
  #k-carve .cx-label { font-size: 11px; padding-top: 3px; }
  #k-carve .cx-lead { font-size: 14px; }
  #k-carve .cx-text { -webkit-line-clamp: unset; display: block; }
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
  const trail = eh && eh.trailHost ? eh.trailHost : null;
  if (typeof window === "undefined" || typeof document === "undefined" || !watch || !watch.layer) return { tellMode() {}, caption: () => (watch ? watch.caption : null) };
  let node = null;
  let narration = null;
  let carving = false;
  // The frame last told the kiosk's mode: a frame swapped in (a new view) is told again.
  let told = null;
  let lastBottom = -1;
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
    // event-help's trail sits on the caption's top edge: the boxes stay clear of both.
    const tr = trail && !trail.hidden ? trail.getBoundingClientRect() : null;
    const top = tr && tr.height && tr.top < c.top && tr.bottom >= c.top - 2 ? tr.top : c.top;
    const over = c.height && top < g.bottom && c.bottom > g.top ? g.bottom - top : 0;
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
    // The caption's height follows its words: the frame keeps the boxes clear of it as it changes.
    const ins = insets();
    if (ins.bottom !== lastBottom) {
      lastBottom = ins.bottom;
      tellMode();
    }
  });
  /** The caption shown now: the carve's while it has the camera, so the trail and the shot stay clear of it. */
  const caption = () => (carving && node && isWatch() ? node : watch.caption);
  return { tellMode, caption };
}
