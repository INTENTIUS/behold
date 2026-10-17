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
import { SLOWED } from "./tour-player.js";

const STYLE = `
#k-carve { display: none; }
body.k-carving #k-caption { display: none; }
body.k-carving.k-watch #k-carve { display: grid; }
/* The same place and size as Watch's own caption (web/kiosk.html #k-caption): along the bottom of the stage on a desktop, in the flow under the graph on a phone. */
#k-carve { position: absolute; left: 5px; right: 5px; bottom: 5px; z-index: 6; grid-template-rows: auto calc(2 * 1.25em * 1.3) calc(2 * 1.25em * 1.3); gap: 0.25em; padding: var(--s3) 1.4em var(--s4); background: var(--surface-pane-b, var(--panel)); border-top: 1px solid var(--rule, var(--line)); border-radius: 0 0 8px 8px; box-shadow: 0 -10px 30px color-mix(in srgb, var(--bg) 70%, transparent); }
#k-carve .cx-top { display: flex; align-items: baseline; gap: var(--s4); min-width: 0; }
#k-carve .cx-title { margin: 0; font-size: 1.55em; line-height: 1.2; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#k-carve .cx-next { margin: 0 0 0 auto; color: var(--muted); font: 0.92em var(--font-mono); position: relative; padding-bottom: 6px; white-space: nowrap; flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; }
#k-carve .cx-nbar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; border-radius: 2px; background: color-mix(in srgb, var(--rule, var(--line)) 55%, transparent); overflow: hidden; }
#k-carve .cx-nbar-in { position: absolute; left: 0; top: 0; bottom: 0; background: var(--bar, var(--bar-pending)); border-radius: inherit; }
#k-carve .cx-row { margin: 0; display: grid; grid-template-columns: var(--k-label-w, 6.5em) minmax(0, 1fr); column-gap: var(--s4); align-items: start; align-self: stretch; padding-left: var(--s3); line-height: 1.25; box-shadow: inset 3px 0 0 var(--bar, var(--bar-neutral)); color: var(--ink2, var(--fg)); }
#k-carve .cx-row:first-of-type { box-shadow: inset 5px 0 0 var(--bar, var(--bar-neutral)); }
#k-carve .cx-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; max-width: 72ch; }
#k-carve .cx-label { font: 600 0.8rem/1.3 var(--font-ui); color: var(--bar, var(--muted)); padding-top: var(--s3); }
#k-carve .cx-lead { font-size: 1.3em; font-weight: 600; color: var(--fg); }
/* behold#725: RECORDED and LIVE stay in capitals: a status badge, not a label. */
#k-carve .cx-rec { display: inline-block; font: 700 max(11.5px, 0.8rem) var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg); border: 1px solid var(--rule, var(--line)); border-radius: 999px; padding: 1px 8px; cursor: help; vertical-align: 0.15em; margin-right: 8px; }
#k-carve .cx-badge-live { color: var(--bar-managed); border-color: var(--bar-managed); }
#k-carve .cx-badge-live::before { content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: currentColor; margin-right: 6px; vertical-align: 0.05em; }
/* behold#725: while the kiosk can't read from behold, the live badge says STALE, dimmed, its dot hollow. */
#k-carve .cx-badge-stale { color: var(--muted); border-style: dashed; }
#k-carve .cx-badge-stale::before { content: ""; display: inline-block; width: 7px; height: 7px; box-sizing: border-box; border-radius: 50%; border: 1.5px solid currentColor; margin-right: 6px; vertical-align: 0.05em; }
#k-carve .cx-tone-busy { --bar: var(--bar-pending); }
#k-carve .cx-tone-ok { --bar: var(--bar-managed); }
#k-carve .cx-tone-bad { --bar: var(--bar-degraded); }
#k-carve .cx-tone-idle { --bar: var(--bar-neutral); }
/* The live badge's lag: how long since the newest write (web/tour-player.js lagText). */
#k-carve .cx-lag { font: 600 max(11.5px, 0.8rem) var(--font-mono); color: var(--muted); margin-right: 8px; vertical-align: 0.15em; white-space: nowrap; }
#k-carve .cx-lag-wait { color: var(--bar-pending); }
/* The tour (behold.tour/v1): the rail, the chapter's card docked in the caption, the numbers, the notes. */
#k-carve.cx-tour { grid-template-rows: auto auto auto auto; gap: var(--s1); }
#k-carve .cx-tour-top { align-items: center; flex-wrap: wrap; gap: var(--s2) var(--s4); }
#k-carve .cx-tour-top .cx-rec { margin-right: 0; }
#k-carve .cx-rail { list-style: none; margin: 0; padding: 0; display: flex; gap: 6px; align-items: center; min-width: 0; }
#k-carve .cx-ch { position: relative; display: flex; align-items: baseline; gap: 6px; padding: 2px 8px 4px; border: 1px solid var(--rule, var(--line)); border-radius: 6px; font: 600 max(11.5px, 0.8rem) var(--font-mono); color: var(--muted); white-space: nowrap; }
#k-carve .cx-ch-done { color: color-mix(in srgb, var(--fg) 70%, var(--muted)); }
#k-carve .cx-ch-current { color: var(--fg); border-color: var(--bar-pending); }
#k-carve .cx-ch-name { font: 600 max(11.5px, 0.8rem) var(--font-ui); max-width: 26ch; overflow: hidden; text-overflow: ellipsis; }
#k-carve .cx-ch-bar { position: absolute; left: 6px; right: 6px; bottom: 2px; height: 2px; border-radius: 1px; background: color-mix(in srgb, var(--rule, var(--line)) 60%, transparent); overflow: hidden; }
#k-carve .cx-ch-bar::after { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: calc(var(--p, 0) * 100%); background: var(--bar-managed); }
#k-carve .cx-ch-current .cx-ch-bar::after { background: var(--bar-pending); }
#k-carve .cx-follow { margin: 0 0 0 auto; display: flex; gap: 8px; align-items: baseline; font: 12px var(--font-ui); color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
#k-carve .cx-follow-label { display: inline-block; font: 600 0.8rem var(--font-ui); }
#k-carve .cx-follow a { color: var(--focus, var(--fg)); }
#k-carve .cx-card { padding-left: var(--s3); box-shadow: inset 5px 0 0 var(--bar-pending); }
#k-carve .cx-card.cx-enter { animation: cx-dock 0.45s ease-out; }
@keyframes cx-dock { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { #k-carve .cx-card.cx-enter { animation: none; } }
#k-carve .cx-card-title { white-space: normal; font-size: 1.4em; }
#k-carve .cx-ch-kicker { display: inline-block; font: 600 0.8rem var(--font-ui); color: var(--muted); margin-right: var(--s4); vertical-align: 0.3em; }
#k-carve .cx-card-line { margin: 0.15em 0 0; color: var(--ink2, var(--fg)); line-height: 1.35; max-width: 90ch; }
#k-carve .cx-numbers { margin: 0.2em 0 0; display: flex; flex-wrap: wrap; gap: 6px 22px; }
#k-carve .cx-num { display: flex; flex-direction: column; }
#k-carve .cx-num dt { font: 600 0.8rem var(--font-ui); color: var(--muted); }
/* behold#725: sentence case. The tour file writes its labels in lower case ("cycle time"), so the label raises its first letter. */
#k-carve .cx-label::first-letter, #k-carve .cx-follow-label::first-letter, #k-carve .cx-ch-kicker::first-letter, #k-carve .cx-num dt::first-letter { text-transform: uppercase; }
#k-carve .cx-num dd { margin: 0; font-size: 1.25em; font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; }
/* The quiet line: what runs while nothing new comes in (web/kiosk-watch.js quietWords). One muted line, no spinner. */
#k-carve .cx-quiet { margin: 0; padding-left: var(--s3); color: var(--muted); font-size: 0.92em; line-height: 1.35; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#k-carve .cx-notes { margin: 0; font: 12px/1.35 var(--font-mono); color: var(--ink2, var(--muted)); padding-left: var(--s3); overflow-wrap: anywhere; }
/* A phone: in the page's flow under the graph, where Watch's caption goes (web/kiosk.html). */
@media (max-width: 600px) {
  body.k-watch #k-carve { position: static; order: 1; flex-direction: column; gap: 4px; border-radius: 0; box-shadow: none; border: 0; border-top: 1px solid var(--line); padding: 8px 12px 8px; }
  body.k-carving.k-watch #k-carve { display: flex; }
  #k-carve .cx-top { flex-wrap: wrap; gap: 4px 16px; }
  #k-carve .cx-title { font-size: 16px; white-space: normal; }
  #k-carve .cx-next { margin-left: 0; flex: 1 1 100%; max-width: none; font-size: 13px; padding-bottom: 6px; }
  #k-carve .cx-row { grid-template-columns: 5em minmax(0, 1fr); gap: 8px; padding-left: 8px; }
  #k-carve .cx-row:first-of-type { box-shadow: inset 3px 0 0 var(--bar, var(--bar-neutral)); }
  #k-carve .cx-label { font-size: 11px; padding-top: 3px; }
  #k-carve .cx-lead { font-size: 14px; }
  #k-carve .cx-text { -webkit-line-clamp: unset; display: block; }
  #k-carve .cx-rail { flex-wrap: wrap; }
  #k-carve .cx-ch-name { display: none; }
  #k-carve .cx-follow { margin-left: 0; flex-wrap: wrap; white-space: normal; }
  #k-carve .cx-card-title { font-size: 17px; }
  #k-carve .cx-card-line { font-size: 14px; }
  #k-carve .cx-num dd { font-size: 16px; }
  #k-carve .cx-quiet { white-space: normal; font-size: 13px; }
}
/* Slowed playback, in Inspect's quiet rows: off (real time) unless a person picks it. */
.k-slowed { font: 12px var(--font-ui); background: var(--well, transparent); color: var(--fg); border: 1px solid var(--line); border-radius: 5px; padding: 2px 8px; cursor: pointer; }
.k-slowed[aria-pressed="true"] { border-color: var(--bar-pending); }
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
  if (typeof window === "undefined" || typeof document === "undefined" || !watch || !watch.layer) return { tellMode() {}, caption: () => (watch ? watch.caption : null), slowedControl: () => null, lastWriteAt: () => null, setQuiet() {} };
  let node = null;
  let narration = null;
  let carving = false;
  // The frame last told the kiosk's mode: a frame swapped in (a new view) is told again.
  let told = null;
  let lastBottom = -1;
  // The newest progress line the frame has told of, and the quiet line the kiosk works out from it (web/kiosk.js).
  let writeAt = null;
  let quiet = null;
  // Slowed playback: a person's choice, real time until then. One button, kept across the header's redraws.
  let slowed = 1;
  let slowedNode = null;
  const slowedButton = () => {
    if (slowedNode || typeof document === "undefined") return slowedNode;
    slowedNode = document.createElement("button");
    slowedNode.type = "button";
    slowedNode.className = "k-slowed";
    const label = () => {
      const at = SLOWED.find((x) => x.n === slowed) || SLOWED[0];
      slowedNode.textContent = at.words;
      slowedNode.setAttribute("aria-pressed", String(slowed !== 1));
      slowedNode.title = slowed === 1 ? "Writes draw as they are read. Click to slow them down." : `Each read's writes are drawn ${at.stepMs} ms apart. Click for the next speed.`;
    };
    label();
    slowedNode.addEventListener("click", () => {
      const i = SLOWED.findIndex((x) => x.n === slowed);
      slowed = SLOWED[(i + 1) % SLOWED.length].n;
      label();
      const f = frame();
      try {
        if (f && f.contentWindow) f.contentWindow.postMessage({ type: "behold:dots-slowed", n: slowed }, origin);
      } catch {
        /* the frame went away */
      }
    });
    return slowedNode;
  };
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
      quiet: () => quiet,
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
    writeAt = typeof e.data.lastWriteAt === "number" ? e.data.lastWriteAt : null;
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
  /** The slowed control for Inspect's quiet rows, once a frame draws a live carve; null before. */
  const slowedControl = () => (node ? slowedButton() : null);
  /** The newest progress line's time the frame has told of, in ms; null before one. */
  const lastWriteAt = () => writeAt;
  /** The quiet line from the kiosk, or null: drawn at once when it changes. */
  const setQuiet = (q) => {
    const was = quiet ? quiet.text : null;
    quiet = q || null;
    if (narration && (quiet ? quiet.text : null) !== was) narration.redraw();
  };
  return { tellMode, caption, slowedControl, lastWriteAt, setQuiet };
}
