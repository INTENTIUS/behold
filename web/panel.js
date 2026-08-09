// Floating control panel chrome — the Adobe-style palette that replaced the
// header strips. This module owns ONLY the chrome: drag by the tab strip,
// magnetic snap to viewport edges and corners, collapse to the bar (button or
// double-click), tab switching, and persistence. app.js renders what's inside
// the tabs (renderPanel* plus the #substrates/#dial/#actions hosts). Plain
// browser JS, no build step, themed entirely by the shared CSS vars — same
// rules as app.js.

const STORE_KEY = "behold.panel";
const MARGIN = 12; // gap kept between a snapped panel and the viewport edge
const SNAP = 32; // released within this many px of an edge → dock to it

let panel = null;
// snapX/snapY anchor an edge — a docked edge stays flush through window
// resizes and content-height changes; null means a free x/y position, clamped
// so the title bar can never leave the viewport.
let state = { x: 12, y: 110, snapX: "left", snapY: "top", collapsed: false, tab: "view" };

function loadState() {
  try {
    return { ...state, ...JSON.parse(localStorage.getItem(STORE_KEY) || "{}") };
  } catch {
    return { ...state };
  }
}
function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* private mode */
  }
}

// #186: no fixed chrome above the graph any more — top snap is the plain margin.
function topEdge() {
  return MARGIN;
}

function applyPosition() {
  if (!panel) return;
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  let x = state.snapX === "left" ? MARGIN : state.snapX === "right" ? window.innerWidth - w - MARGIN : state.x;
  let y = state.snapY === "top" ? topEdge() : state.snapY === "bottom" ? window.innerHeight - h - MARGIN : state.y;
  x = Math.max(60 - w, Math.min(x, window.innerWidth - 60));
  y = Math.max(0, Math.min(y, window.innerHeight - 34));
  panel.style.left = x + "px";
  panel.style.top = y + "px";
}

// On release: an edge within SNAP px of a viewport edge docks to it — both at
// once is a corner. Anywhere else keeps the free position.
function settle() {
  const r = panel.getBoundingClientRect();
  state.snapX = r.left <= MARGIN + SNAP ? "left" : window.innerWidth - r.right <= MARGIN + SNAP ? "right" : null;
  state.snapY = r.top <= topEdge() + SNAP ? "top" : window.innerHeight - r.bottom <= MARGIN + SNAP ? "bottom" : null;
  state.x = r.left;
  state.y = r.top;
  saveState();
  applyPosition();
}

// #184: the tab strip is the drag surface — a drag may START on a tab button
// (there is no other chrome to grab), so drag vs click is discriminated by
// movement: past 4px it's a drag, and the click that fires on release is
// swallowed in the capture phase so the tab doesn't also switch. The collapse
// chevron and the ⌘K pill opt out of dragging entirely — they're pure acts.
function initDrag(bar) {
  let suppressClick = false;
  bar.addEventListener(
    "click",
    (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("#panel-collapse, #hintk")) return;
    e.preventDefault();
    const r = panel.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 4) {
        moved = true;
        panel.classList.add("dragging");
      }
      if (!moved) return;
      panel.style.left = r.left + dx + "px";
      panel.style.top = r.top + dy + "px";
    };
    const onUp = () => {
      panel.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (moved) {
        suppressClick = true; // the release's click must not switch tabs
        settle();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

export function setPanelTab(tab, { expand = true } = {}) {
  if (!panel) return;
  state.tab = tab;
  for (const b of panel.querySelectorAll("#panel-tabs button[data-tab]")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const s of panel.querySelectorAll("#panel-body section")) s.classList.toggle("active", s.dataset.tab === tab);
  if (expand && state.collapsed) {
    setCollapsed(false); // saves state (incl. the new tab) + reapplies position
  } else {
    saveState();
    applyPosition(); // tab heights differ — keep a bottom-snapped panel flush
  }
}

function setCollapsed(on) {
  state.collapsed = !!on;
  panel.classList.toggle("collapsed", state.collapsed);
  const btn = document.getElementById("panel-collapse");
  if (btn) {
    btn.textContent = state.collapsed ? "▸" : "▾";
    btn.title = state.collapsed ? "Expand" : "Collapse";
  }
  saveState();
  applyPosition();
}
export function togglePanelCollapsed() {
  setCollapsed(!state.collapsed);
}
export function isPanelCollapsed() {
  return !!state.collapsed;
}

export function initPanel() {
  panel = document.getElementById("panel");
  if (!panel) return;
  state = loadState();
  const bar = document.getElementById("panel-tabs");
  initDrag(bar);
  bar.addEventListener("dblclick", (e) => {
    if (!e.target.closest("#panel-collapse, #hintk")) togglePanelCollapsed();
  });
  document.getElementById("panel-collapse").addEventListener("click", () => togglePanelCollapsed());
  // Clicking a tab while collapsed expands (setPanelTab's default).
  for (const b of panel.querySelectorAll("#panel-tabs button[data-tab]")) b.addEventListener("click", () => setPanelTab(b.dataset.tab));
  const known = [...panel.querySelectorAll("#panel-tabs button[data-tab]")].map((b) => b.dataset.tab);
  setCollapsed(state.collapsed);
  setPanelTab(known.includes(state.tab) ? state.tab : known[0], { expand: false });
  window.addEventListener("resize", applyPosition);
  // Tab-content re-renders change the panel's height — a bottom-snapped panel
  // must stay flush through them.
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => applyPosition()).observe(panel);
  applyPosition();
}
