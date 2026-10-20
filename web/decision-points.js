// #472: a workspace's open decision points, drawn where they belong. Pure:
// app.js fetches /api/workspace/points beside /api/workspace/gates and paints
// what these return.
//
// A gate that asks a decision point (chant#3170) names its open question as
// `answer.id`, and the point read lists the same id, so the question is drawn
// on that gate's card. A question no waiting gate names gets a card of its own
// in the gate strip. behold answers none of them: framed, the host's rail does
// (arugula-salad/arugula#621); standalone, the card gives chant's line to run.

/** The words a framed point card uses where a standalone one gives the line. */
export const HOST_ANSWERS = "answer it in the rail of the host that framed this graph";
/** The words a standalone point card puts before chant's line. */
export const STANDALONE_ANSWERS = "behold doesn't answer decision points. Answer it at the workspace root:";

/** Who may answer, in words: `2 people holding maintainer`. */
export function whoAnswers(quorum) {
  const count = (quorum && quorum.count) || 1;
  const roles = (quorum && quorum.roles) || [];
  return `${count} ${count === 1 ? "person" : "people"}${roles.length ? ` holding ${roles.join(" or ")}` : ""}`;
}

const shown = (v) => (typeof v === "boolean" ? (v ? "yes" : "no") : String(v));

/** One point as the lines a card draws: the question, who may answer, the facts, and how to answer it elsewhere. */
export function pointLines(p, { embed = false } = {}) {
  const facts = [];
  if (p.candidates && p.candidates.length) facts.push(`answers: ${p.candidates.map(shown).join(", ")}`);
  facts.push(`${whoAnswers(p.quorum)} may answer`);
  if (p.state === "proposed" && p.model) facts.push(`a model proposes ${shown(p.model.answer)}${p.model.confidence !== null ? ` (${Math.round(p.model.confidence * 100)}%)` : ""}, waiting for a person to confirm it`);
  else if (p.model && p.model.answer !== null) facts.push(`a model answered ${shown(p.model.answer)} below its threshold`);
  if (p.askedBy) facts.push(`asked by steward ${p.askedBy}`);
  if (p.askedOn) facts.push(`asked ${p.askedOn}`);
  if (p.stale) facts.push("the point changed since it was asked");
  return {
    id: p.id,
    title: `decision point ${p.point}: ${p.title}`,
    question: p.question,
    facts: facts.join(" · "),
    command: p.command,
    // Standalone, the card shows `command` after the note, as text to copy.
    note: embed ? HOST_ANSWERS : STANDALONE_ANSWERS,
    showCommand: !embed,
  };
}

/**
 * Place each open point: on the card of the waiting gate whose `answer.id`
 * names it (`byGate`, by gate key), or on its own (`loose`). `gates` is the
 * gates answer's list, `points` the points answer's.
 */
export function placePoints(points, gates) {
  const byId = new Map();
  for (const g of gates || []) if (g.answer && g.answer.id) byId.set(g.answer.id, g.key);
  const byGate = new Map();
  const loose = [];
  for (const p of points || []) {
    const key = byId.get(p.id);
    if (key) byGate.set(key, [...(byGate.get(key) || []), p]);
    else loose.push(p);
  }
  return { byGate, loose };
}

/** The title of a point card that no waiting gate here names. */
export function loosePointTitle(p) {
  const lines = pointLines(p);
  if (!p.gate) return lines.title;
  return `${lines.title} (asked by gate ${p.gate.op}/${p.gate.gate}${p.gate.env ? ` in ${p.gate.env}` : ""})`;
}
