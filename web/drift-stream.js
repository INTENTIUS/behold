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

/** The addresses of a member's cards, for the start request. */
export function memberAddresses(ir, member) {
  const prefix = member + "/";
  const out = [];
  for (const n of (ir && ir.nodes) || []) {
    if (!n.id || !n.id.startsWith(prefix)) continue;
    const a = n.attrs && typeof n.attrs.address === "string" ? n.attrs.address : n.id.slice(prefix.length);
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

/**
 * The cards a record or an expected address lands on: the record's graph
 * node when chant mapped one, else the card whose id or `address` is the
 * address, inside the member.
 */
export function cardsFor(ir, member, address, node) {
  const prefix = member + "/";
  const ids = [];
  for (const n of (ir && ir.nodes) || []) {
    if (!n.id || !n.id.startsWith(prefix)) continue;
    const own = n.attrs && n.attrs.address;
    // chant's workspace drift composes `node` with the member in front (`<member>/<root>/<path>`), as workspace graph does; a bare one is prefixed.
    if ((node && (n.id === node || n.id === prefix + node)) || n.id === prefix + address || own === address) ids.push(n.id);
  }
  return ids;
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
    for (const address of frame.expected || []) {
      for (const id of cardsFor(ir, frame.member, address, null)) {
        const a = attrsOf(id);
        if (!a || a._driftReading === frame.run) continue;
        a._driftReading = frame.run;
        moved.push(id);
      }
    }
  } else if (frame.kind === "record") {
    for (const id of cardsFor(ir, frame.member, frame.address, frame.node)) {
      const a = attrsOf(id);
      if (!a) continue;
      delete a._driftReading;
      a._status = frame.tone;
      a._drift = {
        status: frame.status,
        read: frame.read,
        label: frame.label,
        run: frame.run,
        ...(frame.reason ? { reason: frame.reason } : {}),
        ...(frame.notReached ? { notReached: true } : {}),
        ...(frame.unknown ? { unknown: true } : {}),
      };
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
