// #1236: the Stages tab. Pure words from /api/workspace/stages, and one render.
// One block per member with a pipeline, one row per stage in pipeline order:
// the release it runs, its gate, the change risk the gate reads and why, its
// soak and the time left, the canary soaks that hold it, a pause, a hold or
// freeze window, the releases queued for it, and a rollback request or a held
// rollback. Every fact is chant's (workspace status, chant#5342); chant's
// approve and rollback lines are shown to copy and never run. A state this
// page has no word for is drawn as chant wrote it, in the neutral tone.

import { clock } from "./terragucci.js";

const short = (s) => (s ? String(s).replace(/^(jcs1-)?sha256:/, "").slice(0, 12) : "");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A release by its label, else its digest's head. */
const named = (label, digest) => label || short(digest) || "a release";
const ref = (r) => (r ? named(r.label, r.digest) : "a release");

/** Milliseconds as "1h 5m", "12m", "40s". */
export function leftWords(ms) {
  if (typeof ms !== "number") return null;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** The tone of a soak state, from chant's soakState words. */
const SOAK_TONE = { soaking: "wait", "clock-unknown": "wait", failing: "fail", due: "quiet", ended: "quiet", unread: "quiet" };
/** The tone of a gate state. */
const GATE_TONE = { pending: "wait", approved: "ok", expired: "quiet", superseded: "quiet" };

/** The tab's first line: what was read, or why it wasn't. */
export function stagesLegend(a, now = new Date()) {
  if (!a || a.error) return { text: `stages not read${a && a.error ? `: ${a.error}` : ""}`, title: "", tone: "refusal" };
  if (a.workspace === false) return { text: "Stages are read from a declared chant workspace.", title: "", tone: "quiet" };
  if (a.refusal) return { text: `stages not read: ${a.refusal.error}`, title: a.refusal.remedy || "", tone: "refusal" };
  const members = a.members || [];
  const when = a.readAt ? ` · read ${clock(a.readAt, now)}` : "";
  return { text: `${plural(members.length, "pipeline")} · status read at ${a.env}${when}`, title: "Each stage as chant workspace status reads it. Time left counts from the read.", tone: "quiet" };
}

/** The release line: what the stage runs. */
export function releaseRow(s) {
  const r = s.release;
  if (!r) return { key: "release", text: "runs: awaiting its first recorded deploy", tone: "quiet", title: "chant reads the release from the stage's release ledger." };
  const parts = [`runs ${named(r.label, r.releaseDigest)}`];
  if (r.components && r.components.length) parts.push(r.components.join(", "));
  if (r.mixed) parts.push("mixed: its components run more than one release");
  return { key: "release", text: parts.join(" · "), tone: r.mixed ? "wait" : "plain", title: [r.releaseDigest && `release ${r.releaseDigest}`, r.gitSha && `commit ${r.gitSha}`, r.at && `deployed ${r.at}`].filter(Boolean).join("\n") };
}

/** The gate line, with chant's approve line to copy while it waits. */
export function gateRow(s) {
  const g = s.gate;
  if (!g) return null;
  const policy = g.policy && g.policy !== "always" ? ` (${g.policy})` : "";
  if (g.state === null || g.state === undefined) return { key: "gate", text: `gate ${g.name}${policy}: open for the next promote`, tone: "quiet", title: "" };
  const parts = [`gate ${g.name}${policy}: ${g.state} ${g.approvals}/${g.needed}`];
  if (g.releaseDigest) parts.push(`for ${named(g.label, g.releaseDigest)}`);
  return {
    key: "gate",
    text: parts.join(" "),
    tone: GATE_TONE[g.state] || "quiet",
    title: [g.planDigest && `plan ${g.planDigest}`, g.recordedAt && `recorded ${g.recordedAt}`].filter(Boolean).join("\n"),
    ...(g.state === "pending" && g.approve ? { command: g.approve } : {}),
  };
}

/** The risk line: score, level, and why it is over, from chant. */
export function riskRow(s) {
  const r = s.risk;
  if (!r) return null;
  const score = typeof r.score === "number" ? r.score.toFixed(2) : String(r.score);
  const head = `risk ${score} ${r.level} for ${named(r.label, r.releaseDigest)}`;
  if (!r.reads) return { key: "risk", text: `${head} · the gate reads it once the stage sets holds.risk`, tone: "quiet", title: "" };
  if (r.over) return { key: "risk", text: `${head} · over ${r.approveAbove}: the gate takes more approvals`, tone: "wait", title: "", reasons: r.overBy || [] };
  return { key: "risk", text: `${head} · within ${r.approveAbove}`, tone: "plain", title: "" };
}

/** The soak line: its state and the time left. */
export function soakRow(s) {
  const k = s.soak;
  if (!k) return null;
  const parts = [`soak ${k.duration}`, k.state];
  const left = leftWords(k.leftMs);
  if (k.state === "soaking" && left) parts.push(`${left} left`);
  if (k.due) parts.push(`due ${k.due}`);
  if (k.to) parts.push(`holds the promote into ${k.to}`);
  if (k.state === "failing" && k.failing && k.failing.length) parts.push(`failing ${k.failing.join(", ")}`);
  if (k.state === "ended" && k.endedBy) parts.push(`ended by ${k.endedBy}`);
  return { key: "soak", text: parts.join(" · "), tone: SOAK_TONE[k.state] || "quiet", title: [`${plural(k.checks, "check")}, gate ${k.gate}`, ...(k.holds || [])].join("\n") };
}

/** One line per canary upstream: holding or not, with the time left. */
export function canaryRows(s) {
  return (s.canaryHolds || []).map((c) => {
    const left = leftWords(c.leftMs);
    const text = c.holding ? `held by canary ${c.stage}: ${c.state}${left && c.state === "soaking" ? `, ${left} left` : ""}` : `canary ${c.stage}: ${c.state}`;
    return { key: `canary:${c.stage}`, text, tone: c.holding ? (SOAK_TONE[c.state] === "fail" ? "fail" : "wait") : "quiet", title: c.due ? `due ${c.due}` : "" };
  });
}

/** The pause line, with the releases that wait behind it. */
export function pauseRow(s) {
  const p = s.paused;
  if (!p) return null;
  const parts = [`paused by ${p.by}${p.cause === "rollback" ? " after a rollback" : ""}${p.reason ? `: ${p.reason}` : ""}`];
  if (p.waiting && p.waiting.length) parts.push(`waiting ${p.waiting.map(ref).join(", ")}`);
  return { key: "paused", text: parts.join(" · "), tone: "wait", title: p.at ? `since ${p.at}` : "" };
}

/** The hold or freeze window, from the promotion order. */
export function heldRow(s) {
  const h = s.held;
  if (!h) return null;
  const until = h.until ? `until ${h.until}` : "until a change to the pipeline lifts it";
  const what = h.kind === "freeze" ? "in a freeze window" : h.kind === "hold" ? "held" : String(h.kind);
  return { key: "held", text: `${what} ${until}${h.reason ? `: ${h.reason}` : ""}`, tone: "wait", title: "", ...(h.description ? { reasons: [`before it goes on: ${h.description}`] } : {}) };
}

/** The queue: the release in the stage, and the ones waiting or replaced. */
export function queueRow(s) {
  const q = s.queue;
  if (!q) return null;
  const parts = [];
  if (q.inStage) parts.push(`deploying ${named(q.inStage.label, q.inStage.digest)}`);
  if (q.waiting && q.waiting.length) parts.push(`waiting ${q.waiting.map((w) => named(w.label, w.digest)).join(", ")}`);
  if (q.replaced && q.replaced.length) parts.push(`replaced ${q.replaced.map((r) => `${named(r.label, r.digest)} by ${named(r.byLabel, r.by)}`).join(", ")}`);
  if (!parts.length) return null;
  return { key: "queue", text: `queue: ${parts.join(" · ")}`, tone: q.waiting && q.waiting.length ? "wait" : "plain", title: "" };
}

/** The rollback request, with chant's approve and rollback lines to copy. */
export function rollbackRows(s) {
  const out = [];
  const r = s.rollback;
  if (r) {
    const why = r.failure ? ` after ${r.failure} failed${r.failed ? ` on ${ref(r.failed)}` : ""}` : "";
    out.push({
      key: "rollback",
      text: `rollback to ${ref(r.to)} requested by ${r.by}${why} · gate ${r.gate}: ${r.state ?? "unrecorded"}`,
      tone: "fail",
      title: [`requested ${r.requestedAt}`, ...(r.members || []).map((m) => `${m.member}: ${m.state}${m.rollback ? `, ${m.rollback}` : ""}`)].join("\n"),
      commands: [r.state === "pending" || r.state === null ? r.approve : null, r.command].filter(Boolean),
    });
  }
  const h = s.rollbackHeld;
  if (h) out.push({ key: "rollbackHeld", text: `rollback held${h.failure ? ` after ${h.failure} failed${h.failed ? ` on ${ref(h.failed)}` : ""}` : ""}: ${h.reason}`, tone: "fail", title: h.at ? `at ${h.at}` : "" });
  return out;
}

/** One stage's head and rows. */
export function stageCard(s) {
  const head = [s.name, s.canary ? "canary" : null, s.after && s.after.length ? `after ${s.after.join(", ")}` : null, s.onVerifyFail ? `on verify fail: ${s.onVerifyFail}` : null].filter(Boolean).join(" · ");
  const rows = [releaseRow(s), gateRow(s), riskRow(s), soakRow(s), ...canaryRows(s), pauseRow(s), heldRow(s), queueRow(s), ...rollbackRows(s)].filter(Boolean);
  return { name: s.name, head, rows };
}

/** The whole tab as words. */
export function stagesView(a, now = new Date()) {
  const legend = stagesLegend(a, now);
  if (!a || a.error || a.refusal || a.workspace === false) return { legend, notes: [], members: [] };
  const notes = [];
  for (const u of a.queuesUnread || []) notes.push(`queue for ${u.stage} not read: ${u.refusal.error}`);
  const others = a.others || [];
  if (others.length) notes.push(`${others.map((o) => o.member).join(", ")}: chant lists stages for a member with a .chant/pipeline.ts that folds`);
  const members = (a.members || []).map((m) => ({ member: m.member, kind: m.kind, head: `${m.member}${m.kind ? ` (${m.kind})` : ""} · pipeline ${m.pipeline}`, stages: m.stages.map(stageCard) }));
  return { legend, notes, members };
}

const TONE_CLASS = { wait: "stage-wait", fail: "stage-fail", ok: "stage-ok", quiet: "stage-quiet", plain: "" };

/** Draw the tab into `host`. `ui.copy` copies a line, when the page has it. */
export function renderStages(host, a, now, ui) {
  host.replaceChildren();
  const v = stagesView(a, now);
  const el = (tag, cls, text, title) => {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined) d.textContent = text;
    if (title) d.title = title;
    return d;
  };
  host.appendChild(el("div", v.legend.tone === "refusal" ? "tg-refusal" : "tg-legend", v.legend.text, v.legend.title));
  for (const n of v.notes) host.appendChild(el("div", "tg-legend", n));
  const command = (line) => {
    const c = el("div", "stage-command", line, "chant's line, to copy. behold runs none of it.");
    if (ui && ui.copy) c.addEventListener("click", () => ui.copy(line));
    return c;
  };
  for (const m of v.members) {
    const h = el("h3", "", m.head);
    host.appendChild(h);
    for (const s of m.stages) {
      const card = el("div", "stage-card");
      card.dataset.member = m.member;
      card.dataset.stage = s.name;
      card.appendChild(el("div", "stage-head", s.head));
      for (const r of s.rows) {
        const row = el("div", `stage-row ${TONE_CLASS[r.tone] ?? ""}`.trim(), r.text, r.title);
        row.dataset.row = r.key;
        card.appendChild(row);
        for (const why of r.reasons || []) card.appendChild(el("div", "stage-reason", why));
        if (r.command) card.appendChild(command(r.command));
        for (const c of r.commands || []) card.appendChild(command(c));
      }
      host.appendChild(card);
    }
  }
}
