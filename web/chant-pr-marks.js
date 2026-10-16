// behold#631: the marks on a chant project's components view, for a repo
// whose CI runs chant's pull-request loop (`chant components pr-plan` on a
// pull request, `pr-apply` on its merge). What /api/chant/pr read (chant's
// pr-report, or the summary each stage prints in its run's log, and the
// gate's ledger) as the same marks a terragucci repo's components carry
// (web/terragucci-components-live.js), so app.js draws both one way:
//
// - `cards[component]`: its wave and state (planned, applied, unchanged,
//   failed, refused), the words on the card and the facts in its tooltip;
// - `waves[n]`: the wave's state (waiting while the gate waits on the plan's
//   digest), the run's job status while it runs, and the facts on its box.
//
// Only what chant recorded: while pr-apply runs, chant has printed nothing
// per wave or component yet (chant#4007), so the boxes say the job runs and
// the cards keep the plan they apply.

/** The issue that asks chant for progress per wave and component, and a report a reader can fetch. */
export const PROGRESS_ISSUE = "chant#4007";

/** A card's state in one or two words, when the full words don't fit. */
export const CHANT_SHORT = { planned: "planned", applied: "applied", unchanged: "unchanged", failed: "failed", refused: "refused", "not-started": "held back" };

const TONE = { planned: "plan", waiting: "wait", applying: "busy", applied: "ok", failed: "bad", refused: "bad" };
const toneOf = (state) => TONE[state] || "idle";

/** A plan's changes as Terraform sums them up, "+1 ~2 -1" (create, update, delete; a replace is both), or null for none. */
export function countWords(counts) {
  if (!counts) return null;
  const add = (counts.create || 0) + (counts.replace || 0);
  const del = (counts.delete || 0) + (counts.replace || 0);
  const parts = [];
  if (add) parts.push(`+${add}`);
  if (counts.update) parts.push(`~${counts.update}`);
  if (del) parts.push(`-${del}`);
  return parts.length ? parts.join(" ") : null;
}

/** The same in words, for a tooltip: "1 to create, 2 to update". */
export function countSentence(counts) {
  if (!counts) return null;
  const parts = [];
  if (counts.create) parts.push(`${counts.create} to create`);
  if (counts.update) parts.push(`${counts.update} to update`);
  if (counts.replace) parts.push(`${counts.replace} to replace`);
  if (counts.delete) parts.push(`${counts.delete} to delete`);
  return parts.length ? parts.join(", ") : null;
}

/** A digest's hex part, without its `jcs1-sha256:` scheme. */
export const hexOf = (d) => (typeof d === "string" ? d.slice(d.lastIndexOf(":") + 1) : "");
/** A digest as a viewer reads it: its first 8 hex digits. */
export const short8 = (d) => hexOf(d).slice(0, 8);

/** The stage the marks follow: the apply once it reported, else the plan. */
const stageOf = (a) => (a && a.apply ? a.apply : a && a.plan ? a.plan : null);

/** A member's state in a stage. */
function memberState(m, stage) {
  if (!m) return "unchanged";
  if (m.status === "applied") return "applied";
  if (m.status === "failed" || m.status === "plan-failed") return "failed";
  if (m.status === "blocked") return "not-started";
  if (stage.stage === "apply" && stage.status === "refused") return "refused";
  return "planned";
}

/** The words on a card for its state. */
function cardWords(state, m, gate) {
  if (state === "unchanged") return "unchanged";
  if (state === "failed") return m && m.status === "plan-failed" ? "plan failed" : "apply failed";
  if (state === "not-started") return "held back by an earlier wave";
  if (state === "refused") return gate && gate.refusal ? `refused (${gate.refusal})` : "refused";
  const c = countWords(m && m.counts);
  if (state === "applied") return c ? `applied ${c}` : "applied";
  return c ? `planned ${c}` : "planned, no changes";
}

/**
 * The marks for /api/chant/pr's answer and the components graph's
 * `meta.chantPr` facets. Empty (no cards, no waves) before the pull
 * request's first plan: a card with no state draws as the view's neutral.
 */
export function chantComponentMarks(answer, facets) {
  const cards = {};
  const waves = {};
  const empty = { stage: null, cards, waves, source: null };
  if (!answer || answer.error || !facets || !facets.waves) return empty;
  const stage = stageOf(answer);
  const gate = answer.gate || null;
  const running = answer.running || null;
  const componentOf = (m) => m.component || (facets.members && facets.members[m.member]) || m.member;
  const waveNumbers = [...new Set(Object.values(facets.waves))].filter(Number.isInteger).sort((a, b) => a - b);
  if (!stage && !running) return empty;

  const facts = (state, m) => {
    const out = [];
    if (m && countSentence(m.counts)) out.push(countSentence(m.counts));
    if (stage && stage.digest) out.push(`plan ${short8(stage.digest)}`);
    if (m && m.error) out.push(m.error);
    if (m && m.inputsMoved && m.inputsMoved.length) out.push(`inputs from ${m.inputsMoved.join(", ")} moved; the next run plans it again`);
    if (state === "planned" && running && running.stage === "apply") out.push(`per-component progress: ${PROGRESS_ISSUE}`);
    return out;
  };
  if (stage) {
    for (const [c, n] of Object.entries(facets.waves)) {
      const m = stage.members.find((x) => componentOf(x) === c) || null;
      const state = memberState(m, stage);
      cards[c] = { root: c, wave: n, state, tone: toneOf(state), words: cardWords(state, m, gate), short: CHANT_SHORT[state] || state, facts: facts(state, m) };
    }
  }
  for (const n of waveNumbers) {
    const members = Object.entries(facets.waves).filter(([, w]) => w === n).map(([c]) => cards[c]).filter(Boolean);
    const touched = members.filter((m) => m.state !== "unchanged");
    let state = null;
    if (touched.length) {
      if (touched.some((m) => m.state === "failed")) state = "failed";
      else if (touched.some((m) => m.state === "refused")) state = "refused";
      else if (touched.every((m) => m.state === "applied")) state = "applied";
      else if (touched.some((m) => m.state === "not-started")) state = "not-started";
      else state = gate && gate.state === "waiting" && !answer.apply ? "waiting" : "planned";
    }
    const status = running ? { status: running.status, words: `${running.job} ${running.status}`, tone: running.status === "running" ? "busy" : "idle", run: running.run } : null;
    const f = [];
    if (state === "waiting" && gate && gate.digest) f.push(`approve plan ${hexOf(gate.digest)}`);
    else if (state === "planned" && gate && gate.state === "approved") f.push(gate.by ? `approved by ${gate.by.replace(/^.*:/, "")}` : "approved");
    if (state === "applied" && stage && stage.digest) f.push(`applied plan ${short8(stage.digest)}`);
    // While pr-apply runs, chant has said nothing per wave yet: that first, with the issue that asks for it.
    if (running && running.stage === "apply" && touched.length && state !== "applied") f.unshift(`per-wave progress: ${PROGRESS_ISSUE}`);
    waves[n] = { number: n, job: running ? running.job : null, state, tone: state ? toneOf(state) : status ? status.tone : "idle", status, title: status ? `wave-${n} · ${status.words}` : `wave-${n}`, facts: f };
  }
  return { stage: stage ? stage.stage : null, cards, waves, source: sourceWords(answer) };
}

/** Where the marks came from, for each tooltip. */
export function sourceWords(answer) {
  const from = (s) => (s.from === "report" ? `chant's pr-${s.stage} report` : `chant pr-${s.stage}'s summary in run #${s.run}`);
  const parts = [answer.plan, answer.apply].filter(Boolean).map(from);
  if (answer.gate && answer.gate.from === "ledger") parts.push("the gate's ledger");
  return parts.length ? `(from ${parts.join(", ")})` : null;
}

/** The steps chant's gate shows its panel on: the plan waits, it is approved, the merge applied it. */
export const CHANT_PANEL_STEPS = ["waiting", "approved", "merged", "applying", "applied"];

/**
 * "How this hold ends" for chant's gate: one gate per pull request (op
 * `pr-<n>`, gate `pr-apply`) on the plan's digest, approved before the
 * merge. Three rows, each lit from a record: the plan asked for it (the
 * approve line pr-plan printed), the ledger's approval of that digest, and
 * pr-apply applying under it. Null when the answer has no gate.
 */
export function chantApprovalModel({ demo, answer, sealCheck = null }) {
  if (!demo || !CHANT_PANEL_STEPS.includes(demo.step) || !answer || !answer.gate || !answer.plan) return null;
  const g = answer.gate;
  const plan = answer.plan;
  const apply = answer.apply;
  const rows = [];
  rows.push({ id: "requested", label: "Requested", state: "lit", text: `Pull request #${answer.pull} asks a reviewer to approve its plan.`, runId: plan.run || null, ...(g.approveCommand && g.state === "waiting" ? { command: g.approveCommand } : {}) });
  if (g.state === "approved") {
    const signed = g.seal === "sealed";
    rows.push({
      id: "approved",
      label: "Approved",
      state: "lit",
      text: `${g.by || "A reviewer"} approved this exact digest.`,
      seal: signed ? (sealCheck && sealCheck.ok ? { ok: true, text: "signed; matches the repo's allowed signers" } : { ok: null, text: "signed" }) : { ok: null, text: g.from === "ledger" ? "not signed" : "from the report" },
      at: g.at || null,
      commit: g.ledgerCommit || null,
    });
  } else if (g.state === "changed" || g.state === "refused") {
    rows.push({ id: "approved", label: "Approved", state: "dim", text: g.state === "changed" ? "The plan moved after review and needs a fresh approval." : `The apply refused (${g.refusal || "no approval"}).` });
  } else rows.push({ id: "approved", label: "Approved", state: "dim", text: "Next, a reviewer approves the digest." });
  if (apply && apply.status === "applied") rows.push({ id: "spent", label: "Applied", state: "lit", text: "The merge planned again and applied this digest.", runId: apply.run || null });
  else if (answer.running && answer.running.stage === "apply") rows.push({ id: "spent", label: "Applied", state: "going", text: "chant is applying this digest on merge now.", runId: answer.running.run });
  else rows.push({ id: "spent", label: "Applied", state: "dim", text: "On merge, chant applies the plan when it matches." });
  const run = apply ? apply.run : answer.running ? answer.running.run : plan.run;
  return { wave: null, digest: g.digest, run: run || null, rows };
}
