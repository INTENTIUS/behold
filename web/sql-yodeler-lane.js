// #524: a SQL Yodeler repo's lane, from /api/sql-yodeler/lifecycle. One row
// per environment in the order of applies (yodel-waves.json), each with its
// wave's gate and its migrations op's gate: the state, the plan digest, who
// approved and how, and the chant/lifecycle commit it was read from. A
// waiting gate offers `npx yodel approve <env> --plan <digest>` to copy;
// nothing here approves.

import { ago, clock } from "./terragucci.js";
import { laneLegend, modeWords, sourceWords } from "./terragucci-lifecycle.js";

const short = (s) => (s ? String(s).replace(/^(jcs1-)?sha256:/, "").slice(0, 12) : "");

const STATE_WORDS = {
  waiting: "waits for an approval",
  expired: "asked for an approval that expired",
  approved: "approved, not applied yet",
  applied: "applied",
  failed: "apply failed",
  refused: "refused: an approval stands for another plan",
  "refused-by-policy": "refused by policy, no override counts",
  held: "held on another gate",
};

/** The line over the lane: what was read, how, when, and where the order came from. */
export function yodelLegend(answer, now = new Date()) {
  const lg = laneLegend(answer, now);
  if (!answer || answer.error) return lg;
  const order = answer.order && answer.order.source === "yodel-waves.json" ? "environments in yodel-waves.json's order" : answer.order && answer.order.source === "ops" ? "environments from ops/migrate-<env>.op.ts (no yodel-waves.json)" : "no environments declared";
  const member = answer.member && answer.member.members.length ? ` · workspace member ${answer.member.members.join(" / ")}, read under ${answer.member.prefix}` : "";
  return { ...lg, text: `${lg.text} · ${order}${member}`, title: [lg.title, answer.order && answer.order.error ? `yodel-waves.json: ${answer.order.error}` : "", answer.member && answer.member.error ? answer.member.error : ""].filter(Boolean).join("\n") };
}

/** One gate as a card: title, facts, source, and the line to copy when it waits. Pure. */
export function yodelGateCard(env, g, now = new Date()) {
  const what = g.kind === "wave" ? `wave ${g.wave} (${g.gate})` : `${g.op} (${g.gate})`;
  const facts = [];
  if (g.pending) facts.push(`asked ${clock(g.pending.timestamp, now)}, ${ago(g.pending.timestamp, now)}`);
  if (g.approval) {
    const how = [g.approval.signed ? "signed" : "unsigned", g.approval.via ? `via ${g.approval.via}` : "", g.approval.pr !== undefined ? `PR #${g.approval.pr}` : "", g.approval.relayedBy ? `relayed by ${g.approval.relayedBy}` : ""].filter(Boolean).join(", ");
    facts.push(`approved by ${g.approval.by} (${how}) ${clock(g.approval.at, now)}, ${ago(g.approval.at, now)}`);
  }
  if (g.applied) facts.push(`applied ${clock(g.applied.at, now)}, ${ago(g.applied.at, now)}${g.applied.result ? "" : " (outcome not recorded)"}`);
  if (g.digest) facts.push(`plan ${short(g.digest)}`);
  for (const u of g.uncounted || []) facts.push(`${u.approval.by}'s approval does not count: ${u.reason}`);
  if (g.heldOn) facts.push(`held on ${g.heldOn.op}/${g.heldOn.gate}`);
  if (modeWords(g)) facts.push(modeWords(g));
  if ((g.headPlans || []).length) {
    const h = g.headPlans[0];
    facts.push(`pull request head ${h.head.slice(0, 12)} recorded this plan ${clock(h.timestamp, now)}, ${ago(h.timestamp, now)} (${h.path}): a writer's approving review of that head, merged, approves it${g.headPlans.length > 1 ? `; ${g.headPlans.length - 1} more head${g.headPlans.length > 2 ? "s" : ""} recorded it too` : ""}`);
  }
  return {
    env,
    kind: g.kind,
    state: g.state,
    tone: g.state === "waiting" || g.state === "held" ? "wave" : g.state === "failed" || g.state === "refused" || g.state === "refused-by-policy" ? "failed" : g.state === "expired" ? "none" : "ok",
    title: `${env}: ${what} ${STATE_WORDS[g.state] || g.state}`,
    facts: facts.join(" · "),
    source: sourceWords(g.source, now),
    ...(g.command ? { command: g.command } : {}),
    ...(g.pending && g.pending.url ? { job: g.pending.url } : {}),
  };
}

/** Every environment's rows, in the order of applies. An environment with no gate on the ledger says so. Pure. */
export function yodelRows(answer, now = new Date()) {
  if (!answer || answer.error || !answer.found) return [];
  const rows = [];
  for (const e of answer.environments || []) {
    const head = e.wave ? `${e.env}: wave ${e.wave.k}${e.wave.gate ? `, gate ${e.wave.gate}` : ""}${e.wave.approval ? `, approval ${e.wave.approval}` : ""}${e.wave.targets.length > 1 || e.wave.targets[0] !== e.env ? `, ${e.wave.targets.join(", ")}` : ""}` : `${e.env}: in no wave`;
    rows.push({ env: e.env, head, cards: e.gates.map((g) => yodelGateCard(e.env, g, now)) });
  }
  if ((answer.unplaced || []).length) rows.push({ env: "", head: "waves yodel-waves.json does not name", cards: answer.unplaced.map((g) => yodelGateCard(`wave ${g.wave}`, g, now)) });
  return rows;
}

const APPROVE_NOTE = "An approval is a git record bound to this plan digest: run the line at your shell. behold does not approve.";

/** The lane as DOM. `ui` lends app.js's `button`, `copy` and `link`; a Copy button is the only control. */
export function renderYodelLane(host, answer, now, ui) {
  const lg = yodelLegend(answer, now);
  const head = document.createElement("div");
  head.className = lg.tone === "refusal" ? "tg-refusal" : "tg-legend";
  head.textContent = lg.text;
  head.title = lg.title || "";
  host.appendChild(head);
  for (const r of yodelRows(answer, now)) {
    const h = document.createElement("h3");
    h.textContent = r.head;
    host.appendChild(h);
    if (!r.cards.length) {
      const none = document.createElement("div");
      none.className = "tg-legend";
      none.textContent = "no gate on chant/lifecycle yet";
      host.appendChild(none);
    }
    for (const c of r.cards) {
      const box = document.createElement("div");
      box.className = `ws-gate tg-lane-gate tg-${c.tone}`;
      const title = document.createElement("div");
      title.className = "ws-gate-title";
      title.textContent = c.title;
      const facts = document.createElement("div");
      facts.className = "ws-gate-facts";
      facts.textContent = c.facts;
      const src = document.createElement("div");
      src.className = "ws-gate-note";
      src.textContent = `from ${c.source}`;
      box.append(title, facts, src);
      if (c.command) {
        const cmd = document.createElement("code");
        cmd.className = "tg-command";
        cmd.textContent = c.command;
        const copy = ui.button("Copy", "", () => ui.copy(c.command, copy));
        copy.title = "Copy the line. Run it at your shell: the approval is yours.";
        const note = document.createElement("div");
        note.className = "ws-gate-note";
        note.textContent = APPROVE_NOTE;
        box.append(cmd, copy, note);
      }
      if (c.job) {
        const links = document.createElement("div");
        links.className = "ws-gate-note";
        links.appendChild(ui.link("job", c.job));
        box.appendChild(links);
      }
      host.appendChild(box);
    }
  }
}
