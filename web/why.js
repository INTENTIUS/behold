// #471: the "why" section of the inspect pane, for a member or a card in a
// declared workspace. Pure: app.js fetches /api/workspace/why when someone
// clicks "read why" and paints what whyView returns.
//
// Everything here is chant's answer (`chant workspace graph --intent <region>
// --json`, its `why`), put into words. The decisions are chant's ranking, in
// chant's order; behold neither re-ranks nor filters them. A proposed decision
// links to its review in hud when behold was started with --hud, and is named
// by its id otherwise.

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
  return { headline, decisions, runs, commits, more, gaps, footer: footer(answer) };
}

function footer(answer) {
  const parts = [];
  if (typeof answer.ms === "number") parts.push(`read in ${seconds(answer.ms)}`);
  if (answer.chant) parts.push(`chant ${answer.chant}`);
  const region = answer.region ? String(answer.region).replace(/^region:/, "") : null;
  if (region) parts.push(`chant workspace graph --intent ${region}`);
  return parts.join(" · ");
}
