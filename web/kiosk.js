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

import { linkState, linkWords, noteBack, noteRead, readFailed, shareLink } from "./kiosk-link.js";
import { CHANT_PANEL_STEPS, chantApprovalModel, chantResultModel } from "./chant-pr-marks.js";
import { createLivePacer } from "./chant-live-pace.js";
import { applyJobs, cycleTrack, drawTrack, failureAt, seekMs, trackModel, waitingSpec } from "./kiosk-track.js";
import { FORGES, iconSvg } from "./forge-mark.js";
import { TOOLS } from "./tool-mark.js";
import { graphWaves } from "./chant-pr-marks.js";
import { createProgressPacer, trackWaves } from "./terragucci-live-pace.js";
import { PICK_HOLD_MS, annMark, mergeRun, startRuns, statusIcon } from "./kiosk-runs.js";
import { MODES, MODE_STORE, badges as waveBadges, badgeTitle, behindStep, steadyRun, holdEnds, captionModel, captionRoom, coneCaption, stepLine, watchOverlays, doraLine, modeStored, placeBeside, quietWords, recordKey, resultModel, runningStep, shotFor, stepTone, tailLines } from "./kiosk-watch.js";
import { REFIT_WAIT_MS, debounced, shotMessage } from "./kiosk-shot.js";
import { mountTrace } from "./kiosk-trace.js";
import { startEventHelp } from "./kiosk-event-help-ui.js";
import { miniWaterfall, phaseWords, waveTraces } from "./kiosk-wave-traces.js";
import { PANEL_STEPS, PANEL_TITLE, approvalModel, cycleRuns, digestHex, rowFacts } from "./kiosk-approval.js";
import { getThemeName, mountThemePicker, onThemeChange } from "./theme.js";
import { cssString, hoverCss, hoverFromMessage, hoverLinks, hoverMessage, isLightBg, rootSegments, rootText } from "./kiosk-roots.js";
import { creditLines, filterIndex, keepRun, kioskVendorOf, liveEstimate, liveFor, namesOther, notRunRepo, notRunWords, replayAt, replayBanner, replayIndex, rootNoun, rootWord, runAsOf, scrubDemo, servesRepo, vendorOf } from "./kiosk-vendor.js";
import { repoParam, repoUrl, stepCheckout } from "./kiosk-repo.js";
import { startKioskCarve } from "./kiosk-carve.js";
import { drawWaveList, waveListKey } from "./kiosk-wave-list.js";
import { readsFor, runsReadsFor } from "./kiosk-source.js";
import { mountAskTips } from "./kiosk-ask-tips.js";
import { mountResetModal, resetShown } from "./kiosk-reset.js";
import { graphFolds, graphPending } from "./kiosk-graph-pane.js";
import { askEventHelp, askMode, askShot, createAskPane, hasAsk, replyValues } from "./kiosk-ask.js";
import { STATE_WORDS, outcomesOf, changingRoots, costLine, pinsCommit, planFitsPin, pullPin, readEdges, rootsCount, totalsLine, waveRows, blastRows } from "./terragucci-change.js";
import { startKioskLight } from "./kiosk-light.js"; // behold#937
import { SIDE_PHONE, detailsModel, keepSide, renderSide, runTrace, sideState, sideStored } from "./kiosk-side.js";

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
export function stripStops(step, strip = STRIP) {
  const at = strip.findIndex((s) => s.steps.includes(step));
  return strip.map((s, i) => ({ id: s.id, words: s.words, state: at < 0 ? "ahead" : i < at ? "done" : i === at ? (step === "failed" ? "failed" : "current") : "ahead" }));
}

/** behold#631: the chapter headline's look: it fades in when the chapter turns (no motion under reduced motion), the point small under it. */
function chapterStyle() {
  if (typeof document === "undefined" || !document.head || document.getElementById("k-chapter-style")) return;
  const st = document.createElement("style");
  st.id = "k-chapter-style";
  st.textContent = `.k-cap-point { margin: 0.1em 0 0.35em; font: 600 0.95em var(--font-ui); color: var(--muted); }
@media (prefers-reduced-motion: no-preference) {
  .k-chapter-head.k-chapter-in { animation: k-chapter-in 0.8s ease-out both; }
  @keyframes k-chapter-in { from { opacity: 0; } to { opacity: 1; } }
}`;
  document.head.appendChild(st);
}

/**
 * behold#741: whether a kiosk tells its scenario the way #631 built for chant's loop (the projected track, the
 * chapter headline, the reach wedge, the waiting modal, paced waves, the wave blocks, applied earlier, one tip at a
 * time and the title line): a chant repo's loop, or a terragucci repo whose demo.json step carries `chapter`.
 * b-waves, failure and tg-planned-outputs carry none, so they take today's path.
 */
export function storyGate({ chantLoop = false, terragucciRepo = false, demo = null } = {}) {
  if (chantLoop) return "chant";
  if (terragucciRepo && demo && demo.chapter && Number.isInteger(demo.chapter.n)) return "terragucci";
  return null;
}
const storyOn = (s) => !!(s.chantLoop || s.tgStory);

/** behold#631: a chant kiosk's one line naming what it shows: the pipeline is chant's own; terragucci runs the demo around it. */
export const SCENARIO_WORDS = { "fan-out": "fan-out" };
export function whatLine(demo, forge = null, tg = null) {
  return whatParts(demo, forge, tg).map((p) => p.text).join(" · ");
}
/**
 * The line's parts, each `{ text, short, logo? }`: a logo (a mark behold ships) only where a product is named,
 * chant's beside chant, the forge's beside the forge. `short` is the phone's words.
 */
export function whatParts(demo, forge = null, tg = null, hide = null) {
  // behold#746: a tool's page leaves out each part that names what it may not.
  if (hide) return whatParts(demo, forge, tg).filter((p) => !hide(p.text) && !hide(p.short));
  const sc = demo && typeof demo.scenario === "string" ? demo.scenario : null;
  const f = forge && FORGES[forge] ? FORGES[forge] : null;
  // behold#741: a terragucci repo's line: terragucci (behold ships no terragucci mark, so its name alone), the engine
  // its jobs run with its mark where behold ships one (OpenTofu's; Terraform's name alone), then the same as chant's.
  const tool = tg ? whatTool(tg.tools) : null;
  const head = tg
    ? [{ text: "terragucci", short: "terragucci" }, ...(tool ? [{ text: tool.name, short: tool.name, ...(tool.logo ? { logo: tool.logo } : {}) }] : [])]
    : [{ text: "chant's pull-request pipeline", short: "chant pipeline", logo: "chant" }];
  return [
    ...head,
    ...(f ? [{ text: `on ${f.label}`, short: f.label, logo: forge }] : []),
    ...(sc ? [{ text: SCENARIO_WORDS[sc] || sc.replace(/-/g, " "), short: SCENARIO_WORDS[sc] || sc.replace(/-/g, " ") }] : []),
    { text: "live demo", short: "live" },
  ];
}
/** behold#741: the engine a terragucci repo's jobs run, from its declared tools: OpenTofu with its mark, Terraform by name alone. */
export function whatTool(tools) {
  const ts = Array.isArray(tools) ? tools : [];
  for (const id of ["opentofu", "terraform"]) {
    if (!ts.includes(id) || !TOOLS[id]) continue;
    return { id, name: TOOLS[id].name, ...(TOOLS[id].icon && !TOOLS[id].icon.image ? { logo: id } : {}) };
  }
  return null;
}
/** The line drawn: each part's logo at the words' height, at its own aspect (the marks are square), then the words. */
function whatLineEl(demo, forge, tg = null, hide = null, own = false) {
  const line = el("span", "k-cycle k-what-line");
  const light = typeof document !== "undefined" && typeof getComputedStyle === "function" ? isLightBg(getComputedStyle(document.documentElement).getPropertyValue("--bg")) : false;
  whatParts(demo, forge, tg, hide).forEach((p, i) => {
    if (i) line.appendChild(el("span", "k-what-sep", "·"));
    const part = el("span", "k-what-part");
    const spec = p.logo && TOOLS[p.logo] && TOOLS[p.logo].icon ? TOOLS[p.logo].icon : p.logo && FORGES[p.logo] ? FORGES[p.logo] : null;
    if (spec && typeof document !== "undefined" && document.createElementNS) {
      const icon = iconSvg(document, spec, 22, { light });
      icon.setAttribute("class", `k-what-logo k-what-logo-${p.logo}`);
      // A mark drawn in its theme's one colour (chant's gold) carries it inline, so no stylesheet's fill greys it.
      if (spec.fill) {
        const gold = light ? spec.fill.light : spec.fill.dark;
        for (const n of icon.querySelectorAll("rect, path, circle, polygon, g")) n.style.fill = gold;
      }
      part.appendChild(icon);
    }
    part.append(el("span", "k-what-full", p.text), el("span", "k-what-short", p.short));
    line.appendChild(part);
  });
  if (line.setAttribute) line.setAttribute("title", whatTitle(tg, hide, own));
  whatStyle();
  return line;
}
/** The line's look: half again the old size; on a phone the logos stay and the words shorten. */
function whatStyle() {
  if (typeof document === "undefined" || !document.head || document.getElementById("k-what-style")) return;
  const st = document.createElement("style");
  st.id = "k-what-style";
  st.textContent = `.k-what-line { display: inline-flex; align-items: center; gap: 0.45em; font-size: 1.5em; font-weight: 600; color: var(--fg); }
.k-what-part { display: inline-flex; align-items: center; gap: 0.3em; white-space: nowrap; }
.k-what-logo { width: 1.25em; height: 1.25em; flex: none; }
/* chant's mark is pixel-sparse in its square: drawn larger, it carries the weight of Forgejo's. */
.k-what-logo-chant { width: 1.7em; height: 1.7em; }
.k-what-sep { color: var(--muted); }
.k-what-short { display: none; }
@media (max-width: 600px) { .k-what-line { font-size: 1.1em; } .k-what-full { display: none; } .k-what-short { display: inline; } }`;
  document.head.appendChild(st);
}
/** Its tooltip: whose pipeline it is, and whose demo. */
export const WHAT_TITLE = "The pipeline is chant's (chant components pr-plan / pr-apply on Forgejo). The demo stack and its driver are terragucci's.";
/** behold#741: a terragucci repo's: the pipeline, the stack and the driver are all terragucci's. */
export const WHAT_TITLE_TG = "The pipeline is terragucci's (its waves, one job per wave). The demo stack and its driver are terragucci's.";
/** behold#752: chant's own fan-out demo, from its own records: the pipeline, the stack and the driver are all chant's. */
export const WHAT_TITLE_CHANT = "The pipeline is chant's (chant components pr-plan / pr-apply on Forgejo). The demo stack and its driver are chant's too.";
/** behold#746: the tooltip, less each sentence a tool's page may not say (`/chant-fanout` keeps whose pipeline it is). */
export function whatTitle(tg = null, hide = null, own = false) {
  const t = tg ? WHAT_TITLE_TG : own ? WHAT_TITLE_CHANT : WHAT_TITLE;
  return hide ? t.split(/(?<=\.) /).filter((x) => !hide(x)).join(" ") : t;
}

/** behold#631: the step a chant kiosk's strip lights: a wait for approval before the merge is "planned" when the strip has no approval stop. */
export function railStep(s, demo) {
  const strip = s.strip || STRIP;
  return s.chantLoop && ["waiting", "approved"].includes(demo.step) && !strip.some((x) => x.id === APPROVAL_STOP.id) ? "planned" : demo.step;
}

/** behold#571 (#631): the words of the strip's approval stop, a gate before the merge. */
export const APPROVAL_STOP = { id: "approval", words: "approval" };

/**
 * behold#571 (#631): the strip in a scenario's own order, from the steps its
 * tool's recorded cycle went through (/api/terragucci/cycles/<tool>). A wait
 * for an approval before the merge (chant's pull-request loop gates the plan
 * before it merges) is a stop of its own between "planned" and "merged"; after
 * the merge it is part of the waves, as terragucci's waves are. Null when the
 * steps say nothing, so the default strip stands.
 */
export function stripFromSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) return null;
  const words = Object.fromEntries(STRIP.map((x) => [x.id, x.words]));
  const stops = [];
  let merged = false;
  for (const step of steps) {
    if (step === "merged") merged = true;
    const id = ["pull-request", "planned", "merged", "applied", "reset"].includes(step) ? step : (step === "waiting" || step === "approved") && !merged ? APPROVAL_STOP.id : "waves";
    let stop = stops.find((x) => x.id === id);
    if (!stop) {
      stop = { id, words: id === APPROVAL_STOP.id ? APPROVAL_STOP.words : words[id] || id, steps: [] };
      stops.push(stop);
    }
    if (!stop.steps.includes(step)) stop.steps.push(step);
  }
  // A stop the default strip has and these steps never reached (the waves of a run that applied in one go) keeps its place.
  for (const d of STRIP) if (!stops.some((x) => x.id === d.id)) stops.splice(Math.min(stops.length, STRIP.indexOf(d)), 0, { id: d.id, words: d.words, steps: d.steps.filter((st) => !stops.some((x) => x.steps.includes(st))) });
  return stops;
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

/**
 * behold#571: how far the driver's wait for its next action has gone, for the
 * bar under "next, by the driver". The bar fills from `next.from` (when the
 * driver started waiting; an older driver leaves it out) to `next.at`. Without `from`
 * it fills from `seen`, when this page first saw that deadline; null when the
 * page joined the countdown midway, and then there is no bar, only the words.
 *
 * kind is "fill" (fraction 0..1), "due" (the deadline passed: a full bar that
 * pulses until the step changes), "wait" (no deadline: the driver waits on the
 * pipeline, a quiet shimmer) or "none" (no bar).
 */
export function nextProgress(next, now = new Date(), seen = null) {
  if (!next) return { kind: "none", fraction: null };
  if (!next.at) return { kind: "wait", fraction: null };
  const at = Date.parse(next.at);
  if (Number.isNaN(at)) return { kind: "none", fraction: null };
  const t = now.getTime();
  if (t >= at) return { kind: "due", fraction: 1 };
  const parsed = next.from ? Date.parse(next.from) : NaN;
  const from = Number.isNaN(parsed) ? seen : parsed;
  if (typeof from !== "number" || !Number.isFinite(from) || from >= at) return { kind: "none", fraction: null };
  return { kind: "fill", fraction: Math.min(1, Math.max(0, (t - from) / (at - from))) };
}

/**
 * behold#571: when this page first saw each deadline, for nextProgress's
 * `seen`. The deadline on screen when the page loaded, or when the mode
 * changed (live, replay), was seen midway: its `seen` is null. One that came
 * after is seen at `nowMs`. `next` is demo.json's next (null when it has
 * none), or undefined while no demo.json has been read. Returns the memo to
 * keep for the next call.
 */
export function nextSeen(memo, next, mode, nowMs) {
  // No demo.json read yet: nothing watched.
  if (next === undefined) return memo;
  const key = next && next.at ? `${next.action}|${next.at}` : null;
  if (memo && memo.mode === mode && memo.key === key) return memo;
  return { key, mode, seen: memo && memo.mode === mode && key ? nowMs : null };
}

/** The period of the due bar's pulse and the shimmer's sweep; the redraw rebuilds the bar each second, so it carries its phase. */
export const NEXT_BAR_MS = 2400;

/** behold#571: the bar under "next, by the driver", in the step's tone (theme.js barInks). It never takes room: CSS places it. */
function nextBar(demo, now, s) {
  const p = nextProgress(demo.next, now, s && s.nextSeen ? s.nextSeen.seen : null);
  const bar = el("span", `k-nbar k-nbar-${p.kind}`);
  if (bar.dataset) bar.dataset.kTone = stepTone(demo.step);
  if (bar.setAttribute) bar.setAttribute("aria-hidden", "true");
  const fill = el("span", "k-nbar-in");
  if (fill.style && fill.style.setProperty) {
    if (p.fraction !== null) fill.style.setProperty("--k-nbar-fill", String(Math.round(p.fraction * 1000) / 1000));
    fill.style.setProperty("--k-nbar-phase", `-${Date.now() % NEXT_BAR_MS}ms`);
  }
  bar.appendChild(fill);
  return bar;
}

/** The driver's next action, as the kiosk says it. */
export function nextWords(demo, now = new Date()) {
  if (!demo.next) return { action: "reset and start the next cycle", when: "the driver stalled; it resets and starts the next cycle", secs: null };
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
    return { stage: "pull-request", note: demo.pull === null ? "The pull request opens next." : `The pipeline is planning pull request #${demo.pull}.` };
  }
  return { stage: "apply", note: demo.commit ? `The pipeline writes the run view of ${demo.commit.slice(0, 8)} as the waves start.` : "The first run starts next." };
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
    .map((r) => `${r.root} reads ${r.unknown.join(", ")} from ${r.upstream}, set when ${r.upstream} applies.`);
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

/** The cycle's pull request number for the frame (`pull` view key), or null before one opens and on the base. */
export function framePull(demo) {
  if (!demo || demo.scenario === "base" || demo.step === "reset") return null;
  return demo.pull !== null && demo.pull !== undefined && /^\d+$/.test(String(demo.pull)) ? String(demo.pull) : null;
}

/** The framed view's address: behold's own page, bare, at a zoom (the resources zoom unless told), told who its host is. */
export function frameSrc(origin, zoom = "resources", repo = null, theme = null) {
  const q = new URLSearchParams({ embed: "1", bare: "1", zoom, host: origin });
  if (repo) q.set("repo", repo); // behold#571: the checkout the frame draws, on a behold that serves several
  if (theme) q.set("theme", theme); // behold#571: the kiosk's theme, which the frame follows
  return `/?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// #571: which of behold's two views the frame shows. On a terragucci repo
// (`terragucci.components.json`) every step leads to the components zoom:
// one card per root in a box per wave, titled with the job that applies it,
// in step with the jobs pane. Before the merge it draws the pull request's
// planned waves, and from the merge on the run's. Resources, what the change
// touches resource by resource, is one click away. A viewer's click on the
// toggle holds a view for PICK_HOLD_MS after their last click, as a run
// picked in the sidebar does; then the step leads again.

/** The two views the toggle offers, with behold's zoom for each, and what each shows. */
export const VIEWS = [
  { id: "resources", words: "Resources", zoom: "resources", shows: "each resource the change touches" },
  { id: "components", words: "Components", zoom: "components", shows: "the pipeline's jobs and waves" },
];

/**
 * The view a step shows: the components at every step (behold#571), the
 * pull request's planned waves before the merge and the run's from it on.
 * A step behold doesn't know keeps the components too.
 */
export const STEP_VIEW = {
  "pull-request": "components",
  planned: "components",
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
export function kioskView(demo, { components = false, pick = null, now = Date.now(), ask = false } = {}) {
  // behold#939: a prompt-driven step draws every root expanded to its resources, whatever the toggle held.
  // `ask`: the scenario is in ask mode (askHeld), so its steps without a prompt (merged, applying, waiting) draw the estate too, never a pipeline view.
  if (ask || hasAsk(demo)) return { view: "resources", pinned: false, secs: null };
  if (!components) return { view: "resources", pinned: false, secs: null };
  if (pick && VIEWS.some((v) => v.id === pick.view)) {
    const left = pick.at + PICK_HOLD_MS - now;
    if (left > 0) return { view: pick.view, pinned: true, secs: Math.ceil(left / 1000) };
  }
  return { view: demo ? stepView(demo.step) : "components", pinned: false, secs: null };
}

/**
 * Ask mode holds for a whole scenario. `held` is the key (`cycle|scenario`) the mode was on for; a step with a
 * prompt turns it on for its scenario, a step without one keeps it while it is the same scenario, and a step of
 * another scenario (a reset into one with no asks) lets it go. Returns the key to hold, or null.
 */
export function askHeld(held, demo) {
  if (!demo) return null;
  const key = `${demo.cycle}|${demo.scenario}`;
  if (hasAsk(demo)) return key;
  return held === key ? key : null;
}

/** behold#571: the static frame's title, over the legend; collapsed, its one line. */
export const READ_TITLE = "How to read this";

/** behold#571: where a viewer's choice to fold "How to read this" is kept, in their own browser. */
export const READ_STORE = "behold.kiosk.read";

/**
 * behold#571: the legend of the view shown, one row per mark: what a card, a
 * box, a solid arrow and a dashed arrow are, the waves' order, and what the
 * forge and tool marks name. `[{ mark, words }]`, `mark` one of card, box,
 * solid, dashed, order, marks. Short items, two to a line, so the open
 * frame stays a few lines over the graph. Its words follow the view and the
 * tool alone, never the step.
 */
export function readingRows(view, tool = null) {
  const root = rootWord(tool);
  const n = rootNoun(tool);
  // behold#746: a fan-out's page keeps the legend /kiosk shows for it.
  if (reportless(kioskVendorOf(tool))) {
    if (view !== "components") return [{ mark: "box", words: `Box: ${root} with its own state.` }];
    return [
      { mark: "card", words: `Card: ${root} with its own state.` },
      { mark: "box", words: "Box: a wave of components that apply together." },
      { mark: "solid", words: "Arrow: a component reading another's outputs." },
    ];
  }
  const arrows = [
    { mark: "solid", words: "Solid arrow: a read of applied outputs." },
    { mark: "dashed", words: "Dashed arrow: planned values, before they apply." },
  ];
  if (view === "components") {
    return [
      { mark: "card", words: `Card: ${root} with its own state.` },
      { mark: "box", words: "Box: a wave, titled with the job that applies it." },
      ...arrows,
      { mark: "order", words: `Waves apply in order, ${n.many} in a wave together.` },
      { mark: "marks", words: "Marks: the forge and the tools a job runs." },
    ];
  }
  return [
    { mark: "box", words: `Box: ${root} with its own state.` },
    { mark: "card", words: "Card: one of its resources." },
    ...arrows,
    { mark: "marks", words: "Marks: the tools each job runs, in the jobs pane." },
  ];
}

/**
 * behold#571: "How to read this", the graph pane's static frame. A header
 * that folds it, and the legend of the view shown. Drawn again only when the
 * view or the tool changes (the caller keys it), never per step.
 */
export function renderReading(host, view, tool, { open = true, onToggle = () => {} } = {}) {
  if (!host) return;
  host.replaceChildren();
  host.hidden = false;
  const head = el("button", "k-read-head", READ_TITLE);
  head.type = "button";
  if (head.setAttribute) head.setAttribute("aria-expanded", String(open));
  if (head.addEventListener) head.addEventListener("click", () => onToggle(!open));
  host.appendChild(head);
  if (host.classList) host.classList.toggle("k-read-open", open);
  if (!open) return;
  const list = el("ul", "k-read-rows");
  for (const r of readingRows(view, tool)) {
    const li = el("li", "k-read-row");
    const mark = el("span", `k-read-mark k-read-${r.mark}`);
    if (mark.setAttribute) mark.setAttribute("aria-hidden", "true");
    li.append(mark, el("span", "k-read-words", r.words));
    list.appendChild(li);
  }
  host.appendChild(list);
}

/** behold#571: the viewer's fold of "How to read this": true open, false folded, null when they never chose. */
export function readStored(store) {
  try {
    const v = store && store.getItem(READ_STORE);
    return v === "open" ? true : v === "closed" ? false : null;
  } catch {
    return null;
  }
}

/**
 * behold#765: whether chant's demo (`--chant-demo`, the page's own reads) has its graph on this behold. A behold
 * serving one checkout (/api/project names no `viewRepos`) was paired with the demo by its operator, so the frame is
 * the demo's repo; one serving several (`--repos`) draws it when it serves the step's repo by name. `single` is null
 * until /api/project answers. Neither terragucci's answer nor a report naming the repo is asked for: there is none.
 */
export function demoFrameOk(own, single, repo, viewRepos) {
  if (!own) return false;
  if (single === true) return true;
  return !!repoParam(repo, viewRepos);
}

/** Whether a tool's pipeline writes no terragucci reports or run view (VENDORS' `reports: false`). */
export function reportless(vendor) {
  return !!vendor && vendor.reports === false;
}

/** Whether /api/project's answer is a chant project: behold draws its components itself. */
export function chantProject(p) {
  return !!p && Array.isArray(p.memberKinds) && p.memberKinds.includes("chant");
}

/** The tool the page shows: its own on a tool's page, else the running scenario's (demo.json `tool`). */
export function nounTool(s) {
  if (s.vendor) return s.vendor;
  const d = s.demo && s.demo.demo;
  return d && typeof d.tool === "string" ? d.tool : null;
}

/** The behold zoom for a view. */
export function viewZoom(view) {
  const v = VIEWS.find((x) => x.id === view);
  return v ? v.zoom : "resources";
}

/**
 * The toggle, "Resources | Components", over the frame: the view shown
 * pressed, and a line saying whether the step leads or a click holds it
 * (behold#779: a tap, on a touch screen). Not drawn at all when the repo
 * offers no components zoom.
 */
export function renderViewToggle(host, shown, { components = false, onPick = () => {}, touch = touchScreen() } = {}) {
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
    b.setAttribute("title", v.shows);
    b.setAttribute("aria-pressed", String(v.id === shown.view));
    b.addEventListener("click", () => onPick(v.id));
    group.appendChild(b);
  }
  host.appendChild(group);
  const on = VIEWS.find((v) => v.id === shown.view);
  const lead = shown.pinned ? `held by a ${touch ? "tap" : "click"}; the step leads again in ${shown.secs} s` : "follows the step";
  host.appendChild(el("span", "k-view-note", on ? `${on.shows} · ${lead}` : lead));
}

/** The one-line facts under the view: the pull request's totals, cost and blast radius, as #568 has them. */
export function factLines(demo, answer, tool = null) {
  const pr = demo ? matchingPull(answer, demo) : null;
  if (!pr) return [];
  const out = [];
  const totals = totalsLine(pr.totals);
  if (totals) out.push(`pull request #${pr.run.pull_request} changes ${rootsCount(pr.totals_roots, rootNoun(tool)) || `across ${rootNoun(tool).many}`}: ${totals}`);
  const b = blastRows(answer);
  if (b && b.changed.length) out.push(`blast radius: ${b.changed.join(", ")}${b.downstream.length ? `; downstream, nearest first: ${b.downstream.join(", ")}` : ""}`);
  if (b && b.unplanned.length) out.push(`unchanged: ${b.unplanned.join(", ")}`);
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

/**
 * Draw the header from what the kiosk holds. Pure over its arguments, but for
 * the DOM. behold#571: the lead block on the left (the scenario, its two
 * beats, its progress, the pull request's facts and, on a tool's page, the
 * credit), the hold panel on the right. The page has no footer: the legend is
 * the graph pane's "How to read this". `_foot` is ignored, kept for callers.
 */
export function renderKiosk(bar, s, now = new Date(), _foot = null) {
  bar.replaceChildren();
  if (_foot) _foot.replaceChildren();
  drawBar(bar, s, now);
}

/** behold#571: the card's first beat, as the lead block labels it. */
export const BEAT_CHANGES = "What changes";

/** behold#571: the lead block's line of the pull request's facts: factLines, as one line. */
export function factsLine(demo, answer, tool = null) {
  return factLines(demo, answer, tool).join(" · ");
}

/**
 * behold#571: the hold panel's head: its wave, its run and its plan, as
 * "Wave 2 · run #3605 · plan 02812a1b". Without a wave, the pull request or
 * the commit the note is about. Null when it knows none of these.
 */
export function holdHead({ wave = null, run = null, digest = null, pull = null, commit = null } = {}) {
  const parts = [];
  if (Number.isInteger(wave)) parts.push(`Wave ${wave}`);
  if (Number.isInteger(run)) parts.push(`run #${run}`);
  if (digest && digestHex(digest)) parts.push(`plan ${digestHex(digest).slice(0, 8)}`);
  if (!parts.length && pull !== null && pull !== undefined && pull !== "") parts.push(`Pull request #${pull}`);
  if (!parts.length && commit) parts.push(`Merge ${String(commit).slice(0, 8)}`);
  return parts.length ? parts.join(" · ") : null;
}

/** Report minor 34: Inspect's note lines for a cone plan, the same words as Watch's caption (kiosk-watch.js coneCaption); none for any other plan. */
export function coneLines(demo, answer) {
  const c = coneCaption(demo, answer);
  if (!c) return [];
  return [{ cls: "k-note k-cone-note", text: c.line }, ...(c.backend ? [{ cls: "k-note k-cone-backend", text: c.backend }] : [])];
}

/**
 * behold#571: what the hold panel holds, or null for nothing: how the hold
 * ends (from the records), else the driver's approval, else the run's note.
 * `{ kind, wave, head, … }`; `wave` is the wave it lights, when it has one.
 */
export function holdModel(s, demo) {
  const vendor = vendorOf(s.vendor);
  if (s.approval) return { kind: "approval", wave: s.approval.wave, head: holdHead({ wave: s.approval.wave, run: s.approval.run, digest: s.approval.digest }), model: s.approval };
  const appr = pendingApproval(demo, s.progress);
  if (appr) return { kind: "driver", wave: appr.wave, head: holdHead({ wave: appr.wave, digest: appr.digest }), appr };
  if (s.noReports || reportless(vendor || kioskVendorOf(demo.tool))) return null;
  const panel = runPanel(demo, s.answer, s.progress);
  const lines = panel.note ? [{ cls: "k-note", text: panel.note }] : panel.stage === "pull-request" ? [...coneLines(demo, s.answer), ...unreviewedLines(s.answer).map((u) => ({ cls: "k-note k-unknown", text: u }))] : [];
  if (!lines.length) return null;
  const head = holdHead(panel.stage === "pull-request" ? { pull: demo.pull } : { commit: demo.commit });
  return { kind: "note", wave: null, head, lines };
}

function drawBar(bar, s, now) {
  const vendor = vendorOf(s.vendor);
  // behold#571: in Watch the header is one quiet line; the narration is the caption over the graph.
  if (s.watchMode && s.demo && s.demo.demo && !(vendor && s.mode === "none")) return drawWatchHead(bar, s, now);
  if (vendor && s.mode === "none") {
    // behold#571: the tool's scenario has no cycle yet: its name, its link, and a calm line.
    const words = notRunWords(vendor, { graph: !!s.notRunGraph });
    const box = el("div", "k-empty");
    const title = el("h1", "k-title");
    title.append(brandEl(vendor), el("span", "k-title-text", words.title));
    box.append(title, el("p", "k-muted", words.text));
    drawCredit(box, s.vendor);
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
    if (vendor) drawCredit(box, s.vendor);
    bar.appendChild(box);
    return;
  }
  const demo = s.demo.demo;
  const head = scenarioHead(demo, { vendor: s.vendor || null });

  // behold#571: a tool's page says plainly when it replays an earlier run, and when it can't draw the repo's graph.
  if (s.replay && s.replay.asked) bar.appendChild(askedLine(s));
  else if (s.replay && s.replay.banner) bar.appendChild(el("p", "k-replay", s.replay.banner));
  if (vendor && s.noReports && (s.mode === "live" || s.mode === "replay")) bar.appendChild(el("p", "k-nograph-note", NO_GRAPH_WORDS));
  const intro = introText(demo);

  // behold#571: the lead block, a grid of labelled rows: the title (its tool, kicker and the
  // scenario's progress on a quiet line over it), then each beat on a row of its own, its label
  // in a fixed column and its words in the next, each row a fixed box with a rail down its left.
  const left = el("div", "k-left k-lead");
  const titleBox = box("title", "k-box-title");
  const over = el("div", "k-overline");
  // behold#571: /kiosk names the tool each scenario runs on, as its own page does.
  // behold#746: but for a fan-out, whose brand its own page alone carries.
  const shownTool = vendor || (demo.scenario !== "base" ? kioskVendorOf(demo.tool) : null);
  if (shownTool) over.appendChild(brandEl(shownTool));
  over.appendChild(el("span", "k-kicker", head.kicker));
  // The scenario's progress: the strip's stops, at the end of the line over the title.
  const strip = el("ol", "k-strip");
  // behold#631: a chant pull request's wait for its approval comes before its merge. Without a stop of its own on the
  // strip it shows as "planned", for the fix's pull request as for the first.
  for (const stop of stripStops(railStep(s, demo), s.strip || STRIP)) strip.appendChild(el("li", `k-stop k-${stop.state}`, stop.words));
  over.appendChild(strip);
  const title = el("h1", "k-title");
  title.appendChild(el("span", "k-title-text", head.title));
  if (title.setAttribute) title.setAttribute("title", `${head.kicker} · ${head.title || ""}`);
  titleBox.append(over, title);
  // behold#777: a phone's line on what this is, under the title (hidden wider, so the title's box keeps its height).
  const introWords = introFor(s);
  if (introWords) titleBox.appendChild(el("p", "k-w-intro", introWords));
  left.appendChild(titleBox);

  // The first beat: what changes; between scenarios, what the demo is about.
  const rows = aboutRows(demo);
  const changes = rows.find((r) => r.label === BEAT_CHANGES);
  if (demo.step === "reset" && intro) left.appendChild(leadRow("changes", "k-row-beat", INTRO_HEAD, el("p", "k-intro", intro)));
  else if (changes) left.appendChild(leadRow("changes", "k-row-beat", changes.label, elRoots("p", "k-beat", changes.text, s)));
  else left.appendChild(leadRow("changes", "k-row-beat"));

  // The second beat: the step, what just happened and why it stands where it does. Its rail takes the step's state.
  const stepRow = leadRow("step", `k-row-step k-step-${demo.step}`, STEP_WORDS[demo.step] || demo.step, elRoots("p", "k-step", demo.label, s));
  if (stepRow.dataset) stepRow.dataset.kTone = stepTone(demo.step);
  left.appendChild(stepRow);

  // Next: the driver's action, with its countdown.
  const nx = nextWords(demo, now);
  const next = el("p", "k-next");
  next.append(elRoots("span", "k-action", nx.action, s), " ", el("span", "k-when", nx.when), " ", el("span", "k-next-by", "by the driver"));
  const nextRow = leadRow("next", "k-row-next", "Next", next);
  nextRow.appendChild(nextBar(demo, now, s));
  left.appendChild(nextRow);

  // The rest of the card, quieter: each field on its own row (watch for, then what the scenario shows).
  const more = demo.step === "reset" && intro ? [] : rows.filter((r) => r !== changes);
  for (const [i, name] of ["watch", "shows"].entries()) {
    const r = more[i];
    left.appendChild(r ? leadRow(name, "k-row-more", r.label, elRoots("p", "k-about", r.text, s)) : leadRow(name, "k-row-more"));
  }
  // The live carve's slowed playback, a quiet row of its own once the frame draws one: real time unless a person slows it.
  const slowed = s.slowedControl ? s.slowedControl() : null;
  if (slowed) left.appendChild(leadRow("slowed", "k-row-more", "Playback", slowed));

  // The pull request's facts, each a chip that wraps whole; never cut off. behold#571: no line on where the narration was read from.
  const factParts = s.noReports ? [] : factLines(demo, s.answer, nounTool(s));
  if (factParts.length) {
    const p = el("p", "k-facts");
    for (const part of factParts) p.appendChild(elRoots("span", "k-fact", part, s));
    left.appendChild(leadRow("facts", "k-row-facts", FACTS_LABEL, p));
  } else left.appendChild(leadRow("facts", "k-row-facts"));
  // behold#571: a tool's page ends its lead block with who makes the tool, and that they don't endorse the demo.
  if (vendor) drawCredit(left, s.vendor);
  bar.appendChild(left);

  // behold#571: the hold panel, headed with its wave and run, lit as its job row and its wave box are.
  const right = el("div", "k-right");
  // The cycle, quiet over the hold panel: how long this run of the scenario has gone.
  right.appendChild(el("p", "k-cycle", cycleWords(demo, now)));
  const holdBox = box("hold", "k-box-hold");
  const hold = holdModel(s, demo);
  if (hold) {
    // A wave held lights in the waiting tone; a run's note stays quiet.
    holdBox.className += hold.wave !== null ? " k-hold k-hold-wave" : " k-hold";
    if (hold.wave !== null && holdBox.dataset) holdBox.dataset.kWave = String(hold.wave);
    if (hold.head) holdBox.appendChild(el("p", "k-hold-head", hold.head));
    if (hold.kind === "approval") holdBox.appendChild(approvalPanel(hold.model, s));
    else if (hold.kind === "driver") {
      const appr = hold.appr;
      const a = el("div", "k-approve");
      a.appendChild(elRoots("p", "k-approve-gloss", approveGloss(appr), s));
      a.appendChild(el("code", "k-command", appr.approve));
      const then = el("p", "k-approve-then");
      then.append(`then comments `, el("code", "k-inline", appr.comment), ` on ${appr.on}, and the waves run again.`);
      a.appendChild(then);
      holdBox.appendChild(a);
    } else for (const l of hold.lines) holdBox.appendChild(elRoots("p", l.cls, l.text, s));
  }
  // behold#801: each finished wave's trace, as Watch's result card shows them, under the hold (or in its place).
  const traces = el("section", "k-i-traces");
  drawWaveTraces(traces, s);
  if (!traces.hidden) holdBox.appendChild(traces);
  // behold#571: render what's present: an empty hold keeps its place (nothing moves when one comes) but draws no box.
  if (!holdBox.children.length) holdBox.className += " k-box-empty";
  right.appendChild(holdBox);
  bar.appendChild(right);
}

/** behold#571: the label of the lead block's row of the pull request's facts. */
export const FACTS_LABEL = "The change";

/** behold#571: the tone the step row's rail takes from the step: Watch's caption's (kiosk-watch.js), so both layouts light it alike. */
export { stepTone };

/**
 * behold#571: a row of the lead block: its label in the fixed column, its
 * words in a fixed box beside it (they scroll inside it, the page never
 * moves). With no words, the row keeps its place and draws nothing.
 */
function leadRow(name, cls, label = null, content = null) {
  const row = el("div", `k-row ${cls}${content ? "" : " k-row-empty"}`);
  if (content) {
    row.appendChild(el("span", "k-row-label", label));
    const b = box(name, "k-row-box");
    b.appendChild(content);
    row.appendChild(b);
  }
  return row;
}

// ---------------------------------------------------------------------------
// behold#571: Watch, the kiosk's default. web/kiosk-watch.js decides what each
// piece says and where it goes; these draw it.

/** The mode toggle, "Watch | Inspect", in the header's tools. */
export function renderModeToggle(host, mode, onPick) {
  if (!host) return;
  host.replaceChildren();
  for (const m of MODES) {
    const b = el("button", `k-mode${m.id === mode ? " k-mode-on" : ""}`, m.words);
    b.type = "button";
    b.setAttribute("title", m.shows);
    b.setAttribute("aria-pressed", String(m.id === mode));
    b.addEventListener("click", () => onPick(m.id));
    host.appendChild(b);
  }
}

/** behold#779: a touch screen (a phone), where the viewer taps rather than clicks. */
export function touchScreen() {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/**
 * behold#571: the words over a held shot, and the button that follows the step again.
 * behold#779: on a touch screen a tap held it, often a stray one, so the words say so and the button is a big one.
 */
export function heldWords(secs, touch = false) {
  return touch ? `Paused where you tapped · the steps go on in ${secs} s` : `Held where you left it · the steps lead again in ${secs} s`;
}
/** behold#787: the button that ends a replay the viewer asked for. */
export const BACK_WORDS = "Back to live";
/** behold#787: the done card's chip that replays the cycle's failure. */
export const FAILURE_WORDS = "Replay the failure";
/** behold#787: how long a replay the viewer asked for runs with no input before the kiosk is live again. */
export const REPLAY_IDLE_MS = 180_000;

/** behold#787: whether the replay is one the viewer asked for, which the live poll leaves alone. */
export function viewerReplay(s) {
  return !!s && s.mode === "replay" && !!s.replay && !!s.replay.asked;
}

/** behold#787: whether a replay the viewer asked for is over: it reached the cycle's last step (the reset), or `idle` ms went by with no input. */
export function replayOver(steps, elapsed, idle) {
  if (!Array.isArray(steps) || !steps.length) return true;
  return replayAt(steps, elapsed).index === steps.length - 1 || idle > REPLAY_IDLE_MS;
}

/** behold#787: the banner of a replay the viewer asked for, with its way back to live. */
export function askedLine(s) {
  const p = el("p", "k-replay k-replay-asked", null);
  p.setAttribute("role", "status");
  p.appendChild(el("span", "k-replay-words", s.replay.banner || "Replay of the latest run"));
  const b = el("button", "k-replay-back", BACK_WORDS);
  b.type = "button";
  b.addEventListener("click", () => s.backToLive && s.backToLive());
  p.appendChild(b);
  return p;
}
export const FOLLOW_WORDS = "Follow the steps";
export const RESUME_WORDS = "Resume now";
/** behold#779: how long a tap on a touch screen holds Watch's shot (a click holds it PICK_HOLD_MS). */
export const TAP_HOLD_MS = 20_000;

/**
 * A paused Watch, said at the foot of the screen with its resume (kiosk.html shows it on a touch screen only): on a
 * phone the header that also says it is scrolled away by the time a tap on the graph paused it.
 */
function drawHeldOver(doc, s) {
  const over = doc && doc.getElementById ? doc.getElementById("k-held-over") : null;
  if (!over) return;
  over.hidden = !s.watchHeld;
  if (!s.watchHeld) return void over.replaceChildren();
  const b = el("button", "k-w-resume", RESUME_WORDS);
  b.type = "button";
  b.addEventListener("click", () => s.followSteps && s.followSteps());
  over.replaceChildren(el("span", "k-held-words", heldWords(s.watchHeld.secs, true)), b);
}

/** Watch's header: the scenario's place and the strip on the left, the delivery numbers on the right. */
function drawWatchHead(bar, s, now) {
  const demo = s.demo.demo;
  const vendor = vendorOf(s.vendor);
  const place = el("div", "k-w-place");
  const shownTool = vendor || (demo.scenario !== "base" ? kioskVendorOf(demo.tool) : null);
  if (storyOn(s) && s.trackOn) {
    // behold#631: a chant kiosk names what this is in one line; the cycle number and its clock are Inspect's.
    // behold#741: a terragucci repo's chapter-carrying scenario names terragucci, its engine and its forge.
    // behold#746: a tool's page leaves out the parts (and the tooltip's sentence) that name what it may not.
    // On its replay the line's "live demo" goes; the replay's banner follows the line instead.
    // behold#787: and on a replay the viewer asked for.
    const asked = !!(s.replay && s.replay.asked);
    const hide = vendor || asked ? (t) => (!!vendor && namesOther(t, s.vendor)) || (s.mode === "replay" && /^live\b/.test(t)) : null;
    if (s.chantLoop) place.appendChild(whatLineEl(demo, s.chantForge ? s.chantForge() : null, null, hide, s.source === "chant-demo"));
    else place.appendChild(whatLineEl(demo, s.tgForge || null, { tools: s.tools || [] }, hide));
  } else {
    if (shownTool) place.appendChild(brandEl(shownTool));
    place.appendChild(el("span", "k-cycle", cycleWords(demo, now)));
  }
  // behold#746: a tool's page says in Watch too that it replays an earlier run.
  if (vendor && s.mode === "replay" && s.replay && s.replay.banner && !s.replay.asked) place.appendChild(el("span", "k-cycle k-w-replay", s.replay.banner));
  bar.appendChild(place);
  if (s.mode === "replay" && s.replay && s.replay.asked) bar.appendChild(askedLine(s));
  const intro = introFor(s);
  if (intro) bar.appendChild(el("p", "k-w-intro", intro));
  // A phone leads with what the demo shows (kiosk.html shows it there only); the caption's copy of it goes.
  if (demo && demo.title) bar.appendChild(el("p", "k-w-point", demo.title));
  const strip = el("ol", "k-strip");
  // behold#631: a chant pull request's wait for its approval comes before its merge. Without a stop of its own on the
  // strip it shows as "planned", for the fix's pull request as for the first.
  for (const stop of stripStops(railStep(s, demo), s.strip || STRIP)) strip.appendChild(el("li", `k-stop k-${stop.state}`, stop.words));
  // behold#631: a chant kiosk's projected track says where the cycle is; the rail goes.
  if (!s.trackOn) bar.appendChild(strip);
  if (s.watchHeld) {
    const touch = touchScreen();
    const p = el("span", "k-w-held", heldWords(s.watchHeld.secs, touch));
    const b = el("button", "k-w-resume", touch ? RESUME_WORDS : FOLLOW_WORDS);
    b.type = "button";
    b.addEventListener("click", () => s.followSteps && s.followSteps());
    p.appendChild(b);
    bar.appendChild(p);
  }
  drawHeldOver(bar.ownerDocument, s);
  const dora = doraLine(s.metrics);
  if (dora) {
    const p = el("p", "k-w-dora", dora);
    if (p.setAttribute) p.setAttribute("title", [dora, s.metrics && s.metrics.windowNote, s.metrics && s.metrics.note].filter(Boolean).join(". "));
    bar.appendChild(p);
  }
}

/** The caption along the bottom: the title, what changes, the step; one of the two beats leads. */
function drawCaption(host, s, now) {
  host.replaceChildren();
  const demo = s.demo && s.demo.demo;
  const cap = captionModel(demo, { vendor: s.vendor || null, now, answer: s.answer });
  if (!cap) return;
  if (s.chantCaptionStep) cap.step = s.chantCaptionStep(demo, cap.step);
  const top = el("div", "k-cap-top");
  const title = el("h1", "k-cap-title");
  // behold#631: a chant kiosk with its track drops "Scenario 1 of 1": the track says where the cycle is.
  const told = s.storyDemo ? s.storyDemo(demo) : demo;
  const ch = storyOn(s) && told && told.chapter && Number.isInteger(told.chapter.n) ? told.chapter : null;
  if (!(storyOn(s) && s.trackOn)) title.append(el("span", "k-kicker", cap.kicker));
  if (ch) {
    // behold#631: the story's chapter is the headline, "1 of 4 · A change to the shared network goes out to all 15 stacks",
    // fading in when the chapter turns; the scenario's point stays under it as one constant small line.
    chapterStyle();
    const words = `${ch.n} of ${ch.of} · ${ch.headline}`;
    const head = el("span", "k-title-text k-chapter-head", words);
    if (s.capChapter !== words) {
      s.capChapter = words;
      s.capChapterAt = now.getTime ? now.getTime() : Date.now();
    }
    const t = now.getTime ? now.getTime() : Date.now();
    // A redraw mid-fade carries on from where the fade is, never from the start.
    if (t - (s.capChapterAt || 0) < 900 && head.classList) {
      head.classList.add("k-chapter-in");
      if (head.style) head.style.animationDelay = `-${t - s.capChapterAt}ms`;
    }
    title.append(head);
    if (title.setAttribute) title.setAttribute("title", words);
  } else {
    title.append(el("span", "k-title-text", cap.title));
    if (title.setAttribute) title.setAttribute("title", `${cap.kicker} · ${cap.title}`);
  }
  top.appendChild(title);
  if (cap.next) {
    const nx = el("p", "k-cap-next");
    // behold#631: a chant kiosk says what comes next as one plain sentence in one font: the demo is scripted, and
    // "plan note" and "the plan's digest" are chant's own terms. A failure's next step reads as the modal's does.
    if (s.chantLoop) {
      const action = demo && demo.step === "failed" && /\bfix\b/.test(cap.next.action) ? "the fix opens" : cap.next.action.replace(/\bplan note\b/g, "plan").replace(/\bthe plan's digest\b/g, "the plan");
      const sentence = `next (scripted): ${action}${/^when\b/.test(cap.next.when) ? ", " : " "}${cap.next.when}`.replace(/\s+/g, " ").trim();
      nx.append(sentence);
      if (nx.setAttribute) nx.setAttribute("title", sentence);
    } else {
      nx.append("next, by the driver: ", elRoots("span", "k-action", cap.next.action, s), " ", el("span", "k-when", cap.next.when));
      if (nx.setAttribute) nx.setAttribute("title", `next, by the driver: ${cap.next.action}`);
    }
    nx.appendChild(nextBar(demo, now, s));
    top.appendChild(nx);
  }
  host.appendChild(top);
  if (ch && cap.title) host.appendChild(el("p", "k-cap-point", cap.title));
  const beat = cap.intro || cap.changes;
  const changes = el("p", `k-cap-row k-cap-changes${cap.lead === "changes" ? " k-cap-lead" : ""}`);
  if (beat) {
    changes.append(el("span", "k-cap-label", beat.label), elRoots("span", "k-cap-text", beat.text, s));
    if (changes.setAttribute) changes.setAttribute("title", beat.text);
  }
  host.appendChild(changes);
  const step = el("p", `k-cap-row k-cap-step k-tone-${cap.step.tone}${cap.lead === "step" ? " k-cap-lead" : ""}`);
  step.append(el("span", "k-cap-label", cap.step.word), elRoots("span", "k-cap-text", cap.step.text, s));
  if (step.setAttribute) step.setAttribute("title", cap.step.text);
  host.appendChild(step);
  // Report minor 34: a cone plan, in one quiet line: what it planned, and the estates' backend when the reports say it.
  if (cap.cone) host.appendChild(coneEl("k-cap-cone", cap.cone));
  // What used to be a card over the graph (the result, the approval): one quiet line under the label, in the caption.
  const said = stepLine(demo, { held: !!s.stageHeld, result: demo && demo.step === "applied" ? resultModel(demo, s.metrics, s.steady) : null, hold: demo && (demo.step === "waiting" || demo.step === "approved") ? holdModel(s, demo) : null });
  if (said) {
    const p = el("p", "k-cap-quiet k-cap-step-line", said);
    if (p.setAttribute) {
      p.setAttribute("data-step-line", demo.step);
      p.setAttribute("title", said);
    }
    host.appendChild(p);
  }
  // A long step with nothing new coming in: what runs, and for how long (kiosk-watch.js quietWords).
  if (s.quiet) {
    const q = quietEl("k-cap-quiet", s.quiet);
    if (q.setAttribute) {
      q.setAttribute("role", "status");
      q.setAttribute("title", s.quiet.title);
    }
    host.appendChild(q);
  }
}

/**
 * behold#781: Inspect's "The change" block (factLines: the pull request's
 * totals, its blast radius, what it leaves unchanged), for a phone's Watch,
 * where the graph's colours were its only telling. CSS shows it on a phone.
 */
function drawChange(host, s) {
  const demo = s.demo && s.demo.demo;
  const parts = demo && !s.noReports ? factLines(demo, s.answer, nounTool(s)) : [];
  host.hidden = !parts.length;
  const key = JSON.stringify([parts, s.light, s.rootNames]);
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  host.replaceChildren();
  if (!parts.length) return;
  const p = el("p", "k-facts");
  for (const part of parts) p.appendChild(elRoots("span", "k-fact", part, s));
  host.append(el("p", "k-change-label", FACTS_LABEL), p);
}

/** The cone plan's line (kiosk-watch.js coneCaption): the plan's words, then the backend's, quieter. */
export function coneEl(cls, c) {
  const p = el("p", `${cls} k-cone`);
  if (p.setAttribute) {
    p.setAttribute("data-cone-line", "");
    p.setAttribute("title", c.backend ? `${c.line} · ${c.backend}` : c.line);
  }
  p.appendChild(el("span", "k-cone-plan", c.line));
  if (c.backend) p.appendChild(el("span", "k-cone-backend", c.backend));
  return p;
}

/** The corner the framed graph's own controls take at its top right (⤢ fit at 8 px, ↺ layout at 66 px from the right edge, web/index.html), in px. Watch's overlays stay out of it. */
export const FRAME_CONTROLS = { w: 240, h: 44 };

/**
 * The quiet line's element: the driver's words, which may be cut short with an
 * ellipsis, then the running job and the time, always whole. A phone puts the
 * job and the time on a second line.
 */
export function quietEl(cls, q) {
  const p = el("p", `${cls} k-quiet`);
  if (q.said) p.append(el("span", "k-quiet-said", q.said), el("span", "k-quiet-sep", " · "));
  p.append(el("span", "k-quiet-tail", q.tail || q.text));
  return p;
}

/** The approval on the held wave's box: the step's word, the wave, its numbers, and how the hold ends. */
function drawCallout(host, s, hold, nums) {
  const keep = host.scrollTop;
  host.replaceChildren();
  host.appendChild(el("span", "k-notch"));
  host.appendChild(el("p", "k-call-word", STEP_WORDS.waiting));
  if (hold.head) host.appendChild(el("p", "k-call-head", hold.head));
  if (nums) host.appendChild(el("p", "k-call-nums", nums));
  if (hold.kind === "approval") host.appendChild(approvalPanel(hold.model, s));
  else {
    const appr = hold.appr;
    const a = el("div", "k-approve");
    a.appendChild(elRoots("p", "k-approve-gloss", approveGloss(appr), s));
    a.appendChild(el("code", "k-command", appr.approve));
    const then = el("p", "k-approve-then");
    then.append(`then comments `, el("code", "k-inline", appr.comment), ` on ${appr.on}, and the waves run again.`);
    a.appendChild(then);
    host.appendChild(a);
  }
  host.scrollTop = keep;
}

/** The drawer's head and folded lines: the job the run is on, its numbers, and the last lines its step wrote. */
function drawDrawer(host, tail, nums, open) {
  const head = host.querySelector(".k-drawer-head");
  const lines = host.querySelector(".k-drawer-tail");
  head.replaceChildren();
  if (!host.querySelector(".k-notch")) host.insertBefore(el("span", "k-notch"), head);
  head.setAttribute("aria-expanded", String(open));
  if (tail) head.append(statusIcon(tail.status), el("span", "k-drawer-job", tail.job));
  if (nums) head.appendChild(el("span", "k-drawer-nums", nums));
  head.appendChild(el("span", "k-drawer-more", open ? DRAWER_LESS : DRAWER_MORE));
  lines.replaceChildren();
  for (const l of tail ? tail.lines : []) lines.appendChild(el("div", "k-drawer-line", l));
  if (!lines.children.length) lines.appendChild(el("div", "k-drawer-line k-drawer-quiet", DRAWER_EMPTY));
}
/** behold#571: the folded drawer before the job writes a line. */
export const DRAWER_EMPTY = "The job's lines show here as it writes them.";
/** behold#571: the drawer's two states, said on its head. */
export const DRAWER_MORE = "Open the log";
export const DRAWER_LESS = "Close";

/**
 * The result card at the end of the run: the counts, and each wave's numbers.
 * behold#782: the caption under the graph already says "Applied" and the
 * step's line, so the card leads with its first count ("3 waves applied") and
 * leaves the line to the caption.
 */
export function drawResult(host, model, s) {
  host.replaceChildren();
  const [lead, ...rest] = model.counts.length ? model.counts : [model.head];
  host.appendChild(el("p", "k-result-head", lead));
  const counts = el("ul", "k-result-counts");
  for (const c of rest) counts.appendChild(el("li", null, c));
  if (rest.length) host.appendChild(counts);
  // behold#571: a row for every wave, in wave order: its trace as one bar of its phases (a click opens the whole trace),
  // else its numbers, else a quiet line until they land. Never fewer rows than the count says.
  const bars = new Map(miniWaterfall(s.waveTraces || {}).map((r) => [r.wave, r]));
  // A composed run is one apply: no wave rows, no wave traces.
  const order = model.composed ? [] : [...new Set([...model.waves.map((w) => w.wave), ...bars.keys()])].sort((x, y) => x - y);
  if (order.length) {
    const wf = el("div", "k-wf");
    for (const n of order) {
      const r = bars.get(n);
      const w = model.waves.find((x) => x.wave === n);
      if (!r) {
        const row = el("div", "k-wf-row k-wf-plain");
        row.append(el("span", "k-wf-wave", `Wave ${n}`), el("span", w && w.words ? "k-wf-words" : "k-wf-words k-result-soon", w && w.words ? w.words : NUMBERS_SOON));
        wf.appendChild(row);
        continue;
      }
      wf.appendChild(traceRow(r, s));
    }
    if (bars.size) wf.appendChild(phaseKey());
    host.appendChild(wf);
  }
  // behold#787: a visitor who missed the failure's few seconds replays them from here.
  // The card is rebuilt every second: the press is read on the card, so a tap across a rebuild still counts.
  if (s.failureAt && s.failureAt()) {
    const b = el("button", "k-result-replay", FAILURE_WORDS);
    b.type = "button";
    host.appendChild(b);
    if (!host.krWired && host.addEventListener) {
      host.krWired = true;
      let down = 0;
      const on = (e) => !!(e.target && e.target.closest && e.target.closest(".k-result-replay"));
      host.addEventListener("pointerdown", (e) => { down = on(e) ? Date.now() : 0; });
      host.addEventListener("click", (e) => {
        const hit = on(e) || (down && Date.now() - down < 1500 && e.target === host);
        down = 0;
        if (hit && s.seekTo && s.failureAt()) s.seekTo(s.failureAt());
      });
    }
  }
}

/** behold#571: a wave's trace as one bar of its phases, a button that opens the whole trace. */
function traceRow(r, s) {
  const row = el("button", "k-wf-row");
  row.type = "button";
  const held = r.bars.find((b) => b.phase === "held");
  row.title = `${TRACE_OPEN_WORDS} · ${r.bars.map(phaseWords).join(" · ")}`;
  const track = el("span", "k-wf-track");
  for (const b of r.bars) {
    const seg = el("i", `k-wf-seg k-wf-${b.phase}`);
    seg.style.left = `${(b.at * 100).toFixed(2)}%`;
    seg.style.width = `${Math.max(0.6, b.width * 100).toFixed(2)}%`;
    seg.title = phaseWords(b);
    track.appendChild(seg);
  }
  row.append(el("span", "k-wf-wave", `Wave ${r.wave}`), track, el("span", "k-wf-ms", held ? phaseWords(held) : r.words), el("span", "k-wf-go", TRACE_LINK_WORDS));
  row.addEventListener("click", () => s.openWave && s.openWave(r.wave, "trace"));
  return row;
}

/** The phases' key under the trace rows. */
function phaseKey() {
  const key = el("p", "k-wf-key");
  for (const [cls, words] of PHASE_KEY) {
    const k = el("span");
    k.append(el("i", `k-wf-sw k-wf-${cls}`), words);
    key.appendChild(k);
  }
  return key;
}

/**
 * behold#775: on a phone, each wave's trace as soon as the wave has one, under
 * the step: the badges that open a trace on a wider screen have no room
 * there. The result card carries the same rows at the end, so this goes then.
 */
export function drawWaveTraces(host, s, { shown = true } = {}) {
  const rows = shown ? miniWaterfall(s.waveTraces || {}) : [];
  host.hidden = !rows.length;
  const key = rows.map((r) => `${r.wave}|${r.run}|${r.ms}`).join(",");
  // A host built fresh each draw (Inspect's header) may have no dataset to remember its key by.
  const ds = host.dataset || {};
  if (ds.key === key) return;
  ds.key = key;
  host.replaceChildren();
  if (!rows.length) return;
  host.appendChild(el("p", "k-w-traces-head", WAVE_TRACES_WORDS));
  const wf = el("div", "k-wf");
  for (const r of rows) wf.appendChild(traceRow(r, s));
  wf.appendChild(phaseKey());
  host.appendChild(wf);
}
/** behold#775: the head over the phone's trace rows. */
export const WAVE_TRACES_WORDS = "Each wave's trace, as it finishes";
/** behold#571: a wave's row on the result card before its numbers land. */
export const NUMBERS_SOON = "its numbers land in a moment";
/** behold#571: the words of a trace's links, and the phases' key. */
export const TRACE_LINK_WORDS = "Trace";
export const TRACE_OPEN_WORDS = "Open this wave's trace";
export const PHASE_KEY = [["plan", "plan"], ["held", "held for an approval"], ["apply", "apply"], ["report", "report and upload"]];

/** behold#571: the head over the intro, in the card's box between scenarios, and the title of "What is this?". */
export const INTRO_HEAD = "What this demo is about";

/** A fixed box of the header: its text scrolls inside it, and the page keeps its scroll across redraws by `data-box`. */
function box(name, cls = "") {
  const b = el("div", `k-box${cls ? ` ${cls}` : ""}`);
  if (b.dataset) b.dataset.box = name;
  return b;
}

/**
 * behold#571: "How this hold ends", drawn from approvalModel's rows. A row's
 * chip names the log line it rests on and shows it in the runs pane
 * (`s.showLine`).
 */
export function approvalPanel(model, s = {}) {
  const wrap = el("div", "k-ap");
  // behold#571: the hold panel's head names the wave, the run and the plan; this one says what the rows are.
  // behold#631: a chant kiosk's rows carry no times, so its head says none.
  wrap.appendChild(el("p", "k-ap-head", model.kiosk ? PANEL_TITLE : `${PANEL_TITLE} · times in UTC`));
  const list = el("ol", "k-ap-rows");
  for (const r of model.rows) {
    const li = el("li", `k-ap-row k-ap-${r.state}`);
    const mark = el("span", "k-ap-mark");
    if (mark.setAttribute) mark.setAttribute("aria-label", r.state === "lit" ? "done" : r.state === "going" ? "under way" : "not yet");
    li.append(mark, el("span", "k-ap-label", r.label));
    const text = elRoots("span", "k-ap-text", r.text, s);
    const facts = rowFacts(r);
    if (facts.length) text.appendChild(el("span", `k-ap-facts${r.seal && r.seal.ok === false ? " k-ap-bad" : ""}`, facts.join(" · ")));
    if (r.line && r.line.a) {
      const chip = annMark(r.line.a, { first: true });
      chip.dataset.annJump = "1";
      chip.title = `${r.line.a.note} Shows run #${r.line.run}, ${r.line.job}, line ${r.line.n}.`;
      const line = r.line;
      chip.addEventListener("click", () => s.showLine && s.showLine(line));
      text.append(" ", chip);
    }
    li.appendChild(text);
    if (r.command) li.appendChild(el("code", "k-command", r.command));
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}

/** behold#571: the header's line when this behold serves another repo than the page's. */
export const NO_GRAPH_WORDS = "This page shows the runs and their logs.";

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

/** behold#571: the credit on a tool's page, one quiet line at the lead block's foot, its names linked to their official sites. */
function drawCredit(host, tool) {
  const lines = creditLines(tool);
  if (!lines.length) return;
  const wrap = el("p", "k-credits");
  for (const line of lines) {
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
    wrap.append(p, " ");
  }
  host.appendChild(wrap);
}

/** behold#571: how a hovered root's name and wave's job row light: a background and, on the row, its left bar twice as wide. Nothing moves. */
export const HOVER_ROOT_RULE = "background: color-mix(in srgb, var(--focus) 32%, transparent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus) 32%, transparent); border-radius: 3px;";
export const HOVER_JOB_RULE = "background: color-mix(in srgb, var(--focus) 24%, transparent); --bar-w: 6px;";
/** behold#571: how the held wave's job row lights while the hold panel shows it: the waiting tone its wave box and the panel carry. */
export const HELD_JOB_RULE = "background: color-mix(in srgb, var(--foreign) 14%, transparent); --bar: var(--bar-foreign); --bar-w: 6px;";

/** behold#571: how often the approval panel reads the cycle's runs, and the gate ledger (which the server caches 30 s). */
export const APPROVAL_POLL_MS = 4_000;
/** behold#631: how often a chant kiosk reads its loop while the apply runs: as often as the graph's frame does. */
export const CHANT_APPLY_POLL_MS = 1_500;
export const LEDGER_POLL_MS = 10_000;

/** behold#571: the approval panel's words for the approval the driver gives next, over its command. */
export const DRIVER_SIGNS = "Next the driver plays a reviewer outside the change and signs this plan with that reviewer's key:";

/** behold#571: "What is this?" says what behold is; the demo's own intro stays on the card between scenarios. */
export const WHAT_TEXT = "This is behold, a live view of infrastructure. It draws the setup as a graph and shows its pipeline runs, their logs and the approvals they wait for, as they happen. Here it watches a demo pipeline that runs one change through several Terraform states in a loop.";
/** behold#752: the same, for chant's fan-out demo, whose stacks are CloudFormation's. */
export const WHAT_TEXT_CHANT = "This is behold, a live view of infrastructure. It draws the setup as a graph and shows its pipeline runs, their logs and the approvals they wait for, as they happen. Here it watches chant's pull-request pipeline run one change across fifteen stacks in a loop.";
/** behold#777: the same, for a terragucci repo's demo, so the popover names what the phone's intro line names. */
export const WHAT_TEXT_TG = "This is behold, a live view of infrastructure. It draws the setup as a graph and shows its pipeline runs, their logs and the approvals they wait for, as they happen. Here it watches terragucci, which applies one change to many Terraform or OpenTofu states in waves, run its demo pipeline in a loop.";
/** behold#777: "What is this?"'s words for the page: chant's pipeline, a terragucci repo's, or any other. */
export function whatTextFor({ chant = false, tg = false } = {}) {
  return chant ? WHAT_TEXT_CHANT : tg ? WHAT_TEXT_TG : WHAT_TEXT;
}
/**
 * behold#777: the phone's one line under the title, the popover's first two
 * sentences cut to one: what behold is, and whose pipeline it watches. None on
 * a tool's page, which may not name the others.
 */
export function introLine({ chant = false, tg = false, vendor = false } = {}) {
  if (vendor) return null;
  if (tg) return "behold, a live view of infrastructure, watching terragucci apply one change to many states, wave by wave.";
  if (chant) return "behold, a live view of infrastructure, watching chant's pull-request pipeline apply one change across many stacks.";
  return "behold, a live view of infrastructure, watching a demo pipeline run one change in a loop.";
}
const introFor = (s) => introLine({ chant: !!(s.chantLoop || s.source === "chant-demo"), tg: !!s.tgRepo, vendor: !!vendorOf(s.vendor) });
export const WHAT_DOCS = { text: "behold's documentation", url: "https://intentius.io/behold/" };

/** behold#571: a fade at a box's edge where its text goes on past it. */
function fade(b) {
  b.classList.toggle("k-more-below", b.scrollTop + b.clientHeight < b.scrollHeight - 1);
  b.classList.toggle("k-more-above", b.scrollTop > 1);
}

/** behold#571 (#631): how often a tool's recorded step order is read again. */
export const STRIP_REREAD_MS = 600_000;

/** behold#571: how often a run view that is behind the step is read again. */
export const FRESH_RUN_MS = 4_000;
/** behold#571: how often a cycle's run's traces are read again, and how long after a run ends they still are. */
export const TRACE_POLL_MS = 8_000;
export const TRACE_SETTLE_MS = 90_000;

/** behold#571: the longest a reloaded frame loads out of sight before it swaps in anyway. */
export const FRAME_SWAP_MS = 30_000;
/** How long the pane's "drawing the graph" line waits for a frame that never says it drew. */
export const FRAME_WAIT_MS = 10_000;
/** How long the line outlasts a frame's first `behold:drawn`: the scene's layout and fit follow it. */
export const FRAME_SETTLE_MS = 1_200;
/** behold#571: how long the first frame load waits for demo.json, so it opens on the step's checkout. */
export const FRAME_BOOT_WAIT_MS = 4_000;

/** How often the kiosk asks for demo.json. The server shares one read between kiosks. */
export const DEMO_POLL_MS = 3_000;
/** behold#631: the room a chant cycle's graph always leaves at its right for the side panels (the approval card, the result card), in px. */
export const CHANT_SIDE_ROOM = 520;

/**
 * Boot the kiosk: the bar, the frame and the graph pane's legend. Ask demo.json every few
 * seconds, the reports and the run view when the step, cycle or commit moves
 * or the event stream says they did, and redraw every second for the
 * countdown. When the roots the step is about change, move the framed view
 * with a `behold:view` message; the frame takes them only from this origin.
 */
export function startKiosk({ bar, frame, side, main, views, read = null, tools = null, watch = null, eh = null }, { fetchJson = defaultFetch, now = () => new Date(), origin = location.origin, tool = null, source = null, runs = null } = {}) {
  // behold#752: terragucci's loop, or chant's fan-out demo from its own records (web/kiosk-source.js).
  const reads = readsFor(source);
  // behold#815: the runs pane's own reads, chant's run index when serve has --ci-report-url.
  const runsReads = runsReadsFor(runs, reads);
  const s = { source: reads.source, demo: null, answer: null, progress: null, components: false, pick: null, view: "resources", roots: [], waves: [], light: false, hover: null, frameHover: null, held: null };
  // behold#571: Watch or Inspect, the viewer's pick kept in their browser; Watch until they pick Inspect.
  const shelf = typeof localStorage !== "undefined" ? (() => { try { return localStorage; } catch { return null; } })() : null;
  s.metrics = null;
  s.watchMode = !!watch && modeStored(shelf) === "watch";
  s.watchHeld = null;
  s.boxes = null;
  s.shot = null;
  // behold#571: event-help, started further down once what it reads is in place.
  let ehApi = null;
  // #715: the live carve's caption and Tips, when the frame draws one (web/kiosk-carve.js).
  let carveCtl = null;
  // behold#571: the run view as the cycle has seen it (steadyRun), and when a read behind the step last asked again.
  let runMemo = null;
  let freshAt = 0;
  s.steady = null;
  // behold#571: each wave's trace, from Tempo (web/kiosk-wave-traces.js).
  s.waveTraces = {};
  // behold#571: the frame loading out of sight while the shown one stays up (openFrame), and a message to both.
  let buffer = null;
  const post = (msg) => {
    for (const f of [frame, buffer]) {
      try {
        if (f && f.contentWindow) f.contentWindow.postMessage(msg, origin);
      } catch {
        /* the frame went away */
      }
    }
  };
  // behold#571: on a tool's page, `live` while its scenario runs, `replay` of its latest cycle otherwise, `none` before it has one.
  const vendor = vendorOf(tool);
  s.vendor = vendor ? tool : null;
  s.mode = vendor ? "loading" : "live";
  s.replay = null;
  s.repo = null;
  s.live = null;
  if (vendor && typeof document !== "undefined") document.title = `behold · ${vendor.name}`;
  /** The time the page shows: the replay's, while it replays. */
  const shownNow = () => (s.mode === "replay" && s.replay && s.replay.at ? s.replay.at : now());
  /** behold#571: the frame and the plan's facts are the served repo's, so a tool's page shows them only for its own repo. */
  const frameOk = () => {
    if (!vendor) return true;
    // behold#765: chant's demo has no terragucci answer to name its repo, and one checkout served sends no viewRepos.
    if (demoFrameOk(reads.own, s.single, s.repo, s.viewRepos)) return true;
    // Before the tool's first cycle: its repo's checkout, when this behold serves it.
    if (s.mode === "none") return !!notRunRepo(tool, s.viewRepos) && s.aimed === notRunRepo(tool, s.viewRepos);
    if (servesRepo(s.answer && !s.answer.error ? s.answer.project : null, s.repo)) return true;
    // A tool whose pipeline writes no terragucci reports (chant's own loop) has no
    // reports to name its repo: the frame is its repo's when behold serves that checkout.
    return reportless(vendor) && !!repoParam(s.repo, s.viewRepos);
  };
  // behold#571: a behold serving several repos (`serve --repos`) answers the
  // graph's reads from the checkout of the repo the page is about, asked by
  // name. `viewRepos` is what it serves, `aimed` the repo the reads are for.
  s.viewRepos = null;
  // behold#765: whether this behold serves one checkout (no viewRepos), null until /api/project answers.
  s.single = null;
  s.aimed = null;
  s.viewCommits = null;
  const repoNamed = () => repoParam(s.repo, s.viewRepos) || (vendor && s.mode === "none" ? notRunRepo(tool, s.viewRepos) : null);
  // behold#571: the checkout at the step's commit, so a pull request's new roots and resources are drawn.
  const wantRepo = () => stepCheckout(repoNamed(), s.demo && s.demo.demo, s.viewRepos, s.viewCommits);
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
  const shownView = () => kioskView(s.demo && s.demo.demo, { components: s.components, pick: s.pick, now: now().getTime(), ask: !!s.askOn });
  let unstacked = false;
  let askTold = null;
  const tellFrame = (force) => {
    // behold#571: before the tool's first cycle the frame draws its repo on the base, with nothing in flight.
    const notRun = !!vendor && s.mode === "none";
    const d = notRun ? null : s.demo && s.demo.demo;
    if (!d && !notRun) return; // nothing said yet: the frame keeps its default until the narration is read
    // Ask mode draws the whole estate at every step, so no root is brought forward.
    const roots = d && !s.askOn ? focusRoots(d, s.answer, s.progress) : null;
    const focus = roots ? roots.join(",") : null;
    const run = d ? runPin(d) : "base";
    // The cycle's pull request, so a merge's frame never draws another cycle's plan (web/terragucci-change.js pinnedAnswer).
    const pull = framePull(d);
    const zoom = viewZoom(shownView().view);
    // behold#939: a prompt-driven step draws every resource as its own card (the four of app, not "app x4").
    const ask = !!d && (hasAsk(d) || !!s.askOn);
    const key = `${focus}|${run}|${pull}|${zoom}|${ask ? "unstacked" : ""}`;
    if (!force && key === lastFocus) return;
    lastFocus = key;
    // Leaving it gives the default (stacked) back.
    post({ type: "behold:view", member: null, focus, run, pull, zoom, ...(ask ? { alike: false } : unstacked ? { alike: true } : {}) });
    unstacked = ask;
    post({ type: "behold:ask", on: askMode(s) });
    askTold = askMode(s);
    tellHover(s.hover);
  };
  // behold#937: the pane's events (behold#936) light the graph and give the reply its {dependents} (web/kiosk-light.js).
  if (typeof window !== "undefined") startKioskLight({ post, getAnswer: () => s.answer, getProgress: () => s.progress });
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
    // behold#571 event-help: an event's things light as a hover lights them, while its tip is up.
    const c = hoverLinks(s.hover || s.frameHover ? null : s.ehLit, s.waves);
    const links = { roots: [...new Set([...a.roots, ...b.roots, ...c.roots])], waves: [...new Set([...a.waves, ...b.waves, ...c.waves])] };
    style.textContent = [
      // behold#571: the held wave's job row, lit as the hold panel is; a hover's light comes after it and wins.
      Number.isInteger(s.held) ? `.r-job[data-k-wave="${s.held}"] { ${HELD_JOB_RULE} }` : "",
      hoverCss({ roots: links.roots, waves: [] }, { root: (r) => `.k-root[data-k-root=${cssString(r)}]` }, HOVER_ROOT_RULE),
      hoverCss({ roots: [], waves: links.waves }, { wave: (w) => `.r-job[data-k-wave="${w}"]` }, HOVER_JOB_RULE),
    ].join("\n");
  };
  // behold#571: with nothing pointed at, the frame lights the held wave's box, as the hold panel and its job row are lit.
  const tellHover = (h) => {
    const lit = h || s.ehLit || (Number.isInteger(s.held) ? { wave: s.held } : null);
    post(hoverMessage(lit));
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
    const unpin = () => post({ type: "behold:unpin" });
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

  // behold#571: "How to read this", folded until a viewer opens it, then as they last left it.
  const store = typeof localStorage !== "undefined" ? (() => { try { return localStorage; } catch { return null; } })() : null;
  let readOpen = readStored(store) === true;
  let readKey = null;
  const drawReading = (view, ok, force = false) => {
    if (!read) return;
    const t = nounTool(s);
    const key = `${view}|${t}|${ok}|${readOpen}`;
    if (!force && key === readKey) return;
    readKey = key;
    if (!ok) {
      read.replaceChildren();
      read.hidden = true;
      return;
    }
    renderReading(read, view, t, {
      open: readOpen,
      onToggle: (open) => {
        readOpen = open;
        try {
          if (store) store.setItem(READ_STORE, open ? "open" : "closed");
        } catch {
          /* private mode: the fold lasts this visit */
        }
        drawReading(view, ok, true);
      },
    });
  };

  // behold#571: the titles and names demo.json has carried, by scenario, for the runs' subtitles.
  const titles = {};
  const names = {};
  // behold#936: the prompt pane (web/kiosk-ask.js), in the header's and the caption's place while a step has a prompt, in Watch.
  const askValues = () => {
    const d = s.demo && s.demo.demo;
    const failed = [...outcomesOf(s.answer, s.progress).values()].find((o) => o.outcome === "failed" && o.error);
    return replyValues(d ? matchingPull(s.answer, d) : null, failed ? failed.error : null, typeof window !== "undefined" && window.beholdAskTokens ? window.beholdAskTokens : {});
  };
  const applyAsk = () => {
    if (typeof document !== "undefined" && document.body && document.body.classList) document.body.classList.toggle("k-ask", !!s.askOn && !!s.watchMode);
    applySide();
  };
  // The side pane (web/kiosk-side.js): the act's run and what the terminal's current line names, right of the graph
  // in Watch while the prompt pane is up, on a screen wider than a phone. Open until the viewer folds it.
  s.sideOpen = sideStored(shelf);
  s.sideAsk = null;
  let sideWas = null;
  const sideNow = () => sideState({ ask: askMode(s), phone: typeof matchMedia === "function" && matchMedia(SIDE_PHONE).matches, open: s.sideOpen });
  function applySide() {
    if (typeof document === "undefined" || !document.body || !document.body.classList) return;
    const st = sideNow();
    document.body.classList.toggle("k-side-open", st === "open");
    document.body.classList.toggle("k-side-folded", st === "folded");
    if (st === sideWas) return;
    sideWas = st;
    // The graph's pane got narrower or wider: the frame refits on its own resize (web/app.js watchPaneForFit); the shot
    // is told again once the layout has settled, and the tips dock in the new room.
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(() => {
        drawSide();
        tellShot(true);
      });
  }
  const setSide = (open) => {
    s.sideOpen = open;
    keepSide(shelf, open);
    applySide();
    if (open && watch && watch.side && watch.side.focus) watch.side.focus();
  };
  function drawSide() {
    if (!watch || !watch.side || sideNow() !== "open") return;
    const d = s.demo && s.demo.demo;
    const runs = runsApi && runsApi.index && runsApi.index.doc ? runsApi.index.doc.runs : [];
    const trace = runTrace(runs, d, { answer: s.answer, progress: s.progress, now: now().getTime() });
    const details = detailsModel(s.answer, s.progress, s.sideAsk);
    renderSide(watch.side, { trace, details }, { traces: (host) => drawWaveTraces(host, s), onFold: () => setSide(false) });
  }
  if (watch && watch.sideTab && watch.sideTab.addEventListener) watch.sideTab.addEventListener("click", () => setSide(true));
  if (watch && watch.side && watch.side.setAttribute) watch.side.setAttribute("tabindex", "-1");
  // The prompt pane's height, which the side pane stands on: kept as --k-ask-h so the two never overlap.
  if (watch && watch.ask && typeof ResizeObserver !== "undefined" && typeof document !== "undefined") {
    new ResizeObserver(() => {
      const h = watch.ask.hidden ? 0 : Math.ceil(watch.ask.getBoundingClientRect().height);
      document.body.style.setProperty("--k-ask-h", `${h}px`);
    }).observe(watch.ask);
  }
  // The card follows the prompt pane's current turn: what its ask lights, from the plan (web/kiosk-light.js).
  if (typeof window !== "undefined" && window.addEventListener) {
    const turn = (e) => {
      const ask = e && e.detail && e.detail.ask && typeof e.detail.ask === "object" ? e.detail.ask : null;
      s.sideAsk = ask;
      drawSide();
    };
    for (const t of ["behold:ask-start", "behold:ask-light", "behold:ask-status", "behold:ask-done"]) window.addEventListener(t, turn);
    window.addEventListener("behold:ask-clear", () => {
      s.sideAsk = null;
      drawSide();
    });
    if (typeof matchMedia === "function") {
      const mq = matchMedia(SIDE_PHONE);
      if (mq.addEventListener) mq.addEventListener("change", applySide);
    }
  }
  const askPane =
    watch && watch.ask
      ? createAskPane({
          host: watch.ask,
          fill: askValues,
          now,
          reduced: () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
          onActive: (on) => {
            s.askPaneOn = on;
            s.askOn = on || !!s.askHeld;
            applyAsk();
          },
        })
      : null;
  // The tip cards (web/kiosk-ask-tips.js): one per act, docked in a corner of the graph during a long wait, gone the moment the prompt says something new.
  if (askPane && typeof window !== "undefined" && typeof document !== "undefined") mountAskTips({ win: window, doc: document, askHost: watch.ask });
  // The reset between acts is no turn of the story: one "Resetting" modal over the page while it runs (web/kiosk-reset.js).
  const resetModal = askPane && typeof document !== "undefined" && document.body ? mountResetModal(document) : null;
  /** Take one narration (demo.json, or a replayed step), and ask for the run it is about when the step moved. */
  const setDemo = (answer) => {
    const was = s.demo && s.demo.demo;
    s.demo = answer;
    const d = answer && answer.demo;
    // A viewer's hold on the shot ends at the reset and at a new act: the graph in the pane is another one then, and
    // the shot frames it to the pane as it is (a held view of the last graph left the reset's scene at the left edge).
    if (holdEnds(was || null, d || null) && s.endHold) s.endHold();
    if (askPane) {
      // behold#942: ask mode holds for the scenario, so the steps between prompts keep the graph and the pane.
      s.askHeld = askHeld(s.askHeld, d || null);
      askPane.setStep(d || null);
      s.askOn = !!s.askPaneOn || !!s.askHeld;
      applyAsk();
      if (resetModal) resetModal.set(resetShown(d || null, s.askOn));
    }
    // behold#571: when this page first saw the driver's deadline, for the next bar when demo.json has no next.from.
    s.nextSeen = nextSeen(s.nextSeen, d ? d.next || null : undefined, s.mode, shownNow().getTime());
    if (d && d.scenario && typeof d.title === "string" && d.title) titles[d.scenario] = d.title;
    if (d && d.scenario && scenarioName(d)) names[d.scenario] = scenarioName(d);
    const key = d ? `${s.mode}|${d.cycle}|${d.step}|${d.commit}|${d.pull}` : "";
    if (key !== lastKey) {
      lastKey = key;
      // The step moved: the run it is about may be newer than what behold read.
      const stage = d ? demoStage(d) : "none";
      if (stage === "pull-request" || stage === "either") void reports(true);
      if (stage === "apply" || stage === "either") void progress(true);
      // behold#571: a commit no served checkout was on when last asked; the driver may have checked it out since.
      if (d && d.commit && s.viewRepos && !Object.values(s.viewCommits || {}).some((c) => c.startsWith(d.commit) || d.commit.startsWith(c))) void readCommits();
    }
  };
  // behold#571: the replay's clock, read on every draw.
  const replayTick = () => {
    if (s.mode !== "replay" || !s.replay) return;
    const steps = s.replay.cycle.steps;
    const r = replayAt(steps, now().getTime() - s.replay.start);
    // behold#787: a replay the viewer asked for ends at the cycle's end (its reset), or after a while with no input.
    if (s.replay.asked && replayOver(steps, now().getTime() - s.replay.start, now().getTime() - s.replay.input)) return leaveReplay();
    s.replay.at = r.at;
    s.replay.banner = replayBanner(s.replay.cycle, s.replay.asked ? null : liveEstimate(s.live && s.live.demo, s.replay.cycle, now()));
    setDemo({ source: "replay", read: steps[r.index].at, demo: vendor ? scrubDemo(steps[r.index], tool) : steps[r.index] });
  };
  /** behold#787: what a seek or the end of a replay leaves behind: the story's place, the track's, the run view's memo and Watch's hold. */
  const rewind = () => {
    if (s.resetStory) s.resetStory();
    Object.assign(trackState, { cycle: null, pulls: [], key: null, since: null });
    runMemo = null;
    watchHoldAt = null;
    s.watchHeld = null;
    drawerWave = null;
    drawerView = null;
    lastShot = null;
  };
  /**
   * behold#787: replay the track's cycle from `at` (a step's time): the replay a tool's page shows, the viewer's
   * this time. Within a replay it seeks; the live poll leaves it alone until it ends.
   */
  s.seekTo = (at) => {
    const cycle = s.mode === "replay" && s.replay ? s.replay.cycle : s.lastCycle();
    if (!cycle || !Array.isArray(cycle.steps) || !cycle.steps.length) return;
    const start = now().getTime() - seekMs(cycle, at);
    if (s.mode === "replay" && s.replay) s.replay.start = start;
    else {
      s.replay = { cycle, start, at: null, banner: null, runs: null, asked: true };
      s.mode = "replay";
      s.repo = cycle.repo || s.repo;
    }
    s.replay.input = now().getTime();
    rewind();
    draw();
  };
  /** behold#787: the cycle's failure, where the done card's chip replays it from; null for a cycle with none. */
  s.failureAt = () => failureAt(s.mode === "replay" && s.replay ? s.replay.cycle : s.lastCycle());
  const leaveReplay = () => {
    if (!s.replay || !s.replay.asked) return;
    s.replay = null;
    s.mode = "live";
    rewind();
    if (!vendor && s.live) {
      s.repo = s.live.demo ? s.live.demo.repo : s.repo;
      setDemo(s.live);
    }
    void demo();
  };
  s.backToLive = () => {
    leaveReplay();
    draw();
  };
  // behold#787: any input keeps the viewer's replay going.
  if (typeof document !== "undefined" && document.addEventListener) {
    const touched = () => {
      if (s.replay && s.replay.asked) s.replay.input = now().getTime();
    };
    for (const ev of ["pointerdown", "keydown", "wheel"]) document.addEventListener(ev, touched, { passive: true, capture: true });
  }

  const draw = () => {
    followRepo();
    replayTick();
    // behold#741: the story gate for this step, and the frame told so (it draws the wedge, the blocks and the paced waves).
    {
      const d = s.demo && s.demo.demo;
      s.tgStory = storyGate({ chantLoop: s.chantLoop, terragucciRepo: s.tgRepo, demo: d }) === "terragucci";
      // behold#743: and the step's apply made outside the pipeline, which the frame draws on its estate's card.
      if (s.tgRepo) post({ type: "behold:story", on: s.tgStory, cycle: d && Number.isInteger(d.cycle) ? d.cycle : null, outside: (s.tgStory && d && d.outside) || null });
    }
    s.light = typeof document !== "undefined" && document.documentElement ? isLightBg(getComputedStyle(document.documentElement).getPropertyValue("--bg")) : false;
    s.rootNames = rootList();
    const shown = shownView();
    s.view = shown.view;
    const ok = frameOk();
    s.noReports = !ok;
    s.notRunGraph = !!vendor && s.mode === "none" && ok;
    s.approval = approvalNow();
    // behold#571: the header's boxes redraw every second; each keeps where a viewer scrolled it.
    const scrolled = Object.fromEntries([...bar.querySelectorAll(".k-box")].map((b) => [b.dataset.box, b.scrollTop]));
    renderKiosk(bar, s, shownNow());
    for (const b of bar.querySelectorAll(".k-box")) {
      if (scrolled[b.dataset.box]) b.scrollTop = scrolled[b.dataset.box];
      fade(b);
      b.addEventListener("scroll", () => fade(b), { passive: true });
    }
    // behold#571: the wave the hold panel shows, whose job row lights with it.
    const hold = s.demo && s.demo.demo ? holdModel(s, s.demo.demo) : null;
    const held = hold && Number.isInteger(hold.wave) ? hold.wave : null;
    if (held !== s.held) {
      s.held = held;
      glow();
      tellHover(s.hover);
    }
    whatText();
    // behold#571: the run view as the cycle has seen it, for the result card and the trail; a read behind the step asks again.
    const sr = steadyRun(runMemo, s.progress, s.demo && s.demo.demo);
    runMemo = sr.memo;
    s.steady = sr.progress;
    if (behindStep(s.demo && s.demo.demo, s.progress) && now().getTime() - freshAt > FRESH_RUN_MS) {
      freshAt = now().getTime();
      void progress(true);
    }
    // behold#571: Watch's overlays, then the shot they leave room for.
    holdTick();
    if (s.quietTick) s.quietTick();
    drawWatch(shownNow());
    renderViewToggle(views, shown, { components: s.components && ok, onPick: pickView });
    drawReading(shown.view, ok);
    // behold#571: with no graph to show, the graph pane folds away and the runs and the log take its width.
    if (typeof document !== "undefined" && document.body && document.body.classList) {
      if (ok) s.graphSeen = true;
      document.body.classList.toggle("k-nograph", graphFolds({ vendor, ok, askOn: !!s.askOn, seen: !!s.graphSeen, pending: graphPending({ own: reads.own, single: s.single, answer: s.answer }) }));
      // Before the tool's first cycle there are no runs and no log: those panes fold away, and the graph (when there is one) takes the width.
      document.body.classList.toggle("k-notyet", !!vendor && s.mode === "none");
    }
    tellFrame(false);
    tellShot(false);
    if (ehApi) ehApi.tick();
  };

  // ---------------------------------------------------------------------------
  // behold#571: Watch. The graph is the stage; the caption, the callout, the
  // drawer, the badges and the result card ride on it, and the shot moves
  // with the step. A viewer's click or pan holds the shot for PICK_HOLD_MS.
  let watchHoldAt = null;
  let lastShot = null;
  let drawerOpen = false;
  let drawerHover = false;
  // behold#571: a wave the viewer opened the drawer on, its trace or its log; null follows the step.
  let drawerWave = null;
  let drawerView = null;
  const isPhone = () => typeof matchMedia === "function" && matchMedia("(max-width: 600px)").matches;
  /** behold#942: ask mode on a phone (up to 700px) puts the pane under the graph, so nothing overlaps the frame. */
  const askStacked = () => !!(s.askOn && s.watchMode) && typeof matchMedia === "function" && matchMedia("(max-width: 700px)").matches;
  const runsParent = main ? main.parentNode : null;
  const runsNext = main ? main.nextSibling : null;
  const applyMode = () => {
    if (typeof document === "undefined" || !document.body || !document.body.classList) return;
    document.body.classList.toggle("k-watch", s.watchMode);
    if (watch && watch.drawer && main) {
      const body = watch.drawer.querySelector(".k-drawer-body");
      // The runs pane is the drawer's open state in Watch, and back in its column in Inspect.
      if (s.watchMode && body && main.parentNode !== body) body.appendChild(main);
      if (!s.watchMode && runsParent && main.parentNode !== runsParent) runsParent.insertBefore(main, runsNext);
    }
    applyAsk();
    if (watch) renderModeToggle(tools && tools.mode, s.watchMode ? "watch" : "inspect", setMode);
    if (carveCtl) carveCtl.tellMode();
  };
  const setMode = (m) => {
    const next = m === "watch";
    if (next === s.watchMode) return;
    s.watchMode = next;
    try {
      if (shelf) shelf.setItem(MODE_STORE, m);
    } catch {
      /* private mode: the pick lasts this visit */
    }
    if (next) s.pick = null; // Watch frames the components: a Resources pick from Inspect ends here
    watchHoldAt = null;
    s.watchHeld = null;
    lastShot = null;
    applyMode();
    draw();
    // The layout moved under the frame: the shot goes again once it has settled.
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => tellShot(true));
  };
  s.endHold = () => {
    if (watchHoldAt === null && !s.watchHeld) return;
    watchHoldAt = null;
    s.watchHeld = null;
    lastShot = null;
  };
  const holdShot = () => {
    if (!s.watchMode) return;
    watchHoldAt = now().getTime();
    draw();
  };
  s.followSteps = () => {
    drawerWave = null;
    drawerView = null;
    watchHoldAt = null;
    s.watchHeld = null;
    lastShot = null;
    draw();
  };
  function holdTick() {
    if (watchHoldAt === null) return void (s.watchHeld = null);
    // behold#779: on a touch screen most holds are a stray tap or a scroll over the graph: they hold a shorter time.
    const left = watchHoldAt + (touchScreen() ? TAP_HOLD_MS : PICK_HOLD_MS) - now().getTime();
    if (left <= 0) {
      watchHoldAt = null;
      s.watchHeld = null;
      lastShot = null;
      // The steps lead again: a drawer the viewer opened on a wave folds away with the hold.
      drawerWave = null;
      drawerView = null;
      return;
    }
    s.watchHeld = { secs: Math.ceil(left / 1000) };
  }
  /** The caption shown now: Watch's own, or the live carve's while it has the camera (#715). */
  const shownCaption = () => (carveCtl && carveCtl.caption ? carveCtl.caption() || watch.caption : watch.caption);
  /**
   * The box the graph's room ends at: the prompt pane while it shows (the caption is hidden then, and a hidden box
   * measures as zeros, which sent the trail to the top and left the graph no room), else the caption shown now.
   */
  const bottomBox = () => (s.askOn && s.watchMode && watch && watch.ask && !watch.ask.hidden ? watch.ask : shownCaption());
  /** behold#631: a chant kiosk's projected track (drawChantTrack), in the trail's place. */
  let trackHost = null;
  /** behold#571: the caption's top, or event-help's trail's when it sits over the caption. */
  const captionTop = (cap) => {
    const trail = trackHost && !trackHost.hidden ? trackHost : eh && eh.trailHost;
    const r = trail && !trail.hidden && trail.getBoundingClientRect ? trail.getBoundingClientRect() : null;
    return r && r.height && r.top < cap.top ? r.top : cap.top;
  };
  /** How much of the frame the overlays cover, in the frame's pixels: the caption below, and the callout, drawer or card beside the shot. */
  const shotInsets = (shot) => {
    if (!watch || !frame || isPhone() || askStacked() || !frame.getBoundingClientRect) return {};
    const f = frame.getBoundingClientRect();
    const cap = bottomBox().getBoundingClientRect();
    const bottom = Math.max(0, f.bottom - captionTop(cap)) + 16;
    const side = shot.kind === "held" ? watch.callout : shot.kind === "active" ? watch.drawer : shot.kind === "result" ? watch.result : null;
    // The result card sits right beside the graph (placeBeside's gap): an inset of its width and that gap centres the two together.
    const measured = side && !side.hidden && side.offsetWidth ? side.offsetWidth + (shot.kind === "result" ? 18 : 44) : 0;
    // behold#631: a chant cycle keeps one framing from start to end: the side panel's room is kept whether or not one is up, so the graph never shifts.
    const right = s.chantLoop ? Math.max(measured, CHANT_SIDE_ROOM) : measured;
    // Ask mode centres the scene in the graph area: the same margin at each side, none extra above or under it (the fit's own pad keeps the boxes off the edges).
    if (shot.ask) return { top: 0, right: Math.max(right, 20), bottom: bottom - 16, left: 20 };
    return { top: 20, right, bottom, left: 20 };
  };
  /**
   * The tallest the caption gets in a cycle, as a bottom inset in px (kiosk-watch.js captionRoom), measured from the
   * caption as it is: a held small stage keeps this room from the first step, so the cone line, the step line, the
   * quiet line or the trail that comes later moves nothing. None on a phone, where the caption is under the graph.
   */
  function captionRoomPx() {
    if (!watch || !frame || isPhone() || askStacked() || !frame.getBoundingClientRect || typeof getComputedStyle !== "function") return 0;
    const f = frame.getBoundingClientRect();
    // behold#936: the prompt pane, when it shows, is the caption's place; its height is fixed, so the room is too.
    if (s.askOn && watch.ask && !watch.ask.hidden) {
      const a = watch.ask.getBoundingClientRect();
      return Math.round(Math.max(0, f.bottom - a.bottom) + a.height + 16);
    }
    const cap = watch.caption;
    const c = cap.getBoundingClientRect();
    const fs = parseFloat(getComputedStyle(cap).fontSize) || 16;
    const gap = fs * 0.25;
    const extras = [...cap.querySelectorAll(":scope > .k-cap-cone, :scope > .k-cap-quiet")].map((n) => n.getBoundingClientRect().height + gap);
    const rowH = extras.length ? Math.max(...extras) : fs * 0.92 * 1.35 + gap;
    const trail = eh && eh.trailHost && !eh.trailHost.hidden ? eh.trailHost.getBoundingClientRect() : null;
    const trailH = trail && trail.height && trail.top < c.top ? c.top - trail.top : 0;
    const chip = eh && eh.trailHost ? eh.trailHost.querySelector(".eh-chip") : null;
    const trailLineH = chip ? chip.getBoundingClientRect().height + 4 : 26;
    return captionRoom({ capHeight: c.height, extras, rowH, trailH, trailLineH, below: Math.max(0, f.bottom - c.bottom) });
  }
  function tellShot(force, still, fresh = null) {
    if (!frame || !frame.contentWindow || !watch) return;
    // behold#940: ask mode holds in the frame between prompts and between shots, so it is told on its own, when it changes.
    if (askMode(s) !== askTold) {
      askTold = askMode(s);
      post({ type: "behold:ask", on: askTold });
    }
    if (!s.watchMode) {
      if (lastShot !== "release") {
        lastShot = "release";
        post({ type: "behold:shot", release: true });
      }
      return;
    }
    if (!s.shot) return;
    // A viewer's hold keeps the frame they moved where it is. A frame that has just loaded (`fresh`, its window) has
    // nothing of theirs: it takes the shot, or it would fit itself to the graph it first drew and not to the pane.
    if (s.watchHeld && !fresh) return;
    const insets = shotInsets(s.shot);
    // The caption's tallest, for a held small stage's one framing; a stage that isn't held never reads it.
    const room = captionRoomPx();
    const key = `${s.shot.id}|${s.shot.ask ? "ask" : ""}|${insets.right || 0}|${Math.round((insets.top || 0) / 12)}|${Math.round((insets.left || 0) / 12)}|${Math.round((insets.bottom || 0) / 12)}|${s.shot.roots.join(",")}|${Math.round(room / 12)}`;
    const msg = shotMessage({ roots: s.shot.roots, waves: s.shot.waves, whole: s.shot.whole, insets, id: s.shot.id, room, ask: s.shot.ask === true, ...(still ? { ms: 0 } : {}) });
    if (s.watchHeld) {
      try {
        fresh.postMessage(msg, origin);
      } catch {
        /* the frame went away */
      }
      return;
    }
    if (!force && key === lastShot) return;
    lastShot = key;
    post(msg);
  }
  // behold#631: the projected cycle track, a chant kiosk's bottom band in place of the chip strip and the rail.
  const trackState = { cycle: null, pulls: [], key: null, since: null };
  function drawChantTrack(d, at) {
    if (!trackHost && eh && eh.trailHost && eh.trailHost.parentNode && typeof document !== "undefined") {
      trackHost = document.createElement("div");
      trackHost.id = "k-track";
      trackHost.hidden = true;
      eh.trailHost.parentNode.insertBefore(trackHost, eh.trailHost);
    }
    const t = at instanceof Date ? at.getTime() : now().getTime();
    const track = storyOn(s) && d ? cycleTrack(s.lastCycle()) : null;
    s.trackOn = !!track;
    if (!trackHost) return;
    if (!track) {
      s.trackModel = null;
      drawTrack(trackHost, null);
      return;
    }
    // This cycle's pull requests in the order it opened them; the reset closes the last.
    if (trackState.cycle !== d.cycle) Object.assign(trackState, { cycle: d.cycle, pulls: [], key: null, since: null });
    // The story's step, which may be a chapter ahead of demo.json's (s.storyDemo).
    d = s.storyDemo ? s.storyDemo(d) : d;
    if (Number.isInteger(d.pull) && !trackState.pulls.includes(d.pull)) trackState.pulls.push(d.pull);
    const live = s.chantLoop ? (s.chantWavesNow ? s.chantWavesNow(d) : null) : s.tgWavesNow ? s.tgWavesNow(d) : null;
    // When the current segment began: the step's own start where demo.json says it, else when the kiosk first saw it.
    const probe = trackModel(track, { demo: d, pulls: trackState.pulls, since: t, now: t });
    const key = probe ? `${probe.at.chapter}|${probe.at.segment}` : null;
    if (key !== trackState.key) {
      const from = !d.storyAhead && d.next && d.next.from ? Date.parse(d.next.from) : NaN;
      trackState.key = key;
      trackState.since = Number.isFinite(from) && from <= t && t - from < 600_000 ? from : t;
    }
    // behold#774: the run's own jobs say the apply started before its run view does.
    const jobs = applyJobs(runsApi && runsApi.run ? runsApi.run.doc : null, d);
    const model = trackModel(track, { demo: d, pulls: trackState.pulls, since: trackState.since, now: t, waves: live ? live.waves : null, jobs, replay: s.mode === "replay" });
    s.trackModel = model;
    // behold#787: a past step's segment replays it.
    if (model) model.onSeek = s.seekTo;
    drawTrack(trackHost, model);
    // In the trail's place: over the caption.
    const cap = bottomBox().getBoundingClientRect();
    if (trackHost.style) trackHost.style.bottom = cap.height ? `${Math.round((typeof window !== "undefined" ? window.innerHeight : 0) - cap.top)}px` : "";
    // The "Waiting on…" modal: a quiet stretch on a step that waits on something, never while the apply's events come in.
    // Once the play shows anything of this run under way (a wave or a card), nothing waits on the apply to start.
    // behold#741: a terragucci apply is under way once any wave of its run view has moved.
    const applyLive = !!(live && (live.live ? live.waves.some((w) => w.state !== "waiting") || Object.values(live.live.components || {}).some((c) => !["waiting", "planned", "planning"].includes(c.state)) : live.tg && live.waves.some((w) => w.state !== "waiting")));
    s.waitingNow = waitingSpec(model, { quietMs: s.quietFor || 0, applyLive });
  }
  function drawWatch(at) {
    if (!watch || !s.watchMode) return;
    const d = s.demo && s.demo.demo;
    drawCaption(watch.caption, s, at);
    drawChantTrack(d, at);
    const hold = d ? holdModel(s, d) : null;
    const gate = !!hold && (hold.kind === "approval" || hold.kind === "driver");
    const shot = askShot(shotFor(d, { answer: s.answer, progress: s.progress, held: s.held, gate, runDoc: runsApi && runsApi.run ? runsApi.run.doc : null, waves: s.waves }), askMode(s));
    s.shot = shot;
    const nums = waveBadges(s.metrics);
    const opened = drawerWave !== null;
    // On a held small stage nothing overlays the graph (web/kiosk-watch.js watchOverlays): the approval, the result and the
    // running job are the caption's quiet lines there. Any other stage shows its cards as it always has.
    const shows = watchOverlays({ kind: shot.kind, opened, held: !!s.stageHeld, ask: askMode(s) });
    const call = shows.callout && shot.kind === "held" && gate;
    watch.callout.hidden = !call;
    if (call) drawCallout(watch.callout, s, hold, badgeTitle(nums[hold.wave]));
    const drawer = shows.drawer;
    const drawerOn = opened ? drawerWave : shot.waves[0];
    const open = drawer && (drawerOpen || drawerHover || opened);
    watch.drawer.hidden = !drawer;
    watch.drawer.classList.toggle("k-open", open);
    watch.drawer.classList.toggle("k-trace-only", opened && drawerView === "trace");
    // A drawer opened on a wave's trace is headed by that wave's job, not the step's.
    const tr = opened && drawerView === "trace" ? s.waveTraces[drawerOn] : null;
    const tail = tr ? { job: `Wave ${drawerOn} · ${tr.job}`, status: tr.trace.result === "failed" || tr.trace.result === "refused" ? "failure" : tr.trace.result === "waiting" ? "waiting" : "success", lines: [] } : tailLines(runsApi && runsApi.run ? runsApi.run.doc : null);
    if (drawer) drawDrawer(watch.drawer, tail, badgeTitle(nums[drawerOn]), open);
    if (drawer) traceDrawer(d, drawerOn);
    // A drawer the viewer opened on a wave takes the card's place beside the graph until it folds.
    const result = shows.result && shot.kind === "result" && !opened ? resultModel(d, s.metrics, s.steady) || (s.chantResult ? s.chantResult(d) : null) : null;
    watch.result.hidden = !result;
    if (result) drawResult(watch.result, result, s);
    // On a phone the delivery numbers stack under the rest, where the header has no room for them.
    let foot = watch.layer.querySelector(":scope > .k-w-dora-foot");
    if (!foot) {
      foot = el("p", "k-w-dora-foot");
      watch.layer.appendChild(foot);
    }
    foot.textContent = doraLine(s.metrics) || "";
    // behold#781, behold#776: a phone's Watch says the change in words by the story, and lists the graph's marks.
    if (watch.change) drawChange(watch.change, s);
    drawWaves();
    drawSide();
    // behold#775: on a phone, each finished wave's trace under the step (hidden on a wider screen, where the badges open them).
    let traces = watch.layer.querySelector(":scope > .k-w-traces");
    if (!traces) {
      traces = el("section", "k-w-traces");
      if (traces.setAttribute) traces.setAttribute("aria-label", WAVE_TRACES_WORDS);
      watch.caption.after ? watch.caption.after(traces) : watch.layer.appendChild(traces);
    }
    drawWaveTraces(traces, s, { shown: !result });
    watch.badges.replaceChildren();
    const skip = call ? hold.wave : drawer ? drawerOn : null;
    // At applied the result card lists every wave's numbers, so the boxes carry none; a held small stage carries none at all.
    for (const [n, words] of !shows.badges || (shot.kind === "result" && result) ? [] : Object.entries(nums)) {
      if (Number(n) === skip) continue;
      const b = el("span", "k-badge", words);
      b.dataset.kWave = n;
      b.title = `Wave ${n}: ${badgeTitle(words)}`;
      // behold#571: a wave whose trace Tempo has opens it from its numbers.
      if (s.waveTraces[n]) {
        b.classList.add("k-badge-trace");
        b.title = `${b.title} · ${TRACE_OPEN_WORDS}`;
        b.appendChild(el("span", "k-badge-go", TRACE_LINK_WORDS));
        b.addEventListener("click", () => s.openWave(Number(n), "trace"));
      }
      watch.badges.appendChild(b);
    }
    placeWatch();
  }
  /**
   * behold#776: the frame's marks as a list (web/kiosk-wave-list.js), drawn
   * again only when they or the roots opened change, so a tap's row keeps its
   * place. A tap on a root opens its resources under it and lights its card.
   */
  // Its state lives on `s`, made on first use: drawWatch may run before this part of startKiosk has. Each frame's last
  // marks are kept by its window, since the next frame posts its own while it loads out of sight, before it swaps in.
  function waveState() {
    return s.wl || (s.wl = { by: new WeakMap(), open: new Set(), drawn: null });
  }
  if (watch && watch.waves && typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("message", (e) => {
      if (e.origin !== origin || !e.source || !e.data || e.data.type !== "behold:marks") return;
      waveState().by.set(e.source, e.data.list && Array.isArray(e.data.list.waves) ? e.data.list : null);
      drawWaves();
    });
  }
  function drawWaves() {
    if (!watch || !watch.waves) return;
    const wl = waveState();
    s.waveList = (frame && frame.contentWindow && wl.by.get(frame.contentWindow)) || null;
    const key = `${waveListKey(s.waveList)}|${[...wl.open].join(",")}|${s.light}`;
    if (key === wl.drawn) return;
    wl.drawn = key;
    drawWaveList(watch.waves, s.waveList, {
      open: wl.open,
      paint: (_doc, root) => elRoots("span", null, root, s),
      onToggle: (root) => {
        if (wl.open.has(root)) wl.open.delete(root);
        else wl.open.add(root);
        drawWaves();
      },
    });
  }
  /**
   * behold#571: the active wave's job's trace waterfall (web/kiosk-trace.js),
   * in the drawer's mount point: the job that applies the wave, in the run
   * the drawer shows. It draws nothing until Tempo has a trace for that job.
   */
  let trace = null;
  function traceDrawer(d, wave) {
    const host = watch.drawer.querySelector("#k-traces");
    const runDoc = runsApi && runsApi.run ? runsApi.run.doc : null;
    const w = (s.waves || []).find((x) => x.wave === wave);
    const tr = s.waveTraces[wave];
    if (!host || !d || !d.repo || (!tr && (!runDoc || !w))) return;
    // The wave's own trace when Tempo has it (its run and job: a resumed run applies waves in one job), else its job in the drawer's run.
    // The wave's own attempt of its job: a resumed run's job applies several waves, and a wave may run twice.
    const target = tr ? { project: d.repo, run: tr.run, job: tr.job, wave, start: tr.trace.start } : { project: d.repo, run: String(runDoc.id), job: w.job, wave, start: null };
    const key = `${target.project}|${target.run}|${target.job}|${target.wave}|${target.start}`;
    if (trace && trace.key === key) return;
    if (trace) trace.api.update(target);
    else trace = { api: mountTrace(host, { ...target, fetchJson: fetchServed }) };
    trace.key = key;
  }
  /** Put each overlay by its box, as the frame last said they sit. */
  function placeWatch() {
    if (!watch || !s.watchMode || !frame || !frame.getBoundingClientRect) return;
    const all = [watch.callout, watch.drawer, watch.result, ...watch.badges.children];
    if (isPhone()) {
      for (const n of all) n.style.transform = "";
      return;
    }
    const L = watch.layer.getBoundingClientRect();
    const F = frame.getBoundingClientRect();
    const capTop = captionTop(bottomBox().getBoundingClientRect()) - L.top;
    const view = { x: F.left - L.left, y: F.top - L.top, w: F.width, h: capTop - (F.top - L.top) };
    const boxOf = (n) => {
      const waves = (s.boxes && s.boxes.waves) || {};
      // No wave named: every wave's box, for a gate on the whole change.
      const list = n === null || n === undefined ? Object.values(waves) : [waves[n]];
      const ok = list.filter((b) => b && b.w > 0);
      if (!ok.length) return null;
      const x = Math.min(...ok.map((b) => b.x));
      const y = Math.min(...ok.map((b) => b.y));
      return { x: x + view.x, y: y + view.y, w: Math.max(...ok.map((b) => b.x + b.w)) - x, h: Math.max(...ok.map((b) => b.y + b.h)) - y };
    };
    const taken = [];
    // While the live carve has the camera, the graph shows dots, not the wave boxes: the panes sit at the view's top right.
    // On a held small stage a drawer the viewer opened sits at the stage top right.
    const carvingNow = shownCaption() !== watch.caption || !!s.stageHeld;
    const put = (node, n) => {
      if (node.hidden) return;
      // behold#764: measured at its own height, then capped to the view (placeBeside's maxHeight); its body scrolls.
      node.style.maxHeight = "";
      const size = { w: node.offsetWidth, h: node.offsetHeight };
      const box = carvingNow ? null : boxOf(n);
      // Before the frame says where the box is: the right of the view, under its top.
      // The frame's own controls at its top right (⤢ fit, ↺ layout: web/index.html) are kept clear too.
      const chrome = { x: view.x + view.w - FRAME_CONTROLS.w, y: view.y, w: FRAME_CONTROLS.w, h: FRAME_CONTROLS.h };
      const labels = [...((s.boxes && s.boxes.labels) || []).map((r) => ({ x: r.x + view.x, y: r.y + view.y, w: r.w, h: r.h })), chrome];
      const p = box ? placeBeside(box, size, view, 18, labels) : { x: view.x + view.w - size.w - 20, y: view.y + FRAME_CONTROLS.h + 8, side: "below" };
      // The result card stands level with the middle of the graph it sums up.
      const h = p.maxHeight || size.h;
      node.style.maxHeight = p.maxHeight ? `${Math.floor(p.maxHeight)}px` : "";
      node.classList.toggle("k-capped", !!p.maxHeight);
      if (box && node === watch.result) p.y = Math.max(view.y + 8, Math.min(box.y + box.h / 2 - h / 2, view.y + view.h - h - 8));
      node.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
      for (const k of ["right", "left", "below", "above"]) node.classList.toggle(`k-side-${k}`, p.side === k);
      node.classList.add("k-placed");
      const notch = node.querySelector(":scope > .k-notch");
      if (notch && box) notch.style.top = `${Math.round(Math.max(12, Math.min(h - 26, box.y + 22 - p.y)))}px`;
      taken.push({ x: p.x, y: p.y, x2: p.x + size.w, y2: p.y + h });
    };
    put(watch.callout, s.held);
    put(watch.drawer, drawerWave !== null ? drawerWave : s.shot && s.shot.waves[0]);
    put(watch.result, null); // beside the whole graph
    const hits = (r) => taken.some((t) => r.x < t.x2 && r.x2 > t.x && r.y < t.y2 && r.y2 > t.y);
    for (const b of watch.badges.children) {
      const box = carvingNow ? null : boxOf(Number(b.dataset.kWave));
      b.classList.remove("k-placed");
      if (!box) continue;
      const w = b.offsetWidth;
      const h = b.offsetHeight;
      const spots = [
        { x: box.x + box.w + 10, y: box.y + 8 },
        { x: box.x - 10 - w, y: box.y + 8 },
        { x: box.x + box.w - w - 10, y: box.y - h - 6 },
      ];
      const spot = spots.find((p) => p.x >= view.x + 6 && p.x + w <= view.x + view.w - 6 && p.y >= view.y + 4 && p.y + h <= view.y + view.h - 4 && !hits({ x: p.x, y: p.y, x2: p.x + w, y2: p.y + h }));
      if (!spot) continue;
      b.style.transform = `translate(${Math.round(spot.x)}px, ${Math.round(spot.y)}px)`;
      b.classList.add("k-placed");
      taken.push({ x: spot.x, y: spot.y, x2: spot.x + w, y2: spot.y + h });
    }
  }
  if (watch && typeof window !== "undefined" && window.addEventListener) {
    let queued = false;
    window.addEventListener("message", (e) => {
      if (e.origin !== origin || !frame || e.source !== frame.contentWindow || !e.data) return;
      if (e.data.type === "behold:viewer") return holdShot();
      // behold#764: the frame's card details popover opened, moved or closed: a modal yields to it, and one held back opens after.
      if (e.data.type === "behold:pop") {
        const a = e.data.at;
        s.framePop = a && [a.x, a.y, a.w, a.h].every(Number.isFinite) ? { x: a.x, y: a.y, w: a.w, h: a.h } : null;
        if (ehApi) ehApi.tick();
        return;
      }
      if (e.data.type !== "behold:boxes") return;
      s.boxes = e.data;
      // A held small stage: nothing the step shows overlays the graph (watchOverlays), and a drawer the viewer opens
      // sits at the stage's top right, not by a box. body.k-held says so, for a check from outside.
      const held = !!e.data.held;
      if (held !== !!s.stageHeld) {
        s.stageHeld = held;
        if (document.body && document.body.classList) document.body.classList.toggle("k-held", held);
        draw();
      }
      if (ehApi) ehApi.follow();
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        placeWatch();
      });
    });
    window.addEventListener("resize", () => {
      placeWatch();
      tellShot(true);
    });
    // A click on the approval or the log is a viewer reading it: the shot holds.
    if (watch.callout) watch.callout.addEventListener("pointerdown", holdShot);
    const head = watch.drawer && watch.drawer.querySelector(".k-drawer-head");
    if (head) {
      head.addEventListener("click", () => {
        // A drawer the viewer opened on a wave folds away; the step's drawer folds to its last lines.
        if (drawerWave !== null) {
          drawerWave = null;
          drawerView = null;
          drawerOpen = false;
          return draw();
        }
        drawerOpen = !drawerOpen;
        holdShot();
      });
    }
    if (watch.drawer) {
      watch.drawer.addEventListener("pointerenter", (e) => {
        if (e.pointerType === "touch") return;
        drawerHover = true;
        draw();
      });
      watch.drawer.addEventListener("pointerleave", () => {
        drawerHover = false;
        draw();
      });
    }
  }
  // ---------------------------------------------------------------------------
  // behold#571: event-help, the "Tips" (web/kiosk-event-help-ui.js).
  s.ehLit = null;
  ehApi = eh && typeof document !== "undefined"
    ? startEventHelp({
        doc: document,
        store: shelf,
        // behold#764: the story modals a viewer closes, for this visit only (never localStorage).
        session: (() => {
          try {
            return typeof sessionStorage !== "undefined" ? sessionStorage : null;
          } catch {
            return null;
          }
        })(),
        switchHost: eh.switchHost,
        trailHost: eh.trailHost,
        tipsHost: eh.tipsHost,
        modalHost: eh.modalHost,
        now: () => now().getTime(),
        shown: () => shownNow().getTime(),
        light: (lit) => {
          s.ehLit = lit;
          glow();
          tellHover(s.hover);
        },
        openTrace: (wave) => s.openWave(wave, "trace"),
        // The modal shows behold's own approval panel, as the kiosk draws it.
        panel: (kind) => (kind === "held" && s.approval ? approvalPanel(s.approval, s) : null),
        get: () => {
          const d = s.demo && s.demo.demo;
          if (!d) return null;
          const appr = pendingApproval(d, s.progress);
          // behold#939: in ask mode no bubble, modal or strip; the pane and the graph tell it.
          return askEventHelp({
            demo: d,
            answer: s.answer,
            // behold#741: told at the pace the graph plays the waves, while a terragucci story is on.
            progress: s.tgStory && s.tgPaced ? s.tgPaced() : s.steady,
            runDoc: runsApi && runsApi.run ? runsApi.run.doc : null,
            // The cycle's runs the approval panel reads, for the failures of runs the pane no longer shows.
            runDocs: ap.list,
            approval: s.approval && Array.isArray(s.approval.rows) ? s.approval : null,
            metrics: s.metrics,
            waves: s.waves,
            boxes: s.boxes,
            // behold#631: a chant repo's pull-request loop, whose story Tips tell its own way.
            chant: !!s.chantLoop,
            // behold#741: a terragucci repo's chapter-carrying scenario gets the kiosk's look (one tip at a time, modals
            // off the cards and above the band) but keeps its own story order: its gates come after the merge.
            story: storyOn(s),
            // Its projected track replaces the chip strip, and its quiet stretches get a "Waiting on…" modal,
            // which the approval card beside the graph wins over.
            hideTrail: !!(storyOn(s) && s.trackOn && s.watchMode),
            waiting: storyOn(s) && s.watchMode && !(watch && watch.callout && !watch.callout.hidden) ? s.waitingNow || null : null,
            // behold#764: the card's details popover the frame has open (`behold:pop`), which no modal covers.
            pop: s.framePop || null,
            frame,
            watch: s.watchMode,
            // The caption shown now: the live carve's while it has the camera (web/kiosk-carve.js).
            caption: watch ? bottomBox() : null,
            replay: s.mode === "replay",
            approveLine: appr ? appr.approve : null,
            label: d.label || "",
            result: resultModel(d, s.metrics, s.steady) || (s.chantResult ? s.chantResult(d) : null),
            // A held small stage (one framing): no modal and no Tips bubble over the graph in Watch there.
            held: !!s.stageHeld,
            waveTraces: s.waveTraces,
            strip: s.stripReady() ? s.strip : null,
            stripReady: s.stripReady(),
          }, askMode(s));
        },
      })
    : null;

  /**
   * behold#571: open a wave's trace (or its log) from where its numbers are:
   * its badge, the result card, its box, a tip. In Watch, the drawer on its
   * box; in Inspect, the job pane on its job.
   */
  s.openWave = (n, view = "trace") => {
    const tr = s.waveTraces[n];
    const v = view === "trace" && tr ? "trace" : "log";
    const w = (s.waves || []).find((x) => x.wave === n);
    if (!s.watchMode) {
      if (!runsApi || !runsApi.showJob || !(tr || w)) return;
      // behold#775: on a phone the runs fold under "Runs and logs": it opens, and the job's trace comes into view.
      if (tools && tools.runsToggle) setRunsOpen(true);
      runsApi.showJob(tr && v === "trace" ? tr.run : runsApi.run && runsApi.run.doc ? runsApi.run.doc.id : null, tr && v === "trace" ? tr.job : w.job, v === "trace" ? "trace" : "steps");
      if (isPhone() && main && main.querySelector) setTimeout(() => {
        const at = main.querySelector(".t-tabs") || main.querySelector(".r-steps");
        if (at && at.scrollIntoView) at.scrollIntoView({ block: "start", behavior: "smooth" });
      }, 400);
      return;
    }
    drawerWave = n;
    drawerView = v;
    drawerOpen = true;
    if (v === "log" && w && runsApi && runsApi.showJob) runsApi.showJob(runsApi.run && runsApi.run.doc ? runsApi.run.doc.id : null, w.job, "steps");
    holdShot();
  };
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("message", (e) => {
      if (e.origin !== origin || !frame || e.source !== frame.contentWindow || !e.data || e.data.type !== "behold:wave") return;
      if (Number.isInteger(e.data.wave)) s.openWave(e.data.wave, "trace");
    });
  }
  // behold#571: the cycle's runs' traces, read while the waves run and for a while after each run ends (Tempo has a job's spans seconds to a minute after it finishes).
  const traceReads = new Map();
  let tracesBusy = false;
  let tracesCycle = null;
  const readTraces = async () => {
    const d = s.demo && s.demo.demo;
    // A new cycle starts with none: the last one's traces are not this one's.
    if (d && d.cycle !== tracesCycle) {
      tracesCycle = d.cycle;
      s.waveTraces = {};
      drawerWave = null;
      drawerView = null;
    }
    // behold#752: chant's demo has no forge runs for Tempo to have traced.
    if (tracesBusy || reads.own || !d || !d.repo || !runsApi || !runsApi.index || !runsApi.index.doc) return;
    if (!["merged", "applying", "waiting", "approved", "failed", "resumed", "applied"].includes(d.step)) return;
    tracesBusy = true;
    try {
      const t = now().getTime();
      for (const r of cycleRuns(runsApi.index.doc.runs, d)) {
        if (r.status === "queued") continue;
        const key = `${d.cycle}|${r.id}`;
        const had = traceReads.get(key);
        const ended = r.ended_at ? Date.parse(r.ended_at) : null;
        // Done: ended a while ago, and read once since.
        if (had && ended && t - ended > TRACE_SETTLE_MS && had.at > ended + TRACE_SETTLE_MS) continue;
        if (had && t - had.at < TRACE_POLL_MS) continue;
        const a = await fetchServed(`/api/traces?project=${encodeURIComponent(d.repo)}&run=${encodeURIComponent(r.id)}`);
        traceReads.set(key, { at: t, answer: a && !a.error ? a : had ? had.answer : null });
      }
      const mine = [...traceReads].filter(([k]) => k.startsWith(`${d.cycle}|`)).map(([, v]) => v.answer);
      const next = waveTraces(mine);
      if (JSON.stringify(Object.keys(next).map((k) => [k, next[k].run, next[k].trace.start])) !== JSON.stringify(Object.keys(s.waveTraces).map((k) => [k, s.waveTraces[k].run, s.waveTraces[k].trace.start]))) {
        s.waveTraces = next;
        draw();
      }
    } finally {
      tracesBusy = false;
    }
  };
  setInterval(() => void readTraces(), 2_000);

  // behold#571 (#631): the strip in the running tool's own order, from its recorded cycle's steps; the default until it is read.
  const strips = new Map();
  s.strip = null;
  /** behold#631: the running tool's last finished cycle, when one is published. */
  s.lastCycle = () => {
    // behold#787: while it replays, the replayed cycle, though a newer one has ended since.
    if (s.mode === "replay" && s.replay && s.replay.cycle) return s.replay.cycle;
    const d = s.demo && s.demo.demo;
    const t = vendor ? tool : d && typeof d.tool === "string" ? d.tool : null;
    const r = t ? strips.get(t) : null;
    return r && r.cycle ? r.cycle : null;
  };
  /** Whether the running tool's step order has been read (or there is none to read), so the story can be told in it. */
  s.stripReady = () => {
    const d = s.demo && s.demo.demo;
    const t = vendor ? tool : d && typeof d.tool === "string" ? d.tool : null;
    const r = t ? strips.get(t) : null;
    if (r && r.done) s.strip = r.strip;
    return !t || !!(r && r.done);
  };
  const readStrip = async () => {
    const d = s.demo && s.demo.demo;
    const t = vendor ? tool : d && typeof d.tool === "string" ? d.tool : null;
    if (!t) return;
    const had = strips.get(t);
    if (had && now().getTime() - had.at < STRIP_REREAD_MS) {
      if (s.strip !== had.strip) {
        s.strip = had.strip;
        draw();
      }
      return;
    }
    strips.set(t, { at: now().getTime(), strip: had ? had.strip : null, done: had ? had.done : false, cycle: had ? had.cycle : null });
    const a = await fetchServed(reads.cycle(t));
    const strip = a && a.cycle && Array.isArray(a.cycle.steps) ? stripFromSteps(a.cycle.steps.map((x) => x.step)) : null;
    // behold#631: the cycle itself too, for a chant kiosk's projected track.
    strips.set(t, { at: now().getTime(), strip: strip || (had ? had.strip : null), done: true, cycle: a && a.cycle ? a.cycle : had ? had.cycle : null });
    s.strip = strips.get(t).strip;
    draw();
  };
  setInterval(() => void readStrip(), 2_000);

  s.setMetrics = (m) => {
    s.metrics = m;
    draw();
  };

  // behold#571: on a tool's page the runs pane shows the tool's repo alone; in the replay, the cycle's runs as they stood.
  const runDocs = new Map();
  const runDoc = (id) => {
    if (!runDocs.has(id)) runDocs.set(id, fetchJson(reads.run(id)).then((a) => (a && a.doc ? a.doc : null)));
    return runDocs.get(id);
  };
  const replayRuns = async () => {
    const r = s.replay;
    // behold#787: a replay the viewer ended while this read was out.
    if (!r) return [];
    if (r.runs) return r.runs;
    const idx = await fetchJson(reads.runs);
    const listed = new Map((idx && idx.doc && Array.isArray(idx.doc.runs) ? idx.doc.runs : []).map((x) => [x.id, x]));
    const runs = [];
    for (const id of Array.isArray(r.cycle.runs) ? r.cycle.runs : []) {
      const e = listed.get(id) || (await runDoc(id));
      if (e) runs.push(e);
    }
    // behold#787: /kiosk names no tool; the cycle does.
    r.runs = runs.filter((x) => keepRun(x, { tool: tool || r.cycle.tool, repo: r.cycle.repo }));
    return r.runs;
  };
  const runsSource = () => {
    // behold#787: /kiosk replays too, when the viewer asks.
    if (s.mode === "live") return null;
    if (s.mode !== "replay" || !s.replay) return { index: async () => ({ doc: { schema: "demo.runs/v1", runs: [] } }), run: async () => ({ doc: null, absent: "No run to show yet." }) };
    return {
      index: async () => replayIndex(await replayRuns(), shownNow().getTime()),
      run: async (id) => {
        const doc = await runDoc(id);
        return doc ? { doc: runAsOf(doc, shownNow().getTime()) } : { doc: null, absent: `Run #${id} is no longer kept in the reports.` };
      },
    };
  };
  // behold#571: the approval panel's records: the cycle's runs, the gate ledger's history, and the lane.
  const ap = { runs: new Map(), list: [], lifecycle: null, history: null, at: 0, ledgerAt: 0, busy: false };
  const readApproval = async () => {
    const d = s.demo && s.demo.demo;
    if (!d || !(PANEL_STEPS.includes(d.step) || (s.chantLoop && CHANT_PANEL_STEPS.includes(d.step))) || ap.busy) return;
    const t = now().getTime();
    // behold#631: a new step reads at once (the applied step's card shows the moment the play ends, not a poll later).
    const stepKey = `${d.cycle}|${d.pull}|${d.step}`;
    // While a chant apply runs, read every CHANT_APPLY_POLL_MS so the panel, the track and the waiting modal follow the graph's play.
    const every = s.chantLoop && ["merged", "applying", "resumed"].includes(d.step) ? CHANT_APPLY_POLL_MS : APPROVAL_POLL_MS;
    if (t - ap.at < every && !(s.chantLoop && ap.stepKey !== stepKey)) return;
    ap.stepKey = stepKey;
    ap.busy = true;
    ap.at = t;
    try {
      const src = runsSource();
      const raw = src ? await src.index() : await fetchJson(reads.runs);
      const idx = vendor ? filterIndex(raw, { tool, repo: s.repo }) : raw;
      const mine = cycleRuns(idx && idx.doc && Array.isArray(idx.doc.runs) ? idx.doc.runs : [], d);
      for (const e of mine) {
        const key = `${s.mode}|${e.status}|${e.ended_at}|${src ? Math.floor(shownNow().getTime() / 5000) : ""}`;
        const had = ap.runs.get(e.id);
        if (had && had.key === key) continue;
        const r = src ? await src.run(e.id) : await fetchJson(reads.run(e.id));
        if (r && r.doc) ap.runs.set(e.id, { key, doc: mergeRun(e, r.doc) });
      }
      ap.list = mine.map((e) => ap.runs.get(e.id)).filter(Boolean).map((x) => x.doc);
      if (t - ap.ledgerAt >= LEDGER_POLL_MS) {
        ap.ledgerAt = t;
        // behold#752: chant's demo has no terragucci lane; the gate ledger is chant/lifecycle's alone.
        const [lifecycle, history] = await Promise.all([reads.own ? null : fetchJson("/api/terragucci/lifecycle"), fetchJson("/api/lifecycle/history?limit=200")]);
        ap.lifecycle = lifecycle && !lifecycle.error ? lifecycle : null;
        ap.history = history && !history.error ? history : null;
      }
      // behold#631: a chant repo's pull-request gate, from chant's records at the step's run.
      if (s.chantLoop) {
        const pin = runPin(d);
        const a = await fetchJson(`/api/chant/pr${pin ? `?pin=${encodeURIComponent(pin)}` : ""}`);
        ap.chant = a && !a.error && a.loop ? a : null;
      }
    } finally {
      ap.busy = false;
    }
    draw();
  };
  // behold#631: a fast chant apply played at the pace the graph plays it (web/chant-live-pace.js).
  const chantPacer = createLivePacer();
  // behold#631: the result card at a chant repo's applied step, from the apply's run events.
  s.chantResult = (d) => {
    if (!s.chantLoop || !ap.chant) return null;
    const a = chantPacer.answer(ap.chant);
    // Held, as the caption is, until the paced play reaches the end: never a card that counts "0 applied this run".
    if (chantPacer.pending || !(a.live && a.live.apply && a.live.apply.settled)) return null;
    return chantResultModel(d, a);
  };
  // behold#631: a chant repo's failed and applied steps are told by the graph's paced play: the caption's step line waits
  // for the play to reach them, and shows the step before until then. The strip still moves.
  let capShown = null;
  /** behold#631: the apply's waves as the paced graph shows them now, for the track's ticks; null for another pull request's apply. */
  s.chantWavesNow = (demo) => {
    if (!s.chantLoop || !ap.chant || !ap.chant.live || !ap.chant.live.apply) return null;
    if (demo && Number.isInteger(demo.pull) && Number.isInteger(ap.chant.pull) && demo.pull !== ap.chant.pull) return null;
    const a = chantPacer.answer(ap.chant);
    return { waves: graphWaves(a.live.apply).map((w) => ({ wave: w.wave, state: w.state })), live: a.live.apply };
  };
  // behold#741: a terragucci story's run view, its waves played at the pace chant's are (web/terragucci-live-pace.js).
  const tgPacer = createProgressPacer();
  s.tgPaced = () => tgPacer.progress(s.steady);
  /** behold#741: the run view's waves as the paced graph shows them now, for the track's ticks; null off a terragucci story. */
  s.tgWavesNow = (demo) => {
    if (!s.tgStory || !demo || !["merged", "applying", "resumed", "waiting", "approved", "failed", "applied"].includes(demo.step)) return null;
    const p = s.tgPaced();
    // Another commit's run view (the change's, while the fix's apply starts) says nothing of this step's.
    const c = p && p.run && typeof p.run.commit === "string" ? p.run.commit : null;
    if (c && typeof demo.commit === "string" && demo.commit && !(c.startsWith(demo.commit) || demo.commit.startsWith(c))) return null;
    const waves = trackWaves(p);
    if (!waves || !waves.length) return null;
    const failed = waves.some((w) => w.state === "failed");
    const done = !tgPacer.pending && !!p && p.watching === false && waves.every((w) => w.state === "applied");
    return { waves, live: null, tg: true, failed, done };
  };
  /**
   * behold#631: the step as the story tells it now. The driver writes the failed step only once the apply job ends,
   * seconds after the paced graph has shown the failure, and the applied step after the fix's apply ends. So when the
   * play reaches a failure, or finishes the fix's apply, while demo.json still names the apply's chapter, the story
   * moves to the next chapter of the last cycle (its headline, and its first step for the track). demo.json catches
   * up; the story never goes back within a cycle.
   */
  const story = { cycle: null, n: 0, chapter: null, step: null };
  // behold#787: a seek may go back within a cycle; the story starts from where it lands.
  s.resetStory = () => Object.assign(story, { cycle: null, n: 0, chapter: null, step: null });
  /** behold#631: the forge chant's pipeline runs on, from its loop as /api/chant/pr read it. */
  s.chantForge = () => (ap.chant && ap.chant.loop && ap.chant.loop.forge) || null;
  s.storyDemo = (d) => {
    if (!storyOn(s) || !d || !d.chapter || !Number.isInteger(d.chapter.n)) return d;
    if (story.cycle !== d.cycle) Object.assign(story, { cycle: d.cycle, n: 0, chapter: null, step: null });
    const steps = (s.lastCycle() || {}).steps || [];
    const first = (n) => steps.find((x) => x.chapter && x.chapter.n === n) || null;
    let n = d.chapter.n;
    let chapter = d.chapter;
    let step = d.step;
    const applyStep = ["applying", "merged", "resumed"].includes(d.step);
    const w = applyStep && s.chantLoop && s.chantWavesNow ? s.chantWavesNow(d) : null;
    const comps = w && w.live && w.live.components ? Object.values(w.live.components) : [];
    // behold#741: a terragucci story moves on when the paced run view shows a failure, or every wave applied.
    const tw = applyStep && !s.chantLoop && s.tgWavesNow ? s.tgWavesNow(d) : null;
    const ahead = first(n + 1);
    if (ahead && (comps.some((c) => c.state === "failed") || (w && w.live && w.live.settled && w.live.status === "ok" && !w.live.paced) || (tw && (tw.failed || tw.done)))) {
      n = ahead.chapter.n;
      chapter = ahead.chapter;
      step = ahead.step;
    }
    // Never back: a chapter the story has told stays told until demo.json moves past it.
    if (n > story.n) Object.assign(story, { n, chapter, step });
    else if (story.n > n && story.chapter) {
      n = story.n;
      chapter = story.chapter;
      step = story.step;
    }
    return chapter === d.chapter && step === d.step ? d : { ...d, chapter, step, storyAhead: true };
  };
  s.chantCaptionStep = (demo, step) => {
    const held = s.chantLoop && ap.chant && ap.chant.live && ap.chant.live.apply && demo && ["failed", "applied"].includes(demo.step);
    if (held) {
      chantPacer.answer(ap.chant);
      if (chantPacer.pending && capShown && capShown.id !== demo.step) return capShown;
    }
    // behold#741: a terragucci story's failed and applied steps wait, as chant's do, for the paced waves to reach them.
    if (s.tgStory && demo && ["failed", "applied"].includes(demo.step) && s.tgPaced) {
      s.tgPaced();
      if (tgPacer.pending && capShown && capShown.id !== demo.step) return capShown;
    }
    capShown = step;
    return step;
  };
  const approvalNow = () => {
    const d = s.demo && s.demo.demo;
    // behold#631: chant's gate, one per pull request on the plan's digest, when the repo runs chant's loop.
    // The kiosk's card names the plan by its short id; the approve command is Inspect's.
    const chant = s.chantLoop && ap.chant ? chantApprovalModel({ demo: d, answer: chantPacer.answer(ap.chant), kiosk: true }) : null;
    if (chant) return chant;
    if (!d || !PANEL_STEPS.includes(d.step)) return null;
    const appr = pendingApproval(d, s.progress);
    const driver = appr && s.mode !== "replay" ? { gloss: DRIVER_SIGNS, approve: appr.approve, comment: appr.comment, on: appr.on } : null;
    return approvalModel({ demo: d, runs: ap.list, history: ap.history, lifecycle: ap.lifecycle, fallback: appr, now: shownNow().getTime(), driver });
  };
  // behold#571: a chip in the panel shows its log line in the runs pane (opened, on a phone).
  let runsApi = null;
  s.showLine = (line) => {
    if (!runsApi) return;
    if (tools && tools.runsToggle) setRunsOpen(true);
    runsApi.show(line.run, line.job, line.step, line.n);
  };
  const setRunsOpen = (open) => {
    document.body.classList.toggle("k-runs-open", open);
    if (tools && tools.runsToggle) tools.runsToggle.setAttribute("aria-expanded", String(open));
  };
  if (tools && tools.runsToggle) tools.runsToggle.addEventListener("click", () => setRunsOpen(!document.body.classList.contains("k-runs-open")));

  // behold#571: "What is this?" opens what behold is over the page (no layout moves); a click elsewhere or Escape closes it.
  const whatText = () => {
    if (!tools || !tools.pop) return;
    // behold#777: written again once the repo turns out to be terragucci's, so it names what the intro line names.
    const words = whatTextFor({ chant: !!(s.chantLoop || s.source === "chant-demo"), tg: !!s.tgRepo });
    if (tools.pop.firstElementChild && tools.pop.dataset.words === words) return;
    tools.pop.dataset.words = words;
    const docs = el("a", null, WHAT_DOCS.text);
    docs.href = WHAT_DOCS.url;
    docs.target = "_blank";
    docs.rel = "noopener";
    const more = el("p", "k-what-more");
    more.append(docs);
    tools.pop.replaceChildren(el("p", null, words), more);
  };
  if (tools && tools.what && tools.pop) {
    const setWhat = (open) => {
      tools.pop.hidden = !open;
      tools.what.setAttribute("aria-expanded", String(open));
    };
    tools.what.addEventListener("click", (e) => {
      e.stopPropagation();
      whatText();
      setWhat(tools.pop.hidden);
    });
    document.addEventListener("click", (e) => {
      if (!tools.pop.hidden && !tools.pop.contains(e.target)) setWhat(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setWhat(false);
    });
  }
  // behold#571: the theme picker, persisted per viewer as the app does; the frame follows without a reload.
  if (tools && tools.theme) mountThemePicker(tools.theme);
  onThemeChange((th) => {
    post({ type: "behold:theme", name: th.name });
    draw();
  });

  if (side && main) {
    runsApi = startRuns(
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
        tools: () => s.tools || [],
        rootTools: () => s.rootTools || {},
        light: () => s.light,
        // behold#815: chant's run index is the served repo's runs alone and their history, so the pane reads it whole,
        // on a tool's page and in a replay alike.
        source: runsReads.from ? () => null : runsSource,
        filter: vendor && !runsReads.from ? (index) => filterIndex(index, { tool, repo: s.repo }) : (index) => index,
        replay: () => !runsReads.from && s.mode === "replay",
        hideLine: vendor ? (line) => namesOther(line, tool) : null,
        urls: runsReads,
      },
    );
  }
  // #571: whether the repo offers the components zoom (a terragucci.components.json), read before the frame opens so it opens on the step's view.
  let frameSrcNow = null;
  // behold#571: a frame that has drawn its graph stays up while the next one
  // loads out of sight; the next one swaps in once it says it has drawn
  // (`behold:drawn`), so the graph pane is never an empty frame: not at the
  // merge, not at applied, not at a new cycle, in Watch and in Inspect.
  let frameDrawn = false;
  let bufferTimer = null;
  // While no frame has drawn on this page (a reload, a load in place) the pane says what it waits for (body.k-framewait),
  // dark and never empty; a frame that never says it drew gives the line up after FRAME_WAIT_MS.
  let waitTimer = null;
  // A frame says it drew when its cards are in the svg, a moment before the scene is laid out and fitted: the line goes
  // FRAME_SETTLE_MS after that, so the pane is never between the two with nothing in it.
  const frameWait = (on, settle = 0) => {
    if (typeof document === "undefined" || !document.body || !document.body.classList) return;
    clearTimeout(waitTimer);
    if (!on && settle > 0) {
      waitTimer = setTimeout(() => document.body.classList.remove("k-framewait"), settle);
      return;
    }
    document.body.classList.toggle("k-framewait", !!on);
    if (on) waitTimer = setTimeout(() => document.body.classList.remove("k-framewait"), FRAME_WAIT_MS);
  };
  frameWait(true);
  const bootAt = now().getTime();
  let bootRetry = null;
  // The graph's room changes after the first shot (the banner, the pane's height, web fonts, the frame's own box): tell the
  // frame again, once, at the end of the change, without a move. The key keeps it cheap when nothing moved.
  const refitShot = debounced(() => tellShot(false, true), REFIT_WAIT_MS);
  const watched = new Set();
  const watchBox = (el) => {
    if (!el || watched.has(el) || typeof ResizeObserver === "undefined") return;
    watched.add(el);
    new ResizeObserver(refitShot).observe(el);
  };
  if (typeof window !== "undefined") {
    window.addEventListener("resize", refitShot);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => tellShot(false, true), () => {});
  }
  const wireLoad = (el) => {
    watchBox(el);
    watchBox(watch && watch.ask);
    el.addEventListener("load", () => {
      // A new frame takes Watch's shot before it draws, so it opens on it and never on the fit.
      tellShot(true, false, el.contentWindow);
      tellFrame(true);
      // The frame reads its graph after load; tell it again once it has had the time.
      for (const ms of [1500, 4000, 8000]) setTimeout(() => (tellFrame(true), tellShot(true, false, el.contentWindow)), ms);
    });
  };
  const swapFrame = () => {
    if (!buffer) return;
    clearTimeout(bufferTimer);
    const old = frame;
    buffer.id = old.id;
    buffer.className = old.className;
    buffer.removeAttribute("style");
    buffer.removeAttribute("aria-hidden");
    buffer.removeAttribute("tabindex");
    old.remove();
    frame = buffer;
    buffer = null;
    frameDrawn = true;
    frameWait(false);
    s.boxes = null;
    s.framePop = null; // behold#764: the old frame's details popover went with it
    lastFocus = undefined;
    tellFrame(true);
    tellShot(true);
    draw();
  };
  const openFrame = () => {
    if (!frame) return;
    // The first load waits (a few seconds at most) for the narration, which names the checkout the step is on: one load, not two.
    if (frameSrcNow === null && !(s.demo && s.demo.demo) && now().getTime() - bootAt < FRAME_BOOT_WAIT_MS) {
      if (!bootRetry) bootRetry = setTimeout(() => ((bootRetry = null), openFrame()), 400);
      return;
    }
    const src = frameSrc(origin, viewZoom(shownView().view), wantRepo(), getThemeName());
    if (src === frameSrcNow) return;
    const first = frameSrcNow === null;
    frameSrcNow = src;
    if (first) wireLoad(frame);
    // Nothing drawn yet to keep up (the first load, or a load before the last one drew): load in place.
    if (first || !frameDrawn || typeof document === "undefined" || !frame.parentNode) {
      frameDrawn = false;
      frameWait(true);
      frame.src = src;
      return;
    }
    if (buffer) {
      clearTimeout(bufferTimer);
      buffer.remove();
    }
    buffer = document.createElement("iframe");
    buffer.title = frame.title;
    buffer.className = "k-frame-next";
    buffer.setAttribute("aria-hidden", "true");
    buffer.setAttribute("tabindex", "-1");
    // Over the shown frame, its size, out of sight: it lays out as the shown one does, so it opens on the same fit and shot.
    Object.assign(buffer.style, { position: "absolute", left: `${frame.offsetLeft}px`, top: `${frame.offsetTop}px`, width: `${frame.offsetWidth}px`, height: `${frame.offsetHeight}px`, opacity: "0", pointerEvents: "none", border: "0" });
    wireLoad(buffer);
    buffer.src = src;
    frame.parentNode.insertBefore(buffer, frame.nextSibling);
    // A frame that never says it drew still swaps in, late, rather than never.
    bufferTimer = setTimeout(swapFrame, FRAME_SWAP_MS);
  };
  // #715: a frame drawing a live carve tells the kiosk what to say; one that does not says nothing, and nothing here changes.
  if (typeof window !== "undefined" && window.addEventListener && watch) carveCtl = startKioskCarve({ frame: () => frame, watch, eh, origin, isWatch: () => s.watchMode });
  s.slowedControl = () => (carveCtl ? carveCtl.slowedControl() : null);
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("message", (e) => {
      if (e.origin !== origin || !e.data || e.data.type !== "behold:drawn") return;
      if (buffer && e.source === buffer.contentWindow) swapFrame();
      else if (frame && e.source === frame.contentWindow) (frameDrawn = true), frameWait(false, FRAME_SETTLE_MS);
    });
  }
  /** behold#571: the commit each served checkout holds, read again when a step names a new one. */
  const readCommits = () => fetchJson("/api/project").then((p) => {
    if (p && !p.error && Array.isArray(p.viewRepos)) {
      s.viewRepos = p.viewRepos;
      s.viewCommits = p.viewCommits || null;
      draw();
    }
  });
  const readProject = () => fetchJson("/api/project").then((p) => {
    // behold#571: the repos this behold serves, and which one this answer is.
    if (p && !p.error && Array.isArray(p.viewRepos)) {
      s.viewRepos = p.viewRepos;
      s.viewCommits = p.viewCommits || null;
      if (s.aimed === null && p.viewRepo) s.aimed = p.viewRepo;
    }
    if (p && !p.error) s.single = !Array.isArray(p.viewRepos);
    // A chant project's graph is its components (web/app.js bootZoom), so it has that view too.
    s.components = !!(p && !p.error && (p.terragucciComponents || chantProject(p)));
    // behold#631: a chant project may run chant's pull-request loop; /api/chant/pr says (its `loop`).
    s.chantLoop = !!(p && !p.error && !p.terragucciComponents && chantProject(p));
    // behold#741: a terragucci repo, whose chapter-carrying scenarios get the same look (storyGate).
    s.tgRepo = !!(p && !p.error && p.terragucciComponents);
    // behold#571: the declared roots (their colours' order) and the wave jobs that apply them.
    if (p && p.terragucciRoots) {
      s.roots = Array.isArray(p.terragucciRoots.roots) ? p.terragucciRoots.roots : [];
      s.waves = Array.isArray(p.terragucciRoots.waves) ? p.terragucciRoots.waves : [];
      // behold#571: the tools the repo's jobs run, for a job row whose log isn't read yet.
      s.tools = Array.isArray(p.terragucciRoots.tools) ? p.terragucciRoots.tools : [];
      s.rootTools = p.terragucciRoots.rootTools && typeof p.terragucciRoots.rootTools === "object" ? p.terragucciRoots.rootTools : {};
      // behold#741: the forge, for a chapter-carrying scenario's title line.
      s.tgForge = typeof p.terragucciRoots.forge === "string" ? p.terragucciRoots.forge : null;
    } else if (s.aimed) {
      s.roots = [];
      s.waves = [];
      s.tools = [];
      s.rootTools = {};
    }
    openFrame();
    draw();
  });
  void readProject();

  const reports = async (fresh) => {
    // behold#752: chant's demo writes no terragucci reports or run view; its facts come through /api/chant/pr.
    if (reads.own) return;
    s.answer = await fetchJson(`/api/terragucci${fresh ? "?fresh=1" : ""}`);
    draw();
  };
  // #569: the run view of the cycle's commit, the same one the frame draws.
  const pinnedCommit = () => {
    const pin = runPin(s.demo && s.demo.demo);
    return pinsCommit(pin) ? pin : null;
  };
  const progress = async (fresh) => {
    if (reads.own) return;
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
    const a = await fetchJson(reads.cycle(tool));
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

  // behold#725: the stopped-updating cue. The demo poll and the event stream
  // report whether they came back; while one fails, a line over the header
  // says since when nothing has come in (web/kiosk-link.js).
  const link = linkState();
  let linkLine = null;
  let linkWas = null;
  const paintLink = () => {
    const words = linkWords(link);
    // The tour's live badge and its lag follow the cue (web/carve-narration.js liveBadge).
    if (words !== linkWas) { linkWas = words; shareLink(link); }
    if (!linkLine && !words) return;
    if (!linkLine) {
      const host = bar && bar.parentNode;
      if (!host || typeof document === "undefined" || !host.insertBefore) return;
      linkLine = el("p", "k-link");
      linkLine.setAttribute("role", "status");
      host.insertBefore(linkLine, bar);
    }
    linkLine.hidden = !words;
    linkLine.textContent = words || "";
  };

  // A quiet step: when nothing new has come in for a while during a step
  // that runs, the caption says what is running and for how long
  // (kiosk-watch.js quietWords). A record is the driver's step, a job or
  // step changing state in the run's view, or a progress line the carve's
  // frame has drawn. Never on a replay, and never while the link cue is up.
  let recordWas = null;
  let recordAt = null;
  let stepSeenAt = null;
  // The last driver step read and the newest progress line seen: a failed poll or a frame between carves does not count as a new record.
  let quietDemo = null;
  let writeSeen = null;
  s.quietTick = () => {
    const t = now().getTime();
    const read = s.demo && s.demo.demo;
    if (read) quietDemo = read;
    else if (s.mode !== "live") quietDemo = null;
    const d = quietDemo;
    const runDoc = runsApi && runsApi.run ? runsApi.run.doc : null;
    const run = runningStep(runDoc);
    const w = carveCtl ? carveCtl.lastWriteAt() : null;
    if (typeof w === "number" && (writeSeen === null || w > writeSeen)) writeSeen = w;
    // Only a new driver step or a new progress line restarts the clock; a job or step changing state only changes the words.
    const key = recordKey(d, writeSeen);
    if (key !== recordWas) {
      const first = recordWas === null;
      const stepChanged = !first && recordWas.split("#")[0] !== key.split("#")[0];
      // The first look: the newest record's own time, where one says it, so a page opened in a long step shows the line at once.
      const known = first && d ? [d.next && d.next.from ? Date.parse(d.next.from) : NaN, writeSeen].filter((x) => typeof x === "number" && Number.isFinite(x) && x <= t) : [];
      if (first || stepChanged) stepSeenAt = t;
      recordWas = key;
      recordAt = known.length ? Math.max(...known) : t;
    }
    s.quiet = quietWords(d, { now: t, lastRecordAt: recordAt, run, stepAt: stepSeenAt, replay: s.mode === "replay", stale: !!linkWords(link) });
    // behold#631: how long nothing new has come in, for the "Waiting on…" modal.
    s.quietFor = typeof recordAt === "number" ? t - recordAt : 0;
    // behold#631: a chant kiosk's "· N s so far" counts only while a job of the step runs; a step that is done has no timer.
    // With the projected track up, its now line says it: the caption's quiet line goes.
    if (s.chantLoop && s.quiet && (!(run && run.job) || s.trackOn)) s.quiet = null;
    // behold#741: with the projected track up on a terragucci story, its now line says it too.
    else if (s.tgStory && s.quiet && s.trackOn) s.quiet = null;
    if (carveCtl) carveCtl.setQuiet(s.quiet);
  };

  const demo = async () => {
    const live = await fetchJson(reads.demo);
    noteRead(link, "poll", !readFailed(live), now());
    paintLink();
    s.live = live;
    // behold#787: the poll leaves a replay the viewer asked for alone; its end takes the live step from here.
    if (viewerReplay(s)) return draw();
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

  applyMode();
  void demo();
  void reports(false);
  void progress(false);
  setInterval(() => void demo(), DEMO_POLL_MS);
  setInterval(() => void readApproval(), 1000);
  setInterval(draw, 1000);

  if (typeof EventSource !== "undefined" && !reads.own) {
    const es = new EventSource("/api/terragucci/events");
    // behold#725: the browser retries a dropped stream by itself (CONNECTING);
    // one it closed for good (a 404, say) leaves the polls to carry the cue.
    es.addEventListener("open", () => { noteBack(link, "stream"); paintLink(); });
    es.addEventListener("error", () => {
      if (es.readyState === 2) noteBack(link, "stream");
      else noteRead(link, "stream", false, now());
      paintLink();
    });
    const heard = () => { noteRead(link, "stream", true, now()); paintLink(); };
    es.addEventListener("reports", heard);
    es.addEventListener("progress", heard);
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

// behold#725: `unreachable` marks a read that never got an answer, or got a
// server error, so the stopped-updating cue can tell it from a source that
// answered with an error of its own (kiosk-link.js readFailed).
async function defaultFetch(url) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (r.status >= 500) {
      const body = await r.json().catch(() => ({}));
      return { error: body.error || `${url} answered ${r.status}`, ...body, unreachable: true };
    }
    const body = await r.json();
    return r.ok ? body : { error: body.error || `${url} answered ${r.status}`, ...body };
  } catch (e) {
    return { error: `${url}: ${e instanceof Error ? e.message : String(e)}`, unreachable: true };
  }
}

export { STATE_WORDS };
