/**
 * The prompt demo's tip cards. While a step's busy line shows in ask mode (web/kiosk-ask.js emits
 * `behold:ask-busy`), its tips show as modal cards over the graph, one at a time. The cards are the Tips feature's
 * own (web/event-help-modal.js `openEventModal`, kind "tip"), so the look and the close behaviour (x, Escape) are
 * the same; only the host differs: a box over the graph area, never over the prompt pane.
 *
 * Tips never touch the graph or the turn order: this module only listens.
 *
 * The timing is a pure sequencer ({@link createTipSequencer}), tested with fake timers:
 * - one card at a time, the first at once;
 * - a card stays at least {@link TIP_MIN_MS}; when the busy step lasts longer, the next card replaces it;
 * - the last card stays until the busy line ends, then it hides (the host fades it out within {@link TIP_FADE_MS});
 * - a step with no tips of its own gets the built-in three, in order, one cycle's worth: a card shown is not shown
 *   again in that scenario cycle.
 */
import { modalStyle, openEventModal } from "./event-help-modal.js";

/** A card stays this long at least before the next one replaces it. */
export const TIP_MIN_MS = 7_000;
/** A card whose step ended fades out in this long (under 400 ms). */
export const TIP_FADE_MS = 300;

/** What a busy step with no tips of its own shows, in order. */
export const DEFAULT_TIPS = [
  { title: "One root at a time", body: "Most tools plan each root on its own, in order. A root can't see a value its upstream hasn't created yet until that upstream has applied." },
  { title: "terragucci", body: "terragucci runs stock Terraform and OpenTofu roots in waves, each root planned and applied in order, from your own pipeline." },
  { title: "choudoufu", body: "choudoufu, a fork of OpenTofu, plans every estate in one plan, a new subnet's id included, and applies them in one apply. Resource-level locking at the cloud level." },
  { title: "Free, nothing to host", body: "Both are free and open source. There is no server and no database to run: it all runs in your CI pipeline, and the records sit in a storage bucket." },
];

const validTips = (v) => (Array.isArray(v) ? v.filter((t) => t && typeof t.title === "string" && t.title && typeof t.body === "string" && t.body) : []);

/**
 * `show(tip)` puts a card up (replacing any), `hide()` takes the current one down. `enabled()` is the Tips switch.
 * `busy(detail)` takes a `behold:ask-busy` detail. `dismiss()`: the viewer closed the card; no more for this busy line.
 */
export function createTipSequencer({ show, hide, enabled = () => true, defaults = DEFAULT_TIPS, minMs = TIP_MIN_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let id = null;
  let timer = null;
  let up = false;
  // Built-in cards shown so far, by scenario cycle.
  const given = new Map();
  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const down = () => {
    stop();
    if (up) hide();
    up = false;
  };
  const play = (list, i, builtin, cycle) => {
    show(list[i]);
    up = true;
    if (builtin) given.set(cycle, (given.get(cycle) || 0) + 1);
    if (i + 1 < list.length) {
      timer = setTimer(() => {
        timer = null;
        if (id !== null) play(list, i + 1, builtin, cycle);
      }, minMs);
    }
  };
  return {
    busy(d) {
      const next = d && d.busy && d.id ? d.id : null;
      if (next === id) return;
      down();
      id = next;
      if (id === null || !enabled()) return;
      const own = validTips(d.tips);
      const cycle = `${d.cycle}|${d.scenario}`;
      const list = own.length ? own : defaults.slice(given.get(cycle) || 0);
      if (list.length) play(list, 0, !own.length, cycle);
    },
    dismiss() {
      stop();
      up = false;
    },
    /** The Tips switch turned off: the card goes. */
    off() {
      down();
    },
    current: () => id,
  };
}

const STYLE_ID = "k-ask-tips-style";
const STYLE = `
#k-ask-tips { position: fixed; left: 0; right: 0; top: 0; height: 0; z-index: 50; pointer-events: none; overflow: hidden; }
#k-ask-tips .eh-modal-wrap { position: absolute; inset: 0; z-index: auto; background: transparent; align-items: flex-start; padding: 12px 16px 0; box-sizing: border-box; pointer-events: none; }
#k-ask-tips .eh-modal { pointer-events: auto; width: min(32em, 100%); max-height: calc(100% - 12px); font-size: 1em; }
@media (max-width: 700px) { #k-ask-tips .eh-modal { font-size: 0.9em; padding: 0.7em 1em 0.8em; } #k-ask-tips .eh-modal-title { font-size: 1.15em; margin-bottom: 0.3em; } }
@media (prefers-reduced-motion: no-preference) {
  #k-ask-tips .eh-modal-wrap { animation: k-tip-in 0.25s ease-out; transition: opacity ${TIP_FADE_MS}ms linear; }
  #k-ask-tips .eh-modal-wrap.k-tip-out { opacity: 0; }
}
@keyframes k-tip-in { from { opacity: 0; } to { opacity: 1; } }
`;

/**
 * Wire the cards to the page: listens for `behold:ask-busy` on `win`, and shows them in a box over the graph (from the
 * top of the page to the top of `askHost`, the prompt pane). The Tips checkbox turns them off where it shows; where
 * the bar is hidden (ask mode, a phone) they are on.
 */
export function mountAskTips({ win = window, doc = document, askHost, reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches }) {
  if (!askHost || !doc.body) return null;
  if (!doc.getElementById(STYLE_ID)) {
    const st = doc.createElement("style");
    st.id = STYLE_ID;
    st.textContent = STYLE;
    doc.head.appendChild(st);
  }
  modalStyle(doc);
  const host = doc.createElement("div");
  host.id = "k-ask-tips";
  host.setAttribute("aria-live", "polite");
  doc.body.appendChild(host);
  let card = null;
  let measure = null;
  const fit = () => {
    const r = askHost.getBoundingClientRect();
    host.style.height = `${Math.max(0, Math.round(r.top))}px`;
  };
  const enabled = () => {
    const box = doc.querySelector(".eh-switch input");
    const seen = box && box.getClientRects().length > 0;
    return !seen || box.checked;
  };
  const fading = new Set();
  const stopMeasure = () => {
    if (measure !== null) win.clearInterval(measure);
    measure = null;
  };
  const kill = () => {
    for (const c of fading) c.api.close();
    fading.clear();
    if (card) {
      const c = card;
      card = null;
      c.api.close();
    }
    stopMeasure();
  };
  const seq = createTipSequencer({
    enabled,
    show(tip) {
      kill();
      fit();
      const mine = { api: null };
      mine.api = openEventModal(host, {
        mode: "narrated",
        kind: "tip",
        data: { title: tip.title, lines: [{ text: tip.body }] },
        doc,
        reduced: reduced(),
        onClose: (s) => {
          if (card === mine) {
            card = null;
            if (s.closedBy === "viewer") seq.dismiss();
          }
        },
      });
      card = mine;
      if (measure === null) measure = win.setInterval(fit, 250);
    },
    hide() {
      const c = card;
      if (!c) return;
      const wrap = host.querySelector(".eh-modal-wrap");
      if (reduced() || !wrap) return kill();
      wrap.classList.add("k-tip-out");
      card = null;
      fading.add(c);
      stopMeasure();
      win.setTimeout(() => {
        fading.delete(c);
        c.api.close();
      }, TIP_FADE_MS);
    },
  });
  win.addEventListener("behold:ask-busy", (e) => seq.busy(e.detail));
  doc.addEventListener("change", (e) => {
    if (e.target && e.target.matches && e.target.matches(".eh-switch input") && !e.target.checked) seq.off();
  });
  return seq;
}
