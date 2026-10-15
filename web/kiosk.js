// #569 step 2: the kiosk. #569 step 3: a status bar over behold's own view of
// the change, framed (`/?embed=1&bare=1`), moved to the roots each step is about. A looping terragucci demo (terragucci#1014),
// narrated from the demo.json its driver writes at every step, beside the
// newest run: the pull request's plan before the merge, the run view's waves
// from the merge on, and back to the start when the loop resets.
//
// The page only reads, all of it GET: /api/terragucci/demo (the narration),
// /api/terragucci (the pull request's plan), /api/terragucci/progress (the
// run view) and /api/terragucci/events (what moved). It has no control that
// writes and no copy button: the waiting wave's approve line is what the
// driver runs, shown so a viewer sees it.
//
// A wave that failed says which waves applied before it and stay applied.
// Nothing here is all-or-nothing, and nothing says so.

import { PICK_HOLD_MS, startRuns } from "./kiosk-runs.js";
import { cssString, hoverCss, hoverFromMessage, hoverLinks, hoverMessage, isLightBg, rootSegments, rootText } from "./kiosk-roots.js";
import { creditLines, filterIndex, keepRun, liveEstimate, liveFor, namesOther, notRunWords, replayAt, replayBanner, replayIndex, rootWord, runAsOf, scrubDemo, servesRepo, vendorOf } from "./kiosk-vendor.js";
import { repoParam, repoUrl } from "./kiosk-repo.js";
import { STATE_WORDS, changingRoots, costLine, pinsCommit, planFitsPin, pullPin, readEdges, rootsCount, totalsLine, waveRows, blastRows } from "./terragucci-change.js";

/** The scenarios terragucci#1014 numbers. An id not here is shown by the title demo.json carries. */
export const SCENARIOS = {
  base: { n: null, name: "the base" },
  "a-known": { n: 1, name: "A, a known value" },
  "a-output": { n: 2, name: "A, read through .output" },
  "b-waves": { n: 3, name: "B on waves" },
  failure: { n: 4, name: "a failure mid-apply" },
  "stale-plan": { n: 5, name: "a stale plan" },
  "b-composed": { n: 6, name: "B composed" },
};

/** The steps of one cycle as the strip shows them, in order. */
export const STRIP = [
  { id: "pull-request", words: "pull request", steps: ["pull-request"] },
  { id: "planned", words: "planned", steps: ["planned"] },
  { id: "merged", words: "merged", steps: ["merged"] },
  { id: "waves", words: "waves", steps: ["applying", "waiting", "approved", "failed", "resumed"] },
  { id: "applied", words: "applied", steps: ["applied"] },
  { id: "reset", words: "reset", steps: ["reset"] },
];

export const STEP_WORDS = {
  "pull-request": "pull request open",
  planned: "planned",
  merged: "merged",
  applying: "applying",
  waiting: "waiting for an approval",
  approved: "approved",
  failed: "failed",
  resumed: "running again",
  applied: "applied",
  reset: "reset",
  stalled: "stalled",
};

const counted = (n) => Number.isInteger(n) && n > 0;

/** demo.json's `name`, the scenario's short label in plain words (terragucci#1050); null without one. */
export function scenarioName(demo) {
  const n = demo && demo.name;
  return typeof n === "string" && n.trim() ? n.trim() : null;
}

/**
 * The kicker and the title over the card. behold#571: "Scenario 2 of 5" when
 * demo.json counts the loop (`index` of `scenarios`), "Scenario 2" with the
 * index alone, with the title in plain words. Without an index, today's
 * kicker: "scenario 3 · B on waves" from SCENARIOS, demo.json's `name` in
 * place of SCENARIOS' label when it has one; the driver's title alone for an
 * id behold doesn't know.
 */
export function scenarioHead(demo, { vendor = null } = {}) {
  // behold#571: a tool's page numbers nothing, so nothing hints at the loop's other scenarios.
  if (vendor) {
    const name = scenarioName(demo);
    return { kicker: name ? `Scenario · ${name}` : "Scenario", title: demo.title || name || demo.scenario };
  }
  const known = Object.prototype.hasOwnProperty.call(SCENARIOS, demo.scenario) ? SCENARIOS[demo.scenario] : null;
  const name = scenarioName(demo);
  if (counted(demo.index)) {
    const of = counted(demo.scenarios) && demo.index <= demo.scenarios ? ` of ${demo.scenarios}` : "";
    return { kicker: `Scenario ${demo.index}${of}`, title: demo.title || name || (known ? known.name : demo.scenario) };
  }
  if (!known) return { kicker: name ? `scenario · ${name}` : `scenario ${demo.scenario}`, title: demo.title };
  if (known.n === null) return { kicker: demo.title || name || "The base", title: demo.title || name || "The base" };
  return { kicker: `scenario ${known.n} · ${name || known.name}`, title: demo.title };
}

/** behold#571: demo.json's `intro`, one paragraph on the problem the demo solves; null without one. */
export function introText(demo) {
  const t = demo && demo.intro;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

/** The card's rows under the title, in order, with the labels the kiosk draws (behold#571). */
export const ABOUT_ROWS = [
  { field: "changes", label: "What changes" },
  { field: "watch", label: "Watch for" },
  { field: "shows", label: "Shows" },
];

/**
 * behold#571: the scenario's card, always open under the title so a TV or a
 * link opened cold reads it without a click. The text is demo.json's `about`,
 * as terragucci wrote it; no card when it has none.
 */
export function aboutRows(demo) {
  const about = demo && demo.about;
  if (!about) return [];
  return ABOUT_ROWS.filter((r) => typeof about[r.field] === "string" && about[r.field]).map((r) => ({ label: r.label, text: about[r.field] }));
}

/** The strip: each stop, and whether it is done, current or ahead. A stalled cycle marks no stop current. */
export function stripStops(step) {
  const at = STRIP.findIndex((s) => s.steps.includes(step));
  return STRIP.map((s, i) => ({ id: s.id, words: s.words, state: at < 0 ? "ahead" : i < at ? "done" : i === at ? (step === "failed" ? "failed" : "current") : "ahead" }));
}

/** Seconds from now until `at`, never below 0; null when there is no time. */
export function secondsUntil(at, now = new Date()) {
  if (!at) return null;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - now.getTime()) / 1000));
}

/** "in 14 s", "in 1 m 05 s", "now". */
export function countdownWords(secs) {
  if (secs === null) return null;
  if (secs <= 0) return "now";
  if (secs < 60) return `in ${secs} s`;
  return `in ${Math.floor(secs / 60)} m ${String(secs % 60).padStart(2, "0")} s`;
}

/** The driver's next action, as the kiosk says it. */
export function nextWords(demo, now = new Date()) {
  if (!demo.next) return { action: "nothing until the driver resets", when: "the driver stalled; it resets and starts the next cycle", secs: null };
  const secs = secondsUntil(demo.next.at, now);
  return {
    action: demo.next.action,
    when: secs === null ? "when the pipeline gets there" : countdownWords(secs),
    secs,
  };
}

/** "cycle 12 · started 4 m ago". */
export function cycleWords(demo, now = new Date()) {
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(demo.started_at)) / 1000));
  const since = s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, "0")} s ago`;
  return `cycle ${demo.cycle} · started ${since}`;
}

/** Which run the step is about: the pull request's plan, the merge's waves, or neither (a reset). */
export function demoStage(demo) {
  if (demo.step === "pull-request" || demo.step === "planned") return "pull-request";
  if (demo.step === "reset" || demo.scenario === "base") return "none";
  if (demo.step === "stalled") return demo.pull === null ? "none" : "either";
  return "apply";
}

const pullOf = (answer) => (answer && !answer.error && answer.pull_request ? answer.pull_request : null);
const runOf = (progress) => (progress && !progress.error && progress.run && progress.run.present && progress.states && progress.states.length ? progress.run : null);

/**
 * The newest pull request's plan, when it is this step's: the pull request
 * demo.json names, of its commit before the merge. A forge never reuses a
 * number, so an older cycle's plan is never shown as this one's.
 */
export function matchingPull(answer, demo) {
  const pr = pullOf(answer);
  if (!pr || demo.pull === null) return null;
  // From the merge on, demo.json's commit is the merge's, not the plan's.
  const before = demo.step === "pull-request" || demo.step === "planned";
  return planFitsPin(pr, before ? pullPin(planPin(demo)) : { pull: String(demo.pull), commit: null }) ? pr : null;
}

/**
 * The newest run view, when it is this cycle's: on the commit demo.json names
 * (the merge, or scenario 5's push), or written since the cycle started.
 */
export function matchingRun(progress, demo) {
  const run = runOf(progress);
  if (!run) return null;
  const sameCommit = !!demo.commit && !!run.commit && (run.commit.startsWith(demo.commit) || demo.commit.startsWith(run.commit));
  const thisCycle = !!run.updated && Date.parse(run.updated) >= Date.parse(demo.started_at);
  return sameCommit || thisCycle ? run : null;
}

/** What the run panel shows for this step, and the words when it has nothing yet. */
export function runPanel(demo, answer, progress) {
  const stage = demoStage(demo);
  if (stage === "none") return { stage: "none", note: demo.scenario === "base" ? "Nothing in flight: the base is applied." : "Nothing in flight: the states are back on the base." };
  const pr = stage !== "apply" ? matchingPull(answer, demo) : null;
  const run = stage !== "pull-request" ? matchingRun(progress, demo) : null;
  if (run) return { stage: "apply", run };
  if (pr) return { stage: "pull-request", pr };
  if (stage === "pull-request") {
    return { stage: "pull-request", note: demo.pull === null ? "The pull request isn't open yet." : `The plan of pull request #${demo.pull} isn't in the reports yet: the pipeline is planning it.` };
  }
  return { stage: "apply", note: demo.commit ? `The run view of ${demo.commit.slice(0, 8)} isn't in the reports yet: the pipeline writes it as the waves start.` : "No run yet." };
}

/** The pull request's waves and reads, when the panel shows its plan. */
export function pullRows(answer) {
  const only = { ...answer, roots: answer.roots || [] };
  return { waves: waveRows(only, null), reads: readEdges(only, null) };
}

/** The run view's waves, when the panel shows them. The pull request's plan is left out so the stage is the run's. */
export function runRows(progress) {
  return waveRows({ pull_request: null }, progress);
}

/**
 * Plain sentences for each read of an output known only after its upstream
 * applies: the review didn't show the value the reader gets.
 */
export function unreviewedLines(answer) {
  const pr = pullOf(answer);
  if (!pr) return [];
  return pr.reads
    .filter((r) => r.outputs === "planned" && r.unknown && r.unknown.length)
    .map((r) => `${r.root} reads ${r.unknown.join(", ")} from ${r.upstream}, known only after ${r.upstream} applies: the review does not show the value ${r.root} gets.`);
}

/**
 * The approval the driver gives at a waiting wave, as terragucci's
 * stack/demo.sh gives it: `approve_wave` runs chant's approve as the
 * reviewer (terragucci#1052: the driver plays two people, demo-author who
 * opens, merges and comments, and demo-reviewer who approves, since an
 * approval only counts from someone who had no hand in the change), sealed
 * with the reviewer's own signing key; then `resume_pull` posts
 * `/terragucci apply` on the merged pull request. The actor and the key are
 * placeholders: the kiosk never names a path or a secret.
 */
export function driverApproveLines(wave, pull) {
  return {
    approve: `chant approve tf-apply wave-${wave} --actor <reviewer> --sign <reviewer key>`,
    comment: "/terragucci apply",
    on: pull !== null && pull !== undefined ? `pull request #${pull}` : "the merged pull request",
  };
}

/**
 * The waiting wave the driver approves next: the wave and its roots and
 * digest from the run view, and the lines the driver runs. Null unless
 * demo.json is at `waiting` and names it.
 */
export function pendingApproval(demo, progress) {
  if (demo.step !== "waiting" || !demo.next) return null;
  const m = /\bapprove wave-(\d+)\b/.exec(demo.next.action);
  if (!m) return null;
  const number = Number(m[1]);
  const run = matchingRun(progress, demo);
  const w = run ? progress.states.find((x) => x.number === number) : null;
  return {
    wave: number,
    digest: w && w.digest ? w.digest : null,
    // #569 review: only the roots whose plan the approval covers a change in.
    roots: w ? changingRoots(w, [...new Set([...w.roots, ...(w.composed ? w.composed.roots : [])])]) : [],
    ...driverApproveLines(number, demo.pull),
  };
}

/**
 * behold#571: the approval in plain words, before the command, for a viewer
 * who has never approved a pipeline: who the driver plays, what it signs
 * with (terragucci#1052: a reviewer apart from the change's author). The
 * plan's digest is on the wave's box in the view.
 */
export function approveGloss(appr) {
  const roots = appr.roots.length ? ` (${appr.roots.join(", ")})` : "";
  return `The driver plays a reviewer who had no hand in the change, and approves wave ${appr.wave}${roots} with that reviewer's own signing key.`;
}

/**
 * #569: the roots the step is about, for the framed view to bring forward:
 * the pull request's roots while it is planned; from the merge on, the wave
 * that is waiting, applying, failed or refused (its roots and, for a composed
 * run, every root in it; for a failed or refused wave, the roots of the waves
 * before it that applied, which stay applied); nothing in particular once applied or reset, so the
 * whole picture shows. Null brings nothing forward.
 */
export function focusRoots(demo, answer, progress) {
  if (!demo) return null;
  const stage = demoStage(demo);
  if (stage === "none" || demo.step === "applied") return null;
  if (stage === "pull-request") {
    const pr = matchingPull(answer, demo);
    return pr && pr.roots && pr.roots.length ? [...pr.roots] : null;
  }
  const run = matchingRun(progress, demo);
  if (!run) {
    const pr = matchingPull(answer, demo);
    return pr && pr.roots && pr.roots.length ? [...pr.roots] : null;
  }
  const order = ["failed", "refused", "waiting", "applying"];
  for (const want of order) {
    const w = progress.states.find((x) => x.state === want);
    if (!w) continue;
    const inRun = progress.reads.filter((r) => r.composed && r.composed.wave === w.number).map((r) => r.root);
    // A wave that failed or refused: the waves before it that applied too, since they stay applied.
    const before = want === "failed" || want === "refused" ? progress.states.filter((x) => x.number < w.number && x.state === "applied").flatMap((x) => changingRoots(x, x.roots)) : [];
    // A root its wave plans no change in is not what the step is about.
    const roots = [...new Set([...changingRoots(w, [...w.roots, ...(w.composed ? w.composed.roots : []), ...inRun]), ...before])];
    if (roots.length) return roots;
  }
  return null;
}

/**
 * #569: the pin on this cycle's plan, `pull-<n>-<sha>` (or `pull-<n>`, or bare
 * `pull` while none is open): the frame draws that plan or none, never the
 * plan of another cycle's pull request.
 */
export function planPin(demo) {
  if (demo.pull === null || demo.pull === undefined || !/^\d+$/.test(String(demo.pull))) return "pull";
  const sha = demo.commit && /^[0-9a-f]{7,40}$/.test(demo.commit) ? `-${demo.commit}` : "";
  return `pull-${demo.pull}${sha}`;
}

/**
 * #569: which run the framed view draws for this step, so the graph stays on
 * the cycle the narration describes while the loop's next runs (the reset's
 * push back to the base) already go:
 *
 * - before the merge, `pull-<n>-<sha>` (planPin): no run view, and only this
 *   cycle's plan; until the plan job writes it, the roots with no marks;
 * - from the merge to `applied`, the cycle's commit (demo.json's `commit`:
 *   the merge, whose run view the `/terragucci apply` resume rewrites, or
 *   scenario 5's push);
 * - at `reset`, and on the base, `base`: nothing in flight.
 *
 * Never the reset's or the base's run while the step is before `reset`.
 */
export function runPin(demo) {
  if (!demo) return null;
  if (demo.scenario === "base" || demo.step === "reset") return "base";
  if (demo.step === "pull-request" || demo.step === "planned") return planPin(demo);
  if (demo.step === "stalled") return demo.commit ? demo.commit : "none";
  return demo.commit || "none";
}

/** The framed view's address: behold's own page, bare, at a zoom (the resources zoom unless told), told who its host is. */
export function frameSrc(origin, zoom = "resources", repo = null) {
  const q = new URLSearchParams({ embed: "1", bare: "1", zoom, host: origin });
  if (repo) q.set("repo", repo); // behold#571: the checkout the frame draws, on a behold that serves several
  return `/?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// #571: which of behold's two views the frame shows. Before the merge, the
// resources zoom: what the pull request changes and the reads it plans
// before their values are known. From the merge on, the components zoom of a
// terragucci repo (`terragucci.components.json`): one card per root in a box
// per wave, titled with the job that applies it, in step with the jobs pane.
// A viewer's click on the toggle holds a view for PICK_HOLD_MS after their
// last click, as a run picked in the sidebar does; then the step leads again.

/** The two views the toggle offers, with behold's zoom for each. */
export const VIEWS = [
  { id: "resources", words: "Resources", zoom: "resources" },
  { id: "components", words: "Roots by wave", zoom: "components" },
];

/**
 * The view a step shows: the pull request's steps the resources (what
 * changes, the unknown reads), every step from the merge on the components
 * (the jobs running), and the reset the components at rest. A step behold
 * doesn't know, and `stalled`, keep the components: the jobs pane says where
 * the pipeline stopped.
 */
export const STEP_VIEW = {
  "pull-request": "resources",
  planned: "resources",
  merged: "components",
  applying: "components",
  waiting: "components",
  approved: "components",
  failed: "components",
  resumed: "components",
  applied: "components",
  reset: "components",
  stalled: "components",
};

/** The view for a step. */
export function stepView(step) {
  return Object.prototype.hasOwnProperty.call(STEP_VIEW, step) ? STEP_VIEW[step] : "components";
}

/**
 * The view the frame shows, and why: `{ view, pinned, secs }`. Only the
 * resources view when the repo offers no components zoom (no
 * `terragucci.components.json`). A viewer's pick (`{ view, at }`, `at` in ms)
 * holds until PICK_HOLD_MS after it; `secs` is how long it still holds.
 * Without a demo step yet, the resources view.
 */
export function kioskView(demo, { components = false, pick = null, now = Date.now() } = {}) {
  if (!components) return { view: "resources", pinned: false, secs: null };
  if (pick && VIEWS.some((v) => v.id === pick.view)) {
    const left = pick.at + PICK_HOLD_MS - now;
    if (left > 0) return { view: pick.view, pinned: true, secs: Math.ceil(left / 1000) };
  }
  return { view: demo ? stepView(demo.step) : "resources", pinned: false, secs: null };
}

/** The line under the view saying how to read it, for the view shown. */
export function legendWords(view, tool = null) {
  const root = rootWord(tool);
  if (view === "components") {
    return `Each card is ${root} with its own state, in a box per wave titled with the pipeline job that applies it; an arrow is one root reading another's outputs, dashed while it reads planned values. A wave applies its roots together, after the waves it reads.`;
  }
  return `Each box is ${root} with its own state; an arrow is one root reading another's outputs, dashed while it reads planned values. A wave applies its roots together, after the waves it reads.`;
}

/** The behold zoom for a view. */
export function viewZoom(view) {
  const v = VIEWS.find((x) => x.id === view);
  return v ? v.zoom : "resources";
}

/**
 * The toggle, "Resources | Roots by wave", over the frame: the view shown
 * pressed, and a line saying whether the step leads or a click holds it.
 * Not drawn at all when the repo offers no components zoom.
 */
export function renderViewToggle(host, shown, { components = false, onPick = () => {} } = {}) {
  if (!host) return;
  host.replaceChildren();
  host.hidden = !components;
  if (!components) return;
  const group = el("div", "k-views");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "the view");
  for (const v of VIEWS) {
    const b = el("button", `k-view${v.id === shown.view ? " k-view-on" : ""}`, v.words);
    b.type = "button";
    b.setAttribute("aria-pressed", String(v.id === shown.view));
    b.addEventListener("click", () => onPick(v.id));
    group.appendChild(b);
  }
  host.appendChild(group);
  host.appendChild(el("span", "k-view-note", shown.pinned ? `held by a click; the step leads again in ${shown.secs} s` : "follows the step"));
}

/** The one-line facts under the view: the pull request's totals, cost and blast radius, as #568 has them. */
export function factLines(demo, answer) {
  const pr = demo ? matchingPull(answer, demo) : null;
  if (!pr) return [];
  const out = [];
  const totals = totalsLine(pr.totals);
  if (totals) out.push(`pull request #${pr.run.pull_request} changes ${rootsCount(pr.totals_roots) || "across roots"}: ${totals}`);
  const b = blastRows(answer);
  if (b && b.changed.length) out.push(`blast radius: ${b.changed.join(", ")}${b.downstream.length ? `; downstream, nearest first: ${b.downstream.join(", ")}` : ""}`);
  if (b && b.unplanned.length) out.push(`not touched: ${b.unplanned.join(", ")}`);
  const cost = costLine(pr.cost);
  if (cost) out.push(cost);
  return out;
}

// ---------------------------------------------------------------------------
// The page: a status bar over behold's own view in a frame, and a line of
// facts under it. The bar is the narration; the frame shows the change.

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};

/** behold#571: an element whose text puts a dot in its root's colour by each whole-word root name. */
const elRoots = (tag, cls, text, s) => {
  const roots = (s && (s.rootNames || s.roots)) || [];
  if (text === undefined || text === null || !rootSegments(String(text), roots).some((x) => x.root)) return el(tag, cls, text);
  const n = el(tag, cls);
  n.appendChild(rootText(document, String(text), roots, { light: !!(s && s.light) }));
  return n;
};

/** Draw the bar and the foot from what the kiosk holds. Pure over its arguments, but for the DOM. */
export function renderKiosk(bar, s, now = new Date(), foot = null) {
  bar.replaceChildren();
  if (foot) foot.replaceChildren();
  drawBar(bar, s, now, foot);
  // behold#571: a tool's page ends with who makes the tool, and that they don't endorse the demo.
  if (foot && vendorOf(s.vendor)) drawCredit(foot, s.vendor);
}

function drawBar(bar, s, now, foot) {
  const vendor = vendorOf(s.vendor);
  if (vendor && s.mode === "none") {
    // behold#571: the tool's scenario has no cycle yet: its name, its link, and a calm line.
    const words = notRunWords(vendor);
    const box = el("div", "k-empty");
    const title = el("h1", "k-title");
    title.append(brandEl(vendor), el("span", "k-title-text", words.title));
    box.append(title, el("p", "k-muted", words.text));
    bar.appendChild(box);
    return;
  }
  if (!s.demo || !s.demo.demo) {
    const box = el("div", "k-empty");
    const title = el("h1", "k-title");
    if (vendor) title.appendChild(brandEl(vendor));
    title.appendChild(el("span", "k-title-text", "Waiting for the demo"));
    box.appendChild(title);
    box.appendChild(el("p", "k-muted", s.demo ? s.demo.error || s.demo.absent : "Reading demo.json…"));
    bar.appendChild(box);
    return;
  }
  const demo = s.demo.demo;
  const head = scenarioHead(demo, { vendor: s.vendor || null });

  // behold#571: a tool's page says plainly when it replays an earlier run, and when it can't draw the repo's graph.
  if (s.replay && s.replay.banner) bar.appendChild(el("p", "k-replay", s.replay.banner));
  if (vendor && s.noReports && (s.mode === "live" || s.mode === "replay")) bar.appendChild(el("p", "k-nograph-note", NO_GRAPH_WORDS));
  const intro = introText(demo);
  if (intro) bar.appendChild(el("p", "k-intro", intro));

  // behold#571: the kicker on the title's line, so the bar has room for the intro.
  const left = el("div", "k-left");
  const title = el("h1", "k-title");
  if (vendor) title.appendChild(brandEl(vendor));
  title.append(el("span", "k-kicker", head.kicker), el("span", "k-title-text", head.title));
  left.appendChild(title);
  const rows = aboutRows(demo);
  if (rows.length) {
    const card = el("dl", "k-about");
    for (const r of rows) card.append(el("dt", "k-about-label", r.label), elRoots("dd", "k-about-text", r.text, s));
    left.appendChild(card);
  }
  const said = el("p", `k-step k-step-${demo.step}`);
  said.append(el("span", "k-step-word", STEP_WORDS[demo.step] || demo.step), elRoots("span", "k-label", demo.label, s));
  left.appendChild(said);
  bar.appendChild(left);

  const right = el("div", "k-right");
  const strip = el("ol", "k-strip");
  for (const stop of stripStops(demo.step)) strip.appendChild(el("li", `k-stop k-${stop.state}`, stop.words));
  const where = el("div", "k-where");
  where.append(strip, el("span", "k-cycle", cycleWords(demo, now)));
  right.appendChild(where);

  const nx = nextWords(demo, now);
  const next = el("div", "k-next");
  next.appendChild(el("span", "k-next-word", "next, by the driver"));
  next.appendChild(elRoots("span", "k-action", nx.action, s));
  next.appendChild(el("span", "k-when", nx.when));
  right.appendChild(next);

  const appr = pendingApproval(demo, s.progress);
  if (appr) {
    const a = el("div", "k-approve");
    a.appendChild(elRoots("p", "k-approve-gloss", approveGloss(appr), s));
    a.appendChild(el("code", "k-command", appr.approve));
    const then = el("p", "k-approve-then");
    then.append(`then comments `, el("code", "k-inline", appr.comment), ` on ${appr.on}, and the waves run again.`);
    a.appendChild(then);
    right.appendChild(a);
  } else if (!s.noReports) {
    const panel = runPanel(demo, s.answer, s.progress);
    if (panel.note) right.appendChild(elRoots("p", "k-note", panel.note, s));
    else if (panel.stage === "pull-request") for (const u of unreviewedLines(s.answer)) right.appendChild(elRoots("p", "k-note k-unknown", u, s));
  }
  bar.appendChild(right);

  if (foot) {
    // The legend reads the graph; with no graph shown there is nothing for it to explain.
    if (!s.noReports) foot.appendChild(el("span", "k-legend", legendWords(s.view || "resources", s.vendor || null)));
    // behold#571: no line on where the narration was read from: a viewer new to the demo reads the facts.
    if (!s.noReports) for (const f of factLines(demo, s.answer)) foot.appendChild(elRoots("span", "k-fact", f, s));
  }
}

/** behold#571: the header's line when this behold serves another repo than the page's. */
export const NO_GRAPH_WORDS = "This page shows the runs and their logs; the graph of this repo isn't served here.";

/** behold#571: a tool's name, and its logo where its owner allows one, linking to its official site. */
function brandEl(vendor) {
  const a = el("a", "k-brand");
  a.href = vendor.url;
  a.target = "_blank";
  a.rel = "noopener";
  if (vendor.logo) {
    const img = el("img", "k-brand-logo");
    img.src = vendor.logo.src;
    if (vendor.logo.src2x) img.srcset = `${vendor.logo.src2x} 2x`;
    img.alt = "";
    a.appendChild(img);
  }
  a.appendChild(el("span", "k-brand-name", vendor.name));
  return a;
}

/** behold#571: the footer's credit on a tool's page, its names linked to their official sites. */
function drawCredit(foot, tool) {
  for (const line of creditLines(tool)) {
    const p = el("span", "k-credit");
    for (const seg of line) {
      if (!seg.url) {
        p.append(seg.text);
        continue;
      }
      const a = el("a", "k-credit-link", seg.text);
      a.href = seg.url;
      a.target = "_blank";
      a.rel = "noopener";
      p.appendChild(a);
    }
    foot.appendChild(p);
  }
}

/** behold#571: how a hovered root's name and wave's job row light. A background and a shadow: nothing moves. */
export const HOVER_ROOT_RULE = "background: color-mix(in srgb, var(--focus) 32%, transparent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus) 32%, transparent); border-radius: 3px;";
export const HOVER_JOB_RULE = "background: color-mix(in srgb, var(--focus) 24%, transparent); box-shadow: inset 4px 0 0 var(--focus);";

/** How often the kiosk asks for demo.json. The server shares one read between kiosks. */
export const DEMO_POLL_MS = 3_000;

/**
 * Boot the kiosk: the bar, the frame and the foot. Ask demo.json every few
 * seconds, the reports and the run view when the step, cycle or commit moves
 * or the event stream says they did, and redraw every second for the
 * countdown. When the roots the step is about change, move the framed view
 * with a `behold:view` message; the frame takes them only from this origin.
 */
export function startKiosk({ bar, frame, foot, side, main, views }, { fetchJson = defaultFetch, now = () => new Date(), origin = location.origin, tool = null } = {}) {
  const s = { demo: null, answer: null, progress: null, components: false, pick: null, view: "resources", roots: [], waves: [], light: false, hover: null, frameHover: null };
  // behold#571: on a tool's page, `live` while its scenario runs, `replay` of its latest cycle otherwise, `none` before it has one.
  const vendor = vendorOf(tool);
  s.vendor = vendor ? tool : null;
  s.mode = vendor ? "loading" : "live";
  s.replay = null;
  s.repo = null;
  s.live = null;
  if (vendor && typeof document !== "undefined") document.title = `${vendor.name} · terragucci demo`;
  /** The time the page shows: the replay's, while it replays. */
  const shownNow = () => (s.mode === "replay" && s.replay && s.replay.at ? s.replay.at : now());
  /** behold#571: the frame and the plan's facts are the served repo's, so a tool's page shows them only for its own repo. */
  const frameOk = () => !vendor || servesRepo(s.answer && !s.answer.error ? s.answer.project : null, s.repo);
  // behold#571: a behold serving several repos (`serve --repos`) answers the
  // graph's reads from the checkout of the repo the page is about, asked by
  // name. `viewRepos` is what it serves, `aimed` the repo the reads are for.
  s.viewRepos = null;
  s.aimed = null;
  const wantRepo = () => repoParam(s.repo, s.viewRepos);
  const fetchServed = fetchJson;
  fetchJson = (url) => fetchServed(repoUrl(url, wantRepo()));
  /** When the page moves to another served repo, read its project, reports and run view again, and point the frame at it. */
  const followRepo = () => {
    const want = wantRepo();
    if (!want || want === s.aimed) return;
    s.aimed = want;
    void readProject();
    void reports(true);
    void progress(true);
  };
  let lastKey = "";
  let lastFocus;
  const shownView = () => kioskView(s.demo && s.demo.demo, { components: s.components, pick: s.pick, now: now().getTime() });
  const tellFrame = (force) => {
    const d = s.demo && s.demo.demo;
    if (!d) return; // nothing said yet: the frame keeps its default until the narration is read
    const roots = focusRoots(d, s.answer, s.progress);
    const focus = roots ? roots.join(",") : null;
    const run = runPin(d);
    const zoom = viewZoom(shownView().view);
    const key = `${focus}|${run}|${zoom}`;
    if (!force && key === lastFocus) return;
    lastFocus = key;
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: "behold:view", member: null, focus, run, zoom }, origin);
  };
  const pickView = (view) => {
    s.pick = { view, at: now().getTime() };
    draw();
  };
  // behold#571: the roots' colours and the hover links between the panes and the frame.
  const rootList = () => (s.roots.length ? s.roots : s.answer && Array.isArray(s.answer.roots) ? s.answer.roots.map((r) => r.path) : []);
  const glow = () => {
    let style = document.getElementById("k-hover-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "k-hover-style";
      document.head.appendChild(style);
    }
    const a = hoverLinks(s.hover, s.waves);
    const b = hoverLinks(s.frameHover, s.waves);
    const links = { roots: [...new Set([...a.roots, ...b.roots])], waves: [...new Set([...a.waves, ...b.waves])] };
    style.textContent = [
      hoverCss({ roots: links.roots, waves: [] }, { root: (r) => `.k-root[data-k-root=${cssString(r)}]` }, HOVER_ROOT_RULE),
      hoverCss({ roots: [], waves: links.waves }, { wave: (w) => `.r-job[data-k-wave="${w}"]` }, HOVER_JOB_RULE),
    ].join("\n");
  };
  const tellHover = (h) => {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage(hoverMessage(h), origin);
  };
  const hoverAt = (target) => {
    const t = target && target.closest ? target.closest("[data-k-root],[data-k-wave]") : null;
    if (!t) return null;
    if (t.dataset.kRoot) return { root: t.dataset.kRoot };
    const w = Number(t.dataset.kWave);
    return Number.isInteger(w) ? { wave: w } : null;
  };
  const setHover = (h) => {
    if ((h && h.root) === (s.hover && s.hover.root) && (h && h.wave) === (s.hover && s.hover.wave)) return;
    s.hover = h;
    glow();
    tellHover(h);
  };
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("pointerover", (e) => setHover(hoverAt(e.target)));
    document.documentElement.addEventListener("pointerleave", () => setHover(null));
    // A click or Escape anywhere here is a click elsewhere for the frame's pinned popover.
    const unpin = () => frame && frame.contentWindow && frame.contentWindow.postMessage({ type: "behold:unpin" }, origin);
    document.addEventListener("pointerdown", unpin);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") unpin();
    });
    window.addEventListener("message", (e) => {
      if (e.origin !== origin || !frame || e.source !== frame.contentWindow) return;
      const h = hoverFromMessage(e.data);
      if (h === undefined) return;
      s.frameHover = h;
      glow();
    });
  }

  // behold#571: the titles and names demo.json has carried, by scenario, for the runs' subtitles.
  const titles = {};
  const names = {};
  /** Take one narration (demo.json, or a replayed step), and ask for the run it is about when the step moved. */
  const setDemo = (answer) => {
    s.demo = answer;
    const d = answer && answer.demo;
    if (d && d.scenario && typeof d.title === "string" && d.title) titles[d.scenario] = d.title;
    if (d && d.scenario && scenarioName(d)) names[d.scenario] = scenarioName(d);
    const key = d ? `${s.mode}|${d.cycle}|${d.step}|${d.commit}|${d.pull}` : "";
    if (key !== lastKey) {
      lastKey = key;
      // The step moved: the run it is about may be newer than what behold read.
      const stage = d ? demoStage(d) : "none";
      if (stage === "pull-request" || stage === "either") void reports(true);
      if (stage === "apply" || stage === "either") void progress(true);
    }
  };
  // behold#571: the replay's clock, read on every draw.
  const replayTick = () => {
    if (s.mode !== "replay" || !s.replay) return;
    const steps = s.replay.cycle.steps;
    const r = replayAt(steps, now().getTime() - s.replay.start);
    s.replay.at = r.at;
    s.replay.banner = replayBanner(s.replay.cycle, liveEstimate(s.live && s.live.demo, s.replay.cycle, now()));
    setDemo({ source: "replay", read: steps[r.index].at, demo: scrubDemo(steps[r.index], tool) });
  };

  const draw = () => {
    followRepo();
    replayTick();
    s.light = typeof document !== "undefined" && document.documentElement ? isLightBg(getComputedStyle(document.documentElement).getPropertyValue("--bg")) : false;
    s.rootNames = rootList();
    const shown = shownView();
    s.view = shown.view;
    const ok = frameOk();
    s.noReports = !ok;
    renderKiosk(bar, s, shownNow(), foot);
    renderViewToggle(views, shown, { components: s.components && ok, onPick: pickView });
    // behold#571: with no graph to show, the graph pane folds away and the runs and the log take its width.
    if (typeof document !== "undefined" && document.body && document.body.classList) document.body.classList.toggle("k-nograph", !!vendor && !ok);
    tellFrame(false);
  };

  // behold#571: on a tool's page the runs pane shows the tool's repo alone; in the replay, the cycle's runs as they stood.
  const runDocs = new Map();
  const runDoc = (id) => {
    if (!runDocs.has(id)) runDocs.set(id, fetchJson(`/api/terragucci/runs/${id}`).then((a) => (a && a.doc ? a.doc : null)));
    return runDocs.get(id);
  };
  const replayRuns = async () => {
    const r = s.replay;
    if (r.runs) return r.runs;
    const idx = await fetchJson("/api/terragucci/runs");
    const listed = new Map((idx && idx.doc && Array.isArray(idx.doc.runs) ? idx.doc.runs : []).map((x) => [x.id, x]));
    const runs = [];
    for (const id of r.cycle.runs) {
      const e = listed.get(id) || (await runDoc(id));
      if (e) runs.push(e);
    }
    r.runs = runs.filter((x) => keepRun(x, { tool, repo: r.cycle.repo }));
    return r.runs;
  };
  const runsSource = () => {
    if (!vendor || s.mode === "live") return null;
    if (s.mode !== "replay" || !s.replay) return { index: async () => ({ doc: { schema: "demo.runs/v1", runs: [] } }), run: async () => ({ doc: null, absent: "No run to show yet." }) };
    return {
      index: async () => replayIndex(await replayRuns(), shownNow().getTime()),
      run: async (id) => {
        const doc = await runDoc(id);
        return doc ? { doc: runAsOf(doc, shownNow().getTime()) } : { doc: null, absent: `Run #${id} is no longer kept in the reports.` };
      },
    };
  };
  if (side && main) {
    startRuns(
      { side, main },
      {
        fetchJson,
        now,
        shown: shownNow,
        scenarios: SCENARIOS,
        titles: () => titles,
        names: () => names,
        roots: rootList,
        waves: () => s.waves,
        light: () => s.light,
        source: runsSource,
        filter: vendor ? (index) => filterIndex(index, { tool, repo: s.repo }) : (index) => index,
        replay: () => s.mode === "replay",
        hideLine: vendor ? (line) => namesOther(line, tool) : null,
      },
    );
  }
  // #571: whether the repo offers the components zoom (a terragucci.components.json), read before the frame opens so it opens on the step's view.
  let frameSrcNow = null;
  const openFrame = () => {
    if (!frame) return;
    const src = frameSrc(origin, viewZoom(shownView().view), wantRepo());
    if (src === frameSrcNow) return;
    if (frameSrcNow === null) {
      // The frame reads its graph after load; tell it again once it has had the time.
      frame.addEventListener("load", () => {
        for (const ms of [1500, 4000, 8000]) setTimeout(() => tellFrame(true), ms);
      });
    }
    frameSrcNow = src;
    frame.src = src;
  };
  const readProject = () => fetchJson("/api/project").then((p) => {
    // behold#571: the repos this behold serves, and which one this answer is.
    if (p && !p.error && Array.isArray(p.viewRepos)) {
      s.viewRepos = p.viewRepos;
      if (s.aimed === null && p.viewRepo) s.aimed = p.viewRepo;
    }
    s.components = !!(p && !p.error && p.terragucciComponents);
    // behold#571: the declared roots (their colours' order) and the wave jobs that apply them.
    if (p && p.terragucciRoots) {
      s.roots = Array.isArray(p.terragucciRoots.roots) ? p.terragucciRoots.roots : [];
      s.waves = Array.isArray(p.terragucciRoots.waves) ? p.terragucciRoots.waves : [];
    } else if (s.aimed) {
      s.roots = [];
      s.waves = [];
    }
    openFrame();
    draw();
  });
  void readProject();

  const reports = async (fresh) => {
    s.answer = await fetchJson(`/api/terragucci${fresh ? "?fresh=1" : ""}`);
    draw();
  };
  // #569: the run view of the cycle's commit, the same one the frame draws.
  const pinnedCommit = () => {
    const pin = runPin(s.demo && s.demo.demo);
    return pinsCommit(pin) ? pin : null;
  };
  const progress = async (fresh) => {
    const pin = pinnedCommit();
    const q = new URLSearchParams();
    if (pin) q.set("commit", pin);
    if (fresh) q.set("fresh", "1");
    const qs = q.toString();
    s.progress = await fetchJson(`/api/terragucci/progress${qs ? `?${qs}` : ""}`);
    draw();
  };

  // behold#571: a tool's latest cycle, read when its scenario stops being live, and while it has none yet.
  let cycleRead = 0;
  const readCycle = async () => {
    cycleRead = now().getTime();
    const a = await fetchJson(`/api/terragucci/cycles/${tool}`);
    if (s.mode === "live") return; // its scenario started while the read was out
    if (a && a.cycle) {
      if (!s.replay || s.replay.cycle.cycle !== a.cycle.cycle) s.replay = { cycle: a.cycle, start: now().getTime(), at: null, banner: null, runs: null };
      s.mode = "replay";
      s.repo = a.cycle.repo;
    } else if (a && a.absent) {
      s.mode = "none";
      s.replay = null;
    } else {
      s.mode = "error";
      s.replay = null;
      s.demo = { demo: null, error: a && a.error ? a.error : "The tool's latest cycle could not be read." };
    }
  };
  const CYCLE_REREAD_MS = 60_000;

  const demo = async () => {
    const live = await fetchJson("/api/terragucci/demo");
    s.live = live;
    if (!vendor) {
      s.repo = live && live.demo ? live.demo.repo : null;
      setDemo(live);
      return draw();
    }
    const d = live && live.demo;
    if (liveFor(d, tool, SCENARIOS)) {
      s.mode = "live";
      s.replay = null;
      s.repo = d.repo || s.repo;
      setDemo({ ...live, demo: scrubDemo(d, tool) });
      return draw();
    }
    // Not this tool's scenario: replay its latest cycle, read again when it went live and ended, or now and then.
    if (s.mode === "live" || s.mode === "loading" || now().getTime() - cycleRead > CYCLE_REREAD_MS) await readCycle();
    draw();
  };

  void demo();
  void reports(false);
  void progress(false);
  setInterval(() => void demo(), DEMO_POLL_MS);
  setInterval(draw, 1000);

  if (typeof EventSource !== "undefined") {
    const es = new EventSource("/api/terragucci/events");
    es.addEventListener("reports", () => void reports(false));
    es.addEventListener("progress", (e) => {
      try {
        const pushed = JSON.parse(e.data);
        const pin = pinnedCommit();
        const c = pushed && pushed.run && pushed.run.commit;
        // The pushed view is the newest run's: take it only when it is the cycle's.
        if (!pin || (c && (c.startsWith(pin) || pin.startsWith(c)))) {
          s.progress = pushed;
          draw();
        } else void progress(true);
      } catch {
        void progress(false);
      }
    });
  }
  return s;
}

async function defaultFetch(url) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    const body = await r.json();
    return r.ok ? body : { error: body.error || `${url} answered ${r.status}`, ...body };
  } catch (e) {
    return { error: `${url}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export { STATE_WORDS };
