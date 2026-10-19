// #568 step 1: a change across several roots of one terragucci repo, in the
// card view. app.js has /api/terragucci (its `pull_request`: the newest
// tf-plan of a pull request) and /api/terragucci/progress (its `states` and
// `reads`: the run view of the newest apply), and draws what these return.
//
// Two stages. Before the merge there is no run view, so the pull request's
// plan is the picture: which root read which root's planned outputs, what it
// read before it was known, which wave plans again after which, the blast
// radius, the totals and the cost. From the merge on, the run view's waves
// carry the state, for any binary. Each line is dated by the run it came
// from; none of it is live.
//
// A wave that failed says so, and the waves before it that applied stay
// applied: nothing here is all-or-nothing.
//
// #568 step 3: a composed run (INTENTIUS/terragucci#1013, `waves.compose`):
// one wave covering several roots, each root's changes under its own name,
// the outputs read before they were known and the approval they hold the run
// for, and on a failure which roots applied, which didn't, and each state as
// written. What applied stays applied; nothing is called atomic. A report or
// run view without the composed fields draws as before.

import { ago, clock, hrefOf } from "./terragucci.js";
import { coneFact, coneOf, coneResourceLines, fallbackWhy } from "./cone.js";

export const STATE_WORDS = {
  "not-started": "queued",
  planned: "planned",
  waiting: "waiting for an approval",
  applying: "applying",
  applied: "applied",
  refused: "refused",
  failed: "failed",
};

const short = (digest) => (digest ? digest.replace(/^jcs1-sha256:/, "").slice(0, 12) : "");
const list = (xs) => xs.join(", ");

/**
 * Which stage the change is in: `apply` once the run view is newer than the
 * pull request's plan, `pull-request` before that, `none` with neither.
 */
export function changeStage(answer, progress) {
  const pr = answer && !answer.error ? answer.pull_request : null;
  const run = progress && !progress.error && progress.run && progress.run.present && progress.states && progress.states.length ? progress.run : null;
  if (run && (!pr || (run.updated || "") >= pr.run.finished)) return "apply";
  if (pr) return "pull-request";
  return "none";
}

/**
 * The reads edges between roots: from the pull request's plan (`planned` or
 * `applied`, with the outputs read before they were known), or from the run
 * view once the change merged (its state as it stands then).
 */
export function readEdges(answer, progress) {
  const stage = changeStage(answer, progress);
  // Two choudoufu roots: the reader reads the estate's outputs (terraform_estate_outputs); there is no state file to read.
  const bin = (answer && answer.binaries) || {};
  const estate = (from, to) => (bin[from] === "choudoufu" && bin[to] === "choudoufu" ? { estate: true } : {});
  if (stage === "pull-request") {
    const run = answer.pull_request.compose && answer.pull_request.compose.wave;
    return answer.pull_request.reads.map((r) => ({
      from: r.root,
      to: r.upstream,
      data: r.data,
      outputs: r.outputs,
      unknown: r.unknown || [],
      ...(r.why ? { why: r.why } : {}),
      ...(r.composed && run !== undefined ? { composed: run } : {}),
      ...estate(r.root, r.upstream),
      stage,
    }));
  }
  if (stage === "apply") {
    const runOf = new Map(progress.reads.filter((r) => r.composed).map((r) => [r.root, r.composed.wave]));
    return progress.reads.flatMap((r) =>
      r.reads.map((up) => ({
        from: r.root,
        to: up,
        data: null,
        outputs: "applied",
        unknown: [],
        stage,
        wave: r.wave,
        ...estate(r.root, up),
        // #568 step 3: both ends in one composed run: the read is inside it.
        ...(r.composed && runOf.get(up) === r.composed.wave ? { composed: r.composed.wave } : {}),
      })),
    );
  }
  return [];
}

/** One reads edge as a sentence: "app reads network's planned outputs (data network), known after network applies: subnet_id". */
export function readLine(e) {
  const via = e.data ? ` (data ${e.data})` : "";
  if (e.composed !== undefined) {
    // #568 step 3: a read inside a composed run: the run applies the reader after the root it reads.
    const unknown = e.unknown.length ? `, read before known, known once ${e.to}'s part of the run applies: ${list(e.unknown)}` : "";
    return `${e.from} reads ${e.to}${via}, in wave ${e.composed}'s composed run${unknown}`;
  }
  const what = e.outputs === "planned" ? `${e.to}'s planned outputs` : e.estate ? `${e.to}'s outputs as they stand` : `${e.to}'s state as it stands`;
  const unknown = e.unknown.length ? `, read before known, known after ${e.to} applies: ${list(e.unknown)}` : "";
  const why = e.why ? ` (${e.why})` : "";
  return `${e.from} reads ${what}${via}${unknown}${why}`;
}

/** The short tag on a reader's data card: "reads network · planned · 1 unknown". */
export function readTag(e) {
  return `reads ${e.to} · ${e.composed !== undefined ? "in the composed run" : e.outputs}${e.unknown.length ? ` · ${e.unknown.length} unknown` : ""}`;
}

/**
 * The checkout's card id for a reader's data block, for each kind of block
 * that reads another root. The run view names no data block (#569): there the
 * block named after the root it reads is tried, and the caller falls back to
 * the reader's box when the checkout has none.
 */
export function readCardIds(answer, e) {
  const data = e.data || (e.stage === "apply" ? e.to : null);
  if (!data || !answer || !answer.roots) return [];
  const r = answer.roots.find((x) => x.path === e.from);
  if (!r) return [];
  return [`${r.member}/${r.name}/data.terraform_remote_state.${data}`, `${r.member}/${r.name}/data.terraform_estate_outputs.${data}`];
}

/** "5 create · 1 update", no-ops and zeros left out; "unchanged" when nothing moves. */
export function totalsLine(totals) {
  if (!totals) return null;
  const order = ["create", "update", "replace", "delete", "forget", "import", "read"];
  const keys = [...order.filter((k) => k in totals), ...Object.keys(totals).filter((k) => !order.includes(k) && k !== "no-op").sort()];
  const parts = keys.filter((k) => totals[k] > 0).map((k) => `${totals[k]} ${k}`);
  return parts.length ? parts.join(" · ") : "unchanged";
}

/** #568 step 2: "across 3 roots", from `totals_roots` (report minor 35); null on an older report, which has no count. */
export function rootsCount(n, noun = { one: "root", many: "roots" }) {
  if (n === undefined || n === null) return null;
  return `across ${n} ${n === 1 ? noun.one : noun.many}`;
}

const money = (n) => (n === null || n === undefined ? "no figure" : n.toFixed(2));
const signed = (n) => (n === null || n === undefined ? "no figure" : `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(2)}`);

/** "cost: +10.50 USD a month, from 26.00 to 36.50 (estimated by node)". A wave's cost has no estimator. */
export function costLine(cost) {
  if (!cost) return null;
  const by = cost.estimator ? ` (estimated by ${cost.estimator})` : "";
  const over = cost.approve_above !== undefined ? ` · approval above ${money(cost.approve_above)}${cost.over ? ", over it" : ""}` : "";
  const missing = cost.unestimated && cost.unestimated.length ? ` · no estimate for ${list(cost.unestimated)}` : "";
  const failed = (cost.roots || []).filter((r) => r.error).map((r) => r.root);
  const rootsMissing = failed.length ? ` · no estimate for ${list(failed)}` : "";
  if (cost.monthly_delta === null) return `cost: no estimate${by}${missing}${rootsMissing}`;
  return `cost: ${signed(cost.monthly_delta)} ${cost.currency} a month, from ${money(cost.past_monthly_total)} to ${money(cost.monthly_total)}${by}${over}${missing}${rootsMissing}`;
}

const reachText = (x) => `${x.root}: ${x.address}${x.through ? ` through ${x.through.root} output ${x.through.output}` : ""}`;

/**
 * #568 step 2: a changed resource's reaches, grouped by distance (`depth`,
 * report minor 36), nearest first: "at 1: app: a; at 2: app: b, edge: c". A
 * report before minor 36 has no depth: its reaches stay in their order,
 * nearest first, with no count, as terragucci wrote them.
 */
export function reachGroups(reaches) {
  if (!reaches.length || !reaches.every((x) => typeof x.depth === "number")) return [{ depth: null, reaches: reaches.map(reachText) }];
  const by = new Map();
  for (const x of reaches) {
    if (!by.has(x.depth)) by.set(x.depth, []);
    by.get(x.depth).push(reachText(x));
  }
  return [...by.keys()].sort((a, b) => a - b).map((depth) => ({ depth, reaches: by.get(depth) }));
}

/** The reach groups as one line: "at distance 1: …; at distance 2: …", or the plain list when there is no depth. */
export function reachLine(groups) {
  if (!groups.length || (groups.length === 1 && !groups[0].reaches.length)) return "nothing";
  if (groups[0].depth === null) return `nearest first: ${list(groups[0].reaches)}`;
  return groups.map((g) => `at distance ${g.depth}: ${list(g.reaches)}`).join("; ");
}

/**
 * The blast radius, nearest first, as terragucci recorded it: each changed
 * resource and the resources it reaches, by distance from it across roots
 * (an older report without depth: in their order, without a count); then the
 * roots downstream, and the checkout's roots the pull request did not plan.
 */
export function blastRows(answer) {
  const pr = answer && answer.pull_request;
  if (!pr) return null;
  const b = pr.blast;
  const planned = new Set(pr.roots);
  const unplanned = (answer.roots || []).map((r) => r.path).filter((p) => !planned.has(p));
  return {
    changed: b ? b.roots : [],
    resources: b && b.resources
      ? b.resources.map((r) => ({
          head: `${r.root}: ${r.address} (${r.actions.join(", ")})`,
          reaches: reachGroups(r.reaches),
        }))
      : [],
    downstream: b ? b.downstream.map((d) => `${d.root}${d.wave !== undefined ? ` (wave ${d.wave})` : ""}${d.planned ? "" : ", not planned"}`) : [],
    unplanned,
  };
}

/** "network, app and edge". */
const and = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * #568 step 3: the pull request's composed run, or why its change applies in
 * waves (`compose`, report minor 38). Null when `waves.compose` is off.
 */
export function composeLine(pr) {
  const c = pr && pr.compose;
  if (!c) return null;
  if (c.wave !== undefined) {
    return `one composed run, in wave ${c.wave} (waves.compose): ${and(c.roots)} plan as one plan and apply as one apply. Each root keeps its own state: the run locks each state, applies, and writes each state back with what applied to it. If the apply fails part way, what applied stays applied.`;
  }
  if (c.fallback) return `applies in waves (waves.compose): ${c.fallback.reason}`;
  return null;
}

const APPLY_WORDS = { applied: "applied", partial: "applied in part", failed: "failed", "not-started": "queued", "no-changes": "unchanged" };
const STATE_AS = { written: "state written", unchanged: "state as it was, nothing to write", "not-written": "state not written" };

/** One member of a composed run as planned: "app as module.app: 1 create". */
export function memberPlanLine(m) {
  const counts = m.counts ? totalsLine(m.counts) : null;
  return `${m.root} as ${m.module}${counts ? `: ${counts}` : ""}`;
}

/**
 * One member once the run ended: "network: applied, 1 of 1; state written".
 * A state the run could not write says where it was kept and that its lock is
 * still held.
 */
export function memberApplyLine(m) {
  const parts = [];
  if (m.apply) parts.push(`${APPLY_WORDS[m.apply] || m.apply}${m.changes ? `, ${m.changes.done} of ${m.changes.planned}` : ""}`);
  if (m.state) {
    let st = STATE_AS[m.state] || `state ${m.state}`;
    if (m.state === "not-written") st += `${m.kept ? `, kept at ${m.kept}` : ""}${m.lock_held ? ", its lock still held" : ""}`;
    parts.push(st);
  }
  if (m.error) parts.push(m.error);
  return `${m.root}${parts.length ? `: ${parts.join("; ")}` : ` as ${m.module}`}`;
}

/**
 * The members that read a value of another member unknown at plan time; with
 * `waits`, as why the run waits for an approval ("waits for an approval, since
 * app reads a value of another root in the run unknown at plan time").
 */
export function unknownFact(who, waits) {
  const what = `${and(who)} ${who.length === 1 ? "reads a value" : "read values"} of another root in the run unknown at plan time`;
  return waits ? `waits for an approval, since ${what}` : what;
}

/**
 * The waves, by stage. In a pull request: each planned wave, the one that
 * plans again after an earlier wave applies (with no digest until then), and
 * its cost. From the merge on: each wave's state in the run view, the waiting
 * wave's digest and approve line, and on a failed or refused wave, the waves
 * before it that applied and stay applied.
 */
export function waveRows(answer, progress, now = new Date()) {
  const stage = changeStage(answer, progress);
  if (stage === "pull-request") {
    return answer.pull_request.waves.map((w) => {
      const facts = [];
      const c = w.composed;
      if (c) {
        // #568 step 3: each root's changes under its own name, and the run's one digest.
        facts.push(`composed run, each root under its own name: ${c.members.map(memberPlanLine).join("; ")}`);
        if (c.plan_digest === null) facts.push("the composed plan failed");
        if (c.error) facts.push(`the composed run: ${c.error}`);
      }
      if (w.replans_after && w.replans_after.length) facts.push(`plans again after wave ${list(w.replans_after)} applies, no digest until then`);
      else if (w.review_digest) facts.push(`${c ? "one digest for the wave and its composed run, " : ""}review digest ${short(w.review_digest)}`);
      else if (w.set_digest) facts.push(`plan ${short(w.set_digest)}`);
      if (c && c.held_by_unknown && c.held_by_unknown.length) facts.push(unknownFact(c.held_by_unknown, !!w.waits));
      else if (w.waits) facts.push("will wait for an approval");
      if (w.reads && w.reads.length) facts.push(`after wave ${list(w.reads)}`);
      const cost = costLine(w.cost);
      if (cost) facts.push(cost);
      return { number: w.number, state: w.state || "planned", tone: (w.replans_after && w.replans_after.length) || (c && c.held_by_unknown && c.held_by_unknown.length) ? "wave" : "plan", text: `wave ${w.number} ${STATE_WORDS[w.state || "planned"]}: ${list(w.roots)}${c ? ", composed" : ""}`, facts, ...(c ? { composed: true } : {}) };
    });
  }
  if (stage === "apply") {
    const states = progress.states;
    return states.map((w) => {
      const facts = [];
      const c = w.composed;
      // #568 step 3: roots that would be in this wave on their own, applied by an earlier wave's composed run.
      const moved = progress.reads.filter((r) => r.composed && r.composed.own_wave === w.number && r.composed.wave !== w.number);
      if (c) {
        const modules = new Map(progress.reads.filter((r) => r.composed).map((r) => [r.root, r.composed.module]));
        facts.push(`composed run: ${c.roots.map((r) => (modules.has(r) ? `${r} as ${modules.get(r)}` : r)).join(", ")}; one plan, one apply, each root keeps its own state`);
        if (c.unknown && c.unknown.length) facts.push(unknownFact(c.unknown, w.state === "waiting"));
      }
      if (moved.length) {
        const by = [...new Set(moved.map((r) => r.composed.wave))];
        facts.push(`${and(moved.map((r) => r.root))} ${moved.length === 1 ? "applies" : "apply"} in wave ${list(by)}'s composed run`);
      }
      if (w.reads.length) facts.push(`after wave ${list(w.reads)}`);
      if (w.digest) facts.push(`${c ? "one digest for the wave and its composed run, " : ""}plan ${short(w.digest)}`);
      // #568 step 2: the wave's own totals, once it planned (a wave not started has none).
      const totals = totalsLine(w.totals);
      if (totals) facts.push(`changes: ${totals}${rootsCount(w.totals_roots) ? ` ${rootsCount(w.totals_roots)}` : ""}`);
      if (c && c.members) {
        // Once the apply ended: which roots applied, which didn't, and each state as written.
        if (w.state === "failed") facts.push("the composed run failed part way: what applied stays applied. Each root's part and its state as written:");
        for (const m of c.members) facts.push(memberApplyLine(m));
      }
      if (w.state === "failed" || w.state === "refused") {
        const before = states.filter((x) => x.number < w.number && x.state === "applied").map((x) => x.number);
        facts.push(before.length ? `wave ${list(before)} applied before it and stays applied` : "no wave before it applied");
      }
      const roots = !w.roots.length && moved.length ? "no roots of its own" : list(w.roots);
      return {
        number: w.number,
        state: w.state,
        tone: w.state === "failed" || w.state === "refused" ? "failed" : w.state === "waiting" || w.state === "applying" ? "wave" : w.state === "applied" ? "ok" : "none",
        text: `wave ${w.number} ${STATE_WORDS[w.state] || w.state}: ${roots}${c ? ", composed" : ""}`,
        ...(c ? { composed: true } : {}),
        facts,
        ...(w.command ? { command: w.command } : {}),
        ...(w.report ? { report: hrefOf(progress, w.report) } : {}),
      };
    });
  }
  return [];
}

/** The section's first line: which stage, which run, how old. Never "live". */
export function changeHead(answer, progress, now = new Date()) {
  const stage = changeStage(answer, progress);
  if (stage === "pull-request") {
    const r = answer.pull_request.run;
    return { text: `pull request #${r.pull_request}, planned ${clock(r.finished, now)}, ${ago(r.finished, now)}; the run view follows the merge`, href: hrefOf(answer, r.report), pr: r.pull_request_url || null };
  }
  if (stage === "apply") {
    const r = progress.run;
    return { text: `merged: commit ${r.commit.slice(0, 12)}, run view written ${clock(r.updated, now)}, ${ago(r.updated, now)}`, href: r.html ? hrefOf(progress, r.html) : null, pr: null };
  }
  return null;
}

/** The section in the Terragucci tab. `ui` is app.js's `{link, button, copy}`. */
export function changeSection(answer, progress, now, ui) {
  const box = document.createElement("div");
  box.className = "tg-change";
  const head = changeHead(answer, progress, now);
  if (!head) return box;
  const add = (cls, text) => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    box.appendChild(d);
    return d;
  };
  add("tg-timeline-title", "Change across roots");
  const h = add("tg-legend", head.text + " ");
  if (head.href) h.appendChild(ui.link("report", head.href));
  if (head.pr) h.append(" · ", ui.link("pull request", head.pr));

  // #568 step 3: the composed run, or why the change applies in waves, before its reads.
  if (changeStage(answer, progress) === "pull-request") {
    const compose = composeLine(answer.pull_request);
    if (compose) add("tg-legend", compose);
  }
  for (const e of readEdges(answer, progress)) add(e.unknown.length ? "tg-wave" : "tg-plan", readLine(e));

  for (const w of waveRows(answer, progress, now)) {
    const card = document.createElement("div");
    card.className = "ws-gate tg-change-wave";
    card.dataset.state = w.state;
    if (w.composed) card.dataset.composed = "true";
    const t = document.createElement("div");
    t.className = `ws-gate-title tg-${w.tone}`;
    t.textContent = w.text;
    card.appendChild(t);
    for (const f of w.facts) {
      const n = document.createElement("div");
      n.className = "ws-gate-note";
      n.textContent = f;
      card.appendChild(n);
    }
    if (w.command) {
      const cmd = document.createElement("code");
      cmd.className = "tg-command";
      cmd.textContent = w.command;
      card.appendChild(cmd);
      if (ui.button && ui.copy) {
        const copy = ui.button("Copy", "", () => ui.copy(w.command, copy));
        copy.title = "Copy the line. Run it at your shell: the approval is yours, signed, in git.";
        card.appendChild(copy);
      }
    }
    if (w.report) {
      const n = document.createElement("div");
      n.className = "ws-gate-note";
      n.appendChild(ui.link("report", w.report));
      card.appendChild(n);
    }
    box.appendChild(card);
  }

  const pr = answer && answer.pull_request;
  if (pr) {
    const totals = totalsLine(pr.totals);
    if (totals) add("tg-legend", `totals ${rootsCount(pr.totals_roots) || "across roots"} (pull request #${pr.run.pull_request}): ${totals}`);
    const cost = costLine(pr.cost);
    if (cost) add("tg-legend", cost);
    const b = blastRows(answer);
    if (b && (b.changed.length || b.resources.length)) {
      const d = document.createElement("details");
      d.className = "tg-blast";
      const s = document.createElement("summary");
      s.textContent = `blast radius: ${b.changed.length ? `changes in ${list(b.changed)}` : "no root changes"}${b.downstream.length ? `; downstream, nearest first: ${list(b.downstream)}` : ""}`;
      d.appendChild(s);
      for (const r of b.resources) {
        const n = document.createElement("div");
        n.className = "ws-gate-note";
        n.textContent = `${r.head} reaches ${reachLine(r.reaches)}`;
        d.appendChild(n);
      }
      box.appendChild(d);
    }
    if (b && b.unplanned.length) add("tg-legend", `not planned by this pull request: ${list(b.unplanned)}`);
  }
  return box;
}

// ---------------------------------------------------------------------------
// #569: the change drawn on the view itself, so the graph says what the panel
// says: each root's wave and its state on its box, each read between roots as
// a labelled line, and which run all of it comes from.

/** The colour a state is drawn in: one word per channel, mapped to a theme token in app.js. */
export const STATE_TONE = {
  planned: "plan",
  "not-started": "idle",
  waiting: "wait",
  applying: "busy",
  applied: "ok",
  refused: "bad",
  failed: "bad",
  outside: "idle",
  unchanged: "idle",
};

/** behold#741: the tone chant's blocked cards carry (web/chant-pr-marks.js), on a story's blocked root. */
export const BLOCKED_TONE = "wait";

const sameCommit = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/**
 * behold#770: the wave results (/api/terragucci's `results`, behold#751) of
 * one commit, each wave by its newest report. None without a commit, or when
 * the read kept none of it (older than its newest tf-apply commits).
 */
function commitResults(answer, commit) {
  const all = answer && !answer.error && answer.results && typeof answer.results === "object" ? answer.results : null;
  if (!all || typeof commit !== "string" || !commit) return [];
  const key = Object.keys(all).find((c) => sameCommit(c, commit));
  return key && Array.isArray(all[key]) ? all[key].filter((r) => r && Number.isInteger(r.wave)) : [];
}

/**
 * behold#741 (terragucci#1161): the roots the run view's run blocked, each
 * with its wave and the root whose failure held it (`by`), from the wave
 * reports' `waves[].blocked` (/api/terragucci's `blocked`, report minor 41)
 * when they are of the run view's commit. A wave the run view says is
 * `blocked` holds every root of it, by the root its report names, or by
 * nobody named when its report is not read yet. Empty for older reports
 * and run views, which carry neither: they read exactly as before.
 */
export function blockedOf(answer, progress) {
  const out = new Map();
  const run = progress && !progress.error && progress.run && progress.run.present ? progress.run : null;
  const b = answer && !answer.error && answer.blocked && answer.blocked.roots && typeof answer.blocked.roots === "object" ? answer.blocked : null;
  // A wave the run view has not started yet has no report to block anything (a paced view holds it there too).
  const notStarted = new Set((progress && Array.isArray(progress.states) ? progress.states : []).filter((w) => w.state === "not-started").map((w) => w.number));
  if (b && (!run || !run.commit || sameCommit(b.commit, run.commit))) {
    for (const [root, x] of Object.entries(b.roots)) if (x && typeof x.by === "string" && x.by && !(Number.isInteger(x.wave) && notStarted.has(x.wave))) out.set(root, { wave: Number.isInteger(x.wave) ? x.wave : null, by: x.by });
  } else {
    // behold#770: `blocked` is the newest apply's alone. A run view of an older commit (a tool page's replay, pinned to
    // its cycle's change after the fix applied) takes its blocked roots from that commit's own wave reports (`results`).
    for (const r of commitResults(answer, run && run.commit)) {
      if (notStarted.has(r.wave)) continue;
      for (const x of Array.isArray(r.blocked) ? r.blocked : []) if (x && typeof x.root === "string" && typeof x.by === "string" && x.by && !out.has(x.root)) out.set(x.root, { wave: r.wave, by: x.by });
    }
  }
  for (const w of progress && Array.isArray(progress.states) ? progress.states : []) {
    if (w.state !== "blocked") continue;
    for (const root of w.roots || []) if (!out.has(root)) out.set(root, { wave: w.number, by: null });
  }
  return out;
}

/**
 * behold#741: each root's own apply outcome in its wave (`applied`,
 * `unchanged` or `failed`, with the error), from the wave reports
 * (/api/terragucci's `outcomes`) of the run view's commit, for a wave the run
 * view has started. Empty for reports without one.
 */
export function outcomesOf(answer, progress) {
  const out = new Map();
  const run = progress && !progress.error && progress.run && progress.run.present ? progress.run : null;
  const o = answer && !answer.error && answer.outcomes && answer.outcomes.roots && typeof answer.outcomes.roots === "object" ? answer.outcomes : null;
  const notStarted = new Set((progress && Array.isArray(progress.states) ? progress.states : []).filter((w) => w.state === "not-started").map((w) => w.number));
  if (!o || (run && run.commit && !sameCommit(o.commit, run.commit))) {
    // behold#770: `outcomes` is the newest apply's alone. A run view of an older commit (a tool page's replay of its
    // cycle's failure, after the fix applied) reads that commit's own wave reports (`results`, behold#751), not its
    // wave's state: cluster-b applied beside a failed cluster-a in the replay too, as it did live.
    for (const r of commitResults(answer, run && run.commit)) {
      if (notStarted.has(r.wave)) continue;
      const put = (root, outcome, error) => !out.has(root) && out.set(root, { wave: r.wave, outcome, ...(typeof error === "string" && error ? { error } : {}) });
      for (const root of Array.isArray(r.applied) ? r.applied : []) if (typeof root === "string") put(root, "applied");
      for (const root of Array.isArray(r.unchanged) ? r.unchanged : []) if (typeof root === "string") put(root, "unchanged");
      for (const f of Array.isArray(r.failed) ? r.failed : []) if (f && typeof f.root === "string") put(f.root, "failed", f.error);
    }
    return out;
  }
  for (const [root, x] of Object.entries(o.roots)) {
    if (!x || !["applied", "unchanged", "failed"].includes(x.outcome)) continue;
    if (Number.isInteger(x.wave) && notStarted.has(x.wave)) continue;
    out.set(root, { wave: Number.isInteger(x.wave) ? x.wave : null, outcome: x.outcome, ...(typeof x.error === "string" && x.error ? { error: x.error } : {}) });
  }
  return out;
}

/** behold#741: "blocked by cluster-a", or "blocked" when the report names no root. */
export const blockedWords = (x) => (x && x.by ? `blocked by ${x.by}` : "blocked");

/**
 * behold#741: a wave's outcome as its header says it once some of its roots
 * are blocked: "3 applied, 6 blocked by cluster-a", "6 blocked by cluster-a"
 * when none ran, with each blocker named when there are several. Null when
 * none of its roots is blocked.
 */
export function blockedHeader(roots, blocked, state) {
  const held = roots.filter((r) => blocked.has(r));
  if (!held.length) return null;
  const by = [...new Set(held.map((r) => blocked.get(r).by).filter(Boolean))].sort();
  const words = `${held.length} blocked${by.length ? ` by ${and(by)}` : ""}`;
  const ran = roots.length - held.length;
  if (!ran || state === "blocked") return words;
  return state === "applied" ? `${ran} applied, ${words}` : `${ran} ${STATE_WORDS[state] || state}, ${words}`;
}

/**
 * behold#751: a wave's result as its own report says it (/api/terragucci's
 * `results`, by commit), for the commit the run that applied it is of. A
 * wave's job is no witness to it: terragucci ends the job of a wave that
 * applied what it planned and blocked the rest as a failure (terragucci#1161),
 * so the commit status isn't green while roots are unapplied. `after` is when
 * the job started: a report finished before it is an earlier run's on the
 * commit, and says nothing of this one. Null without a report of the wave,
 * where the job's status is all there is.
 */
export function waveResultOf(answer, commit, wave, { after = null } = {}) {
  const all = answer && !answer.error && answer.results && typeof answer.results === "object" ? answer.results : null;
  if (!all || typeof commit !== "string" || !commit || !Number.isInteger(wave)) return null;
  const key = Object.keys(all).find((c) => sameCommit(c, commit));
  const r = key && Array.isArray(all[key]) ? all[key].find((x) => x && x.wave === wave && typeof x.state === "string") : null;
  if (!r) return null;
  const done = Date.parse(r.finished);
  const start = after ? Date.parse(after) : NaN;
  if (Number.isFinite(done) && Number.isFinite(start) && done < start) return null;
  return r;
}

/** behold#751: whether a wave's report says the wave itself failed (a root of its own failed, or the wave was refused). */
export const resultFailed = (r) => !!r && (r.state === "failed" || r.state === "refused");

/** behold#751: whether a wave's report says it held roots back: some blocked, or the whole wave. */
export const resultBlocked = (r) => !!r && (r.state === "blocked" || (Array.isArray(r.blocked) && r.blocked.length > 0));

/**
 * behold#751: a wave's result in words, from its report: "applied 6, 6
 * blocked by cluster-a" for a wave that applied what it planned and blocked
 * the rest, "6 blocked by cluster-a" for one that ran nothing, "1 failed, 1
 * applied" for one a root of its own failed, else its state ("applied").
 */
export function resultWords(r) {
  if (!r) return null;
  const held = Array.isArray(r.blocked) ? r.blocked : [];
  const by = [...new Set(held.map((b) => b && b.by).filter(Boolean))].sort();
  const blocked = held.length ? `${held.length} blocked${by.length ? ` by ${and(by)}` : ""}` : null;
  const ran = (Array.isArray(r.applied) ? r.applied.length : 0) + (Array.isArray(r.unchanged) ? r.unchanged.length : 0);
  if (r.state === "applied") return blocked ? `applied ${ran}, ${blocked}` : "applied";
  if (r.state === "blocked") return blocked || "blocked";
  if (r.state === "failed") {
    const failed = Array.isArray(r.failed) ? r.failed.length : 0;
    return failed ? `${failed} failed${ran ? `, ${ran} applied` : ""}${blocked ? `, ${blocked}` : ""}` : "failed";
  }
  return STATE_WORDS[r.state] || r.state;
}

/** behold#751: the tone a wave's result is drawn in: blocked's for one that held roots back, bad for a failure. */
export const resultTone = (r) => (resultFailed(r) ? "bad" : resultBlocked(r) ? BLOCKED_TONE : r && r.state === "applied" ? "ok" : "idle");

/**
 * #569 review: whether a root of a run-view wave plans a change. A root its
 * wave planned without a change (`changed`, the roots whose plan changes a
 * resource or an output) is never shown waiting, applying or failed: nothing
 * of it is approved or applied. A composed run's member says for itself.
 * Unknown (true) until the wave has planned, or on a run view without
 * `changed`.
 */
export function rootChanges(w, root) {
  const m = w.composed && w.composed.members ? w.composed.members.find((x) => x.root === root) : null;
  if (m && m.apply) return m.apply !== "no-changes";
  const planned = w.state !== "not-started" && (!!w.totals || !!w.digest);
  if (!planned || !Array.isArray(w.changed)) return true;
  return w.changed.includes(root);
}

/** The roots of a wave that plan a change, in the wave's order (all of them while that isn't known). */
export function changingRoots(w, roots) {
  return roots.filter((r) => rootChanges(w, r));
}

/** A member of a composed run, once it ended, as a root state. */
const MEMBER_STATE = { applied: "applied", partial: "failed", failed: "failed", "not-started": "not-started", "no-changes": "applied" };

/**
 * Each root's wave and state, for its box on the view. `roots` maps a root's
 * path to `{ wave, state, tone, words, facts }`: "wave 2 · waiting for an
 * approval", with the facts under it (the plan's digest it waits on, its
 * changes, that it plans again after an earlier wave). A root the change
 * doesn't plan, or the run doesn't apply, is `outside`. A root in a composed
 * run that failed part way takes its own part's outcome: what applied says
 * applied.
 */
export function rootStates(answer, progress, { story = false } = {}) {
  const stage = changeStage(answer, progress);
  const roots = {};
  const known = (answer && answer.roots ? answer.roots.map((r) => r.path) : []).filter(Boolean);
  if (stage === "pull-request") {
    const pr = answer.pull_request;
    const cone = coneOf(pr);
    for (const w of pr.waves) {
      const c = w.composed;
      const members = c ? c.members.map((m) => m.root) : [];
      for (const root of [...new Set([...w.roots, ...members])]) {
        // #569 review: a root the pull request plans without a change, and that
        // reads nothing unknown, shows no changes rather than a wave's plan.
        const blast = pr.blast && Array.isArray(pr.blast.roots) ? pr.blast.roots : null;
        const readsUnknown = (pr.reads || []).some((r) => r.root === root && r.unknown && r.unknown.length) || !!(c && c.held_by_unknown && c.held_by_unknown.includes(root));
        if (blast && !blast.includes(root) && !readsUnknown) {
          roots[root] = { wave: w.number, state: "unchanged", tone: STATE_TONE.unchanged, words: `wave ${w.number} · unchanged`, facts: [] };
          continue;
        }
        const facts = [];
        if (w.replans_after && w.replans_after.length) facts.push(`plans again once wave ${list(w.replans_after)} applies`);
        else if (w.review_digest || w.set_digest) facts.push(`plan ${short(w.review_digest || w.set_digest)}`);
        if (c && c.held_by_unknown && c.held_by_unknown.includes(root)) facts.push("reads a value unknown when planned");
        if (w.waits) facts.push("will wait for an approval");
        // Report minor 34: a cone plan says its size, or why choudoufu planned the whole estate, on the root's own box.
        const cr = cone ? cone.roots.find((x) => x.root === root) : null;
        const cf = cr && (cr.kind === "cone" || cr.kind === "full") ? coneFact(cr) : null;
        const said = cr && cr.kind === "cone" ? `planned · ${cf}` : cf || "planned";
        const lines = cr ? coneResourceLines(cr) : [];
        roots[root] = { wave: w.number, state: "planned", tone: STATE_TONE.planned, words: `wave ${w.number} · ${said}${c ? ", composed" : ""}`, facts: cf ? [cf, ...(fallbackWhy(cr) ? [fallbackWhy(cr)] : []), ...facts] : facts, ...(cr ? { cone: cr.kind } : {}), ...(lines.length ? { lines } : {}) };
      }
    }
    // With a cone view, a root the pull request's plan holds nothing of is said to be not planned.
    for (const root of known) if (!roots[root]) roots[root] = { wave: null, state: "outside", tone: STATE_TONE.outside, words: cone ? "not planned" : "unchanged", facts: [], ...(cone ? { cone: "not-planned" } : {}) };
    return { stage, roots };
  }
  if (stage === "apply") {
    const composedOf = new Map(progress.reads.filter((r) => r.composed).map((r) => [r.root, r.composed.wave]));
    // behold#741: the roots the run blocked; none for reports and run views before terragucci#1161.
    // Only on a kiosk telling a chapter-carrying scenario (`story`): every other view reads the states exactly as before.
    const blocked = story ? blockedOf(answer, progress) : new Map();
    const outcomes = story ? outcomesOf(answer, progress) : new Map();
    for (const w of progress.states) {
      const c = w.composed;
      const inRun = [...composedOf].filter(([, n]) => n === w.number).map(([r]) => r);
      for (const root of [...new Set([...w.roots, ...(c ? c.roots : []), ...inRun])]) {
        // A blocked root never planned, so its wave's `changed` leaves it out: it is blocked, not unchanged.
        const held = blocked.get(root);
        if (held) {
          roots[root] = { wave: w.number, state: "blocked", tone: BLOCKED_TONE, words: `wave ${w.number} · ${blockedWords(held)}`, facts: [held.by ? `did not run: ${held.by} did not apply, and this depends on it` : "did not run: something it depends on did not apply"], ...(held.by ? { blockedBy: held.by } : {}) };
          continue;
        }
        // behold#741: a root's own outcome in its wave, where the report says it: cluster-b applied beside a failed cluster-a.
        // Only once its wave has settled as the (paced) run view shows it: never ahead of the play.
        const own = ["applied", "failed", "refused", "blocked"].includes(w.state) ? outcomes.get(root) : undefined;
        if (!rootChanges(w, root) || (own && own.outcome === "unchanged")) {
          roots[root] = { wave: w.number, state: "unchanged", tone: STATE_TONE.unchanged, words: `wave ${w.number} · unchanged`, facts: [] };
          continue;
        }
        const m = c && c.members ? c.members.find((x) => x.root === root) : null;
        const state = m && m.apply ? MEMBER_STATE[m.apply] || w.state : own ? own.outcome : w.state;
        const facts = [];
        if (own && own.outcome === "failed" && own.error) facts.push(`failed: ${own.error}`);
        if (state === "waiting" && w.digest) facts.push(`approve plan ${short(w.digest)}`);
        if (state === "waiting" && c && c.unknown && c.unknown.includes(root)) facts.push("read a value unknown when planned");
        const totals = totalsLine(w.totals);
        const together = new Set([...w.roots, ...(c ? c.roots : []), ...inRun]).size > 1;
        const composedHere = !!c && (c.roots.includes(root) || inRun.includes(root));
        if (m && m.apply) facts.push(memberApplyLine(m).replace(`${root}: `, "")); // this root's own part, not the wave's
        else if (c && !composedHere) {
          // Beside a composed run in its wave: the wave's figures are the run's, not this root's.
        } else if (totals && state !== "not-started") facts.push(totals === "unchanged" ? `${together ? "the wave: " : ""}unchanged` : `${together ? "the wave " : ""}${state === "applied" ? "applied" : state === "failed" || state === "refused" ? "planned" : "plans"} ${totals}`);
        if (state === "failed" || state === "refused") {
          const before = progress.states.filter((x) => x.number < w.number && x.state === "applied").map((x) => x.number);
          if (before.length) facts.push(`wave ${list(before)} stays applied`);
        }
        const words = `wave ${w.number} · ${STATE_WORDS[state] || state}${composedHere ? ", composed" : ""}`;
        roots[root] = { wave: w.number, state, tone: STATE_TONE[state] || "idle", words, facts, ...(own && own.outcome === "failed" && own.error ? { error: own.error } : {}) };
      }
    }
    for (const root of known) if (!roots[root]) roots[root] = { wave: null, state: "outside", tone: STATE_TONE.outside, words: "not in this run", facts: [] };
    return { stage, roots };
  }
  return { stage, roots };
}

/** The short label on a read's line: "reads network's planned http_proxy_port, set when network applies". */
export function readLabel(e) {
  if (e.composed !== undefined) {
    return `reads ${e.to} in wave ${e.composed}'s composed run${e.unknown.length ? `: ${list(e.unknown)} known once ${e.to}'s part applies` : ""}`;
  }
  if (e.outputs === "planned") return e.unknown.length ? `reads ${list(e.unknown)} from ${e.to}, set when ${e.to} applies` : `reads ${e.to}'s planned outputs`;
  return e.estate ? `reads ${e.to}'s outputs` : `reads ${e.to}'s applied state`;
}

/**
 * #569: a `run` pin on one pull request's plan, as the kiosk sends it before
 * the merge: `pull-<n>`, or `pull-<n>-<sha>` with the commit the plan is of;
 * bare `pull` while no pull request is open. Null for any other pin.
 */
export function pullPin(run) {
  const m = /^pull(?:-(\d+)(?:-([0-9a-f]{7,40}))?)?$/.exec(String(run || ""));
  return m ? { pull: m[1] || null, commit: m[2] || null } : null;
}

/** #569: whether a pin names a commit's run view (not `none`, `base` or a pull request's plan). */
export function pinsCommit(run) {
  return !!run && run !== "none" && run !== "base" && !pullPin(run);
}

const sameSha = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/** #569: whether a pull request's plan is the one a `pull-…` pin names: its number, and its commit when the pin has one. */
export function planFitsPin(pr, pin) {
  if (!pr || !pr.run || !pin || pin.pull === null) return false;
  if (String(pr.run.pull_request) !== pin.pull) return false;
  return !pin.commit || sameSha(pr.run.commit, pin.commit);
}

/**
 * #569: the reports as the view draws them under its `run` pin. At `base`
 * nothing is in flight; at `pull-…` only that pull request's plan, so another
 * cycle's plan is never drawn as this one's. Anything else draws them as read.
 */
export function pinnedAnswer(answer, run, pull = null) {
  if (!answer || answer.error) return answer;
  const pin = pullPin(run);
  if (run === "base" || (pin && !planFitsPin(answer.pull_request, pin))) return { ...answer, pull_request: null };
  // A commit's run is the merge of the cycle's pull request (`pull`): another cycle's plan is never drawn for it.
  if (pull && pinsCommit(run) && !mergedPull(answer.pull_request, pull)) return { ...answer, pull_request: null };
  return answer;
}

/** Whether a pull request's plan is the one numbered `pull`. */
const mergedPull = (pr, pull) => !!pr && !!pr.run && String(pr.run.pull_request) === String(pull);

/**
 * #569: the sentence above the boxes when the pin holds the view off every
 * plan and run: the base, a pull request whose plan isn't written yet, or a
 * merge whose run hasn't started and whose pull request's plan isn't read yet.
 * Null when the view draws a plan or a run, and viewCaption says which.
 */
export function pinnedCaption(answer, run, pull = null, progress = null) {
  if (run === "base") return "Nothing in flight: the states went back to the base";
  const pin = pullPin(run);
  if (!pin) {
    const ran = progress && !progress.error && progress.run && progress.run.present;
    if (pull && pinsCommit(run) && !ran && !(answer && !answer.error && mergedPull(answer.pull_request, pull))) return `Pull request #${pull} is merged; the merge's run shows here once it starts`;
    return null;
  }
  if (answer && !answer.error && planFitsPin(answer.pull_request, pin)) return null;
  if (pin.pull === null) return "The pull request isn't open yet; its plan shows here once the plan job writes it";
  return `Pull request #${pin.pull} is being planned; its plan shows here once the plan job writes it`;
}

/**
 * What the frame pinned to `run` still waits for, so it reads again soon:
 * `plan`, the reports, while the pin's pull request's plan (or, for a merge,
 * the cycle's pull request) isn't in them; `run`, the run view, while a
 * merge's isn't written. Pure.
 */
export function pinWaits(answer, progress, run, pull = null) {
  const read = !!answer && !answer.error;
  const ran = !!progress && !progress.error && !!progress.run && !!progress.run.present;
  const pin = pullPin(run);
  const plan = read && !!run && run !== "base" && (pin ? !planFitsPin(answer.pull_request, pin) : !!pull && pinsCommit(run) && !ran && !mergedPull(answer.pull_request, pull));
  return { plan, run: !!run && pinsCommit(run) && !ran };
}

/**
 * Which run the view's marks come from, dated: "the plan of pull request #201
 * at 03:11 UTC, before the merge". `merged`: the view is pinned to the merge,
 * whose run hasn't started yet, so the plan is said as what the merge's run
 * follows. A run of a pull request planned as a cone says the merge plans each
 * estate in full.
 */
export function viewCaption(answer, progress, now = new Date(), { merged = false } = {}) {
  const stage = changeStage(answer, progress);
  if (stage === "pull-request") {
    const r = answer.pull_request.run;
    return merged ? `the plan of pull request #${r.pull_request} at ${clock(r.finished, now)}; the merge's run starts next` : `the plan of pull request #${r.pull_request} at ${clock(r.finished, now)}, before the merge`;
  }
  if (stage === "apply") {
    const r = progress.run;
    const full = !!(answer && !answer.error && coneOf(answer.pull_request));
    return full ? `the merge's run (${r.commit.slice(0, 8)}), planning each estate in full, as of ${clock(r.updated, now)}` : `the run of merge ${r.commit.slice(0, 8)}, as of ${clock(r.updated, now)}`;
  }
  return null;
}
