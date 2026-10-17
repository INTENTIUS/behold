// The dots preview's data (#712): a carve recording (#457's JSON Lines,
// scripts/dot-bench/record-carve.mjs) or the terralith walkthrough's
// snapshots (src/terralith-demo.ts readTerralith), read into one "show":
//
//   { kind, source, estates[], roster[], owners0, ownersEnd, events[], threads[], t0, t1 }
//
// Every event is a line of the recording or a fact of a snapshot. Nothing is
// made up: a recording's times are its own stamps; the snapshots carry one
// time per phase, so their events are spaced evenly inside it and the show
// says so (`spaced: true`). Pure: text or JSON in, plain data out.

/** A carve recording's lines -> { header, end, roster, estates, keyframes, timeline } (after #457's recording.js). */
export function readCarve(text) {
  const lines = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const header = lines.find((l) => l.kind === "header");
  const keyframes = lines.filter((l) => l.kind === "keyframe");
  if (!header || !keyframes.length) throw new Error("not a carve recording: no header or no keyframe");
  const rosterLine = lines.find((l) => l.kind === "roster");
  const byAddress = new Map();
  if (rosterLine) {
    for (const i of rosterLine.instances) byAddress.set(i.address, { address: i.address, type: i.type, taggable: i.rung === "tag-governable", rung: i.rung });
  } else {
    for (const doc of Object.values(keyframes[0].estates)) {
      for (const it of doc.items ?? []) if (it.address && !byAddress.has(it.address)) byAddress.set(it.address, { address: it.address, type: it.type, taggable: true });
      for (const g of doc.gaps ?? []) if (!byAddress.has(g.address)) byAddress.set(g.address, { address: g.address, type: g.type, taggable: false });
    }
  }
  const owners = (kf) => {
    const o = new Map();
    for (const [estate, doc] of Object.entries(kf.estates)) for (const it of doc.items ?? []) if (it.address) o.set(it.address, estate);
    return o;
  };
  const timeline = lines
    .filter((l) => l.kind === "move")
    .map((m) => {
      const end = Date.parse(m.t);
      const seconds = Number.isFinite(m.seconds) ? m.seconds : 0;
      return {
        seq: m.seq,
        t: end,
        start: end - seconds * 1000,
        address: m.address,
        from: m.doc?.from?.estate ?? header.source,
        to: m.estate,
        ok: m.exit === 0 && !!m.doc && m.doc.written !== false,
        refusal: m.doc?.refusal?.code ?? (m.exit !== 0 ? "exit" : undefined),
        ...(m.doc?.refusal?.summary ? { refusalSummary: m.doc.refusal.summary } : {}),
        followers: (m.doc?.followers ?? []).map((f) => f.address),
      };
    })
    .sort((a, b) => a.seq - b.seq);
  return {
    header,
    end: lines.find((l) => l.kind === "end"),
    roster: [...byAddress.values()],
    estates: [header.source, ...(header.destinations ?? [])],
    keyframes: keyframes.map((k) => ({ seq: k.seq, t: Date.parse(k.t), owners: owners(k) })),
    timeline,
  };
}

/**
 * Owner of every address after `upto` moves: the nearest keyframe at or before
 * it, then the landed moves between (each carries its followers). A child no
 * keyframe lists takes its parent's owner.
 */
export function ownersAt(rec, upto, parents) {
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
    const p = parents.get(r.address);
    owner.set(r.address, (p && owner.get(p)) || rec.header.source);
  }
  return owner;
}

/** A carve recording as a show: one `write` event per live-mv line. */
export function carveShow(rec, parents) {
  const last = rec.keyframes.reduce((a, k) => (k.seq > a.seq ? k : a), rec.keyframes[0]);
  const events = rec.timeline.map((m) => ({
    kind: "write",
    t: m.t,
    start: Math.min(m.start, m.t),
    address: m.address,
    followers: m.followers,
    from: m.from,
    to: m.to,
    ok: m.ok,
    ...(m.refusal ? { refusal: m.refusal } : {}),
    ...(m.refusalSummary ? { refusalSummary: m.refusalSummary } : {}),
    seq: m.seq,
  }));
  const t0 = Math.min(rec.keyframes[0].t, ...events.map((e) => e.start));
  const t1 = Math.max(last.t, ...events.map((e) => e.t));
  return {
    kind: "carve",
    title: rec.header.source,
    recordedAt: Date.parse(rec.header.t) || t0,
    source: rec.header.source,
    estates: rec.estates,
    roster: rec.roster,
    owners0: ownersAt(rec, 0, parents),
    ownersEnd: ownersAt(rec, last.seq, parents),
    events,
    threads: [],
    phases: [],
    parents,
    t0,
    t1,
    spaced: false,
  };
}

/**
 * The walkthrough's four phases (readTerralith's model) as a show:
 *   adopt  each card live-import stamped (identity.marked) leaves a ring;
 *   split  each card that moved recolours, with a comet toward its estate;
 *   plan   each card a root's plan read glows dimly, a planned change
 *          brighter, and each planned output is a thread from its estate to
 *          its readers, with a pulse handed along it (wave 1 to wave 2).
 */
export function walkthroughShow(model) {
  const phases = model.phases ?? [];
  const stock = phases.find((p) => p.id === "stock") ?? phases[0];
  if (!stock) throw new Error("no phases in the walkthrough's snapshots");
  const adopt = phases.find((p) => p.id === "adopt");
  const split = phases.find((p) => p.id === "split");
  const plan = phases.find((p) => p.id === "plan");
  const source = stock.boxes[0]?.id ?? "terralith";
  const marked = new Map();
  for (const b of adopt?.boxes ?? []) for (const c of b.cards) marked.set(c.id, !!c.identity?.marked);
  const roster = stock.boxes
    .flatMap((b) => b.cards)
    .map((c) => ({ address: c.id, type: c.type, taggable: adopt ? !!marked.get(c.id) : true }));
  const at = (p, i) => Date.parse(p?.at ?? "") || i * 10_000;
  const times = phases.map((p, i) => at(p, i));
  // A phase runs from its stamp to the next one's; the last gets the mean length.
  const spanOf = (i) => (i + 1 < times.length ? times[i + 1] - times[i] : Math.max(10_000, (times.at(-1) - times[0]) / Math.max(1, times.length - 1)));
  const iOf = (p) => phases.indexOf(p);
  const spread = (p, items, mk) => {
    const i = iOf(p);
    const t = times[i];
    const span = spanOf(i) * 0.8;
    return items.map((it, k) => mk(it, t + (span * (k + 0.5)) / items.length, span / Math.max(1, items.length)));
  };
  const events = [];
  if (adopt) {
    const cards = adopt.boxes.flatMap((b) => b.cards).filter((c) => c.identity?.marked);
    events.push(...spread(adopt, cards, (c, t, d) => ({ kind: "adopt", t, start: t - d * 0.6, address: c.id, source: c.identity.source })));
  }
  const owners0 = new Map(roster.map((r) => [r.address, source]));
  const ownersEnd = new Map(owners0);
  if (split) {
    const cards = split.boxes.flatMap((b) => b.cards).filter((c) => c.moved && !c.moved.follows);
    const followers = new Map();
    for (const b of split.boxes) for (const c of b.cards) if (c.moved?.follows) followers.set(c.moved.follows, [...(followers.get(c.moved.follows) ?? []), c.id]);
    events.push(
      ...spread(split, cards, (c, t, d) => ({ kind: "write", t, start: t - d * 0.6, address: c.id, followers: followers.get(c.id) ?? [], from: c.moved.from, to: c.moved.to, ok: true })),
    );
    for (const b of split.boxes) for (const c of b.cards) ownersEnd.set(c.id, b.estate ?? b.id);
  }
  const threads = [];
  if (plan) {
    const i = iOf(plan);
    const t = times[i];
    const span = spanOf(i) * 0.8;
    for (const b of plan.boxes) {
      const whole = !!(b.plan?.fallback || (b.plan?.cone && b.plan.cone.full && b.plan.cone.kind !== "empty-cone"));
      for (const c of b.cards) {
        if (c.planned) events.push({ kind: "planned", t: t + span * 0.55, start: t + span * 0.3, address: c.id, actions: c.planned.actions });
        if (whole || c.inCone || c.planned) events.push({ kind: "read", t: t + span * 0.5, start: t + span * 0.25, address: c.id, root: b.id });
      }
    }
    for (const o of plan.plan?.outputs ?? []) {
      for (const r of o.readers) {
        threads.push({ from: o.estate, to: r, name: o.name, known: o.known });
        events.push({ kind: "handoff", t: t + span * 0.35, start: t + span * 0.1, from: o.estate, to: r, name: o.name });
      }
    }
  }
  events.sort((a, b) => a.start - b.start);
  const estates = [source, ...new Set([...ownersEnd.values()].filter((e) => e !== source))];
  return {
    kind: "walkthrough",
    title: `${source} walkthrough`,
    recordedAt: times[0],
    source,
    estates,
    roster,
    owners0,
    ownersEnd,
    events,
    threads,
    parents: new Map(),
    phases: phases.map((p, k) => ({ id: p.id, t: times[k] })),
    t0: times[0],
    t1: times[times.length - 1] + spanOf(times.length - 1),
    spaced: true,
  };
}

/** Owners at show time `t`: every landed write that has finished by then. */
export function ownersAtTime(show, t) {
  const o = new Map(show.owners0);
  const touched = new Set();
  for (const e of show.events) {
    if (e.kind !== "write" || !e.ok || e.t > t) continue;
    o.set(e.address, e.to);
    touched.add(e.address);
    for (const f of e.followers ?? []) {
      o.set(f, e.to);
      touched.add(f);
    }
  }
  // A child no follower record names goes where its parent went.
  for (const [child, parent] of show.parents ?? []) if (!touched.has(child) && touched.has(parent)) o.set(child, o.get(parent));
  return o;
}

/** The phase a show is in at `t` (walkthrough only), or null. */
export function phaseAt(show, t) {
  let at = null;
  for (const p of show.phases) if (p.t <= t) at = p;
  return at;
}
