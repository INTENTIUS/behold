// #526: SQL Yodeler's report and drift, read from files by /api/yodel-report.
// Pure helpers; app.js places the marks and draws the panel. A mark is a
// dated corner tag, never a fill: none of this is live.
import { ago, clock } from "./terragucci.js";

/** The ids of the cards an object names: the id itself, or a member's `<member>/<name>`. */
export function cardsFor(object, ids) {
  return ids.filter((id) => id === object || id.endsWith("/" + object));
}

/** Join the read's marks onto the drawn card ids: marks by card, and the objects no card is. */
export function joinMarks(answer, ids) {
  const cards = {};
  const unmatched = [];
  for (const m of (answer && answer.marks) || []) {
    const hit = cardsFor(m.object, ids);
    if (hit.length === 0) unmatched.push(m);
    for (const id of hit) (cards[id] ||= []).push(m);
  }
  return { cards, unmatched };
}

/** When and from where, in words: "drift-prod.json, written 06:04 UTC, 4h ago". */
export function datedWords(dated, now = new Date()) {
  const how = dated.by === "generatedAt" ? "generated" : "written";
  return `${dated.file}, ${how} ${clock(dated.at, now)}, ${ago(dated.at, now)}`;
}

/** One mark as a line: "prod: changed out of band (ttl) · drift-prod.json, written 06:04 UTC, 4h ago". */
export function markLine(m, now = new Date()) {
  const paths = m.changes.map((c) => c.path).filter(Boolean);
  return `${m.environment}: ${m.words}${paths.length ? ` (${paths.join(", ")})` : ""} · ${datedWords(m.dated, now)}`;
}

/** The corner tag for a card's marks: "drift prod · 4h", the age of the newest. */
export function cornerText(marks, now = new Date()) {
  const envs = [...new Set(marks.map((m) => m.environment))].join(", ");
  const newest = marks.map((m) => m.dated.at).sort().pop();
  const s = Math.max(0, (now.getTime() - Date.parse(newest)) / 1000);
  const age = s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return `drift ${envs} · ${age}`;
}

/** The panel's lines for one environment, from the report. */
export function environmentLines(e, now = new Date()) {
  const lines = [];
  if (e.error) lines.push(`could not be read: ${e.error}`);
  const newest = e.applied[e.applied.length - 1];
  lines.push(
    `${e.applied.length} applied` +
      (newest ? `, newest ${newest.id}${newest.at ? ` at ${clock(newest.at, now)}` : ""}${newest.by ? ` by ${newest.by}` : ""}` : ""),
  );
  for (const m of e.other) lines.push(`${m.id}: ${m.state}${m.inDirectory ? "" : " (not in the directory)"}`);
  for (const g of e.gaps) lines.push(`gap (${g.kind}): ${g.detail}`);
  for (const n of e.notes) lines.push(`note: ${n}`);
  return lines;
}

/** The panel's head: what was read, how it was checked, and when. */
export function legend(answer, now = new Date()) {
  const v = answer.validation;
  const checked = v.from === "package" ? `@intentius/sql-yodeler ${v.sqlYodeler}'s schemas` : `behold's pinned copy of SQL Yodeler's schemas (${v.commit})`;
  const what = answer.report ? `${answer.report.file}, generated ${clock(answer.report.generatedAt, now)}, ${ago(answer.report.generatedAt, now)}` : "no report";
  return { text: `SQL Yodeler, not live · ${what} · ${answer.drift.length} drift file${answer.drift.length === 1 ? "" : "s"}`, title: `Read from ${answer.source}, checked against ${checked}. behold never runs yodel or reads the database.` };
}

// #537: the report's audit entries. Each is dated by its own `at` and says
// where SQL Yodeler read it: a gate ledger on chant/lifecycle, or a row of
// the environment's history table.
const AUDIT_WORDS = {
  "approval-requested": "approval asked",
  approved: "approved",
  override: "overridden",
  silenced: "silenced",
  applied: "applied",
  refused: "refused",
  failed: "failed",
  repaired: "repaired",
  reverted: "reverted",
  step: "step",
};

/** Where an entry came from: "ledger <l>, <op>/<gate>" or "<history> row <seq>, run <run>". */
export function auditSource(a) {
  const s = a.source || {};
  if (s.ledger !== undefined) return `chant/lifecycle ledger ${s.ledger}, ${s.op}/${s.gate}`;
  if (s.history !== undefined) return `${s.history} row ${s.seq}, run ${s.run}`;
  return "an unnamed source";
}

/** One entry as a line and its source line. Pure. */
export function auditLines(a, now = new Date()) {
  const what = [AUDIT_WORDS[a.kind] || a.kind, a.migration || "", a.by ? `by ${a.by}` : ""].filter(Boolean).join(" ");
  const extra = [a.detail || "", a.digest ? `plan ${String(a.digest).replace(/^(jcs1-)?sha256:/, "").slice(0, 12)}` : "", a.wave ? `wave gate ${a.wave.gate} ${a.wave.status === "approved" ? "approved" : "needed no approval"}` : ""].filter(Boolean);
  return {
    text: `${what}${extra.length ? ` (${extra.join(", ")})` : ""} · ${clock(a.at, now)}, ${ago(a.at, now)}`,
    source: `from ${auditSource(a)}, in ${a.file}`,
  };
}
