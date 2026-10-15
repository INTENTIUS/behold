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

import { startRuns } from "./kiosk-runs.js";
import { STATE_WORDS, changingRoots, costLine, readEdges, rootsCount, totalsLine, waveRows, blastRows } from "./terragucci-change.js";

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

/** "Scenario 3 of 6 · B on waves", or the driver's title alone for an id behold doesn't know. */
export function scenarioHead(demo) {
  const known = Object.prototype.hasOwnProperty.call(SCENARIOS, demo.scenario) ? SCENARIOS[demo.scenario] : null;
  if (!known) return { kicker: `scenario ${demo.scenario}`, title: demo.title };
  if (known.n === null) return { kicker: demo.title || "The base", title: demo.title || "The base" };
  return { kicker: `scenario ${known.n} · ${known.name}`, title: demo.title };
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
 * demo.json names. A forge never reuses a number, so an older cycle's plan is
 * never shown as this one's.
 */
export function matchingPull(answer, demo) {
  const pr = pullOf(answer);
  if (!pr || demo.pull === null) return null;
  return String(pr.run.pull_request) === String(demo.pull) ? pr : null;
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
 * stack/demo.sh gives it: `approve_wave` runs chant's approve, sealed with
 * the driver's ssh key, then `resume_pull` posts `/terragucci apply` on the
 * merged pull request. The actor and the key are placeholders: the kiosk
 * never names a path or a secret.
 */
export function driverApproveLines(wave, pull) {
  return {
    approve: `chant approve tf-apply wave-${wave} --actor <driver> --sign <driver key>`,
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

/** The framed view's address: behold's own page, bare, at the resources zoom, told who its host is. */
export function frameSrc(origin) {
  const q = new URLSearchParams({ embed: "1", bare: "1", zoom: "resources", host: origin });
  return `/?${q.toString()}`;
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

/** Draw the bar and the foot from what the kiosk holds. Pure over its arguments, but for the DOM. */
export function renderKiosk(bar, s, now = new Date(), foot = null) {
  bar.replaceChildren();
  if (foot) foot.replaceChildren();
  if (!s.demo || !s.demo.demo) {
    const box = el("div", "k-empty");
    box.appendChild(el("h1", "k-title", "Waiting for the demo"));
    box.appendChild(el("p", "k-muted", s.demo ? s.demo.error || s.demo.absent : "Reading demo.json…"));
    bar.appendChild(box);
    return;
  }
  const demo = s.demo.demo;
  const head = scenarioHead(demo);

  const left = el("div", "k-left");
  const kick = el("div", "k-kicker");
  kick.append(el("span", null, head.kicker), el("span", "k-cycle", cycleWords(demo, now)));
  left.appendChild(kick);
  left.appendChild(el("h1", "k-title", head.title));
  const said = el("div", `k-step k-step-${demo.step}`);
  said.appendChild(el("span", "k-step-word", STEP_WORDS[demo.step] || demo.step));
  said.appendChild(el("p", "k-label", demo.label));
  left.appendChild(said);
  bar.appendChild(left);

  const right = el("div", "k-right");
  const strip = el("ol", "k-strip");
  for (const stop of stripStops(demo.step)) strip.appendChild(el("li", `k-stop k-${stop.state}`, stop.words));
  right.appendChild(strip);

  const nx = nextWords(demo, now);
  const next = el("div", "k-next");
  next.appendChild(el("span", "k-next-word", "next, by the driver"));
  next.appendChild(el("span", "k-action", nx.action));
  next.appendChild(el("span", "k-when", nx.when));
  right.appendChild(next);

  const appr = pendingApproval(demo, s.progress);
  if (appr) {
    const a = el("div", "k-approve");
    a.appendChild(
      el(
        "p",
        "k-approve-head",
        `The driver approves wave ${appr.wave}${appr.roots.length ? ` (${appr.roots.join(", ")})` : ""}, signed with its own key${appr.digest ? `, for the plan ${appr.digest.replace(/^jcs1-sha256:/, "").slice(0, 12)}` : ""}:`,
      ),
    );
    a.appendChild(el("code", "k-command", appr.approve));
    const then = el("p", "k-approve-then");
    then.append(`then comments `, el("code", "k-inline", appr.comment), ` on ${appr.on}, and the waves run again.`);
    a.appendChild(then);
    right.appendChild(a);
  } else {
    const panel = runPanel(demo, s.answer, s.progress);
    if (panel.note) right.appendChild(el("p", "k-note", panel.note));
    else if (panel.stage === "pull-request") for (const u of unreviewedLines(s.answer)) right.appendChild(el("p", "k-note k-unknown", u));
  }
  bar.appendChild(right);

  if (foot) {
    foot.appendChild(el("span", "k-legend", "Each box is a Terraform root with its own state; an arrow is one root reading another's outputs, dashed while it reads planned values. A wave applies its roots together, after the waves it reads."));
    for (const f of factLines(demo, s.answer)) foot.appendChild(el("span", "k-fact", f));
    foot.appendChild(
      el("span", "k-source", `narration read ${clockOf(s.demo.read)} from ${s.demo.source}${demo.pull !== null ? ` · pull request #${demo.pull}` : ""}${demo.commit ? ` · commit ${demo.commit.slice(0, 8)}` : ""} · nothing here writes`),
    );
  }
}

const clockOf = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")} UTC`;
};

/** How often the kiosk asks for demo.json. The server shares one read between kiosks. */
export const DEMO_POLL_MS = 3_000;

/**
 * Boot the kiosk: the bar, the frame and the foot. Ask demo.json every few
 * seconds, the reports and the run view when the step, cycle or commit moves
 * or the event stream says they did, and redraw every second for the
 * countdown. When the roots the step is about change, move the framed view
 * with a `behold:view` message; the frame takes them only from this origin.
 */
export function startKiosk({ bar, frame, foot, side, main }, { fetchJson = defaultFetch, now = () => new Date(), origin = location.origin } = {}) {
  const s = { demo: null, answer: null, progress: null };
  let lastKey = "";
  let lastFocus;
  const tellFrame = (force) => {
    const d = s.demo && s.demo.demo;
    const roots = focusRoots(d, s.answer, s.progress);
    const focus = roots ? roots.join(",") : null;
    if (!force && focus === lastFocus) return;
    lastFocus = focus;
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: "behold:view", member: null, focus }, origin);
  };
  const draw = () => {
    renderKiosk(bar, s, now(), foot);
    tellFrame(false);
  };
  // #569: the pipeline's runs beside the view, CI-page style.
  if (side && main) startRuns({ side, main }, { fetchJson, now, scenarios: SCENARIOS });
  if (frame) {
    frame.src = frameSrc(origin);
    // The frame reads its graph after load; tell it again once it has had the time.
    frame.addEventListener("load", () => {
      for (const ms of [1500, 4000, 8000]) setTimeout(() => tellFrame(true), ms);
    });
  }

  const reports = async (fresh) => {
    s.answer = await fetchJson(`/api/terragucci${fresh ? "?fresh=1" : ""}`);
    draw();
  };
  const progress = async (fresh) => {
    s.progress = await fetchJson(`/api/terragucci/progress${fresh ? "?fresh=1" : ""}`);
    draw();
  };

  const demo = async () => {
    s.demo = await fetchJson("/api/terragucci/demo");
    const d = s.demo && s.demo.demo;
    const key = d ? `${d.cycle}|${d.step}|${d.commit}|${d.pull}` : "";
    if (key !== lastKey) {
      lastKey = key;
      // The step moved: the run it is about may be newer than what behold read.
      const stage = d ? demoStage(d) : "none";
      if (stage === "pull-request" || stage === "either") void reports(true);
      if (stage === "apply" || stage === "either") void progress(true);
    }
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
        s.progress = JSON.parse(e.data);
        draw();
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
