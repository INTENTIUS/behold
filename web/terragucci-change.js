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
    return answer.pull_request.reads.map((r) => ({
      from: r.root,
      to: r.upstream,
      data: r.data,
      outputs: r.outputs,
      unknown: r.unknown || [],
      ...(r.why ? { why: r.why } : {}),
      stage,
    }));
  }
  if (stage === "apply") {
    return progress.reads.flatMap((r) => r.reads.map((up) => ({ from: r.root, to: up, data: null, outputs: "applied", unknown: [], stage, wave: r.wave })));
  }
  return [];
}

/** One reads edge as a sentence: "app reads network's planned outputs (data network), known after network applies: subnet_id". */
export function readLine(e) {
  const what = e.outputs === "planned" ? `${e.to}'s planned outputs` : `${e.to}'s state as it stands`;
  const via = e.data ? ` (data ${e.data})` : "";
  const unknown = e.unknown.length ? `, read before known, known after ${e.to} applies: ${list(e.unknown)}` : "";
  const why = e.why ? ` (${e.why})` : "";
  return `${e.from} reads ${what}${via}${unknown}${why}`;
}

/** The short tag on a reader's data card: "reads network · planned · 1 unknown". */
export function readTag(e) {
  return `reads ${e.to} · ${e.outputs}${e.unknown.length ? ` · ${e.unknown.length} unknown` : ""}`;
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

/**
 * The blast radius, nearest first, as terragucci recorded it: each changed
 * resource and the resources it reaches, in their order and without a count
 * (distance comes with INTENTIUS/terragucci#1016); then the roots downstream,
 * and the checkout's roots the pull request did not plan.
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
          reaches: r.reaches.map((x) => `${x.root}: ${x.address}${x.through ? ` through ${x.through.root} output ${x.through.output}` : ""}`),
        }))
      : [],
    downstream: b ? b.downstream.map((d) => `${d.root}${d.wave !== undefined ? ` (wave ${d.wave})` : ""}${d.planned ? "" : ", not planned"}`) : [],
    unplanned,
  };
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
      if (w.replans_after && w.replans_after.length) facts.push(`plans again after wave ${list(w.replans_after)} applies, no digest until then`);
      else if (w.review_digest) facts.push(`review digest ${short(w.review_digest)}`);
      else if (w.set_digest) facts.push(`plan ${short(w.set_digest)}`);
      if (w.waits) facts.push("will wait for an approval");
      if (w.reads && w.reads.length) facts.push(`after wave ${list(w.reads)}`);
      const cost = costLine(w.cost);
      if (cost) facts.push(cost);
      return { number: w.number, state: w.state || "planned", tone: w.replans_after && w.replans_after.length ? "wave" : "plan", text: `wave ${w.number} ${STATE_WORDS[w.state || "planned"]}: ${list(w.roots)}`, facts };
    });
  }
  if (stage === "apply") {
    const states = progress.states;
    return states.map((w) => {
      const facts = [];
      if (w.reads.length) facts.push(`after wave ${list(w.reads)}`);
      if (w.digest) facts.push(`plan ${short(w.digest)}`);
      if (w.state === "failed" || w.state === "refused") {
        const before = states.filter((x) => x.number < w.number && x.state === "applied").map((x) => x.number);
        facts.push(before.length ? `wave ${list(before)} applied before it and stays applied` : "no wave before it applied");
      }
      return {
        number: w.number,
        state: w.state,
        tone: w.state === "failed" || w.state === "refused" ? "failed" : w.state === "waiting" || w.state === "applying" ? "wave" : w.state === "applied" ? "ok" : "none",
        text: `wave ${w.number} ${STATE_WORDS[w.state] || w.state}: ${list(w.roots)}`,
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

  for (const e of readEdges(answer, progress)) add(e.unknown.length ? "tg-wave" : "tg-plan", readLine(e));

  for (const w of waveRows(answer, progress, now)) {
    const card = document.createElement("div");
    card.className = "ws-gate tg-change-wave";
    card.dataset.state = w.state;
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
    if (totals) add("tg-legend", `totals across roots (pull request #${pr.run.pull_request}): ${totals}`);
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
        n.textContent = `${r.head} reaches, nearest first: ${r.reaches.length ? list(r.reaches) : "nothing"}`;
        d.appendChild(n);
      }
      box.appendChild(d);
    }
    if (b && b.unplanned.length) add("tg-legend", `not planned by this pull request: ${list(b.unplanned)}`);
  }
  return box;
}
