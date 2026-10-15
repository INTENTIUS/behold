// behold#571: "How this hold ends", the approval panel. From the step a wave
// waits on through the waves applied, four rows light one by one, each from a
// record, never from the narration:
//
// - Requested: the wave asked for an approval of its plan (by digest). The
//   gate ledger's pending fact on chant/lifecycle (/api/lifecycle/history,
//   chant's gate-audit `approval-requested`), and the wave's log line.
// - Approved: a reviewer approved exactly that plan. The ledger's approval of
//   that digest, its seal, and whether the seal checks out against the
//   repo's allowed signers (/api/terragucci/lifecycle's `sealCheck`).
// - Resumed: `/terragucci apply` started the waves again and the gate found
//   the approval of this digest. The resume run and its log lines.
// - Spent: the wave applied under that approval, which is now used up. The
//   ledger's applied record, and the wave's log line.
//
// Each record is this cycle's: no earlier than the cycle's start, and, in a
// replay, no later than the replay's clock. The digests repeat from cycle to
// cycle (the loop plans the same change), so the cycle's start is what keeps
// an older approval of the same plan from lighting a row.

import { findLine } from "./kiosk-annotations.js";

/** The steps the panel shows on: from the wave waiting to the waves applied. */
export const PANEL_STEPS = ["waiting", "approved", "resumed", "applied"];

/** The panel's title. */
export const PANEL_TITLE = "How this hold ends";

/** The rows, in order. */
export const ROWS = [
  { id: "requested", label: "Requested" },
  { id: "approved", label: "Approved" },
  { id: "resumed", label: "Resumed" },
  { id: "spent", label: "Spent" },
];

/** A digest's hex part, for comparing `jcs1-sha256:…` with `sha256:…`. */
export const digestHex = (d) => (typeof d === "string" ? d.slice(d.lastIndexOf(":") + 1).toLowerCase() : "");
export const sameDigest = (a, b) => !!digestHex(a) && digestHex(a) === digestHex(b);
/** A digest as a viewer reads it: its first 12 hex digits. */
export const shortDigest = (d) => digestHex(d).slice(0, 12);

const ms = (t) => (t ? Date.parse(t) : NaN);

/** The runs of the cycle demo.json is at, oldest first: same cycle (or, without one, the same pull request since the cycle started), merges and resumes. */
export function cycleRuns(runs, demo) {
  const start = ms(demo && demo.started_at);
  return (runs || [])
    .filter((r) => r && (r.trigger === "merge" || isResume(r) || r.trigger === "push"))
    .filter((r) => (Number.isInteger(r.cycle) && Number.isInteger(demo.cycle) ? r.cycle === demo.cycle : String(r.pull) === String(demo.pull) && !(ms(r.created_at) < start)))
    .sort((a, b) => ms(a.created_at) - ms(b.created_at) || a.id - b.id);
}

/** A run that `/terragucci apply` started: the driver's resume, a comment on the merged pull request. */
export const isResume = (r) => !!r && (r.trigger === "resume" || r.event === "issue_comment");

const waveLine = (wave) => (text) => new RegExp(`^wave ${wave}\\b`).test(text);

/** The line of a run that `ids` know about wave `wave`, with the run's id: `{ run, a, job, step, n, text }` or null. */
function lineOf(run, ids, wave, more = () => true) {
  const f = findLine(run, ids, (text, a) => waveLine(wave)(text) && more(text, a));
  return f ? { run: run.id, ...f } : null;
}

/**
 * The wave this cycle holds and the plan it asks about: the newest "waits for
 * an approval of digest" line (T11) in the cycle's runs, with where it is.
 * Null when no run of the cycle printed one.
 */
export function heldWave(runs) {
  let found = null;
  for (const run of runs) {
    const f = findLine(run, ["T11"]);
    if (!f) continue;
    const m = /^wave (\d+) of \d+ waits for an approval of digest (\S+?)\./.exec(f.text);
    if (m) found = { wave: Number(m[1]), digest: m[2], line: { run: run.id, ...f } };
  }
  return found;
}

/** When a line says it happened: the time in it (T14's approval time is not when it applied), else the run's step's end, else the run's start. */
function lineTime(run, f) {
  const job = run.jobs.find((j) => j.name === f.job);
  const step = job && job.steps ? job.steps[f.step] : null;
  return (step && (step.ended_at || step.started_at)) || run.started_at || run.created_at || null;
}

/**
 * The panel's model: `{ wave, digest, rows: [{ id, label, state, … }] }`, or
 * null when the step is not one the panel shows or no wave of the cycle
 * held. `state` is `lit`, `going` (begun, not done) or `dim`. Inputs:
 *
 * - `demo`: demo.json (or the replay's step);
 * - `runs`: the cycle's runs' documents (any order);
 * - `history`: /api/lifecycle/history's answer;
 * - `lifecycle`: /api/terragucci/lifecycle's answer;
 * - `fallback`: `{ wave, digest }` from the run view, for a wave whose log isn't copied yet;
 * - `now`: the page's clock (the replay's, in a replay), in ms.
 */
export function approvalModel({ demo, runs = [], history = null, lifecycle = null, fallback = null, now = Date.now(), driver = null }) {
  if (!demo || !PANEL_STEPS.includes(demo.step)) return null;
  const cycle = cycleRuns(runs, demo);
  const held = heldWave(cycle) || (fallback && fallback.wave ? { wave: fallback.wave, digest: fallback.digest || null, line: null } : null);
  if (!held) return null;
  const { wave, digest } = held;
  const start = ms(demo.started_at);
  const inCycle = (t) => !(ms(t) < start) && !(ms(t) > now);
  const gate = `wave-${wave}`;
  const entries = (history && Array.isArray(history.entries) ? history.entries : []).filter((e) => e.gate === gate && inCycle(e.at) && (!digest || sameDigest(e.digest, digest)));
  const oldest = (kind) => entries.filter((e) => e.kind === kind).sort((a, b) => ms(a.at) - ms(b.at))[0] || null;
  const requested = oldest("approval-requested");
  const approved = entries.filter((e) => e.kind === "approved" && (!requested || ms(e.at) >= ms(requested.at))).sort((a, b) => ms(a.at) - ms(b.at))[0] || null;
  const lane = lifecycle && Array.isArray(lifecycle.gates) ? lifecycle.gates.find((g) => g.gate === gate) : null;

  // Requested.
  const reqLine = held.line;
  const reqRow = { id: "requested", label: "Requested" };
  if (requested || reqLine) {
    Object.assign(reqRow, {
      state: "lit",
      text: `Wave ${wave} asked for an approval of this plan.`,
      at: requested ? requested.at : reqLine ? lineTime(cycle.find((r) => r.id === reqLine.run), reqLine) : null,
      commit: requested && requested.source ? requested.source.commit || null : null,
      line: reqLine,
    });
  } else Object.assign(reqRow, { state: "dim", text: `Wave ${wave} has not asked for an approval yet.` });

  // Approved.
  const apRow = { id: "approved", label: "Approved" };
  // The resume runs: started by /terragucci apply after the run that held the wave.
  const holdRun = reqLine ? cycle.find((r) => r.id === reqLine.run) : null;
  const resumeRuns = cycle.filter((r) => isResume(r) && (!holdRun || !(ms(r.created_at) < ms(holdRun.created_at))));
  const gateRead = resumeRuns.map((r) => lineOf(r, ["T09"], wave, (text) => / approved by /.test(text))).find(Boolean) || null;
  if (approved) {
    const check = lane && lane.approval && lane.approval.by === approved.actor && ms(lane.approval.at) === ms(approved.at) ? lane.approval.sealCheck || null : null;
    Object.assign(apRow, {
      state: "lit",
      text: `${approved.actor || "A reviewer"} approved exactly this plan.`,
      seal: sealWords(approved, check),
      at: approved.at,
      commit: approved.source ? approved.source.commit || null : null,
      line: gateRead,
    });
  } else if (driver) {
    Object.assign(apRow, { state: "dim", text: driver.gloss, command: driver.approve });
  } else Object.assign(apRow, { state: "dim", text: "Waiting for a reviewer to approve this plan." });

  // Resumed: the resume run, and the gate finding the approval in it.
  const rsRow = { id: "resumed", label: "Resumed" };
  const resume = resumeRuns[resumeRuns.length - 1] || null;
  const found = resume ? lineOf(resume, ["T13"], wave) || gateRead : null;
  const start2 = resume ? findLine(resume, ["T36"]) : null;
  if (resume && found) {
    Object.assign(rsRow, {
      state: "lit",
      text: "/terragucci apply ran the waves again, and the gate found this approval.",
      at: resume.started_at || resume.created_at,
      runId: resume.id,
      line: start2 ? { run: resume.id, ...start2 } : found,
    });
  } else if (resume) {
    Object.assign(rsRow, { state: "going", text: `/terragucci apply started the waves again; wave ${wave} has not reached its gate yet.`, at: resume.started_at || resume.created_at, runId: resume.id, line: start2 ? { run: resume.id, ...start2 } : null });
  } else {
    Object.assign(rsRow, { state: "dim", text: driver && driver.comment ? `Then a comment of ${driver.comment} on ${driver.on} starts the waves again.` : "A comment of /terragucci apply starts the waves again." });
  }

  // Spent: the ledger's applied record under this approval, or the wave's line.
  const spRow = { id: "spent", label: "Spent" };
  const spentLine = cycle.map((r) => lineOf(r, ["T14"], wave, (text) => !approved || !approved.actor || text.includes(` by ${approved.actor} `))).find(Boolean) || null;
  const appliedRec = lane && lane.applied && approved && lane.applied.approvedBy === approved.actor && ms(lane.applied.approvedAt) === ms(approved.at) && inCycle(lane.applied.at) ? lane.applied : null;
  if (appliedRec || spentLine) {
    Object.assign(spRow, {
      state: "lit",
      text: `Wave ${wave} applied under that approval, which is now used up.`,
      at: appliedRec ? appliedRec.at : spentLine ? lineTime(cycle.find((r) => r.id === spentLine.run), spentLine) : null,
      runId: spentLine ? spentLine.run : null,
      line: spentLine,
    });
  } else Object.assign(spRow, { state: "dim", text: `Once wave ${wave} applies, this approval is used up for good.` });

  return { wave, digest, rows: inferBack([reqRow, apRow, rsRow, spRow], { wave, gateRead, spentLine, resumeRuns }) };
}

/** The words a row lit only because a later one is, by row. Each says it was inferred; none invents a time. */
export const INFERRED = {
  requested: (wave) => `Wave ${wave} asked for an approval of this plan.`,
  approved: (actor) => `${actor || "A reviewer"} approved this plan.`,
  resumed: () => "The waves ran again under this approval.",
};

/**
 * behold#571: a hold ends in order, so no row is lit after one that isn't.
 * A lit row lights the rows before it: Spent means the waves ran again
 * (Resumed), which means the plan was approved, which means it was asked
 * for. A row lit this way says so (`inferred`), names what the later rows
 * show (the approver from the gate's or the spend's line, the run), and
 * carries no time it does not have.
 */
export function inferBack(rows, { wave, gateRead = null, spentLine = null, resumeRuns = [] } = {}) {
  const out = rows.map((r) => ({ ...r }));
  for (let i = out.length - 1; i > 0; i--) {
    if (out[i].state !== "lit" || out[i - 1].state === "lit") continue;
    const r = out[i - 1];
    const base = { id: r.id, label: r.label, state: "lit", inferred: true };
    if (r.id === "requested") out[i - 1] = { ...base, text: INFERRED.requested(wave) };
    else if (r.id === "approved") {
      const said = [gateRead, spentLine].filter(Boolean).map((l) => / approv(?:ed|al) by (\S+?)[;,\s]/.exec(`${l.text} `)).find(Boolean);
      out[i - 1] = { ...base, text: INFERRED.approved(said ? said[1] : null), line: gateRead || null };
    } else if (r.id === "resumed") {
      const run = resumeRuns[resumeRuns.length - 1] || null;
      out[i - 1] = { ...base, text: INFERRED.resumed(), runId: run ? run.id : r.runId || (spentLine ? spentLine.run : null), at: r.at || null, line: r.line || null };
    }
  }
  return out;
}

/**
 * The seal in words: signed and checked against the repo's allowed signers,
 * signed and not matching (with chant's reason), signed with nothing to
 * check it against here, or not signed.
 */
export function sealWords(entry, check) {
  const signed = entry && (entry.seal === "sealed" || (entry.audit && entry.audit.sealed));
  if (!signed) return { ok: null, text: entry && entry.seal === "review" ? "approved by a pull request review" : "not signed" };
  if (check && check.ok) return { ok: true, text: "signed; matches the repo's allowed signers" };
  if (check && check.ok === false) return { ok: false, text: `signed, but the signature does not check out: ${check.reason}` };
  return { ok: null, text: "signed; behold has not checked the signature" };
}

/** "04:09:41", in UTC (the panel's head says so). */
export function clockWords(at) {
  const t = ms(at);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(11, 19);
}

/** A row's facts after its sentence, in order: the seal, the time, the ledger's commit on chant/lifecycle, the run. */
export function rowFacts(row) {
  return [row.inferred ? "inferred from the rows after it" : null, row.seal ? row.seal.text : null, clockWords(row.at), row.commit ? `ledger ${row.commit.slice(0, 8)}` : null, row.runId ? `run #${row.runId}` : null].filter(Boolean);
}

