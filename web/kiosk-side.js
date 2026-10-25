// The Watch side pane of the prompt demo: a column at the right of the graph, above the prompt pane, on a wide
// screen. At its top the act's run as a trace (the steps with their timings: the plan, the approval, the apply, and
// each estate's part of the apply), drawn with the rows Inspect's trace box uses; under it one small card about what
// the terminal's current line names (the boxes its `ask.light` and `ask.paths` light): the resource, its before and
// after, and which estate's record was written. It says nothing the terminal does not: it shows the run's facts.
//
// The models are pure (data in, data out, tested next door); renderSide draws them. web/kiosk.js wires it.

import { applyOf, cardLines, cardTitle, lineState, planOf, selectLight, stateMarks, stateWords } from "./kiosk-light.js";
import { msShort } from "./kiosk-wave-traces.js";

/** Where a viewer's choice to fold the pane is kept, in their own browser. */
export const SIDE_STORE = "behold.kiosk.side";

/** Phones (up to this width) keep the graph and the prompt only. */
export const SIDE_PHONE = "(max-width: 700px)";

/** Whether the pane is open: open unless this viewer folded it. A storage that throws counts as open. */
export function sideStored(store) {
  try {
    return !(store && store.getItem(SIDE_STORE) === "closed");
  } catch {
    return true;
  }
}

/** Keep the viewer's choice; a storage that throws keeps it for this visit only. */
export function keepSide(store, open) {
  try {
    if (store) store.setItem(SIDE_STORE, open ? "open" : "closed");
  } catch {
    /* private mode: the choice lasts this visit */
  }
}

/**
 * How the pane shows: "open", "folded" (a tab at the right edge), or "none". Only in Watch with the prompt pane up
 * (ask mode), and never on a phone.
 */
export function sideState({ ask, phone, open }) {
  if (!ask || phone) return "none";
  return open ? "open" : "folded";
}

const ms = (v) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const lastSegment = (path) => String(path || "").split("/").filter(Boolean).pop() || String(path || "");

/** A job's or a step's tone: done, running, waiting, failed, or skipped. */
export function jobTone(status) {
  if (status === "success" || status === "applied" || status === "approved") return "done";
  if (status === "running" || status === "applying") return "running";
  if (status === "failure" || status === "failed" || status === "cancelled" || status === "partial") return "failed";
  if (status === "waiting" || status === "queued" || status === "blocked") return "waiting";
  return "skipped";
}

/**
 * The step the trace is drawn at: the terminal's current turn (`turn`, `{ scenario, step }` from the prompt pane's
 * events), on the cycle its scenario was last seen on (`cycles`, scenario to cycle), since the terminal plays its
 * steps in turn and may be behind demo.json (`demo`). demo.json's step when no turn has played, or the turn's
 * scenario was never seen.
 */
export function sideStep(demo, turn, cycles) {
  if (!turn || !cycles || !cycles.has(turn.scenario)) return demo || null;
  const cycle = cycles.get(turn.scenario);
  if (demo && demo.cycle === cycle) return { ...demo, step: turn.step };
  return { ...(demo || {}), cycle, scenario: turn.scenario, step: turn.step };
}

const APPROVED_STEPS = new Set(["approved", "merged", "applying", "waiting", "resumed", "applied", "failed", "reset"]);

/** A pipeline job's place in the trace: "plan", "approval", "apply" (with its wave, for an apply-wave-N job), or null for the bookkeeping jobs. */
export function jobKind(name) {
  const n = String(name || "");
  if (n === "plan" || n === "replan") return { kind: "plan", label: n === "replan" ? "re-plan" : "plan" };
  if (n === "approval") return { kind: "approval" };
  const w = /^apply-wave-(\d+)$/.exec(n);
  if (w) return { kind: "apply", wave: Number(w[1]) };
  if (n === "apply") return { kind: "apply", wave: null };
  return null;
}

/**
 * The act's run as trace rows, in the order they ran: `{ rows, from, to }`. Each row is `{ key, label, tone, at, end,
 * ms, depth }`, times in epoch ms (`end` null while it runs), `depth` 1 for an estate's part of the apply. The rows,
 * from the jobs of the act's runs (the bookkeeping jobs, checks, notes and tips, left out):
 * - the plan (and a re-plan);
 * - the approval: the wait from the plan's end to the approval (its job's end, else the first apply's run), or to now
 *   while the step still waits on it;
 * - the apply: one row per apply job, named for the estates its wave applies when the run view says (else "wave N"),
 *   and, for a single apply job, each estate's part of it from the run view (no time of its own: the run view states
 *   each part's outcome, not when it ran).
 * `runs` is the runs index (web/kiosk-runs.js), `demo` the step, `answer` and `progress` the kiosk's terragucci reads.
 */
export function runTrace(runs, demo, { answer = null, progress = null, now = Date.now() } = {}) {
  if (!demo || !Number.isInteger(demo.cycle)) return { rows: [], from: null, to: null };
  const mine = (Array.isArray(runs) ? runs : [])
    .filter((r) => r && r.cycle === demo.cycle)
    .sort((a, b) => (ms(a.created_at) || 0) - (ms(b.created_at) || 0) || (a.id || 0) - (b.id || 0));
  const jobs = [];
  for (const run of mine) {
    for (const j of run.jobs || []) {
      const k = jobKind(j.name);
      const at = ms(j.started_at);
      if (!k || (at === null && jobTone(j.status) === "skipped")) continue;
      jobs.push({ run, job: j, ...k, at, end: ms(j.ended_at), created: ms(run.created_at) });
    }
  }
  const row = (x, label) => ({ key: `${x.run.id}/${x.job.id ?? x.job.name}`, label, tone: jobTone(x.job.status), at: x.at, end: x.end, ms: x.at !== null ? (x.end ?? now) - x.at : null, depth: 0, run: x.run.id });
  const rows = [];
  const plans = jobs.filter((x) => x.kind === "plan");
  for (const x of plans) rows.push(row(x, x.label));
  const applies = jobs.filter((x) => x.kind === "apply");
  const planEnd = plans.length ? plans[plans.length - 1].end : null;
  if (planEnd !== null) {
    const job = jobs.find((x) => x.kind === "approval" && x.end !== null);
    const firstApply = applies.length ? applies[0].created ?? applies[0].at : null;
    const done = job ? job.end : firstApply;
    const approved = done !== null || APPROVED_STEPS.has(demo.step);
    rows.push({ key: "approval", label: "approval", tone: approved ? "done" : "waiting", at: planEnd, end: done, ms: done !== null ? Math.max(0, done - planEnd) : approved ? null : Math.max(0, now - planEnd), depth: 0 });
  }
  const waveRoots = new Map();
  for (const w of (progress && Array.isArray(progress.states) ? progress.states : [])) {
    const roots = w.composed && Array.isArray(w.composed.members) ? w.composed.members.map((m) => m.root) : Array.isArray(w.roots) ? w.roots : [];
    if (Number.isInteger(w.number) && roots.length) waveRoots.set(w.number, roots.map(lastSegment).join(", "));
  }
  for (const x of applies) {
    const label = x.wave === null ? "apply" : waveRoots.get(x.wave) || `wave ${x.wave}`;
    const r = row(x, label);
    rows.push(r);
    if (applies.length === 1) for (const part of applyParts(answer, progress)) rows.push({ ...part, key: `${r.key}/${part.root}`, at: r.at, end: r.end, ms: null, depth: 1 });
  }
  const times = rows.flatMap((r) => [r.at, r.end]).filter((t) => t !== null);
  const from = times.length ? Math.min(...times) : null;
  const to = rows.some((r) => r.at !== null && r.end === null) ? now : times.length ? Math.max(...times) : null;
  return { rows, from, to: to !== null && from !== null && to <= from ? from + 1 : to };
}

const PART_WORDS = { applied: "applied", "no-changes": "applied", partial: "partly applied", failed: "partly applied", "not-started": "not applied" };

/** Each estate's part of the apply, from the run view: `{ root, label, tone, words }`, in the plan's order. */
export function applyParts(answer, progress) {
  const plan = planOf(answer, progress);
  const roots = plan.roots.length ? plan.roots.map((r) => r.path) : progress && Array.isArray(progress.reads) ? progress.reads.map((r) => r.root) : [];
  const out = [];
  for (const root of roots) {
    const a = applyOf(root, progress);
    if (!a) continue;
    const words = a.apply ? PART_WORDS[a.apply] || a.apply : a.waveState === "applying" || a.waveState === "running" ? "applying" : "waiting";
    const tone = a.apply ? jobTone(a.apply === "no-changes" ? "applied" : a.apply === "not-started" ? "skipped" : a.apply) : jobTone(words);
    out.push({ root, label: lastSegment(root), tone, words });
  }
  return out;
}

/**
 * The card about the terminal's current line: what its `ask.light` names (and `ask.paths` reaches), from the plan.
 * `{ items, estates }` or null when the line names nothing the plan has. Each item is `{ key, name, type, action,
 * estate, lines }`, `lines` the attribute lines the graph's card shows (`{ state, text }`: the before and after, or
 * the value known after apply); each estate is `{ name, words }`, its records written or not. At most `max` items.
 */
export function detailsModel(answer, progress, ask, { max = 3 } = {}) {
  if (!ask || !answer || answer.error) return null;
  const plan = planOf(answer, progress);
  const sel = selectLight(plan, ask);
  if (!sel) return null;
  const light = Array.isArray(ask.light) ? ask.light : [];
  const lines = cardLines(plan, light);
  const items = sel.lit.slice(0, max).map((key) => {
    const res = plan.resources.get(key);
    const t = cardTitle(res.address);
    return {
      key,
      name: t.name,
      type: t.type,
      action: res.action || null,
      estate: lastSegment(res.root),
      lines: lines.filter((l) => l.key === key).map((l) => lineState(l, answer, progress)),
    };
  });
  const marks = stateMarks(answer, progress);
  const estates = sel.roots.map((root) => {
    const m = marks[root];
    return { name: lastSegment(root), words: m ? stateWords(m) || null : null, written: !!(m && m.written) };
  });
  return { items, more: Math.max(0, sel.lit.length - items.length), estates };
}

// ---------------------------------------------------------------------------
// The DOM.

const el = (doc, tag, cls, text) => {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};

/** The head over the trace and the card. */
export const SIDE_WORDS = { run: "This act's run", details: "On this line", fold: "Hide", unfold: "Run details" };

/**
 * Draw the pane into `host`: the trace (`trace`, from runTrace) as rows of Inspect's trace box (`.k-wf`), then
 * `traces(node)` (the waves' Tempo traces, as Inspect draws them, when it has them), then the card (`details`). The
 * DOM is drawn again only when what it shows changes (`key`).
 */
export function renderSide(host, { trace, details }, { doc = typeof document !== "undefined" ? document : null, traces = null, onFold = null } = {}) {
  if (!host || !doc) return;
  const key = JSON.stringify([trace.rows.map((r) => [r.key, r.tone, r.words, r.ms === null ? null : Math.floor(r.ms / 1000)]), details]);
  if (host.dataset && host.dataset.key === key) return;
  if (host.dataset) host.dataset.key = key;
  host.replaceChildren();
  const head = el(doc, "div", "k-side-head");
  head.appendChild(el(doc, "h2", "k-side-title", SIDE_WORDS.run));
  if (onFold) {
    const fold = el(doc, "button", "k-side-fold", SIDE_WORDS.fold);
    fold.type = "button";
    fold.setAttribute("aria-label", "Hide the run details");
    fold.addEventListener("click", onFold);
    head.appendChild(fold);
  }
  host.appendChild(head);
  const wf = el(doc, "div", "k-wf k-side-wf");
  const span = trace.from !== null && trace.to !== null ? trace.to - trace.from : 0;
  for (const r of trace.rows) {
    const row = el(doc, "div", `k-wf-row k-wf-plain k-side-row k-tone-${r.tone}${r.depth ? " k-side-part" : ""}`);
    row.appendChild(el(doc, "span", "k-wf-wave", r.label));
    const track = el(doc, "span", "k-wf-track");
    if (r.depth) track.appendChild(el(doc, "span", "k-side-words", r.words));
    else if (r.at !== null && span > 0) {
      const seg = el(doc, "span", `k-wf-seg k-side-seg k-tone-${r.tone}`);
      const a = (r.at - trace.from) / span;
      const b = ((r.end ?? trace.to) - trace.from) / span;
      seg.style.left = `${(a * 100).toFixed(2)}%`;
      seg.style.width = `${Math.max(0.5, (b - a) * 100).toFixed(2)}%`;
      track.appendChild(seg);
    }
    row.appendChild(track);
    row.appendChild(el(doc, "span", "k-wf-words", r.depth ? "" : r.ms !== null ? msShort(r.ms) : ""));
    wf.appendChild(row);
  }
  if (!trace.rows.length) wf.appendChild(el(doc, "p", "k-side-quiet", "No run yet in this act."));
  host.appendChild(wf);
  if (traces) {
    const t = el(doc, "section", "k-i-traces k-side-traces");
    traces(t);
    if (!t.hidden) host.appendChild(t);
  }
  if (details && (details.items.length || details.estates.length)) {
    const card = el(doc, "section", "k-side-card");
    card.appendChild(el(doc, "h2", "k-side-title", SIDE_WORDS.details));
    for (const it of details.items) {
      const item = el(doc, "div", "k-side-item");
      const name = el(doc, "p", "k-side-name");
      name.appendChild(el(doc, "b", null, it.name));
      name.appendChild(el(doc, "span", "k-side-type", [it.type, it.action, it.estate].filter(Boolean).join(" · ")));
      item.appendChild(name);
      for (const l of it.lines) item.appendChild(el(doc, "p", `k-side-line k-line-${l.state}`, l.text));
      card.appendChild(item);
    }
    if (details.more) card.appendChild(el(doc, "p", "k-side-quiet", `and ${details.more} more`));
    for (const e of details.estates) {
      const p = el(doc, "p", `k-side-estate${e.written ? " k-side-written" : ""}`);
      p.appendChild(el(doc, "b", null, e.name));
      if (e.words) p.appendChild(el(doc, "span", "k-side-type", e.words));
      card.appendChild(p);
    }
    host.appendChild(card);
  }
}
