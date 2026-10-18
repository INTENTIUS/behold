// #683: feature flags on the graph. Pure words and colours from
// /api/workspace/flags; app.js draws them.
//
// A flag is a workspace record chant reads as one build parameter of one
// member (chant#4024). chant names no graph node that reads a parameter, so a
// flag marks every card of its member, with a tag under the card in the
// environment the tab picks: on in the managed green, off or unset in the
// neutral grey, any other value in the pending blue. A flag the stale-flag
// lint reports (WSP118) says so on the tag and in the tab. The tag sits under
// the card, clear of the change set's tag above it, and the fill stays the
// live-status channel.
//
// behold changes no flag. A flip waiting at a gate opens that gate's change
// set (#681); otherwise the tab shows the lines a person runs.

const short = (s) => (s ? String(s).replace(/^(jcs1-)?sha256:/, "").slice(0, 12) : "");
const sha7 = (s) => (s ? String(s).slice(0, 7) : "");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The colour each state is drawn in. */
export const STATE_COLORS = { on: "var(--managed)", off: "var(--neutral)", default: "var(--neutral)", set: "var(--pending)" };
/** The colour of the stale mark. */
export const STALE_COLOR = "var(--degraded)";

/** The note on how cards are tied to flags. */
export const NODES_NOTE = "chant does not say which resources read a build parameter, so each flag marks every card of its member.";
/** The note under the lines that turn a flag on. */
export const TURN_ON_NOTE = "behold does not change flags. Once this commit is green, a release cut from it and promoted to the environment waits at its gate, and its change set opens here.";
/** The words for a flag the stale-flag lint reports. */
export const STALE_WORDS = "due for removal (WSP118)";

/** A value in words: on, off, unset, or the value. */
export function stateWords(e) {
  if (!e) return "unset";
  if (e.state === "on") return "on";
  if (e.state === "off") return "off";
  if (e.state === "default") return "unset";
  return JSON.stringify(e.value);
}

/** The tab's first line: what was read, or why it wasn't. */
export function flagsHeader(a) {
  if (!a || a.error) return { text: `flags not read${a && a.error ? `: ${a.error}` : ""}`, title: "", tone: "refusal" };
  if (a.refusal) return { text: `flags not read: ${a.refusal.error}`, title: [a.refusal.remedy, a.degraded ? `Without it, ${a.degraded}.` : ""].filter(Boolean).join("\n"), tone: "refusal" };
  const stale = a.flags.filter((f) => f.stale).length;
  return { text: `${plural(a.flags.length, "flag")}${stale ? `, ${stale} ${STALE_WORDS}` : ""}`, title: NODES_NOTE, tone: "quiet" };
}

/** The environment to draw: `want` when the answer has it, else the first. */
export function pickEnv(a, want) {
  const envs = (a && a.environments) || [];
  return envs.includes(want) ? want : envs[0] || null;
}

/** One flag's row in the tab. `env` is the environment the graph draws. */
export function flagRow(f, env) {
  const facts = [`param ${f.param}`, `owner ${f.owner || "none"}`, f.work ? `work ${f.work.id}${f.work.state ? ` (${f.work.state})` : ""}` : "no work item"];
  const values = Object.entries(f.envs).map(([e, v]) => ({ env: e, text: `${e} ${stateWords(v)}`, color: STATE_COLORS[v.state] || "var(--muted)", current: e === env }));
  const waiting = f.waiting.map((w) => ({
    env: w.env,
    gate: w.gate,
    text: `${f.param} ${JSON.stringify(w.before)} to ${JSON.stringify(w.after)} waits at gate ${w.gate} in ${w.env}`,
    link: `change set ${short(w.changeSet)}`,
    title: [
      `Draw this change set on the graph, as a preview.`,
      w.gitSha ? `commit ${sha7(w.gitSha)}` : "",
      w.releaseDigest ? `release ${short(w.releaseDigest)}` : "",
      ...w.entries.map((e) => `${e.address}${e.node ? ` on ${e.node}` : ", on no graph node"}`),
    ]
      .filter(Boolean)
      .join("\n"),
  }));
  const turnOn = f.turnOn.map((t) => ({ env: t.env, head: `To turn it on in ${t.env}:`, lines: t.lines }));
  return {
    key: f.key,
    title: f.key,
    stale: f.stale ? { text: STALE_WORDS, title: staleTitle(f) } : null,
    facts: facts.join(" · "),
    path: f.path,
    values,
    waiting,
    turnOn,
  };
}

/** Why a stale flag is due for removal, from the decisions its work item implements. */
export function staleTitle(f) {
  const ds = (f.implements || []).map((d) => `${d.id} (${d.state || "unknown"})`).join(", ");
  return `The stale-flag lint (chant workspace check, WSP118) reports it: ${f.work ? `its work item ${f.work.id}` : "its work item"} implements ${ds || "no decision"}, and every one is confirmed. Remove the record and the parameter it backs.`;
}

/**
 * The marks to draw in `env`: per node id in `ids`, a colour, a tag and a
 * tooltip, for every card whose member has a flag. `memberOf(id)` gives a
 * card's member.
 */
export function flagMarks(a, env, ids, memberOf) {
  const out = {};
  if (!a || a.error || a.refusal || !a.flags || !env) return out;
  const byMember = new Map();
  for (const f of a.flags) {
    if (!byMember.has(f.member)) byMember.set(f.member, []);
    byMember.get(f.member).push(f);
  }
  for (const id of ids) {
    const flags = byMember.get(memberOf(id));
    if (!flags || !flags.length) continue;
    const on = flags.filter((f) => f.envs[env] && f.envs[env].state === "on").length;
    const stale = flags.filter((f) => f.stale).length;
    let tag;
    if (flags.length === 1) {
      const f = flags[0];
      tag = `${f.id}: ${stateWords(f.envs[env])}${f.stale ? ", stale" : ""}`;
    } else {
      tag = `${plural(flags.length, "flag")}: ${on} on${stale ? `, ${stale} stale` : ""}`;
    }
    const lines = flags.map((f) => `${f.id} (${f.param}): ${stateWords(f.envs[env])} in ${env}${f.stale ? `, ${STALE_WORDS}` : ""}`);
    out[id] = {
      color: on ? STATE_COLORS.on : flags.some((f) => f.envs[env] && f.envs[env].state === "set") ? STATE_COLORS.set : STATE_COLORS.off,
      stale: stale > 0,
      tag,
      title: [`feature flags of ${memberOf(id)} in ${env}:`, ...lines, "", NODES_NOTE].join("\n"),
    };
  }
  return out;
}

/** The flags of one card's member, for the inspect pane. */
export function flagsFor(a, member, env) {
  if (!a || a.error || a.refusal || !a.flags || !env) return [];
  return a.flags
    .filter((f) => f.member === member)
    .map((f) => ({ text: `${f.id}: ${stateWords(f.envs[env])} in ${env}${f.stale ? `, ${STALE_WORDS}` : ""}`, color: STATE_COLORS[(f.envs[env] || {}).state] || "var(--muted)", title: flagRow(f, env).facts }));
}

/** The lines that say what the answer leaves out: members whose flags could not be read, and reads that failed. */
export function gapLines(a) {
  if (!a || a.error || a.refusal) return [];
  return [
    ...(a.unreadable || []).map((m) => ({ text: `chant could not read the flag records of ${m}`, title: "Run chant workspace records in the workspace root to see why." })),
    ...(a.refusals || []).map((r) => ({ text: r.gate ? `the change set of ${r.gate} in ${r.env} was not read: ${r.error}` : `${r.env} was not read: ${r.error}`, title: r.remedy || "" })),
  ];
}
