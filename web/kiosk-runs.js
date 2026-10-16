// #569: the kiosk's pipeline runs, laid out the way a CI page lays them out:
// a sidebar of recent runs (the live one pinned on top), the selected run's
// jobs in the order their `needs` give, each job's steps, and the step that
// matters expanded with its log, following it while it runs.
//
// The runs are the demo repo's real pipeline runs, which the loop driver
// copies from its forge into the reports bucket (`demo.runs/v1`,
// `demo.run/v1`); behold serves them at /api/terragucci/runs(/:id). All GET.
//
// A job held at a terragucci gate is `waiting`: it waits for an approval, and
// is never drawn as a failure. Step names are shown as the driver wrote them.

import { rootColour, rootPaint, rootSegments, rootText, rootsOfWave, waveOfJob } from "./kiosk-roots.js";
import { TOUR, chipWords, docsUrl, jobMarks, runFeatures } from "./kiosk-annotations.js";
import { iconSvg } from "./forge-mark.js";
import { TOOLS, jobTools } from "./tool-mark.js";
import { traceSource, traceStyle } from "./kiosk-trace.js";

/** The run, job and step statuses, as a viewer reads them. */
export const STATUS_WORDS = {
  queued: "queued",
  running: "running",
  waiting: "waiting for an approval",
  success: "succeeded",
  failure: "failed",
  cancelled: "cancelled",
  skipped: "skipped",
};

/** The tone a status is drawn in. `waiting` has its own, never failure's. */
export const STATUS_TONE = { queued: "idle", running: "busy", waiting: "wait", success: "ok", failure: "bad", cancelled: "idle", skipped: "idle" };

/** behold#571: the tone an item's left bar takes from its status (kiosk.html's `[data-k-tone]` rules). */
export const toneOf = (status) => STATUS_TONE[status] || "idle";

const LIVE = new Set(["queued", "running", "waiting"]);

/** A step named by an action's address (`https://…/checkout@v4`, `actions/checkout@v4`), not by the workflow. */
const looksLikeAction = (name) => /^[a-z][a-z0-9+.-]*:\/\//i.test(name) || /^[\w.-]+\/[\w.-]+@/.test(name);
/** The runner's post step of an action: "Post " and the action's address. */
const isPostStep = (name) => /^Post /.test(name) && looksLikeAction(name.slice(5));

/**
 * What started a run, in words, with the ref it ran on: "Merge of #278 to
 * main", "Plan of pull request #278", "/terragucci apply on #278", "Push to
 * branch demo-a-known". The ref comes from the run (index.json carries it; a
 * run's own document may not, see mergeRun).
 */
export function triggerWords(run) {
  const pr = run.pull !== null && run.pull !== undefined ? `#${run.pull}` : null;
  const ref = run.ref || null;
  const onMain = !ref || ref === "main" || ref === "master";
  switch (run.trigger) {
    case "plan":
      return pr ? `Plan of pull request ${pr}` : `Plan of a pull request${ref ? ` from ${ref}` : ""}`;
    case "merge":
      return pr ? `Merge of ${pr} to ${ref || "main"}` : `Merge to ${ref || "main"}`;
    case "resume":
      return pr ? `/terragucci apply on ${pr}` : "/terragucci apply";
    case "reset":
      return `Reset ${ref || "main"} to the base`;
    case "base":
      return `The base, pushed to ${ref || "main"}`;
    case "push":
      return onMain ? `Push to ${ref || "main"}` : `Push to branch ${ref}`;
    default:
      return run.event ? `${run.event} run${ref ? ` on ${ref}` : ""}` : "a run";
  }
}

/** How far along a status is: a run or job only moves up this order, so the higher of two reads is the newer. */
export const STATUS_RANK = { queued: 0, running: 1, waiting: 2, success: 3, failure: 3, cancelled: 3, skipped: 3 };

/** Of two reads of the same run or job, the one that is further along; the second on a tie. */
export function newerOf(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ra = STATUS_RANK[a.status] ?? -1;
  const rb = STATUS_RANK[b.status] ?? -1;
  if (ra !== rb) return ra > rb ? a : b;
  if (a.ended_at && !b.ended_at) return a;
  return b;
}

/**
 * One run as the kiosk draws it, from its index.json entry and its own
 * document, read at different moments: every field the document lacks
 * (`ref`, say) from the entry, and the run's and each job's status and times
 * from whichever read is further along. The sidebar and the run's page draw
 * this same object, so they never disagree.
 */
export function mergeRun(entry, doc) {
  if (!doc) return entry || null;
  if (!entry || entry.id !== doc.id) return doc;
  const out = { ...doc };
  for (const [k, v] of Object.entries(entry)) if ((out[k] === undefined || out[k] === null) && k !== "jobs") out[k] = v;
  const run = newerOf(doc, entry);
  out.status = run.status;
  out.started_at = run.started_at ?? doc.started_at ?? entry.started_at ?? null;
  out.ended_at = run.ended_at ?? null;
  const ix = new Map((entry.jobs || []).map((j) => [j.id ?? j.name, j]));
  const jobs = (doc.jobs || []).map((j) => {
    const e = ix.get(j.id ?? j.name);
    ix.delete(j.id ?? j.name);
    const n = newerOf(j, e);
    return n === j ? j : { ...j, status: n.status, started_at: n.started_at ?? j.started_at, ended_at: n.ended_at ?? null };
  });
  for (const e of ix.values()) jobs.push({ ...e, steps: [] });
  out.jobs = jobs;
  return out;
}

/**
 * The run the kiosk follows: the newest one queued or running, else the
 * newest run. A run held at a gate is followed while it is the newest; once a
 * newer run came after it (the resume, the next cycle), the demo has moved on
 * and it is a recent run like the others. Null with no runs.
 */
export function liveRun(runs) {
  if (!runs || !runs.length) return null;
  return runs.find((r) => r.status === "queued" || r.status === "running") || runs[0];
}

/** The sidebar's order: the live run first, then the rest newest first, as the index has them. */
export function sidebarRuns(runs) {
  const live = liveRun(runs);
  if (!live) return [];
  return [live, ...runs.filter((r) => r !== live)];
}

/**
 * Jobs in the order their `needs` give (a job after every job it needs),
 * keeping the forge's order among equals. A `needs` naming a job the run
 * doesn't have is ignored; a cycle still lists every job once.
 */
export function jobOrder(jobs) {
  const byName = new Map(jobs.map((j) => [j.name, j]));
  const depth = new Map();
  const visiting = new Set();
  const d = (j) => {
    if (depth.has(j.name)) return depth.get(j.name);
    if (visiting.has(j.name)) return 0;
    visiting.add(j.name);
    const needs = (j.needs || []).map((n) => byName.get(n)).filter(Boolean);
    const v = needs.length ? 1 + Math.max(...needs.map(d)) : 0;
    visiting.delete(j.name);
    depth.set(j.name, v);
    return v;
  };
  return jobs.map((j, i) => ({ j, i, k: d(j) })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => ({ ...x.j, depth: x.k }));
}

/** Split jobs into those that ran or will run, and the ones the run skipped (shown folded). */
export function splitSkipped(jobs) {
  return { shown: jobs.filter((j) => j.status !== "skipped"), skipped: jobs.filter((j) => j.status === "skipped") };
}

/** The job shown by default: running, then waiting, then failed, then the last one that started. */
export function defaultJob(jobs) {
  for (const s of ["running", "waiting", "failure"]) {
    const j = jobs.find((x) => x.status === s);
    if (j) return j;
  }
  // A run that ended: the job with the most of its own to say (the plan, the apply), else the last one that started.
  const said = jobs.map((j) => ({ j, n: ownLines(j.steps || []) })).filter((x) => x.n > 0);
  if (said.length) return said.reduce((a, b) => (b.n > a.n ? b : a)).j;
  const started = jobs.filter((j) => j.started_at).sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  return started[0] || jobs.find((j) => j.status !== "skipped") || jobs[0] || null;
}

/** Forgejo's runner line ending a step that exited 3, the code terragucci holds a wave with. */
const RUNNER_EXIT_3 = /^\s*⚙️\s*\[runner\]: exitcode '3': failure\s*$/u;

/**
 * A log line as the kiosk shows it under a job: in a job held at the gate,
 * the runner's `exitcode '3': failure` reads as what it is, a hold waiting for
 * an approval, never a failure. `{ text, held }`; any other line, and any line
 * of a job that is not held, is kept as it came.
 */
export function logLineWords(jobStatus, line) {
  if (jobStatus === "waiting" && typeof line === "string" && RUNNER_EXIT_3.test(line)) {
    return { text: "[runner]: exit code 3: held at the gate, waiting for an approval", held: true };
  }
  return { text: line, held: false };
}

/** The workflow's own steps of a job: not the runner's set-up or trailer, a post step, or an action's (named by its address). */
function ownSteps(steps) {
  return steps.map((s, i) => ({ s, i })).filter(({ s, i }) => i > 0 && i < steps.length - 1 && !isPostStep(s.name) && !looksLikeAction(s.name));
}

/** How many log lines a job's own steps wrote. */
function ownLines(steps) {
  return ownSteps(steps).reduce((n, { s }) => n + saidLines(s.log), 0);
}

/** behold#571: a log's lines that are not set-up or an artifact's copy, the ones a viewer reads. */
function saidLines(log) {
  return (log || []).filter((l) => !setupLine(l) && typeof l === "string" && l.trim()).length;
}

/**
 * The step expanded by default: the one running, waiting or failed (where the
 * job's own output is). Otherwise the step with the most to say among the
 * workflow's own steps: not the runner's set-up, its trailer or a post step,
 * and not an action's (named by its address), the job's first step when there
 * is nothing else. Index into `steps`, or -1 with no steps.
 */
export function defaultStep(steps) {
  if (!steps || !steps.length) return -1;
  for (const s of ["running", "waiting", "failure"]) {
    const i = steps.findIndex((x) => x.status === s);
    if (i >= 0) return i;
  }
  const own = ownSteps(steps).filter(({ s }) => saidLines(s.log) > 0);
  if (own.length) return own.reduce((a, b) => (saidLines(b.s.log) > saidLines(a.s.log) ? b : a)).i;
  const any = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.log && s.log.length);
  return any.length ? any[any.length - 1].i : 0;
}

/** "4 s", "1 m 05 s", "1 h 02 m"; null without a start. A thing still going counts to now. */
export function durationWords(started, ended, now = new Date()) {
  if (!started) return null;
  const a = Date.parse(started);
  const b = ended ? Date.parse(ended) : now.getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const s = Math.max(0, Math.round((b - a) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} m`;
}

/** "just now", "40 s ago", "3 m ago", "2 h ago". */
export function agoWords(at, now = new Date()) {
  if (!at) return "";
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} m ago`;
  if (s < 172800) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/**
 * behold#571: whether a scenario's short label reads as code to someone new
 * to the demo: a lettered label ("A, read through .output", "B on waves"), a
 * code token in it, or the bare id ("a-output").
 */
export function codeish(label) {
  return typeof label === "string" && (/^[A-Z]\b/.test(label) || /\.[A-Za-z]|[_`]/.test(label) || /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(label));
}

const MERGE_TITLE = /^Merge pull request '(.+)' \(#\d+\)/;

/**
 * behold#571: each scenario's title in plain words, by id: from the merge
 * runs' titles (the pull request is titled after its scenario), and from
 * `known` (the titles demo.json has carried, which win).
 */
export function scenarioTitles(runs, known = {}) {
  const out = {};
  for (const r of [...(runs || [])].reverse()) {
    const m = r && r.scenario && typeof r.title === "string" ? MERGE_TITLE.exec(r.title) : null;
    if (m) out[r.scenario] = m[1];
  }
  for (const [id, title] of Object.entries(known || {})) if (typeof title === "string" && title) out[id] = title;
  return out;
}

/**
 * The scenario and the cycle under a run: "a failure mid-apply · cycle 90".
 * The scenario's name as demo.json last carried it (`names`, terragucci#1050)
 * comes first, then the kiosk's SCENARIOS label; a label that reads as code
 * gives way to the scenario's title when one is known (behold#571).
 */
export function placeWords(run, scenarios, titles = {}, names = {}) {
  const own = (m) => !!(run.scenario && m && Object.prototype.hasOwnProperty.call(m, run.scenario));
  const short = own(names) && names[run.scenario] ? names[run.scenario] : own(scenarios) ? scenarios[run.scenario].name : run.scenario;
  const title = own(titles) ? titles[run.scenario] : null;
  const sc = title && (!short || codeish(short)) ? title : short;
  return [sc, run.cycle !== null && run.cycle !== undefined ? `cycle ${run.cycle}` : null].filter(Boolean).join(" · ");
}

/**
 * behold#571: a runner's or an action's set-up line, not terragucci's own:
 * git's hints, the checkout's `[command]` lines and groups, the runner's
 * docker and fetch lines.
 */
export const SETUP_LINES = [
  /^hint:/,
  /^\[command\]/,
  /^##\[(?:group|endgroup)\]/,
  /^Initialized empty Git repository\b/,
  /^::(?:add|remove)-matcher\b/,
  /^\s*❓\s*add-matcher\b/u,
  /^\s*🐳\s+docker\b/u,
  /^\s*☁️\s+git fetch\b/u,
  /^git version \d/,
  /^Temporarily overriding HOME=/,
  /^Adding repository directory to the temporary git global config\b/,
  /^Deleting the contents of '/,
  /^Syncing repository: /,
  /^Working directory is '/,
  // behold#571: an artifact's upload or download, as actions/upload-artifact and download-artifact print it.
  /^With the provided path, there will be \d+ files? uploaded$/,
  /^Starting artifact upload$/,
  /^For more detailed logs during the artifact (?:upload|download) process, enable step-debugging: /,
  /^Artifact name is valid!$/,
  /^Container for artifact "[^"]*" successfully created\. Starting upload of file\(s\)$/,
  /^Total size of all the files uploaded is \d+ bytes$/,
  /^File upload process has finished\. Finalizing the artifact upload$/,
  /^Artifact has been finalized\. All files have been successfully uploaded!$/,
  /^The raw size of all the files that were specified for upload is \d+ bytes$/,
  /^The size of all the files that were uploaded is \d+ bytes\. /,
  /^Note: The size of downloaded zips can differ significantly from the reported size\./,
  /^Artifact \S+ has been successfully uploaded!/,
  /^Uploaded bytes \d+$/,
  /^Beginning upload of artifact content to blob storage$/,
  /^Finished uploading artifact content to blob storage!$/,
  /^SHA256 (?:hash|digest) of (?:uploaded )?artifact (?:zip )?is /,
  /^Finalizing artifact upload$/,
  /^Artifact \S+ successfully finalized\. Artifact ID \d+$/,
  /^Artifact download URL: /,
  /^Starting download for \S+$/,
  /^Directory structure has been setup for the artifact$/,
  /^Total number of files that will be downloaded: \d+$/,
  /^Artifact \S+ was downloaded to /,
  /^Artifact download has finished successfully$/,
  /^Downloading single artifact$/,
  /^Preparing to download the following artifacts:$/,
  /^- \S+ \(ID: \d+, Size: \d+/,
  /^Redirecting to blob download url: /,
  /^Starting download of artifact to: /,
  /^Artifact download completed successfully\.$/,
  /^Total of \d+ artifact\(s\) downloaded$/,
  /^Download artifact has finished successfully$/,
];

/** Whether a log line is set-up noise (SETUP_LINES). */
export function setupLine(line) {
  return typeof line === "string" && SETUP_LINES.some((re) => re.test(line));
}

/**
 * behold#571: a step's log as the kiosk draws it. The set-up lines fold into
 * one row at the top, `{ setup: n }`, so terragucci's own lines come first;
 * opened (`open`), the row heads the whole log in order. Every line keeps
 * its number in the log. A log with no set-up lines is drawn as it came.
 */
export function logRows(lines, { open = false, from = 0, hide = null } = {}) {
  // behold#571: a tool's page leaves out a line naming another tool, and says how many it left out.
  const every = (lines || []).map((text, i) => ({ n: from + i + 1, text, setup: setupLine(text) }));
  // behold#571: a blank line after a set-up line (the upload's spacing) folds with it.
  let prev = false;
  for (const l of every) {
    if (typeof l.text === "string" && !l.text.trim()) l.setup = prev;
    else prev = l.setup;
  }
  const all = hide ? every.filter((l) => !hide(l.text)) : every;
  const gone = every.length - all.length;
  const rows = logRowsOf(all, open);
  return gone ? [...rows, { hidden: gone }] : rows;
}

function logRowsOf(all, open) {
  const n = all.filter((l) => l.setup).length;
  if (!n) return all.map(({ n: num, text }) => ({ n: num, text }));
  const head = { setup: n, open };
  const body = open ? all : all.filter((l) => !l.setup);
  return [head, ...body.map(({ n: num, text, setup }) => (open && setup ? { n: num, text, quiet: true } : { n: num, text }))];
}

// ---------------------------------------------------------------------------
// Drawing.

const NS = "http://www.w3.org/2000/svg";
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};

/** A status icon, the way a CI page draws one. */
export function statusIcon(status) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", `r-icon r-${STATUS_TONE[status] || "idle"}${status === "running" ? " r-spin" : ""}`);
  svg.setAttribute("aria-label", STATUS_WORDS[status] || status);
  const add = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.appendChild(n);
  };
  if (status === "success") {
    add("circle", { cx: 8, cy: 8, r: 7, fill: "currentColor" });
    add("path", { d: "M4.6 8.3 7 10.6l4.5-5", fill: "none", stroke: "var(--bg)", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" });
  } else if (status === "failure") {
    add("circle", { cx: 8, cy: 8, r: 7, fill: "currentColor" });
    add("path", { d: "M5.5 5.5l5 5m0-5-5 5", stroke: "var(--bg)", "stroke-width": 1.8, "stroke-linecap": "round" });
  } else if (status === "running") {
    add("circle", { cx: 8, cy: 8, r: 6, fill: "none", stroke: "currentColor", "stroke-opacity": 0.3, "stroke-width": 2 });
    add("path", { d: "M8 2a6 6 0 0 1 6 6", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" });
  } else if (status === "waiting") {
    add("circle", { cx: 8, cy: 8, r: 7, fill: "currentColor" });
    add("path", { d: "M6.2 5v6M9.8 5v6", stroke: "var(--bg)", "stroke-width": 1.8, "stroke-linecap": "round" });
  } else if (status === "skipped" || status === "cancelled") {
    add("circle", { cx: 8, cy: 8, r: 6.2, fill: "none", stroke: "currentColor", "stroke-width": 1.5 });
    add("path", { d: "M4 12 12 4", stroke: "currentColor", "stroke-width": 1.5 });
  } else {
    add("circle", { cx: 8, cy: 8, r: 6.2, fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-dasharray": "2.4 2" });
  }
  return svg;
}

/** The sidebar: the live run pinned, then the recent ones. `pick(id)` selects one; nothing here writes. */
export function renderSidebar(host, index, selectedId, { now = new Date(), scenarios = {}, titles = {}, names = {}, pick = () => {}, merged = null, replay = false } = {}) {
  host.replaceChildren();
  const head = el("div", "r-side-head");
  head.appendChild(el("div", "r-side-title", "Runs"));
  // behold#571: a tool's page replays an earlier cycle's runs, and says so.
  head.appendChild(el("div", "r-side-note", replay ? "The replayed cycle's runs, newest first." : "From the forge, newest first."));
  host.appendChild(head);
  if (!index || index.error || index.absent || !index.doc) {
    host.appendChild(el("p", "r-note", index ? index.absent || index.error : "Reading the runs…"));
    return;
  }
  // The selected run as its page draws it, when its own document is newer than the index.
  const runs = sidebarRuns(index.doc.runs).map((r) => (merged && merged.id === r.id ? merged : r));
  if (!runs.length) {
    host.appendChild(el("p", "r-note", "No runs to show yet."));
    return;
  }
  const live = runs[0];
  const named = scenarioTitles(index.doc.runs, titles);
  const list = el("ol", "r-runs");
  runs.forEach((r, i) => {
    if (i === 0) list.appendChild(el("li", "r-group", replay ? (LIVE.has(live.status) ? "Running in the replay" : "Latest in the replay") : LIVE.has(live.status) ? "Live" : "Latest"));
    if (i === 1) list.appendChild(el("li", "r-group", "Recent"));
    const li = el("li", `r-run${r.id === selectedId ? " r-selected" : ""}`);
    li.tabIndex = 0;
    li.dataset.run = String(r.id);
    li.dataset.kTone = toneOf(r.status);
    li.appendChild(statusIcon(r.status));
    const body = el("div", "r-run-body");
    body.appendChild(el("div", "r-run-title", triggerWords(r)));
    const place = placeWords(r, scenarios, named, names);
    if (place) body.appendChild(el("div", "r-run-place", place));
    const meta = el("div", "r-run-meta");
    meta.append(
      el("span", `r-word r-${STATUS_TONE[r.status] || "idle"}`, r.status === "waiting" ? "held at the gate" : STATUS_WORDS[r.status] || r.status),
      el("span", null, `#${r.id}`),
      el("span", null, agoWords(r.started_at || r.created_at, now)),
    );
    const dur = durationWords(r.started_at, r.ended_at, now);
    if (dur) meta.appendChild(el("span", null, dur));
    body.appendChild(meta);
    li.appendChild(body);
    li.addEventListener("click", () => pick(r.id));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") pick(r.id);
    });
    list.appendChild(li);
  });
  host.appendChild(list);
}

/**
 * The run's page: its head, its jobs in `needs` order (skipped ones folded
 * into a line), the selected job's steps, and the expanded step's log.
 * `ui` holds the viewer's picks: `job` (a name) and `open` (a step index),
 * null for the defaults. Returns what it drew, so the caller can keep a log's
 * scroll.
 */
/**
 * behold#571: a job row's tool marks, `<span class="r-job-tools">` of one
 * `r-tool` per tool (its icon, then its name), or null for none. `carried`
 * are the tools the roots the job applies carry inside them. A tool a vendor
 * page may not name (`hideLine`) is left out.
 */
export function toolMarks(job, repoTools = [], { light = false, hideLine = null, doc = document, carried = [] } = {}) {
  const ids = jobTools(job, repoTools, carried).filter((t) => !(hideLine && hideLine(TOOLS[t].name)));
  if (!ids.length) return null;
  const box = doc.createElement("span");
  box.className = "r-job-tools";
  for (const t of ids) {
    const tool = TOOLS[t];
    const m = doc.createElement("span");
    m.className = `r-tool r-tool-${t}`;
    m.title = `${job.name} runs ${tool.name}`;
    if (tool.icon) {
      const icon = iconSvg(doc, tool.icon, 11, { light });
      icon.setAttribute("class", "r-tool-icon");
      m.appendChild(icon);
    }
    const name = doc.createElement("span");
    name.className = "r-tool-name";
    name.textContent = tool.name;
    m.appendChild(name);
    box.appendChild(m);
  }
  return box;
}

export function renderRun(host, answer, ui, { now = new Date(), pickJob = () => {}, toggleStep = () => {}, toggleSetup = () => {}, jump = () => {}, toggleFeats = () => {}, featsOpen = false, note = null, flash = null, entry = null, roots = [], waves = [], tools = [], rootTools = {}, light = false, hideLine = null, trace = null, jobView = "steps", pickView = () => {} } = {}) {
  // behold#571: a root's name with its colour's dot, where the line names one.
  const textOf = (cls, text) => {
    if (!roots.length || !rootSegments(text, roots).some((x) => x.root)) return el("span", cls, text);
    const n = el("span", cls);
    n.appendChild(rootText(document, text, roots, { light }));
    return n;
  };
  host.replaceChildren();
  if (!answer || answer.error || answer.absent || !answer.doc) {
    host.appendChild(el("p", "r-note", answer ? answer.absent || answer.error : "Reading the run…"));
    return { log: null, steps: null, key: null };
  }
  const run = mergeRun(entry, answer.doc);
  const head = el("div", "r-head");
  const t = el("div", "r-head-title");
  t.append(statusIcon(run.status), el("span", null, triggerWords(run)));
  head.appendChild(t);
  head.appendChild(el("div", "r-head-sub", run.title));
  const meta = el("div", "r-head-meta");
  const bits = [
    `#${run.id}`,
    run.status === "waiting" ? "held at a terragucci gate, waiting for an approval" : STATUS_WORDS[run.status] || run.status,
    run.ref ? `on ${run.ref}` : null,
    run.commit ? `commit ${run.commit.slice(0, 8)}` : null,
    run.started_at ? `started ${agoWords(run.started_at, now)}` : null,
    durationWords(run.started_at, run.ended_at, now),
  ].filter(Boolean);
  meta.textContent = bits.join(" · ");
  head.appendChild(meta);
  host.appendChild(head);

  const ordered = jobOrder(run.jobs);
  const { shown, skipped } = splitSkipped(ordered);
  const job = (ui.job && run.jobs.find((j) => j.name === ui.job)) || defaultJob(shown.length ? shown : run.jobs);
  host.appendChild(el("div", "r-label", "Jobs"));
  const jobsBox = el("ol", "r-jobs");
  for (const j of shown) {
    const li = el("li", `r-job${job && j.name === job.name ? " r-selected" : ""}`);
    li.style.setProperty("--depth", String(j.depth));
    li.dataset.kTone = toneOf(j.status);
    li.appendChild(statusIcon(j.status));
    // behold#571: the tools the job runs, each its logo (where its owner allows) and its name, on a
    // line of their own under the job's name, so the row's line keeps its width.
    const jobWave = waveOfJob(j.name, waves);
    const carried = jobWave !== null ? rootsOfWave(jobWave, waves).flatMap((r) => rootTools[r] || []) : [];
    const marks = toolMarks(j, tools, { light, hideLine, carried });
    if (marks) {
      const head = el("span", "r-job-head");
      head.append(el("span", "r-job-name", j.name), marks);
      li.appendChild(head);
    } else li.appendChild(el("span", "r-job-name", j.name));
    // behold#571: a wave's job row names the roots it applies, each with its dot, and lights its wave box on hover.
    const wave = waveOfJob(j.name, waves);
    const applies = wave !== null ? rootsOfWave(wave, waves).filter((r) => rootColour(r, roots, { light })) : [];
    if (wave !== null && waves.length) li.dataset.kWave = String(wave);
    if (applies.length) {
      const box = el("span", "r-job-roots");
      for (const r of applies) {
        const name = el("span", "k-root", r);
        name.dataset.kRoot = r;
        name.style.setProperty("--k-root", rootPaint(r, roots, { light }));
        box.appendChild(name);
      }
      li.appendChild(box);
    }
    if (j.needs && j.needs.length) li.appendChild(el("span", "r-job-needs", `after ${j.needs.join(", ")}`));
    li.appendChild(el("span", "r-dur", j.status === "waiting" ? "held at the gate" : durationWords(j.started_at, j.ended_at, now) || STATUS_WORDS[j.status] || ""));
    li.addEventListener("click", () => pickJob(j.name));
    jobsBox.appendChild(li);
  }
  if (skipped.length) jobsBox.appendChild(el("li", "r-job r-job-skipped", `${skipped.length} skipped, not for this event: ${skipped.map((j) => j.name).join(", ")}`));
  host.appendChild(jobsBox);

  // behold#571: the features this run's logs show, by tool, each jumping to its first line.
  // One wrapping list (a tool's name, then its features); folded, it shows whole lines only (fitFeatures).
  const feats = runFeatures(shown, { hide: hideLine });
  if (feats.length) {
    const box = el("div", `r-feats${featsOpen ? " r-feats-open" : ""}`);
    box.appendChild(el("div", "r-label r-feats-label", "Features"));
    const list = el("div", "r-feats-list");
    for (const g of feats) {
      list.appendChild(el("span", `r-feats-product r-ann-${g.product}`, g.product));
      for (const f of g.features) {
        const b = el("button", "r-feat", f.feature);
        b.type = "button";
        b.title = `${f.a.note} (${f.job}, line ${f.n})`;
        b.addEventListener("click", () => jump(f.job, f.step, f.n));
        list.appendChild(b);
      }
    }
    const more = el("button", "r-feats-more", featsOpen ? "Show fewer" : "");
    more.type = "button";
    more.addEventListener("click", () => toggleFeats());
    list.appendChild(more);
    box.appendChild(list);
    host.appendChild(box);
  }

  if (!job) return { log: null, steps: null, key: null };
  // behold#571: a job with a trace in Tempo offers it beside its steps (web/kiosk-trace.js).
  if (trace && trace.has(job.name)) {
    const tabs = el("div", "t-tabs");
    for (const [view, words] of [["steps", "Steps"], ["trace", "Trace"]]) {
      const b = el("button", "t-tab", words);
      b.type = "button";
      b.setAttribute("aria-pressed", String((jobView === "trace") === (view === "trace")));
      b.addEventListener("click", () => pickView(view));
      tabs.appendChild(b);
    }
    host.appendChild(tabs);
    if (jobView === "trace") {
      const box = el("div", "r-steps r-trace");
      trace.draw(box, job.name);
      host.appendChild(box);
      return { log: null, steps: box, key: null };
    }
  } else host.appendChild(el("div", "r-label", "Steps"));
  const stepsBox = el("div", "r-steps");
  const sh = el("div", "r-steps-head");
  sh.append(statusIcon(job.status), el("span", "r-steps-job", job.name), el("span", "r-steps-word", job.status === "waiting" ? "waits for an approval at the gate" : STATUS_WORDS[job.status] || job.status));
  stepsBox.appendChild(sh);
  const steps = job.steps || [];
  if (!steps.length) {
    const words =
      job.status === "queued"
        ? "Queued: it starts once the jobs it needs finish."
        : job.status === "running"
          ? "Started: its steps and log appear here as the loop driver copies them from the forge, every few seconds."
          : "No steps recorded for this job.";
    stepsBox.appendChild(el("p", "r-note", words));
  }
  const open = ui.open !== null && ui.open !== undefined && ui.job === job.name ? ui.open : defaultStep(steps);
  let logEl = null;
  const marks = jobMarks(steps, { hide: hideLine });
  steps.forEach((s, i) => {
    const row = el("div", `r-step${i === open ? " r-open" : ""}`);
    row.dataset.kTone = toneOf(s.status);
    const line = el("div", "r-step-line");
    line.append(el("span", "r-caret", i === open ? "▾" : "▸"), statusIcon(s.status), el("span", "r-step-name", s.name), el("span", "r-dur", durationWords(s.started_at, s.ended_at, now) || ""));
    line.addEventListener("click", () => toggleStep(job.name, i === open ? -1 : i));
    row.appendChild(line);
    if (i === open) {
      const pre = el("pre", "r-log");
      if (s.truncated) pre.appendChild(el("div", "r-log-cut", `… ${s.truncated} earlier lines not kept`));
      const key = logKey(run.id, job.name, i);
      for (const row of logRows(s.log, { open: ui.setup === key, from: s.truncated || 0, hide: hideLine })) {
        if (row.hidden) {
          pre.appendChild(el("div", "r-log-cut", `${row.hidden} line${row.hidden === 1 ? "" : "s"} of this log left out on this page`));
          continue;
        }
        if (row.setup) {
          const fold = el("div", `r-log-setup${row.open ? " r-log-setup-open" : ""}`, `${row.open ? "▾" : "▸"} runner set-up and file copies (${row.setup} line${row.setup === 1 ? "" : "s"})`);
          fold.setAttribute("role", "button");
          fold.tabIndex = 0;
          fold.setAttribute("aria-expanded", String(row.open));
          fold.addEventListener("click", () => toggleSetup(key));
          fold.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") toggleSetup(key);
          });
          pre.appendChild(fold);
          continue;
        }
        const lineKey = `${key}|${row.n}`;
        const ln = el("div", `r-log-line${row.quiet ? " r-log-quiet" : ""}${flash === lineKey ? " r-flash" : ""}`);
        ln.dataset.n = String(row.n);
        const shown = logLineWords(job.status, row.text);
        const text = row.quiet ? el("span", shown.held ? "r-lt r-wait" : "r-lt", shown.text) : textOf(shown.held ? "r-lt r-wait" : "r-lt", shown.text);
        ln.append(el("span", "r-ln", String(row.n)), text);
        // behold#571: the line's feature, as a chip on its first line in the job and a dot after.
        const mark = marks.get(`${i}:${row.n}`);
        if (mark) {
          ln.classList.add("r-ann-line");
          ln.dataset.annKey = lineKey;
          text.append(" ", annMark(mark.a, { first: mark.first, tour: mark.first && TOUR.includes(mark.a.id) }));
          if (note && note.key === lineKey) ln.appendChild(annNote(mark.a, note));
        }
        pre.appendChild(ln);
      }
      if (!s.log.length) pre.appendChild(el("div", "r-log-cut", s.status === "running" ? "waiting for output…" : "no output"));
      if (s.status === "running") pre.appendChild(el("div", "r-log-live", "▍"));
      row.appendChild(pre);
      logEl = pre;
    }
    stepsBox.appendChild(row);
  });
  host.appendChild(stepsBox);
  return { log: logEl, steps: stepsBox, key: logEl ? logKey(run.id, job.name, open) : null, live: LIVE.has(job.status) };
}

/** behold#571: a line's feature mark: an outlined chip (the tool and the feature), or a faint dot on a later line of it. */
export function annMark(a, { first = true, tour = false } = {}) {
  const b = el("button", first ? `r-ann r-ann-${a.product}${tour ? " r-ann-tour" : ""}` : `r-ann-dot r-ann-${a.product}`, first ? chipWords(a) : "");
  b.type = "button";
  b.dataset.ann = a.id;
  b.setAttribute("aria-label", `${chipWords(a)}: ${a.note}`);
  if (!first) b.title = chipWords(a);
  return b;
}

/** behold#571: a feature's note, opened under its line: the sentence, and the docs in a new tab. */
export function annNote(a, { auto = false, pinned = false } = {}) {
  const box = el("div", `r-ann-note${auto ? " r-ann-auto" : ""}${pinned ? " r-ann-pinned" : ""}`);
  box.setAttribute("role", "note");
  box.appendChild(el("div", `r-ann-note-head r-ann-${a.product}`, chipWords(a)));
  box.appendChild(el("p", "r-ann-note-text", a.note));
  const link = el("a", "r-ann-more", "Read more");
  link.href = docsUrl(a);
  link.target = "_blank";
  link.rel = "noopener";
  box.appendChild(link);
  return box;
}

/** behold#571: how many whole lines the folded features strip shows. */
export const FEATURE_LINES = 3;

/**
 * behold#571: fold the features strip to FEATURE_LINES whole lines: what
 * would wrap past them is hidden, never cut through, and a "+N more" button
 * on the last line opens the rest. A tool's name left last on a line with
 * none of its features after it goes too. Measures the drawn list, so it runs
 * after layout and again whenever the list's width or its features change.
 * The button shows only when it hides at least one feature (never "+0 more"),
 * and opened, only when there is something to fold back.
 */
export function fitFeatures(list, open, lines = FEATURE_LINES) {
  if (!list) return;
  const more = list.querySelector(".r-feats-more");
  const items = [...list.children].filter((c) => c !== more);
  for (const i of items) i.hidden = false;
  more.hidden = true;
  const tops = [...new Set(items.map((i) => i.offsetTop))].sort((a, b) => a - b);
  if (tops.length <= lines) return;
  const last = tops[lines - 1];
  if (open) {
    // Folded, it would hide a feature: offer to fold it back.
    more.hidden = !items.some((i) => i.offsetTop > last && i.classList.contains("r-feat"));
    return;
  }
  const shown = items.filter((i) => i.offsetTop <= last);
  for (const i of items) if (i.offsetTop > last) i.hidden = true;
  const count = () => items.filter((i) => i.hidden && i.classList.contains("r-feat")).length;
  if (count() > 0) {
    more.hidden = false;
    more.textContent = `+${count()} more`;
    // The button sits on the last line: hide features from its end until it fits there.
    while (more.offsetTop > last && shown.length) {
      shown.pop().hidden = true;
      more.textContent = `+${count()} more`;
    }
  }
  // A tool's name with none of its features shown after it.
  const vis = items.filter((i) => !i.hidden);
  if (vis.length && vis[vis.length - 1].classList.contains("r-feats-product")) vis[vis.length - 1].hidden = true;
}

/** Which log is open: the run, the job and the step. A new key means a different log, which the pane follows from its end. */
export function logKey(runId, job, step) {
  return `${runId}|${job}|${step}`;
}

/** How close to the end, in log lines, still counts as at the end: a viewer back within it is followed again. */
export const FOLLOW_LINES = 3;

/** Whether a scroller's view ends within `slack` pixels of its content's end. */
export function nearEnd({ scrollTop, clientHeight, scrollHeight }, slack) {
  return scrollTop + clientHeight >= scrollHeight - slack;
}

/**
 * Whether the log pane follows its end after a redraw, the way a CI page's
 * log does: always when a different log opened (another run, job or step,
 * as when the next step starts); otherwise as the viewer left it, following
 * unless they scrolled up away from the end.
 */
export function followsLog(prevKey, key, wasFollowing) {
  if (key !== prevKey) return true;
  return wasFollowing;
}

/** How long a viewer's pick holds before the kiosk follows the live run again. */
export const PICK_HOLD_MS = 90_000;

/**
 * Boot the runs panel: poll the index, read the selected run (often while it
 * is live), and redraw. The live run is selected until a viewer picks
 * another, and again {@link PICK_HOLD_MS} after their last pick.
 */
export function startRuns(
  { side, main },
  {
    fetchJson,
    now = () => new Date(),
    shown = now,
    scenarios = {},
    titles = () => ({}),
    names = () => ({}),
    onLive = () => {},
    roots = () => [],
    waves = () => [],
    tools = () => [],
    rootTools = () => ({}),
    light = () => false,
    source = () => null,
    filter = (index) => index,
    replay = () => false,
    hideLine = null,
  } = {},
) {
  const s = { index: null, run: null, selected: null, picked: 0, ui: { job: null, open: null, setup: null }, note: null, flash: null, scrollTo: null, pending: null, featsOpen: false };
  // behold#571: the notes a kiosk with nobody at it has opened by itself, and when it last had a pointer.
  const toured = new Set();
  let lastPointer = -Infinity;
  let tourRest = 0;
  let follow = true;
  let lastRunKey = "";
  // The open log and whether the pane follows its end; a viewer who scrolls up stops it until they come back.
  let logShown = null;
  let logFollow = true;
  // behold#571: the job pane's view, its steps or its trace, kept as a viewer moves between jobs.
  let jobView = "steps";
  const traces = traceSource({ fetchJson, onChange: () => draw() });
  if (typeof document !== "undefined") traceStyle(document);
  const following = () => follow || now().getTime() - s.picked > PICK_HOLD_MS;
  const selectedId = () => {
    const runs = s.index && s.index.doc ? s.index.doc.runs : [];
    const live = liveRun(runs);
    if (following()) {
      follow = true;
      return live ? live.id : null;
    }
    return s.selected;
  };
  const draw = () => {
    const id = selectedId();
    const entry = s.index && s.index.doc ? s.index.doc.runs.find((r) => r.id === id) || null : null;
    const ans = s.run && (!s.run.doc || s.run.doc.id === id) ? s.run : null;
    // behold#571: a line asked for from elsewhere (the approval panel), once its run is read.
    if (s.pending && ans && ans.doc && ans.doc.id === s.pending.run) {
      const p = s.pending;
      s.pending = null;
      s.ui = { job: p.job, open: p.step, setup: null };
      const k = `${logKey(p.run, p.job, p.step)}|${p.n}`;
      s.scrollTo = k;
      s.flash = { key: k, until: now().getTime() + FLASH_MS };
      s.note = p.note === false ? s.note : { key: k, pinned: true, auto: false };
    }
    const t = now().getTime();
    if (s.flash && t > s.flash.until) s.flash = null;
    if (s.note && s.note.auto && t > s.note.until) {
      s.note = null;
      tourRest = t + TOUR_REST_MS;
    }
    // One merged read of the selected run for both the sidebar and its page.
    const merged = ans && ans.doc ? mergeRun(entry, ans.doc) : null;
    renderSidebar(side, s.index, id, { now: shown(), scenarios, titles: titles(), names: names(), pick, merged, replay: replay() });
    // The redraw replaces the scrollers: keep where a viewer left them.
    const old = main.querySelector(".r-log");
    const oldSteps = main.querySelector(".r-steps");
    const prevTop = old ? old.scrollTop : 0;
    const prevStepsTop = oldSteps ? oldSteps.scrollTop : 0;
    const drawn = renderRun(main, ans, s.ui, {
      now: shown(),
      entry,
      roots: roots(),
      waves: waves(),
      tools: tools(),
      rootTools: rootTools(),
      light: light(),
      hideLine,
      trace: traceFor(ans),
      jobView,
      pickView: (view) => {
        jobView = view;
        hold();
        draw();
      },
      note: s.note,
      flash: s.flash ? s.flash.key : null,
      featsOpen: s.featsOpen,
      toggleFeats: () => {
        s.featsOpen = !s.featsOpen;
        hold();
        draw();
      },
      jump: (job, step, n) => {
        const runId = ans && ans.doc ? ans.doc.id : null;
        if (runId === null) return;
        s.pending = { run: runId, job, step, n };
        hold();
        draw();
      },
      pickJob: (name) => {
        s.ui = { job: name, open: null, setup: null };
        hold();
        draw();
      },
      toggleStep: (job, i) => {
        s.ui = { job, open: i, setup: null };
        hold();
        draw();
      },
      toggleSetup: (key) => {
        s.ui = { ...s.ui, setup: s.ui.setup === key ? null : key };
        hold();
        draw();
      },
    });
    fitFeatures(main.querySelector(".r-feats-list"), s.featsOpen);
    logFollow = followsLog(logShown, drawn.key, logFollow);
    const sameLog = drawn.key !== null && drawn.key === logShown;
    logShown = drawn.key;
    if (!drawn.log) {
      if (drawn.steps) drawn.steps.scrollTop = prevStepsTop;
      return;
    }
    const log = drawn.log;
    const steps = drawn.steps;
    const target = s.scrollTo && s.scrollTo.startsWith(`${drawn.key}|`) ? log.querySelector(`.r-log-line[data-n="${s.scrollTo.slice(drawn.key.length + 1)}"]`) : null;
    if (target) {
      // A line asked for: in the middle of the log's view, the log in the steps' view; the pane stops following.
      s.scrollTo = null;
      logFollow = false;
      log.scrollTop = Math.max(0, target.offsetTop - log.clientHeight / 3);
      steps.scrollTop = 0;
      const below = log.getBoundingClientRect().bottom - steps.getBoundingClientRect().bottom;
      if (below > 0) steps.scrollTop += below + 8;
      if (typeof target.scrollIntoView === "function" && main.closest && main.closest(".k-runs-open")) target.scrollIntoView({ block: "center" });
    } else if (logFollow) {
      log.scrollTop = log.scrollHeight;
      // The steps list scrolls too: bring the log's end into its view.
      steps.scrollTop = sameLog ? prevStepsTop : 0;
      const below = log.getBoundingClientRect().bottom - steps.getBoundingClientRect().bottom;
      if (below > 0) steps.scrollTop += below + 8;
    } else {
      log.scrollTop = prevTop;
      steps.scrollTop = prevStepsTop;
    }
    // A viewer scrolling either list decides whether the pane follows: near the log's end it does again.
    const line = log.querySelector(".r-log-line");
    const slack = (line ? line.getBoundingClientRect().height || 18 : 18) * FOLLOW_LINES;
    const onScroll = () => {
      const logEnd = log.getBoundingClientRect().bottom - steps.getBoundingClientRect().bottom;
      logFollow = nearEnd(log, slack) && logEnd <= slack;
    };
    log.addEventListener("scroll", onScroll, { passive: true });
    steps.addEventListener("scroll", onScroll, { passive: true });
    tour(log);
  };
  /**
   * behold#571: with nobody at the screen (no pointer or touch for a while,
   * and not a touch screen), the tour's chips open their notes one at a
   * time, each for a few seconds, as their line scrolls into the log's view.
   */
  const tour = (log) => {
    const t = now().getTime();
    if (s.note || t < tourRest || t - lastPointer < IDLE_MS || !tourable()) return;
    const view = log.getBoundingClientRect();
    if (!view.height) return;
    for (const chip of log.querySelectorAll(".r-ann-tour")) {
      const line = chip.closest(".r-ann-line");
      const key = line && line.dataset.annKey;
      if (!key || toured.has(key)) continue;
      const r = line.getBoundingClientRect();
      if (r.top < view.top || r.bottom > view.bottom - view.height / 4) continue;
      toured.add(key);
      s.note = { key, pinned: false, auto: true, until: t + TOUR_NOTE_MS };
      draw();
      return;
    }
  };
  // behold#571: pointing at a chip or a dot opens its note, a click or a tap keeps it open; a click elsewhere closes it.
  const annKeyAt = (target) => {
    const mark = target && target.closest ? target.closest(".r-ann, .r-ann-dot, .r-ann-note") : null;
    const line = mark && mark.closest(".r-ann-line");
    return line ? line.dataset.annKey : null;
  };
  // behold#571: the features strip folds by measuring its drawn lines, so it measures again
  // when the panel's width changes (a resize, the panel opening) and once the fonts load.
  const refitFeatures = () => fitFeatures(main.querySelector && main.querySelector(".r-feats-list"), s.featsOpen);
  if (typeof ResizeObserver !== "undefined" && typeof Element !== "undefined" && main instanceof Element) {
    let width = -1;
    new ResizeObserver((entries) => {
      const w = Math.round(entries[entries.length - 1].contentRect.width);
      if (w === width) return;
      width = w;
      refitFeatures();
    }).observe(main);
  }
  if (typeof document !== "undefined" && document.fonts && document.fonts.ready) document.fonts.ready.then(refitFeatures, () => {});
  if (main.addEventListener) {
    const seen =() => (lastPointer = now().getTime());
    for (const ev of ["pointermove", "pointerdown", "touchstart", "wheel", "keydown"]) document.addEventListener(ev, seen, { passive: true });
    main.addEventListener("pointerover", (e) => {
      if (e.pointerType === "touch") return;
      const key = annKeyAt(e.target);
      if (s.note && (s.note.pinned || s.note.key === key)) return;
      if (!key && !s.note) return;
      s.note = key ? { key, pinned: false, auto: false } : null;
      draw();
    });
    document.addEventListener("click", (e) => {
      // The approval panel's chips and the features strip show their line, which opens its note.
      if (e.target && e.target.closest && e.target.closest("[data-ann-jump], .r-feat")) return;
      const key = annKeyAt(e.target);
      const onMark = e.target && e.target.closest && e.target.closest(".r-ann, .r-ann-dot");
      if (onMark && key) {
        s.note = s.note && s.note.key === key && s.note.pinned ? null : { key, pinned: true, auto: false };
        hold();
        draw();
        return;
      }
      if (s.note && !key) {
        s.note = null;
        draw();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && s.note) {
        s.note = null;
        draw();
      }
    });
  }
  /** The selected run's traces, by the repo and run id its document names. */
  const traceFor = (ans) => {
    const doc = ans && ans.doc;
    if (!doc || !doc.repo) return null;
    return {
      has: (job) => traces.has(doc.repo, doc.id, job),
      draw: (box, job) =>
        traces.draw(box, {
          repo: doc.repo,
          run: doc.id,
          job,
          pickJob: (name) => {
            s.ui = { job: name, open: null, setup: null };
            hold();
            draw();
          },
        }),
    };
  };
  const hold = () => {
    follow = false;
    s.selected = selectedId() ?? s.selected;
    s.picked = now().getTime();
  };
  const pick = (id) => {
    s.selected = id;
    follow = false;
    s.picked = now().getTime();
    s.ui = { job: null, open: null, setup: null };
    void readRun();
  };
  const readIndex = async () => {
    // behold#571: a tool's page reads its replay's runs from `source`, and keeps its own repo's alone.
    const src = source();
    s.index = filter(src ? await src.index() : await fetchJson("/api/terragucci/runs"));
    const runs = s.index && s.index.doc ? s.index.doc.runs : [];
    const live = liveRun(runs);
    onLive(live);
    await readRun();
  };
  const readRun = async () => {
    const id = selectedId();
    if (id === null) {
      if (s.index && s.index.doc) s.run = { doc: null, absent: "No run to show yet." };
      return draw();
    }
    const entry = s.index && s.index.doc ? s.index.doc.runs.find((r) => r.id === id) : null;
    // A run that ended reads once; one still going reads on every tick.
    const src = source();
    const key = `${src ? "replay" : "live"}|${id}|${entry ? entry.status : ""}|${entry ? entry.ended_at : ""}`;
    if (key === lastRunKey && entry && !LIVE.has(entry.status) && s.run && s.run.doc && s.run.doc.id === id) return draw();
    if (s.run && s.run.doc && s.run.doc.id !== id && !s.pending) s.ui = { job: null, open: null, setup: null };
    lastRunKey = key;
    s.run = src ? await src.run(id) : await fetchJson(`/api/terragucci/runs/${id}`);
    draw();
  };
  void readIndex();
  setInterval(() => void readIndex(), 3_000);
  setInterval(draw, 1_000);
  /** behold#571: show a run's log line from elsewhere (the approval panel's chips): its job, its step open, the line in view and lit, its note open. */
  s.show = (run, job, step, n) => {
    s.selected = run;
    follow = false;
    s.picked = now().getTime();
    s.pending = { run, job, step, n };
    if (s.run && s.run.doc && s.run.doc.id === run) draw();
    else void readRun();
  };
  return s;
}

/** How long a line asked for stays lit. */
export const FLASH_MS = 2_500;
/** How long a tour's note stays open, and the rest before the next. */
export const TOUR_NOTE_MS = 6_000;
export const TOUR_REST_MS = 2_000;
/** How long without a pointer or a touch before the kiosk counts as unattended. */
export const IDLE_MS = 45_000;

/** Whether this screen takes a tour: not a touch screen, where a finger opens the notes. */
function tourable() {
  return !(typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
}
