// behold#940: ask mode's two ways of putting the roots where the room is.
//
//   askDeltas   the graph the page drew, its roots moved into a stack (as layout deltas web/app.js paints);
//   sceneModel  a composed choudoufu run: the graph has none of the run's resources (an estate keeps no state
//               file, and the checkout is as of the base), so the scene is drawn from the run's reports;
//   drawScene   puts a scene model in the svg, in place of the graph's own boxes, cards and edges.
//
// The scene keeps the graph's own hooks (`data-group-id` on a box, `data-node-id` on a card, `data-edge-from`
// on an edge), so lighting, the reads between roots and the state labels work on it as they do on the graph.
// The positions come from web/kiosk-ask-layout.js; the first two are pure.

import { askLayout, orderRoots } from "./kiosk-ask-layout.js";
import { applyOf, cardLines, cardTitle } from "./kiosk-light.js";
import { HOLE_WORDS, KIND_TAGS, memberKinds } from "./member-kind.js";

/** What hangs under a card for each unknown value it carries (web/kiosk-light-frame.js drawSlots). */
export const SLOT_ROW = 26;
export const CARD_W = 340;
export const CARD_H = 60;

/** How many attribute lines (at most two) each card id carries. */
export function slotCounts(plan) {
  const out = {};
  for (const s of cardLines(plan)) if (s.cardId) out[s.cardId] = (out[s.cardId] || 0) + 1;
  return out;
}

const upstreamFirst = (roots, edges) => {
  const byPath = new Map(roots.map((r) => [r.path, r]));
  return orderRoots(roots.map((r) => r.path), edges).map((p) => byPath.get(p));
};

/**
 * The deltas that stack the drawn graph's roots. `nodes` maps a card id to `{ rect: { x, y, w, h } }` and `boxes` a
 * box id (`box:<root name>`) to `{ x, y, w0, h0 }`, both as the page drew them. Returns `{ deltas, layout }`, with
 * `deltas[id] = { dx, dy }` (and `dw`, `dh` for a box), or null when no root has a box and cards to move.
 */
export function askDeltas({ roots, nodes, boxes, extras = {}, edges = [], open }) {
  const ordered = upstreamFirst(roots, edges);
  const input = [];
  for (const r of ordered) {
    const box = boxes.get(`box:${r.name}`);
    const prefix = `${r.member}/${r.name}/`;
    const cards = [...nodes].filter(([id, n]) => id.startsWith(prefix) && n.rect).map(([id, n]) => ({ id, w: n.rect.w, h: n.rect.h + (extras[id] || 0) }));
    if (box && cards.length) input.push({ id: `box:${r.name}`, cards, box });
  }
  if (!input.length) return null;
  const layout = askLayout(input, open);
  const x0 = Math.min(...input.map((r) => r.box.x));
  const y0 = Math.min(...input.map((r) => r.box.y));
  const deltas = {};
  for (const r of input) {
    const b = layout.boxes[r.id];
    deltas[r.id] = { dx: x0 + b.x - r.box.x, dy: y0 + b.y - r.box.y, dw: b.w - r.box.w0, dh: b.h - r.box.h0 };
    for (const c of r.cards) {
      const at = layout.cards[c.id];
      const n = nodes.get(c.id);
      deltas[c.id] = { dx: x0 + at.x - n.rect.x, dy: y0 + at.y - n.rect.y };
    }
  }
  return { deltas, layout };
}

/**
 * A composed choudoufu run's scene: each estate's box and cards from `answer.estateScene`, laid out for `open`, and
 * an edge for each reach the blast radius names. Null when the answer holds no scene.
 *
 * behold#1008: a composed chant run says what each member is (`answer.chant.members`, web/member-kind.js). Each root
 * then carries `kind` (hole, previewed or plain), and a hole with nothing previewed keeps its box with one empty slot
 * (`hole`: where its cards would be, and why there are none).
 */
export function sceneModel(answer, plan, progress, open) {
  const kinds = memberKinds(answer);
  const isHole = (r) => r.hole === true || (kinds.get(r.path) || {}).kind === "hole";
  const scene = answer && answer.estateScene && Array.isArray(answer.estateScene.roots) ? answer.estateScene.roots.filter((r) => (r.resources && r.resources.length) || (r.path && r.name && isHole(r))) : [];
  if (!scene.length) return null;
  const extras = slotCounts(plan);
  const ordered = upstreamFirst(scene, plan.edges);
  const holeSlot = (r) => `${r.member}/${r.name}/~hole`;
  const resourcesOf = (r) => r.resources || [];
  const input = ordered.map((r) => ({
    id: r.path,
    cards: resourcesOf(r).length
      ? r.resources.map((res) => {
          const id = `${r.member}/${r.name}/${res.address}`;
          return { id, w: CARD_W, h: CARD_H + (extras[id] ? extras[id] * SLOT_ROW + 10 : 0) };
        })
      : [{ id: holeSlot(r), w: CARD_W, h: CARD_H }],
  }));
  const layout = askLayout(input, open);
  const roots = ordered.map((r) => {
    const box = layout.boxes[r.path];
    const outcome = applyOf(r.path, progress);
    const done = outcome ? outcome.apply === "applied" || outcome.apply === "no-changes" : null;
    const known = kinds.get(r.path);
    const kind = isHole(r) ? "hole" : known ? known.kind : null;
    return {
      path: r.path,
      name: r.name,
      member: r.member,
      ...box,
      ...(kind ? { kind } : {}),
      ...(!resourcesOf(r).length ? { hole: { ...layout.cards[holeSlot(r)], words: HOLE_WORDS, reasons: known ? known.reasons : [] } } : {}),
      cards: resourcesOf(r).map((res) => {
        const id = `${r.member}/${r.name}/${res.address}`;
        const at = layout.cards[id];
        const { name, type } = cardTitle(res.address);
        // The run view says each estate's part of the apply as it happens; the reports say it once they list it as applied.
        const applied = done === null ? res.state === "applied" : done;
        return { id, address: res.address, name, type, action: res.action, applied, ...at, h: CARD_H };
      }),
    };
  });
  const at = new Map(roots.flatMap((r) => r.cards).map((c) => [c.id, c]));
  const keyOf = new Map();
  for (const r of roots) for (const c of r.cards) keyOf.set(`${r.path}/${c.address}`, c.id);
  const edges = [];
  // Only between roots that sit next to each other: a line past a box to one beyond it crosses what is between.
  const place = new Map(roots.map((r, i) => [r.path, i]));
  for (const [seed, reaches] of plan.reaches) {
    const from = keyOf.get(seed);
    for (const x of reaches || []) {
      const to = keyOf.get(`${x.root}/${x.address}`);
      if (from && to && from !== to && Math.abs(place.get(seed.slice(0, seed.indexOf("/"))) - place.get(x.root)) <= 1 && !edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to, d: edgePath(at.get(from), at.get(to)) });
    }
  }
  return { roots, edges, width: layout.width, height: layout.height, cols: layout.cols };
}

/** The words in a box whose plan is not written yet. */
export const WAITING_WORDS = "waiting for the plan";

/**
 * The scene while the plan is not there to draw (a pull request being planned, the reset between acts): each
 * estate the reports name, upstream on top, with one empty slot where its cards will be. Without it the pane holds
 * dark until the plan job writes the plan, or keeps the last act's cards under the next act's title. Null when the
 * reports name no estate.
 */
export function waitingModel(answer, plan, open) {
  const scene = answer && answer.estateScene && Array.isArray(answer.estateScene.roots) ? answer.estateScene.roots.filter((r) => r && r.path && r.name) : [];
  if (!scene.length) return null;
  const ordered = upstreamFirst(scene, (plan && plan.edges) || []);
  const slotOf = (r) => `${r.member}/${r.name}/~waiting`;
  const layout = askLayout(ordered.map((r) => ({ id: r.path, cards: [{ id: slotOf(r), w: CARD_W, h: CARD_H }] })), open);
  const roots = ordered.map((r) => ({ path: r.path, name: r.name, member: r.member, ...layout.boxes[r.path], cards: [], waiting: { ...layout.cards[slotOf(r)], words: WAITING_WORDS } }));
  return { roots, edges: [], width: layout.width, height: layout.height, cols: layout.cols, waiting: true };
}

/** A curve from one card's edge to the other's, on the sides that face. */
export function edgePath(a, b) {
  if (b.y >= a.y + a.h) {
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2;
    const y2 = b.y;
    const k = (y2 - y1) / 2;
    return `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`;
  }
  if (a.y >= b.y + b.h) return edgePath(b, a);
  const right = b.x >= a.x;
  const x1 = right ? a.x + a.w : a.x;
  const x2 = right ? b.x : b.x + b.w;
  const y1 = a.y + a.h / 2;
  const y2 = b.y + b.h / 2;
  const k = Math.abs(x2 - x1) / 2;
  return `M ${x1} ${y1} C ${x1 + (right ? k : -k)} ${y1}, ${x2 + (right ? -k : k)} ${y2}, ${x2} ${y2}`;
}

// ---------------------------------------------------------------------------
// The svg.
// ---------------------------------------------------------------------------

const NS = "http://www.w3.org/2000/svg";
const make = (tag, attrs, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
};
const tone = (action) => (action === "delete" ? "var(--frame-degraded, var(--degraded))" : action === "update" || action === "replace" ? "var(--frame-pending, var(--pending))" : "var(--frame-managed, var(--managed))");

/** Take back the graph's own drawing, drop the scene. */
export function clearScene(svg) {
  if (!svg) return;
  for (const el of svg.querySelectorAll(":scope > [data-kl-scene]")) el.remove();
  const stash = svg.__klStash;
  if (stash) {
    for (const el of stash) svg.appendChild(el);
    svg.__klStash = null;
  }
}

/**
 * Draw `model` in place of the graph's boxes, cards and edges. The graph's own elements are set aside (kept, to come
 * back with clearScene) the first time; every call after draws the scene again.
 */
export function drawScene(svg, model) {
  if (!svg || !model) return;
  if (!svg.__klStash) {
    const keep = (el) => /^(defs|style|title|desc)$/i.test(el.tagName);
    svg.__klStash = [...svg.children].filter((el) => !keep(el) && !el.hasAttribute("data-kl-scene"));
    for (const el of svg.__klStash) el.remove();
  }
  for (const el of svg.querySelectorAll(":scope > [data-kl-scene]")) el.remove();
  const scene = make("g", { "data-kl-scene": "1" });
  for (const e of model.edges) {
    const g = make("g", { "data-edge-from": e.from, "data-edge-to": e.to });
    g.appendChild(make("path", { d: e.d, fill: "none", stroke: "var(--muted)", "stroke-width": 2, opacity: 0.45 }));
    scene.appendChild(g);
  }
  for (const r of model.roots) {
    // behold#1008: a hole's box is dashed in the degraded tone; a hole's and a previewed member's carry a tag saying so.
    const g = make("g", { "data-layout-box": `box:${r.name}`, ...(r.kind ? { "data-member-kind": r.kind } : {}) });
    const hole = r.kind === "hole";
    g.appendChild(make("rect", { "data-group-id": r.name, x: r.x, y: r.y, width: r.w, height: r.h, rx: 16, fill: "var(--panel, var(--bg))", "fill-opacity": 0.6, stroke: hole ? "var(--frame-degraded, var(--degraded))" : "var(--frame-neutral, var(--neutral))", "stroke-width": hole ? 2 : 1.5, ...(hole ? { "stroke-dasharray": "10 6" } : {}) }));
    g.appendChild(make("text", { x: r.x + 18, y: r.y + 26, "font-size": 20, "font-weight": 700, "letter-spacing": ".5", fill: "var(--muted)" }, r.name));
    const tag = r.kind && KIND_TAGS[r.kind];
    if (tag) {
      const color = hole ? "var(--frame-degraded, var(--degraded))" : "var(--frame-pending, var(--pending))";
      const w = tag.length * 8.5 + 20;
      const mark = make("g", { "data-kl-kind-mark": r.kind });
      mark.appendChild(make("rect", { x: r.x + r.w - w - 14, y: r.y + 9, width: w, height: 24, rx: 12, fill: "none", stroke: color, "stroke-width": 1.5 }));
      mark.appendChild(make("text", { x: r.x + r.w - w / 2 - 14, y: r.y + 26, "text-anchor": "middle", "font-size": 14, "font-weight": 600, fill: color }, tag));
      g.appendChild(mark);
    }
    scene.appendChild(g);
    if (r.hole) {
      // Where the hole's cards would be: no data-node-id, as the waiting slot has none.
      const h = r.hole;
      const slot = make("g", { "data-kl-hole": r.name });
      slot.appendChild(make("rect", { x: h.x, y: h.y, width: h.w, height: h.h, rx: 12, fill: "none", stroke: "var(--frame-degraded, var(--degraded))", "stroke-width": 1.5, "stroke-dasharray": "6 5" }));
      slot.appendChild(make("text", { x: h.x + h.w / 2, y: h.y + h.h / 2 + 5, "text-anchor": "middle", "font-size": 15, fill: "var(--muted)" }, h.words));
      if (h.reasons && h.reasons.length) slot.appendChild(make("title", {}, h.reasons.join("\n")));
      scene.appendChild(slot);
    }
    if (r.waiting) {
      // No data-node-id: the lighting and the reads look for cards, and this is where they will be, not one of them.
      const w = r.waiting;
      const slot = make("g", { "data-kl-waiting": r.name });
      slot.appendChild(make("rect", { x: w.x, y: w.y, width: w.w, height: w.h, rx: 12, fill: "none", stroke: "var(--frame-neutral, var(--neutral))", "stroke-width": 1.5, "stroke-dasharray": "6 5" }));
      slot.appendChild(make("text", { x: w.x + w.w / 2, y: w.y + w.h / 2 + 5, "text-anchor": "middle", "font-size": 15, fill: "var(--muted)" }, w.words));
      scene.appendChild(slot);
    }
    for (const c of r.cards) {
      const card = make("g", { "data-node-id": c.id, "data-kl-synth": "1" });
      const edge = c.applied ? "var(--frame-managed, var(--managed))" : "var(--frame-pending, var(--pending))";
      card.appendChild(make("rect", { x: c.x, y: c.y, width: c.w, height: c.h, rx: 12, fill: "var(--panel, var(--bg))", stroke: edge, "stroke-width": 2 }));
      card.appendChild(make("rect", { x: c.x, y: c.y, width: 6, height: c.h, rx: 3, fill: tone(c.action) }));
      card.appendChild(make("text", { x: c.x + 20, y: c.y + 27, "font-size": 20, "font-weight": 700, fill: "var(--fg)" }, c.name));
      card.appendChild(make("text", { x: c.x + 20, y: c.y + 47, "font-size": 14, fill: "var(--muted)" }, c.type + (c.action ? ` · ${c.action}` : "")));
      scene.appendChild(card);
    }
  }
  svg.appendChild(scene);
}

/**
 * Whether the scene drawn on `svg` should stay when its data goes missing: it is there, and the graph's own elements
 * set aside under it hold no card to go back to (a composed run's graph has none, so going back is a blank pane).
 */
export function sceneHoldsOn(svg) {
  if (!svg || !svg.__klStash || !svg.querySelector(":scope > [data-kl-scene]")) return false;
  const own = svg.__klStash.some((el) => (el.hasAttribute && el.hasAttribute("data-node-id")) || (el.querySelector && el.querySelector("[data-node-id]")));
  return !own;
}
