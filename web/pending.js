// The picture while it is still arriving (#422, M3 of #419).
//
// An estate whose slowest member takes two minutes showed nothing for two
// minutes, including the members that answered in three seconds. The server's
// `?progressive=1` answers at once with every member composed from its SOURCE,
// each node carrying `_pendingRead`, and then broadcasts one `member` frame per
// live read as it settles. This module is the pure half of applying those.
//
// Pending is its own claim. `_unobserved` means behold looked and could not
// see; neutral means the plan did not mention it; this means the read has not
// finished. A viewer that blurs them is the thing behold exists not to be, so
// the pending mark is a separate attr and a separate treatment, never a fifth
// status colour — pinhole's painter takes a closed set and silently falls back
// to neutral for anything else, which is "unobserved", the exact wrong answer.

/**
 * Fold one `member` frame into the graph IR on screen.
 *
 * Returns the ids whose status actually moved, so the caller repaints those and
 * leaves the rest of the SVG alone — the node set never changes here, which is
 * what keeps dagre out of it and stops cards jumping under the reader.
 *
 * Mutates `ir` in place, because it IS the IR the renderer holds.
 */
export function applyMemberFrame(ir, frame) {
  if (!ir || !frame || !frame.member || !frame.statuses) return [];
  const moved = [];
  for (const node of ir.nodes || []) {
    const next = frame.statuses[node.id];
    if (next === undefined) continue;
    const attrs = node.attrs || (node.attrs = {});
    const was = attrs._status;
    delete attrs._pendingRead;
    attrs._status = next;
    // A member whose live read failed comes back with its reason, and that is
    // a different card from one that simply finished: unobserved, not pending
    // and not absent.
    if (frame.unobserved) attrs._unobserved = frame.unobserved;
    else delete attrs._unobserved;
    // The identity mark (web/identity-mark.js), for a card that carries one.
    if (frame.identities && frame.identities[node.id]) attrs._identity = frame.identities[node.id];
    if (was !== next) moved.push(node.id);
  }
  return moved;
}

/** Which members the picture is still waiting on, after a frame lands. */
export function stillPending(pending, frame) {
  if (!Array.isArray(pending)) return [];
  if (!frame || !frame.member) return [...pending];
  return pending.filter((m) => m !== frame.member);
}

/**
 * The line for the reader while the estate arrives.
 *
 * Null once nothing is pending — the caller clears rather than printing a
 * finished-sounding sentence, because the ordinary status line already says
 * what the estate is.
 */
export function pendingLine(pending, total) {
  if (!Array.isArray(pending) || pending.length === 0) return null;
  const done = Math.max(0, (total ?? pending.length) - pending.length);
  const scope = total ? `${done} of ${total} members read` : `${pending.length} members still reading`;
  // Named, not counted, while the list is short enough to read: "waiting on
  // team-a" is actionable and "3 pending" is not.
  const who = pending.length <= 3 ? ` — waiting on ${pending.join(", ")}` : "";
  return `${scope}${who}`;
}

/**
 * The frames of one progressive load, kept from the moment its request goes
 * out until the answer is drawn.
 *
 * The live pass starts when the server takes the request, and with the
 * overlay cache warm it can settle and broadcast every member before the
 * answer reaches the page. A frame that lands then has no picture to fold
 * into: the answer, drawn a moment later, paints every card pending again.
 * So every frame is noted here (the newest per member wins), applied at once
 * only when the picture it belongs to is already up, and replayed onto the
 * picture right after it is drawn. A failed live pass is noted the same way.
 */
export function createMemberFrames() {
  let frames = new Map();
  let failed = null;
  let drawing = false;
  let load = 0;
  return {
    /** A progressive request is going out: its frames start here. Returns the load's turn. */
    begin() {
      frames = new Map();
      failed = null;
      drawing = true;
      return ++load;
    },
    /** Note a frame. True when it can be applied now, false when it waits for the draw. */
    note(frame) {
      if (!frame) return false;
      if (frame.error) failed = frame.error;
      else if (frame.member) frames.set(frame.member, frame);
      return !drawing;
    },
    /** Load `turn`'s answer is drawn: fold every noted frame into it. Null when a newer load took over. */
    replay(ir, pending, turn = load) {
      if (turn !== load) return null;
      drawing = false;
      const moved = [];
      let still = Array.isArray(pending) ? [...pending] : [];
      for (const frame of frames.values()) {
        moved.push(...applyMemberFrame(ir, frame));
        still = stillPending(still, frame);
      }
      if (failed) still = [];
      return { moved, pending: still, failed };
    },
    /** Load `turn` ended without drawing (an error, a newer view): stop holding frames back, unless a newer load holds them. */
    cancel(turn = load) {
      if (turn === load) drawing = false;
    },
  };
}
