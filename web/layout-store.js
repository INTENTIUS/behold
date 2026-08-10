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
// web/layout-store.test.js). app.js owns the pointer work and the SVG. The
// second tier of the issue (a `.behold/layout.json` sidecar behind
// `POST /api/layout`, so exports and snapshots honour the same deltas) is the
// follow-up; this is the shape it will serialize.

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
