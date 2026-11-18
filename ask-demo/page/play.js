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
import { answerDrawing } from "../../web/graph-query.js";
import { sourceLabel } from "../../web/source-label.js";

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

/** How long the agent's pane stays open once the question's reply has printed, in ms of the page's clock. */
export const PANE_BEAT_MS = 2_500;

/**
 * behold#1183: whether the agent's pane is open. It is open while a loop's
 * turns print, and for {@link PANE_BEAT_MS} after the question's reply has
 * printed (`sinceDoneMs` counts from then); after that it closes, so the
 * estate graph and the Cypher pane take its room for the loop's pause. A
 * visitor's choice (`chosen`: true to open, false to close, null for none)
 * wins once the reply has printed; the next loop starts with none.
 */
export function paneOpen({ phase, sinceDoneMs = 0, chosen = null }) {
  if (phase !== "after") return true;
  if (chosen === true || chosen === false) return chosen;
  return sinceDoneMs < PANE_BEAT_MS;
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
 * behold#1191: what the agent asked, in words, above the query. For the load
 * turn, what it loaded (the commands it ran are for hover, `callTitle`). A
 * Cypher call's query and parameters are the ones in the boxes below, so the
 * words point at them rather than repeat the tool's argument format; a
 * template call names the template and the resource, which behold expanded
 * to that query.
 */
export function callLine(turn) {
  const call = turn && turn.call;
  if (!call) return "";
  if (Array.isArray(call.commands)) {
    const n = Array.isArray(turn.rows) ? turn.rows.length : 0;
    return `The agent loaded the estate into behold: ${n} source${n === 1 ? "" : "s"}, each one a row below. No query has run yet.`;
  }
  const args = call.arguments || {};
  const params = typeof args.params === "string" && args.params && args.params !== "{}";
  if (typeof args.cypher === "string") return `The agent asked behold this query through its ask tool${params ? ", with the parameters below it" : ""}.`;
  const inputs = typeof args.inputs === "string" && args.inputs && args.inputs !== "{}" ? `, with the inputs ${args.inputs}` : "";
  return `The agent asked behold, through its ask tool, to run the ${args.template} template on ${args.resource}${inputs}. behold ran it as this query.`;
}

/** The call as the agent made it, for hover: the commands that loaded the estate, or the ask tool's arguments. */
export function callTitle(turn) {
  const call = turn && turn.call;
  if (!call) return "";
  if (Array.isArray(call.commands)) return call.commands.map((c) => `$ ${c}`).join("\n");
  return `${call.tool || "ask"} ${JSON.stringify(call.arguments || {})}`;
}

/** `2026-11-18T17:20:15.866Z` as `18 November 2026, 17:20 UTC`; anything else as it is. */
export function recordedTime(iso) {
  const d = new Date(iso);
  if (!iso || !Number.isFinite(d.getTime())) return String(iso || "");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${recordedDate(iso)}, ${hh}:${mm} UTC`;
}

const sized = (s) => (Number.isInteger(s.nodes) ? `${s.nodes} resource${s.nodes === 1 ? "" : "s"}${Number.isInteger(s.edges) ? ` and ${s.edges} edge${s.edges === 1 ? "" : "s"}` : ""}` : "its resources");

/**
 * behold#1191: one line per source, named as a person would (web/source-label.js):
 * what it held, whether that was declared or read from where it runs, and when
 * behold loaded it. The scope key and the raw times are for hover (`sourceTitle`).
 */
export function sourceWords(sources) {
  return (sources || []).map((s) => {
    const label = sourceLabel(s.scopeKey);
    const name = label.charAt(0).toUpperCase() + label.slice(1);
    const how = s.observedAt ? `as indexed ${recordedTime(s.observedAt)}` : "as declared";
    return `${name}: ${sized(s)} ${how}; loaded into behold ${recordedTime(s.readAt)}`;
  });
}

/** A source line's hover: its scope key, what read it, and the raw times. */
export function sourceTitle(s) {
  return `${s.scopeKey} (${s.name}), loaded ${s.readAt}${s.observedAt ? `, observed ${s.observedAt}` : ", declared, not observed"}`;
}

/**
 * behold#1191: the load turn's rows with the source each one is, in words,
 * first; the scope key stays in its own column.
 */
export function loadRows(turn) {
  const columns = Array.isArray(turn.columns) ? turn.columns : [];
  const rows = Array.isArray(turn.rows) ? turn.rows : [];
  return { columns: ["what", ...columns], rows: rows.map((r) => ({ what: sourceLabel(r.scopeKey), ...r })) };
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

/**
 * behold#1190: the resources the page knows, by key, for drawing an answer:
 * graphdb.json's resources (the rows the recording loaded), each as the
 * answer drawing's node.
 */
export function knownResources(graphdb) {
  const out = new Map();
  for (const r of (graphdb && graphdb.rows && graphdb.rows.resources) || []) {
    if (r && typeof r.key === "string") out.set(r.key, { key: r.key, kind: r.kind || "", name: r.name || "", source: r.source || "", scopeKey: r.scopeKey || "" });
  }
  return out;
}

/** The keys a turn's answer drawing lights: each node it draws that the answer names (web/graph-query.js `answerDrawing`). */
export function drawLight(answerBody, known = new Map()) {
  return answerDrawing(answerBody, known).lit;
}

/** `2026-11-18T16:56:39Z` as `18 November 2026` (UTC). */
export function recordedDate(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The words the page says about where the answers come from: never that they are live. `line` is both sentences; the phone shows `date` alone. */
export function recordedWords(n) {
  const date = `Recorded ${recordedDate(n.recordedAt)} from a real run on emulators.`;
  const replay = "Every answer is behold's, replayed as it came back.";
  return {
    date,
    replay,
    line: `${date} ${replay}`,
    command: typeof n.recordCommand === "string" && n.recordCommand ? n.recordCommand : RECORD_COMMAND,
    versions: Object.entries(n.versions || {})
      .map(([k, v]) => `${k} ${v}`)
      .join(", "),
  };
}

/** behold#1188: where the header's links go, on behold's docs site. */
export const DOCS = "https://intentius.io/behold/";
export const DEMO_DOCS = `${DOCS}using/ask-demo/`;
export const LINKS = [
  { id: "ad-link-docs", href: DOCS, text: "behold's docs" },
  { id: "ad-link-demo", href: DEMO_DOCS, text: "About this demo" },
  { id: "ad-link-yours", href: `${DEMO_DOCS}#the-same-loop-on-your-estate`, text: "Run it on your estate" },
];

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
