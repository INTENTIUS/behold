// #506: the timeline lane, from terragucci's audit record. app.js fetches
// /api/terragucci/timeline once (the whole project, newest first) and hands
// the answer here: the Terragucci tab shows every entry, a card's inspect pane
// the entries of its root. The record holds no per-resource entry, so a card's
// lane is its root's.
//
// An entry is dated and attributed as the record has it, and links its run's
// report through the same file route the marks use. An absent record is said
// in words: it is not "nothing happened".

import { ago, clock, hrefOf } from "./terragucci.js";

const KIND_WORDS = {
  "approval-requested": "approval requested",
  approval: "approved",
  "approval-revoked": "approval revoked",
  "override-requested": "override requested",
  override: "policy overridden",
  "override-revoked": "override revoked",
  apply: "apply",
  refused: "refused",
  migration: "state migration",
  unlock: "lock released",
  "state-export": "state exported",
  "ephemeral-apply": "ephemeral copy applied",
  "ephemeral-destroy": "ephemeral copy destroyed",
};

/** The tone an entry is drawn in: a refusal or a failure stands out, a wait is pending, the rest is quiet. */
export function toneOf(entry) {
  if (entry.kind === "refused" || entry.result === "failed" || entry.result === "denied") return "failed";
  if (entry.result === "waiting" || entry.kind === "approval-requested" || entry.kind === "override-requested") return "wave";
  if (entry.kind.endsWith("-revoked")) return "drift";
  return "ok";
}

/** One entry as a line: "approved wave-2 by dana · plan 4be1…". */
export function entryLine(entry) {
  const what = KIND_WORDS[entry.kind] || entry.kind;
  const by = entry.who ? ` by ${entry.who}` : "";
  // Signing is opt-in: an unsigned approval is the normal case and goes unmarked.
  const result = entry.result && entry.result !== entry.kind && entry.result !== "unsigned" ? `: ${entry.result}` : "";
  const digest = entry.digest ? ` · plan ${entry.digest.replace(/^(jcs1-)?sha256:/, "").slice(0, 12)}` : "";
  return `${what} ${entry.what}${by}${result}${digest}`;
}

/** The root a card sits in, by terragucci's path, from /api/terragucci's roots: a card id is `<member>/<root name>/…`. */
export function rootOfCard(marksAnswer, nodeId) {
  if (!marksAnswer || !marksAnswer.roots || !nodeId) return null;
  let best = null;
  for (const r of marksAnswer.roots) {
    const prefix = `${r.member}/${r.name}/`;
    if (nodeId.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, path: r.path };
  }
  return best ? best.path : null;
}

/** The lane's rows, newest first, of `root` when given. Each row: its clock, its line, its tone, and its links. */
export function laneRows(answer, { root = null, now = new Date() } = {}) {
  if (!answer || !answer.entries) return [];
  const entries = root ? answer.entries.filter((e) => (e.roots || []).includes(root)) : answer.entries;
  return entries.map((e) => {
    const links = [];
    if (e.run && e.run.report) links.push({ text: "report", href: hrefOf(answer, e.run.report) });
    if (e.run && e.run.job_url) links.push({ text: "job", href: e.run.job_url });
    if (e.evidence && e.evidence.source === "ledger" && /^https?:\/\//.test(e.evidence.url || "")) links.push({ text: "ledger commit", href: e.evidence.url });
    return {
      id: e.id,
      when: `${clock(e.at, now)}, ${ago(e.at, now)}`,
      text: entryLine(e),
      tone: toneOf(e),
      title: [e.at, e.roots && e.roots.length ? `roots: ${e.roots.join(", ")}` : "", e.run && e.run.commit ? `commit ${e.run.commit}` : "", e.run && e.run.pull_request ? `PR #${e.run.pull_request}` : ""].filter(Boolean).join("\n"),
      links,
    };
  });
}

/** The line over the lane: whose record, how many entries, or that the source has none. */
export function laneLegend(answer, { root = null, shown = 0 } = {}) {
  if (!answer) return "audit record not read";
  if (answer.error) return answer.error;
  if (answer.absent) return answer.absent;
  if (!shown) return root ? `the audit record names no entry for ${root}` : `the audit record holds no entry for ${answer.project || "this project"}`;
  const more = !root && answer.total > answer.entries.length ? ` of ${answer.total}` : "";
  return `${shown}${more} entr${shown === 1 ? "y" : "ies"} from terragucci's audit record${root ? ` for ${root}` : ""}, newest first`;
}

/** The lane as DOM: a legend line and one row per entry. Browser-only (the tests take the pure functions above). */
export function laneElement(answer, opts = {}) {
  const rows = laneRows(answer, opts);
  const box = document.createElement("div");
  box.className = "tg-timeline";
  const head = document.createElement("div");
  head.className = answer && answer.error ? "tg-refusal" : "tg-legend";
  head.textContent = laneLegend(answer, { root: opts.root || null, shown: rows.length });
  if (answer && answer.remedy) head.title = answer.remedy;
  box.appendChild(head);
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = `tg-entry tg-${r.tone}`;
    row.title = r.title;
    const when = document.createElement("span");
    when.className = "tg-when";
    when.textContent = r.when;
    const text = document.createElement("span");
    text.textContent = ` ${r.text}`;
    row.append(when, text);
    for (const l of r.links) {
      const a = document.createElement("a");
      a.textContent = l.text;
      a.href = l.href;
      a.target = "_blank";
      a.rel = "noopener";
      row.append(" · ", a);
    }
    box.appendChild(row);
  }
  return box;
}

// #522: the gate ledgers' history on chant/lifecycle, from
// /api/lifecycle/history (chant's gate-audit over `git log -p`). Drawn beside
// the audit record, or alone when the source has no audit.jsonl, and labelled
// "ledger" so the two are never mistaken for each other.

const HISTORY_WORDS = {
  "approval-requested": "approval requested",
  approved: "approved",
  "override-requested": "override requested",
  "override-recorded": "policy overridden",
  applied: "applied",
  "override-spent": "override spent",
};

/** One ledger entry as a line: "approved wave-2 by dana · plan 4be1…". */
export function historyLine(entry) {
  const what = entry.kind === "revoked" ? `${entry.subject || "approval"} revoked` : HISTORY_WORDS[entry.kind] || entry.kind;
  const op = entry.op && entry.op !== "tf-apply" ? ` (${entry.op})` : "";
  const by = entry.actor ? ` by ${entry.actor}` : "";
  const seal = entry.seal && entry.seal !== "unsigned" && (entry.kind === "approved" || entry.kind === "override-recorded") ? `: ${entry.seal}` : "";
  const digest = entry.digest ? ` · plan ${entry.digest.replace(/^(jcs1-)?sha256:/, "").slice(0, 12)}` : "";
  return `${what} ${entry.gate}${op}${by}${seal}${digest}`;
}

/** The history's rows, newest first: clock, line, tone, and the line's file, commit and committer in the title. */
export function historyRows(answer, { now = new Date() } = {}) {
  if (!answer || !answer.entries) return [];
  return answer.entries.map((e) => {
    const s = e.source || {};
    const commit = s.commit ? `${s.change === "removed" ? "removed" : "added"} in ${s.commit.slice(0, 12)}${s.committer ? ` by ${s.committer}` : ""}${s.committed ? ` at ${s.committed}` : ""}` : "";
    return {
      id: e.id,
      when: `${clock(e.at, now)}, ${ago(e.at, now)}`,
      text: historyLine(e),
      tone: e.kind === "revoked" ? "drift" : e.kind.endsWith("-requested") ? "wave" : "ok",
      title: [e.at, `${s.path}${s.line ? `:${s.line}` : ""}`, commit, e.note || ""].filter(Boolean).join("\n"),
    };
  });
}

/** The line over the history: its source, how many entries, where it was read from and how old. */
export function historyLegend(answer, { shown = 0 } = {}) {
  if (!answer) return "ledger history not read";
  if (answer.error) return answer.error;
  if (!answer.found) return `ledger: ${answer.note}`;
  if (!shown) return `ledger: no gate record on ${answer.branch}`;
  const more = answer.total > shown ? ` of ${answer.total}` : "";
  const via = answer.via === "checkout-ref" ? " (the checkout's copy: the fetch failed)" : "";
  const tip = answer.commit ? `, tip committed ${answer.commit.committed}` : "";
  return `ledger: ${shown}${more} entr${shown === 1 ? "y" : "ies"} from the gate ledgers on ${answer.branch}${via}${tip}, newest first`;
}

/** The history as DOM. Browser-only (the tests take the pure functions above). */
export function historyElement(answer, opts = {}) {
  const rows = historyRows(answer, opts);
  const box = document.createElement("div");
  box.className = "tg-timeline";
  const head = document.createElement("div");
  head.className = answer && answer.error ? "tg-refusal" : "tg-legend";
  head.textContent = historyLegend(answer, { shown: rows.length });
  if (answer && answer.note) head.title = answer.note;
  box.appendChild(head);
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = `tg-entry tg-${r.tone}`;
    row.title = r.title;
    const when = document.createElement("span");
    when.className = "tg-when";
    when.textContent = r.when;
    const text = document.createElement("span");
    text.textContent = ` ${r.text}`;
    row.append(when, text);
    box.appendChild(row);
  }
  return box;
}
