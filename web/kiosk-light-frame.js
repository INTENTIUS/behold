// behold#937: the graph frame's half of a step's lighting (web/kiosk-light.js decides).
// Draws, over the terragucci marks the frame already has:
//   - lit and dimmed cards, the edges between lit cards at full weight (the `q`
//     view's look, #913, under its own `data-kl` marks so a query's repaint
//     never clears them), and a one-time pulse on what lit;
//   - each root's state file and its "written" mark, in one of three looks
//     (applied, partly applied, not applied);
//   - at most two attribute lines on a card: a value read from another estate ("known after apply", dashed amber,
//     until its producer applied, then the real value in green), or a known value that changed; no other attribute;
//   - the ghosted "plan again, approve again" approval, struck through;
//   - the resource's name first on its card, its type second.
// All of it is removed and drawn again on each call, so a redraw of the marks is harmless.

import { cardLines, cardTitle, lineState, planOf, rootsOf, stateMarks, stateWords } from "./kiosk-light.js";

const NS = "http://www.w3.org/2000/svg";
const make = (tag, attrs, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
};

/** Take back what the last call drew or changed. */
export function clearLight(svg) {
  if (!svg) return;
  for (const el of svg.querySelectorAll("[data-kl-layer]")) el.remove();
  for (const el of svg.querySelectorAll("[data-kl]")) el.removeAttribute("data-kl");
  for (const el of svg.querySelectorAll("[data-kl-pulse]")) el.removeAttribute("data-kl-pulse");
}

/**
 * Draw a step's lighting. `msg` is the last `behold:light` message (or null),
 * `answer` and `progress` the frame's reads (the paced run view), and `h` the
 * frame's helpers: `{ cardsOf(root), rootBox(root), compMode, pulsed }`.
 * `pulsed` is a `{ token }` box kept between calls so a beat pulses once.
 */
export function drawLight(svg, msg, answer, progress, h) {
  clearLight(svg);
  if (!svg || !msg || !answer || answer.error || !Array.isArray(answer.roots)) return;
  const plan = planOf(answer, progress);
  const layer = make("g", { "data-kl-layer": "1", "pointer-events": "none" });
  svg.appendChild(layer);

  // Cards lead with the resource's name, its type second.
  if (!h.compMode) nameFirst(svg, plan);

  // Lit and dimmed.
  if (msg.lit) {
    const lit = new Set(msg.ids);
    const litRoots = new Set(msg.roots);
    const cards = [...svg.querySelectorAll("[data-node-id]")];
    const isLit = (g) => (h.compMode ? litRoots.has(rootOfCard(answer, g.getAttribute("data-node-id"), h)) : lit.has(g.getAttribute("data-node-id")));
    const fresh = h.pulsed && h.pulsed.token !== msg.token;
    for (const g of cards) {
      const on = isLit(g);
      g.setAttribute("data-kl", on ? "lit" : "dim");
      if (on && fresh) g.setAttribute("data-kl-pulse", "1");
    }
    if (h.pulsed) h.pulsed.token = msg.token;
    const state = new Map(cards.map((g) => [g.getAttribute("data-node-id"), g.getAttribute("data-kl")]));
    for (const e of svg.querySelectorAll("g[data-edge-from]")) {
      e.setAttribute("data-kl", state.get(e.getAttribute("data-edge-from")) === "lit" && state.get(e.getAttribute("data-edge-to")) === "lit" ? "path" : "dim");
    }
    // The reads between roots: at full weight between two lit roots, dim otherwise.
    for (const l of svg.querySelectorAll("line[data-tg-read-from]")) {
      l.setAttribute("data-kl", litRoots.has(l.getAttribute("data-tg-read-from")) && litRoots.has(l.getAttribute("data-tg-read-to")) ? "path" : "dim");
    }
  } else if (h.pulsed) h.pulsed.token = msg.token;

  if (msg.labels) {
    drawStates(layer, answer, progress, h);
    if (!h.compMode) drawSlots(layer, svg, plan, answer, progress, h, msg);
  }
  if (msg.ghost) drawGhost(layer, h);
}

function rootOfCard(answer, id, h) {
  const r = (answer.roots || []).find((x) => h.cardsOf(x.path).some((g) => g.getAttribute("data-node-id") === id));
  return r ? r.path : null;
}

function nameFirst(svg, plan) {
  const byCard = new Map([...plan.resources.values()].filter((r) => r.cardId).map((r) => [r.cardId, r]));
  for (const g of svg.querySelectorAll("[data-node-id]")) {
    const res = byCard.get(g.getAttribute("data-node-id"));
    if (!res || !res.type) continue;
    const texts = [...g.querySelectorAll(":scope > text")];
    const title = texts.find((t) => t.getAttribute("visibility") !== "hidden" && (t.textContent || "").trim());
    if (!title) continue;
    const { name, type } = cardTitle(res.address);
    title.textContent = name;
    // The kind line the kiosk hides ("terraform_data · terraform") becomes the type, second.
    const kind = texts.find((t) => t.hasAttribute("data-kiosk-quiet") && / · /.test(t.textContent || ""));
    if (kind) {
      kind.textContent = type;
      kind.removeAttribute("visibility");
      kind.setAttribute("data-kl", "type");
    }
  }
}

/** Each root's state file label, with its written mark and its look. */
function drawStates(layer, answer, progress, h) {
  const marks = stateMarks(answer, progress);
  for (const r of rootsOf(answer)) {
    const m = marks[r.path];
    // behold#940: a label rides inside its box's own group when the graph has one, so it moves, grows and reflows with the box.
    const host = h.boxHost ? h.boxHost(r.path) : null;
    const box = host || h.rootBox(r.path);
    if (!m || !box) continue;
    // behold#939: a prompt-driven step draws the roots' resources, which fill their boxes: the label goes under the box, off the cards.
    const y = h.below ? box.y2 + 26 : box.y2 - 12;
    const g = make("g", { "data-kl-state": r.path, "data-kl-look": m.look || "none", "pointer-events": "none" });
    if (host) g.setAttribute("data-kl-layer", "1");
    const words = stateWords(m);
    if (!words) continue; // an estate with nothing decided yet: its box's title already names it
    const w = Math.max(120, words.length * 7.4 + 20);
    const x = box.x + 14;
    const rect = make("rect", { x, y: y - 17, width: w, height: 22, rx: 4, fill: "var(--panel, var(--bg))", stroke: "var(--frame-neutral, var(--neutral))", "stroke-width": 1.5 });
    // Three looks, by shape as well as colour: solid is applied, half filled with a dashed edge is partly applied, hollow dotted is not applied.
    let ink = "var(--fg)";
    if (m.look === "applied") {
      rect.setAttribute("fill", "var(--frame-managed, var(--managed))");
      rect.setAttribute("stroke", "var(--frame-managed, var(--managed))");
      ink = "var(--bg)";
      g.appendChild(rect);
    } else if (m.look === "partial") {
      rect.setAttribute("stroke", "var(--frame-pending, var(--pending))");
      rect.setAttribute("stroke-dasharray", "6 3");
      g.appendChild(rect);
      g.appendChild(make("rect", { x, y: y - 17, width: w / 2, height: 22, rx: 4, fill: "var(--frame-pending, var(--pending))", opacity: 0.45 }));
    } else if (m.look === "not-applied") {
      rect.setAttribute("stroke-dasharray", "2 3");
      rect.setAttribute("fill", "none");
      g.appendChild(rect);
      ink = "var(--muted)";
    } else g.appendChild(rect);
    g.appendChild(make("text", { x: x + 10, y: y - 1.5, "font-size": 13, "font-weight": 700, fill: ink }, words));
    g.appendChild(make("title", {}, m.estate ? `${r.path} is an estate: it keeps records, not a state file${m.written ? "; the apply wrote them" : ""}` : `${r.path}'s state file is ${m.file}${m.from === "path" ? " (named from the root's path)" : ""}${m.written ? "; the apply wrote it" : ""}`));
    (host ? host.parent : layer).appendChild(g);
  }
}

/** A card's attribute lines (web/kiosk-light.js cardLines): unknown dashed amber, applied or changed solid. */
function drawSlots(layer, svg, plan, answer, progress, h, msg) {
  const byCard = new Map();
  for (const s of cardLines(plan, msg && msg.light)) {
    if (!byCard.has(s.cardId)) byCard.set(s.cardId, []);
    byCard.get(s.cardId).push(s);
  }
  for (const [id, slots] of byCard) {
    const card = svg.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
    const rect = card && card.querySelector(":scope > rect");
    if (!rect) continue;
    const b = rect.getBBox();
    slots.forEach((s, i) => {
      const st = lineState(s, answer, progress);
      const words = st.text;
      // behold#940: a card the scene drew (data-kl-synth) has room under it for its lines, in bigger type; a graph card's hang over its foot.
      const synth = card.hasAttribute("data-kl-synth");
      const size = synth ? 14 : 11.5;
      // One line, inside the card: a long value ends in an ellipsis.
      const fit = Math.max(8, Math.floor((b.width - 28) / (size * 0.6)));
      // A filled line's payoff is its end (the id the producer made): cut from the middle, and drop the attribute's name before the end.
      const shown = words.length <= fit ? words : fit - 9 >= 14 ? `${words.slice(0, 6)}...${words.slice(words.length - (fit - 9))}` : `...${words.slice(words.length - (fit - 3))}`;
      const w = synth ? b.width - 12 : Math.min(b.width - 12, Math.max(90, shown.length * 6.8 + 16));
      const rowH = synth ? 22 : 18;
      const y = synth ? b.y + b.height + 6 + rowH + i * 26 : b.y + b.height - 3 + i * 22;
      const ink = st.state === "applied" ? "var(--frame-managed, var(--managed))" : "var(--frame-pending, var(--pending))";
      const g = make("g", { "data-kl-slot": id, "data-kl-filled": st.state === "applied" ? "1" : "0", "data-kl-line": st.state });
      g.setAttribute("transform", card.getAttribute("transform") || "");
      // Unknown: a dashed amber outline with a hollow inside. Applied: solid green, tinted. A changed value: solid amber.
      g.appendChild(make("rect", { x: b.x + 6, y: y - rowH, width: w, height: rowH, rx: 3, fill: st.state === "unknown" ? "var(--bg)" : ink, "fill-opacity": st.state === "unknown" ? 1 : 0.25, stroke: ink, "stroke-width": 1.5, "stroke-dasharray": st.state === "unknown" ? "4 3" : "none" }));
      g.appendChild(make("text", { x: b.x + 12, y: y - (synth ? 6 : 5), "font-size": size, "font-weight": 600, fill: "var(--fg)" }, shown));
      layer.appendChild(g);
    });
  }
}

/** The approval the change does not need: faded, between network and app, then struck through. */
function drawGhost(layer, h) {
  const a = h.rootBox("network");
  const b = h.rootBox("app");
  if (!a || !b) return;
  const cx = (a.x + a.x2 + b.x + b.x2) / 4;
  const cy = (a.y + a.y2 + b.y + b.y2) / 4;
  const words = "plan again, approve again";
  const w = words.length * 8.6 + 28;
  const g = make("g", { "data-kl-ghost": "1", opacity: 0.55 });
  g.appendChild(make("rect", { x: cx - w / 2, y: cy - 16, width: w, height: 32, rx: 6, fill: "var(--panel, var(--bg))", stroke: "var(--frame-foreign, var(--foreign))", "stroke-width": 2, "stroke-dasharray": "6 4" }));
  g.appendChild(make("text", { x: cx, y: cy + 5, "text-anchor": "middle", "font-size": 15, "font-weight": 600, fill: "var(--fg)" }, words));
  // The strike draws itself after the approval has been on screen a moment.
  const strike = make("line", { x1: cx - w / 2 + 6, y1: cy, x2: cx + w / 2 - 6, y2: cy, stroke: "var(--frame-degraded, var(--degraded))", "stroke-width": 3, class: "kl-strike", pathLength: 1 });
  g.appendChild(strike);
  layer.appendChild(g);
}
