// behold#571: the kiosk's Watch mode, its default. The Components graph is
// the stage, and the rest rides on it: the narration is a caption along the
// bottom, the approval a callout on the held wave's box, the running job's
// log a drawer from the active wave's box, the pipeline metrics a badge on
// each wave's box, and the delivery numbers one line in the header. With
// each step the kiosk moves the graph to what the step is about (a "shot":
// web/kiosk-shot.js does the camera). Inspect is the dense layout, one click
// away, and a viewer's choice of the two is kept in their browser.
//
// This module decides what each piece says and where it goes. It reads only
// what the kiosk already holds (demo.json, the reports, the run view, the
// runs, the metrics model); web/kiosk.js draws it.

import { STEP_WORDS, focusRoots, matchingPull, matchingRun, scenarioHead, introText, aboutRows, nextWords, demoStage } from "./kiosk.js";
import { defaultJob, defaultStep, logLineWords, setupLine } from "./kiosk-runs.js";

/** The two modes, Watch first: it is the default. */
export const MODES = [
  { id: "watch", words: "Watch", shows: "the graph, moved to each step as it happens" },
  { id: "inspect", words: "Inspect", shows: "the runs and their logs beside the graph" },
];

/** Where a viewer's mode is kept, in their own browser. */
export const MODE_STORE = "behold.kiosk.mode";

/** The viewer's mode: "watch" unless they picked Inspect. */
export function modeStored(store) {
  try {
    return store && store.getItem(MODE_STORE) === "inspect" ? "inspect" : "watch";
  } catch {
    return "watch";
  }
}

/** The tone a step's chip takes, by the same colours the strip and the wave boxes use. */
export function stepTone(step) {
  if (step === "waiting") return "wait";
  if (step === "failed" || step === "stalled") return "bad";
  if (step === "applied") return "ok";
  if (step === "reset") return "idle";
  return "busy";
}

/**
 * The wave the run is on: from the run view, the wave applying, else failed
 * or refused, else the first that has not applied. Before the run view has
 * this cycle's run, the wave whose job is running, waiting or failed in the
 * pipeline's run (`runDoc`, its jobs named as `waves` names them). Null when
 * neither says.
 */
export function activeWave(demo, progress, { runDoc = null, waves = [] } = {}) {
  const run = demo ? matchingRun(progress, demo) : null;
  if (run) {
    const states = progress.states || [];
    for (const want of ["applying", "failed", "refused"]) {
      const w = states.find((x) => x.state === want);
      if (w) return w.number;
    }
    const next = states.find((x) => x.state !== "applied" && x.state !== "skipped");
    if (next) return next.number;
  }
  const jobs = runDoc && Array.isArray(runDoc.jobs) ? runDoc.jobs : [];
  for (const status of ["running", "waiting", "failure"]) {
    const job = jobs.find((j) => j.status === status && waves.some((w) => w.job === j.name));
    if (job) return waves.find((w) => w.job === job.name).wave;
  }
  return null;
}

/**
 * The roots a pull request's shot frames: the roots it changes, and each
 * root a read joins to them, so the reads' lines are in the picture.
 */
export function changeRoots(demo, answer, progress) {
  const roots = focusRoots(demo, answer, progress) || [];
  const pr = matchingPull(answer, demo);
  const reads = pr && Array.isArray(pr.reads) ? pr.reads : [];
  const out = new Set(roots);
  for (const r of reads) if (out.has(r.root) || out.has(r.upstream)) [r.root, r.upstream].filter(Boolean).forEach((x) => out.add(x));
  return [...out];
}

/**
 * The shot for a step: what the graph frames and which overlay leads.
 * `{ id, kind, roots, waves, whole }`, `kind` one of:
 *
 * - "change" (pull request, planned): the changing roots and the reads;
 * - "held" (waiting, approved): the held wave, with the approval callout; the whole graph for a gate on the whole change (`gate`);
 * - "active" (applying, running again, failed): the wave the run is on, its log drawer open;
 * - "result" (applied): the whole graph, its badges and the result card;
 * - "intro" (reset, the base): the whole graph, with the demo's intro;
 * - "whole": the whole graph (merged, stalled, and a step with nothing to frame yet).
 *
 * `id` changes only when the frame should move.
 */
export function shotFor(demo, { answer = null, progress = null, held = null, gate = false, runDoc = null, waves = [] } = {}) {
  if (!demo) return { id: "none", kind: "whole", roots: [], waves: [], whole: true };
  const base = `${demo.cycle}|${demo.step}`;
  const whole = (kind) => ({ id: `${base}|${kind}`, kind, roots: [], waves: [], whole: true });
  if (demo.step === "reset" || demoStage(demo) === "none") return whole("intro");
  if (demo.step === "applied") return whole("result");
  if (demo.step === "pull-request" || demo.step === "planned") {
    const roots = changeRoots(demo, answer, progress);
    return roots.length ? { id: `${base}|change|${roots.join(",")}`, kind: "change", roots, waves: [], whole: false } : whole("change");
  }
  if ((demo.step === "waiting" || demo.step === "approved") && Number.isInteger(held)) return { id: `${base}|held|${held}`, kind: "held", roots: [], waves: [held], whole: false };
  // A gate on the whole change (chant's pull-request gate, one approval for every wave): the whole graph, with the callout.
  if ((demo.step === "waiting" || demo.step === "approved") && gate) return { id: `${base}|held|all`, kind: "held", roots: [], waves: [], whole: true };
  if (["applying", "resumed", "failed", "waiting", "approved"].includes(demo.step)) {
    const n = activeWave(demo, progress, { runDoc, waves });
    if (Number.isInteger(n)) return { id: `${base}|active|${n}`, kind: "active", roots: [], waves: [n], whole: false };
  }
  return whole("whole");
}

/**
 * The caption along the bottom: the scenario's title, what changes, and the
 * step. `lead` says which line leads: "changes" before the merge, when the
 * change is what to read, else "step". Between scenarios, the intro.
 */
export function captionModel(demo, { vendor = null, now = new Date() } = {}) {
  if (!demo) return null;
  const head = scenarioHead(demo, { vendor });
  const rows = aboutRows(demo);
  const changes = rows.find((r) => r.label === "What changes") || null;
  const intro = demo.step === "reset" ? introText(demo) : null;
  const nx = nextWords(demo, now);
  return {
    kicker: head.kicker,
    title: head.title || "",
    lead: demo.step === "pull-request" || demo.step === "planned" ? "changes" : "step",
    changes: intro ? null : changes ? { label: changes.label, text: changes.text } : null,
    intro: intro ? { label: "What this demo is about", text: intro } : null,
    step: { word: STEP_WORDS[demo.step] || demo.step, text: demo.label || "", tone: stepTone(demo.step), id: demo.step },
    next: nx.action ? { action: nx.action, when: nx.when } : null,
  };
}

/** "1.6 s · held 25 s · 4 created": one wave's numbers from the metrics model's wave, or null when it has none. */
export function badgeWords(wave) {
  if (!wave) return null;
  const parts = [wave.seconds, wave.held ? `held ${wave.held}` : null, wave.changed].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** The badge's words with what they are, for the callout's and the drawer's heads and a badge's tooltip. */
export function badgeTitle(words) {
  return words ? `Pipeline metrics · ${words}` : null;
}

/** Each wave's badge, by wave number, from the metrics model; only for this cycle's run, never an older one. */
export function badges(metrics) {
  const run = metrics && metrics.run;
  if (!run || !run.current) return {};
  const out = {};
  for (const w of run.waves) {
    const words = badgeWords(w);
    if (words) out[w.wave] = words;
  }
  return out;
}

/** "19,489 deploys a week · lead time 1 min 56 s · change failure rate 1% · time to restore 1 min 12 s", or null. */
export function doraLine(metrics) {
  const rows = metrics && metrics.dora;
  if (!rows || !rows.length) return null;
  const say = {
    Deploys: (v) => `${roundedWeek(v)} deploys a week`,
    "Lead time": (v) => `lead time ${v}`,
    "Change failure rate": (v) => `change failure rate ${v}`,
    "Time to restore": (v) => `time to restore ${v}`,
  };
  return rows.map(([label, v]) => (say[label] ? say[label](v) : `${label.toLowerCase()} ${v}`)).join(" · ");
}

/** "19488.7 a week" as "19,489"; a small rate keeps its tenth ("4.5"). */
function roundedWeek(v) {
  const n = Number(String(v).replace(/ a week$/, ""));
  if (!Number.isFinite(n)) return String(v).replace(/ a week$/, "");
  return n >= 100 ? Math.round(n).toLocaleString("en-US") : String(Math.round(n * 10) / 10);
}

/**
 * The result card, the applied shot's focal point: the result line (the
 * step's own words), the counts (the waves that applied and what they
 * changed, from the run view the graph draws; the job time and the hold, from
 * the metrics when they cover every wave), and each wave's numbers as its
 * badge has them. Null without this cycle's run.
 */
export function resultModel(demo, metrics, progress = null) {
  if (!demo || demo.step !== "applied") return null;
  const run = matchingRun(progress, demo);
  // The step says the run applied: every wave the run view names counts, even one a read has not caught up on yet.
  const all = run ? progress.states || [] : [];
  const states = all.filter((w) => w.state === "applied");
  const m = metrics && metrics.run && metrics.run.current ? metrics.run.waves : [];
  const n = all.length || m.length;
  if (!n) return null;
  const counts = [`${n} ${n === 1 ? "wave" : "waves"} applied`];
  const changed = states.length ? mergeChanges(states.map((w) => w.totals)) : mergeChanges(m.map((w) => w.changesRaw));
  counts.push(changed || "nothing to change");
  // The metrics cover the run when they have a number for each wave that applied.
  if (m.length >= n) {
    const secs = m.reduce((a, w) => a + (Number.isFinite(w.secondsRaw) ? w.secondsRaw : 0), 0);
    if (secs > 0) counts.push(`${secondsShort(secs)} of job time`);
    const held = m.reduce((a, w) => a + (Number.isFinite(w.heldRaw) ? w.heldRaw : 0), 0);
    if (held > 0) counts.push(`${secondsShort(held)} held for an approval`);
  }
  // A row for every wave, its numbers when they have landed; never fewer rows than the count says.
  const numbers = new Map(m.map((w) => [w.wave, badgeWords(w)]));
  const numbered = [...new Set([...all.map((w) => w.number), ...m.map((w) => w.wave)])].sort((a, b) => a - b);
  const waves = numbered.map((w) => ({ wave: w, words: numbers.get(w) || null }));
  return { head: "Applied", line: typeof demo.label === "string" ? demo.label : "", counts, waves };
}

/**
 * behold#571: the run view as the cycle has seen it, for the result card and
 * the trail. Reads land one by one and a read can lag behind the last: within
 * one cycle's commit, a wave once read as applied stays applied, a wave a
 * read leaves out keeps what it was, and the run stays the last one that
 * matched. `{ memo, progress }`; pass the memo back in with the next read.
 */
export function steadyRun(memo, progress, demo) {
  const key = demo ? `${demo.cycle}|${demo.commit}` : null;
  const run = demo ? matchingRun(progress, demo) : null;
  const was = memo && memo.key === key ? memo : { key, run: null, states: {} };
  const next = { key, run: run || was.run, states: { ...was.states } };
  if (run) {
    for (const st of progress.states || []) {
      const had = next.states[st.number];
      if (had && had.state === "applied" && st.state !== "applied") continue;
      // A re-run's run view says nothing changed for a wave an earlier run applied: the change stays the one that landed.
      if (had && had.state === "applied" && st.state === "applied" && changeCount(had.totals) > 0 && changeCount(st.totals) === 0) continue;
      next.states[st.number] = st;
    }
  }
  const states = Object.values(next.states).sort((a, b) => a.number - b.number);
  if (!next.run || !states.length) return { memo: next, progress };
  return { memo: next, progress: { ...(run ? progress : {}), reads: run ? progress.reads || [] : [], run: next.run, states } };
}

const changeCount = (totals) => ACTION_ORDER.reduce((a, k) => a + (totals && typeof totals[k] === "number" ? totals[k] : 0), 0);

/** behold#571: whether a run view is behind the step: the step says applied, and a wave in it still says otherwise. */
export function behindStep(demo, progress) {
  if (!demo || demo.step !== "applied") return false;
  const run = matchingRun(progress, demo);
  return !!run && (progress.states || []).some((w) => w.state !== "applied");
}

const ACTION_ORDER = ["create", "update", "delete", "replace", "forget", "import", "move"];
const ACTION_WORDS = { create: "created", update: "updated", delete: "deleted", replace: "replaced", forget: "forgotten", import: "imported", move: "moved" };
function mergeChanges(list) {
  const sum = {};
  for (const c of list) for (const [a, n] of Object.entries(c || {})) if (a in ACTION_WORDS && typeof n === "number" && n > 0) sum[a] = (sum[a] || 0) + n;
  const parts = ACTION_ORDER.filter((a) => sum[a]).map((a) => `${sum[a]} ${ACTION_WORDS[a]}`);
  return parts.length ? parts.join(", ") : null;
}
function secondsShort(secs) {
  if (secs < 10) return `${Math.round(secs * 10) / 10} s`;
  if (secs < 60) return `${Math.round(secs)} s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs - m * 60);
  return s ? `${m} min ${s} s` : `${m} min`;
}

/**
 * The drawer's folded lines: the job the run is on and the last lines its
 * step wrote, as the jobs pane would show them. `{ job, step, status, lines }`
 * or null without a run read.
 */
export function tailLines(runDoc, n = 2) {
  if (!runDoc || !Array.isArray(runDoc.jobs) || !runDoc.jobs.length) return null;
  const job = defaultJob(runDoc.jobs);
  if (!job) return null;
  const steps = job.steps || [];
  const i = defaultStep(steps);
  const step = i >= 0 ? steps[i] : null;
  // Node's own warnings (a deprecation, and its hint) are the runtime's, not the job's.
  const runtime = (l) => /^\s*\((node:\d+|Use `node )/.test(l);
  const said = (step && Array.isArray(step.log) ? step.log : []).filter((l) => typeof l === "string" && l.trim() && !setupLine(l) && !runtime(l));
  const lines = said.slice(-n).map((l) => logLineWords(job.status, l).text);
  return { job: job.name, step: step ? step.name : null, status: job.status, lines };
}

/**
 * Where an overlay of `size` goes beside `box` inside `view` (all pixels,
 * `{x, y, w, h}`): to the right of the box when it fits, else to its left,
 * else under it; its top level with the box's, kept inside the view. On the
 * right it moves past any of `avoid` (the reads' labels) it would cover.
 * `{ x, y, side }`, `side` "right", "left" or "below".
 */
export function placeBeside(box, size, view, gap = 18, avoid = []) {
  const top = Math.max(view.y + 8, Math.min(box.y, view.y + view.h - size.h - 8));
  // Clear of the graph's own labels beside the box: past the right edge of any it would cover.
  const over = (x) => avoid.filter((a) => a.x < x + size.w && a.x + a.w > x && a.y < top + size.h && a.y + a.h > top);
  let right = box.x + box.w + gap;
  for (let i = 0; i < 4 && over(right).length; i++) right = Math.max(...over(right).map((a) => a.x + a.w)) + gap / 2;
  if (right + size.w <= view.x + view.w - 8) return { x: right, y: top, side: "right" };
  if (box.x - gap - size.w >= view.x + 8) return { x: box.x - gap - size.w, y: top, side: "left" };
  const x = Math.max(view.x + 8, Math.min(box.x, view.x + view.w - size.w - 8));
  return { x, y: Math.min(box.y + box.h + gap, view.y + view.h - size.h - 8), side: "below" };
}

// ---------------------------------------------------------------------------
// A quiet step: during a long step (a wave planning four roots, live-mv about
// to start) nothing new may arrive for a minute or more, and the stage holds
// still. After QUIET_MS with no new record, one quiet line in the caption
// says what is running and for how long, from demo.json's step and the run's
// running job and step. Never over a replay, and never while the kiosk can't
// read from behold: the stopped-updating cue (web/kiosk-link.js) says that.

/** How long with no new record before the quiet line shows. */
export const QUIET_MS = 10_000;

/** The driver's steps that have something running behind them. A held step (waiting, failed), the end and the reset have their own words. */
export const QUIET_STEPS = ["pull-request", "planned", "merged", "applying", "approved", "resumed"];

/** "8 s", "1 m 05 s", "1 h 02 m". */
export function quietDuration(secs) {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} m`;
}

/** The first sentence of the driver's label, without its full stop. */
export function firstSentence(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;
  const m = /^(.+?[^.\s])\.(?:\s|$)/.exec(t);
  return m ? m[1] : t;
}

/** The job and step running in a run's view, `{ job, step, at }` (`at` the step's start, else the job's, in ms), or null when none runs. */
export function runningStep(runDoc) {
  if (!runDoc || !Array.isArray(runDoc.jobs)) return null;
  const job = runDoc.jobs.find((j) => j && j.status === "running");
  if (!job) return null;
  const step = (job.steps || []).find((x) => x && x.status === "running") || null;
  const at = Date.parse((step && step.started_at) || job.started_at || "");
  return { job: job.name, step: step ? step.name : null, at: Number.isFinite(at) ? at : null };
}

/**
 * What counts as a new record for the quiet line: the driver's step, its
 * label and its next action; each job's and step's status in the run's view;
 * the newest progress line. A log line growing inside a step is not one: the
 * stage does not show it.
 */
export function recordKey(demo, runDoc, lastWriteAt = null) {
  const d = demo ? [demo.step, demo.label, demo.next ? demo.next.action : "", demo.next ? demo.next.from || "" : ""].join("|") : "";
  const jobs = runDoc && Array.isArray(runDoc.jobs) ? runDoc.jobs.map((j) => `${j.name}:${j.status}:${(j.steps || []).map((x) => x.status).join(",")}`).join(";") : "";
  return `${d}#${runDoc ? runDoc.id : ""}#${jobs}#${lastWriteAt ?? ""}`;
}

/**
 * The quiet line, `{ text, title, since }`, or null when it should not show.
 * `lastRecordAt`: when the kiosk last saw a new record (ms); `run`:
 * {@link runningStep}; `stepAt`: when the kiosk first saw this step, for a
 * driver that writes no `next.from`. It shows only after QUIET_MS with no new
 * record, on a step with something running, with no countdown of the
 * driver's own still to run, and never on a replay or while the link is
 * stale. The time is how long the driver's step has run.
 */
export function quietWords(demo, { now = Date.now(), lastRecordAt = null, run = null, stepAt = null, replay = false, stale = false } = {}) {
  if (replay || stale || !demo || !QUIET_STEPS.includes(demo.step)) return null;
  if (typeof lastRecordAt !== "number" || now - lastRecordAt <= QUIET_MS) return null;
  const next = demo.next || null;
  // A timed hold (the driver merges in 20 s) has its own countdown on the next line.
  const due = next && next.at ? Date.parse(next.at) : NaN;
  if (Number.isFinite(due) && due > now) return null;
  const said = firstSentence(demo.label) || (next && next.action ? `Waiting for ${next.action}` : null);
  const ran = run && run.job ? `${run.job}${run.step ? `: ${run.step}` : ""}` : null;
  const what = [said, ran].filter(Boolean).join(" · ");
  if (!what) return null;
  const from = next && next.from ? Date.parse(next.from) : NaN;
  const since = Number.isFinite(from) ? from : typeof stepAt === "number" ? stepAt : run && run.at !== null ? run.at : lastRecordAt;
  const text = `${what} · ${quietDuration((now - since) / 1000)} so far`;
  const title = `Nothing new has come in for ${quietDuration((now - lastRecordAt) / 1000)}. ${demo.label || what}${ran ? ` (running: ${ran})` : ""}`;
  return { text, title, since };
}
