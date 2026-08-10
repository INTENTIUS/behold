// #259 — the one place a JSON value becomes DOM.
//
// behold shows other people's payloads: a declared attribute, chant's observed
// live state, a drift pair, an op report, the body of an /api error. Every one
// of those used to reach the pane as `JSON.stringify(v)` — a single flat line
// that wraps four times and tells you nothing about its shape. This module is
// the replacement: 2-space pretty print, an expand/collapse affordance per
// object and array, and a per-subtree copy of the raw JSON.
//
// Two halves, deliberately separated:
//
//   - the pure half (kindOf … collapsedByDefault) has no DOM in it and is unit
//     tested in web/json-view.test.js, the way web/layout-store.js is (#245);
//   - renderJson() builds the tree out of those functions and nothing else.
//
// Rules the pure half encodes, so they are testable rather than argued about:
//
//   Key order is the order received. Object.keys is insertion order for string
//   keys, and chant's payloads arrive from JSON.parse, so what you read is what
//   the substrate sent — never sorted, because a re-sorted payload no longer
//   matches the manifest you'd diff it against.
//
//   Escaping is JSON's own. Strings render through JSON.stringify, so quotes,
//   backslashes and control characters come out as the escapes a JSON reader
//   expects; everything lands via textContent, so markup in a payload is text.
//
//   Collapsed by default means deep OR large. Depth <= openDepth (1) is open,
//   so the first tier of a payload reads at a glance; anything below that, and
//   anything wider than `big` entries wherever it sits, starts folded.
//
// Styling is tokens only (#229/#253) — see the `.jsonv` block in index.html.
// No dependencies: the SPA is unbundled ES modules and stays that way.

/** Indent unit — literally two spaces, matched by `.jsonv-children`'s 2ch. */
export const INDENT = "  ";
/** Containers at this depth or shallower start open (root is depth 0). */
export const OPEN_DEPTH = 1;
/** More entries than this and a container starts collapsed at any depth. */
export const BIG_ENTRIES = 12;
/** Characters of a string shown before the "+N chars" expander. */
export const MAX_STRING = 180;

const BRACKETS = { array: ["[", "]"], object: ["{", "}"] };

/** JSON's own type vocabulary, with arrays split out from objects. */
export function kindOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  return t === "object" ? "object" : t; // string | number | boolean | undefined | bigint | function | symbol
}

/** An object or an array — the two things that get a collapse affordance. */
export function isContainer(v) {
  const k = kindOf(v);
  return k === "object" || k === "array";
}

/** `[key, value]` pairs in the order received (array indices as keys). */
export function entriesOf(v) {
  if (Array.isArray(v)) return v.map((x, i) => [String(i), x]);
  if (v && typeof v === "object") return Object.keys(v).map((k) => [k, v[k]]);
  return [];
}

export function countOf(v) {
  return entriesOf(v).length;
}

/** What a collapsed container says about itself: `3 keys` / `5 items`. */
export function summaryOf(v) {
  const n = countOf(v);
  if (Array.isArray(v)) return n === 1 ? "1 item" : `${n} items`;
  return n === 1 ? "1 key" : `${n} keys`;
}

/** A string's INNER escaped form — JSON's escaping without the quotes. */
export function escapeString(s) {
  return JSON.stringify(String(s)).slice(1, -1);
}

/**
 * One scalar as JSON source text. Strings come back quoted and escaped;
 * `undefined` (which JSON has no spelling for, but a payload sliced by the SPA
 * can still hold) and non-finite numbers are named rather than silently turned
 * into `null` the way JSON.stringify would.
 */
export function scalarText(v) {
  switch (kindOf(v)) {
    case "string":
      return JSON.stringify(v);
    case "null":
      return "null";
    case "undefined":
      return "undefined";
    case "bigint":
      return String(v) + "n";
    default:
      return String(v); // number (incl. NaN/Infinity), boolean, function, symbol
  }
}

/** Exactly what the copy control writes: this subtree, 2-space pretty printed. */
export function rawJson(v) {
  try {
    const s = JSON.stringify(v, null, INDENT);
    return s === undefined ? scalarText(v) : s;
  } catch {
    return scalarText(v); // a cycle, or a value that refuses to serialize
  }
}

/** Split a long string for the truncated view. Splits the RAW string, then the
 * renderer escapes each half — escaping first could cut `é` in two. */
export function truncateString(s, max = MAX_STRING) {
  const str = String(s);
  if (str.length <= max) return { head: str, rest: "", truncated: false };
  return { head: str.slice(0, max), rest: str.slice(max), truncated: true };
}

/** Does this container start folded? Deep or large — see the header note. */
export function collapsedByDefault(value, depth, opts = {}) {
  if (!isContainer(value)) return false;
  const n = countOf(value);
  if (n === 0) return false; // `{}` has nothing to hide; it renders on one line
  const openDepth = opts.openDepth ?? OPEN_DEPTH;
  const big = opts.big ?? BIG_ENTRIES;
  if (n > big) return true;
  return depth > openDepth;
}

// ---- the DOM half ---------------------------------------------------------

/** Write to the system clipboard, with the pre-`navigator.clipboard` fallback
 * a file:// static export may still need. Returns a promise either way. */
export function writeClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy") ? resolve() : reject(new Error("copy rejected"));
    } catch (e) {
      reject(e);
    } finally {
      ta.remove();
    }
  });
}

function span(cls, text) {
  const el = document.createElement("span");
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** A focusable, Enter/Space-activated control. Not a <button>: the inspect
 * pane paints every <button> in it as an Adopt-style action, and a JSON tree
 * full of those would read as a page of buttons. */
function control(cls, text, onActivate) {
  const el = span(cls, text);
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    onActivate();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    e.preventDefault();
    e.stopPropagation();
    onActivate();
  });
  return el;
}

function scalarNode(value, o) {
  const wrap = span("jsonv-val jsonv-" + kindOf(value));
  if (kindOf(value) !== "string") {
    wrap.textContent = scalarText(value);
    return wrap;
  }
  const { head, truncated } = truncateString(value, o.maxString);
  if (!truncated) {
    wrap.textContent = scalarText(value);
    return wrap;
  }
  const text = span("jsonv-str-head", `"${escapeString(head)}…"`);
  const more = control("jsonv-more", `+${value.length - head.length} chars`, () => {
    text.textContent = scalarText(value);
    more.remove();
  });
  more.title = "Show the whole string";
  wrap.append(text, more);
  return wrap;
}

function copyControl(value, o) {
  const el = control("jsonv-copy", "copy", () => {
    const text = rawJson(value);
    Promise.resolve(o.copyText(text)).then(
      () => flash(el, "copied", "1"),
      () => flash(el, "copy failed", "0"),
    );
  });
  el.title = "Copy this subtree as raw JSON";
  // What the click WILL write, reachable from a test without a clipboard
  // permission (smoke/ui-smoke.mjs reads it, then round-trips it through
  // JSON.parse) — the same string the handler above hands to the clipboard.
  el.__jsonPayload = () => rawJson(value);
  return el;
}

function flash(el, text, ok) {
  el.textContent = text;
  el.dataset.copied = ok;
  clearTimeout(el.__flash);
  el.__flash = setTimeout(() => {
    el.textContent = "copy";
    delete el.dataset.copied;
  }, 1500);
}

function buildNode(value, key, depth, o) {
  const node = document.createElement("div");
  node.className = "jsonv-node";
  // The key this node hangs off, so a tree is addressable from outside — the
  // smoke selects `[data-key="metadata"]` rather than matching rendered text.
  if (key !== null) node.dataset.key = key;
  const line = document.createElement("div");
  line.className = "jsonv-line";
  node.appendChild(line);

  if (!isContainer(value)) {
    if (key !== null) line.append(span("jsonv-key", quoteKey(key)), span("jsonv-punct", ": "));
    line.appendChild(scalarNode(value, o));
    return node;
  }

  const [open, close] = BRACKETS[kindOf(value)];
  const n = countOf(value);
  const kids = document.createElement("div");
  kids.className = "jsonv-children";
  const tail = document.createElement("div");
  tail.className = "jsonv-tail";
  tail.appendChild(span("jsonv-punct", close));

  const head = document.createElement("span");
  head.className = "jsonv-head";
  const chevron = span("jsonv-toggle");
  head.appendChild(chevron);
  if (key !== null) head.append(span("jsonv-key", quoteKey(key)), span("jsonv-punct", ": "));
  head.appendChild(span("jsonv-punct", open));
  head.appendChild(span("jsonv-summary", n ? ` … ${summaryOf(value)} ` : ""));
  head.appendChild(span("jsonv-punct jsonv-close-inline", close));
  line.appendChild(head);
  if (o.copy) line.appendChild(copyControl(value, o));
  node.append(kids, tail);

  // An empty container is its own summary — `{}` on one line, no affordance,
  // nothing to focus.
  if (!n) {
    node.dataset.open = "0";
    chevron.textContent = " ";
    return node;
  }

  // Children are built on first expand: a collapsed subtree costs no DOM, which
  // is what makes a 400-key observed payload cheap to show at all.
  let built = false;
  const setOpen = (isOpen) => {
    if (isOpen && !built) {
      built = true;
      for (const [k, v] of entriesOf(value)) kids.appendChild(buildNode(v, k, depth + 1, o));
    }
    node.dataset.open = isOpen ? "1" : "0";
    head.setAttribute("aria-expanded", String(isOpen));
    chevron.textContent = isOpen ? "▾" : "▸";
    head.title = isOpen ? "Collapse" : `Expand — ${summaryOf(value)}`;
  };
  head.setAttribute("role", "button");
  head.tabIndex = 0;
  head.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(node.dataset.open !== "1");
  });
  head.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(node.dataset.open !== "1");
  });
  setOpen(!collapsedByDefault(value, depth, o));
  return node;
}

/** Array indices read as `0:` rather than `"0":` — they are positions, not keys. */
function quoteKey(key) {
  return /^\d+$/.test(key) ? key : JSON.stringify(key);
}

/**
 * Render one JSON value as a collapsible tree. Returns a detached element —
 * the caller appends it wherever the flat string used to go.
 *
 * opts: { openDepth, big, maxString, copy, copyText }
 */
export function renderJson(value, opts = {}) {
  const o = {
    openDepth: OPEN_DEPTH,
    big: BIG_ENTRIES,
    maxString: MAX_STRING,
    copy: true,
    copyText: writeClipboard,
    ...opts,
  };
  const root = document.createElement("div");
  root.className = "jsonv";
  root.appendChild(buildNode(value, null, 0, o));
  return root;
}

/**
 * The call every site in app.js actually makes: a container becomes the tree,
 * a scalar stays inline text. A collapsible one-line view of `3` helps nobody,
 * and the panes this feeds are dominated by scalars.
 */
export function jsonCell(value, opts) {
  return isContainer(value) ? renderJson(value, opts) : scalarText(value);
}
