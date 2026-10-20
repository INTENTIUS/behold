// #477: a declared workspace's waiting gates, as cards. Pure: app.js fetches
// /api/workspace/gates and paints what gateCards returns.
//
// One approve path per gate. Framed in a host (#476), behold draws the gate
// and no button: the host knows who is looking and records it. Standalone, the
// button stays, and its label names who chant records the approval as (#690):
// the person behold's proxy signed in, the one `--as` names, or else the user
// running behold. A gate that needs a signed approval gets a button only when
// behold holds that person's key.

import { HOST_ANSWERS, loosePointTitle, placePoints, pointLines } from "./decision-points.js";

/** Where the approver's name came from, in the words a button's tooltip uses. */
const SOURCE_WORDS = {
  header: "from your sign-in",
  configured: "set when behold started",
  process: "the user running behold",
};

/** The words a framed card uses instead of a button. */
export const HOST_APPROVES = "approve in the host that framed this graph";

/**
 * Cards for a gates answer. `embed` is whether behold is framed; `member`
 * narrows to one member's gates when a host opened behold on it (the rest are
 * counted, not hidden without a word). `points` is the points answer (#472):
 * each open question is drawn on the card of the gate that waits on it, and
 * one no waiting gate names gets a card of its own after the gates.
 */
export function gateCards(answer, { embed = false, member = null, points = null } = {}) {
  const all = (answer && answer.gates) || [];
  const shown = member ? all.filter((g) => g.member === member) : all;
  const { byGate, loose } = placePoints((points && points.points) || [], all);
  const cards = shown.map((g) => {
    const card = gateCard(g, answer, embed);
    const asks = byGate.get(g.key);
    if (asks) card.points = asks.map((p) => pointLines(p, { embed }));
    return card;
  });
  for (const p of loose) cards.push({ key: `point/${p.id}`, member: null, ...pointLines(p, { embed }), title: loosePointTitle(p), point: true });
  const elsewhere = all.length - shown.length;
  return { cards, elsewhere, refusal: (answer && answer.refusal) || null, pointsRefusal: (points && points.refusal) || null };
}

function gateCard(g, answer, embed) {
  if (g.override) return overrideCard(g);
  // #472: a gate that asks a decision point counts no approvals; its point's quorum decides.
  const facts = g.answer ? [] : [`${g.approvals.length} of ${g.needed} approval${g.needed === 1 ? "" : "s"}`];
  if (g.env) facts.push(`env ${g.env}`);
  if (g.planDigest) facts.push(`plan ${shortDigest(g.planDigest)}`);
  if (g.approvals.length) facts.push(`approved by ${g.approvals.map((a) => a.principal).join(", ")}`);
  const card = {
    key: g.key,
    member: g.member,
    title: g.answer ? `${g.member}: ${g.op} waits at gate ${g.gate} on decision point ${g.answer.point}` : `${g.member}: ${g.op} waits at gate ${g.gate}`,
    facts: facts.join(" · "),
    command: g.approve,
  };
  if (embed) card.note = g.answer ? HOST_ANSWERS : HOST_APPROVES;
  else Object.assign(card, approveAffordance(g, answer));
  return card;
}

/**
 * #690: the button, or the note in its place, for a standalone card. The label
 * says who the approval is recorded as before the click. A gate that waits on
 * a decision point gets no button (#472): `chant approve` refuses it, and the
 * question is answered elsewhere.
 */
export function approveAffordance(g, answer) {
  if (g.answer) return { note: `waits on decision point ${g.answer.point}, which behold doesn't answer. Run ${g.approve}` };
  const refusal = answer && answer.approverRefusal;
  if (refusal) return { note: `can't approve here: ${refusal.error}. Run ${g.approve}` };
  const id = (answer && answer.approverIdentity) || null;
  const who = (answer && answer.approver) || "you";
  const from = SOURCE_WORDS[id ? id.source : "process"] || SOURCE_WORDS.process;
  if (g.signed) {
    if (!id || !id.signs) return { note: `needs a signed approval, and behold has no key for ${who}. Run ${g.approve}` };
    return { button: { label: `Approve as ${who}, signed`, title: `behold runs ${g.approve} with ${who}'s key. chant records ${who}, ${from}.` } };
  }
  return { button: { label: `Approve as ${who}`, title: `behold runs ${g.approve}. chant records ${who}, ${from}.` } };
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
