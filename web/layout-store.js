// The hand-layout delta store (#228) — what a dragged node or a resized
// containment box remembers, and where.
//
// Deltas, never absolute positions. The graph is chant's and the layout is
// yours, and that ordering must not invert: a stored `{dx,dy}` is an offset
// from whatever dagre decided on THIS render, so a node that legitimately
// moved in the source still lands under your offset instead of pinning itself
// to a stale coordinate. A delta whose node id is gone from the graph is
// dropped without a word (`applicable`).
//
// No DOM in here on purpose — this is the testable half of #228 (see
// web/layout-store.test.js). app.js owns the pointer work and the SVG.
//
// Two tiers, and the second one lands here too: `localStorage` (free, per
// browser) and the `.behold/layout.json` sidecar behind `GET/POST /api/layout`
// (shareable, versionable, and what a server-side export bakes in — see
// src/layout.ts). `mergeLayouts` decides who wins when both have an opinion,
// and every server call degrades to localStorage-only without a word.

const PREFIX = "behold.layout";
const NUM = ["dx", "dy", "dw", "dh"];

/** A path or a lens name → one flat, readable key segment. */
export function slug(s) {
  return (
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

/** The storage key for one project + lens: `behold.layout.<project>.<lens>`. */
export function layoutKey(projectKey, lens) {
  return `${PREFIX}.${slug(projectKey)}.${slug(lens)}`;
}

/** The project half of the key, from /api/project's payload (see initPickers). */
export function projectKeyOf(info) {
  return slug(info && info.projectDir);
}

/**
 * The lens half of the key. `?logical=1` and the plain graph must keep
 * independent layouts (#228's acceptance), and so must radial vs. straight and
 * one stack vs. another — every one of those re-lays the graph out from
 * scratch, so a delta from one means nothing in another. The env is
 * deliberately NOT in the key: picking an env recolours the same nodes, it
 * doesn't re-place them, and losing your layout on an overlay flip would be
 * the wrong trade.
 */
export function lensKeyOf({ zoom, radial, stack } = {}) {
  return [zoom || "graph", radial ? "radial" : null, stack ? `stack-${stack}` : null].filter(Boolean).join("+");
}

/** Coerce arbitrary parsed JSON into `{id: {dx,dy,dw,dh}}` of finite non-zero numbers. */
export function normalize(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, d] of Object.entries(raw)) {
    if (!id || !d || typeof d !== "object") continue;
    const clean = {};
    for (const k of NUM) {
      const v = Number(d[k]);
      if (Number.isFinite(v) && v !== 0) clean[k] = v;
    }
    if (Object.keys(clean).length) out[id] = clean;
  }
  return out;
}

/** True when nothing is hand-placed — drives whether the reset control shows. */
export function isEmpty(deltas) {
  return Object.keys(normalize(deltas)).length === 0;
}

/** Read one key. Unparseable, missing, or a storage that throws → `{}`. */
export function readLayout(storage, key) {
  try {
    return normalize(JSON.parse(storage.getItem(key) || "{}"));
  } catch {
    return {};
  }
}

/** Write one key (an empty layout removes it rather than storing `{}`). */
export function writeLayout(storage, key, deltas) {
  const d = normalize(deltas);
  try {
    if (Object.keys(d).length) storage.setItem(key, JSON.stringify(d));
    else storage.removeItem(key);
  } catch {
    /* private mode, quota, a static export off file:// — layout is a nicety */
  }
  return d;
}

export function clearLayout(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    /* see writeLayout */
  }
}

/** Replace one id's delta, returning a NEW map. An all-zero delta is pruned. */
export function setDelta(deltas, id, delta) {
  const next = normalize(deltas);
  const clean = normalize({ [id]: delta })[id];
  if (clean) next[id] = clean;
  else delete next[id];
  return next;
}

/** Drop deltas whose id is no longer in the graph — silently, per #228. */
export function applicable(deltas, liveIds) {
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds || []);
  const out = {};
  for (const [id, d] of Object.entries(normalize(deltas))) if (live.has(id)) out[id] = d;
  return out;
}

// --- The delta → SVG math ---------------------------------------------------
// MUST stay identical to the copies in src/layout.ts, which is what bakes a
// layout into a server-rendered export. web/layout-store.test.js imports both
// modules and asserts they agree across a table of cases, so a drift fails a
// test instead of quietly making an export disagree with the screen it came
// from. (Same discipline as `canonicalKey`, mirrored in app.js and export.ts.)

/** A node group's transform with its delta ridden on top of dagre's own. */
export function nodeTransform(base, d) {
  const dx = (d && d.dx) || 0;
  const dy = (d && d.dy) || 0;
  if (!dx && !dy) return base;
  return `translate(${dx}, ${dy}) ${base}`.trim();
}

/** First and last coordinate pair of a path `d` — pinhole's own edge anchors. */
export function pathAnchors(d) {
  const n = String(d || "").match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  if (!n || n.length < 4) return null;
  return { sx: +n[0], sy: +n[1], ex: +n[n.length - 2], ey: +n[n.length - 1] };
}

/** An edge whose ends moved: a straight line between the original anchors,
 * each shifted by ITS OWN end's delta. #228 accepts the straight-line fallback
 * explicitly; spline re-routing stays pinhole's job. */
export function straightEdge(anchors, from, to) {
  const { sx, sy, ex, ey } = anchors;
  return `M ${sx + ((from && from.dx) || 0)} ${sy + ((from && from.dy) || 0)} L ${ex + ((to && to.dx) || 0)} ${ey + ((to && to.dy) || 0)}`;
}

// --- The server tier --------------------------------------------------------

/**
 * The two tiers, merged for display. **Local wins where both have an id.**
 *
 * You are looking at this browser's picture: the drag you just did is in
 * localStorage and must not be argued with by a sidecar someone else committed
 * (or that you yourself pushed from another machine). An id only the server has
 * still comes through — that is what makes a shared layout worth having — so
 * the merge adds without ever overwriting. The reverse ordering would mean a
 * `git pull` silently undoing a placement you can see on your screen.
 *
 * The stale-id rule is unchanged and applies after: `applicable` drops whatever
 * is no longer in the graph, whichever tier it came from.
 */
export function mergeLayouts(local, server) {
  return { ...normalize(server), ...normalize(local) };
}

/** The lens's deltas as the server has them (`{}` on any refusal), plus whether
 * it would accept a write. No server, a static export, preview mode, a
 * read-only project, a 404 from an older behold — all the same answer: this is
 * a localStorage-only session, and nothing says so out loud. */
export async function fetchServerLayout(fetchFn, lens) {
  try {
    const res = await fetchFn(`/api/layout?lens=${encodeURIComponent(lens)}`);
    if (!res || !res.ok) return { deltas: {}, writable: false };
    const body = await res.json();
    return { deltas: normalize(body && body.deltas), writable: !!(body && body.writable) };
  } catch {
    return { deltas: {}, writable: false };
  }
}

/** Push one lens's map to the sidecar. Resolves true iff it was stored.
 * `keepalive` so a push flushed on the way out of the page (see `debounce`'s
 * `flush`) still completes after the document is gone. */
export async function postServerLayout(fetchFn, lens, deltas) {
  try {
    const res = await fetchFn("/api/layout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lens, deltas: normalize(deltas) }),
      keepalive: true,
    });
    return !!(res && res.ok);
  } catch {
    return false;
  }
}

/** A trailing-edge debouncer for the POST above: a drag emits a pointer-move
 * storm and ends on the one write that matters. `flush()` runs a pending call
 * now — what a page leaving mid-debounce needs, or the sidecar would miss the
 * last placement the localStorage tier already has. Exported so the test can
 * drive it with a fake clock rather than sleeping. */
// The default timers are wrappers, not bare references: a detached
// `setTimeout` is called with no `this` and Chrome answers that with an
// "Illegal invocation" TypeError.
export function debounce(fn, ms, setTimer = (cb, t) => setTimeout(cb, t), clearTimer = (id) => clearTimeout(id)) {
  let t = null;
  let last = null;
  const run = (...args) => {
    if (t !== null) clearTimer(t);
    last = args;
    t = setTimer(() => {
      t = null;
      last = null;
      fn(...args);
    }, ms);
  };
  run.flush = () => {
    if (t === null) return;
    clearTimer(t);
    t = null;
    const args = last || [];
    last = null;
    fn(...args);
  };
  return run;
}
