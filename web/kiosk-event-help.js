// behold#571: event-help, the kiosk's "Tips". What happens in a cycle, as
// events: each a short line of context about what just happened, and the
// things on screen it is about (its roots, its wave, its job and its run), so
// the kiosk can place a tip on them, light them together across the panes,
// and keep them in order on the cycle's story trail.
//
// Pure, no DOM, no reads of its own. The kiosk hands it what it already reads
// (demo.json, the pull request's plan, the run view, the pipeline's run, the
// approval panel's rows, the metrics, which jobs have a trace), as one
// snapshot. `cycleFacts(snapshot)` says everything the snapshot shows has
// happened in the cycle so far, in the cycle's order: that is the trail, and
// a viewer who arrives mid-cycle gets it whole. `newEvents(seen, facts)` is
// what happened since the last snapshot: those pop as tips.

import { STRIP, matchingPull, matchingRun } from "./kiosk.js";
import { defaultStep } from "./kiosk-runs.js";
import { traceReadyWords } from "./kiosk-wave-traces.js";

export { EH_STORE, ehStore, ehStored } from "./event-help-store.js";

/** How long a tip stays up before it shrinks toward the trail, and how many show at once. */
export const TIP_MS = 5_000;
export const TIPS_AT_ONCE = 2;

const ACTIONS = { create: "created", update: "updated", replace: "replaced", delete: "deleted", forget: "forgotten", import: "imported", move: "moved" };
const changedWords = (totals) => {
  const parts = Object.entries(ACTIONS)
    .filter(([a]) => totals && typeof totals[a] === "number" && totals[a] > 0)
    .map(([a, w]) => `${totals[a]} ${w}`);
  return parts.length ? parts.join(", ") : null;
};
/** "the plan creates 5 and updates 1", from a plan's totals. */
export function planWords(totals) {
  const verbs = { create: "creates", update: "updates", replace: "replaces", delete: "deletes", forget: "forgets", import: "imports" };
  const parts = Object.entries(verbs).filter(([a]) => totals && totals[a] > 0).map(([a, v]) => `${v} ${totals[a]}`);
  return parts.length ? `the plan ${list(parts)}` : "the plan changes nothing";
}
const list = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * SQL Yodeler's refusal in a failed job's log, as one short line, or null:
 * "SQL Yodeler refused: an email shared by more than one row".
 */
export function yodelRefusal(lines) {
  const text = (lines || []).filter((l) => typeof l === "string");
  if (!text.some((l) => /yodel apply: refused/.test(l))) return null;
  for (const l of text) {
    const m = /would fail: (\d+) values? of \(([^)]+)\) held by more than one row/.exec(l);
    if (m) {
      const n = Number(m[1]);
      const what = n === 1 ? `${/^[aeiou]/i.test(m[2]) ? "an" : "a"} ${m[2]} is` : `${n} ${m[2]} values are`;
      return `SQL Yodeler refused, since ${what} shared by more than one row`;
    }
  }
  return "SQL Yodeler refused the migration before its first statement";
}

/** Every log line of a job, its steps in order. */
const jobLines = (job) => (job && Array.isArray(job.steps) ? job.steps.flatMap((s) => (Array.isArray(s.log) ? s.log : [])) : []);

/**
 * One snapshot of what the kiosk holds, reduced to what events are made of.
 * `waves` is the declared waves (`{ job, wave, roots }`), so a job names its
 * wave and a wave its roots.
 */
export function ehSnapshot({ demo = null, answer = null, progress = null, runDoc = null, runDocs = [], approval = null, metrics = null, waveTraces = {}, waves = [], failed = [], strip = null } = {}) {
  if (!demo) return null;
  const pr = matchingPull(answer, demo) || (answer && !answer.error && answer.pull_request && demo.pull !== null && String(answer.pull_request.run && answer.pull_request.run.pull_request) === String(demo.pull) ? answer.pull_request : null);
  const run = matchingRun(progress, demo);
  const jobs = runDoc && Array.isArray(runDoc.jobs) && (!demo.cycle || runDoc.cycle === undefined || runDoc.cycle === demo.cycle) ? runDoc.jobs : [];
  return {
    cycle: demo.cycle,
    step: demo.step,
    pull: demo.pull,
    label: demo.label || "",
    plan: pr ? { totals: pr.totals || null, roots: pr.roots || [], reads: pr.reads || [] } : null,
    states: run ? progress.states || [] : [],
    run: runDoc ? { id: runDoc.id, jobs: jobs.map((j) => ({ name: j.name, status: j.status, wave: waveOfJob(j.name, waves), refusal: j.status === "failure" ? yodelRefusal(jobLines(j)) : null, step: j.steps ? defaultStep(j.steps) : -1 })) } : null,
    approval: approval && Array.isArray(approval.rows) ? { wave: approval.wave, rows: approval.rows.filter((r) => r.state === "lit").map((r) => ({ id: r.id, at: r.at || null, actor: r.id === "approved" ? actorOf(r.text) : null, signed: !!(r.seal && /^signed/.test(r.seal.text || "")) })) } : null,
    // The numbers of this cycle's merge only: from the merge on, and only for its commit.
    metrics: metrics && metrics.run && metrics.run.current && stepRank(demo.step, strip) >= stepRank("merged", strip) && (!demo.commit || String(metrics.run.label || "").includes(String(demo.commit).slice(0, 8))) ? metrics.run.waves.map((w) => ({ wave: w.wave, words: [w.seconds, w.held ? `held ${w.held}` : null, w.changed].filter(Boolean).join(" · ") })).filter((w) => w.words) : [],
    // Each wave's trace, once Tempo has it (web/kiosk-wave-traces.js): `{ wave, run, job, words }`.
    traces: Object.keys(waveTraces || {}).map(Number).sort((a, b) => a - b).map((w) => ({ wave: w, run: waveTraces[w].run, job: waveTraces[w].job, words: traceReadyWords(w, waveTraces[w].trace) })).filter((t) => t.words),
    waves,
    // The scenario's own step order (kiosk.js stripFromSteps), so the story keeps the order the steps had: chant gates before its merge.
    strip: Array.isArray(strip) && strip.length ? strip : STRIP,
    // The waves this cycle saw fail, kept by the kiosk: a re-run is news only against a failure seen before it.
    failed: [...new Set(failed)],
    // The cycle's earlier runs' failures (the approval panel reads them): a viewer who arrives after the re-run still gets the refusal.
    pastFailures: (runDocs || [])
      .filter((d) => d && d.id !== (runDoc && runDoc.id) && (!demo.cycle || d.cycle === undefined || d.cycle === demo.cycle) && Array.isArray(d.jobs))
      .flatMap((d) => d.jobs.filter((j) => j.status === "failure" && waveOfJob(j.name, waves) !== null).map((j) => ({ wave: waveOfJob(j.name, waves), job: j.name, run: d.id, refusal: yodelRefusal(jobLines(j)) }))),
  };
}

const waveOfJob = (name, waves) => {
  const w = (waves || []).find((x) => x.job === name);
  return w ? w.wave : null;
};
const rootsOfWave = (n, waves, states) => {
  const s = (states || []).find((x) => x.number === n);
  if (s && Array.isArray(s.changed) && s.changed.length) return s.changed;
  const w = (waves || []).find((x) => x.wave === n);
  return w ? w.roots || [] : s ? s.roots || [] : [];
};
/** "demo-reviewer approved exactly this plan." → "demo-reviewer". */
const actorOf = (text) => {
  const m = /^(.+?) approved\b/.exec(text || "");
  return m && m[1] !== "A reviewer" ? m[1] : null;
};

/** The strip's order of a step: 0 for the pull request, up to 5 for the reset; -1 for one the strip doesn't know. */
const stepRank = (step, strip = STRIP) => (strip || STRIP).findIndex((s) => s.steps.includes(step));

/**
 * Everything the snapshot says has happened in its cycle, as facts in the
 * cycle's order. A fact is `{ id, kind, text, subjects: { roots, wave, job, run }, order, trail, critical }`:
 * `id` is stable for the cycle, so a fact seen once is never news again;
 * `trail` says whether the story trail keeps it (a wave starting or a trace
 * landing pops a tip but is not a beat of the story); `critical` is a wave
 * held for an approval, a wave that failed, and the cycle applied.
 */
export function cycleFacts(snap) {
  if (!snap) return [];
  const out = [];
  const add = (f) => out.push({ subjects: { roots: [], wave: null, job: null, run: null }, trail: true, critical: false, ...f, subjects: { roots: [], wave: null, job: null, run: null, ...(f.subjects || {}) } });
  const strip = snap.strip || STRIP;
  const at = stepRank(snap.step, strip);
  const rank = (step) => stepRank(step, strip);
  const c = snap.cycle;
  const runId = snap.run ? snap.run.id : null;
  // The pull request and its plan.
  if (snap.pull !== null && snap.pull !== undefined && at >= 0) add({ id: `${c}|pr`, kind: "pull-request", text: `pull request #${snap.pull} opened`, order: 0, subjects: { roots: snap.plan ? snap.plan.roots : [] } });
  if (snap.plan && snap.plan.totals && at >= rank("planned")) {
    add({ id: `${c}|plan`, kind: "planned", text: planWords(snap.plan.totals), order: 1, subjects: { roots: snap.plan.roots } });
  }
  if (at >= rank("merged") && snap.pull !== null && snap.pull !== undefined) add({ id: `${c}|merged`, kind: "merged", text: `pull request #${snap.pull} merged`, order: 2 });
  // Each wave, from the run view; a wave's job, from the pipeline's run.
  const jobOf = (n) => (snap.run ? snap.run.jobs.find((j) => j.wave === n) : null);
  const approved = snap.approval ? snap.approval.rows.find((r) => r.id === "approved") : null;
  const states = [...snap.states].sort((a, b) => a.number - b.number);
  const failedBefore = new Set([...(snap.failed || []), ...(snap.pastFailures || []).map((f) => f.wave)]);
  for (const s of states) {
    const n = s.number;
    const roots = rootsOfWave(n, snap.waves, states);
    const job = jobOf(n);
    const subjects = { roots, wave: n, job: job ? job.name : null, run: runId };
    const base = 10 + n * 10;
    if (["applying", "waiting", "applied", "failed", "refused"].includes(s.state)) add({ id: `${c}|w${n}|start`, kind: "started", text: `wave ${n} started`, order: base, subjects, trail: false });
    // A failure the run view no longer shows (the re-run moved on) is still the pipeline's run's.
    const failedJob = job && job.status === "failure" ? job : null;
    const past = (snap.pastFailures || []).find((f) => f.wave === n);
    if (s.state === "failed" || s.state === "refused" || failedJob || past) {
      failedBefore.add(n);
      const refusal = (failedJob && failedJob.refusal) || (past && past.refusal);
      add({ id: `${c}|w${n}|failed`, kind: refusal ? "refused" : "failed", text: refusal || `wave ${n} failed`, order: base + 1, subjects: past && !failedJob ? { ...subjects, job: past.job, run: past.run } : subjects, critical: true });
    }
    // The read that holds a wave: a root of it reading a value its upstream only now has.
    const read = snap.plan ? snap.plan.reads.find((r) => roots.includes(r.root) && r.unknown && r.unknown.length) : null;
    const heldText = read ? `wave ${n} held, since ${read.root}'s plan uses ${list(read.unknown)}` : `wave ${n} held for an approval`;
    if (s.state === "waiting") add({ id: `${c}|w${n}|held`, kind: "held", text: heldText, order: base + 3, subjects, critical: true });
    if (snap.approval && snap.approval.wave === n) {
      for (const r of snap.approval.rows) {
        if (r.id === "requested" && s.state !== "waiting") add({ id: `${c}|w${n}|held`, kind: "held", text: heldText, order: base + 3, subjects, critical: true });
        if (r.id === "approved") add({ id: `${c}|w${n}|approved`, kind: "approved", text: r.actor ? `approved by ${r.actor}${r.signed ? ", signed" : ""}` : "approved, signed", order: base + 4, subjects });
        if (r.id === "resumed") add({ id: `${c}|w${n}|resumed`, kind: "resumed", text: "/terragucci apply ran the waves again", order: base + 5, subjects });
      }
    }
    if (failedBefore.has(n) && (s.state === "applying" || s.state === "applied") && !failedJob) add({ id: `${c}|w${n}|rerun`, kind: "rerun", text: `wave ${n} runs again`, order: base + 6, subjects });
    if (s.state === "applied") {
      const changed = changedWords(s.totals);
      const under = approved && snap.approval.wave === n && approved.actor ? ` under ${approved.actor}'s approval` : "";
      add({ id: `${c}|w${n}|applied`, kind: "applied-wave", text: `wave ${n} applied${under || (changed ? `: ${changed}` : "")}`, order: base + 7, subjects });
      // The values a read waited on are known once their upstream applies.
      for (const r of snap.plan ? snap.plan.reads : []) {
        if (!r.unknown || !r.unknown.length || !roots.includes(r.upstream)) continue;
        add({ id: `${c}|known|${r.root}|${r.upstream}`, kind: "known", text: `${list(r.unknown)} now known`, order: base + 8, subjects: { roots: [r.upstream, r.root], wave: n, job: subjects.job, run: runId } });
      }
    }
  }
  // The numbers and the traces, when they land.
  for (const m of snap.metrics) add({ id: `${c}|metrics|${m.wave}`, kind: "metrics", text: `wave ${m.wave}: ${m.words}`, order: 10 + m.wave * 10 + 9, subjects: { roots: rootsOfWave(m.wave, snap.waves, states), wave: m.wave, run: runId }, trail: false });
  // A wave's trace, once Tempo has it: a beat of the story, and a tip that opens it.
  for (const t of snap.traces) add({ id: `${c}|trace|w${t.wave}`, kind: "trace", text: t.words, order: 10 + t.wave * 10 + 9, subjects: { roots: rootsOfWave(t.wave, snap.waves, states), wave: t.wave, job: t.job, run: t.run } });
  // A gate on the whole change (chant's pull-request loop): its approval, no wave named.
  if (snap.approval && !Number.isInteger(snap.approval.wave)) {
    if (snap.approval.rows.some((r) => r.id === "requested" || r.id === "approved")) add({ id: `${c}|held`, kind: "held", text: "the plan waits for an approval", order: 9, critical: true });
    const ok = snap.approval.rows.find((r) => r.id === "approved");
    if (ok) add({ id: `${c}|approved`, kind: "approved", text: ok.actor ? `approved by ${ok.actor}${ok.signed ? ", signed" : ""}` : "approved, signed", order: 9.5 });
  }
  // A gate on the whole change (chant's pull-request loop): the plan waits, no wave named.
  // A repo with declared waves names its held wave once the run view has it; this is for a repo without them.
  if (snap.step === "waiting" && !(snap.waves || []).length && !out.some((f) => f.kind === "held")) add({ id: `${c}|held`, kind: "held", text: "the plan waits for an approval", order: 9, critical: true });
  // The step says the run applied: every wave the run view names, even one a read has not caught up on.
  if (snap.step === "applied") add({ id: `${c}|applied`, kind: "applied", text: !states.length ? "the change applied" : states.length === 1 ? "the wave applied" : `all ${states.length} waves applied`, order: 990, critical: true });
  if (snap.step === "reset") add({ id: `${c}|reset`, kind: "reset", text: "states back on the base", order: 995 });
  // One fact per id (a wave's hold is said by the run view and the approval rows alike).
  const byId = new Map();
  for (const f of out) if (!byId.has(f.id)) byId.set(f.id, f);
  // behold#571 (#631): in the order the scenario's steps went: each fact at its stop of the strip, then in its order within it.
  // An approval before the merge (chant's gate) is its own stop; after it, part of the waves.
  const stopIndex = (id) => {
    const i = strip.findIndex((x) => x.id === id);
    return i >= 0 ? i : strip.findIndex((x) => x.id === "waves");
  };
  const gateStop = strip.some((x) => x.id === "approval") ? "approval" : "waves";
  const stopOf = (f) => (["pull-request", "planned", "merged", "applied", "reset"].includes(f.kind) ? f.kind : f.kind === "pull-request" ? "pull-request" : ["held", "approved", "resumed"].includes(f.kind) && !Number.isInteger(f.subjects.wave) ? gateStop : "waves");
  return [...byId.values()].map((f) => ({ ...f, stop: stopOf(f), order: Math.max(0, stopIndex(stopOf(f))) * 1000 + f.order })).sort((a, b) => a.order - b.order);
}

/** The story trail: the cycle's facts that are beats of its story. */
export function storyTrail(facts) {
  return facts.filter((f) => f.trail);
}

/**
 * What is news: the facts not seen before, in order. The first snapshot of a
 * page (`seen` null) is no news at all: it is the trail so far.
 */
export function newEvents(seen, facts, { after = -Infinity } = {}) {
  if (!seen) return [];
  // A fact that turns up late, behind the story already told (a plan read after the waves began), joins the trail but is no news.
  // A trace and a wave's numbers always land after the wave's next beats: they are news whenever they land.
  const fresh = facts.filter((f) => !seen.has(f.id) && (f.order >= after || f.kind === "trace" || f.kind === "metrics"));
  // A wave's start said alone is news; beside its own next beat, the beat says it.
  return fresh.filter((f) => !(f.kind === "started" && fresh.some((g) => g !== f && g.subjects.wave === f.subjects.wave && g.kind !== "metrics" && g.kind !== "trace")));
}

/** How far behind the newest beat told a late fact may sit and still be news. */
export const LATE_ORDER = 10;

/**
 * The tips queue: at most TIPS_AT_ONCE up, the rest waiting their turn, each
 * up TIP_MS. Pure: `{ shown: [{ event, until }], waiting: [event] }`.
 */
export function tipsQueue(state, { add = [], now = 0, max = TIPS_AT_ONCE, ms = TIP_MS } = {}) {
  const shown = (state ? state.shown : []).filter((s) => s.until > now);
  const waiting = [...(state ? state.waiting : []), ...add].filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i && !shown.some((s) => s.event.id === e.id));
  while (shown.length < max && waiting.length) shown.push({ event: waiting.shift(), until: now + ms });
  return { shown, waiting };
}

/**
 * The critical modals' queue: one at a time, never while a viewer is at the
 * page (a pointer or a key within `quietMs`), and only the newest of each
 * kind, since an old one is already history.
 */
export function modalQueue(state, { add = [], now = 0, lastInput = -Infinity, quietMs = 6_000, open = false } = {}) {
  const waiting = [...(state ? state.waiting : []), ...add.filter((e) => e.critical)];
  const newest = new Map();
  for (const e of waiting) newest.set(e.kind === "refused" ? "failed" : e.kind, e);
  const queue = [...newest.values()];
  if (open || !queue.length || now - lastInput < quietMs) return { next: null, waiting: queue };
  return { next: queue[0], waiting: queue.slice(1) };
}
