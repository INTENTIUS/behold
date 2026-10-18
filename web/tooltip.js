// behold#725: one small tooltip for the page, in place of the browser's own
// for an SVG <title>. The browser's shows only under a resting mouse; this one
// also opens when a badge takes keyboard focus, closes on Escape, and is
// position: fixed, so a scrolling pane can't clip it. Screen readers get it
// through aria-describedby on the element it describes.
//
// The graph's marks keep their <title> elements as app.js draws them, so an
// exported SVG still carries every tooltip's words. While a mark is hovered or
// focused, its <title> is emptied (the browser then has nothing to show) and
// its words go into the shared tooltip; they go back when the pointer or the
// focus leaves. An HTML element can ask for the tooltip with data-tip.

export const TIP_ID = "b-tip";
/** The room between the tooltip and what it describes, and between it and the window's edge, in px. */
export const TIP_GAP = 8;
export const TIP_MARGIN = 8;
/** How long a pointer rests before the tooltip opens; focus opens it at once. */
export const HOVER_MS = 250;

/**
 * Where the tooltip goes: centred under its target, above it when there is no
 * room below, and kept inside the window's sides.
 * `target` is a client rect, `size` the tooltip's, `view` the window's.
 */
export function placeTip(target, size, view, { gap = TIP_GAP, margin = TIP_MARGIN } = {}) {
  const below = target.bottom + gap;
  const above = target.top - gap - size.height;
  const fitsBelow = below + size.height <= view.height - margin;
  const side = fitsBelow || above < margin ? "below" : "above";
  const top = side === "below" ? below : above;
  const centred = (target.left + target.right) / 2 - size.width / 2;
  const left = Math.max(margin, Math.min(centred, view.width - margin - size.width));
  return { left: Math.round(left), top: Math.round(Math.max(margin, top)), side };
}

/** An id list (aria-describedby) with `id` in it once. */
export function addId(list, id) {
  const ids = String(list || "").split(/\s+/).filter(Boolean);
  return ids.includes(id) ? ids.join(" ") : [...ids, id].join(" ");
}
/** An id list without `id`. */
export function dropId(list, id) {
  return String(list || "").split(/\s+/).filter((x) => x && x !== id).join(" ");
}

const tagOf = (node) => String((node && (node.localName || node.tagName || node.nodeName)) || "").toLowerCase();

/** The <title> an SVG element carries as its own child, or null. */
export function ownTitle(node) {
  for (const c of (node && node.children) || []) if (tagOf(c) === "title") return c;
  return null;
}

/**
 * Whether an SVG element with a <title> is a badge, a mark drawn on a card or
 * a box, which the keyboard should reach. The card itself, an edge and the
 * drawing as a whole are not: the card has its own click, and a tab stop on
 * every edge would bury the badges.
 */
export function isBadge(node) {
  if (!node || !node.getAttribute) return false;
  if (tagOf(node) === "svg") return false;
  return !node.hasAttribute("data-node-id") && !node.hasAttribute("data-edge-from") && !node.hasAttribute("data-edge-via");
}

/**
 * The element under `node` (or `node` itself) whose words a tooltip shows: the
 * nearest with data-tip, or with a <title> child that has words. `current` is
 * the element whose <title> is emptied while it is shown, so it still counts.
 */
export function tipHost(node, current = null) {
  for (let n = node; n && n.nodeType === 1; n = n.parentNode) {
    if (n === current) return n;
    if (n.hasAttribute && n.hasAttribute("data-tip") && n.getAttribute("data-tip")) return n;
    const t = ownTitle(n);
    if (t && (t.textContent || "").trim()) return n;
    if (tagOf(n) === "body") break;
  }
  return null;
}

/** Give every badge under `root` that has a <title> a tab stop. Returns how many it gave one. */
export function reachBadges(root) {
  let n = 0;
  if (!root || !root.querySelectorAll) return 0;
  for (const t of root.querySelectorAll("svg title")) {
    const host = t.parentNode;
    if (!isBadge(host) || host.hasAttribute("tabindex") || !(t.textContent || "").trim()) continue;
    host.setAttribute("tabindex", "0");
    n++;
  }
  return n;
}

/**
 * behold#744: an edge, or a line drawn over the graph, whose tooltip goes by
 * the pointer: its own box can span the drawing. The edges are also all a
 * kiosk frame shows a tooltip for: its cards have the frame's popover.
 */
export function isLine(node) {
  return !!(node && node.hasAttribute && (node.hasAttribute("data-edge-from") || node.hasAttribute("data-tg-read-hit")));
}

/**
 * Wire the tooltip into `doc`. `scope` names the part of the page whose SVG
 * badges get tab stops as they are drawn. A kiosk frame (the root's .bare) has
 * its own popover and nothing to focus, so it gets neither, save a tooltip on
 * an edge (behold#744), which the browser's own shows late or not at all.
 */
export function installTooltips(doc = typeof document !== "undefined" ? document : null, { scope = "#graph", setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!doc || !doc.documentElement || !doc.body) return () => {};
  const off = () => doc.documentElement.classList && doc.documentElement.classList.contains("bare");
  const win = doc.defaultView || (typeof window !== "undefined" ? window : null);
  let tip = null;
  let current = null; // { host, title, text, timer }

  const ensureTip = () => {
    if (tip) return tip;
    tip = doc.getElementById(TIP_ID) || doc.createElement("div");
    tip.id = TIP_ID;
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    if (!tip.parentNode) doc.body.appendChild(tip);
    return tip;
  };
  const show = () => {
    if (!current) return;
    const t = ensureTip();
    t.textContent = current.text;
    t.hidden = false;
    const at0 = current.at;
    const r = at0 ? { left: at0.x - 6, right: at0.x + 6, top: at0.y - 6, bottom: at0.y + 6 } : current.host.getBoundingClientRect();
    const s = t.getBoundingClientRect();
    const view = { width: (win && win.innerWidth) || doc.documentElement.clientWidth, height: (win && win.innerHeight) || doc.documentElement.clientHeight };
    const at = placeTip(r, { width: s.width, height: s.height }, view);
    t.style.left = `${at.left}px`;
    t.style.top = `${at.top}px`;
    t.setAttribute("data-side", at.side);
    current.host.setAttribute("aria-describedby", addId(current.host.getAttribute("aria-describedby"), TIP_ID));
  };
  const hideBubble = () => {
    if (current && current.timer) { clearTimer(current.timer); current.timer = null; }
    if (tip) tip.hidden = true;
  };
  const leave = () => {
    if (!current) return;
    hideBubble();
    const { host, title, text } = current;
    // Put the words back, unless app.js wrote new ones while they were out.
    if (title && !(title.textContent || "").trim()) title.textContent = text;
    const ids = dropId(host.getAttribute("aria-describedby"), TIP_ID);
    if (ids) host.setAttribute("aria-describedby", ids);
    else host.removeAttribute("aria-describedby");
    current = null;
  };
  const enter = (host, delay, at = null) => {
    if (current && current.host === host) return;
    leave();
    const title = host.hasAttribute("data-tip") ? null : ownTitle(host);
    const text = title ? (title.textContent || "").trim() : host.getAttribute("data-tip");
    if (!text) return;
    // Emptied now, before the browser's own tooltip can rise.
    if (title) title.textContent = "";
    current = { host, title, text, timer: null, at };
    if (delay > 0) current.timer = setTimer(show, delay);
    else show();
  };
  const inside = (outer, node) => { for (let n = node; n; n = n.parentNode) if (n === outer) return true; return false; };

  const onOver = (e) => {
    let host = tipHost(e.target, current && current.host);
    if (off() && !isLine(host)) host = null; // behold#744: a kiosk frame's edges only
    const at = isLine(host) && typeof e.clientX === "number" ? { x: e.clientX, y: e.clientY } : null;
    if (host) enter(host, HOVER_MS, at);
    else if (current && !inside(current.host, e.target)) leave();
  };
  const onOut = (e) => { if (current && !inside(current.host, e.relatedTarget)) leave(); };
  const onFocusIn = (e) => {
    if (off()) return;
    const host = tipHost(e.target, current && current.host);
    if (host !== e.target) return;
    // A click focuses a badge too; only the keyboard's focus opens the tooltip.
    try { if (host.matches && !host.matches(":focus-visible")) return; } catch { /* an engine without :focus-visible opens it */ }
    enter(host, 0);
  };
  const onFocusOut = () => leave();
  const onKey = (e) => { if (e.key === "Escape" && current) hideBubble(); };
  // A pan, a zoom or a scroll moves the target out from under a fixed tooltip.
  const onMove = () => hideBubble();

  doc.addEventListener("pointerover", onOver);
  doc.addEventListener("pointerout", onOut);
  doc.addEventListener("focusin", onFocusIn);
  doc.addEventListener("focusout", onFocusOut);
  doc.addEventListener("keydown", onKey);
  doc.addEventListener("pointerdown", onMove, true);
  doc.addEventListener("wheel", onMove, { capture: true, passive: true });
  doc.addEventListener("scroll", onMove, true);

  // Tab stops for the badges, as each frame is drawn.
  let observer = null;
  const area = doc.querySelector(scope);
  const MO = win && win.MutationObserver;
  if (area && MO) {
    let queued = false;
    const pass = () => { queued = false; if (!off()) reachBadges(area); };
    observer = new MO(() => { if (!queued) { queued = true; Promise.resolve().then(pass); } });
    observer.observe(area, { childList: true, subtree: true });
    pass();
  }

  return () => {
    leave();
    if (observer) observer.disconnect();
    doc.removeEventListener("pointerover", onOver);
    doc.removeEventListener("pointerout", onOut);
    doc.removeEventListener("focusin", onFocusIn);
    doc.removeEventListener("focusout", onFocusOut);
    doc.removeEventListener("keydown", onKey);
    doc.removeEventListener("pointerdown", onMove, true);
    doc.removeEventListener("wheel", onMove, { capture: true });
    doc.removeEventListener("scroll", onMove, true);
  };
}
