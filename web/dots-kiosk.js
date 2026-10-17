// The dots layer in the kiosk (#712, #715): what Watch says and frames as a carve
// replays. Every beat is read off the scene, which is the recording's moves
// flown by unit (web/dots-scene.js): who moved where, which landed, which
// were refused. Pure: scene and time in, words and a focus out.

/** The kiosk's loop: the replay plays, holds on its result, then starts again. */
export const LOOP = { holdMs: 10_000 };
/** How long a Tips bubble stays up, and the least time between two. */
export const TIP = { showMs: 4_200, gapMs: 1_200, staleMs: 9_000 };
/** The director changes what it frames at most this often. */
export const DIRECTOR = { holdMs: 2_600 };

const fmt = (n) => Number(n).toLocaleString("en-US");

export function shortName(e, source) {
  return e !== source && e.startsWith(`${source}-`) ? e.slice(source.length + 1) : e;
}

/** The carve's facts, once per scene. */
export function carveStory(scene) {
  const moves = scene.flights.filter((f) => !f.parent);
  const landing = scene.flights.filter((f) => f.ok);
  const refusals = moves.filter((f) => !f.ok);
  const firstLanding = new Map();
  for (const f of landing) if (!firstLanding.has(f.to) || f.end < firstLanding.get(f.to).end) firstLanding.set(f.to, f);
  const dests = [...firstLanding.keys()].sort();
  return {
    source: scene.source,
    moves,
    dests,
    firstLanding,
    firstRefusal: refusals.reduce((a, f) => (!a || f.end < a.end ? f : a), null),
    start: moves.length ? Math.min(...moves.map((f) => f.start)) : 0,
    end: scene.flights.length ? Math.max(...scene.flights.map((f) => f.end)) : 0,
    refused: refusals.length,
    resourcesMoved: landing.length,
  };
}

/** Each estate's count at t, a dot counted where it is until it lands. */
export function countsNow(scene, t) {
  const owners = new Map(scene.show.owners0);
  for (const f of scene.landing) if (f.end <= t) owners.set(f.address, f.to);
  const c = new Map();
  for (const e of owners.values()) c.set(e, (c.get(e) ?? 0) + 1);
  return c;
}

/** The move flying most recently at t (not a child), or null. */
export function currentMove(story, t) {
  let at = null;
  for (const f of story.moves) if (f.start <= t && (!at || f.start > at.start)) at = f;
  return at;
}

/**
 * What Watch says at replay time t: the title, the line under it, how many
 * moves are left, and what the director frames.
 */
export function beatAt(story, scene, t) {
  const src = story.source;
  const n = story.dests.length;
  const counts = countsNow(scene, t);
  const left = story.moves.filter((f) => f.end > t).length;
  const total = story.moves.length;
  const next = { text: left ? `${fmt(left)} move${left === 1 ? "" : "s"} left` : "carve done", fraction: total ? (total - left) / total : 1 };
  if (t < story.start) {
    return {
      phase: "start",
      title: `Carving ${src} into ${n} team estates`,
      line: { label: "now", text: `${fmt(counts.get(src) ?? 0)} resources in one estate, about to move by tag writes alone`, tone: "busy" },
      next,
      focus: { kind: "source" },
    };
  }
  if (t >= story.end) {
    const kept = counts.get(src) ?? 0;
    return {
      phase: "settled",
      title: `Carved: ${n} estate${n === 1 ? "" : "s"}`,
      line: {
        label: "done",
        text: `${fmt(story.resourcesMoved)} resources moved, nothing recreated` + (story.refused ? `; ${story.refused} moves refused, so ${fmt(kept)} stay in ${src}` : ""),
        tone: "ok",
      },
      next,
      focus: { kind: "all" },
    };
  }
  const f = currentMove(story, t);
  const refusedSoFar = story.moves.filter((m) => !m.ok && m.end <= t).length;
  if (f && !f.ok) {
    return {
      phase: "carve",
      title: `Carving ${src} into ${n} team estates`,
      line: { label: "refused", text: `${f.address}: ${refusedSoFar > 1 ? `${refusedSoFar} moves refused` : "the move is refused"}; ${refusedSoFar > 1 ? "they stay" : "it stays"} in ${src}`, tone: "bad" },
      next,
      focus: { kind: "estate", estate: src },
    };
  }
  const to = f ? f.to : src;
  return {
    phase: "carve",
    title: `Carving ${src} into ${n} team estates`,
    line: { label: "moving", text: `${shortName(to, src)}: ${fmt(counts.get(to) ?? 0)} resources moved, nothing recreated`, tone: "busy" },
    next,
    focus: { kind: "estate", estate: to },
  };
}

/**
 * The Tips bubbles that fire in (from, to]: each estate's first landing, the
 * first refusal, and the end. Each has a key, so a loop shows it once.
 */
export function tipsBetween(story, from, to) {
  const src = story.source;
  const out = [];
  const inWin = (t) => t > from && t <= to;
  for (const e of story.dests) {
    const f = story.firstLanding.get(e);
    if (f && inWin(f.end)) out.push({ key: `land:${e}`, at: f.end, recordedAt: f.at, estate: e, tone: "ok", title: `${shortName(e, src)}: the first landing`, text: `${shortName(e, src)}: its first resource lands. live-mv rewrote the ownership tags; nothing was recreated.` });
  }
  const r = story.firstRefusal;
  if (r && inWin(r.end)) {
    const why = r.refusalSummary ? r.refusalSummary.replace(/\.$/, "").toLowerCase() : r.refusal || "refused";
    out.push({ key: "refused", at: r.end, recordedAt: r.at, estate: src, address: r.address, tone: "bad", title: "A move is refused", text: `${r.address} is refused: ${why}. Nothing was written, so it stays in ${src}.` });
  }
  if (inWin(story.end)) out.push({ key: "end", at: story.end, recordedAt: story.moves.reduce((m, f) => Math.max(m, f.at || 0), 0) || null, estate: null, tone: "ok", title: "Carved", text: `Carved into ${story.dests.length} estate${story.dests.length === 1 ? "" : "s"} by tag writes alone: ${fmt(story.resourcesMoved)} resources moved, none recreated.` });
  return out.sort((a, b) => a.at - b.at);
}

/** What the director frames: a focus held at least DIRECTOR.holdMs before it changes. */
export function directorFocus(prev, want, wall) {
  const same = prev && prev.focus.kind === want.kind && prev.focus.estate === want.estate;
  if (same) return prev;
  // The start and the end always take over; a move to another estate waits its turn.
  if (prev && want.kind === "estate" && prev.focus.kind === "estate" && wall - prev.since < DIRECTOR.holdMs) return prev;
  return { focus: want, since: wall };
}

// --- the live carve (#715) -------------------------------------------------------
// The same beats over a carve that is being written: the title and the next
// line come from demo.json while a migration runs ("carve: 36 of 79 moved"),
// the line under the title from the newest progress line, and the end is the
// migration's own finish, not the last flight.

/** After a live carve ends, Watch holds on the result this long before handing the camera back. */
export const LIVE_HOLD_MS = 12_000;

const lineWords = {
  moved: "moving",
  stamped: "adopting",
  refused: "refused",
};

/** The newest event of the show that has started by replay time t: a write's flight, or an adoption. */
export function latestEvent(scene, t) {
  let at = null;
  for (const f of scene.flights) if (!f.parent && f.start <= t && (!at || f.start >= at.start)) at = { ...f, kind: f.ok ? "moved" : "refused" };
  const t0 = scene.show.t0;
  for (const e of scene.show.events) {
    if (e.kind !== "adopt" || e.before) continue;
    const s = e.start - t0;
    if (s <= t && (!at || s >= at.start)) at = { kind: "stamped", address: e.address, start: s, to: null, from: null };
  }
  return at;
}

/**
 * What Watch says over a live carve at replay time t. `ctx`: { demo, migration }
 * from the route's answer (demo.json's fields, and the migration in view).
 */
export function liveBeat(scene, t, ctx = {}) {
  const src = scene.source;
  const story = carveStory(scene);
  const counts = countsNow(scene, t);
  const m = ctx.migration || null;
  const demo = ctx.demo || null;
  // The counts as played (web/dots-live.js playedCounts): the caption and the next line say the same numbers.
  const shown = ctx.shown || null;
  const c = m ? (shown ? shown.counts : m.counts) : null;
  const total = c ? c.moved + c.stamped + c.refused + c.skipped + (c.left ?? 0) : story.moves.length;
  const doneN = c ? c.moved + c.stamped + c.refused + c.skipped : story.moves.filter((f) => f.end <= t).length;
  // demo.json's next line names the migration with the driver's count, read when it last looked; the page's own count replaces it.
  const named = demo && demo.next ? /^\s*([^:\s]+):\s+\d+\s+of\s+\d+\s+(?:moved|stamped)\b/.exec(demo.next) : null;
  const ours = !!(shown && m && (!demo || !demo.next || (named && named[1] === m.name)));
  const nextText = ours
    ? `${m.name}: ${fmt(doneN)} of ${fmt(total)} ${c.stamped && !c.moved ? "stamped" : "moved"}`
    : demo && demo.next
      ? demo.next
      : m
        ? `${m.name}: ${fmt(c.moved + c.stamped)} of ${fmt(total)} ${c.stamped && !c.moved ? "stamped" : "moved"}`
        : "no migration running";
  const next = { text: nextText, fraction: total ? Math.min(1, doneN / total) : 0 };
  const title = demo && demo.title ? demo.title : m ? `Carving ${src}: ${m.name}` : src;
  const ev = latestEvent(scene, t);
  const running = !!(m && (m.running || (shown && shown.playing)));
  if (!ev) {
    return {
      phase: running ? "start" : "stock",
      title,
      line: { label: "now", text: `${fmt(counts.get(src) ?? 0)} resources in ${src}${running ? ", the migration is starting" : ""}`, tone: running ? "busy" : "idle" },
      next,
      focus: { kind: "source" },
    };
  }
  if (!running && m) {
    const kept = counts.get(src) ?? 0;
    const r = resourceCounts(m);
    const n = [...counts.entries()].filter(([e, v]) => v > 0 && e !== src).length;
    return {
      phase: "settled",
      title,
      line: {
        label: "done",
        text: `${m.name}: ${fmt(r.moved)} resources moved, ${fmt(r.stamped)} stamped, nothing recreated` + (r.refused ? `; ${r.refused} refused, so ${fmt(kept)} stay in ${src}` : "") + (n ? ` · ${n} estate${n === 1 ? "" : "s"} beside ${src}` : ""),
        tone: r.refused ? "bad" : "ok",
      },
      next: { ...next, fraction: 1 },
      focus: { kind: "all" },
    };
  }
  if (ev.kind === "refused") {
    return { phase: "carve", title, line: { label: "refused", text: `${ev.address}: ${ev.refusalSummary || "the move is refused"}; it stays in ${shortName(ev.from || src, src)}`, tone: "bad" }, next, focus: { kind: "estate", estate: ev.from || src } };
  }
  if (ev.kind === "stamped") {
    return { phase: "carve", title, line: { label: lineWords.stamped, text: `${ev.address} wears its estate's tags now; nothing was recreated`, tone: "busy" }, next, focus: { kind: "source" } };
  }
  return { phase: "carve", title, line: { label: lineWords.moved, text: `${shortName(ev.to, src)}: ${fmt(counts.get(ev.to) ?? 0)} resources, moved by tag writes, nothing recreated`, tone: "busy" }, next, focus: { kind: "estate", estate: ev.to } };
}

/**
 * The live carve's Tips that fire in (from, to]: each estate's first landing
 * and the first refusal, from the flights. The end is told by the caller when
 * the migration finishes ({@link liveEndTip}). Keys are stable across reads, so
 * a bubble shows once however often the scene is rebuilt.
 */
export function liveTipsBetween(scene, from, to) {
  const story = carveStory(scene);
  const src = story.source;
  const out = [];
  const inWin = (t) => t > from && t <= to;
  for (const e of story.dests) {
    const f = story.firstLanding.get(e);
    if (f && inWin(f.end)) out.push({ key: `land:${e}`, at: f.end, recordedAt: f.at, estate: e, tone: "ok", title: `${shortName(e, src)}: the first landing`, text: `${shortName(e, src)}: its first resource lands. The migration rewrote the ownership tags; nothing was recreated.` });
  }
  const r = story.firstRefusal;
  if (r && inWin(r.end)) {
    const why = r.refusalSummary ? r.refusalSummary.replace(/\.$/, "") : r.refusal || "refused";
    out.push({ key: "refused", at: r.end, recordedAt: r.at, estate: r.from || src, address: r.address, tone: "bad", title: "A move is refused", text: `${r.address} is refused: ${why}. Nothing was written, so it stays in ${shortName(r.from || src, src)}.` });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * A migration's counts in resources, not lines: a follower of two parents has
 * a moved line under each (terragucci#1146), so the record's line counts can
 * say 45 where 39 resources moved. With no lines, the record's own counts.
 */
export function resourceCounts(migration) {
  const lines = (migration && migration.lines) || [];
  if (!lines.length) return migration ? migration.counts : null;
  const n = (o) => new Set(lines.filter((l) => l.outcome === o).map((l) => l.live_id || l.address)).size;
  return { ...migration.counts, moved: n("moved"), stamped: n("stamped"), refused: n("refused"), skipped: n("skipped") };
}

/** The Tip for a migration that has just finished. */
export function liveEndTip(migration, t) {
  const c = resourceCounts(migration);
  return {
    key: `end:${migration.name}`,
    at: t,
    recordedAt: null,
    estate: null,
    tone: c.refused ? "bad" : "ok",
    title: `${migration.name}: done`,
    text: `${migration.name} is done: ${fmt(c.moved)} resources moved and ${fmt(c.stamped)} stamped by tag writes alone, none recreated${c.refused ? `; ${c.refused} refused, left where they were` : ""}.`,
  };
}
