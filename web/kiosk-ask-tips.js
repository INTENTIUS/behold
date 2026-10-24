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
 * - a card stays its whole reading time ({@link holdMs}, never under {@link TIP_MIN_MS}), whatever the steps do:
 *   a step that ends or changes never cuts a card short, it only changes which card comes next;
 * - while a step is busy, the next card replaces a read one; the last stays until the busy line ends, then it hides
 *   (the host fades it out within {@link TIP_FADE_MS});
 * - a card with a link pauses its timer while it is hovered or focused ({@link LINK_RESUME_MS} left at least on
 *   leaving), so a reader can click; reduced motion changes nothing about this;
 * - a step with no tips of its own gets the built-in three, in order, one cycle's worth: a card shown is not shown
 *   again in that scenario cycle.
 */
import { modalStyle, openEventModal } from "./event-help-modal.js";

/** A card stays at least this long; a longer one stays its reading time ({@link holdMs}). */
export const TIP_MIN_MS = 8_000;
/** A card whose step ended fades out in this long (under 400 ms). */
export const TIP_FADE_MS = 300;
/** A card with a link, left after a hover or focus, has at least this long still to show. */
export const LINK_RESUME_MS = 3_000;

/**
 * A tip's link, or null: only an https URL on intentius.io (or a subdomain) or under github.com/INTENTIUS, with a
 * non-empty label (the default is "Read how"). Anything else is dropped.
 */
export function safeLink(l) {
  if (!l || typeof l.url !== "string") return null;
  let u;
  try {
    u = new URL(l.url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const ok = host === "intentius.io" || host.endsWith(".intentius.io") || (host === "github.com" && (u.pathname === "/INTENTIUS" || u.pathname.startsWith("/INTENTIUS/")));
  if (!ok) return null;
  const label = typeof l.label === "string" && l.label.trim() ? l.label.trim() : "Read how";
  return { label, url: u.href };
}

/**
 * What a busy step with no tips of its own shows, in order: the viewer's takeaways, then where to look next. Minimal
 * and positive, and each linted clean on its own at strictness 3 with the sentences package's destink linter.
 */
export const DEFAULT_TIPS = [
  { title: "All at once", body: "Every estate plans together, and the plan already holds the new subnet's id. Most tools go one root at a time.", link: { label: "How it plans across estates", url: "https://intentius.io/choudoufu/how-it-works/across-estates/" } },
  { title: "terragucci", body: "terragucci runs this from your own CI. It puts every estate into one plan and one apply.", link: { label: "How a composed run works", url: "https://intentius.io/terragucci/concepts/waves-and-approvals/#composed-estates" } },
  { title: "choudoufu", body: "choudoufu is a fork of OpenTofu. It plans and applies every estate in one pass. Resource-level locking at the cloud level.", link: { label: "How the locking works", url: "https://intentius.io/choudoufu/how-it-works/locking/" } },
  { title: "Free, nothing to host", body: "Both are free and open source. Everything runs in your own CI pipeline. There is no server or database to host.", link: { label: "choudoufu on GitHub", url: "https://github.com/INTENTIUS/choudoufu" } },
  { title: "Inspect", body: "Open Inspect to explore every resource and the plan behind it." },
];
/** The same, on a phone: the last card says this is the short version. */
export const PHONE_TIPS = [
  ...DEFAULT_TIPS.slice(0, -1),
  { title: "The full view", body: "This is the short version. A laptop shows the full view and Inspect." },
];
/** The phone layout's width (web/kiosk.html, ask mode). */
const PHONE = "(max-width: 700px)";

const validTips = (v) =>
  Array.isArray(v)
    ? v
        .filter((t) => t && typeof t.title === "string" && t.title && typeof t.body === "string" && t.body)
        .map((t) => {
          const { link, ...rest } = t;
          const ok = safeLink(link);
          return ok ? { ...rest, link: ok } : rest;
        })
    : [];

/**
 * `show(tip)` puts a card up (replacing any), `hide()` takes the current one down. `enabled()` is the Tips switch.
 * `busy(detail)` takes a `behold:ask-busy` detail. `dismiss()`: the viewer closed the card; no more for this busy line.
 */
export function createTipSequencer({ show, hide, enabled = () => true, defaults = DEFAULT_TIPS, minMs = TIP_MIN_MS, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  let id = null;
  let timer = null;
  let up = false;
  // The current card has been up its whole reading time.
  let read = false;
  // The card on screen, when its timer is running: when it ends, and what is left while it is paused.
  let current = null;
  let due = 0;
  let paused = null;
  // Cards waiting for the current one to be read: { tip, builtin, cycle }.
  let queue = [];
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
    read = false;
    paused = null;
  };
  const arm = (ms) => {
    due = now() + ms;
    timer = setTimer(() => {
      timer = null;
      read = true;
      next();
    }, ms);
  };
  // The next waiting card, or, once the current card is read and nothing waits, down when no step is busy.
  const next = () => {
    if (queue.length) {
      const { tip, builtin, cycle } = queue.shift();
      show(tip);
      up = true;
      read = false;
      current = tip;
      paused = null;
      if (builtin) given.set(cycle, (given.get(cycle) || 0) + 1);
      arm(holdMs(tip, minMs));
      return;
    }
    if (id === null) down();
  };
  return {
    busy(d) {
      const step = d && d.busy && d.id ? d.id : null;
      if (step === id) return;
      id = step;
      // A card on screen is never cut short: a step that ends or changes only changes what comes after it.
      queue = [];
      if (id !== null && enabled()) {
        const own = validTips(d.tips);
        const cycle = `${d.cycle}|${d.scenario}`;
        const list = own.length ? own : defaults.slice(given.get(cycle) || 0);
        queue = list.map((tip) => ({ tip, builtin: !own.length, cycle }));
      }
      if (!up || read) {
        stop();
        next();
      }
    },
    /** The viewer hovers or focuses the card: a card with a link holds still. */
    pause() {
      if (!up || read || paused !== null || timer === null || !current || !current.link) return;
      paused = Math.max(0, due - now());
      stop();
    },
    /** The viewer moved away: the card goes on with at least {@link LINK_RESUME_MS} left. */
    resume() {
      if (paused === null) return;
      const left = Math.max(paused, LINK_RESUME_MS);
      paused = null;
      arm(left);
    },
    dismiss() {
      stop();
      paused = null;
      up = false;
      read = false;
      queue = [];
    },
    /** The Tips switch turned off: the card goes. */
    off() {
      queue = [];
      down();
    },
    current: () => id,
  };
}

/** How long a card stays: long enough to read its title and body (about 3 words a second, plus 3 s), never under minMs. */
export function holdMs(tip, minMs = TIP_MIN_MS) {
  const words = `${tip.title} ${tip.body}`.split(/\s+/).filter(Boolean).length;
  return Math.max(minMs, 3_000 + words * 330);
}

const STYLE_ID = "k-ask-tips-style";
const STYLE = `
#k-ask-tips { position: fixed; left: 0; right: 0; top: 0; height: 0; z-index: 50; pointer-events: none; overflow: hidden; }
#k-ask-tips .eh-modal-wrap { position: absolute; inset: 0; z-index: auto; background: transparent; align-items: flex-start; padding: 12px 16px 0; box-sizing: border-box; pointer-events: none; }
#k-ask-tips .eh-modal-link { display: inline-block; margin-top: 0.4em; font-size: 0.9em; color: var(--focus, inherit); text-decoration: underline; }
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
  const linkNode = (l) => {
    const a = doc.createElement("a");
    a.className = "eh-modal-link";
    a.href = l.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = l.label;
    return a;
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
    defaults: typeof win.matchMedia === "function" && win.matchMedia(PHONE).matches ? PHONE_TIPS : DEFAULT_TIPS,
    enabled,
    show(tip) {
      kill();
      fit();
      const mine = { api: null };
      mine.api = openEventModal(host, {
        mode: "narrated",
        kind: "tip",
        data: { title: tip.title, lines: [{ text: tip.body }], ...(tip.link ? { panel: linkNode(tip.link) } : {}) },
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
  // A card with a link holds still while it is hovered or has focus (the sequencer ignores a card without one).
  const onCard = (e) => e.target && e.target.closest && e.target.closest("#k-ask-tips .eh-modal");
  host.addEventListener("mouseover", (e) => onCard(e) && seq.pause());
  host.addEventListener("focusin", (e) => onCard(e) && seq.pause());
  host.addEventListener("mouseout", (e) => onCard(e) && !(e.relatedTarget && onCard({ target: e.relatedTarget })) && !host.querySelector(".eh-modal:focus-within") && seq.resume());
  host.addEventListener("focusout", (e) => onCard(e) && !(e.relatedTarget && onCard({ target: e.relatedTarget })) && !host.querySelector(".eh-modal:hover") && seq.resume());
  win.addEventListener("behold:ask-busy", (e) => seq.busy(e.detail));
  doc.addEventListener("change", (e) => {
    if (e.target && e.target.matches && e.target.matches(".eh-switch input") && !e.target.checked) seq.off();
  });
  return seq;
}
