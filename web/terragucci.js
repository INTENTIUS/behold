// #490: a terragucci estate painted from its reports. Pure: app.js fetches
// /api/terragucci, then stamps cards and fills the panel tab from what these
// functions return.
//
// Everything here is dated. A mark says what a run found, when that run
// finished and how long ago that is, and links the run's report and job. No
// mark is a fill and none says "live": a card the reports say nothing about is
// left as it is, which is not the same as fine. A waiting wave offers only the
// line a person runs at their shell; behold has no approve button for it.

/** "4h ago", "3d ago", "just now". */
export function ago(iso, now = new Date()) {
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** The run's finish as a clock time, with the date when it is not today, in UTC so every viewer reads the same words. */
export function clock(iso, now = new Date()) {
  const d = new Date(iso);
  const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const sameDay = d.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  return sameDay ? `${hhmm} UTC` : `${d.toISOString().slice(0, 10)} ${hhmm} UTC`;
}

const STAGE_WORDS = { "tf-drift": "drift check", "tf-plan": "plan", "tf-apply": "apply" };

/** Which run, in words: "drift check 06:04 UTC, 4h ago", "plan on PR #12 09:00 UTC, 1h ago". */
export function runWords(run, now = new Date()) {
  const what = run.stage === "tf-apply" && run.wave !== undefined ? `apply wave ${run.wave}` : STAGE_WORDS[run.stage] || run.stage;
  const pr = run.pull_request ? ` on PR #${run.pull_request}` : "";
  return `${what}${pr} ${clock(run.finished, now)}, ${ago(run.finished, now)}`;
}

/** One mark as a sentence: "drift found 06:04 UTC, 4h ago: deleted outside Terraform". */
export function markLine(mark, now = new Date()) {
  const lead = mark.verdict === "drift" ? "drift found" : mark.verdict === "wave" ? `wave ${mark.run.wave} waiting` : `plan${mark.run.pull_request ? ` on PR #${mark.run.pull_request}` : ""}`;
  const attrs = mark.attributes && mark.attributes.length ? ` (${mark.attributes.join(", ")})` : "";
  const many = mark.addresses.length > 1 ? ` · ${mark.addresses.length} instances` : "";
  return `${lead} ${clock(mark.run.finished, now)}, ${ago(mark.run.finished, now)}: ${mark.words}${attrs}${many}`;
}

/** The corner glyph of a marked card: drift outranks a wave, a wave outranks a plan. */
export function cornerOf(marks) {
  if (marks.some((m) => m.verdict === "drift")) return { text: "⚠ drift", tone: "drift" };
  if (marks.some((m) => m.verdict === "wave")) return { text: "⏸ wave", tone: "wave" };
  return { text: "~ plan", tone: "plan" };
}

/** The address a key opens at: this server's file route, or a relative path in an export. */
export function hrefOf(answer, key) {
  return `${answer.files || ""}${answer.files && answer.files.includes("?") ? encodeURIComponent(key) : key}`;
}

/** The newest run any mark or root names: what the legend dates the picture by. */
export function newestRun(answer) {
  let best = null;
  const see = (run) => {
    if (run && (!best || run.finished > best.finished)) best = run;
  };
  for (const r of answer.roots || []) for (const k of ["plan", "drift", "apply"]) see(r[k] && r[k].run);
  return best;
}

/** The line under the tab's title: whose reports, how old, how checked. Never "live". `title` carries the long form. */
export function legend(answer, now = new Date()) {
  const newest = newestRun(answer);
  const checked = answer.validation && answer.validation.by === "schema" ? `checked against terragucci ${answer.validation.terragucci}'s schemas` : "checked structurally; install @intentius/terragucci to check against its schemas";
  return {
    text: `terragucci reports of ${answer.project}, not live${newest ? ` · newest run ${ago(newest.finished, now)}` : " · no runs for these roots yet"}`,
    title: [newest ? `newest run: ${runWords(newest, now)}` : "", `${answer.reports} report${answer.reports === 1 ? "" : "s"} read from ${answer.source}`, checked].filter(Boolean).join("\n"),
  };
}

/** A root's cell for one stage: what its newest run of that stage found, or that there is none. Short, with the clock in `title`. */
export function stageCell(verdict, stage, now = new Date()) {
  if (!verdict) return { text: "no report", tone: "none", title: `no ${STAGE_WORDS[stage]} report holds this root` };
  const title = [runWords(verdict.run, now), verdict.error].filter(Boolean).join("\n");
  const age = ago(verdict.run.finished, now);
  if (verdict.status === "failed") return { text: `failed, ${age}`, tone: "failed", title };
  if (stage === "tf-apply") {
    if (verdict.approval === "waiting") return { text: `wave ${verdict.run.wave} waiting, ${age}`, tone: "wave", title };
    return { text: `wave ${verdict.run.wave} ${verdict.applied ? "applied" : verdict.approval || "ran"}, ${age}`, tone: "ok", title };
  }
  if (verdict.changes === 0) return { text: `${stage === "tf-drift" ? "none" : "no changes"}, ${age}`, tone: "ok", title };
  const noun = stage === "tf-drift" ? "drifted" : `change${verdict.changes === 1 ? "" : "s"}`;
  const pr = verdict.run.pull_request ? ` (PR #${verdict.run.pull_request})` : "";
  return { text: `${verdict.changes} ${noun}${pr}, ${age}`, tone: stage === "tf-drift" ? "drift" : "plan", title };
}

/** The roots table, drift first: the rows that say something come before the quiet ones. */
export function rootRows(answer, now = new Date()) {
  const rank = (r) => (r.drift && (r.drift.status === "failed" || r.drift.changes > 0) ? 0 : r.apply && r.apply.approval === "waiting" ? 1 : r.plan && r.plan.changes > 0 ? 2 : 3);
  return [...(answer.roots || [])]
    .sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : 1))
    .map((r) => ({
      path: r.path,
      name: r.name,
      member: r.member,
      drift: { ...stageCell(r.drift, "tf-drift", now), ...(r.drift ? { href: hrefOf(answer, r.drift.run.report) } : {}) },
      plan: { ...stageCell(r.plan, "tf-plan", now), ...(r.plan ? { href: hrefOf(answer, r.plan.run.report) } : {}) },
      apply: { ...stageCell(r.apply, "tf-apply", now), ...(r.apply ? { href: hrefOf(answer, r.apply.run.report) } : {}) },
    }));
}

/** A waiting wave as a gate card: what it holds and destroys, how long it has waited, and the line to run. No button. */
export function waveCards(answer, now = new Date()) {
  return (answer.waiting || []).map((w) => ({
    title: `wave ${w.wave} waits for an approval`,
    facts: [
      `since ${clock(w.since, now)}, ${ago(w.since, now)}`,
      `${w.roots.length} root${w.roots.length === 1 ? "" : "s"}`,
      `commit ${w.commit.slice(0, 12)}`,
      w.set_digest ? `plan ${w.set_digest.replace(/^jcs1-sha256:/, "").slice(0, 12)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    destroys: w.destroys,
    command: w.command,
    note: "An approval is a signed git record bound to this plan digest: run the line at your shell. behold does not approve.",
    report: hrefOf(answer, w.report),
    ...(w.job_url ? { job: w.job_url } : {}),
  }));
}

/** terragucci's own counts, as its estate page shows them, with the page's link. */
export function estateLine(answer) {
  if (!answer.estate) return null;
  const e = answer.estate;
  return {
    text: `terragucci's estate page: ${e.drifted} root${e.drifted === 1 ? "" : "s"} drifted · ${e.failed} failed · ${e.waiting} wave${e.waiting === 1 ? "" : "s"} waiting`,
    href: hrefOf(answer, e.html),
  };
}
