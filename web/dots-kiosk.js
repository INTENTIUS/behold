// The dots preview in the kiosk (#712): what Watch says and frames as a carve
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
      title: `Carved: ${n} estates`,
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
  if (inWin(story.end)) out.push({ key: "end", at: story.end, recordedAt: story.moves.reduce((m, f) => Math.max(m, f.at || 0), 0) || null, estate: null, tone: "ok", title: "Carved", text: `Carved into ${story.dests.length} estates by tag writes alone: ${fmt(story.resourcesMoved)} resources moved, none recreated.` });
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
