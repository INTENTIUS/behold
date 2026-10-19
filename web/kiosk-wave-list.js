// behold#776: a phone's Watch as a list. On a 390 px screen the components
// graph shrinks until its card labels are about 5 px, so Watch reads as
// coloured boxes. Under the graph a phone gets the same marks as words: each
// wave, how it stands, and each of its roots with its state; a tap on a root
// opens what its card's popover says (its resources and which of them change).
//
// The frame owns the marks (web/terragucci-components-live.js componentMarks,
// web/chant-pr-marks.js chantComponentMarks) and posts them as `behold:marks`
// in the form waveListOf makes; the kiosk draws them with drawWaveList.
//
// Pure apart from drawWaveList, which builds DOM from a list.

const TONES = new Set(["ok", "bad", "wait", "busy", "idle"]);
const toneOf = (t) => (TONES.has(t) ? t : "idle");
const words = (x) => (typeof x === "string" ? x.trim() : "");

/**
 * The list from a draw's marks: `{ waves: [{ wave, words, tone, roots: [{ root, component, words, tone, facts, detail? }] }] }`,
 * the waves in the order they apply (wave 1 first), each wave's roots by name.
 * `details` maps a component to its popover's content (kiosk-popover.js rootPopover), when the frame has one.
 * Null when the marks carry no cards.
 */
export function waveListOf(marks, details = {}) {
  const cards = marks && marks.cards && typeof marks.cards === "object" ? marks.cards : null;
  if (!cards || !Object.keys(cards).length) return null;
  const waveMarks = marks.waves && typeof marks.waves === "object" ? marks.waves : {};
  const byWave = new Map();
  for (const [component, c] of Object.entries(cards)) {
    if (!c || typeof c.root !== "string") continue;
    const n = Number.isInteger(c.wave) ? c.wave : null;
    if (!byWave.has(n)) byWave.set(n, []);
    const d = details && details[component];
    byWave.get(n).push({
      root: c.root,
      component,
      words: words(c.words) || words(c.short) || words(c.state),
      tone: toneOf(c.tone),
      facts: Array.isArray(c.facts) ? c.facts.filter((f) => typeof f === "string" && f) : [],
      ...(d && typeof d.head === "string" ? { detail: { head: d.head, rows: (d.rows || []).map((r) => ({ address: r.address, state: r.state, words: r.words })), more: d.more || 0 } } : {}),
    });
  }
  const waves = [...byWave.keys()]
    .sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b))
    .map((n) => {
      const w = n !== null ? waveMarks[n] : null;
      const said = w ? words(w.status && w.status.words) || words(w.state) : "";
      return { wave: n, words: said, tone: toneOf(w ? w.tone : "idle"), roots: byWave.get(n).sort((a, b) => a.root.localeCompare(b.root)) };
    });
  return { waves };
}

/** A list's identity, so the frame posts it and the kiosk redraws it only when it changes. */
export function waveListKey(list) {
  return JSON.stringify(list || null);
}

/** A wave's heading: "Wave 2 · failed", "Wave 2" before any state, "Other roots" for roots in no wave. */
export function waveHead(w) {
  const name = w.wave === null ? "Other roots" : `Wave ${w.wave}`;
  return w.words ? `${name} · ${w.words}` : name;
}

/** What the list says it is, over its waves. */
export const LIST_WORDS = { title: "The waves", hint: "Tap a root for its resources." };

/**
 * Draw the list into `host`. `open` is the set of roots whose details are
 * shown; `onToggle(root)` is called on a tap. `paint(doc, root)` returns the
 * node for a root's name (its colour dot), or null for the plain name.
 */
export function drawWaveList(host, list, { doc = typeof document !== "undefined" ? document : null, open = new Set(), onToggle = () => {}, paint = null } = {}) {
  if (!host || !doc) return;
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };
  host.replaceChildren();
  host.hidden = !list || !list.waves.length;
  if (host.hidden) return;
  const head = el("div", "k-wl-head");
  head.append(el("h2", "k-wl-title", LIST_WORDS.title), el("span", "k-wl-hint", LIST_WORDS.hint));
  host.appendChild(head);
  for (const w of list.waves) {
    const sec = el("section", "k-wl-wave");
    sec.dataset.kTone = w.tone;
    if (w.wave !== null) sec.dataset.kWave = String(w.wave);
    sec.appendChild(el("h3", `k-wl-wave-head k-wl-${w.tone}`, waveHead(w)));
    const ul = el("ul", "k-wl-roots");
    for (const r of w.roots) {
      const shown = open.has(r.root);
      const li = el("li", `k-wl-root${shown ? " k-wl-open" : ""}`);
      li.dataset.kTone = r.tone;
      li.dataset.kRoot = r.root;
      const b = el("button", "k-wl-row");
      b.type = "button";
      b.setAttribute("aria-expanded", String(shown));
      const name = (paint && paint(doc, r.root)) || el("span", "k-wl-name", r.root);
      if (name.classList) name.classList.add("k-wl-name");
      b.append(name, el("span", `k-wl-state k-wl-${r.tone}`, r.words));
      b.addEventListener("click", () => onToggle(r.root));
      li.appendChild(b);
      if (shown) li.appendChild(rootDetail(el, r));
      ul.appendChild(li);
    }
    sec.appendChild(ul);
    host.appendChild(sec);
  }
}

/** A root's details under its row: its card's facts, then its resources as its popover lists them. */
function rootDetail(el, r) {
  const box = el("div", "k-wl-detail");
  for (const f of r.facts) box.appendChild(el("p", "k-wl-fact", f));
  if (r.detail) {
    box.appendChild(el("p", "k-wl-res-head", r.detail.head));
    if (r.detail.rows.length) {
      const ul = el("ul", "k-wl-res");
      for (const x of r.detail.rows) {
        const li = el("li", null, `${x.address} `);
        li.appendChild(el("span", `k-wl-res-${x.state}`, x.words));
        ul.appendChild(li);
      }
      if (r.detail.more > 0) ul.appendChild(el("li", "k-wl-res-more", `and ${r.detail.more} more`));
      box.appendChild(ul);
    }
  } else if (!r.facts.length) box.appendChild(el("p", "k-wl-fact", "Its resources show once the plan's report is read."));
  return box;
}
