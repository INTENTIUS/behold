// Read a carve recording (scripts/dot-bench/record-carve.mjs) into what a
// scrubber needs (#457, question 4): the roster, every resource's owner at
// the first keyframe, and the moves in order, each with the followers it
// carried. Pure: the file's lines in, plain data out.
//
// State at move k is the owners at the nearest keyframe at or before k with
// the moves after it applied, which is why keyframes are kept: a scrubber
// jumping to move 900 of 1000 starts from the keyframe at 900, not from 0.

/** One live-ls document -> [{address, type, taggable, estate}] (items are tagged, gaps are not listable). */
export function rosterOf(estate, doc) {
  const out = [];
  for (const it of doc.items ?? []) if (it.address) out.push({ address: it.address, type: it.type, taggable: true, estate, id: it.id });
  for (const g of doc.gaps ?? []) out.push({ address: g.address, type: g.type, taggable: false, estate, rung: g.rung });
  return out;
}

export function readRecording(text) {
  const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const header = lines.find((l) => l.kind === "header");
  const keyframes = lines.filter((l) => l.kind === "keyframe");
  const moves = lines.filter((l) => l.kind === "move");
  const end = lines.find((l) => l.kind === "end");
  if (!header || !keyframes.length) throw new Error("not a carve recording: no header or no keyframe");

  // The roster is live-check's instance list: every declared instance, with
  // `tag-governable` ones (which live-ls can see, and a move can target) and
  // `declaration-carried` ones (untaggable; they follow a parent). A recording
  // without a roster line falls back to the first keyframe's tagged items.
  const rosterLine = lines.find((l) => l.kind === "roster");
  const first = keyframes[0].estates;
  const byAddress = new Map();
  if (rosterLine) {
    for (const i of rosterLine.instances) byAddress.set(i.address, { address: i.address, type: i.type, taggable: i.rung === "tag-governable", rung: i.rung });
  } else {
    for (const [estate, doc] of Object.entries(first)) for (const r of rosterOf(estate, doc)) if (!byAddress.has(r.address)) byAddress.set(r.address, r);
  }
  const roster = [...byAddress.values()];

  const owners = (kf) => {
    const o = new Map();
    for (const [estate, doc] of Object.entries(kf.estates)) for (const it of doc.items ?? []) if (it.address) o.set(it.address, estate);
    return o;
  };

  const timeline = moves.map((m) => ({
    seq: m.seq,
    t: Date.parse(m.t),
    address: m.address,
    to: m.estate,
    ok: m.exit === 0 && !!m.doc && m.doc.written !== false,
    followers: (m.doc?.followers ?? []).map((f) => f.address),
    seconds: m.seconds,
  }));
  timeline.sort((a, b) => a.seq - b.seq);

  const estates = [header.source, ...header.destinations];
  return { header, end, roster, estates, keyframes: keyframes.map((k) => ({ seq: k.seq, t: Date.parse(k.t), owners: owners(k) })), timeline };
}

/**
 * Owner of every address after `upto` moves: the nearest keyframe at or
 * before it, then the moves between. A follower takes its parent's new owner.
 * An untaggable child with no follower record keeps its parent's owner,
 * which the layout's `parent` names.
 */
export function ownersAt(rec, upto, parentOf) {
  let kf = rec.keyframes[0];
  for (const k of rec.keyframes) if (k.seq <= upto && k.seq >= kf.seq) kf = k;
  const owner = new Map(kf.owners);
  for (const m of rec.timeline) {
    if (m.seq <= kf.seq || m.seq > upto || !m.ok) continue;
    owner.set(m.address, m.to);
    for (const f of m.followers) owner.set(f, m.to);
  }
  for (const r of rec.roster) {
    if (owner.has(r.address)) continue;
    const p = parentOf(r.address);
    owner.set(r.address, (p && owner.get(p)) || rec.header.source);
  }
  return owner;
}
