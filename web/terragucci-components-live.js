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

import { BLOCKED_TONE, blockedHeader, blockedOf, pinsCommit, resultFailed, resultTone, resultWords, rootStates, totalsLine, waveResultOf } from "./terragucci-change.js";
import { shortReason } from "./chant-pr-marks.js";
import { rootNames } from "./cone.js";

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
  // behold#741 (terragucci#1161): a root an upstream that did not apply held.
  blocked: "blocked",
  // behold#741: a story's later pull request (the fix) leaves out what landed before it.
  "applied-earlier": "applied earlier",
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

/**
 * behold#751: a wave's job status, unless the job failed and the wave's own
 * report (`result`, terragucci-change.js waveResultOf) says the wave did not:
 * terragucci ends the job of a wave that applied what it planned and blocked
 * the rest as a failure (terragucci#1161), so the commit status isn't green
 * while roots are unapplied. Then the box says what the report does, "applied
 * 6, 6 blocked by cluster-a", in its tone (`report`). A wave the report says
 * failed, and a job with no report of its wave, keep the job's status.
 */
export function reportStatus(status, result) {
  if (!status || status.status !== "failure" || !result || resultFailed(result)) return status;
  return { status: result.state === "blocked" ? "blocked" : "done", words: resultWords(result), tone: resultTone(result), report: true, ...(status.run ? { run: status.run } : {}) };
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
export function componentMarks(answer, progress, facets, { runs = null, pin = null, story = null } = {}) {
  const jobs = facets && Array.isArray(facets.jobs) ? facets.jobs : [];
  const rootOf = (c) => (facets && facets.roots && facets.roots[c]) || c;
  // behold#741: blocked roots and each root's own outcome are a story's alone; every other view reads as before.
  const states = rootStates(answer, progress, { story: !!story });
  const stage = states.stage;
  const commit = runsCommit(pin, progress);
  const cards = {};
  // behold#741: a kiosk telling a chapter-carrying scenario (`story`): what landed earlier in the cycle, and what a
  // failure left, carry over to the next pull request's cards (the fix) where its plan says nothing of them.
  const earlier = story && story.earlier instanceof Set ? story.earlier : new Set();
  const lastStates = story && story.lastStates ? story.lastStates : null;
  for (const j of jobs) {
    const root = rootOf(j.component);
    let st = states.roots[root];
    if (story && (!st || st.state === "unchanged" || st.state === "outside")) {
      const last = lastStates && stage !== "apply" ? lastStates[root] : null;
      if (last && (last.state === "failed" || last.state === "blocked")) st = { wave: st ? st.wave : j.wave, state: last.state, tone: last.state === "failed" ? "bad" : "wait", words: last.words || SHORT_WORDS[last.state], facts: [], ...(last.blockedBy ? { blockedBy: last.blockedBy } : {}) };
      else if (earlier.has(root)) st = { wave: st ? st.wave : j.wave, state: "applied-earlier", tone: "ok", words: "applied earlier", facts: [] };
    }
    if (!st) continue;
    const facts = [...st.facts];
    // behold#741: a story's plan says each root's own counts, from the plan report.
    const counts = story && stage === "pull-request" && st.state === "planned" && answer.pull_request.counts ? totalsLine(answer.pull_request.counts[root]) : null;
    if (counts) facts.push(`plans ${counts}`);
    // behold#741: a story's failed root says its error the way chant's cards do: "failed: <its specific part>",
    // a shorter middle form for a narrow card, and the whole error in the tooltip.
    const reason = st.state === "failed" && st.error ? shortReason(st.error) : null;
    cards[j.component] = {
      root,
      wave: j.wave ?? st.wave,
      state: st.state,
      tone: st.tone,
      words: reason ? `failed: ${reason}` : st.words.replace(/^wave \d+ · /, ""),
      ...(reason ? { mid: `failed: ${shortReason(st.error, 16)}`, reason } : {}),
      short: st.cone === "not-planned" ? "not planned" : st.cone === "cone" || st.cone === "full" ? "planned" : SHORT_WORDS[st.state] || st.state,
      facts,
      ...(st.blockedBy ? { blockedBy: st.blockedBy } : {}),
      // Report minor 34: the cone's resources, short lines inside the card's body.
      ...(st.lines ? { lines: st.lines } : {}),
      ...(st.cone ? { cone: st.cone } : {}),
    };
  }
  // behold#741: a wave's header once some of its roots are blocked (terragucci#1161); none for older reports.
  const blocked = story && stage === "apply" ? blockedOf(answer, progress) : new Map();
  const waves = {};
  const waveNumbers = [...new Set(jobs.map((j) => j.wave).filter((n) => typeof n === "number"))].sort((a, b) => a - b);
  for (const n of waveNumbers) {
    const jobName = jobs.find((j) => j.wave === n).jobName;
    const members = jobs.filter((j) => j.wave === n).map((j) => cards[j.component]).filter(Boolean);
    const w = waveState(answer, progress, stage, n);
    // behold#751: a job that failed while its wave's report says the wave applied (and blocked the rest) reads as the report says.
    const status = commit ? reportStatus(waveStatus(jobStatus(runs, commit, jobName), w), waveResultOf(answer, commit, n)) : null;
    // The wave's job ended well and the run view never started a root: the wave applied nothing to it. Say so,
    // never "queued" under a box that says the job succeeded.
    if (stage === "apply" && status && status.status === "success") for (const m of members) settleMember(m, progress, n);
    const facts = [];
    // behold#736: a cone's fact is its root's (each card's first), so the wave's box names whose it is: "cluster-a: 1
    // of 5 blocks, as a cone", "app-01 to app-06 planned in full: empty cone" for a wave of several estates.
    const coneSaid = new Map();
    for (const m of members) if ((m.cone === "cone" || m.cone === "full") && m.facts[0]) coneSaid.set(m.facts[0], [...(coneSaid.get(m.facts[0]) || []), m]);
    for (const [f, ms] of coneSaid) facts.push(ms[0].cone === "full" ? `${rootNames(ms.map((m) => m.root))} ${f}` : `${rootNames(ms.map((m) => m.root))}: ${f}`);
    for (const m of members) for (const f of m.facts) if (!facts.includes(f) && !coneSaid.has(f)) facts.push(f);
    // The plan a waiting wave is approved for first, as it's what the approval
    // names; then, for a wave that failed, the waves before it that stay applied.
    const rank = (f) => (/^approve plan /.test(f) ? 0 : / stays applied$/.test(f) ? 1 : 2);
    facts.sort((a, b) => rank(a) - rank(b));
    // behold#741: "3 applied, 6 blocked by cluster-a", or "blocked by cluster-a" for a wave none of whose roots ran:
    // its job exits 1 for the roots it held, which is no failure of the wave's own.
    const wr = stage === "apply" && progress && Array.isArray(progress.states) ? progress.states.find((x) => x.number === n) : null;
    let header = wr && blocked.size ? blockedHeader(wr.roots || [], blocked, w) : null;
    let headerTone = w === "blocked" ? BLOCKED_TONE : toneOf(w);
    // behold#741: a story's failed wave says how each root came out, as chant's does: "1 failed, 1 applied", the
    // failure's reason first among its facts, shorter forms of it for a narrow box.
    const failedHere = story && w === "failed" ? members.filter((m) => m.state === "failed") : [];
    const factShort = [];
    if (failedHere.length) {
      const applied = members.filter((m) => m.state === "applied").length;
      header = `${failedHere.length} failed${applied ? `, ${applied} applied` : ""}`;
      headerTone = "bad";
      facts.unshift(...failedHere.map((m) => (m.reason ? `${m.root} failed: ${m.reason}` : `${m.root} failed`)));
      const first = failedHere[0];
      if (first.reason) factShort.push(`${first.root} failed: ${shortReason(first.reason, 36)}`, `${first.root} failed`);
    }
    const shown = header ? { status: w === "blocked" ? "blocked" : w === "failed" ? "failed" : "done", words: header, tone: headerTone, ...(status && status.run ? { run: status.run } : {}) } : status;
    waves[n] = {
      number: n,
      job: jobName,
      state: w,
      // A re-run held at its gate (behold#693) tones the box as its title says.
      tone: header ? headerTone : shown && ((shown.held && shown.status === "waiting") || shown.report) ? shown.tone : w ? toneOf(w) : shown ? shown.tone : "idle",
      status: shown,
      title: waveTitle(jobName, shown),
      facts,
      ...(factShort.length ? { factShort } : {}),
    };
  }
  if (!story) return { stage, cards, waves, commit };
  // behold#741: the chant kiosk's look for a chapter-carrying scenario: the wedge, and the bigger card and wave words.
  const needs = rootNeeds(answer, progress, stage, jobs, rootOf);
  const reach = tgReachOf(cards, { stage, answer, needs, earlier });
  return { stage, cards, waves, commit, needs, ...(reach ? { reach } : {}), ...(story.kiosk ? { statusRight: true, cardFont: 15, waveFont: 18 } : {}) };
}

/**
 * A card still `not-started` in a wave whose job succeeded: `unchanged` when
 * the run view's wave says it changed nothing (its totals, or `changed`
 * leaving the root out); else the wave's report isn't read yet, and the card
 * says so ("wave done, reading its report") until the report decides, never
 * that the root was skipped. Changes the card in place; any other card is
 * left as it is.
 */
export function settleMember(card, progress, n) {
  if (!card || card.state !== "not-started") return card;
  const w = progress && Array.isArray(progress.states) ? progress.states.find((x) => x.number === n) : null;
  const moved = w && w.totals ? Object.entries(w.totals).some(([a, k]) => a !== "no-op" && a !== "read" && typeof k === "number" && k > 0) : null;
  const unchanged = (w && Array.isArray(w.changed) && !w.changed.includes(card.root)) || moved === false;
  card.state = unchanged ? "unchanged" : "reading";
  card.tone = "idle";
  card.words = unchanged ? "unchanged" : "wave done, reading its report";
  card.short = unchanged ? "unchanged" : "reading its report";
  card.facts = [unchanged ? "its wave applied no change to it" : "its wave's job ended; its report says what it applied, once read", ...card.facts];
  return card;
}

const toneOf = (state) => ({ planned: "plan", waiting: "wait", applying: "busy", applied: "ok", failed: "bad", refused: "bad" })[state] || "idle";

/**
 * behold#741: each component's upstream components, from the plan report's
 * reads and dependencies while a pull request plans (`upstreams`), and from
 * the run view's reads from the merge on: the edges terragucci layers its
 * waves by (rootOrder).
 */
export function rootNeeds(answer, progress, stage, jobs, rootOf) {
  const compsOf = new Map();
  for (const j of jobs) {
    const r = rootOf(j.component);
    compsOf.set(r, [...(compsOf.get(r) || []), j.component]);
  }
  const ups = {};
  if (stage === "pull-request" && answer && answer.pull_request) {
    const pr = answer.pull_request;
    for (const [root, us] of Object.entries(pr.upstreams || {})) ups[root] = [...us];
    for (const r of pr.reads || []) ups[r.root] = [...new Set([...(ups[r.root] || []), r.upstream])];
  } else if (progress && Array.isArray(progress.reads)) {
    for (const r of progress.reads) ups[r.root] = [...new Set([...(ups[r.root] || []), ...(r.reads || [])])];
  }
  const needs = {};
  for (const [root, us] of Object.entries(ups)) {
    const from = compsOf.get(root) || [root];
    const to = us.flatMap((u) => compsOf.get(u) || [u]);
    for (const c of from) needs[c] = [...new Set([...(needs[c] || []), ...to])].filter((x) => x !== c).sort();
  }
  return needs;
}

/** The components downstream of `roots` along `needs` (a component -> what it needs), within `within` when given. */
function downstreamOf(roots, needs, within = null) {
  const out = new Set();
  const users = {};
  for (const [c, ds] of Object.entries(needs)) for (const d of ds) (users[d] = users[d] || []).push(c);
  const walk = (n) => {
    for (const u of users[n] || []) {
      if (out.has(u) || roots.includes(u) || (within && !within.has(u))) continue;
      out.add(u);
      walk(u);
    }
  };
  for (const r of roots) walk(r);
  return [...out];
}

/**
 * behold#741: what a change reaches, for app.js drawReach, as chant's
 * reachOf (web/chant-pr-marks.js) says it, from terragucci's reports:
 *
 * - once a root failed: the failed root(s), covering the cards they block,
 *   "6 blocked";
 * - while a pull request's plan stands: the changed root(s) (the plan's
 *   blast roots, else the planned roots that read no other planned one) as
 *   the apex, covering the planned roots downstream of them, "reaches 15
 *   roots", or for a later pull request of the cycle "the fix reaches 7";
 * - nothing from the merge on, until a failure.
 */
export function tgReachOf(cards, { stage, answer, needs = {}, earlier = new Set() } = {}) {
  const failed = Object.entries(cards).filter(([, c]) => c.state === "failed").map(([id]) => id);
  if (failed.length && stage === "apply") {
    const failedRoots = new Set(failed.map((id) => cards[id].root));
    const held = new Set(Object.entries(cards).filter(([, c]) => c.state === "blocked" && (!c.blockedBy || failedRoots.has(c.blockedBy))).map(([id]) => id));
    for (const d of downstreamOf(failed, needs)) if (cards[d] && cards[d].state === "blocked") held.add(d);
    if (!held.size) return null;
    const names = [...held].sort();
    return { key: `failed|${failed.sort().join(",")}|${names.length}`, roots: failed, covered: names, tone: "bad", label: `${names.length} blocked` };
  }
  if (stage !== "pull-request" || !answer || !answer.pull_request) return null;
  const members = new Set(Object.entries(cards).filter(([, c]) => c.state === "planned").map(([id]) => id));
  if (!members.size) return null;
  const blast = answer.pull_request.blast && Array.isArray(answer.pull_request.blast.roots) ? new Set(answer.pull_request.blast.roots) : null;
  const changed = blast ? [...members].filter((id) => blast.has(cards[id].root) && !(needs[id] || []).some((d) => members.has(d) && blast.has(cards[d].root))) : [];
  const roots = (changed.length ? changed : [...members].filter((id) => !(needs[id] || []).some((d) => members.has(d)))).sort();
  if (!roots.length) return null;
  const covered = [...new Set([...roots, ...downstreamOf(roots, needs, members)])].sort();
  const fix = earlier.size > 0;
  return { key: `plan|${roots.join(",")}|${covered.length}|${fix ? "fix" : "change"}`, roots, covered, tone: "plan", label: fix ? `the fix reaches ${covered.length}` : `reaches ${covered.length} ${covered.length === 1 ? "root" : "roots"}` };
}

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

