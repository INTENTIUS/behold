// #680: the trunk lane. Pure words from /api/workspace/lane, and one render.
// First the trunk's recent commits, each green, revoked or undecided, with its
// work items and runs and where it is now. Then one lane per environment in
// the promotion order chant declares: what the environment runs, and the
// gates waiting there, each with the approve button the gate strip uses
// (approveAffordance, #690), and the change set it binds as the link that
// draws it on the graph (#681). Nothing here is behold's own state.

import { ago, clock } from "./terragucci.js";
import { approveAffordance, HOST_APPROVES, overrideCard } from "./workspace-gates.js";

const short = (s) => (s ? String(s).replace(/^(jcs1-)?sha256:/, "").slice(0, 12) : "");
const sha7 = (s) => (s ? String(s).slice(0, 7) : "");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The note under the legend: chant ci list reads local tags only. */
export const UNDECIDED_NOTE = "undecided: no ci tag yet. chant ci list reads local tags, so a commit that failed without ever going green also reads undecided.";

/** The lane's first line: what was read, or why it wasn't. */
export function laneLegend(a, now = new Date()) {
  if (!a || a.error) return { text: `lane not read${a && a.error ? `: ${a.error}` : ""}`, title: "", tone: "refusal" };
  if (a.refusal) return { text: `lane not read: ${a.refusal.error}`, title: a.refusal.remedy || "", tone: "refusal" };
  const when = a.read ? ` · read ${ago(a.read.at, now)}` : "";
  if (!a.trunk) return { text: `trunk not read: ${a.trunkRefusal ? a.trunkRefusal.error : "chant ci list gave no answer"}${when}`, title: (a.trunkRefusal && a.trunkRefusal.remedy) || "", tone: "refusal" };
  const span = a.trunk.since ? `after ${sha7(a.trunk.since)}` : `within ${a.trunk.window}`;
  return { text: `trunk ${a.trunk.branch} · ${plural(a.commits.length, "commit")} ${span}${when}`, title: UNDECIDED_NOTE, tone: "quiet" };
}

/** A commit's work items in words, as chant#4029 links them; null when chant said nothing. */
export function workWords(work) {
  if (!work) return null;
  if (work.state === "linked") return { text: `work ${work.ids.join(", ")}`, title: "" };
  if (work.state === "unlinked") return { text: "no work item", title: "No Chant-Record or Chant-Lease trailer names one." };
  if (work.state === "wrong") return { text: "names a work item that does not exist", title: work.problems.map((p) => `${p.trailer}: ${p.message}`).join("\n") };
  if (work.state === "merge") return { text: "merge commit", title: "Its work is the commits it brings." };
  return null;
}

/** Where a commit is, in words: "runs in staging, waits in prod". */
export function whereWords(where) {
  return (where || []).map((w) => (w.what === "runs" ? `runs in ${w.env}` : `waits in ${w.env}`)).join(", ");
}

/** The runs behind a commit's state, each a link: every phase's runs, and the run a revoked tag names. */
export function commitRuns(c) {
  const out = [];
  const seen = new Set();
  const add = (r) => {
    if (!r || !r.url || seen.has(r.url)) return;
    seen.add(r.url);
    out.push({ text: r.name, href: r.url, title: r.conclusion ? `${r.name}: ${r.conclusion}` : r.name });
  };
  for (const p of c.phases || []) for (const r of p.runs) add(r);
  if (c.revoked) add(c.revoked.run);
  return out;
}

/** One trunk commit's row. */
export function commitRow(c, now = new Date()) {
  const facts = [];
  const work = workWords(c.work);
  if (c.revoked) facts.push({ text: `revoked: ${c.revoked.phase || "a phase"} failed`, title: "" });
  if (work) facts.push(work);
  if (c.ignored && c.ignored.length) facts.push({ text: `${plural(c.ignored.length, "ci tag")} not counted`, title: c.ignored.map((t) => `${t.tag} (${t.status}): ${t.reason}`).join("\n") });
  return {
    sha: c.sha,
    head: `${sha7(c.sha)} ${c.state}`,
    state: c.state,
    when: ago(c.committed, now),
    title: `${c.sha}\ncommitted ${clock(c.committed, now)}${c.state === "undecided" ? `\n${UNDECIDED_NOTE}` : ""}`,
    where: whereWords(c.where),
    facts,
    runs: commitRuns(c),
  };
}

/** What one environment runs, line by line; `no deploy record` when chant has none. */
export function runsLines(e, now = new Date()) {
  const lines = [];
  for (const r of e.releases || []) {
    lines.push({
      text: `runs ${r.label || short(r.releaseDigest)}, cut from ${sha7(r.commit)}${r.listed ? "" : " (older than the trunk list)"} · ${r.components.join(", ")}`,
      title: [`release ${r.releaseDigest} of ${r.member}`, r.cutBy ? `cut by ${r.cutBy}${r.cutAt ? ` ${clock(r.cutAt, now)}` : ""}` : "", r.approver ? `deploy approved by ${r.approver}` : ""].filter(Boolean).join("\n"),
    });
  }
  for (const d of e.deploys || []) {
    lines.push({
      text: `runs ${d.component} ${short(d.digest)} from ${sha7(d.gitSha)}${d.listed ? "" : " (older than the trunk list)"}`,
      title: `deploy record of ${d.member}, run ${d.runId}, by ${d.actor} ${ago(d.timestamp, now)}${d.approver ? `, approved by ${d.approver}` : ""}`,
    });
  }
  if (!lines.length) lines.push({ text: "no deploy record", title: "chant has no deploy record for this environment, so behold does not say what runs here." });
  return lines;
}

/** One waiting gate as a card, with the gate strip's approve button (or the note in its place). */
export function laneGateCard(g, answer, { embed = false } = {}) {
  if (g.override) {
    const o = overrideCard(g);
    return { key: g.key, title: o.title, facts: o.facts, note: o.note, command: o.command };
  }
  const facts = [];
  facts.push(g.gitSha ? `for ${sha7(g.gitSha)}${g.commitState ? ` (${g.commitState})` : ""}` : "commit unknown");
  facts.push(`${g.approvals.length} of ${plural(g.needed, "approval")}`);
  if (g.runId) facts.push(`run ${g.runId}`);
  if (g.releaseDigest) facts.push(`release ${short(g.releaseDigest)}`);
  if (g.approvals.length) facts.push(`approved by ${g.approvals.map((a) => a.principal).join(", ")}`);
  const show = g.changeSet ? `chant change-set show ${g.changeSet} --member ${g.member}` : null;
  const card = {
    key: g.key,
    title: `${g.member}: ${g.op} waits at gate ${g.gate}`,
    facts: facts.join(" · "),
    command: show ? `${g.approve}\n${show}` : g.approve,
  };
  // #681: the change set is a link that draws it on the graph.
  if (g.changeSet) card.changeSet = { text: `change set ${short(g.changeSet)}`, title: `Draw this change set on the graph, as a preview.\n${show}` };
  if (embed) card.note = HOST_APPROVES;
  else Object.assign(card, approveAffordance(g, answer));
  return card;
}

/** The whole lane as words: the legend, the commits, and a lane per environment. Pure. */
export function laneView(a, now = new Date(), opts = {}) {
  const legend = laneLegend(a, now);
  if (!a || a.error || a.refusal) return { legend, notes: [], commits: [], environments: [] };
  const notes = [];
  if (a.order === "env" && a.environments.length) notes.push(`no member declares a promotion order, so this is ${a.environments[0].env} alone`);
  for (const r of a.releaseRefusals || []) notes.push(`releases of ${r.member} not read: ${r.refusal.error}`);
  return {
    legend,
    notes,
    commits: (a.commits || []).map((c) => commitRow(c, now)),
    empty: a.trunk && !(a.commits || []).length ? `no commits ${a.trunk.since ? `after ${sha7(a.trunk.since)}` : `within ${a.trunk.window}`}` : null,
    environments: (a.environments || []).map((e) => ({
      env: e.env,
      heading: e.canary ? `${e.env} (canary)` : e.env,
      refusal: e.refusal ? `not read: ${e.refusal.error}` : null,
      runs: e.refusal ? [] : runsLines(e, now),
      gates: (e.waiting || []).filter((g) => g.state === "pending" || g.override).map((g) => laneGateCard(g, a, opts)),
    })),
  };
}

/**
 * Render into `host`. `ui.button(label, cls, onClick)` and `ui.link(text,
 * href)` are app.js's; `ui.approve(key, env, button)` posts the approval;
 * `ui.embed` and `ui.canApprove` say whether a button may be drawn;
 * `ui.openChangeSet(key, env)` draws a gate's change set on the graph (#681).
 */
export function renderTrunkLane(host, a, now, ui) {
  host.replaceChildren();
  const v = laneView(a, now, { embed: !!(ui && ui.embed) });
  const line = (cls, text, title) => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    if (title) d.title = title;
    host.appendChild(d);
    return d;
  };
  line(v.legend.tone === "refusal" ? "tg-refusal" : "tg-legend", v.legend.text, v.legend.title);
  for (const n of v.notes) line("tg-legend", n);
  if (!v.commits.length && !v.environments.length) return;

  const h = document.createElement("h3");
  h.textContent = "trunk";
  host.appendChild(h);
  if (v.empty) line("tg-legend", v.empty);
  for (const c of v.commits) {
    const row = document.createElement("div");
    row.className = "lane-commit";
    row.dataset.sha = c.sha;
    row.title = c.title;
    const head = document.createElement("div");
    const state = document.createElement("span");
    state.className = `lane-sha lane-${c.state}`;
    state.textContent = c.head;
    head.append(state, document.createTextNode(` · ${c.when}`));
    if (c.where) {
      const where = document.createElement("span");
      where.className = "lane-where";
      where.textContent = ` · ${c.where}`;
      head.appendChild(where);
    }
    row.appendChild(head);
    if (c.facts.length || c.runs.length) {
      const facts = document.createElement("div");
      facts.className = "lane-facts";
      c.facts.forEach((f, i) => {
        const s = document.createElement("span");
        s.textContent = `${i ? " · " : ""}${f.text}`;
        if (f.title) s.title = f.title;
        facts.appendChild(s);
      });
      for (const r of c.runs) {
        if (facts.childNodes.length) facts.appendChild(document.createTextNode(" · "));
        const a = ui && ui.link ? ui.link(r.text, r.href) : document.createTextNode(r.text);
        if (a.title !== undefined) a.title = r.title;
        facts.appendChild(a);
      }
      row.appendChild(facts);
    }
    host.appendChild(row);
  }

  for (const e of v.environments) {
    const eh = document.createElement("h3");
    eh.textContent = e.heading;
    host.appendChild(eh);
    if (e.refusal) line("tg-refusal", e.refusal);
    for (const r of e.runs) line("lane-runs", r.text, r.title);
    for (const g of e.gates) {
      const box = document.createElement("div");
      box.className = "ws-gate";
      box.dataset.gate = g.key;
      const title = document.createElement("div");
      title.className = "ws-gate-title";
      title.textContent = g.title;
      const facts = document.createElement("div");
      facts.className = "ws-gate-facts";
      facts.textContent = g.facts;
      facts.title = g.command;
      // #681: the change set the gate binds, as the link that opens the overlay.
      if (g.changeSet) {
        facts.appendChild(document.createTextNode(" · "));
        if (ui && ui.openChangeSet) {
          const a = document.createElement("a");
          a.href = "#";
          a.className = "lane-change-set";
          a.textContent = g.changeSet.text;
          a.title = g.changeSet.title;
          a.addEventListener("click", (ev) => {
            ev.preventDefault();
            ui.openChangeSet(g.key, e.env);
          });
          facts.appendChild(a);
        } else facts.appendChild(document.createTextNode(g.changeSet.text));
      }
      box.append(title, facts);
      if (g.note) {
        const note = document.createElement("div");
        note.className = "ws-gate-note";
        note.textContent = g.note;
        box.appendChild(note);
      }
      if (g.button && ui && ui.canApprove && ui.button && ui.approve) {
        const b = ui.button(g.button.label, "approve", () => ui.approve(g.key, e.env, b));
        b.title = g.button.title;
        box.appendChild(b);
      }
      host.appendChild(box);
    }
  }
}
