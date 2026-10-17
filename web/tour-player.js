// The tour player (behold.tour/v1): which chapter of a tour a cycle is in,
// and which of its visuals are on, from the events that have happened. Pure:
// the tour and an event stream in, plain data out, so the live carve and a
// recorded cycle or bundle can feed it the same way.
//
// An event is one of:
//   { kind: "beat", beat, step, at }               demo.json's beat and step
//   { kind: "line", migration, line, at }          a migration's first or last progress line
//   { kind: "wave", wave, edge, at }               a wave's job starting or ending
// `at` is a time in ms. A trigger matches an event of its kind whose fields
// equal the trigger's; `after_at` (a named run's finish, which the server
// resolves) keeps out an event at or before it, and `blocked` (the named run
// does not exist yet) matches nothing.
//
// The current chapter is the last chapter, in the file's order, whose trigger
// has fired by `t`: a cycle's beats only go forward, so a later chapter that
// fired wins over an earlier one that fired since.

const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);

/** The first event at or before `t` that `trigger` matches, or null. */
export function firedBy(trigger, events, t = Infinity) {
  if (!trigger || trigger.blocked) return null;
  if (Array.isArray(trigger.any)) {
    let best = null;
    for (const tr of trigger.any) {
      const e = firedBy(tr, events, t);
      if (e && (!best || e.at < best.at)) best = e;
    }
    return best;
  }
  let best = null;
  for (const e of events || []) {
    if (!(e.at <= t)) continue;
    if (!matches(trigger, e)) continue;
    if (!best || e.at < best.at) best = e;
  }
  return best;
}

function matches(tr, e) {
  if (has(tr, "migration")) {
    if (e.kind !== "line" || e.migration !== tr.migration || e.line !== tr.line) return false;
  } else if (has(tr, "wave")) {
    if (e.kind !== "wave" || e.wave !== tr.wave || e.edge !== tr.edge) return false;
  } else {
    if (e.kind !== "beat") return false;
    if (has(tr, "beat") && e.beat !== tr.beat) return false;
    if (has(tr, "step") && e.step !== tr.step) return false;
  }
  if (typeof tr.after_at === "number" && !(e.at > tr.after_at)) return false;
  return true;
}

/**
 * The chapter at `t`: `{ index, chapter, at, progress }`, or null before the
 * first chapter's trigger. `step`: demo.json's step now, for how far a chapter
 * that a beat started has got along the tour's `steps`.
 */
export function chapterAt(tour, events, t = Infinity, step = null) {
  const chapters = (tour && tour.chapters) || [];
  for (let i = chapters.length - 1; i >= 0; i--) {
    const e = firedBy(chapters[i].trigger, events, t);
    if (e) return { index: i, chapter: chapters[i], at: e.at, progress: progressOf(tour, i, step) };
  }
  return null;
}

/** How far chapter `i` has got, 0..1: the step's place in the tour's steps; the last chapter is whole once reached. */
export function progressOf(tour, i, step) {
  const chapters = (tour && tour.chapters) || [];
  if (i >= chapters.length - 1) return 1;
  const steps = (tour && tour.steps) || [];
  const k = step ? steps.indexOf(step) : -1;
  if (k < 0 || steps.length < 2) return 0;
  return k / (steps.length - 1);
}

/** Each chapter's place on the rail: done, current (with its progress) or ahead. */
export function railOf(tour, at) {
  return ((tour && tour.chapters) || []).map((c, i) => ({
    n: i + 1,
    id: c.id,
    title: c.title,
    state: !at ? "ahead" : i < at.index ? "done" : i === at.index ? "current" : "ahead",
    progress: !at ? 0 : i < at.index ? 1 : i === at.index ? at.progress : 0,
  }));
}

/** A chapter's visuals that are on at `t`: those with no `when`, and those whose `when` has fired. Each with `at`, when it fired. */
export function shownAt(chapter, events, t = Infinity) {
  const out = [];
  for (const s of (chapter && chapter.show) || []) {
    if (!s.when) {
      out.push({ ...s, at: null });
      continue;
    }
    const e = firedBy(s.when, events, t);
    if (e) out.push({ ...s, at: e.at });
  }
  return out;
}

/**
 * A line of text with its facts filled in, or null when a fact it names has
 * no value: a fact with no record behind it is left out, never shown as 0.
 */
export function fill(text, facts) {
  if (typeof text !== "string") return null;
  let missing = false;
  const out = text.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, k) => {
    const v = facts ? facts[k] : undefined;
    if (v === undefined || v === null || v === "") {
      missing = true;
      return "";
    }
    return typeof v === "number" ? v.toLocaleString("en-US") : String(v);
  });
  return missing ? null : out;
}

/** A chapter's lines, filled; a line naming a fact with no record is dropped. */
export function chapterLines(chapter, facts) {
  return ((chapter && chapter.text) || []).map((l) => fill(l, facts)).filter((l) => l !== null);
}

/** The card's rows, filled; a row with no record is dropped. */
export function cardRows(card, facts) {
  return (card || []).map((r) => ({ label: r.label, text: fill(r.text, facts) })).filter((r) => r.text !== null);
}

// --- the live badge's lag (faithfulness 3) -----------------------------------

/** After this long with no write while a migration runs, the badge says it is waiting for the job. */
export const LAG_WAIT_MS = 60_000;

/**
 * The words beside LIVE: "last write N s ago", from the newest progress
 * line's `at` and the page's clock; "waiting for the job" once the gap passes
 * a minute while a migration runs; null with no write to measure from.
 */
export function lagText(newestAt, now, running) {
  const at = typeof newestAt === "number" ? newestAt : Date.parse(newestAt || "");
  if (!Number.isFinite(at)) return null;
  const gap = Math.max(0, now - at);
  if (running && gap > LAG_WAIT_MS) return "waiting for the job";
  const s = Math.floor(gap / 1000);
  if (s < 60) return `last write ${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `last write ${m} min ago`;
  return `last write ${Math.floor(m / 60)} h ago`;
}

// --- a landed dot's provenance (faithfulness 2) --------------------------------

/** A line's time as a reader reads it: UTC, to the millisecond. */
export function clockOf(at) {
  const d = new Date(typeof at === "number" ? at : Date.parse(at || ""));
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(11, 23)} UTC`;
}

/**
 * What happened to a landed dot, from its progress line and the migration
 * that wrote it: "live-mv retagged aws_iam_role.x from tl1-terralith to
 * tl1-team-a at 16:57:49.668 UTC · job #3655". `w`: { outcome, address, from,
 * to, at, tool, job, reason }.
 */
export function provenanceText(w) {
  if (!w || !w.address) return null;
  const when = clockOf(w.at);
  const at = when ? ` at ${when}` : "";
  const job = w.job ? ` · job #${w.job}` : "";
  if (w.outcome === "stamped") return `${w.tool || "live-import"} stamped ${w.address} into ${w.to}${at}${job}`;
  if (w.outcome === "refused") return `${w.tool || "live-mv"} refused to retag ${w.address} from ${w.from} to ${w.to}${w.reason ? `: ${w.reason}` : ""}${at}${job}`;
  return `${w.tool || "live-mv"} retagged ${w.address} from ${w.from} to ${w.to}${at}${job}`;
}

/** The choudoufu command a migration ran, from its record's `change`: an adoption stamps with live-import, a retag moves with live-mv. */
export function migrationTool(change) {
  return change === "adopt" ? "live-import" : "live-mv";
}

/** The job number in a job's URL (Forgejo/GitHub `/actions/runs/<n>`, GitLab `/-/jobs/<n>`), or null. */
export function jobNumber(url) {
  const m = typeof url === "string" ? /\/(?:actions\/runs|-\/jobs|jobs)\/(\d+)(?:[/?#]|$)/.exec(url) : null;
  return m ? Number(m[1]) : null;
}

// --- slowed playback (faithfulness 1) -------------------------------------------

/** The slowed control's choices: off is real time; each other is how far apart one read's lines are drawn. */
export const SLOWED = [
  { n: 1, words: "real time", stepMs: 0 },
  { n: 2, words: "slowed ×2", stepMs: 25 },
  { n: 4, words: "slowed ×4", stepMs: 50 },
  { n: 8, words: "slowed ×8", stepMs: 100 },
];

/** The pacing of one read's lines for a slowed factor: 0 (real time) unless a person chose to slow it. */
export function stepMsFor(n) {
  const s = SLOWED.find((x) => x.n === n);
  return s ? s.stepMs : 0;
}
