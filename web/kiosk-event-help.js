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
import { COMPOSED_WORDS, composedRun } from "./kiosk-light.js";
import { resultBlocked, resultFailed, resultWords, waveResultOf } from "./terragucci-change.js";

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
export function ehSnapshot({ demo = null, answer = null, progress = null, runDoc = null, runDocs = [], approval = null, metrics = null, waveTraces = {}, waves = [], failed = [], strip = null, chant = false } = {}) {
  if (!demo) return null;
  const pr = matchingPull(answer, demo) || (answer && !answer.error && answer.pull_request && demo.pull !== null && String(answer.pull_request.run && answer.pull_request.run.pull_request) === String(demo.pull) ? answer.pull_request : null);
  const run = matchingRun(progress, demo);
  const jobs = runDoc && Array.isArray(runDoc.jobs) && (!demo.cycle || runDoc.cycle === undefined || runDoc.cycle === demo.cycle) ? runDoc.jobs : [];
  // behold#751: a wave's result by its own report, of the commit the run applied: its job's status is no witness to it,
  // since terragucci fails the job of a wave that applied what it planned and blocked the rest (terragucci#1161).
  const resultOf = (commit, name, started) => {
    const n = waveOfJob(name, waves);
    return n === null ? null : waveResultOf(answer, commit, n, { after: started || null });
  };
  // The cycle's earlier runs' wave jobs that ended as failures, each with its report's word on the wave when there is one.
  const pastJobs = (runDocs || [])
    .filter((d) => d && d.id !== (runDoc && runDoc.id) && (!demo.cycle || d.cycle === undefined || d.cycle === demo.cycle) && Array.isArray(d.jobs))
    .flatMap((d) => d.jobs.filter((j) => j.status === "failure" && waveOfJob(j.name, waves) !== null).map((j) => ({ wave: waveOfJob(j.name, waves), job: j.name, run: d.id, refusal: yodelRefusal(jobLines(j)), result: resultOf(d.commit, j.name, j.started_at) })));
  return {
    cycle: demo.cycle,
    // behold#631: a chant repo's pull-request loop: a cycle may hold a fix's pull request after the first, each told as its own run of beats.
    chant: !!chant,
    // A scenario told in beats (the terralith: stock, adopt, split, team, cross) runs each beat's steps in one cycle.
    beat: demo.beat || null,
    step: demo.step,
    pull: demo.pull,
    label: demo.label || "",
    plan: pr ? { totals: pr.totals || null, roots: pr.roots || [], reads: pr.reads || [] } : null,
    // behold#751: each wave with its report's result, of the run view's commit.
    // One composed apply across estates: its text never counts or names waves.
    composed: composedRun(answer, run ? progress : null),
    states: run ? (progress.states || []).map((s) => ({ ...s, result: waveResultOf(answer, run.commit, s.number) })) : [],
    run: runDoc ? { id: runDoc.id, jobs: jobs.map((j) => ({ name: j.name, status: j.status, wave: waveOfJob(j.name, waves), refusal: j.status === "failure" ? yodelRefusal(jobLines(j)) : null, step: j.steps ? defaultStep(j.steps) : -1, result: resultOf(runDoc.commit, j.name, j.started_at) })) } : null,
    approval: approval && Array.isArray(approval.rows) ? { wave: approval.wave, rows: approval.rows.filter((r) => r.state === "lit").map((r) => ({ id: r.id, at: r.at || null, actor: r.id === "approved" ? actorOf(r.text) : null, signed: !!(r.seal && /^signed/.test(r.seal.text || "")) })), ...(Array.isArray(approval.chantWaves) ? { chantWaves: approval.chantWaves } : {}) } : null,
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
    // behold#751: a failed job whose wave's report says it applied and blocked roots is no failure of the wave: it is `pastBlocked`.
    pastFailures: pastJobs.filter((f) => !f.result || resultFailed(f.result)).map(({ result, ...f }) => f),
    pastBlocked: pastJobs.filter((f) => f.result && !resultFailed(f.result) && resultBlocked(f.result)),
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
/** The story a snapshot belongs to: its cycle, and its beat when the scenario is told in beats. */
export function storyKey(snap) {
  if (!snap) return null;
  return snap.beat ? `${snap.cycle}:${snap.beat}` : snap.cycle;
}

export function cycleFacts(snap) {
  if (!snap) return [];
  const out = [];
  const add = (f) => out.push({ subjects: { roots: [], wave: null, job: null, run: null }, trail: true, critical: false, ...f, subjects: { roots: [], wave: null, job: null, run: null, ...(f.subjects || {}) } });
  const strip = snap.strip || STRIP;
  const at = stepRank(snap.step, strip);
  const rank = (step) => stepRank(step, strip);
  // Each beat of a cycle is a story of its own: the adopt beat's "applied" is not the split's.
  // A chant cycle's second pull request (the fix) is its own run of beats: its ids and its place follow the pull request.
  const c = snap.chant && snap.pull !== null && snap.pull !== undefined ? `${storyKey(snap)}|pr${snap.pull}` : storyKey(snap);
  const runId = snap.run ? snap.run.id : null;
  // The pull request and its plan.
  if (snap.pull !== null && snap.pull !== undefined && at >= 0) add({ id: `${c}|pr`, kind: "pull-request", text: `pull request #${snap.pull} opened`, order: 0, subjects: { roots: snap.plan ? snap.plan.roots : [] } });
  if (snap.plan && snap.plan.totals && at >= rank("planned")) {
    add({ id: `${c}|plan`, kind: "planned", text: planWords(snap.plan.totals), order: 1, subjects: { roots: snap.plan.roots } });
  }
  // chant's gate comes before its merge: there the merge is said only once its step is reached.
  const merged = snap.chant ? ["merged", "applying", "failed", "resumed", "applied"].includes(snap.step) : at >= rank("merged");
  if (merged && snap.pull !== null && snap.pull !== undefined) add({ id: `${c}|merged`, kind: "merged", text: `pull request #${snap.pull} merged`, order: 2 });
  // Each wave, from the run view; a wave's job, from the pipeline's run.
  const jobOf = (n) => (snap.run ? snap.run.jobs.find((j) => j.wave === n) : null);
  const approved = snap.approval ? snap.approval.rows.find((r) => r.id === "approved") : null;
  const states = [...snap.states].sort((a, b) => a.number - b.number);
  // behold#751: a wave an earlier run left roots of blocked runs again, as a failed one does.
  const failedBefore = new Set([...(snap.failed || []), ...(snap.pastFailures || []).map((f) => f.wave), ...(snap.pastBlocked || []).map((f) => f.wave)]);
  for (const s of states) {
    const n = s.number;
    const roots = rootsOfWave(n, snap.waves, states);
    const job = jobOf(n);
    const subjects = { roots, wave: n, job: job ? job.name : null, run: runId };
    const base = 10 + n * 10;
    if (["applying", "waiting", "applied", "failed", "refused"].includes(s.state)) add({ id: `${c}|w${n}|start`, kind: "started", text: `wave ${n} started`, order: base, subjects, trail: false });
    // A failure the run view no longer shows (the re-run moved on) is still the pipeline's run's.
    // behold#751: unless the wave's report says otherwise: a wave that applied what it planned and blocked the rest ends its
    // job as a failure (terragucci#1161), and is no failed wave. The job's status speaks only where no report of the wave does.
    const failedJob = job && job.status === "failure" && !(job.result && !resultFailed(job.result)) ? job : null;
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
    // behold#751: what the wave's report says it held back, once the run view settles it, or an earlier run of the cycle did:
    // "wave 3 applied 6, 6 blocked by cluster-a", "wave 3: 6 blocked by cluster-a" for one that ran nothing.
    const nowHeld = ["applied", "blocked"].includes(s.state) ? [s.result, job && job.result].find((r) => r && !resultFailed(r) && resultBlocked(r)) : null;
    const pastHeld = (snap.pastBlocked || []).find((f) => f.wave === n);
    const held = nowHeld || (pastHeld && pastHeld.result);
    if (held) {
      const words = resultWords(held);
      add({ id: `${c}|w${n}|blocked`, kind: "blocked", text: held.state === "applied" ? `wave ${n} ${words}` : `wave ${n}: ${words}`, order: base + 7, subjects: pastHeld && !(job && job.status === "failure") ? { ...subjects, job: pastHeld.job, run: pastHeld.run } : subjects });
    }
    if (s.state === "applied" && !nowHeld) {
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
    // A chant kiosk names the reviewer alone: "forgejo@forgejo:3000:demo-reviewer, signed" is a principal, not a person.
    if (ok) add({ id: `${c}|approved`, kind: "approved", text: snap.chant ? (ok.actor ? `approved by ${ok.actor.replace(/^.*:/, "")}` : "approved") : ok.actor ? `approved by ${ok.actor}${ok.signed ? ", signed" : ""}` : "approved, signed", order: 9.5 });
  }
  // behold#631: chant's pull-request apply, wave by wave from its run events: started, failed with the reason, applied, and what it left blocked.
  for (const w of snap.approval && Array.isArray(snap.approval.chantWaves) ? snap.approval.chantWaves : []) {
    const n = w.wave;
    const base = 10 + n * 10;
    const subjects = { roots: w.components || [], wave: n, run: runId };
    if (["running", "applied", "failed"].includes(w.state)) add({ id: `${c}|w${n}|start`, kind: "started", text: `wave ${n} started`, order: base, subjects, trail: false });
    // The cards of this wave and the next: what a failure's modal must leave in view (the half that went ahead too).
    const next = snap.approval.chantWaves.find((x) => x.wave === n + 1);
    const inView = [...(w.components || []), ...(next ? next.components || [] : [])];
    for (const f of w.failed || []) {
      // The step's label says why in words ("cluster-a failed: SQS refuses …"); CloudFormation's own words stay in the tooltip.
      const said = typeof snap.label === "string" && snap.label.startsWith(`${f.component} failed:`) ? snap.label.split(/\.\s/)[0].replace(/\.$/, "") : null;
      // The raw error rides along for a tooltip; the roots are the failed card and what it blocked.
      add({ id: `${c}|w${n}|failed|${f.component}`, kind: "failed", text: said || `${f.component} failed`, order: base + 1, subjects: { ...subjects, roots: [f.component, ...(f.blocks || [])] }, critical: true, chant: true, avoid: [...new Set([f.component, ...(f.blocks || []), ...inView])], ...(f.error ? { raw: `${f.component} failed: ${f.error}` } : {}) });
    }
    if (w.state === "applied" || (w.state === "failed" && w.applied)) {
      // A wave with a failure says both halves, by name when there are few: "wave 2: cluster-b applied, cluster-a failed".
      const failedNames = (w.failed || []).map((f) => f.component);
      const appliedNames = w.appliedNames || [];
      const both = appliedNames.length && appliedNames.length <= 2 && failedNames.length <= 2 ? `wave ${n}: ${list(appliedNames)} applied, ${list(failedNames)} failed` : `wave ${n}: ${w.applied} applied, ${failedNames.length} failed`;
      add({ id: `${c}|w${n}|applied`, kind: "applied-wave", text: w.state === "failed" ? both : w.blocked ? `wave ${n} applied ${w.applied}; ${w.blocked} blocked` : `wave ${n} applied`, order: base + 7, subjects });
    }
    if (w.blocked) {
      const by = w.blockedBy && w.blockedBy.length ? ` by ${list(w.blockedBy)}` : "";
      add({ id: `${c}|w${n}|blocked`, kind: "blocked", text: `${w.blocked} in wave ${n} blocked${by}: they did not run`, order: base + 8, subjects });
    }
  }
  // A gate on the whole change (chant's pull-request loop): the plan waits, no wave named.
  // A repo with declared waves names its held wave once the run view has it; this is for a repo without them.
  if (snap.step === "waiting" && !(snap.waves || []).length && !out.some((f) => f.kind === "held")) add({ id: `${c}|held`, kind: "held", text: "the plan waits for an approval", order: 9, critical: true });
  // The step says the run applied: every wave the run view names, even one a read has not caught up on.
  if (snap.step === "applied") add({ id: `${c}|applied`, kind: "applied", text: !states.length ? "the change applied" : snap.composed ? COMPOSED_WORDS : states.length === 1 ? "the wave applied" : `all ${states.length} waves applied`, order: 990, critical: true });
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
  // chant's gate comes before the merge: without its own stop it sits with the plan, not after the merge.
  const gateStop = strip.some((x) => x.id === "approval") ? "approval" : snap.chant ? "planned" : "waves";
  const stopOf = (f) => (["pull-request", "planned", "merged", "applied", "reset"].includes(f.kind) ? f.kind : f.kind === "pull-request" ? "pull-request" : ["held", "approved", "resumed"].includes(f.kind) && !Number.isInteger(f.subjects.wave) ? gateStop : "waves");
  // A chant cycle's pull requests in turn: each one's beats after the one before's, whatever their stops.
  const segment = snap.chant && Number.isInteger(snap.pull) ? snap.pull * 100_000 : 0;
  return [...byId.values()]
    .map((f) => ({ ...f, stop: stopOf(f), order: segment + Math.max(0, stopIndex(stopOf(f))) * 1000 + f.order, ...(snap.chant ? { pull: snap.pull } : {}) }))
    .sort((a, b) => a.order - b.order);
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
 * Whether the caption already says what a critical modal would, so the modal
 * stays shut: on a held small stage in Watch (`held`) nothing overlays the
 * graph (web/kiosk-watch.js watchOverlays), and the caption says each step
 * (the applied counts, a held wave's approval, a failure's label).
 * behold#782: in Watch the applied step has its result card (`result`) and
 * the caption's "Applied", so its modal would say it a third time. Any other
 * stage, and Inspect, open them as they always have.
 */
export function modalShownElsewhere(event, { watch = false, held = false, result = false } = {}) {
  if (!watch || !event) return false;
  return !!held || (event.kind === "applied" && !!result);
}

/** Whether Tips' bubbles show: everywhere but a held small stage in Watch, where nothing overlays the graph; the trail over the caption stays. */
export function tipsShown({ watch = false, held = false } = {}) {
  return !(watch && held);
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

// ---------------------------------------------------------------------------
// behold#757: a step's highlight. The scenario's driver says what is special
// about a step (demo.json's or demo-step/v1's `highlight: { title, body }`,
// terragucci#1176, chant#4106) on the step where it happens; Watch opens it as
// a modal once per cycle, step and title. The driver writes a step more than
// once (an apply, its holds) with the same highlight, which opens once; a step
// can gain one partway through (choudoufu's operator, on one write of the
// applying step), which opens when it first appears; and a replay that loops
// round to its step opens it again.

/** How long a highlight stays up, longer than a tip: it is a paragraph to read. It goes sooner when its step does. */
export const HIGHLIGHT_MS = 12_000;

/** A demo step's highlight, `{ title, body }`, or null unless both are non-empty strings (the server's floor, again). */
export function stepHighlight(demo) {
  const h = demo && demo.highlight;
  if (!h || typeof h !== "object" || Array.isArray(h)) return null;
  const title = typeof h.title === "string" ? h.title.trim() : "";
  const body = typeof h.body === "string" ? h.body.trim() : "";
  return title && body ? { title, body } : null;
}

/** The step a highlight's modal stays with: its cycle, beat, pull request and step. It closes when the step moves on. */
export function highlightStepKey(demo) {
  if (!demo) return null;
  return [demo.cycle, demo.beat || "", demo.pull === null || demo.pull === undefined ? "" : demo.pull, demo.step].join("|");
}

/** What a highlight opens once for: its cycle (and beat), its step and its title (terragucci#1176). */
export const highlightId = (demo, h) => [demo.cycle, demo.beat || "", demo.step, h.title].join("|");

/** When a step was written: a replay's step its `at`, a live one its `started_at`. A time that goes back is a replay looping round. */
const writtenAt = (demo) => {
  const t = Date.parse((demo && (demo.at || demo.started_at)) || "");
  return Number.isFinite(t) ? t : null;
};

/**
 * The highlight's state after a look at `demo`: `{ step, seen, at, pending }`.
 * `pending` is the step's highlight while it has not opened (`{ id, key,
 * title, body }`), to open once nothing stops it; `seen` the ids opened this
 * pass of the cycle, so a highlight written again is not opened again. A step
 * that goes takes a pending highlight with it; a replay looping round (its
 * step's time going back) starts a new pass.
 */
export function highlightTurn(state, demo) {
  const at = writtenAt(demo);
  const looped = !!state && state.at !== null && at !== null && at < state.at;
  const seen = !state || looped ? new Set() : state.seen;
  const step = highlightStepKey(demo);
  const h = stepHighlight(demo);
  const id = h ? highlightId(demo, h) : null;
  const kept = state && !looped && state.pending && state.pending.id === id && state.step === step ? state.pending : null;
  const pending = h && !seen.has(id) ? kept || { id, key: step, ...h } : null;
  if (state && !looped && state.step === step && state.pending === pending && state.at === at) return state;
  return { step, seen, at, pending };
}

/** The state once its pending highlight has opened: seen for the rest of the pass. */
export function highlightShown(state) {
  if (!state || !state.pending) return state;
  return { ...state, seen: new Set([...state.seen, state.pending.id]), pending: null };
}

/**
 * Whether a pending highlight opens now: Tips on, in Watch, not on a held
 * small stage (nothing overlays the graph there), and no modal up but a
 * "Waiting on…" one, which it replaces. A critical modal up keeps it waiting.
 */
export function highlightOpens({ pending = null, on = true, watch = false, held = false, modal = null, pop = null } = {}) {
  // behold#764: nor over the card's details popover a viewer has open (`pop`): it waits until that closes.
  return !!pending && !!on && !!watch && !held && !pop && (!modal || modal === "waiting");
}

// ---------------------------------------------------------------------------
// behold#764: a story modal a viewer closes stays closed. "Waiting on the
// pipeline…" came straight back on the next look after its ×: the tick opens
// one whenever a wait is up and no modal is. A close by the viewer (×, Escape,
// a click on the sheet) is kept for what the modal was about: its kind, the
// cycle (and beat), the pull request, the step, and its own key (the wait's
// chapter, segment and what it waits on; a fact's id; a highlight's id). A new
// wait (a later step, a new pull request, a new cycle) opens again. Kept for
// the visit in sessionStorage, so a reload does not bring it back either; a
// replay that loops round to its start forgets them, as it does a highlight.
// A step's highlight is kept here once it has opened, so it is once per
// cycle, step and title across a reload too.

/** Where the visit's closed modals are kept (sessionStorage). */
export const DISMISS_STORE = "behold.eventHelp.closed";
/** At most this many are kept: the newest. */
export const DISMISS_MAX = 64;

/** What a story modal is about, as one key: kind, cycle, beat, pull request, step and its own key. */
export function dismissKey(kind, demo, key) {
  const d = demo || {};
  return [kind, d.cycle ?? "", d.beat || "", d.pull ?? "", d.step || "", key ?? ""].join("|");
}

/** When a step was written, in ms (a replay's `at`, a live step's `started_at`), or null. */
export const stepWrittenAt = (demo) => writtenAt(demo);

/**
 * The visit's closed modals: `{ has(key), add(key), clear(), keys() }`, kept
 * in `store` (sessionStorage) where it lets them be, in memory where it
 * throws or is missing. Never localStorage: a closed modal is this visit's.
 */
export function createDismissals(store = null) {
  let keys = [];
  try {
    const raw = store ? JSON.parse(store.getItem(DISMISS_STORE) || "[]") : [];
    if (Array.isArray(raw)) keys = raw.filter((k) => typeof k === "string").slice(-DISMISS_MAX);
  } catch {
    keys = [];
  }
  const save = () => {
    try {
      if (store) store.setItem(DISMISS_STORE, JSON.stringify(keys));
    } catch {
      /* kept for this page only */
    }
  };
  return {
    has: (key) => keys.includes(key),
    add(key) {
      if (keys.includes(key)) return;
      keys = [...keys, key].slice(-DISMISS_MAX);
      save();
    },
    clear() {
      if (!keys.length) return;
      keys = [];
      save();
    },
    keys: () => [...keys],
  };
}

/**
 * behold#764: whether the "Waiting on…" modal opens now: a wait is up, Tips
 * on, no other modal up or due, the wait not just closed by news (`held`),
 * no details popover open (`pop`), and the viewer has not closed this wait.
 */
export function waitingOpens({ waiting = null, on = true, held = false, modal = null, due = false, pop = null, closed = false } = {}) {
  return !!waiting && !!on && !held && !modal && !due && !pop && !closed;
}
