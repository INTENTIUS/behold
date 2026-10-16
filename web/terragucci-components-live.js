// #571: the live marks on a terragucci repo's components zoom, the roots drawn
// one card per root in wave boxes titled with the job that applies the wave
// (behold#597). The same marks the resources zoom carries (#568, #569), for
// the run the view is pinned to: each card in its wave's state, the waiting
// wave's plan digest on its box, the box's title with its job's status from
// the pipeline's runs (`/api/terragucci/runs`, terragucci#1038), and the reads
// between the roots. app.js draws what these return; nothing here touches
// the DOM.
//
// The marks are the reports' and the runs', read when they were written: a
// wave that failed says the waves before it stay applied, and nothing here is
// all-or-nothing.

import { pinsCommit, rootStates } from "./terragucci-change.js";

/** A job's status as its wave box says it. A job held at a terragucci gate is never a failure. */
export const JOB_WORDS = {
  queued: "queued",
  running: "running",
  waiting: "held at the gate",
  success: "succeeded",
  failure: "failed",
  cancelled: "cancelled",
  skipped: "skipped",
};

/** The tone a job's status is drawn in, on the same channels as a root's state. */
export const JOB_TONE = { queued: "idle", running: "busy", waiting: "wait", success: "ok", failure: "bad", cancelled: "idle", skipped: "idle" };

/** A card's state in one or two words, when the full words don't fit the card. */
export const SHORT_WORDS = {
  planned: "planned",
  "not-started": "queued",
  waiting: "waiting",
  applying: "applying",
  applied: "applied",
  refused: "refused",
  failed: "failed",
  unchanged: "unchanged",
  outside: "not in this run",
};

const sameSha = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/**
 * The commit whose pipeline runs the wave boxes report: the pinned one, or
 * with no pin, the run view's. None when the pin holds the view off every run
 * (`base`, `none`, a pull request's plan): the boxes then carry no job status.
 */
export function runsCommit(pin, progress) {
  if (pin) return pinsCommit(pin) ? pin : null;
  const run = progress && !progress.error && progress.run && progress.run.present ? progress.run : null;
  return run && run.commit ? run.commit : null;
}

/**
 * A wave job's status on a commit: of the runs on that commit (the index is
 * newest first), the newest in which the job ran or waits, so a resume's run
 * of `apply-wave-2` follows the merge's run that held it. A job every such
 * run skipped is `skipped`. Null when no run on the commit has the job.
 */
export function jobStatus(index, commit, jobName) {
  const runs = index && index.doc && Array.isArray(index.doc.runs) ? index.doc.runs : [];
  let skipped = null;
  // behold#571: a newer run on the commit that skipped this job but ran
  // another (a /terragucci apply re-run applies every wave in its
  // apply-comment job) is the latest run for the wave.
  let later = null;
  // behold#693: and whether that run waits at its gate, which the run view
  // doesn't say until the approval: the reports still hold the failure.
  let held = false;
  for (const run of runs) {
    if (!sameSha(run.commit, commit)) continue;
    const job = (run.jobs || []).find((j) => j.name === jobName);
    if (!job) continue;
    if (job.status !== "skipped") {
      return { status: job.status, words: JOB_WORDS[job.status] || job.status, tone: JOB_TONE[job.status] || "idle", run: run.id, ...(later ? { superseded: later } : {}), ...(later && held ? { held: true } : {}) };
    }
    if (!later && (run.jobs || []).some((j) => j.status !== "skipped")) {
      later = run.id;
      held = run.status === "waiting" || (run.jobs || []).some((j) => j.status === "waiting");
    }
    skipped = skipped || { status: "skipped", words: JOB_WORDS.skipped, tone: "idle", run: run.id };
  }
  return skipped;
}

/** A wave's state from the run view, as a box's title says it after a re-run. */
export const WAVE_WORDS = { waiting: "held at the gate", applying: "running", applied: "applied", failed: "failed", refused: "refused" };

/**
 * The status a wave's box shows: its job's, unless a later run on the commit
 * took the wave over (`superseded`); then the run view's state for the wave,
 * which is the latest run's. While that later run waits at its gate (`held`),
 * a wave its job failed reads "held at the gate": the run view keeps the
 * failure until the approval lets the re-run write (behold#693).
 */
export function waveStatus(status, state) {
  if (!status || !status.superseded) return status;
  const undone = state !== "applied" && state !== "applying";
  const failed = status.status === "failure" || status.status === "cancelled" || state === "failed" || state === "refused";
  if (status.held && undone && failed) return { status: "waiting", words: WAVE_WORDS.waiting, tone: toneOf("waiting"), run: status.superseded, held: true };
  if (!state || !WAVE_WORDS[state]) return status;
  return { status: state, words: WAVE_WORDS[state], tone: toneOf(state), run: status.superseded };
}

/** A status's words in a narrow box, where the full words cross an edge (behold#693): "held" for a wave held at its gate. */
export function statusShort(status) {
  if (!status) return null;
  return status.status === "waiting" ? "held" : status.words;
}

/** "apply-wave-2 · held at the gate", or the job alone without a status. */
export function waveTitle(jobName, status) {
  return status ? `${jobName} · ${status.words}` : jobName;
}

/** The wave a `groups.byWave` key names: `wave-2` is 2. Null for any other key. */
export function waveOfKey(key) {
  const m = /^wave-(\d+)$/.exec(String(key || ""));
  return m ? Number(m[1]) : null;
}

/**
 * Each component's marks and each wave box's, for the run the view draws:
 *
 * - `cards[component]`: its root, wave and state (`rootStates`' words and
 *   tone; `words` without the "wave N ·" its box already says, `short` for a
 *   card the words don't fit), and the facts for its tooltip;
 * - `waves[n]`: the wave's state, its job and the job's status on the run's
 *   commit, the box's title, and the facts drawn on the box (a waiting
 *   wave's plan digest first).
 *
 * `facets` is the components graph's `meta.terragucciComponents`: its jobs
 * (component -> job and wave) and `roots` (component -> the root it applies;
 * a component without one is taken to be its root's name).
 */
export function componentMarks(answer, progress, facets, { runs = null, pin = null } = {}) {
  const jobs = facets && Array.isArray(facets.jobs) ? facets.jobs : [];
  const rootOf = (c) => (facets && facets.roots && facets.roots[c]) || c;
  const states = rootStates(answer, progress);
  const stage = states.stage;
  const commit = runsCommit(pin, progress);
  const cards = {};
  for (const j of jobs) {
    const root = rootOf(j.component);
    const st = states.roots[root];
    if (!st) continue;
    cards[j.component] = {
      root,
      wave: j.wave ?? st.wave,
      state: st.state,
      tone: st.tone,
      words: st.words.replace(/^wave \d+ · /, ""),
      short: SHORT_WORDS[st.state] || st.state,
      facts: st.facts,
    };
  }
  const waves = {};
  const waveNumbers = [...new Set(jobs.map((j) => j.wave).filter((n) => typeof n === "number"))].sort((a, b) => a - b);
  for (const n of waveNumbers) {
    const jobName = jobs.find((j) => j.wave === n).jobName;
    const members = jobs.filter((j) => j.wave === n).map((j) => cards[j.component]).filter(Boolean);
    const w = waveState(answer, progress, stage, n);
    const status = commit ? waveStatus(jobStatus(runs, commit, jobName), w) : null;
    const facts = [];
    for (const m of members) for (const f of m.facts) if (!facts.includes(f)) facts.push(f);
    // The plan a waiting wave is approved for first, as it's what the approval
    // names; then, for a wave that failed, the waves before it that stay applied.
    const rank = (f) => (/^approve plan /.test(f) ? 0 : / stays applied$/.test(f) ? 1 : 2);
    facts.sort((a, b) => rank(a) - rank(b));
    waves[n] = {
      number: n,
      job: jobName,
      state: w,
      // A re-run held at its gate (behold#693) tones the box as its title says.
      tone: status && status.held && status.status === "waiting" ? status.tone : w ? toneOf(w) : status ? status.tone : "idle",
      status,
      title: waveTitle(jobName, status),
      facts,
    };
  }
  return { stage, cards, waves, commit };
}

const toneOf = (state) => ({ planned: "plan", waiting: "wait", applying: "busy", applied: "ok", failed: "bad", refused: "bad" })[state] || "idle";

/** A wave's own state: the run view's once merged, `planned` while a pull request plans it. */
function waveState(answer, progress, stage, n) {
  if (stage === "apply") {
    const w = progress.states.find((x) => x.number === n);
    return w ? w.state : null;
  }
  if (stage === "pull-request") {
    const w = answer.pull_request.waves.find((x) => x.number === n);
    return w ? w.state || "planned" : null;
  }
  return null;
}

/** The words for a card: the full state when it fits in `room` (a width), else the short form. */
export function cardWords(mark, fits) {
  return fits(mark.words) ? mark.words : mark.short;
}

