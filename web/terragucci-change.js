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

export const STATE_WORDS = {
  "not-started": "not started",
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
  const what = e.outputs === "planned" ? `${e.to}'s planned outputs` : `${e.to}'s state as it stands`;
  const unknown = e.unknown.length ? `, read before known, known after ${e.to} applies: ${list(e.unknown)}` : "";
  const why = e.why ? ` (${e.why})` : "";
  return `${e.from} reads ${what}${via}${unknown}${why}`;
}

/** The short tag on a reader's data card: "reads network · planned · 1 unknown". */
export function readTag(e) {
  return `reads ${e.to} · ${e.composed !== undefined ? "in the composed run" : e.outputs}${e.unknown.length ? ` · ${e.unknown.length} unknown` : ""}`;
}

/** The checkout's card id for a reader's data block, for each kind of block that reads another root. */
export function readCardIds(answer, e) {
  if (!e.data || !answer || !answer.roots) return [];
  const r = answer.roots.find((x) => x.path === e.from);
  if (!r) return [];
  return [`${r.member}/${r.name}/data.terraform_remote_state.${e.data}`, `${r.member}/${r.name}/data.terraform_estate_outputs.${e.data}`];
}

/** "5 create · 1 update", no-ops and zeros left out; "no changes" when nothing moves. */
export function totalsLine(totals) {
  if (!totals) return null;
  const order = ["create", "update", "replace", "delete", "forget", "import", "read"];
  const keys = [...order.filter((k) => k in totals), ...Object.keys(totals).filter((k) => !order.includes(k) && k !== "no-op").sort()];
  const parts = keys.filter((k) => totals[k] > 0).map((k) => `${totals[k]} ${k}`);
  return parts.length ? parts.join(" · ") : "no changes";
}

/** #568 step 2: "across 3 roots", from `totals_roots` (report minor 35); null on an older report, which has no count. */
export function rootsCount(n) {
  if (n === undefined || n === null) return null;
  return `across ${n} ${n === 1 ? "root" : "roots"}`;
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

const APPLY_WORDS = { applied: "applied", partial: "applied in part", failed: "failed", "not-started": "not started", "no-changes": "no changes" };
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
    return { text: `pull request #${r.pull_request}, planned ${clock(r.finished, now)}, ${ago(r.finished, now)}; not merged yet, so no run view`, href: hrefOf(answer, r.report), pr: r.pull_request_url || null };
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
