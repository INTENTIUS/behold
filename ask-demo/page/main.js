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
 *   - the estate pane zooms onto what a turn lit (web/key-light.js
 *     `zoomFrame`), and a visitor can zoom it with its buttons, the wheel or a
 *     pinch, and drag it; doing so holds the loop as editing the query does,
 *     and the next recorded turn does not move the view out from under them;
 *   - LadybugDB's badge beside the Cypher heading moves from the question's
 *     busy line until a few seconds after its answer draws, and while a
 *     visitor's query runs (web/engine-badge.js, on the page's clock);
 *   - a short beat after the question's reply has printed, the agent's pane
 *     closes (play.js `paneOpen`) so the estate graph and the Cypher pane
 *     take its room; the control at its edge opens it again, which holds
 *     the loop as editing the query does, and the next loop opens it;
 *   - after a loop the Cypher box can be edited, and once LadybugDB's
 *     WebAssembly build has loaded (after the first draw), a visitor's query
 *     runs in the page on the recorded rows (graph-db-wasm.js).
 *
 * Every file it reads is in the bundle (scripts/ask-demo/bundle.ts).
 * `?pace=<n>` plays n times faster, for a test; `?loop=<i>` starts at
 * question i.
 */
import { createAskPane } from "../../web/kiosk-ask.js";
import { answerDrawing, drawSvg, refusalText, rowsTable } from "../../web/graph-query.js";
import { bindEngineBadge } from "../../web/engine-badge.js";
import { applyKeyLight, cardIndex, lightKeys, zoomFrame } from "../../web/key-light.js";
import { callLine, cypherFill, knownResources, loopOf, loopTiming, narrationProblems, paneOpen, panView, parseParams, recordedAnswer, recordedWords, sourceWords, zoomView } from "./play.js";

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

const state = { narration: null, cards: new Map(), known: new Map(), loop: null, timing: null, startedAt: 0, questionGiven: false, phase: "idle", doneAt: 0, held: false, db: null, engine: "waiting", touched: false, zoomedAt: -Infinity, gesture: false, paneChosen: null };

/** A recorded turn leaves the view alone this long after the visitor last zoomed or dragged it, in ms. */
const VISITOR_VIEW_MS = 4000;
/** How far one press of a zoom button zooms. */
const ZOOM_STEP = 1.5;

async function getJson(path) {
  const r = await fetch(path, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  return r.json();
}

// --- The estate graph -------------------------------------------------------

let svg = null;
let full = null;
let tween = 0;
/** Where the view is going: the box the last tween or gesture set. */
let view = null;

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

const setViewBox = (b) => svg.setAttribute("viewBox", `${b.x} ${b.y} ${b.width} ${b.height}`);

function viewTo(box, ms = 700) {
  if (!svg || !box) return;
  const from = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  const set = setViewBox;
  view = { ...box };
  cancelAnimationFrame(tween);
  if (reduced() || from.length !== 4) return set(box);
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / ms);
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

/**
 * Light `ids` on the estate graph and zoom onto them (`zoomFrame`); with none,
 * or every card, the whole graph, and a caption saying why when there are
 * none. A recorded turn (`auto`) leaves the view where a visitor just put it.
 */
function lightEstate(ids, why, { auto = false } = {}) {
  const on = applyKeyLight(svg, ids, { pulse: !reduced() });
  html.dataset.lit = ids.join("\n");
  $("ad-estate-cap").textContent = why || "";
  if (auto && (state.gesture || performance.now() - state.zoomedAt < VISITOR_VIEW_MS)) return;
  const drawn = svg ? svg.querySelectorAll("[data-node-id]").length : 0;
  viewTo(on.length && on.length < drawn ? zoomFrame(on.map(boxOf), full) : full);
}

// --- The visitor's zoom -----------------------------------------------------

/** The view on screen now: mid-tween, where the tween has got to. */
function shownView() {
  const v = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  return v.length === 4 && v.every(Number.isFinite) ? { x: v[0], y: v[1], width: v[2], height: v[3] } : { ...full };
}

/** A point on screen in the graph's units. */
function graphPoint(clientX, clientY) {
  const m = svg.getScreenCTM();
  if (!m) return null;
  const p = svg.createSVGPoint();
  p.x = clientX;
  p.y = clientY;
  return p.matrixTransform(m.inverse());
}

/** The visitor moved the view: hold the loop once it can be held, and keep recorded turns off the view for a while. */
function visitorZoomed() {
  state.touched = true;
  state.zoomedAt = performance.now();
  hold();
}

/** Put the view at `box` at once, as a gesture does. */
function setView(box) {
  cancelAnimationFrame(tween);
  view = { ...box };
  setViewBox(box);
}

function zoomButton(factor) {
  if (!svg || !full) return;
  visitorZoomed();
  viewTo(factor ? zoomView(view || full, full, factor) : full, 250);
}

/** One column (a phone, a narrow window): the page scrolls, so a plain wheel scrolls it rather than zoom the estate. */
const oneColumn = typeof matchMedia === "function" ? matchMedia("(max-width: 820px)") : null;
const coarse = typeof matchMedia === "function" ? matchMedia("(pointer: coarse)") : null;

function zoomHint() {
  $("ad-zoom-hint").textContent =
    coarse && coarse.matches ? "Pinch to zoom and move" : oneColumn && oneColumn.matches ? "Pinch or Ctrl+scroll to zoom, drag to move" : "Scroll to zoom, drag to move";
}

function wireZoom() {
  const host = $("ad-estate-graph");
  $("ad-zoom-in").addEventListener("click", () => zoomButton(ZOOM_STEP));
  $("ad-zoom-out").addEventListener("click", () => zoomButton(1 / ZOOM_STEP));
  $("ad-zoom-fit").addEventListener("click", () => zoomButton(0));
  zoomHint();
  for (const q of [oneColumn, coarse]) if (q && q.addEventListener) q.addEventListener("change", zoomHint);

  host.addEventListener(
    "wheel",
    (e) => {
      if (!svg || !full || html.dataset.estate !== "loaded") return;
      // A trackpad pinch comes as a wheel with ctrlKey; a plain wheel zooms only where the page does not scroll.
      if (!e.ctrlKey && oneColumn && oneColumn.matches) return;
      const at = graphPoint(e.clientX, e.clientY);
      if (!at) return;
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002));
      visitorZoomed();
      setView(zoomView(shownView(), full, factor, at));
    },
    { passive: false },
  );

  // Drag to move, with a mouse or a pen. A finger is left to scroll the page; two fingers pinch (below).
  let drag = null;
  host.addEventListener("pointerdown", (e) => {
    if (!svg || !full || e.pointerType === "touch" || e.button !== 0 || html.dataset.estate !== "loaded") return;
    const m = svg.getScreenCTM();
    if (!m) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, from: shownView(), scale: m.a, moved: false };
  });
  host.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      state.gesture = true;
      host.setPointerCapture(e.pointerId);
      host.dataset.dragging = "1";
    }
    visitorZoomed();
    setView(panView(drag.from, full, -dx / drag.scale, -dy / drag.scale));
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    state.gesture = false;
    delete host.dataset.dragging;
  };
  host.addEventListener("pointerup", endDrag);
  host.addEventListener("pointercancel", endDrag);

  // Pinch with two fingers: zoom about where they started, and follow them as they move.
  let pinch = null;
  const pair = (t) => ({ d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY), x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  host.addEventListener(
    "touchstart",
    (e) => {
      if (!svg || !full || e.touches.length !== 2 || html.dataset.estate !== "loaded") return;
      const m = svg.getScreenCTM();
      const p = pair(e.touches);
      const at = graphPoint(p.x, p.y);
      if (!m || !at || !p.d) return;
      e.preventDefault();
      pinch = { ...p, at, from: shownView(), scale: m.a };
      state.gesture = true;
    },
    { passive: false },
  );
  host.addEventListener(
    "touchmove",
    (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const p = pair(e.touches);
      const zoomed = zoomView(pinch.from, full, p.d / pinch.d, pinch.at);
      const k = (pinch.from.width / zoomed.width) * pinch.scale;
      visitorZoomed();
      setView(panView(zoomed, full, -(p.x - pinch.x) / k, -(p.y - pinch.y) / k));
    },
    { passive: false },
  );
  const endPinch = (e) => {
    if (!pinch || e.touches.length === 2) return;
    pinch = null;
    state.gesture = false;
  };
  host.addEventListener("touchend", endPinch);
  host.addEventListener("touchcancel", endPinch);
}

// --- The /graph pane --------------------------------------------------------

/**
 * Show an answer: its rows, and its drawing with both ends of each row
 * (behold#1190, `answerDrawing` over the resources the recording loaded), so
 * a recorded turn and a visitor's query draw alike.
 */
function showAnswer(answer) {
  const { status, body } = answer;
  const picture = status === 200 && body.draw ? answerDrawing(body, state.known) : { nodes: [], edges: [], lit: [] };
  const lit = picture.lit;
  $("g-error").textContent = status === 200 ? "" : refusalText(body);
  $("g-draw").innerHTML = picture.nodes.length ? drawSvg(picture, DRAW_SIZE, lit) : "";
  $("g-rows").innerHTML = status === 200 && body.columns ? rowsTable(body.columns, body.rows) : "";
  $("g-sources").textContent = status === 200 ? sourceWords(body.sources).join("\n") : "";
  html.dataset.answerLit = lit.join("\n");
}

function clearPane() {
  $("g-cypher").value = "";
  $("g-params").value = "";
  $("g-call").textContent = "";
  showAnswer({ status: 200, body: {} });
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
    showAnswer(recordedAnswer({ ...turn, keys: [], draw: { nodes: [], edges: [] } }));
    showEstate(true);
    lightEstate(turn.light, "", { auto: true });
    return;
  }
  const fill = cypherFill(turn);
  $("g-cypher").value = fill.cypher;
  $("g-params").value = fill.params;
  $("g-call").textContent = fill.call;
  showAnswer(recordedAnswer(turn));
  lightEstate(
    turn.light,
    turn.light.length ? "" : "The estate graph draws no card for what this answer names (indexed cloud and cluster objects). They light in the answer's drawing.",
    { auto: true },
  );
}

// --- The agent's pane ---------------------------------------------------------

/** Open or close the agent's pane as `paneOpen` says, and the control at its edge to match. */
function showPane() {
  const open = paneOpen({ phase: state.phase, sinceDoneMs: clock() - state.doneAt, chosen: state.paneChosen });
  const was = html.dataset.pane;
  const now = open ? "open" : "closed";
  const control = $("ad-convo");
  control.hidden = state.phase !== "after";
  if (was === now) return;
  html.dataset.pane = now;
  $("ad-ask-fold").inert = !open;
  control.setAttribute("aria-expanded", String(open));
  control.textContent = open ? "Hide the conversation" : "Show the conversation";
}

function togglePane() {
  const open = html.dataset.pane !== "closed";
  state.paneChosen = !open;
  // Opening it is reading the conversation again: the loop waits, as it does for an edited query.
  if (!open) hold();
  showPane();
}

// --- Loops ------------------------------------------------------------------

let pane = null;
let badge = null;

function startLoop(i) {
  const n = state.narration;
  state.loop = loopOf(n, i);
  state.timing = loopTiming(state.loop, { reduced: reduced() });
  state.startedAt = clock();
  state.questionGiven = false;
  state.held = false;
  state.touched = false;
  state.paneChosen = null;
  state.phase = "playing";
  state.badgeTurn = "idle";
  badge.reset();
  html.dataset.loop = String(i);
  delete html.dataset.turn;
  delete html.dataset.held;
  $("ad-next").classList.remove("ad-wanted");
  $("ad-count").textContent = `Question ${state.loop.index + 1} of ${state.loop.of}`;
  clearPane();
  lightEstate([], "Nothing is loaded into behold yet.");
  showEstate(false);
  setEditable(false);
  showPane();
  pane.setStep(state.loop.steps[0]);
}

function tick() {
  if (!state.loop) return;
  const t = clock();
  showPane();
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
  const answer = await badge.run(state.db.query($("g-cypher").value, p.params));
  showAnswer(answer);
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
  const [narration, estate, graphdb] = await Promise.all([getJson("./narration.json"), getJson("./estate.json"), getJson("./graphdb.json")]);
  const problems = narrationProblems(narration);
  if (problems.length) throw new Error(`narration.json: ${problems.join("; ")}`);
  state.narration = narration;
  state.cards = cardIndex(estate.nodes);
  state.known = knownResources(graphdb);
  const words = recordedWords(narration);
  $("ad-recorded").textContent = words.line;
  $("ad-command").textContent = words.command;
  $("ad-versions").textContent = words.versions;
  $("ad-note").textContent = narration.note;
  drawEstate(estate);
  wireZoom();

  pane = createAskPane({ host: $("k-ask"), now: () => new Date(clock()), reduced });
  badge = bindEngineBadge($("g-engine-badge"), { now: clock });
  // The question's busy line is behold running its query: the badge moves from there until its answer has drawn.
  addEventListener("behold:ask-busy", (e) => {
    const d = e.detail;
    if (!d || !d.busy || !state.loop || d.step !== state.loop.question.id || state.badgeTurn !== "idle") return;
    state.badgeTurn = "running";
    badge.start();
  });
  addEventListener("behold:ask-light", (e) => {
    const turn = e.detail && e.detail.ask && e.detail.ask.turn;
    if (turn) onTurn(turn);
    if (!turn || !state.loop || turn !== state.loop.question) return;
    // Under reduced motion the words show at once and the busy line may not; the answer still draws.
    if (state.badgeTurn === "done") return;
    if (state.badgeTurn === "idle") badge.start();
    state.badgeTurn = "done";
    badge.result(true);
  });
  addEventListener("behold:ask-done", (e) => {
    const turn = e.detail && e.detail.ask && e.detail.ask.turn;
    if (!turn || !state.loop || turn !== state.loop.question) return;
    state.phase = "after";
    state.doneAt = clock();
    setEditable(true);
    showPane();
    // A visitor who zoomed or dragged the estate while it played is looking at it: hold the loop for them.
    if (state.touched) hold();
  });
  $("g-cypher-form").addEventListener("submit", ask);
  for (const id of ["g-cypher", "g-params"]) {
    $(id).addEventListener("focus", hold);
    $(id).addEventListener("input", hold);
  }
  $("ad-convo").addEventListener("click", togglePane);
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
