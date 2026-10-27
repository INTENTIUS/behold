// behold#998: streamed drift, the page's half.
//
// The server narrates one run of chant's drift stream as `drift` frames on
// /api/events (src/drift-stream.ts): begin, start (the addresses a read
// expects), one record per instance as it arrives, settle (with a
// not-reached record already sent for every expected address no record
// answered), failed, end. This module folds a frame into the graph IR on
// screen, the same way web/pending.js folds a `member` frame: in place, the
// node set never changes, and it returns the ids that moved so the caller
// repaints only those.
//
// Reading is not a status. A card a started read has not reported yet keeps
// its `_status` and gains `_driftReading`, which the page draws dimmed and
// dashed, never filled. Only a record changes `_status`.

/**
 * The addresses of a member's cards, for the start request. A stack card
 * (`attrs._stackOf`, src/stack-lens.ts, an estate's default zoom) is titled
 * `<kind> ×<n>`, which is no address: the cards it holds are asked about
 * instead, each by its id inside the member.
 */
export function memberAddresses(ir, member) {
  const prefix = member + "/";
  const out = [];
  const add = (a) => {
    if (a && !out.includes(a)) out.push(a);
  };
  for (const n of (ir && ir.nodes) || []) {
    if (!n.id || !n.id.startsWith(prefix)) continue;
    const held = n.attrs && n.attrs._stackOf;
    if (Array.isArray(held)) {
      for (const m of held) {
        const id = typeof m === "string" ? m : m && typeof m.id === "string" ? m.id : "";
        if (id.startsWith(prefix)) add(id.slice(prefix.length));
      }
      continue;
    }
    add(n.attrs && typeof n.attrs.address === "string" ? n.attrs.address : n.id.slice(prefix.length));
  }
  return out;
}

/** The id of one `_stackOf` entry: a string, or an object's `id`. */
const heldId = (m) => (typeof m === "string" ? m : m && typeof m.id === "string" ? m.id : "");

/**
 * behold#1021: the card a stack holds that a record or an expected address
 * names, by the same match as a card of its own (its id, `<member>/<address>`
 * or the record's node), or undefined. A held card's `address` is not carried
 * on `_stackOf`, which is why memberAddresses asks about each by its id.
 */
function heldMatch(n, prefix, address, node) {
  const held = n.attrs && n.attrs._stackOf;
  if (!Array.isArray(held)) return undefined;
  for (const m of held) {
    const id = heldId(m);
    if (!id.startsWith(prefix)) continue;
    if ((node && (id === node || id === prefix + node)) || id === prefix + address) return id;
  }
  return undefined;
}

/**
 * The cards a record or an expected address lands on: the record's graph
 * node when chant mapped one, else the card whose id or `address` is the
 * address, inside the member. behold#1021: a stack card (`_stackOf`) that
 * holds such a card is one too, so the default stacked view colours.
 */
export function cardsFor(ir, member, address, node) {
  const prefix = member + "/";
  const ids = [];
  for (const n of (ir && ir.nodes) || []) {
    if (!n.id || !n.id.startsWith(prefix)) continue;
    const own = n.attrs && n.attrs.address;
    // chant's workspace drift composes `node` with the member in front (`<member>/<root>/<path>`), as workspace graph does; a bare one is prefixed.
    if ((node && (n.id === node || n.id === prefix + node)) || n.id === prefix + address || own === address || heldMatch(n, prefix, address, node)) ids.push(n.id);
  }
  return ids;
}

/**
 * behold#1021: the tones a record paints (src/drift-tone.ts `CardTone`),
 * worst first. A stack card takes the worst of its cards' records: one drifted
 * card in a stack of ten makes the stack drifted. `neutral` (not observed, or
 * a record behold does not know) ranks above `runtime` and `good`, so a stack
 * is never green while a card in it went unseen.
 */
export const TONES_WORST_FIRST = ["warn", "accent", "neutral", "runtime", "good"];

/** The worst of `tones`, by {@link TONES_WORST_FIRST}; a tone outside it ranks as neutral. */
export function worstTone(tones) {
  let best = -1;
  for (const t of tones) {
    const i = TONES_WORST_FIRST.indexOf(t);
    const rank = i < 0 ? TONES_WORST_FIRST.indexOf("neutral") : i;
    if (best < 0 || rank < best) best = rank;
  }
  return best < 0 ? undefined : TONES_WORST_FIRST[best];
}

/** A record frame as the `_drift` a card keeps. */
function driftOf(frame) {
  return {
    status: frame.status,
    read: frame.read,
    label: frame.label,
    run: frame.run,
    ...(frame.reason ? { reason: frame.reason } : {}),
    ...(frame.notReached ? { notReached: true } : {}),
    ...(frame.unknown ? { unknown: true } : {}),
  };
}

/**
 * behold#1021: a stack card's state for one run, `attrs._driftHeld`: the
 * cards a start expected and the record each has had, by held id. A new run
 * starts it afresh.
 */
function heldState(a, run) {
  if (!a._driftHeld || a._driftHeld.run !== run) a._driftHeld = { run, expected: [], records: {} };
  return a._driftHeld;
}

/**
 * Paint a stack card from its held records: `_status` the worst tone, `_drift`
 * that record's with the count in its label, each `_stackOf` entry's status
 * the tone its record painted (the inspect pane lists them), and reading
 * while a held card a start expected has not reported. The worst tone so far
 * only gets worse as records arrive, so a warn, accent or neutral one paints
 * at once; a good or runtime one waits for the last expected card, so a
 * stack is never green while a card in it is still being read.
 */
function paintStack(a, state) {
  const records = Object.values(state.records);
  const worst = worstTone(records.map((r) => r.tone));
  const atWorst = records.filter((r) => worstTone([r.tone]) === worst);
  const held = Array.isArray(a._stackOf) ? a._stackOf : [];
  const pending = state.expected.some((id) => !state.records[id]);
  if (atWorst.length && (!pending || TONES_WORST_FIRST.indexOf(worst) <= TONES_WORST_FIRST.indexOf("neutral"))) {
    const top = atWorst[0].drift;
    const of = held.length || records.length;
    a._status = worst;
    a._drift = { ...top, label: `${top.label}: ${atWorst.length} of ${of} card${of === 1 ? "" : "s"}${records.length < of ? `, ${records.length} reported` : ""}` };
    if (records.every((r) => r.drift.status === "not-observed")) a._unobserved = { reason: top.reason || "read-failed" };
    else delete a._unobserved;
  }
  for (const m of held) if (m && typeof m === "object" && state.records[m.id]) m.status = state.records[m.id].tone;
  if (pending) a._driftReading = state.run;
  else delete a._driftReading;
}

function nodeById(ir) {
  return new Map(((ir && ir.nodes) || []).map((n) => [n.id, n]));
}

/**
 * Fold one `drift` frame into `ir`. Returns `{ moved, reading }`: the ids
 * whose paint changed, and how many cards of this run are still reading.
 */
export function applyDriftFrame(ir, frame) {
  const moved = [];
  if (!ir || !frame || !frame.kind || !frame.member) return { moved, reading: 0 };
  const byId = nodeById(ir);
  const attrsOf = (id) => {
    const n = byId.get(id);
    return n ? n.attrs || (n.attrs = {}) : null;
  };
  if (frame.kind === "start") {
    const prefix = frame.member + "/";
    for (const address of frame.expected || []) {
      for (const id of cardsFor(ir, frame.member, address, null)) {
        const a = attrsOf(id);
        if (!a) continue;
        const held = heldMatch(byId.get(id), prefix, address, null);
        if (held) {
          const state = heldState(a, frame.run);
          if (!state.expected.includes(held)) state.expected.push(held);
        }
        if (a._driftReading === frame.run) continue;
        a._driftReading = frame.run;
        moved.push(id);
      }
    }
  } else if (frame.kind === "record") {
    const prefix = frame.member + "/";
    for (const id of cardsFor(ir, frame.member, frame.address, frame.node)) {
      const a = attrsOf(id);
      if (!a) continue;
      // behold#1021: a stack card keeps each held card's record and paints the worst.
      const held = heldMatch(byId.get(id), prefix, frame.address, frame.node);
      if (held) {
        const state = heldState(a, frame.run);
        state.records[held] = { tone: frame.tone, drift: driftOf(frame) };
        paintStack(a, state);
        moved.push(id);
        continue;
      }
      delete a._driftReading;
      a._status = frame.tone;
      a._drift = driftOf(frame);
      if (frame.status === "not-observed") a._unobserved = { reason: frame.reason || "read-failed" };
      else delete a._unobserved;
      moved.push(id);
    }
  } else if (frame.kind === "failed" || frame.kind === "end") {
    // Nothing more is coming for these cards: they stop reading and keep the
    // colour they had. A settle has already resolved every card it expected.
    for (const n of (ir && ir.nodes) || []) {
      if (n.attrs && n.attrs._driftReading === frame.run && n.id.startsWith(frame.member + "/")) {
        delete n.attrs._driftReading;
        moved.push(n.id);
      }
    }
  }
  let reading = 0;
  for (const n of (ir && ir.nodes) || []) if (n.attrs && n.attrs._driftReading === frame.run) reading++;
  return { moved, reading };
}

/** The now-line for a frame, or null when the frame says nothing a person needs. */
export function driftLine(frame, reading) {
  if (!frame) return null;
  switch (frame.kind) {
    case "begin":
      return frame.plan === "per-resource"
        ? `↻ streaming drift for ${frame.member}, one resource at a time (${frame.resources.length})`
        : `↻ streaming drift for ${frame.member}`;
    case "start":
      return `↻ ${frame.member}: reading ${frame.resource || "the member"} (${reading} card${reading === 1 ? "" : "s"} reading)`;
    case "settle":
      return frame.notReached && frame.notReached.length
        ? `↻ ${frame.member}: ${frame.resource || "the read"} settled, ${frame.notReached.length} not reached`
        : null;
    case "failed":
      return `✗ ${frame.member}${frame.resource ? ` ${frame.resource}` : ""}: ${frame.error}`;
    case "end":
      return `■ drift stream for ${frame.member} done`;
    default:
      return null;
  }
}
