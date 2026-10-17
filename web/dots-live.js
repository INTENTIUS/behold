// The dots layer's live driver (#715): terragucci's estate rosters and its
// migrations' progress lines (/api/terragucci/carve, src/terragucci-carve.ts)
// read into the same "show" a recording makes (web/dots-recording.js), so the
// one layer draws both. Pure: the route's answer in, plain data out.
//
// What a dot is: one resource instance an estate's roster or a progress line
// names, keyed by its live id. A stock root's roster has no live ids (it is
// written from the state), so its dots are keyed by estate and address until a
// stamp names their live id; a move then finds them by that id.
//
// Each progress line is one event:
//   stamped  an adoption: the dot gains a ring, since it now wears its tags
//            (and moves, when the line names another estate);
//   moved    a split: the dot flies to its new estate's box;
//   refused  the move is refused: the dot bounces back and stays lit red;
//   skipped  nothing to draw; it is counted.
//
// Lines play as they arrive. A line already in the first answer happened
// before the page looked, so it is drawn where it ended, with no flight; a
// line that arrives later plays from the moment it was seen. Lines that
// arrive in one batch are paced `stepMs` apart, queued after the last one
// still to play: an adoption on floci stamps 82 resources in under a second,
// so its lines come in one read, and 50 ms a line keeps the beat watchable
// (about 4 s for 82). A recording's replay paces itself (web/dots-scene.js).
//
// An adoption turns a stock root into an estate (the answer's `adopted`
// pairs them). That is one box changing its name, not two boxes: the
// estate's resources and lines are drawn in the stock root's box, the stamps
// ring the dots where they are, and the box takes the estate's name when the
// first stamp plays.

/** How far apart the lines of one batch play, and how far ahead of a line its flight may start. */
export const LIVE = { stepMs: 50, lead: 2_500 };

/** A progress line's key: the same line in two reads is the same event. */
export function lineKey(migration, line) {
  return `${migration}|${line.at}|${line.estate_from}|${line.address}|${line.outcome}`;
}

/**
 * When each line is drawn from: `seen` maps a line's key to that time. Lines
 * of the first read keep their own `at` (the past); the lines new in a later
 * read play `stepMs` apart in the order they were written, from `now`, or
 * after the last line of an earlier batch still waiting to play. Returns a new
 * map; `seen` is not changed.
 */
export function stampArrivals(answer, seen, now, { first = false, stepMs = LIVE.stepMs } = {}) {
  const out = new Map(seen);
  const fresh = [];
  for (const m of answer && answer.migrations ? answer.migrations : []) {
    for (const l of m.lines) {
      const k = lineKey(m.name, l);
      if (out.has(k)) continue;
      if (first) out.set(k, Date.parse(l.at) || now);
      else fresh.push({ k, at: Date.parse(l.at) || 0 });
    }
  }
  fresh.sort((a, b) => a.at - b.at);
  let queued = -Infinity;
  for (const t of seen.values()) if (t > queued) queued = t;
  let next = Math.max(now, queued + stepMs);
  for (const f of fresh) {
    out.set(f.k, next);
    next += stepMs;
  }
  return out;
}

/**
 * The name an estate's box carries at show time `t`: a stock root an
 * adoption replaced takes its estate's name once the first stamp plays.
 */
export function boxName(show, estate, t) {
  const r = show && show.renames ? show.renames.get(estate) : undefined;
  return r && t >= r.at ? r.to : estate;
}

const unknownType = (address) => {
  const m = /(?:^|\.)([a-z][a-z0-9]*_[a-z0-9_]+)\.[^.]+$/.exec(address.replace(/\[[^\]]*\]/g, ""));
  return m ? m[1] : "";
};

/**
 * The live carve as a show. `seen` is {@link stampArrivals}' map; `now` is the
 * show's end so far. `t0`, when given, is the start an earlier read chose, so
 * the show's clock stays put from one read to the next.
 */
export function liveShow(answer, seen, now, { t0: start = null } = {}) {
  const dots = new Map(); // id -> { id, address, type, taggable, estate0, live_id, marked }
  const byLive = new Map();
  const byAddr = new Map();
  const usedAddr = new Set();
  const place = (estate, address) => `${estate}\u0000${address}`;
  const addDot = (estate, r) => {
    // A dot's address is its address where it was first seen, kept unique so the layout can key on it.
    let address = r.address;
    for (let n = 2; usedAddr.has(address); n++) address = `${r.address}#${n}`;
    usedAddr.add(address);
    const d = { id: address, address, type: r.type || unknownType(r.address), taggable: !r.follows, estate0: estate, live_id: r.live_id || null, marked: !!r.marked, follows: r.follows || null, home: estate };
    dots.set(d.id, d);
    byAddr.set(place(estate, r.address), d);
    if (d.live_id) byLive.set(d.live_id, d);
    return d;
  };
  const find = (estate, r) => (r.live_id && byLive.get(r.live_id)) || byAddr.get(place(estate, r.address));

  // An adopted stock root and its estate are one box, keyed by the stock root's name.
  const alias = new Map(((answer && answer.adopted) || []).map((a) => [a.to, a.from]));
  const as = (e) => alias.get(e) ?? e;
  const estates = ((answer && answer.estates) || []).map((e) => ({ ...e, estate: as(e.estate) }));
  const migrations = ((answer && answer.migrations) || []).map((m) => ({ ...m, lines: m.lines.map((l) => ({ ...l, estate_from: as(l.estate_from), estate_to: as(l.estate_to), key: lineKey(m.name, l), into: l.estate_to })) }));
  // 1. A stock root's resources, which only an address names.
  for (const e of estates) for (const r of e.resources) if (!r.live_id && !find(e.estate, r)) addDot(e.estate, r);
  // 2. Each line in time order, finding its dot by live id, else where it came from.
  const lines = [];
  for (const m of migrations) for (const l of m.lines) lines.push({ m: m.name, l, t: seen.get(l.key) ?? (Date.parse(l.at) || now) });
  lines.sort((a, b) => a.t - b.t);
  const claimed = new Set();
  for (const x of lines) {
    const { l } = x;
    let d = find(l.estate_from, l);
    // A destination roster written after the move (a wave's, from planned values, so with no live ids) already drew
    // the resource in the estate it moved to: the line moves that dot, from where it came, never a second one.
    if (!d) {
      const there = byAddr.get(place(l.estate_to, l.address));
      if (there && !claimed.has(there) && there.estate0 === l.estate_to) {
        d = there;
        d.estate0 = l.estate_from;
        byAddr.set(place(l.estate_from, l.address), d);
      }
    }
    if (!d) d = addDot(l.estate_from, { address: l.address, type: "", live_id: l.live_id, follows: l.follows });
    if (l.live_id && !d.live_id) {
      d.live_id = l.live_id;
      byLive.set(l.live_id, d);
    }
    // The destination's roster named this resource by address only (a wave's roster, written after the move), and
    // an earlier line of the cycle (the adoption's stamp) already made its dot: one dot, under the plain address.
    const old = byAddr.get(place(l.estate_to, l.address));
    if (old && old !== d && !claimed.has(old) && old.estate0 === l.estate_to && !old.live_id) {
      dots.delete(old.id);
      if (d.id !== old.id) {
        dots.delete(d.id);
        usedAddr.delete(d.id);
        d.id = d.address = old.id;
        dots.set(d.id, d);
      }
    }
    byAddr.set(place(l.estate_to, l.address), d);
    claimed.add(d);
    x.dot = d;
  }
  // 3. Every other estate's resources: by live id, else by address, else a dot of their own.
  for (const e of estates) {
    for (const r of e.resources) {
      const d = find(e.estate, r);
      if (d) {
        if (r.marked) d.marked = true;
        if (!d.type && r.type) d.type = r.type;
        if (r.follows) d.follows = d.follows || r.follows;
        d.home = e.estate;
        continue;
      }
      addDot(e.estate, r).home = e.estate;
    }
  }

  // The source: where the first line came from, else the estate holding the most dots.
  const owners0 = new Map([...dots.values()].map((d) => [d.id, d.estate0]));
  let source = lines.length ? lines[0].l.estate_from : null;
  if (!source) {
    const n = new Map();
    for (const e of owners0.values()) n.set(e, (n.get(e) ?? 0) + 1);
    source = [...n].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? (estates[0] ? estates[0].estate : "estate");
  }

  // Parents: a line or roster entry that follows another names it by address.
  const parents = new Map();
  for (const d of dots.values()) {
    if (!d.follows) continue;
    const p = byAddr.get(place(d.estate0, d.follows)) || [...dots.values()].find((q) => q.address === d.follows);
    if (p && p !== d) parents.set(d.id, p.id);
  }

  // Events.
  const events = [];
  const writeOf = new Map(); // `${migration}|${parent id}` -> its write, for followers
  let t0 = now;
  for (const d of dots.values()) if (d.marked && !lines.some((x) => x.dot === d && x.l.outcome === "stamped")) events.push({ kind: "adopt", t: -Infinity, start: -Infinity, address: d.id, before: true });
  for (const x of lines) {
    const { l, t, dot } = x;
    t0 = Math.min(t0, t);
    if (l.outcome === "skipped") continue;
    if (l.outcome === "stamped") {
      events.push({ kind: "adopt", t: t + 300, start: t, address: dot.id, migration: x.m, at: Date.parse(l.at) || t });
      if (l.estate_to === l.estate_from) continue;
    }
    const ok = l.outcome !== "refused";
    const parent = l.follows ? parents.get(dot.id) : undefined;
    const pw = parent && writeOf.get(`${x.m}|${parent}`);
    if (pw && ok && pw.ok) {
      pw.followers.push(dot.id);
      continue;
    }
    const w = { kind: "write", t: t + 1, start: t, address: dot.id, followers: [], from: l.estate_from, to: l.estate_to, ok, migration: x.m, at: Date.parse(l.at) || t, ...(ok ? {} : { refusal: "refused", refusalSummary: l.reason || "the move was refused" }) };
    writeOf.set(`${x.m}|${dot.id}`, w);
    events.push(w);
  }
  t0 = start !== null && Number.isFinite(start) ? Math.min(start, t0 - LIVE.lead) : Math.min(t0, now) - LIVE.lead;
  for (const ev of events) if (ev.before) ev.t = ev.start = t0;
  events.sort((a, b) => a.start - b.start);

  const ownersEnd = new Map(owners0);
  for (const ev of events) {
    if (ev.kind !== "write" || !ev.ok) continue;
    ownersEnd.set(ev.address, ev.to);
    for (const f of ev.followers) ownersEnd.set(f, ev.to);
  }
  for (const [child, parent] of parents) if (!events.some((e) => e.address === child)) ownersEnd.set(child, ownersEnd.get(parent) ?? ownersEnd.get(child));

  // The box's new name plays with the first stamp into the estate; with none, it has the estate's name already.
  const renames = new Map();
  for (const [to, from] of alias) {
    const stamps = lines.filter((x) => x.l.outcome === "stamped" && x.l.into === to).map((x) => x.t);
    renames.set(from, { to, at: stamps.length ? Math.min(...stamps) : -Infinity });
  }

  const roster = [...dots.values()].map((d) => ({ address: d.id, type: d.type, taggable: d.taggable, ...(d.live_id ? { live_id: d.live_id } : {}) }));
  const names = [...new Set([source, ...estates.map((e) => e.estate), ...ownersEnd.values()])];
  return {
    kind: "live",
    title: source,
    recordedAt: null,
    source,
    estates: names,
    roster,
    owners0,
    ownersEnd,
    events,
    threads: [],
    phases: [],
    parents,
    t0,
    t1: now,
    spaced: false,
    renames,
    counts: Object.fromEntries(estates.map((e) => [e.estate, e.count])),
  };
}

/** What changed between two shows, so the layer rebuilds only when it must. */
export function showKey(show) {
  const last = show.events.length ? show.events[show.events.length - 1] : null;
  const ends = new Map();
  for (const e of show.ownersEnd.values()) ends.set(e, (ends.get(e) ?? 0) + 1);
  return [show.source, show.roster.length, show.events.length, last ? `${last.address}@${last.start}` : "", [...ends].sort().join(",")].join("|");
}

/** The newest migration that is running, else the newest with lines; null when none. */
export function currentMigration(answer) {
  const ms = (answer && answer.migrations) || [];
  const newest = (m) => m.lines.reduce((a, l) => Math.max(a, Date.parse(l.at) || 0), 0);
  const running = ms.filter((m) => m.running).sort((a, b) => newest(b) - newest(a));
  if (running.length) return running[0];
  return ms.filter((m) => m.lines.length).sort((a, b) => newest(b) - newest(a))[0] || null;
}

/** Whether the layer has anything to draw: the gate is open and some roster or line names a resource. */
export function carveDrawable(answer) {
  if (!answer || answer.live !== true) return false;
  return (answer.estates || []).some((e) => e.resources.length > 0) || (answer.migrations || []).some((m) => m.lines.length > 0);
}

/**
 * A migration's counts as the page has played them by show time `t`: each
 * line counts once its paced time has come. While lines are still to play,
 * the counts are those lines' and the rest are left; once all have played,
 * the record's own counts. `playing` says which.
 */
export function playedCounts(migration, seen, t) {
  const c = { moved: 0, stamped: 0, refused: 0, skipped: 0 };
  let n = 0;
  for (const l of migration.lines) {
    const at = seen.get(lineKey(migration.name, l)) ?? (Date.parse(l.at) || 0);
    if (at > t) continue;
    c[l.outcome] = (c[l.outcome] ?? 0) + 1;
    n++;
  }
  if (n === migration.lines.length) return { counts: migration.counts, playing: false };
  const r = migration.counts;
  const total = r.moved + r.stamped + r.refused + r.skipped + (r.left ?? 0);
  return { counts: { ...c, left: Math.max(0, Math.max(total, migration.lines.length) - n) }, playing: true };
}
