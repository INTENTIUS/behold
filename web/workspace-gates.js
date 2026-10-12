// #477: a declared workspace's waiting gates, as cards. Pure: app.js fetches
// /api/workspace/gates and paints what gateCards returns.
//
// One approve path per gate. Framed in a host (#476), behold draws the gate
// and no button: the host knows who is looking and records it. Standalone, the
// button stays, and the card says the approval is recorded as the user running
// behold, since behold has no other identity to give chant.

/** The words a framed card uses instead of a button. */
export const HOST_APPROVES = "approve in the host that framed this graph";

/**
 * Cards for a gates answer. `embed` is whether behold is framed; `member`
 * narrows to one member's gates when a host opened behold on it (the rest are
 * counted, not hidden without a word).
 */
export function gateCards(answer, { embed = false, member = null } = {}) {
  const all = (answer && answer.gates) || [];
  const shown = member ? all.filter((g) => g.member === member) : all;
  const cards = shown.map((g) => {
    if (g.override) return overrideCard(g);
    const facts = [`${g.approvals.length} of ${g.needed} approval${g.needed === 1 ? "" : "s"}`];
    if (g.env) facts.push(`env ${g.env}`);
    if (g.planDigest) facts.push(`plan ${shortDigest(g.planDigest)}`);
    if (g.approvals.length) facts.push(`approved by ${g.approvals.map((a) => a.principal).join(", ")}`);
    const card = {
      key: g.key,
      member: g.member,
      title: `${g.member}: ${g.op} waits at gate ${g.gate}`,
      facts: facts.join(" · "),
      command: g.approve,
    };
    if (embed) card.note = HOST_APPROVES;
    else if (g.signed) card.note = `wants a signed approval; run ${g.approve}`;
    else card.button = { label: `Approve as ${answer.approver || "you"}`, title: `${g.approve}, run by behold. chant records the approval as ${answer.approver || "the user running behold"}.` };
    return card;
  });
  const elsewhere = all.length - shown.length;
  return { cards, elsewhere, refusal: (answer && answer.refusal) || null };
}

/**
 * #519: a policy denial. chant's override needs the denied rules and a
 * person's reason, so the card shows them and the command to run, and never a
 * button, framed or not. An override that counts reads as overridden until a
 * run applies it, then as spent.
 */
export function overrideCard(g) {
  const o = g.override;
  const facts = [];
  facts.push(o.rules.length ? `denied by ${o.rules.join(", ")}` : "denied by rules the ledger did not name");
  if (o.plan) facts.push(`plan ${shortDigest(o.plan)}`);
  if (o.digest) facts.push(`override digest ${shortDigest(o.digest)}`);
  if (g.recordedAt) facts.push(`denied ${g.recordedAt}`);
  if (o.source) facts.push(`from ${o.source}`);
  const card = { key: g.key, member: g.member, facts: facts.join(" · "), command: o.command, override: o.state };
  if (o.state === "spent") {
    card.title = `${g.member}: the override of ${o.subject} is spent`;
    card.note = `a run applied under it${o.spentAt ? ` at ${o.spentAt}` : ""}; a new denial needs a new override`;
  } else if (o.state === "overridden") {
    card.title = `${g.member}: ${o.subject} is overridden`;
    card.note = "an override counts for this plan; the next run applies it once";
  } else {
    card.title = `${g.member}: the policy denied ${o.subject}`;
    card.note = `a reason is required. Override it at your shell: ${o.command}`;
  }
  return card;
}

function shortDigest(d) {
  const s = String(d).replace(/^sha256:/, "");
  return s.length > 12 ? s.slice(0, 12) : s;
}
