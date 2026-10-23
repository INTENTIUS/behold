// #914: an agent moved the open tab (POST /api/view, the `view` event on
// /api/events). Pure logic, no DOM: the banner's words and the history entry
// a move makes. app.js `agentMove` does the moving.

/** How many agent moves in a row get their own history entry. Past it, a move
 * replaces the newest agent entry instead of pushing, so Back still reaches
 * the person's own view after at most this many steps. */
export const AGENT_STACK_MAX = 20;

/**
 * The history entry an agent move makes. `state` is history.state of the entry
 * being left; a move pushes a new entry with `beholdMove` on it, numbered by
 * how many agent moves in a row it is. At AGENT_STACK_MAX it replaces instead.
 */
export function agentEntry(state, move, max = AGENT_STACK_MAX) {
  const before = state && typeof state === "object" ? state : {};
  const prev = (before.beholdMove && Number(before.beholdMove.depth)) || 0;
  const push = prev < max;
  return { push, state: { ...before, beholdMove: { ...move, depth: push ? prev + 1 : prev } } };
}

/** What clears each key of a question: q, its grouping and its plan depth. */
export const QUESTION_KEYS = Object.freeze({ q: null, countBy: null, plan: false });

/**
 * An agent's move that asks a question (it carries q or countBy) asks it
 * whole: a question key it leaves out, and the tab still holds, is cleared
 * rather than kept from the view the tab was on. Found in #908's stage 3 run:
 * step 3's countBy=module stayed on step 4's `cap:` query, so the tab showed
 * chant's refusal while the agent's answer was right. env and the rest stay:
 * they are where the tab is, not what it asks.
 */
export function wholeQuestion(want, current) {
  if (!want || !("q" in want || "countBy" in want)) return want;
  const out = { ...want };
  for (const [k, clear] of Object.entries(QUESTION_KEYS)) if (!(k in out) && current && current[k]) out[k] = clear;
  return out;
}

/** HH:MM:SS in the viewer's clock, or "" for a date that isn't one. */
export function clockTime(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * The banner's line: "Moved by an agent: <by> asked `<q>` at 14:02:11
 * (request 7f3a)." Without a question it says what moved it and when. The
 * label is the caller's own claim (`by`), never checked.
 */
export function agentBanner(move, at) {
  const m = move || {};
  const by = typeof m.by === "string" && m.by ? m.by : "an agent";
  const q = typeof m.q === "string" && m.q ? m.q : "";
  const when = clockTime(at);
  const id = typeof m.id === "string" && m.id ? ` (request ${m.id})` : "";
  const asked = q ? ` asked \`${q.length > 120 ? q.slice(0, 120) + "..." : q}\`` : " moved this view";
  return { text: `Moved by an agent: ${by}${asked}${when ? ` at ${when}` : ""}${id}.` };
}
