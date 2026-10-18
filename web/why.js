// #471: the "why" section of the inspect pane, for a member or a card in a
// declared workspace. Pure: app.js fetches /api/workspace/why when someone
// clicks "read why" and paints what whyView returns.
//
// Everything here is chant's answer (`chant workspace graph --intent <region>
// --json`, its `why`), put into words. The decisions are chant's ranking, in
// chant's order; behold neither re-ranks nor filters them. A proposed decision
// links to its review in hud when behold was started with --hud, and is named
// by its id otherwise.
//
// #682: the chain, from chant 0.124.29 (`trace`, chant#4023). For each commit
// chant walked: the work items it names ("asked for by"), the ones whose
// window it fell in (kept apart, never a link), its ci tag, the release that
// shipped it and the gate resolution that let that release through, and its
// deploys per environment. Each link carries chant's `source`, the record it
// came from, which the pane gives as the git line that opens it. A link chant
// found nothing for is drawn as missing, with chant's reason when it gives one.
// behold joins nothing: a commit names its release and deploys by id, and
// those ids are looked up in the same trace.

/** The query for a member or a node. A node wins: it names a smaller region. */
export function whyQuery({ member = null, node = null } = {}) {
  const q = new URLSearchParams();
  if (node) q.set("node", node);
  else if (member) q.set("member", member);
  return `/api/workspace/why?${q}`;
}

/** Seconds, for "reading… 12 s" and "read in 4.1 s". */
export function seconds(ms) {
  if (!(ms >= 0)) return "";
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

const RELEVANCE = {
  carried: "carried out by the commits or runs that wrote these lines",
  path: "constrains this path",
  contract: "constrains it through a contract",
  issue: "names an issue this work closed",
  member: "constrains the whole member",
  related: "related through supersession or an older commit",
};

const short = (sha) => String(sha || "").slice(0, 8);
/** How many of the chain's commits the pane draws; the rest are counted. Matches the server's WHY_COMMITS_SHOWN. */
const SHOWN = 8;
/** A digest, short enough to read: `jcs1-sha256:773f0087`. */
const shortDigest = (d) => {
  const s = String(d || "");
  const i = s.lastIndexOf(":");
  return i < 0 ? s.slice(0, 12) : `${s.slice(0, i + 1)}${s.slice(i + 1, i + 9)}`;
};

/**
 * The git line that opens a link's source record, from chant's `source.ref`:
 * a path on the lifecycle branch, a tag, a commit, or a work record's file
 * (from the repository root, read at HEAD).
 */
export function sourceLine(source) {
  if (!source || !source.ref) return null;
  const ref = String(source.ref);
  const open = ref.startsWith("chant/lifecycle:") || ref.startsWith("refs/") || /^[0-9a-f]{7,64}$/.test(ref) ? `git show ${ref}` : `git show HEAD:${ref}`;
  return { open, title: `${source.field}: ${source.value}\nfrom ${ref}` };
}

/** "let through by bob on cli at 2026-10-16T10:30:00.000Z", the words for one gate resolution. */
export function letThrough(g) {
  return `let through by ${g.resolvedBy}${g.channel ? ` on ${g.channel}` : ""} at ${g.at}`;
}

/**
 * The section's content for an answer from /api/workspace/why: a headline,
 * then decisions, runs, commits and gaps as rows of plain strings (and an
 * href for a decision under review). `refusal` instead when chant couldn't
 * answer.
 */
export function whyView(answer) {
  if (!answer) return { refusal: { error: "no answer", remedy: "" } };
  if (answer.refusal) return { refusal: answer.refusal, footer: footer(answer) };
  if (answer.error) return { refusal: { error: answer.error, remedy: answer.remedy || "" } };
  if (!answer.answered) {
    return {
      headline: `chant ${answer.chant || "(unknown version)"} reads the intent graph but writes no "why"; it needs chant 0.102.0 or newer in the workspace root.`,
      decisions: [],
      runs: [],
      commits: [],
      gaps: [],
      chain: null,
      footer: footer(answer),
    };
  }
  const where = answer.path ? `${answer.path}${answer.type === "dir" ? "/" : ""}` : answer.region;
  const current = answer.decisions.filter((d) => d.current).length;
  let headline;
  if (answer.decisions.length === 0) headline = `No decision covers ${where}.`;
  else headline = `${answer.decisions.length} decision${answer.decisions.length === 1 ? "" : "s"} cover${answer.decisions.length === 1 ? "s" : ""} ${where}${current !== answer.decisions.length ? ` (${current} current)` : ""}.`;
  if (!answer.explained && answer.decisions.length) headline += " None of them is current and accounts for it.";

  const decisions = answer.decisions.map((d) => ({
    id: d.id,
    title: d.title || "",
    meta: [d.state || "no state", RELEVANCE[d.relevance] || d.relevance, d.current ? null : "superseded", d.lines ? `${d.lines} line${d.lines === 1 ? "" : "s"} as its own work` : null, d.decidedBy ? `decided by ${d.decidedBy}${d.decidedOn ? ` on ${d.decidedOn}` : ""}` : null]
      .filter(Boolean)
      .join(" · "),
    href: d.review || null,
    note: d.state === "proposed" && !d.review ? "proposed; under review in hud (behold has no --hud address to link)" : null,
  }));

  const runs = answer.runs.map((r) => ({
    id: r.id,
    meta: [
      r.by ? `by ${r.by}` : null,
      r.harness ? (r.model && r.model !== "none" ? `${r.harness} · ${r.model}` : r.harness) : null,
      r.outcome,
      r.lines ? `${r.lines} line${r.lines === 1 ? "" : "s"}` : null,
      r.unit ? `work ${r.unit}` : null,
      r.commits.length ? `commit${r.commits.length === 1 ? "" : "s"} ${r.commits.map(short).join(", ")}` : null,
      r.decisions.length ? `carried out ${r.decisions.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    when: r.startedAt || "",
  }));

  const commits = answer.commits.map((c) => ({
    sha: short(c.sha),
    subject: c.subject || "",
    meta: [c.author, c.date ? c.date.slice(0, 10) : null, c.pullRequest ? `#${c.pullRequest}` : null, c.run ? `run ${c.run}` : null].filter(Boolean).join(" · "),
  }));
  const more = answer.commitsTotal > answer.commits.length ? answer.commitsTotal - answer.commits.length : 0;
  const gaps = answer.gaps.map((g) => g.message || g.code);
  if (answer.uncommittedLines) gaps.unshift(`${answer.uncommittedLines} line${answer.uncommittedLines === 1 ? " isn't" : "s aren't"} committed yet.`);
  return { headline, decisions, runs, commits, more, gaps, chain: chainView(answer), footer: footer(answer) };
}

const WORK_MISSING = {
  unlinked: "no work item: the commit names none in a Chant-Record or Chant-Lease trailer",
  wrong: "the commit names a work item chant could not take as its link",
};

/**
 * #682: the chain section for an answer, or null when the answer has no
 * `chain` field (a server before #682). `note` instead of rows when chant
 * wrote no chain. Each commit has `rows`: `{ label, text, meta, source,
 * missing }`, with `source` from {@link sourceLine} or null, and `missing`
 * true for a link chant found nothing for.
 */
export function chainView(answer) {
  const chain = answer && answer.chain;
  if (!chain) return null;
  const trace = answer.trace;
  if (!chain.full || !trace) return { note: chain.note || `The chain from work item to release needs chant ${chain.floor} or newer.`, reasons: [], commits: [], more: 0 };
  if (trace.commits.length === 0) return { note: "chant walked no commit for this region, so there is no chain to show.", reasons: trace.reasons.map((r) => `Part of the chain could not be read (${r.code}): ${r.message}`), commits: [], more: 0 };
  const releaseOf = new Map(trace.releases.map((r) => [r.releaseDigest, r]));
  const deployOf = new Map(trace.deploys.map((d) => [d.id, d]));
  const releaseName = (digest) => {
    const r = releaseOf.get(digest);
    return r && r.label ? r.label : shortDigest(digest);
  };
  const reasons = trace.reasons.map((r) => `Part of the chain could not be read (${r.code}): ${r.message}`);
  const shown = trace.commits.slice(0, SHOWN);

  const commits = shown.map((c) => {
    const rows = [];
    const row = (label, text, meta, source, missing = false) => rows.push({ label, text, meta: meta || "", source: sourceLine(source), missing });

    // Who asked for it: the trailer's work items, judged as chant judges them.
    const problems = c.work ? c.work.problems.map((p) => `${p.trailer}: ${p.message}`).join("; ") : "";
    if (!c.work) row("asked for by", "nothing read", "chant read no work kind, so it judged no link", null, true);
    else if (c.work.state === "merge") row("asked for by", "a merge commit", "chant judges the commits it merges, not the merge", null);
    else if (c.work.items.length === 0) row("asked for by", "missing", [WORK_MISSING[c.work.state] || c.work.state, problems].filter(Boolean).join("; "), null, true);
    else {
      for (const w of c.work.items) row("asked for by", w.id, [w.title, c.work.state === "wrong" ? WORK_MISSING.wrong : null, w.node ? null : "chant read no record with this id", problems].filter(Boolean).join(" · "), w.source, c.work.state === "wrong");
    }
    // The window: listed apart, and never a link.
    if (c.windowMatches.length) row("in the window of", c.windowMatches.map((w) => w.id).join(", "), "the commit fell in its window, which does not link them", null);

    // The ci tag.
    const t = c.tag;
    if (t.state === "revoked" && t.revoked) row("ci tag", t.revoked.tag, ["revoked", t.revoked.phase ? `phase ${t.revoked.phase} failed` : null, t.revoked.tagged].filter(Boolean).join(" · "), t.revoked.source);
    else if (t.state === "green" && t.green) row("ci tag", t.green.tag, [t.green.signer ? `signed by ${t.green.signer}` : "counts unsigned", t.green.tagged].filter(Boolean).join(" · "), t.green.source);
    else row("ci tag", "no green tag", t.ignored.length ? t.ignored.map((x) => `${x.tag} is ${x.status}: ${x.reason}`).join("; ") : "", null, true);

    // The release that shipped it, and the gate resolution that let it through.
    if (c.releases.length === 0) row("release", "missing", "no release is cut from this commit or from one that has it in its history", null, true);
    for (const link of c.releases) {
      const r = releaseOf.get(link.release);
      const cut = r && r.cuts[0];
      row(
        "release",
        releaseName(link.release),
        [link.link === "cut-from" ? "cut from this commit" : `contains this commit; cut from ${short(r ? r.commit : link.source.value)}`, cut ? `cut by ${cut.actor} at ${cut.timestamp}${cut.signed ? ", signed" : ""}` : null].filter(Boolean).join(" · "),
        link.source,
      );
      if (!r) continue;
      if (r.gates.length === 0) row("gate", "missing", `no release gate resolution names ${releaseName(link.release)}`, null, true);
      for (const g of r.gates) {
        const facts = [`${g.gate}${g.environment ? ` in ${g.environment}` : ""}`, g.relayedBy ? `relayed by ${g.relayedBy}` : null, g.sealed ? "sealed" : null, g.empty ? "an empty change set, passed by the promote itself, not a person's approval" : null];
        row("gate", letThrough(g), facts.filter(Boolean).join(" · "), g.source);
        if (g.changeSet) row("change set", `chant change-set show ${g.changeSet}${r.member ? ` --member ${r.member}` : ""}`, "the change set the approval was for", g.changeSetSource);
        else if (g.planDigest) row("change set", "missing", `chant stored no change set under the plan ${shortDigest(g.planDigest)}`, null, true);
      }
    }

    // The deploys, per environment.
    if (c.deploys.length === 0) row("deploy", "missing", "no deploy record is built from this commit or from one that has it in its history", null, true);
    for (const link of c.deploys) {
      const d = deployOf.get(link.deploy);
      if (!d) {
        row(`deploy ${link.env}`, link.deploy, "", link.source);
        continue;
      }
      const admitted = d.admittedBy ? `admitted by ${d.admittedBy.gate}, ${letThrough(d.admittedBy)}` : "admitted by no gate resolution chant could find";
      const work = d.plan && Array.isArray(d.plan.document.work) && d.plan.document.work.length ? `release plan: ${d.plan.document.work.join(", ")}` : null;
      row(
        `deploy ${link.env}`,
        `${d.component} run ${d.runId} at ${d.timestamp}`,
        [d.release ? `release ${releaseName(d.release)}` : "names no release", admitted, d.approver ? `approved by ${d.approver}` : null, link.link === "contains" ? `built from ${short(d.gitSha)}, which contains this commit` : null, work].filter(Boolean).join(" · "),
        link.source,
      );
    }
    return { sha: short(c.sha), subject: c.subject || "", rows };
  });
  return { note: null, reasons, commits, more: Math.max(0, trace.commits.length - shown.length) };
}


function footer(answer) {
  const parts = [];
  if (typeof answer.ms === "number") parts.push(`read in ${seconds(answer.ms)}`);
  if (answer.chant) parts.push(`chant ${answer.chant}`);
  const region = answer.region ? String(answer.region).replace(/^region:/, "") : null;
  if (region) parts.push(`chant workspace graph --intent ${region}`);
  return parts.join(" · ");
}
