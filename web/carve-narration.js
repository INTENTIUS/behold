// The narration around a carve (#712, #715): the header, the Watch-style
// caption with its next line and progress bar, and the Tips bubbles on the
// boxes. The static export narrates a recording with it, under a "recorded"
// badge; the kiosk narrates the live carve with it (web/kiosk-carve.js), under
// a "live" badge. The dots layer (web/dots.js, in its `auto` mode)
// replays the recording, directs the camera, and hands this a state twice a
// second: the beat (web/dots-kiosk.js), the counts, and where each estate's
// box is on the page. A click on a bubble opens it in Tips' replay modal.

import { tipSpot, tipsStyle, TIPS_STYLE_ID } from "./kiosk-event-help-ui.js";
import { openEventModal } from "./event-help-modal.js";
import { TIP } from "./dots-kiosk.js";

const fmt = (n) => Number(n).toLocaleString("en-US");

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

const STOPS = [
  { id: "start", words: "one estate" },
  { id: "carve", words: "carving" },
  { id: "settled", words: "carved" },
];

/** The badge: "live" over a carve being written (#715), "recorded" over a replay. */
export function badgeText(state) {
  return state.recording && state.recording.kind === "live" ? "live" : "recorded";
}

/** The badge's tooltip: what the recording is, or where the live carve is read from. */
export function recordedWords(state) {
  const r = state.recording || {};
  if (r.kind === "live") {
    const n = r.resources ? `, ${fmt(r.resources)} resources` : "";
    const m = r.migration ? `; migration ${r.migration}` : "";
    return `live carve of ${state.src}${n}, drawn from the estate rosters and the migration's progress as terragucci writes them${r.from ? ` to ${r.from}` : ""}${m}`;
  }
  const what = r.kind === "walkthrough" ? "recorded walkthrough" : "recorded carve";
  const n = r.resources ? `, ${fmt(r.resources)} resources` : "";
  const when = r.recordedAt ? `, recorded ${new Date(r.recordedAt).toISOString().slice(0, 10)}` : "";
  return `${what} of ${state.src}${n}${when}, replayed`;
}

/** First landings that queue up together become one bubble, on the newest box. */
export function mergeLandings(tips, names = {}) {
  if (tips.length < 2) return tips[0] || null;
  const list = tips.map((x) => names[x.estate] || x.estate);
  const last = tips[tips.length - 1];
  return { ...last, text: `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}: their first resources land. live-mv rewrote the ownership tags; nothing was recreated.` };
}

/**
 * bar, caption: elements to draw into; tipsHost, modalHost: where bubbles and
 * modals go; origin(): the page offset of the layer the state's box rects are in.
 */
export function createNarration({ bar, caption, tipsHost, modalHost, origin }) {
  if (!document.getElementById(TIPS_STYLE_ID)) {
    const st = el("style");
    st.id = TIPS_STYLE_ID;
    st.textContent = tipsStyle();
    document.head.appendChild(st);
  }
  const queue = [];
  const shown = new Set();
  let tip = null;
  let lastTipAt = 0;
  let last = null;

  const anchorOf = (t, state) => {
    const o = origin();
    const r = t.estate && state.rects[t.estate];
    if (r) return { left: o.left + r.left, top: o.top + r.top, width: r.width, height: r.height };
    return { left: o.left + o.width / 2 - 60, top: o.top + o.height * 0.35, width: 120, height: 10 };
  };
  const placeTip = (state) => {
    if (!tip) return;
    const size = { w: tip.node.offsetWidth, h: tip.node.offsetHeight };
    const win = { w: window.innerWidth, h: window.innerHeight };
    let p;
    // The other boxes are what the bubble keeps off: it points at one estate, never sits on another's box or the source's.
    const o = origin();
    const others = Object.entries(state.rects || {})
      .filter(([e]) => e !== tip.t.estate)
      .map(([, r]) => ({ x: o.left + r.left, y: o.top + r.top, w: r.width, h: r.height }));
    try {
      p = tipSpot(anchorOf(tip.t, state), size, win, others);
    } catch {
      // A box off the page has no spot beside it: the bubble goes over the middle.
      p = tipSpot({ left: o.left + o.width / 2 - 60, top: o.top + o.height / 2, width: 120, height: 10 }, size, win);
    }
    tip.node.style.setProperty("--eh-at", `translate(${p.x}px, ${p.y}px)`);
    tip.node.style.transform = `translate(${p.x}px, ${p.y}px)`;
    tip.node.style.setProperty("--eh-arrow", `${p.arrow}px`);
    tip.node.classList.toggle("eh-below", p.below);
  };
  const tickTips = (state) => {
    const now = Date.now();
    if (tip && now - tip.at > TIP.showMs) {
      const n = tip.node;
      n.classList.add("eh-out");
      setTimeout(() => n.remove(), 700);
      tip = null;
      lastTipAt = now;
    }
    // A bubble about something long past, or not yet reached after a seek back, is dropped.
    while (queue.length && (queue[0].at > state.t || state.t - queue[0].at > TIP.staleMs)) queue.shift();
    if (!tip && queue.length && now - lastTipAt > TIP.gapMs && tipsHost) {
      let t = queue.shift();
      if (t.key.startsWith("land:")) {
        const group = [t];
        while (queue.length && queue[0].key.startsWith("land:")) group.push(queue.shift());
        t = mergeLandings(group, state.names);
      }
      const node = el("div", "eh-tip eh-tip-go", t.text);
      node.dataset.ehTone = t.tone;
      node.setAttribute("role", "status");
      node.title = "Open it";
      node.addEventListener("click", () => {
        if (!modalHost) return;
        openEventModal(modalHost, {
          mode: "replay",
          kind: t.tone === "bad" ? "failed" : "applied",
          data: { title: t.title || "The carve", lines: [{ text: t.text, lit: true }, { text: recordedWords(last || state) }], ...(t.recordedAt ? { replayAt: t.recordedAt } : {}) },
        });
      });
      tipsHost.appendChild(node);
      tip = { t, node, at: now };
    }
    placeTip(state);
  };

  const draw = (state) => {
    const b = state.beat;
    if (bar) {
      bar.replaceChildren();
      const place = el("div", "cx-place");
      const rec = el("span", `cx-rec cx-badge-${badgeText(state)}`, badgeText(state));
      rec.title = recordedWords(state);
      place.append(rec, el("span", "cx-src", state.src));
      bar.appendChild(place);
      const strip = el("ol", "cx-strip");
      const at = STOPS.findIndex((s) => s.id === b.phase);
      STOPS.forEach((s, i) => strip.appendChild(el("li", `cx-stop cx-${i < at ? "done" : i === at ? "current" : "ahead"}`, s.words)));
      bar.appendChild(strip);
    }
    if (caption) {
      caption.replaceChildren();
      const top = el("div", "cx-top");
      const h = el("h1", "cx-title");
      const rec = el("span", `cx-rec cx-badge-${badgeText(state)}`, badgeText(state));
      rec.title = recordedWords(state);
      h.append(rec, el("span", null, b.title));
      top.appendChild(h);
      const hold = state.holdLeft !== null && state.holdLeft !== undefined;
      const nx = el("p", "cx-next");
      if (!b.next) b.next = { text: "", fraction: 0 };
      nx.append(el("span", null, hold ? `starting again in ${state.holdLeft} s` : b.next.text));
      const nbar = el("span", `cx-nbar cx-tone-${hold ? "idle" : b.phase === "settled" ? "ok" : "busy"}`);
      const fill = el("span", "cx-nbar-in");
      fill.style.width = `${Math.round((hold ? 1 - state.holdLeft / 10 : b.next.fraction) * 1000) / 10}%`;
      nbar.appendChild(fill);
      nx.appendChild(nbar);
      top.appendChild(nx);
      caption.appendChild(top);
      const line = el("p", `cx-row cx-tone-${b.line.tone}`);
      line.append(el("span", "cx-label", b.line.label), el("span", "cx-text cx-lead", b.line.text));
      caption.appendChild(line);
      const tot = state.totals;
      const tally = el("p", "cx-row cx-tone-idle");
      const estatesN = Object.values(state.counts).filter((n) => n > 0).length;
      const estatesW = `${estatesN} estate${estatesN === 1 ? "" : "s"}`;
      const tallyText =
        state.recording && state.recording.kind === "live" && tot.moved !== undefined
          ? `${fmt(tot.moved)} moved · ${fmt(tot.stamped)} stamped · ${tot.refused} refused${tot.skipped ? ` · ${tot.skipped} skipped` : ""} · ${estatesW}`
          : `${fmt(tot.done)} of ${fmt(tot.moves)} flown · ${tot.refused} refused · ${estatesW}`;
      tally.append(el("span", "cx-label", "moves"), el("span", "cx-text", tallyText));
      caption.appendChild(tally);
    }
  };

  return {
    update(state) {
      if (state.type !== "behold:dots-state") {
        if (state.type === "behold:dots-ready") shown.clear();
        return;
      }
      // A new loop shows its Tips again.
      if (last && state.t < last.t) shown.clear();
      for (const t of state.tips || []) {
        if (shown.has(t.key)) continue;
        shown.add(t.key);
        queue.push(t);
      }
      last = state;
      draw(state);
      tickTips(state);
    },
  };
}
