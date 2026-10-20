// #680: the trunk lane. Pure words from /api/workspace/lane, and one render.
// First the trunk's recent commits, each green, revoked or undecided, with its
// work items and runs and where it is now. Then one lane per environment in
// the promotion order chant declares: what the environment runs, and the
// gates waiting there, each with the approve button the gate strip uses
// (approveAffordance, #690), and the change set it binds as the link that
// draws it on the graph (#681). Between the two, the releases cut from those
// commits (#692): each with its cut, a config-only mark, a revoked mark with
// the rollback line, where it runs and waits, and the environment it is
// promoted to next. An environment chant reads as mixed (#731) says so, with
// each component's release and state and chant's redeploy and rollback lines,
// shown to copy and never run. Nothing here is behold's own state.

import { ago, clock } from "./terragucci.js";
import { approveAffordance, HOST_APPROVES, overrideCard } from "./workspace-gates.js";
import { HOST_ANSWERS } from "./decision-points.js";

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
  // #692: the releases cut from it.
  if (c.cuts && c.cuts.length) facts.push({ text: `cut as ${c.cuts.map((x) => x.label || short(x.releaseDigest)).join(", ")}`, title: c.cuts.map((x) => `release ${x.releaseDigest} of ${x.member}`).join("\n") });
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
    const rollback = r.rollback || [];
    lines.push({
      text: `runs ${r.label || short(r.releaseDigest)}, cut from ${sha7(r.commit)}${r.listed ? "" : " (older than the trunk list)"} · ${r.components.join(", ")}${rollback.length ? " · revoked" : ""}`,
      title: [
        `release ${r.releaseDigest} of ${r.member}`,
        r.cutBy ? `cut by ${r.cutBy}${r.cutAt ? ` ${clock(r.cutAt, now)}` : ""}` : "",
        r.approver ? `deploy approved by ${r.approver}` : "",
        ...rollback.map((l) => `roll back: ${l}`),
      ]
        .filter(Boolean)
        .join("\n"),
      ...(rollback.length ? { revoked: true } : {}),
    });
  }
  for (const d of e.deploys || []) {
    const from = d.release ? `release ${d.release.label || short(d.release.releaseDigest)}, ` : "";
    lines.push({
      text: `runs ${d.component} ${short(d.digest)} from ${from}${sha7(d.gitSha)}${d.listed ? "" : " (older than the trunk list)"}${d.rollback ? " · revoked" : ""}`,
      title: `deploy record of ${d.member}, run ${d.runId}, by ${d.actor} ${ago(d.timestamp, now)}${d.approver ? `, approved by ${d.approver}` : ""}${d.rollback ? `\nroll back: ${d.rollback}` : ""}`,
      ...(d.rollback ? { revoked: true } : {}),
    });
  }
  if (!lines.length) lines.push({ text: "no deploy record", title: "chant has no deploy record for this environment, so behold does not say what runs here." });
  return lines;
}

/** A release's name: its label, else its digest, short. */
const releaseName = (r) => (r ? r.label || short(r.releaseDigest) : "");

/** A cut's signature in words, from chant's own check of it (chant#4031). */
export function signatureWords(sig) {
  if (!sig) return null;
  if (sig.status === "verified") return { text: "signed", title: sig.reason || "chant verified the cut's signature." };
  // Signing is opt-in: a cut without a signature is the normal case and goes unmarked.
  if (sig.status === "unsigned") return null;
  return { text: "signature does not count", title: sig.reason || "" };
}

/** The note under the releases heading when the project's chant is below the column's floor. */
export function releaseColumnNote(a) {
  if (!a || !a.releaseColumn || a.releaseColumn.full) return null;
  return `chant ${a.chant || "(unknown version)"} does not say which releases are revoked; chant ${a.releaseColumn.floor} and newer does.`;
}

/**
 * One release in the column (#692): its name and marks, its cut, where it is
 * and where it goes next, and, when revoked, what failed and the line that
 * rolls it back.
 */
export function releaseRow(r, now = new Date()) {
  const marks = [];
  if (r.configOnly) marks.push({ text: "config-only", cls: "lane-config-only", title: `The same artifact digests as ${releaseName(r.previous)}: only configuration changed.` });
  if (r.revoked) marks.push({ text: "revoked", cls: "lane-revoked", title: `${r.revoked.tag}${r.revoked.tagged ? `, tagged ${clock(r.revoked.tagged, now)}` : ""}. chant promotes no revoked release and counts no approval of it.` });
  const facts = [];
  if (r.cut) {
    facts.push({ text: `cut by ${r.cut.by} ${ago(r.cut.at, now)}`, title: clock(r.cut.at, now) });
    const sig = signatureWords(r.cut.signature);
    if (sig) facts.push(sig);
  } else facts.push({ text: "no cut recorded", title: "chant stores the release, but no cut names it." });
  if (r.artifacts === 0) facts.push({ text: "no artifact digests", title: "The member builds no image or asset, so no release of it is config-only." });

  const where = [];
  for (const x of r.runs) where.push({ text: `runs in ${x.env}`, title: x.components.join(", ") });
  for (const w of r.waits) where.push(w.state === "superseded" ? { text: `gate in ${w.env} superseded`, title: `${w.gate}: its release is revoked, so no approval of it counts.` } : { text: `waits in ${w.env}`, title: `at gate ${w.gate}` });
  if (r.next && !r.waits.some((w) => w.env === r.next)) where.push({ text: `next: ${r.next}`, title: "The next environment in the promotion order chant declares." });
  if (!r.runs.length && !r.waits.length && !r.next) where.push({ text: "runs nowhere", title: "" });

  const revoked = r.revoked
    ? {
        text: `revoked: ${r.revoked.phase || "a required phase"} failed`,
        run: r.revoked.run && r.revoked.run.url ? { text: r.revoked.run.name, href: r.revoked.run.url, title: r.revoked.run.conclusion ? `${r.revoked.run.name}: ${r.revoked.run.conclusion}` : r.revoked.run.name } : null,
        rollback: r.revoked.rollback.map((l) => `roll back: ${l}`),
      }
    : null;
  return {
    key: r.releaseDigest,
    head: `${releaseName(r)} · ${r.member}`,
    cutFrom: `cut from ${sha7(r.commit)}${r.listed ? "" : " (older than the trunk list)"}`,
    title: `release ${r.releaseDigest}\ncommit ${r.commit}${r.previous ? `\nprevious release ${releaseName(r.previous)}` : ""}`,
    marks,
    facts,
    where,
    revoked,
  };
}

/**
 * One member's mixed state in an environment (#731), as lines: a head, what
 * each component runs and whether it settled, then chant's redeploy lines and
 * its rollback line, which behold shows and does not run.
 */
export function mixedLines(m, env, now = new Date()) {
  const unsettled = m.components.filter((c) => c.state !== "settled");
  const ran = [...new Set(m.components.map((c) => (c.release ? releaseName(c.release) : null)).filter(Boolean))];
  const head = unsettled.length
    ? { text: `mixed: ${plural(unsettled.length, "component")} of ${m.member} not settled`, title: "A promote, rollback or redeploy left them failed or gated, and chant has recorded nothing for them since, so what they run is not known." }
    : { text: `mixed: ${m.member} runs ${ran.join(" and ")}`, title: "Its components run different releases." };
  const components = m.components.map((c) => {
    const runs = c.release ? `runs ${releaseName(c.release)}` : c.digest ? `runs ${short(c.digest)}` : "no deploy record";
    if (!c.attempt || c.state === "settled") return { text: `${c.component} ${runs}`, title: c.release ? `release ${c.release.releaseDigest}` : "", unsettled: false };
    const what = `${c.attempt.verb}${c.attempt.release ? ` of ${releaseName(c.attempt.release)}` : ""}`;
    return {
      text: `${c.component} ${runs} · ${c.state} in ${what}, run ${c.attempt.runId}`,
      title: `${c.state === "gated" ? "Stopped at its gate" : "Failed"} in ${what}, run ${c.attempt.runId} ${clock(c.attempt.timestamp, now)}. The ledger's record is older than that run, so what ${c.component} runs is not known.`,
      unsettled: true,
    };
  });
  const where = `Run in ${m.dir}. behold does not run it.`;
  const commands = [
    ...m.redeploy.map((l) => ({ label: "redeploy", line: l, title: `Puts back the release the ledger records for the component. ${where}` })),
    ...(m.rollback ? [{ label: "roll back", line: m.rollback, title: `Restores the newest release ${env} ran that is kept and not revoked. ${where}` }] : []),
  ].map((c) => ({ ...c, text: `${c.label}: ${c.line}` }));
  return { head, components, commands };
}

/** A release gate chant reads as superseded, as a line in its environment. */
export function supersededLine(g, a) {
  const r = ((a && a.releases) || []).find((x) => x.releaseDigest === g.releaseDigest);
  return {
    text: `${g.key} superseded: release ${r ? releaseName(r) : short(g.releaseDigest)} is revoked (${g.revoked.phase || "a required phase"} failed)`,
    title: `${g.revoked.tag}\nchant approve refuses this gate, and chant promotes no revoked release.${g.runId ? `\nrun ${g.runId}` : ""}`,
  };
}

/** One waiting gate as a card, with the gate strip's approve button (or the note in its place). */
export function laneGateCard(g, answer, { embed = false } = {}) {
  if (g.override) {
    const o = overrideCard(g);
    return { key: g.key, title: o.title, facts: o.facts, note: o.note, command: o.command };
  }
  const facts = [];
  facts.push(g.gitSha ? `for ${sha7(g.gitSha)}${g.commitState ? ` (${g.commitState})` : ""}` : "commit unknown");
  // #472: a gate that asks a decision point counts no approvals; its point's quorum decides.
  facts.push(g.answer ? `waits on decision point ${g.answer.point}` : `${g.approvals.length} of ${plural(g.needed, "approval")}`);
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
  // #472: a gate that waits on a decision point is answered, not approved, and never here.
  if (embed) card.note = g.answer ? HOST_ANSWERS : HOST_APPROVES;
  else Object.assign(card, approveAffordance(g, answer));
  return card;
}

/** The whole lane as words: the legend, the commits, and a lane per environment. Pure. */
export function laneView(a, now = new Date(), opts = {}) {
  const legend = laneLegend(a, now);
  if (!a || a.error || a.refusal) return { legend, notes: [], commits: [], releases: null, environments: [] };
  const notes = [];
  if (a.order === "env" && a.environments.length) notes.push(`no member declares a promotion order, so this is ${a.environments[0].env} alone`);
  for (const r of a.releaseRefusals || []) notes.push(`releases of ${r.member} not read: ${r.refusal.error}`);
  return {
    legend,
    notes,
    commits: (a.commits || []).map((c) => commitRow(c, now)),
    empty: a.trunk && !(a.commits || []).length ? `no commits ${a.trunk.since ? `after ${sha7(a.trunk.since)}` : `within ${a.trunk.window}`}` : null,
    // #692: null when the answer has no column (an older behold's export).
    releases: a.releases
      ? {
          note: releaseColumnNote(a),
          empty: !a.releases.length ? "no release cut yet" : null,
          rows: a.releases.map((r) => releaseRow(r, now)),
        }
      : null,
    environments: (a.environments || []).map((e) => ({
      env: e.env,
      heading: `${e.env}${[e.canary ? "canary" : "", e.mixed && e.mixed.length ? "mixed" : ""].filter(Boolean).map((t) => ` (${t})`).join("")}`,
      refusal: e.refusal ? `not read: ${e.refusal.error}` : null,
      runs: e.refusal ? [] : runsLines(e, now),
      // #731: absent from an answer before it, and empty below its floor.
      mixed: (e.mixed || []).map((m) => mixedLines(m, e.env, now)),
      superseded: (e.superseded || []).map((g) => supersededLine(g, a)),
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
  if (!v.commits.length && !v.environments.length && !(v.releases && v.releases.rows.length)) return;

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

  // #692: the release column, between the commits and the gates.
  if (v.releases) {
    const rh = document.createElement("h3");
    rh.textContent = "releases";
    host.appendChild(rh);
    if (v.releases.note) line("tg-legend", v.releases.note);
    if (v.releases.empty) line("tg-legend", v.releases.empty);
    for (const r of v.releases.rows) {
      const row = document.createElement("div");
      row.className = "lane-release";
      row.dataset.release = r.key;
      row.title = r.title;
      const head = document.createElement("div");
      const name = document.createElement("span");
      name.className = "lane-sha";
      name.textContent = r.head;
      head.append(name, document.createTextNode(` · ${r.cutFrom}`));
      for (const m of r.marks) {
        const mark = document.createElement("span");
        mark.className = m.cls;
        mark.textContent = ` · ${m.text}`;
        mark.title = m.title;
        head.appendChild(mark);
      }
      row.appendChild(head);
      const parts = (cls, items) => {
        const d = document.createElement("div");
        d.className = cls;
        items.forEach((f, i) => {
          const sp = document.createElement("span");
          sp.textContent = `${i ? " · " : ""}${f.text}`;
          if (f.title) sp.title = f.title;
          d.appendChild(sp);
        });
        row.appendChild(d);
        return d;
      };
      parts("lane-facts", r.facts);
      if (r.where.length) parts("lane-where", r.where);
      if (r.revoked) {
        const rv = parts("lane-revoked-why", [{ text: r.revoked.text }]);
        if (r.revoked.run) {
          rv.appendChild(document.createTextNode(" in "));
          const a = ui && ui.link ? ui.link(r.revoked.run.text, r.revoked.run.href) : document.createTextNode(r.revoked.run.text);
          if (a.title !== undefined) a.title = r.revoked.run.title;
          rv.appendChild(a);
        }
        for (const l of r.revoked.rollback) {
          const cmd = document.createElement("div");
          cmd.className = "lane-rollback";
          cmd.textContent = l;
          row.appendChild(cmd);
        }
      }
      host.appendChild(row);
    }
  }

  for (const e of v.environments) {
    const eh = document.createElement("h3");
    eh.textContent = e.heading;
    host.appendChild(eh);
    if (e.refusal) line("tg-refusal", e.refusal);
    for (const r of e.runs) line(r.revoked ? "lane-runs lane-runs-revoked" : "lane-runs", r.text, r.title);
    for (const m of e.mixed) {
      line("lane-mixed", m.head.text, m.head.title);
      for (const c of m.components) line(c.unsettled ? "lane-mixed-component lane-mixed-unsettled" : "lane-mixed-component", c.text, c.title);
      // The line alone selects as one piece, so it copies without its label.
      for (const l of m.commands) {
        const d = line("lane-command", `${l.label}: `, l.title);
        const cmd = document.createElement("span");
        cmd.className = "lane-command-line";
        cmd.textContent = l.line;
        d.appendChild(cmd);
      }
    }
    for (const g of e.superseded) line("lane-superseded", g.text, g.title);
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
