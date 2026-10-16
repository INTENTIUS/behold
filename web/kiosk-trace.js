// behold#571: a job's trace as a waterfall, from Tempo through /api/traces
// (src/tempo-traces.ts). The run's jobs on one time line, then the selected
// job: terragucci's stage, its phases (plan, gate, apply, report, upload),
// each root's init, plan and apply, and OpenTofu's own spans under them.
//
// It shows what Tempo holds and nothing else: a job with no trace has no
// Trace view. Deep levels start folded; a click on a row opens or folds it.
// The spans that make up the job's critical path are lit, and so is a wait:
// the gate, or a state lock.
//
// Two ways in, both GET only:
// - `traceSource({ fetchJson })`: the kiosk's job pane asks it, on every
//   redraw, whether a job has a trace (`has`) and draws it (`draw`). It reads
//   a run once per TRACE_POLL_MS and calls `onChange` when an answer lands.
// - `mountTrace(host, { project, run, job })`: the same waterfall as a
//   component of its own, for any layout that wants one job's trace.

/** How often a run's traces are asked for again. The route shares one read of Tempo for 10 s. */
export const TRACE_POLL_MS = 15_000;
/** Rows deeper than this start folded: the stage, its phases and the roots show; the binary's spans wait for a click. */
export const OPEN_DEPTH = 3;
/** Two spans closer than this, in ms, count as touching on the critical path. */
const EPS = 0.5;

/** The URL a run's traces are read at, or null when the run cannot be named. */
export function traceUrl({ repo, run, commit = null }) {
  if (!repo || typeof repo !== "string") return null;
  const q = new URLSearchParams({ project: repo });
  if (run !== null && run !== undefined && /^[1-9][0-9]{0,15}$/.test(String(run))) q.set("run", String(run));
  else if (commit && /^[0-9a-f]{7,64}$/.test(commit)) q.set("commit", commit);
  else return null;
  return `/api/traces?${q}`;
}

/** "70 ms", "6.4 s", "48 s", "2 min 5 s". */
export function msWords(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${Math.round(s * 10) / 10} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  if (m < 60) return r ? `${m} min ${r} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const end = (s) => s.start + s.ms;

/** The spans as a tree: each one's children, earliest first, and the tops (spans whose parent is not in the trace). */
export function spanTree(spans) {
  const ids = new Set(spans.map((s) => s.id));
  const kids = new Map();
  const tops = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.parent && ids.has(s.parent)) {
      if (!kids.has(s.parent)) kids.set(s.parent, []);
      kids.get(s.parent).push(s);
    } else tops.push(s);
  }
  return { kids, tops };
}

/**
 * The job's critical path: from the end of each top span back to its start,
 * the child that ended last before that point, then the one that ended last
 * before it began, and so on down each. A sibling still running when the
 * chosen one began, such as a root that planned beside it and finished
 * sooner, stays off it.
 */
export function criticalPath(spans) {
  const { kids, tops } = spanTree(spans);
  const on = new Set();
  const walk = (s, bound) => {
    on.add(s.id);
    let t = Math.min(end(s), bound);
    const children = [...(kids.get(s.id) || [])].sort((a, b) => end(b) - end(a));
    for (const c of children) {
      // A child still running at the point, or starting after it, is not what the point waited on.
      if (c.start >= t - EPS || end(c) > t + EPS) continue;
      walk(c, t);
      t = resumeAt(c, kids);
    }
  };
  for (const s of tops) walk(s, Infinity);
  return on;
}

/** Whether a span is a wait: the wave's gate, or a state lock. */
export function isWait(s) {
  return s.attrs["terragucci.phase"] === "gate" || !!s.attrs["terragucci.wait"] || s.name === "State lock wait";
}

/**
 * Where the critical path goes on from after `s`: its start, or for a wait
 * that holds work of this job (a gate's check after its hold), the start of
 * that work, so what ran before the check stays on the path.
 */
function resumeAt(s, kids) {
  if (!isWait(s)) return s.start;
  const work = (kids.get(s.id) || []).filter((c) => !isWait(c));
  return work.length ? Math.min(...work.map((c) => c.start)) : s.start;
}

/** A span's label and the words after it. */
export function spanWords(s) {
  const a = s.attrs || {};
  if (a["terragucci.stage"]) {
    const wave = a["terragucci.wave"];
    return { label: `${a["terragucci.stage"]}${wave ? `, wave ${wave}` : ""}`, sub: a["terragucci.result"] ? String(a["terragucci.result"]) : "" };
  }
  if (a["terragucci.phase"] === "gate") {
    const held = a["terragucci.gate.held_seconds"];
    const status = a["terragucci.gate.status"];
    const sub = typeof held === "number" ? `approved after ${msWords(held * 1000)} held` : status === "not-required" ? "no approval needed" : status === "waiting" ? "waits for an approval" : status ? String(status) : "";
    return { label: "gate", sub };
  }
  if (a["terragucci.phase"]) return { label: String(a["terragucci.phase"]), sub: "" };
  if (a["terragucci.wait"] === "approval") return { label: "held", sub: "for an approval" };
  if (s.name === "check" && s.service === "terragucci") return { label: "check", sub: "this job's decision" };
  if (a["terragucci.root"] && s.name.startsWith("root ")) return { label: s.name, sub: a["terragucci.status"] ? String(a["terragucci.status"]) : "" };
  const address = a["opentofu.resource_instance.address"] || a["opentofu.resource.address"];
  if (address) {
    const verb = /^(Plan|Apply|Refresh|Validate|Read)\b/.exec(s.name);
    return { label: String(address), sub: verb ? verb[1].toLowerCase() : s.name };
  }
  if (s.name === "Configure provider" && a["opentofu.provider.source"]) return { label: "Configure provider", sub: String(a["opentofu.provider.source"]).replace(/^registry\.(opentofu|terraform)\.(org|io)\//, "") };
  if (s.name === "tofu" && s.service !== "terragucci") return { label: "OpenTofu", sub: "" };
  if (a["rpc.method"]) return { label: String(a["rpc.method"]), sub: a["opentofu.provider.address"] ? String(a["opentofu.provider.address"]) : "" };
  return { label: s.name, sub: "" };
}

/**
 * The rows a trace draws, top to bottom: each visible span with its depth,
 * its place on the job's time line (0..1), and whether it is on the critical
 * path, a wait or failed. `open` is the set of span ids a viewer opened past
 * OPEN_DEPTH, `shut` the ones they folded above it.
 */
export function waterfallRows(trace, { open = new Set(), shut = new Set() } = {}) {
  const spans = trace.spans || [];
  if (!spans.length) return [];
  const { kids, tops } = spanTree(spans);
  const crit = criticalPath(spans);
  const t0 = Math.min(...spans.map((s) => s.start));
  const span = Math.max(1e-6, Math.max(...spans.map(end)) - t0);
  const rows = [];
  const visit = (s, depth) => {
    const children = kids.get(s.id) || [];
    const isOpen = children.length > 0 && (depth < OPEN_DEPTH ? !shut.has(s.id) : open.has(s.id));
    const words = spanWords(s);
    rows.push({
      id: s.id,
      depth,
      label: words.label,
      sub: words.sub,
      service: s.service,
      ms: s.ms,
      at: (s.start - t0) / span,
      width: s.ms / span,
      critical: crit.has(s.id),
      wait: isWait(s),
      error: s.error || null,
      kids: children.length,
      open: isOpen,
    });
    if (isOpen) for (const c of children) visit(c, depth + 1);
  };
  for (const s of tops) visit(s, 0);
  return rows;
}

/** The run's jobs on one time line: each job's newest trace, 0..1 across the run. */
export function runStrip(traces) {
  const newest = new Map();
  for (const t of traces) if (t.job && (!newest.has(t.job) || newest.get(t.job).start < t.start)) newest.set(t.job, t);
  const list = [...newest.values()].sort((a, b) => a.start - b.start);
  if (!list.length) return [];
  const t0 = Math.min(...list.map((t) => t.start));
  const span = Math.max(1e-6, Math.max(...list.map((t) => t.start + t.ms)) - t0);
  return list.map((t) => ({ job: t.job, wave: t.wave, result: t.result, ms: t.ms, at: (t.start - t0) / span, width: t.ms / span }));
}

const STYLE = `
.t-trace { padding: 0.2em 0 0.6em; font-size: 0.86em; }
.t-tabs { display: flex; gap: 0.3em; padding: 0.5em 1em 0.1em; flex-wrap: wrap; }
.t-tab { font: 600 0.78em var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); background: transparent; border: 1px solid var(--rule); border-radius: 999px; padding: 0.2em 0.8em; cursor: pointer; }
.t-tab[aria-pressed="true"] { color: var(--fg); background: var(--active); border-color: var(--focus); }
.t-sec { font: 600 0.8em var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); padding: 0.6em 1em 0.25em; }
.t-strip, .t-rows { display: flex; flex-direction: column; }
.t-row { display: grid; grid-template-columns: minmax(10em, 38%) minmax(0, 1fr) 4.6em; align-items: center; gap: 0.6em; padding: 0.08em 1em; min-height: 1.55em; cursor: default; }
.t-row:nth-child(odd) { background: var(--zebra-row); }
.t-row.t-can { cursor: pointer; }
.t-row.t-can:hover, .t-row.t-sel { background: var(--active); }
.t-name { display: flex; gap: 0.35em; align-items: baseline; min-width: 0; padding-left: calc(var(--d, 0) * 0.85em); }
.t-caret { color: var(--muted); width: 0.8em; flex: none; font-size: 0.85em; }
.t-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); flex: 0 1 auto; min-width: 2.5em; }
.t-name .t-sub { flex: 0 100 auto; }
.t-sub { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 0.9em; }
.t-track { position: relative; height: 0.8em; border-radius: 3px; background: color-mix(in srgb, var(--rule) 45%, transparent); }
.t-bar { position: absolute; top: 0; bottom: 0; min-width: 2px; border-radius: 3px; background: color-mix(in srgb, var(--muted) 75%, transparent); }
.t-bin .t-bar { background: color-mix(in srgb, var(--managed) 70%, transparent); }
.t-crit .t-bar { background: var(--runtime); box-shadow: 0 0 0 1px color-mix(in srgb, var(--runtime) 55%, transparent); }
.t-wait .t-bar { background: repeating-linear-gradient(135deg, var(--foreign) 0 4px, color-mix(in srgb, var(--foreign) 45%, transparent) 4px 8px); }
.t-err .t-bar { background: var(--degraded); }
.t-ms { color: var(--muted); text-align: right; font: 0.9em var(--font-mono); white-space: nowrap; }
.t-crit .t-ms, .t-wait .t-ms { color: var(--fg); }
.t-key { display: flex; flex-wrap: wrap; gap: 0.3em 1.1em; padding: 0.5em 1em 0; color: var(--muted); font-size: 0.85em; }
.t-key span { display: inline-flex; align-items: center; gap: 0.35em; }
.t-sw { display: inline-block; width: 1.4em; height: 0.6em; border-radius: 2px; }
.t-sw.t-c { background: var(--runtime); }
.t-sw.t-w { background: repeating-linear-gradient(135deg, var(--foreign) 0 4px, color-mix(in srgb, var(--foreign) 45%, transparent) 4px 8px); }
.t-sw.t-b { background: color-mix(in srgb, var(--managed) 70%, transparent); }
.t-note { color: var(--muted); padding: 0.3em 1em; font-size: 0.9em; }
@media (max-width: 600px) {
  .t-row { grid-template-columns: minmax(0, 1fr) 4.2em; grid-template-areas: "name ms" "track track"; row-gap: 0.15em; padding: 0.25em 0.8em; }
  .t-name { grid-area: name; }
  .t-ms { grid-area: ms; }
  .t-track { grid-area: track; margin-left: calc(var(--d, 0) * 0.85em); }
}
`;

const el = (doc, tag, cls, text) => {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};

/** Put the waterfall's style on the page once. */
export function traceStyle(doc = document) {
  if (!doc.head || doc.getElementById("t-trace-style")) return;
  const style = el(doc, "style");
  style.id = "t-trace-style";
  style.textContent = STYLE;
  doc.head.appendChild(style);
}

function bar(doc, at, width) {
  const track = el(doc, "div", "t-track");
  const b = el(doc, "div", "t-bar");
  b.style.left = `${Math.min(100, Math.max(0, at * 100))}%`;
  b.style.width = `${Math.min(100 - at * 100, Math.max(0, width * 100))}%`;
  track.appendChild(b);
  return track;
}

/**
 * Draw one job's trace into `host`: the run's jobs on a strip (when `run`
 * holds more than this job), the job's waterfall, and its key. `ui` holds
 * the viewer's folds (`open`, `shut`, sets of span ids) and calls `toggle(id)`
 * and `pickJob(name)`.
 */
export function renderTrace(host, { traces, run = [], job }, { doc = document, toggle = () => {}, pickJob = null, open = new Set(), shut = new Set() } = {}) {
  traceStyle(doc);
  const box = el(doc, "div", "t-trace");
  const strip = runStrip(run);
  if (strip.length > 1) {
    box.appendChild(el(doc, "div", "t-sec", "The run's jobs"));
    const rows = el(doc, "div", "t-strip");
    for (const r of strip) {
      const row = el(doc, "div", `t-row${pickJob ? " t-can" : ""}${r.job === job ? " t-sel" : ""}${r.result === "failed" ? " t-err" : r.result === "waiting" ? " t-wait" : ""}`);
      const name = el(doc, "div", "t-name");
      name.append(el(doc, "span", "t-label", r.job), el(doc, "span", "t-sub", r.result || ""));
      row.append(name, bar(doc, r.at, r.width), el(doc, "div", "t-ms", msWords(r.ms)));
      if (pickJob) row.addEventListener("click", () => pickJob(r.job));
      rows.appendChild(row);
    }
    box.appendChild(rows);
  }
  traces.forEach((t, i) => {
    const when = new Date(t.start);
    const head = traces.length > 1 ? `Attempt ${i + 1} of ${traces.length}, ${when.toISOString().slice(11, 19)} UTC` : `This job, ${msWords(t.ms)}`;
    box.appendChild(el(doc, "div", "t-sec", head));
    const rows = el(doc, "div", "t-rows");
    for (const r of waterfallRows(t, { open, shut })) {
      const cls = ["t-row", r.kids ? "t-can" : "", r.service !== "terragucci" ? "t-bin" : "", r.critical ? "t-crit" : "", r.wait ? "t-wait" : "", r.error ? "t-err" : ""].filter(Boolean).join(" ");
      const row = el(doc, "div", cls);
      row.style.setProperty("--d", String(r.depth));
      const name = el(doc, "div", "t-name");
      name.append(el(doc, "span", "t-caret", r.kids ? (r.open ? "▾" : "▸") : ""), el(doc, "span", "t-label", r.label));
      if (r.sub) name.appendChild(el(doc, "span", "t-sub", r.sub));
      row.title = [r.label, r.sub, msWords(r.ms), r.critical ? "on the critical path" : "", r.error ? `error: ${r.error}` : "", r.kids && !r.open ? `${r.kids} spans inside` : ""].filter(Boolean).join(" · ");
      row.append(name, bar(doc, r.at, r.width), el(doc, "div", "t-ms", msWords(r.ms)));
      if (r.kids) row.addEventListener("click", () => toggle(r.id, r.depth));
      rows.appendChild(row);
    }
    box.appendChild(rows);
    if (t.left_out) box.appendChild(el(doc, "div", "t-note", `${t.left_out} of the deepest spans stay in Tempo; this view keeps the run's shape.`));
  });
  const key = el(doc, "div", "t-key");
  const sw = (c, words) => {
    const k = el(doc, "span");
    k.append(el(doc, "i", `t-sw ${c}`), words);
    return k;
  };
  key.append(sw("t-c", "critical path"), sw("t-w", "a wait at the gate or for a state lock"), sw("t-b", "OpenTofu's own spans"));
  box.appendChild(key);
  host.appendChild(box);
  return box;
}

/** The viewer's folds: a click on a row opens it or folds it, whatever its depth. */
export function foldState() {
  const open = new Set();
  const shut = new Set();
  return {
    open,
    shut,
    toggle(id, depth) {
      if (depth < OPEN_DEPTH) {
        if (shut.has(id)) shut.delete(id);
        else shut.add(id);
      } else if (open.has(id)) open.delete(id);
      else open.add(id);
    },
  };
}

/**
 * The kiosk's reader of runs' traces. `has(repo, run, job)` and
 * `traces(repo, run, job)` answer from what it read, and ask again when the
 * run's answer is older than TRACE_POLL_MS; `onChange` runs when an answer
 * lands. One answer per run, shared by its jobs.
 */
export function traceSource({ fetchJson, onChange = () => {}, now = () => Date.now() }) {
  const runs = new Map();
  const folds = foldState();
  const read = (repo, run) => {
    const url = traceUrl({ repo, run });
    if (!url) return null;
    let r = runs.get(url);
    const t = now();
    if (!r || (!r.pending && t - r.at >= TRACE_POLL_MS)) {
      r = r || { at: t, answer: null, pending: null };
      r.at = t;
      r.pending = Promise.resolve(fetchJson(url)).then(
        (a) => {
          r.pending = null;
          const before = JSON.stringify(r.answer && r.answer.jobs);
          const ok = a && !a.error && Array.isArray(a.traces);
          if (ok) r.answer = a;
          if (ok && (before !== JSON.stringify(a.jobs) || (r.answer && r.answer.traces.length))) onChange();
        },
        () => {
          r.pending = null;
        },
      );
      runs.set(url, r);
      // Old runs age off.
      for (const [k, v] of runs) if (t - v.at > 10 * TRACE_POLL_MS) runs.delete(k);
    }
    return r.answer;
  };
  const of = (repo, run, job) => {
    const a = read(repo, run);
    return a ? a.traces.filter((t) => t.job === job) : [];
  };
  return {
    folds,
    has: (repo, run, job) => of(repo, run, job).length > 0,
    traces: of,
    all: (repo, run) => (read(repo, run) || { traces: [] }).traces,
    draw(host, { repo, run, job, pickJob = null, doc = document }) {
      return renderTrace(host, { traces: of(repo, run, job), run: this.all(repo, run), job }, { doc, pickJob, open: folds.open, shut: folds.shut, toggle: (id, depth) => { folds.toggle(id, depth); onChange(); } });
    },
  };
}

/**
 * One job's waterfall as a component: it reads the run's traces, draws the
 * job's, and keeps the viewer's folds across its own redraws. `update` points
 * it at another job; `stop` ends its reads. With no trace for the job it
 * draws nothing.
 */
export function mountTrace(host, { project, run, job, fetchJson = defaultFetch, doc = document, setTimer = setInterval, clearTimer = clearInterval, pickJob = null } = {}) {
  let target = { project, run, job };
  const draw = () => {
    host.replaceChildren();
    if (!source.has(target.project, target.run, target.job)) return;
    source.draw(host, { repo: target.project, run: target.run, job: target.job, pickJob, doc });
  };
  const source = traceSource({ fetchJson, onChange: draw });
  draw();
  const timer = setTimer(draw, TRACE_POLL_MS);
  return {
    update(next) {
      target = { ...target, ...next };
      draw();
    },
    stop() {
      clearTimer(timer);
    },
  };
}

async function defaultFetch(url) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return { error: `${url} answered ${r.status}` };
    return await r.json();
  } catch (e) {
    return { error: String(e) };
  }
}
