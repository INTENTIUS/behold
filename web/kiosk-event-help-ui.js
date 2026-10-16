// behold#571: event-help in the kiosk, the "Tips". The events come from
// web/kiosk-event-help.js; this draws them:
//
// - a tip, one short line, pops from the thing on screen an event is about (a
//   card or a wave box in the graph, a job row, the approval panel, a metrics
//   badge), for TIP_MS, two at once at most, then shrinks toward the trail;
// - the event's subjects light together across the panes for that time, as
//   a hover lights them (`light`), and the thing the tip points at glows;
// - the story trail: the cycle's beats as chips, quiet, under the header in
//   Inspect and by the caption in Watch; a chip, pointed at or clicked,
//   shows its tip and its lights again;
// - a critical event (a wave held, a wave failed, the cycle applied) opens
//   web/event-help-modal.js, narrated (or replayed on a tool's page).
//
// The Tips switch, on by default and kept per viewer, turns the tips, the
// lights, the glows and the modals off; the trail stays, since it is the
// record.

import { EH_STORE, LATE_ORDER, TIP_MS, cycleFacts, ehSnapshot, ehStore, ehStored, modalQueue, newEvents, storyTrail, tipsQueue } from "./kiosk-event-help.js";

/** How long after the page opens (or the cycle turns) what arrives is the story so far, not news: the reads land one by one. */
export const SETTLE_MS = 8_000;
import { modalStyle, openEventModal } from "./event-help-modal.js";

/** The switch's label, and its title. */
export const TIPS_WORDS = "Tips";
export const TIPS_TITLE = "Short notes on what just happened, beside the things they are about";
/** The trail's label. */
export const TRAIL_WORDS = "This cycle";

const STYLE = `
#eh-trail { display: flex; flex-wrap: nowrap; align-items: center; gap: 0.35em; overflow-x: auto; scrollbar-width: none; contain: inline-size; min-width: 0; padding: 0.15em 0.9em 0.3em; font-size: 0.78em; color: var(--muted); min-height: 1.9em; }
#eh-trail::-webkit-scrollbar { display: none; }
#eh-trail[hidden] { display: none; }
.eh-trail-label { font: 600 0.85em var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; margin-right: 0.3em; white-space: nowrap; }
.eh-chip { flex: none; white-space: nowrap; padding: 0.05em 0.6em; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--rule) 80%, transparent); background: transparent; color: var(--muted); font: inherit; cursor: pointer; box-shadow: inset 3px 0 0 var(--bar, var(--bar-neutral, var(--muted))); }
.eh-chip:hover, .eh-chip:focus-visible { color: var(--fg); border-color: var(--focus); }
.eh-chip:last-of-type { color: var(--fg); }
.eh-sep { flex: none; opacity: 0.5; }
.eh-chip[data-eh-tone="ok"] { --bar: var(--bar-managed, var(--managed)); }
.eh-chip[data-eh-tone="wait"] { --bar: var(--bar-foreign, var(--foreign)); }
.eh-chip[data-eh-tone="bad"] { --bar: var(--bar-degraded, var(--degraded)); }
.eh-chip[data-eh-tone="busy"] { --bar: var(--bar-pending, var(--pending)); }
body.k-watch #eh-trail { position: fixed; z-index: 7; left: 5px; right: 5px; padding: 0.3em 1.4em; background: var(--surface-pane-b); border-top: 1px solid color-mix(in srgb, var(--rule) 60%, transparent); border-radius: 8px 8px 0 0; }
#eh-tips { position: fixed; inset: 0; pointer-events: none; z-index: 40; }
#eh-modals { position: fixed; z-index: 50; }
.eh-tip { position: fixed; left: 0; top: 0; max-width: 24em; padding: 0.35em 0.75em; border-radius: 9px; background: var(--surface-box, var(--panel)); color: var(--fg); border: 1px solid var(--bar, var(--focus)); font-size: 0.92em; line-height: 1.3;
  box-shadow: 0 6px 22px color-mix(in srgb, var(--shadow) 70%, transparent); transform-origin: 50% 100%; }
.eh-tip.eh-tip-go { pointer-events: auto; cursor: pointer; }
.eh-tip.eh-tip-go:hover { background: var(--active); }
.eh-tip::after { content: ""; position: absolute; left: calc(50% - 6px); bottom: -7px; width: 12px; height: 12px; background: inherit; border: inherit; border-top: 0; border-left: 0; transform: rotate(45deg); }
.eh-tip.eh-below::after { bottom: auto; top: -7px; transform: rotate(-135deg); }
.eh-tip[data-eh-tone="ok"] { --bar: var(--bar-managed, var(--managed)); }
.eh-tip[data-eh-tone="wait"] { --bar: var(--bar-foreign, var(--foreign)); }
.eh-tip[data-eh-tone="bad"] { --bar: var(--bar-degraded, var(--degraded)); }
.eh-tip[data-eh-tone="busy"] { --bar: var(--bar-pending, var(--pending)); }
.eh-glow { outline: 2px solid var(--eh-glow, var(--focus)); outline-offset: 2px; border-radius: 6px; }
@media (prefers-reduced-motion: no-preference) {
  .eh-tip { animation: eh-pop 0.28s ease-out; }
  .eh-tip.eh-out { transition: transform 0.6s ease-in, opacity 0.6s ease-in; opacity: 0; }
  .eh-glow { animation: eh-pulse 1.4s ease-in-out 2; }
}
@media (prefers-reduced-motion: reduce) { .eh-tip.eh-out { opacity: 0; } }
@keyframes eh-pop { from { opacity: 0; transform: var(--eh-at) translateY(6px) scale(0.92); } to { opacity: 1; transform: var(--eh-at); } }
@keyframes eh-pulse { 0%, 100% { outline-color: color-mix(in srgb, var(--eh-glow, var(--focus)) 35%, transparent); } 50% { outline-color: var(--eh-glow, var(--focus)); } }
@media (max-width: 600px) { #eh-trail { padding: 0.2em 16px; } body.k-watch #eh-trail { position: static; background: transparent; border: 0; } .eh-tip { max-width: 18em; } }
`;

/** A fact's tone, for its chip, its tip and its modal: the state colours the bars use. */
export function toneOf(kind) {
  if (kind === "held") return "wait";
  if (kind === "failed" || kind === "refused") return "bad";
  if (kind === "applied" || kind === "applied-wave" || kind === "approved" || kind === "known") return "ok";
  return "busy";
}

/**
 * Start Tips. `get()` answers what the kiosk holds now; `light(subjects)`
 * lights them across the panes as a hover does (null puts them out);
 * `panel(kind)` builds the real panel the modal shows (the approval panel).
 */
export function startEventHelp({ doc = document, store = null, switchHost = null, trailHost, tipsHost, modalHost, get, light = () => {}, panel = () => null, openTrace = () => {}, now = () => Date.now(), shown = now, reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches }) {
  if (doc.head && !doc.getElementById("eh-style")) {
    const style = doc.createElement("style");
    style.id = "eh-style";
    style.textContent = STYLE;
    doc.head.appendChild(style);
  }
  modalStyle(doc);
  const st = { bootAt: now(), maxOrder: -Infinity, appliedAt: new Map(), on: ehStored(store), cycle: null, seen: null, trail: new Map(), failed: new Set(), tips: null, modals: null, modal: null, lastInput: -Infinity, lit: null, litUntil: 0, nodes: new Map(), glows: [] };
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };

  // The switch, by the theme picker and "What is this?".
  if (switchHost) {
    const label = el("label", "eh-switch");
    label.title = TIPS_TITLE;
    const box = el("input");
    box.type = "checkbox";
    box.checked = st.on;
    box.addEventListener("change", () => {
      st.on = box.checked;
      ehStore(store, st.on);
      if (!st.on) quiet();
    });
    label.append(box, TIPS_WORDS);
    switchHost.prepend(label);
  }
  // A viewer at the page: no modal opens over what they are doing.
  for (const ev of ["pointerdown", "keydown", "wheel"]) doc.addEventListener(ev, () => (st.lastInput = now()), { passive: true });
  doc.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "touch") st.lastInput = now();
  }, { passive: true });

  /** Everything Tips put up, put away: the tips, the lights, the glows, any modal. */
  const quiet = () => {
    for (const n of st.nodes.values()) n.remove();
    st.nodes.clear();
    st.tips = null;
    st.modals = null;
    for (const g of st.glows) g.el.classList.remove("eh-glow");
    st.glows = [];
    if (st.lit) light(null);
    st.lit = null;
    if (st.modal) st.modal.api.close();
  };

  // ---- where an event's things are on screen -----------------------------
  const frameRect = (h) => {
    const f = h.frame;
    if (!f || !f.getBoundingClientRect) return null;
    const F = f.getBoundingClientRect();
    return F.width ? F : null;
  };
  const visible = (r) => r && r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < (doc.defaultView ? doc.defaultView.innerHeight : 1e9);
  const fromFrame = (h, b) => {
    const F = frameRect(h);
    if (!F || !b || !(b.w > 0)) return null;
    const r = { left: F.left + b.x, top: F.top + b.y, width: b.w, height: b.h };
    // Only the part inside the frame: a box panned out of view is no anchor.
    const top = Math.max(r.top, F.top);
    const bottom = Math.min(r.top + r.height, F.bottom);
    const left = Math.max(r.left, F.left);
    const right = Math.min(r.left + r.width, F.right);
    return bottom - top > 8 && right - left > 8 ? { left, top, width: right - left, height: bottom - top, right, bottom } : null;
  };
  const q = (sel) => [...doc.querySelectorAll(sel)].find((n) => visible(n.getBoundingClientRect()) && !n.closest("[hidden]"));
  /** The things an event is about, the one its tip points at first. */
  const anchorsOf = (ev, h) => {
    const s = ev.subjects;
    const out = [];
    const graph = () => {
      const boxes = (h.boxes && h.boxes.waves) || {};
      const roots = (h.boxes && h.boxes.roots) || {};
      const card = s.roots.map((r) => fromFrame(h, roots[r])).find(Boolean);
      const wave = Number.isInteger(s.wave) ? fromFrame(h, boxes[s.wave]) : null;
      // A read's value, a plan: the card; a wave's news: its box.
      return ev.kind === "known" || ev.kind === "planned" || ev.kind === "pull-request" ? card || wave : wave || card;
    };
    const approvalEl = () => q("#k-callout:not([hidden])") || q(".k-box-hold.k-hold");
    const jobEl = () => (Number.isInteger(s.wave) ? q(`.r-job[data-k-wave="${s.wave}"]`) : null) || (s.job ? q("#k-drawer:not([hidden]) .k-drawer-head") : null);
    const badgeEl = () => (Number.isInteger(s.wave) ? q(`.k-badge.k-placed[data-k-wave="${s.wave}"]`) || q(`#k-metrics .k-metrics-wave[data-k-wave="${s.wave}"]`) : null);
    const add = (x) => {
      if (!x) return;
      if (x.getBoundingClientRect) out.push({ el: x, rect: x.getBoundingClientRect() });
      else out.push({ el: null, rect: x });
    };
    if (["held", "approved", "resumed"].includes(ev.kind)) add(approvalEl());
    if (ev.kind === "metrics") add(badgeEl());
    // A job's own news (it started, failed, ran again, has a trace) points at its job row first.
    if (["trace", "started", "failed", "refused", "rerun"].includes(ev.kind)) add(jobEl());
    add(graph());
    add(jobEl());
    if (ev.kind !== "metrics") add(badgeEl());
    // The first that is on screen leads; the same element twice counts once.
    return out.filter((a, i) => visible(a.rect) && (!a.el || out.findIndex((b) => b.el === a.el) === i));
  };

  // ---- tips ----------------------------------------------------------------
  const place = (node, rect) => {
    const W = doc.defaultView ? doc.defaultView.innerWidth : 1600;
    const w = node.offsetWidth || 200;
    const hgt = node.offsetHeight || 30;
    let x = rect.left + rect.width / 2 - w / 2;
    x = Math.max(8, Math.min(x, W - w - 8));
    let y = rect.top - hgt - 12;
    const below = y < 8;
    if (below) y = rect.top + rect.height + 12;
    node.classList.toggle("eh-below", below);
    const at = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    node.style.setProperty("--eh-at", at);
    node.style.transform = at;
  };
  const trailChip = (id) => trailHost && trailHost.querySelector(`.eh-chip[data-eh-id="${CSS.escape(id)}"]`);
  const showTips = (h) => {
    const t = now();
    const prev = st.tips;
    st.tips = tipsQueue(st.tips, { now: t });
    const up = new Set(st.tips.shown.map((x) => x.event.id));
    // Each tip whose time is up shrinks toward its chip on the trail, then goes.
    for (const [id, node] of st.nodes) {
      if (up.has(id)) continue;
      st.nodes.delete(id);
      const chip = trailChip(id) || (trailHost && trailHost.querySelector(".eh-chip:last-of-type"));
      if (chip && !reduced()) {
        const c = chip.getBoundingClientRect();
        const r = node.getBoundingClientRect();
        node.style.transform = `translate(${Math.round(c.left + c.width / 2 - r.width / 2)}px, ${Math.round(c.top - r.height / 2)}px) scale(0.2)`;
      }
      node.classList.add("eh-out");
      setTimeout(() => node.remove(), reduced() ? 250 : 650);
    }
    for (const { event } of st.tips.shown) {
      const anchors = anchorsOf(event, h);
      let node = st.nodes.get(event.id);
      if (!anchors.length) {
        if (node) node.style.visibility = "hidden";
        continue;
      }
      const isNew = !node;
      if (isNew) {
        node = el("div", "eh-tip", event.text);
        node.dataset.ehTone = toneOf(event.kind);
        node.setAttribute("role", "status");
        // A trace's tip opens the trace.
        if (event.kind === "trace" && Number.isInteger(event.subjects.wave)) {
          node.classList.add("eh-tip-go");
          node.title = "Open this wave's trace";
          const w = event.subjects.wave;
          node.addEventListener("click", () => openTrace(w));
        }
        tipsHost.appendChild(node);
        st.nodes.set(event.id, node);
      }
      node.style.visibility = "";
      place(node, anchors[0].rect);
      if (isNew) {
        // The things it is about glow while it is up, and light together across the panes.
        for (const a of anchors) if (a.el) glowOn(a.el, toneOf(event.kind));
        lightFor(event);
      }
    }
    if (prev && !st.tips.shown.length && st.lit && now() > st.litUntil) {
      light(null);
      st.lit = null;
    }
  };
  const glowOn = (node, tone) => {
    node.style.setProperty("--eh-glow", `var(--bar-${tone === "ok" ? "managed" : tone === "wait" ? "foreign" : tone === "bad" ? "degraded" : "pending"}, var(--focus))`);
    node.classList.add("eh-glow");
    const until = now() + TIP_MS;
    st.glows.push({ el: node, until });
  };
  const lightFor = (event) => {
    const s = event.subjects;
    st.lit = Number.isInteger(s.wave) ? { wave: s.wave } : s.roots.length ? { root: s.roots[0] } : null;
    st.litUntil = now() + TIP_MS;
    if (st.lit) light(st.lit);
  };
  const ageGlows = () => {
    const t = now();
    st.glows = st.glows.filter((g) => {
      if (g.until > t) return true;
      g.el.classList.remove("eh-glow");
      return false;
    });
    if (st.lit && t > st.litUntil) {
      st.lit = null;
      light(null);
    }
  };

  // ---- the trail -----------------------------------------------------------
  let trailKey = "";
  const drawTrail = (h) => {
    if (!trailHost) return;
    const facts = [...st.trail.values()].sort((a, b) => a.order - b.order);
    const key = facts.map((f) => `${f.id}=${f.text}`).join(",");
    trailHost.hidden = !facts.length;
    if (h.watch && h.caption && trailHost.style) {
      const c = h.caption.getBoundingClientRect();
      trailHost.style.bottom = c.height ? `${Math.round((doc.defaultView ? doc.defaultView.innerHeight : 0) - c.top)}px` : "";
    } else if (trailHost.style) trailHost.style.bottom = "";
    if (key === trailKey) return;
    trailKey = key;
    trailHost.replaceChildren(el("span", "eh-trail-label", TRAIL_WORDS));
    facts.forEach((f, i) => {
      if (i) trailHost.appendChild(el("span", "eh-sep", "›"));
      const chip = el("button", "eh-chip", f.text);
      chip.type = "button";
      chip.dataset.ehId = f.id;
      chip.dataset.ehTone = toneOf(f.kind);
      // A chip asked for shows its tip again: on a hover while Tips are on, on a click always.
      chip.addEventListener("pointerenter", () => st.on && replay(f));
      chip.addEventListener("click", () => replay(f));
      trailHost.appendChild(chip);
    });
    // The newest beat stays in view.
    trailHost.scrollLeft = trailHost.scrollWidth;
  };
  // A chip asked for takes the stage: the tips up now step aside for it.
  const replay = (f) => {
    for (const n of st.nodes.values()) n.remove();
    st.nodes.clear();
    st.tips = { shown: [], waiting: [f] };
    showTips(get());
  };

  // ---- modals --------------------------------------------------------------
  const openModal = (event, h) => {
    const d = h.demo;
    const nextAt = d && d.next && d.next.at ? Date.parse(d.next.at) : null;
    const mode = h.replay ? "replay" : "narrated";
    const t = shown();
    let data;
    if (event.kind === "held") {
      data = { title: Number.isInteger(event.subjects.wave) ? `Wave ${event.subjects.wave} waits for an approval` : "The plan waits for an approval", lines: [{ text: event.text }], panel: panel("held"), command: h.approveLine || null, at: d && d.step === "waiting" && /approve/.test((d.next && d.next.action) || "") ? nextAt : null, from: t, replayAt: t };
    } else if (event.kind === "failed" || event.kind === "refused") {
      data = { title: `Wave ${event.subjects.wave} failed`, lines: [{ text: event.text, lit: true }, ...(h.label ? [{ text: h.label }] : [])], action: d && d.next ? d.next.action : null, at: nextAt, from: t, replayAt: t };
    } else {
      const r = h.result;
      data = { title: "Applied", lines: [...(h.label ? [{ text: h.label }] : []), ...(r ? r.counts.map((c) => ({ text: c })) : [])], replayAt: t };
    }
    const kind = event.kind === "refused" ? "failed" : event.kind;
    const api = openEventModal(modalHost, { mode, kind, data, doc, now: shown, reduced: reduced(), onClose: () => (st.modal = null) });
    st.modal = { api, event, kind, step: d ? d.step : null, cycle: d ? d.cycle : null };
  };
  /** The modal's real event: the approval landed, the waves ran again, the cycle moved on. */
  const settleModal = (h, facts) => {
    const m = st.modal;
    if (!m || m.api.state.resolved) return;
    const d = h.demo;
    if (m.kind === "held") {
      const ok = facts.find((f) => f.kind === "approved" && (f.subjects.wave === m.event.subjects.wave || !Number.isInteger(m.event.subjects.wave)));
      if (ok) m.api.resolve(ok.text);
      else if (d && (d.cycle !== m.cycle || !["waiting", "approved"].includes(d.step))) m.api.resolve(d.cycle === m.cycle ? "approved; the waves run again" : null);
    } else if (m.kind === "failed") {
      if (d && (d.cycle !== m.cycle || ["resumed", "applying", "waiting", "applied"].includes(d.step))) m.api.resolve(d.cycle === m.cycle ? "the waves run again" : null);
    }
  };

  /** Read what the kiosk holds, find the news, and draw it. Called on every kiosk redraw. */
  const tick = () => {
    const h = get();
    if (!h || !h.demo) return;
    // behold#571 (#631): the story is told in the tool's own step order; until that is read, nothing is said in another's.
    if (h.stripReady === false) return;
    const stripKey = JSON.stringify((h.strip || []).map((x) => x.id));
    if (stripKey !== st.stripKey) {
      // Another tool's order: the trail is told again in it.
      st.stripKey = stripKey;
      st.trail.clear();
    }
    const facts = cycleFacts(ehSnapshot({ demo: h.demo, answer: h.answer, progress: h.progress, runDoc: h.runDoc, runDocs: h.runDocs || [], approval: h.approval, metrics: h.metrics, waveTraces: h.waveTraces || {}, strip: h.strip || null, waves: h.waves || [], failed: [...st.failed] }));
    if (h.demo.cycle !== st.cycle) {
      // A new cycle: a new story. Its first look is the trail so far, not news.
      // The first look at a page sees a cycle already under way: no news. A cycle that turns while the page is open is all news.
      if (st.cycle !== null) st.seen = new Set();
      else st.seen = null;
      st.cycle = h.demo.cycle;
      st.maxOrder = -Infinity;
      st.trail.clear();
      st.failed.clear();
    }
    for (const f of facts) if ((f.kind === "failed" || f.kind === "refused") && Number.isInteger(f.subjects.wave)) st.failed.add(f.subjects.wave);
    // While the page settles, everything is the story so far.
    const settling = now() - st.bootAt < SETTLE_MS;
    let news = settling ? [] : newEvents(st.seen, facts, { after: st.maxOrder - LATE_ORDER });
    st.seen = new Set([...(st.seen || []), ...facts.map((f) => f.id)]);
    for (const f of facts) if (f.kind !== "metrics" && f.kind !== "trace") st.maxOrder = Math.max(st.maxOrder, f.order);
    // A wave's numbers right after its own "applied" tip say little new: they wait for the badge.
    for (const f of news) if (f.kind === "applied-wave") st.appliedAt.set(f.subjects.wave, now());
    news = news.filter((f) => !(f.kind === "metrics" && now() - (st.appliedAt.get(f.subjects.wave) || -Infinity) < 30_000));
    // A beat keeps its place, and its words follow what the newest read says of it.
    for (const f of storyTrail(facts)) st.trail.set(f.id, f);
    drawTrail(h);
    settleModal(h, facts);
    if (!st.on) return;
    if (news.length) st.tips = tipsQueue(st.tips, { add: news, now: now() });
    // While a modal is up, the tips wait their turn behind it.
    if (!st.modal) showTips(h);
    ageGlows();
    st.modals = modalQueue(st.modals, { add: news, now: now(), lastInput: st.lastInput, open: !!st.modal });
    // A modal opens only while its event is still the step's: one that waited out a viewer at the page and went by is history.
    if (st.modals.next && stillNow(st.modals.next, h.demo)) openModal(st.modals.next, h);
  };
  const stillNow = (e, d) => (e.kind === "held" ? d.step === "waiting" : e.kind === "failed" || e.kind === "refused" ? d.step === "failed" : e.kind === "applied" ? d.step === "applied" : false);
  /** Keep the tips on their things while the graph moves (a shot, a pan). */
  const follow = () => {
    if (st.on && st.tips && st.tips.shown.length) showTips(get());
  };
  return { tick, follow, state: st, store: EH_STORE };
}
