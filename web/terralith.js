// `behold demo terralith`'s page: one estate per box, one card per resource,
// and a phase stepper. Moving between phases is a FLIP: every card keeps its
// address as its id, so a card glides from the terralith into the team box
// the split spawned, while that box fades in. Decisions live in
// terralith-steps.js and identity-mark.js; this file only draws.

import { PHASES, boxSubtitle, cardFace, cardNews, flipDelta, legendFor, phaseById, shownPhase, stepperItems } from "./terralith-steps.js";
import { identityMark, tagGlyphSvg } from "./identity-mark.js";

const POLL_MS = 3000;
const GLIDE_MS = 900;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const glyph = (kind, color) =>
  kind === "none" ? "" : `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">${tagGlyphSvg(kind, 1, 1, 12, color)}</svg>`;

function wantedFromUrl() {
  return new URLSearchParams(location.search).get("phase");
}

function setUrl(id) {
  const u = new URL(location.href);
  u.searchParams.set("phase", id);
  history.replaceState(null, "", u);
}

function renderSteps(host, model, shownId, onPick) {
  host.replaceChildren();
  for (const s of stepperItems(model, shownId)) {
    const li = el("li", `t-step${s.ran ? " ran" : ""}${s.shown ? " shown" : ""}${s.next ? " next" : ""}`);
    const b = el("b", null, String(s.n));
    li.append(b, document.createTextNode(s.label + (s.next ? " · next" : "")));
    if (s.ran) {
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      if (s.shown) li.setAttribute("aria-current", "step");
      li.addEventListener("click", () => onPick(s.id));
      li.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && onPick(s.id));
    }
    host.appendChild(li);
  }
}

function renderLead(host, phase) {
  host.replaceChildren();
  const copy = phaseById(phase.id);
  const left = el("div");
  left.append(el("h2", null, `${phase.n}. ${copy.title}`), el("p", null, copy.lead), el("p", "t-facts", copy.facts(phase)));
  const legend = el("ul", "t-legend");
  legend.setAttribute("aria-label", "What the tag on a card means");
  for (const m of legendFor(phase)) {
    const li = el("li");
    li.innerHTML = glyph(m.glyph, "var(--managed)") || "<i></i>";
    li.append(el("strong", null, m.label), el("span", null, m.tip));
    legend.appendChild(li);
  }
  host.append(left, legend);
}

function renderNext(host, model) {
  if (!model.next) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.replaceChildren();
  const copy = phaseById(model.next.id);
  const code = el("code", null, model.next.command);
  const btn = el("button", "t-copy", "copy");
  btn.type = "button";
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(model.next.command);
      btn.textContent = "copied";
    } catch {
      btn.textContent = "select and copy";
    }
    setTimeout(() => (btn.textContent = "copy"), 1600);
  });
  host.append(el("strong", null, `Next: ${copy ? copy.label.toLowerCase() : model.next.id}`), code, btn);
  host.append(el("span", "t-why", "Run it in the demo copy. The write is yours; this page moves on when the phase lands."));
}

function cardEl(card, phaseId) {
  const face = cardFace(card);
  const mark = identityMark(card.identity);
  const c = el("div", `t-card${phaseId === "split" && card.moved ? " moved" : ""}`);
  c.dataset.card = card.id;
  c.title = [card.id, card.liveId ? `live id: ${card.liveId}` : "", mark ? mark.tip : ""].filter(Boolean).join("\n");
  c.append(el("div", "k", face.kind), el("div", "n", face.name));
  // Under the name: the mark, then the phase's news about this card.
  if (mark) {
    const m = el("div", `m${mark.glyph === "solid" ? " solid" : ""}`);
    m.innerHTML = glyph(mark.glyph, "currentColor");
    m.append(el("span", "w", mark.label));
    c.appendChild(m);
  }
  const news = cardNews(card, phaseId);
  if (news) c.appendChild(el("div", news === "drifted" ? "news drifted" : "news", news));
  return c;
}

function renderStage(host, phase) {
  host.replaceChildren();
  for (const box of phase.boxes) {
    const b = el("section", `t-box${box.stock ? " stock" : ""}${box.spawned ? " spawned" : ""}`);
    b.dataset.box = box.id;
    const head = el("div", "t-box-head");
    head.append(el("h3", null, box.id), el("span", null, `${boxSubtitle(box)} · ${box.cards.length}`));
    const cards = el("div", "t-cards");
    for (const card of box.cards) cards.appendChild(cardEl(card, phase.id));
    b.append(head, cards);
    host.appendChild(b);
  }
}

/** Where every card and box is now, by id. */
function measure(root) {
  const at = new Map();
  for (const n of root.querySelectorAll("[data-card]")) at.set("c:" + n.dataset.card, n.getBoundingClientRect());
  for (const n of root.querySelectorAll("[data-box]")) at.set("b:" + n.dataset.box, n.getBoundingClientRect());
  return at;
}

/** The glide: each card starts where it was and moves to where it is. A box new to this phase fades in. */
function play(root, before) {
  if (!before || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const n of root.querySelectorAll("[data-box]")) {
    if (!before.has("b:" + n.dataset.box)) n.classList.add("spawning");
  }
  for (const n of root.querySelectorAll("[data-card]")) {
    const d = flipDelta(before.get("c:" + n.dataset.card), n.getBoundingClientRect());
    if (!d) continue;
    n.style.transition = "none";
    n.style.transform = `translate(${d.dx}px, ${d.dy}px)`;
    n.style.zIndex = "2";
  }
  // One frame at the old place, then the glide.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      for (const n of root.querySelectorAll("[data-card]")) {
        if (!n.style.transform) continue;
        n.style.transition = `transform ${GLIDE_MS}ms cubic-bezier(.25,.8,.25,1)`;
        n.style.transform = "";
        n.addEventListener("transitionend", () => {
          n.style.transition = "";
          n.style.zIndex = "";
        }, { once: true });
      }
    }),
  );
}

export function startTerralith(doc) {
  const steps = doc.getElementById("t-steps");
  const lead = doc.getElementById("t-lead");
  const next = doc.getElementById("t-next");
  const stage = doc.getElementById("t-stage");
  const notes = doc.getElementById("t-notes");
  let model = null;
  let shownId = null;
  let lastKey = "";

  const show = (id, { animate = true } = {}) => {
    const phase = shownPhase(model, id);
    renderSteps(steps, model, phase ? phase.id : null, (pick) => show(pick));
    renderNext(next, model);
    if (!phase) {
      lead.replaceChildren(el("p", "t-empty", `No phase has run yet. Run ${model.next ? model.next.command : "scripts/terralith-up.sh"} in the demo copy.`));
      stage.replaceChildren();
      return;
    }
    const before = animate && shownId && shownId !== phase.id ? measure(stage) : null;
    shownId = phase.id;
    setUrl(phase.id);
    renderLead(lead, phase);
    renderStage(stage, phase);
    notes.hidden = !phase.notes.length;
    notes.textContent = phase.notes.length ? `Some files could not be read: ${phase.notes.join("; ")}` : "";
    play(stage, before);
  };

  const load = async () => {
    try {
      const res = await fetch("/api/terralith", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fresh = await res.json();
      const key = JSON.stringify(fresh.phases.map((p) => [p.id, p.at]));
      if (key === lastKey) return;
      const grew = model && fresh.phases.length > model.phases.length;
      lastKey = key;
      model = fresh;
      // A phase that just landed is shown at once, gliding from the one before.
      show(grew ? fresh.phases[fresh.phases.length - 1].id : shownId || wantedFromUrl(), { animate: !!grew });
    } catch (err) {
      if (!model) lead.replaceChildren(el("p", "t-empty", `Waiting for the demo server (${err instanceof Error ? err.message : String(err)}).`));
    }
  };

  void load();
  setInterval(load, POLL_MS);
  return { show: (id) => show(id) };
}

export { PHASES };
