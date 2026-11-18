/**
 * behold#1163: the ask demo page's pure half. The page (./main.js) plays
 * ask-demo/narration.json in loops: the load turn, then one question, and the
 * next loop takes the next question. Each loop is one step for the kiosk's
 * prompt pane (web/kiosk-ask.js), whose beats carry their turn so the page
 * can light the graph and fill the /graph pane when a beat's reply starts.
 *
 * Nothing here touches the page; ./play.test.js tests it.
 */
import { BEAT_GAP_MS, playback } from "../../web/kiosk-ask.js";

export const NARRATION_FORMAT = "behold-ask-demo-narration/1";
/** About how long a loop takes, words and pause together. */
export const LOOP_MS = 60_000;
/** The shortest pause after a loop's last reply, however long its words took. */
export const MIN_DWELL_MS = 12_000;
/** Under reduced motion the words show at once: how long the load turn stays alone before the question shows. */
export const REDUCED_READ_MS = 8_000;
/** The command that records the narration again, when the file does not name one. */
export const RECORD_COMMAND = "just ask-demo-record";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** What is wrong with a narration for this page, or an empty list. The schema (ask-demo/narration.schema.json) says more; the page checks what it plays. */
export function narrationProblems(n) {
  const out = [];
  if (!n || typeof n !== "object") return ["the narration is not a JSON object"];
  if (n.format !== NARRATION_FORMAT) out.push(`format is ${JSON.stringify(n.format)}, not ${NARRATION_FORMAT}`);
  if (typeof n.recordedAt !== "string" || !Number.isFinite(Date.parse(n.recordedAt))) out.push("recordedAt is not a timestamp");
  const turns = Array.isArray(n.turns) ? n.turns : [];
  if (!turns.length || turns[0].kind !== "load") out.push("the first turn is not the load turn");
  if (!turns.slice(1).some((t) => t && t.kind === "question")) out.push("there is no question turn");
  for (const t of turns) {
    if (!t || typeof t.prompt !== "string" || typeof t.reply !== "string" || typeof t.busy !== "string") out.push(`turn ${t && t.id} lacks a prompt, a busy line or a reply`);
  }
  return out;
}

export const questionsOf = (n) => n.turns.filter((t) => t.kind === "question");

/** A turn as one beat of the prompt pane: the prompt typed, the busy line, the reply. The turn rides along for the page. */
export const beatOf = (turn) => ({ prompt: turn.prompt, status: turn.busy, reply: turn.reply, turn });

/**
 * Loop `i`: the load turn, then question `i` (counting round). `steps` are
 * the two steps the prompt pane takes, one per turn: their own cycle each
 * loop, so the pane starts clean, and one scenario, so the question follows
 * the load turn in one transcript.
 */
export function loopOf(n, i) {
  const qs = questionsOf(n);
  const index = ((i % qs.length) + qs.length) % qs.length;
  const load = n.turns[0];
  const question = qs[index];
  const step = (turn) => ({ cycle: `loop-${i}`, scenario: "ask-demo", step: turn.id, asks: [beatOf(turn)] });
  return { loop: i, index, of: qs.length, load, question, steps: [step(load), step(question)] };
}

/**
 * A loop's clock, in ms from its start: when the question's step is given
 * to the pane (`questionAt`: after the load turn and the pane's gap between
 * beats, or, under reduced motion where words show at once, after
 * {@link REDUCED_READ_MS}), when its words are done (`playMs`), and the pause
 * after them, so a loop takes about {@link LOOP_MS}.
 */
export function loopTiming(loop, { reduced = false } = {}) {
  const loadMs = playback(loop.steps[0].asks, 0, { reduced }).end;
  const questionAt = reduced ? REDUCED_READ_MS : loadMs + BEAT_GAP_MS;
  const playMs = questionAt + playback(loop.steps[1].asks, 0, { reduced }).end;
  const dwellMs = Math.max(MIN_DWELL_MS, LOOP_MS - playMs);
  return { questionAt, playMs, dwellMs, totalMs: playMs + dwellMs };
}

/** What the /graph pane's boxes show for a turn: its Cypher and parameters, and the call the agent made. */
export function cypherFill(turn) {
  const params = turn && turn.params && typeof turn.params === "object" ? turn.params : {};
  return {
    cypher: turn && typeof turn.cypher === "string" ? turn.cypher : "",
    params: Object.keys(params).length ? JSON.stringify(params) : "",
    call: callLine(turn),
  };
}

/**
 * The call a turn made: the commands that loaded the estate, one per line, or
 * the ask tool's arguments. A Cypher call's query is the one in the box, so
 * the line says so rather than repeat it; a template call names the resource
 * and template, which behold expanded to that query.
 */
export function callLine(turn) {
  const call = turn && turn.call;
  if (!call) return "";
  if (Array.isArray(call.commands)) return call.commands.map((c) => `$ ${c}`).join("\n");
  const args = call.arguments || {};
  const rest = Object.entries(args)
    .filter(([k]) => k !== "cypher")
    .map(([k, v]) => `${k}=${v}`);
  if (typeof args.cypher === "string") return [`${call.tool || "ask"} cypher=<the query below>`, ...rest].join(" ");
  return `${[call.tool || "ask", ...rest].join(" ")} (behold ran it as the query below)`;
}

/** When each source was read, one line each: a declared source reads no cloud, so it has no observed time. */
export function sourceWords(sources) {
  return (sources || []).map((s) => {
    const size = Number.isInteger(s.nodes) ? `, ${s.nodes} nodes${Number.isInteger(s.edges) ? `, ${s.edges} edges` : ""}` : "";
    const seen = s.observedAt ? `observed ${s.observedAt}` : "declared, not observed";
    return `${s.scopeKey} (${s.name}): ${seen}; read ${s.readAt}${size}`;
  });
}

/**
 * A turn's recorded answer, shaped as GET /api/graphdb/query answers (what
 * the /graph pane shows). A turn the recorder kept no drawing for draws its
 * keys alone, each named by its last segment, with no edges.
 */
export function recordedAnswer(turn) {
  const keys = Array.isArray(turn.keys) ? turn.keys : [];
  const draw = turn.draw && Array.isArray(turn.draw.nodes) ? turn.draw : { nodes: keys.map((key) => ({ key, kind: "", name: key.split("/").pop() || key, source: "", scopeKey: "" })), edges: [] };
  return { status: 200, body: { columns: turn.columns || [], rows: turn.rows || [], keys, draw, sources: turn.sources || [] } };
}

/** The keys a turn's answer drawing lights: each of its keys the drawing has. */
export function drawLight(answerBody) {
  const keys = new Set((answerBody && answerBody.keys) || []);
  const nodes = (answerBody && answerBody.draw && answerBody.draw.nodes) || [];
  return nodes.map((x) => x.key).filter((k) => keys.has(k));
}

/** `2026-11-18T16:56:39Z` as `18 November 2026` (UTC). */
export function recordedDate(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The words the page says about where the answers come from: never that they are live. */
export function recordedWords(n) {
  return {
    line: `Recorded ${recordedDate(n.recordedAt)} from a real run on emulators. Every answer is behold's, replayed as it came back.`,
    command: typeof n.recordCommand === "string" && n.recordCommand ? n.recordCommand : RECORD_COMMAND,
    versions: Object.entries(n.versions || {})
      .map(([k, v]) => `${k} ${v}`)
      .join(", "),
  };
}

/** The visitor's parameters box as an object: empty is none; anything else must be a JSON object. */
export function parseParams(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: true, params: undefined };
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "Parameters are a JSON object." };
    return { ok: true, params: v };
  } catch {
    return { ok: false, error: "Parameters are a JSON object." };
  }
}

// --- The visitor's zoom (behold#1175) ---------------------------------------

/** How far in a visitor can zoom: the view's larger side no smaller than 1/MAX_ZOOM of the full graph's. */
export const MAX_ZOOM = 8;

/** `view` moved back inside `full` where it fits, and centred on `full` along a side where it is larger. */
export function keepInside(view, full) {
  const side = (s, size, lo, span) => (size >= span ? lo + (span - size) / 2 : Math.max(lo, Math.min(s, lo + span - size)));
  return { x: side(view.x, view.width, full.x, full.width), y: side(view.y, view.height, full.y, full.height), width: view.width, height: view.height };
}

/**
 * `view` zoomed by `factor` (above 1 zooms in) about the point `at`, in the
 * graph's units, which stays where it is on screen. The zoom stops at the
 * full graph on the way out and at MAX_ZOOM on the way in, and the view
 * stays inside the graph.
 */
export function zoomView(view, full, factor, at = { x: view.x + view.width / 2, y: view.y + view.height / 2 }) {
  const share = Math.max(view.width / full.width, view.height / full.height);
  const next = Math.min(1, Math.max(1 / MAX_ZOOM, share / factor));
  const k = next / share;
  const width = view.width * k;
  const height = view.height * k;
  return keepInside({ x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k, width, height }, full);
}

/** `view` moved by `dx`, `dy` graph units, inside `full`. */
export function panView(view, full, dx, dy) {
  return keepInside({ ...view, x: view.x + dx, y: view.y + dy }, full);
}
