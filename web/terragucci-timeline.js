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

/** One entry as a line: "approved wave-2 by dana: unsigned · plan 4be1…". */
export function entryLine(entry) {
  const what = KIND_WORDS[entry.kind] || entry.kind;
  const by = entry.who ? ` by ${entry.who}` : "";
  const result = entry.result && entry.result !== entry.kind ? `: ${entry.result}` : "";
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
