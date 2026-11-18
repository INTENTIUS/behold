/**
 * behold#1163: the ask demo page. It plays ask-demo/narration.json, a
 * recording of an agent loading an estate into behold and asking it
 * questions, in loops of about a minute: the load turn, then one question.
 *
 *   - the prompt pane at the bottom is the kiosk's (web/kiosk-ask.js), given
 *     one step per turn; it types the prompt, shows the busy line and types
 *     the reply, and tells the page through `behold:ask-*` window events;
 *   - as a reply starts, the estate graph above lights the cards the turn
 *     names (web/key-light.js, by key), and the /graph pane beside it fills
 *     its Cypher box with the turn's query and draws the recorded answer, its
 *     nodes lit, with when each source was read;
 *   - after a loop the Cypher box can be edited, and once LadybugDB's
 *     WebAssembly build has loaded (after the first draw), a visitor's query
 *     runs in the page on the recorded rows (graph-db-wasm.js).
 *
 * Every file it reads is in the bundle (scripts/ask-demo/bundle.ts).
 * `?pace=<n>` plays n times faster, for a test; `?loop=<i>` starts at
 * question i.
 */
import { createAskPane } from "../../web/kiosk-ask.js";
import { drawSvg, refusalText, rowsTable } from "../../web/graph-query.js";
import { applyKeyLight, cardIndex, frameBox, lightKeys } from "../../web/key-light.js";
import { callLine, cypherFill, drawLight, loopOf, loopTiming, narrationProblems, parseParams, recordedAnswer, recordedWords, sourceWords } from "./play.js";

const $ = (id) => document.getElementById(id);
const html = document.documentElement;
const query = new URLSearchParams(location.search);
const PACE = Math.min(50, Math.max(0.1, Number(query.get("pace")) || 1));
const motion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
const reduced = () => !!(motion && motion.matches);
const T0 = Date.now();
/** The page's clock: real time, or faster under `?pace`. */
const clock = () => T0 + (Date.now() - T0) * PACE;

/** The answer drawing's side, in its own units: smaller than the /graph page's, so its words read in a narrow pane. */
const DRAW_SIZE = 420;

const state = { narration: null, cards: new Map(), loop: null, timing: null, startedAt: 0, questionGiven: false, phase: "idle", doneAt: 0, held: false, db: null, engine: "waiting" };

async function getJson(path) {
  const r = await fetch(path, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  return r.json();
}

// --- The estate graph -------------------------------------------------------

let svg = null;
let full = null;
let tween = 0;

function drawEstate(estate) {
  const host = $("ad-estate-graph");
  host.innerHTML = estate.svg;
  svg = host.querySelector("svg");
  if (!svg) return;
  const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  full = vb.length === 4 && vb.every(Number.isFinite) ? { x: vb[0], y: vb[1], width: vb[2], height: vb[3] } : { x: 0, y: 0, width: Number(svg.getAttribute("width")) || 1000, height: Number(svg.getAttribute("height")) || 1000 };
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "The estate graph behold drew for the recording");
}

const boxOf = (g) => {
  const r = g.querySelector("rect");
  return r ? { x: Number(r.getAttribute("x")), y: Number(r.getAttribute("y")), width: Number(r.getAttribute("width")), height: Number(r.getAttribute("height")) } : null;
};

function viewTo(box) {
  if (!svg || !box) return;
  const from = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  const set = (b) => svg.setAttribute("viewBox", `${b.x} ${b.y} ${b.width} ${b.height}`);
  cancelAnimationFrame(tween);
  if (reduced() || from.length !== 4) return set(box);
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / 700);
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    set({ x: from[0] + (box.x - from[0]) * e, y: from[1] + (box.y - from[1]) * e, width: from[2] + (box.width - from[2]) * e, height: from[3] + (box.height - from[3]) * e });
    if (k < 1) tween = requestAnimationFrame(step);
  };
  tween = requestAnimationFrame(step);
}

/**
 * The estate pane is empty until the agent loads the estate: each loop starts
 * with nothing drawn, and the load turn's reply shows the graph.
 */
function showEstate(on) {
  html.dataset.estate = on ? "loaded" : "empty";
  $("ad-estate-graph").setAttribute("aria-hidden", on ? "false" : "true");
}

/** Light `ids` on the estate graph and frame them; with none, the whole graph and a caption saying why. */
function lightEstate(ids, why) {
  const on = applyKeyLight(svg, ids, { pulse: !reduced() });
  html.dataset.lit = ids.join("\n");
  viewTo(on.length && on.length < state.cards.size ? frameBox(on.map(boxOf), full) : full);
  $("ad-estate-cap").textContent = why || "";
}

// --- The /graph pane --------------------------------------------------------

function showAnswer(answer, lit) {
  const { status, body } = answer;
  $("g-error").textContent = status === 200 ? "" : refusalText(body);
  $("g-draw").innerHTML = status === 200 && body.draw ? drawSvg(body.draw, DRAW_SIZE, lit) : "";
  $("g-rows").innerHTML = status === 200 && body.columns ? rowsTable(body.columns, body.rows) : "";
  $("g-sources").textContent = status === 200 ? sourceWords(body.sources).join("\n") : "";
  html.dataset.answerLit = lit.join("\n");
}

function clearPane() {
  $("g-cypher").value = "";
  $("g-params").value = "";
  $("g-call").textContent = "";
  showAnswer({ status: 200, body: {} }, []);
}

function setEditable(on) {
  $("g-cypher").readOnly = !on;
  $("g-params").readOnly = !on;
  html.dataset.phase = state.phase;
  const ready = state.engine === "ready";
  const ask = $("g-ask");
  ask.disabled = !on || !ready;
  ask.textContent = on && !ready && state.engine !== "failed" ? "Loading..." : "Ask";
  $("g-hint").textContent = !on
    ? "The query behold ran for the agent. You can edit it once the answer has printed."
    : ready
      ? "Your turn: edit the query and press Ask. It runs in this page, on the rows the recording loaded."
      : state.engine === "failed"
        ? "The graph database did not load in this page, so a query cannot run here."
        : "Your turn once the graph database has loaded in this page.";
}

function setEngine(s, detail = "") {
  state.engine = s;
  html.dataset.engine = s;
  $("g-engine").textContent =
    s === "loading" ? "LadybugDB (WebAssembly) is loading in this page." : s === "ready" ? `LadybugDB ${detail} is ready in this page.`.replace("  ", " ") : s === "failed" ? `LadybugDB did not load: ${detail}` : "";
  setEditable(state.phase === "after");
}

// --- Turns ------------------------------------------------------------------

function onTurn(turn) {
  html.dataset.turn = turn.id;
  if (turn.kind === "load") {
    clearPane();
    $("g-call").textContent = callLine(turn);
    $("g-cypher").placeholder = "The load turn runs no query.";
    showAnswer(recordedAnswer({ ...turn, keys: [], draw: { nodes: [], edges: [] } }), []);
    showEstate(true);
    lightEstate(turn.light, "");
    return;
  }
  const fill = cypherFill(turn);
  $("g-cypher").value = fill.cypher;
  $("g-params").value = fill.params;
  $("g-call").textContent = fill.call;
  const answer = recordedAnswer(turn);
  showAnswer(answer, drawLight(answer.body));
  lightEstate(
    turn.light,
    turn.light.length ? "" : "The estate graph draws no card for what this answer names (indexed cloud and cluster objects). They light in the answer's drawing.",
  );
}

// --- Loops ------------------------------------------------------------------

let pane = null;

function startLoop(i) {
  const n = state.narration;
  state.loop = loopOf(n, i);
  state.timing = loopTiming(state.loop, { reduced: reduced() });
  state.startedAt = clock();
  state.questionGiven = false;
  state.held = false;
  state.phase = "playing";
  html.dataset.loop = String(i);
  delete html.dataset.turn;
  delete html.dataset.held;
  $("ad-next").classList.remove("ad-wanted");
  $("ad-count").textContent = `Question ${state.loop.index + 1} of ${state.loop.of}`;
  clearPane();
  lightEstate([], "Nothing is loaded into behold yet.");
  showEstate(false);
  setEditable(false);
  pane.setStep(state.loop.steps[0]);
}

function tick() {
  if (!state.loop) return;
  const t = clock();
  if (state.phase === "playing" && !state.questionGiven && t - state.startedAt >= state.timing.questionAt) {
    state.questionGiven = true;
    pane.setStep(state.loop.steps[1]);
  }
  if (state.phase === "after" && !state.held && t - state.doneAt >= state.timing.dwellMs) startLoop(state.loop.loop + 1);
}

function hold() {
  if (state.phase !== "after") return;
  state.held = true;
  html.dataset.held = "1";
  $("ad-next").classList.add("ad-wanted");
}

async function ask(ev) {
  ev.preventDefault();
  if (state.phase !== "after" || !state.db || state.engine !== "ready") return;
  hold();
  const p = parseParams($("g-params").value);
  if (!p.ok) {
    $("g-error").textContent = p.error;
    return;
  }
  $("g-call").textContent = "Your query, run in this page.";
  const answer = await state.db.query($("g-cypher").value, p.params);
  showAnswer(answer, answer.status === 200 ? drawLight(answer.body) : []);
  const lit = answer.status === 200 ? lightKeys(answer.body, state.cards) : [];
  lightEstate(lit, answer.status === 200 && !lit.length ? "The estate graph draws no card for what this answer names. It lights in the answer's drawing." : "");
  html.dataset.visitor = String(Number(html.dataset.visitor || 0) + 1);
}

function loadEngine() {
  setEngine("loading");
  import("./graph-db-wasm.js")
    .then((m) => {
      state.db = m.openGraphDb(new URL("./graphdb.json", location.href).href);
      return state.db.ready.then(() => state.db.status());
    })
    .then((s) => setEngine("ready", (s && s.body && s.body.peer && s.body.peer.version) || ""))
    .catch((e) => setEngine("failed", (e && e.message) || String(e)));
}

async function boot() {
  const [narration, estate] = await Promise.all([getJson("./narration.json"), getJson("./estate.json")]);
  const problems = narrationProblems(narration);
  if (problems.length) throw new Error(`narration.json: ${problems.join("; ")}`);
  state.narration = narration;
  state.cards = cardIndex(estate.nodes);
  const words = recordedWords(narration);
  $("ad-recorded").textContent = words.line;
  $("ad-command").textContent = words.command;
  $("ad-versions").textContent = words.versions;
  $("ad-note").textContent = narration.note;
  drawEstate(estate);

  pane = createAskPane({ host: $("k-ask"), now: () => new Date(clock()), reduced });
  addEventListener("behold:ask-light", (e) => {
    const turn = e.detail && e.detail.ask && e.detail.ask.turn;
    if (turn) onTurn(turn);
  });
  addEventListener("behold:ask-done", (e) => {
    const turn = e.detail && e.detail.ask && e.detail.ask.turn;
    if (!turn || !state.loop || turn !== state.loop.question) return;
    state.phase = "after";
    state.doneAt = clock();
    setEditable(true);
  });
  $("g-cypher-form").addEventListener("submit", ask);
  for (const id of ["g-cypher", "g-params"]) {
    $(id).addEventListener("focus", hold);
    $(id).addEventListener("input", hold);
  }
  $("ad-next").addEventListener("click", () => {
    startLoop(state.loop ? state.loop.loop + 1 : 0);
  });
  setInterval(tick, 50);
  startLoop(Math.max(0, Number(query.get("loop")) || 0));
  // The engine and its 23 MiB worker load once the page is on screen.
  requestAnimationFrame(() => setTimeout(loadEngine, 0));
}

boot().catch((e) => {
  html.dataset.failed = "1";
  $("ad-recorded").textContent = `The recording did not load: ${(e && e.message) || e}`;
});
