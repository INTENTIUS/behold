// behold SPA. Fetches the read-only graph from the server — chant's IR + pinhole's
// rendered SVG — inlines the SVG and wires click-inspect. The visual is pinhole's
// mature painter (themes, icons, `_status` drift colouring); behold owns the data,
// the inspect panel, and (later) the lanes + delegated actions.

// Ghostty colour themes (#62): apply the persisted/default theme's tokens as CSS vars
// before first paint (so the whole graph + chrome recolour from one source). Then the
// floating control panel's chrome (panel.js — drag/snap/collapse/tabs, persisted
// position), and the theme picker into the panel's View-tab slot (a stable element
// renderPanelView never rewrites, so the select mounts once and survives re-renders).
import "./view-repo.js"; // behold#571: first, so every read carries the page's ?repo=
import { createRefreshQueue } from "./refresh-queue.js";
import { indexCompositeMembers } from "./composite-members.js";
import { readViewQuery, writeViewQuery, settleView, settlePlace, refusalLine, withOpening, defaultEnv, restoreViewQuery, viewFromObject } from "./view-url.js";
import { agentBanner, agentEntry, wholeQuestion } from "./agent-move.js";
import { quietCardLines, readEmbed, selectMessage, viewFromMessage, wheelPx, wheelZoomsBare } from "./embed.js";
import { WORDS as POP_WORDS, cardRoot as popCardRoot, placePopover, popReduce, popState, resourcePopover, rootPopover } from "./kiosk-popover.js";
import { waveListKey, waveListOf } from "./kiosk-wave-list.js";
import { shiftInto } from "./float-place.js"; // behold#764
import { cssString, hoverCss, hoverFromMessage, hoverLinks, hoverMessage, isLightBg, rootPaint, rootText } from "./kiosk-roots.js";
import { gateCards } from "./workspace-gates.js";
import { cornerOf, estateLine, hrefOf as tgHref, legend as tgLegend, markLine, rootRows as tgRootRows, waveCards } from "./terragucci.js";
import { laneElement as tgLane, rootOfCard as tgRootOfCard, historyElement as tgHistoryLane } from "./terragucci-timeline.js";
import { renderLane } from "./terragucci-lifecycle.js";
import { renderReleases } from "./releases.js";
import { renderTrunkLane } from "./trunk-lane.js";
import { startLocalRuns } from "./local-run.js";
import { entriesFor as csEntriesFor, gapLines as csGapLines, inspectHeading as csInspectHeading, nodeMarks as csNodeMarks, offGraph as csOffGraph, overlayHeader as csHeader, overlayLegend as csLegend, PREVIEW_NOTE as CS_PREVIEW_NOTE } from "./change-set-overlay.js";
import { collisionFilter as coFilter, collisionHeader as coHeader, collisionMarks as coMarks, collisionsFor as coFor, COLLISION_NOTE as CO_NOTE, FILES_NOTE as CO_FILES_NOTE, FILTER_OFF as CO_FILTER_OFF, FILTER_ON as CO_FILTER_ON, gapLines as coGapLines, hideEdge as coHideEdge, itemRow as coItemRow, nodeRow as coNodeRow, sideLines as coSideLines } from "./collision-marks.js";
import { dimEdge as hmDimEdge, HEALTH_NOTE as HM_NOTE, healthHeader as hmHeader, healthLegendRows as hmLegendRows, healthMarks as hmMarks, healthRows as hmRows, memberLines as hmMemberLines } from "./health-marks.js";
import { flagMarks as flFlagMarks, flagRow as flFlagRow, flagsFor as flFlagsFor, flagsHeader as flHeader, gapLines as flGapLines, NODES_NOTE as FL_NODES_NOTE, pickEnv as flPickEnv, STALE_COLOR as FL_STALE_COLOR, TURN_ON_NOTE as FL_TURN_ON_NOTE } from "./feature-flags.js";
import { renderYodelLane } from "./sql-yodeler-lane.js";
import { initTerragucciEstate } from "./terragucci-estate.js";
import { chantComponentMarks } from "./chant-pr-marks.js";
import { createLivePacer } from "./chant-live-pace.js";
import { createProgressPacer } from "./terragucci-live-pace.js";
import { noStateFill } from "./frame-fill.js";
import { componentMarks as tgComponentMarks, runsCommit as tgRunsCommit, statusShort as tgStatusShort, waveOfKey as tgWaveOfKey } from "./terragucci-components-live.js";
import { FORGES, MARK, componentsForge, forgeOfName, iconSvg, markLink, markTitle, waveJobUrl } from "./forge-mark.js";
import { TOOLS, orderTools } from "./tool-mark.js";
import { STATE_WORDS as tgStateWords, changeSection as tgChangeSection, readCardIds as tgReadCardIds, readEdges as tgReadEdges, readLabel as tgReadLabel, readLine as tgReadLine, readTag as tgReadTag, rootStates as tgRootStates, viewCaption as tgViewCaption, pinnedAnswer as tgPinnedAnswer, pinnedCaption as tgPinnedCaption, pinsCommit as tgPinsCommit, pinWaits as tgPinWaits } from "./terragucci-change.js";
import { auditLines as yrAuditLines, cornerText as yrCorner, datedWords as yrDated, environmentLines as yrEnvLines, joinMarks as yrJoin, legend as yrLegend, markLine as yrMarkLine } from "./yodel-report.js";
import { drawLight as klDraw } from "./kiosk-light-frame.js"; // behold#937
import { badgeWords as klBadge, planOf as klPlanOf } from "./kiosk-light.js"; // behold#940
import { composedRun } from "./kiosk-light.js";
import { graphMayShow, keepsSceneInAsk, mayTellDrawn, refusalHoldsScene } from "./kiosk-graph-pane.js";
import { askDeltas, clearScene, drawScene, sceneModel, slotCounts as klSlotCounts, waitingModel } from "./kiosk-estate-scene.js"; // behold#940
import { cardProgress as tgCardProgress, progressLines as tgProgressLines, progressSection as tgProgressSection, stampProgress as tgStampProgress } from "./terragucci-progress.js";
import { seconds, whyQuery, whyView } from "./why.js";
import { edgeKey, edgeLabel, edgeLegend, edgeTitle, isCiKind, viaIndex } from "./edge-kind.js";
import { edgeWeights, weightLegend } from "./edge-weight.js";
import { networkFindings, OUTSIDE, traceRoute } from "./net-trace.js";
import { readCostLine } from "./read-cost.js";
import { mountHistoryPicker } from "./history-picker.js";
import { applyMemberFrame, createMemberFrames, pendingLine, stillPending } from "./pending.js";
import { initTheme, setTheme, mountThemePicker, readableOn, inkOn, colorForCategory, onThemeChange, getTokens, getTheme, pinTokensFor, barVarFor } from "./theme.js";
// #399 M2 / #401 M4 of #397: the colour-by modes' arithmetic and the
// provenance badge's wording — every decision the behaviour overlay makes,
// pure and unit-tested beside the file. This module owns the fetches, the SVG
// and the panels; nothing below states a figure of its own.
import {
  COLOUR_MODES,
  badgeFor,
  blockOf,
  countFigures,
  countsText,
  domainFor,
  effectiveMode,
  figureOf,
  fillFor,
  fmtCost,
  fmtHeadroom,
  headroomOf,
  modeAvailability,
  rampFor,
  rampGradient,
  scaleEnds,
  totalsFor,
  totalsText,
  deltaRows,
} from "./behaviour-scale.js";
import { addPanelTab, initPanel, setPanelTab, togglePanelCollapsed, isPanelCollapsed, foldPanelOnPhone } from "./panel.js";
// #254: the carve walkthrough's stepper — everything it DECIDES is a pure
// function in there; this file owns the fetches, the graph selection, and the
// "carved" marker the last step leaves on a card.
import { CARVE_STEPS, blockedReason, initialCarveState, renderCarvePanel } from "./carve-steps.js";
// #228: the hand-layout delta store — everything about WHAT gets remembered and
// under which key. The pointer work and the SVG surgery stay here (see the
// "Hand layout" section below).
import {
  applicable,
  clampDelta,
  clearLayout,
  debounce,
  fetchServerLayout,
  isEmpty,
  layoutKey,
  lensKeyOf,
  mergeLayouts,
  nodeTransform,
  pathAnchors,
  postServerLayout,
  projectKeyOf,
  readLayout,
  setDelta,
  straightEdge,
  writeLayout,
} from "./layout-store.js";
import { PHONE_QUERY as INSPECT_PHONE_QUERY, inspectStartsFolded } from "./inspect-pane.js";
// #259: every JSON value this page shows goes through one renderer — pretty
// printed, collapsible, copyable per subtree. `valueCell`/`pairCell` below are
// the call-site shorthands: a container becomes the tree, a scalar stays text.
import { isContainer, jsonCell, renderJson, scalarText } from "./json-view.js";
// #268: the demo catalog's presentation — what a catalog row's button says
// about it (disabled + reason, or the fetch it would do).
import { fetchDemos, demoLabel, demoTitle, demoProgress } from "./demos.js";
// #284 item 2: the run playhead's panel — the verdict wording, the pending gate
// card and the settled-step rows. Everything it DECIDES is pure in there; the
// fetches, the SSE subscription and the graph re-pull stay here.
import { hasPlayhead, renderPlayhead, waitingFor, sourceLabel, applyChipText, waitingLine, RUN_STATUS_COLOR } from "./run-playhead.js";
// #234 joins 3 + 1: the operator strip (one honestly-dated tick per ConvergeOp,
// the lease, the pending gate count) and the converge gate card, whose Approve
// records a fact for the next tick rather than releasing anything. Same split as
// the playhead — the decisions are pure in there, the fetches stay here.
import { hasOperator, renderOperator, renderConvergeGateCard, APPROVED_SEMANTICS } from "./operator.js";
import { modalStyle, openEventModal } from "./event-help-modal.js";
import { ehStore, ehStored } from "./event-help-store.js";
// #165: the recorded release on a component — which run put it here, from
// which commit, approved by whom — and, when the ledger's run id cannot be
// followed, the reason in words rather than a guessed link.
import { releaseRows } from "./release.js";
import { renderExportNote } from "./export-note.js";
import { danglingFor, danglingRows, danglingHeading, DANGLING_EXPLAINED } from "./dangling.js";
import { comparisonRow, comparisonSummary } from "./cross-env.js";
// The marker-vs-derived mark on a choudoufu card: how its identity was found.
import { identityMark, tagGlyphSvg } from "./identity-mark.js";
import { ASK_MAX_SCALE, afterFrames, debounced, shotFromMessage, shotViewBox, tweenViewBox, unionBox, sameViewBox, heldFrame, heldInsets, heldTarget, holdsStage, medianWidth, smallStage } from "./kiosk-shot.js"; // behold#571: Watch's camera
import { SHOT_ATTR, SHOT_CAPTION_PX, SHOT_DIM, queryFrame, readShotFrame, shotCaption, shotLit, shotProvenance, shotState } from "./shot-frame.js"; // behold#915: the page `behold shot` photographs
import { countsLine, groupLabel, groupMarks, queryLine, queryMarks, searchKey, searchUrl, stackIndex, uncapturedLine } from "./search-view.js"; // behold#913: `q` drawn; behold#922: groups
// #712, #715: the dots layer, the zoom past the cards. Mounted for a live
// carve when the estate has choudoufu roots or estate rosters
// (/api/terragucci/carve, liveCarveGate below), or when /api/graph's meta
// carries `dots` (the local preview server, scripts/dots-preview.ts). With
// neither it stays unmounted, and its hooks below are no-ops.
import { mountDots, unmountDots, dotsCamera, dotsZoomOutFactor, dotsCarving, dotsMinViewWidth, setDotsCone } from "./dots.js";
// Report minor 34: a cone plan's lights, on the cards and the dots (web/cone.js).
import { cardRoot as coneCardRoot, coneLights, coneOf, resourceLight as coneResourceLight, rootLight as coneRootLight, wrapWords } from "./cone.js";
import { carveDrawable } from "./dots-live.js";
import { FLASH_MS as TG_FLASH_MS, coveredEdges as tgCoveredEdges, createReadFlash, dependsLine as tgDependsLine, hotReads as tgHotReads, nearestOn as tgNearestOn, pillSpots as tgPillSpots, readKey as tgReadKey, readerStates as tgReaderStates } from "./tg-read-pills.js"; // behold#744
import { outsideCard as tgOutsideCard, outsideModel as tgOutsideModel, outsideSpots as tgOutsideSpots } from "./tg-outside.js"; // behold#743
initTheme();
// #476: framed in a host pane. The flag is a class on <html>, so the CSS that
// folds the chrome away needs no JS, and the theme is the host's for this
// frame only.
const embedOpts = readEmbed(location.search);
if (embedOpts.theme && !setTheme(embedOpts.theme, { persist: false })) console.warn(`behold: no theme named ${embedOpts.theme}`);
if (embedOpts.embed) document.documentElement.classList.add("embed");
if (embedOpts.embed && embedOpts.bare) document.documentElement.classList.add("bare"); // #569: the graph alone, for a kiosk
// The kiosk on a phone: one finger scrolls the page and two pan or zoom the graph. A one-finger pan held most of the
// screen, so any scroll over the graph moved it and paused Watch.
const kioskTouch = () => !!(embedOpts.embed && embedOpts.bare) && typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
if (kioskTouch()) document.documentElement.classList.add("kiosk-touch");
initPanel({ embed: embedOpts.embed, phone: typeof matchMedia === "function" && matchMedia(INSPECT_PHONE_QUERY).matches, phoneQuery: INSPECT_PHONE_QUERY });
mountThemePicker(document.getElementById("panel-theme"));

// Colour node fills by category/kind using the theme's FULL palette (spicypath-style, so the
// graph shows the theme's many colours), while pinhole's drift stays on the bar/stroke. Node
// labels/icons get readable ink (black/white) on the category fill. Re-runs on theme switch,
// since the categorical hues come from the active theme's palette.
let lastGraphIr = null;

// --- colour by drift, cost or headroom (#399, M2 of #397) -------------------
//
// The mode is CLIENT-SIDE state, deliberately. It changes no fetch: the server
// hands the same overlay whichever mode is picked — `attrs._behaviour` rides
// every priced card already (src/behaviour.ts explains why the block stays on
// the node), so a mode switch is a repaint of the SVG that is already on
// screen, with no round trip and nothing for a slow chant read to hold up. It
// is therefore NOT in `LENS_PARAMS`/`canonicalKey`: a lens param there means "a
// different snapshot comes back", and adding one would give a static export
// three identical bundles of the same graph under three keys.
//
// It survives a reload the way the theme does, and for the same reason — the
// colour you left the graph in is part of how you read it.
const COLOUR_STORE_KEY = "behold.colourBy";
let colourMode = "drift";
try {
  const saved = localStorage.getItem(COLOUR_STORE_KEY);
  if (COLOUR_MODES.includes(saved)) colourMode = saved;
} catch {
  /* private mode */
}
// #475: what a load with no `lens=` would paint, so the URL carries any other.
let savedColourMode = colourMode;

const COLOUR_MODE_TITLE = {
  drift: "Color each card by what chant observed live — the overlay behold has always drawn",
  cost: "Color each card by the engine's cost per hour, low to high across this estate. An entity nothing priced draws neutral, never the cheap end.",
  headroom: "Color each card by how far it is from saturation — the LOWER of the axes the engine reported. An entity nothing priced draws neutral.",
};

/** `meta.behaviour` off the last render, or null. */
function behaviourMeta() {
  return (lastMeta && lastMeta.behaviour) || null;
}

/** The mode actually painted: the pick, unless this graph cannot serve it (no
 * overlay, a refusal, an absence), in which case drift — which never depended
 * on an engine. The PICK is kept either way, so switching back to a live env
 * lands where you left off. */
function activeColourMode() {
  return effectiveMode(colourMode, lastMeta);
}

function setColourMode(mode) {
  colourMode = mode;
  try {
    localStorage.setItem(COLOUR_STORE_KEY, mode);
    savedColourMode = mode;
  } catch {
    /* private mode */
  }
  // No load(): the mode changes nothing the server would answer differently,
  // so the SVG already on screen is repainted in place. renderStatusbar() is
  // the one entry point that redraws the strip AND all three panel tabs, which
  // is exactly the surface a mode switch moves.
  recolorNodesByCategory();
  renderStatusbar();
}

/**
 * What each card is painted, in the active mode.
 *
 * Drift keeps the categorical hue #62 gives a card (the drift state stays on
 * the bar and the stroke, where pinhole puts it). The two behaviour modes
 * replace the FILL with the mode's scale, so the drift bar underneath is
 * untouched and both facts stay on the card at once.
 *
 * The scale's domain is taken over every entity in the graph that carries a
 * figure — the same single walk of `ir.nodes` M1's design note promised, with
 * no join against a second index.
 */
function colourPlan(graphIr) {
  const mode = activeColourMode();
  const tokens = getTokens();
  const kindOf = new Map(graphIr.nodes.map((n) => [n.id, n.kind || n.lexicon || "node"]));
  const theme = getTheme();
  // #569 review: a terragucci repo's view with no drift read draws each root's
  // wave state on its box, so the cards wear the neutral ground: colour there
  // means a wave's state, never a category hue that reads as an error.
  // behold#571: in the kiosk's frame a card's state is its outline, bar and
  // words, never its fill, so a card with no state yet (before the pull
  // request's first plan, or reports that name another checkout) wears the
  // same neutral ground, not a category hue that reads as an error.
  if (mode === "drift" && tokens && (tgStatesDrawn(graphIr) || noStateFill({ frame: !!embedOpts.bare, live: graphIr.nodes.some((n) => n.attrs && n.attrs._status) }))) {
    const neutral = theme ? pinTokensFor(theme).neutralFill : tokens.neutral;
    return { mode, neutral: true, fillOf: () => ({ fill: neutral, unpriced: false }) };
  }
  if (mode === "drift" || !tokens) {
    return { mode, fillOf: (id) => ({ fill: colorForCategory(kindOf.get(id)), unpriced: false }) };
  }
  // The drift overlay's own neutral card ground — the colour a card wears when
  // chant could not read it. #399: an entity with no block draws THIS, never
  // the zero end of the scale, which would say "free" or "saturated" about an
  // entity nothing priced.
  const neutralFill = theme ? pinTokensFor(theme).neutralFill : tokens.neutral;
  const ramp = rampFor(mode, tokens);
  const domain = domainFor(
    mode,
    graphIr.nodes.map((n) => figureOf(mode, blockOf(n))),
  );
  const figures = new Map(graphIr.nodes.map((n) => [n.id, figureOf(mode, blockOf(n))]));
  return { mode, domain, ramp, fillOf: (id) => fillFor(figures.get(id), domain, ramp, neutralFill) };
}

/** Whether the view draws a terragucci repo's root states over cards that carry no drift read. */
function tgStatesDrawn(graphIr) {
  if (!tgAnswer || tgAnswer.error || !tgAnswer.roots || !tgAnswer.roots.length) return false;
  return !graphIr.nodes.some((n) => n.attrs && n.attrs._status);
}

function recolorNodesByCategory(ir) {
  if (ir) lastGraphIr = ir;
  const graphIr = ir || lastGraphIr;
  const svg = document.querySelector("#graph svg");
  if (!svg || !graphIr) return;
  const kindOf = new Map(graphIr.nodes.map((n) => [n.id, n.kind || n.lexicon || "node"]));
  const plan = colourPlan(graphIr);
  for (const g of svg.querySelectorAll("[data-node-id]")) {
    const id = g.getAttribute("data-node-id");
    const kind = kindOf.get(id);
    if (!kind) continue;
    const paint = plan.fillOf(id);
    // behold#571: on the neutral card ground, the ink that reads best on it (theme.js inkOn).
    const cat = paint.fill, ink = plan.neutral ? inkOn(cat) : readableOn(cat);
    // #399: an unpriced card is marked, not merely coloured — a hex cannot be
    // read back out into "the engine did not price this", and the legend's
    // unpriced count has to agree with what is on the canvas.
    if (plan.mode !== "drift" && paint.unpriced) g.setAttribute("data-unpriced", "1");
    else g.removeAttribute("data-unpriced");
    // #429: and the card an overlay never observed because its member has no
    // live half. Only on an overlay: on the source graph NO card has a status
    // and the mark would be on every one of them, saying nothing.
    const onOverlay = !!(lastMeta && lastMeta.env);
    const node = graphIr.nodes.find((n) => n.id === id);
    g.toggleAttribute("data-no-live", onOverlay && !!node && !(node.attrs && node.attrs._status));
    // Classify each element ONCE by the pinhole token it rode on (data-cat role), then apply
    // the role's colour on every pass. This is what makes it recolour on theme switch: after
    // the first pass the fill is a hex (not a --pin-* var), so we must key off the marker, not
    // the token. Roles: fill=card background (→ category hue), bg=foreignObject background,
    // inkf/inks=label/icon (→ readable ink). The drift bar (--pin-*Bar) is never classified.
    for (const el of g.querySelectorAll("*")) {
      let role = el.getAttribute("data-cat");
      if (!role) {
        const f = el.getAttribute("fill") || "", s = el.getAttribute("stroke") || "", st = el.getAttribute("style") || "";
        if (/--pin-\w+Fill\b/.test(f)) role = "fill";
        else if (/--pin-\w+Fill\b/.test(st)) role = "bg";
        else if (/--pin-text/.test(f)) role = "inkf";
        else if (/--pin-text/.test(s)) role = "inks";
        if (role) el.setAttribute("data-cat", role);
      }
      if (role === "fill") el.setAttribute("fill", cat);
      else if (role === "bg") el.setAttribute("style", (el.getAttribute("style") || "").replace(/background:[^;]*/, "background:" + cat));
      else if (role === "inkf") el.setAttribute("fill", ink);
      else if (role === "inks") el.setAttribute("stroke", ink);
    }
  }
  // Runtime children get their bar coloured here (#144): pinhole's status
  // palette has no `runtime` token, so chant's `_status: runtime` falls through
  // to the neutral bar and a Pod reads exactly like an unobserved node. The bar
  // is the 4px rect pinhole draws second inside each node group.
  const statusOf = new Map(graphIr.nodes.map((n) => [n.id, n.attrs && n.attrs._status]));
  for (const g of svg.querySelectorAll("[data-node-id]")) {
    if (statusOf.get(g.getAttribute("data-node-id")) !== "runtime") continue;
    const bar = g.querySelector('rect[width="4"]');
    if (bar) bar.setAttribute("fill", "var(--runtime)");
  }
  markCloudBoxes();
  renderGraphLegend();
}

// behold#824: an estate across clouds draws one boundary box per cloud (AWS
// account, Azure subscription, GCP project). Each is marked with its cloud so
// the stylesheet can give it that vendor's colour, box and title together, and
// three clouds read as three clouds at a glance rather than three grey boxes.
const CLOUD_OF_BOX = [
  [/^AWS account\b/, "aws"],
  [/^Azure subscription\b/, "azure"],
  [/^GCP project\b/, "gcp"],
];
function cloudOfBox(title) {
  for (const [re, cloud] of CLOUD_OF_BOX) if (re.test(title)) return cloud;
  return null;
}
function markCloudBoxes() {
  const svg = document.querySelector("#graph svg");
  if (!svg) return;
  // A project box (the composites and resources zooms draw one per workspace
  // member) takes its cloud from its resources' lexicon when they share one:
  // `dns`, Route 53 and an Op, is an AWS box.
  const lexiconsOf = new Map();
  for (const n of (lastGraphIr && lastGraphIr.nodes) || []) {
    const slash = n.id.indexOf("/");
    if (slash < 1 || !n.lexicon) continue;
    const m = n.id.slice(0, slash);
    (lexiconsOf.get(m) ?? lexiconsOf.set(m, new Set()).get(m)).add(n.lexicon);
  }
  // Only the cloud lexicons count: a member that also holds an Op or other
  // non-cloud cards (dns, with its front-door Op) is still that cloud's.
  const memberCloud = (id) => {
    const clouds = [...(lexiconsOf.get(id) ?? [])].filter((l) => ["aws", "azure", "gcp"].includes(l));
    return clouds.length === 1 ? clouds[0] : null;
  };
  const titles = new Map();
  for (const rect of svg.querySelectorAll("rect[data-group-id]")) {
    const id = rect.getAttribute("data-group-id") || "";
    const cloud = cloudOfBox(id) || memberCloud(id);
    if (!cloud) continue;
    rect.setAttribute("data-cloud", cloud);
    titles.set(rect.getAttribute("data-group-id"), cloud);
  }
  if (!titles.size) return;
  for (const t of svg.querySelectorAll("text")) {
    const cloud = titles.get((t.textContent || "").trim());
    if (!cloud || t.getAttribute("data-cloud")) continue;
    t.setAttribute("data-cloud", cloud);
    // #872: the vendor's own mark before the title, drawn as published. The
    // title moves right by the mark's width, once (data-cloud guards it).
    const size = 20;
    const x = Number(t.getAttribute("x"));
    const y = Number(t.getAttribute("y"));
    const mark = document.createElementNS(SVGNS, "image");
    mark.setAttribute("href", `icons/${CLOUD_MARK[cloud]}.svg`);
    mark.setAttribute("x", String(x));
    mark.setAttribute("y", String(y - size + 4));
    mark.setAttribute("width", String(size));
    mark.setAttribute("height", String(size));
    mark.setAttribute("data-cloud-mark", cloud);
    t.parentNode.insertBefore(mark, t);
    t.setAttribute("x", String(x + size + 6));
  }
  declutterBoxHeads(boxLabelsOf(svg)); // the marks moved titles right
}
/** The vendored mark each cloud box wears (src/cloud-icons.ts vendors them). */
const CLOUD_MARK = { aws: "aws/cloud", azure: "azure/subscription", gcp: "gcp/project" };
onThemeChange(() => (recolorNodesByCategory(), drawTgReads())); // behold#571: drawTgReads redraws the marks in the theme's colours
// behold#824: the legend on the graph itself. In drift mode a card's fill is
// its resource kind (one hue per kind, nothing more) and its state is the bar
// down its left side and its outline, but the only legend was in the Model
// tab, so the biggest colours on the canvas read as a code with no key. This
// corner says what each one is, with the counts the Model tab keeps, and the
// health marks when there are any. Closed once, it stays closed for this
// viewer (a "legend" button brings it back).
const LEGEND_KEY = "behold.graph.legend.hidden";
function legendHidden() {
  let saved = null;
  try {
    saved = localStorage.getItem(LEGEND_KEY);
  } catch {}
  // On a phone the legend starts folded to its button: open, it covers a third of the graph.
  return saved === "1" || (saved === null && onPhone());
}
function onPhone() {
  return typeof matchMedia === "function" && matchMedia(INSPECT_PHONE_QUERY).matches;
}
function renderGraphLegend() {
  const host = document.getElementById("graph");
  if (!host) return;
  let el = document.getElementById("graph-legend");
  const ir = lastGraphIr;
  const onOverlay = !!(lastMeta && lastMeta.env);
  if (!ir || !onOverlay || activeColourMode() !== "drift" || embedOpts.bare) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = "graph-legend";
    host.appendChild(el);
  }
  el.innerHTML = "";
  if (legendHidden()) {
    el.className = "closed";
    el.appendChild(button("legend", "act", () => {
      try {
        localStorage.setItem(LEGEND_KEY, "0");
      } catch {}
      renderGraphLegend();
    }));
    return;
  }
  el.className = "";
  const head = document.createElement("div");
  head.className = "gl-head";
  head.textContent = "legend";
  const close = button("×", "gl-close", () => {
    try {
      localStorage.setItem(LEGEND_KEY, "1");
    } catch {}
    renderGraphLegend();
  });
  close.title = "Hide the legend (the Model tab keeps it)";
  head.appendChild(close);
  el.appendChild(head);
  const line = (swatch, text, count, cls) => {
    const row = document.createElement("div");
    row.className = "gl-row" + (cls ? " " + cls : "");
    row.appendChild(swatch);
    const t = document.createElement("span");
    t.className = "grow";
    t.textContent = text;
    row.appendChild(t);
    if (count) {
      const c = document.createElement("span");
      c.className = "gl-count";
      c.textContent = count;
      row.appendChild(c);
    }
    el.appendChild(row);
  };
  const kinds = [...new Set(ir.nodes.map((n) => n.kind || n.lexicon || "node"))].slice(0, 3);
  const fills = document.createElement("span");
  fills.className = "gl-fills";
  for (const k of kinds) {
    const f = document.createElement("i");
    f.style.background = colorForCategory(k);
    fills.appendChild(f);
  }
  const clouds = [...new Set([...document.querySelectorAll("#graph rect[data-cloud]")].map((r) => r.getAttribute("data-cloud")))];
  if (clouds.length) {
    const sw = document.createElement("span");
    sw.className = "gl-fills";
    const names = { aws: "AWS", azure: "Azure", gcp: "GCP" };
    for (const c of ["aws", "azure", "gcp"].filter((c) => clouds.includes(c))) {
      const f = document.createElement("i");
      f.style.background = `var(--cloud-${c})`;
      f.title = names[c];
      sw.appendChild(f);
    }
    line(sw, `box color: cloud (${["aws", "azure", "gcp"].filter((c) => clouds.includes(c)).map((c) => names[c]).join(", ")})`);
  }
  line(fills, "card color: resource kind");
  const sub = document.createElement("div");
  sub.className = "gl-sub";
  sub.textContent = "bar and outline: state";
  el.appendChild(sub);
  const words = statusLabels();
  const counts = {};
  for (const n of ir.nodes) {
    const st = n.attrs && n.attrs._status;
    if (st in words) counts[st] = (counts[st] || 0) + 1;
  }
  for (const [k, label] of Object.entries(words)) {
    if (!counts[k]) continue;
    const bar = document.createElement("span");
    bar.className = "gl-bar";
    bar.style.background = DRIFT_STATUS_VAR[k];
    line(bar, label, String(counts[k]));
  }
  const weights = weightLegend(lastEdgeWeights);
  if (weights.length) {
    const es = document.createElement("div");
    es.className = "gl-sub";
    es.textContent = "edges";
    el.appendChild(es);
    for (const r of weights) {
      const sw = document.createElementNS(SVGNS, "svg");
      sw.setAttribute("class", "edge-swatch gl-edge");
      sw.setAttribute("viewBox", "0 0 22 10");
      sw.setAttribute("width", "22");
      sw.setAttribute("height", "10");
      const g = document.createElementNS(SVGNS, "g");
      g.setAttribute("data-edge-weight", r.weight);
      const stroke = document.createElementNS(SVGNS, "path");
      stroke.setAttribute("class", "pin-edge-line");
      stroke.setAttribute("d", "M 1 5 L 21 5");
      g.appendChild(stroke);
      sw.appendChild(g);
      line(sw, r.title, String(r.count));
    }
  }
  const health = hmLegendRows(hmAnswer);
  if (health.length) {
    const hs = document.createElement("div");
    hs.className = "gl-sub";
    hs.textContent = "health";
    el.appendChild(hs);
    for (const r of health) {
      const dot = document.createElement("span");
      dot.className = "gl-dot" + (r.dashed ? " dashed" : "");
      dot.style.background = r.color;
      line(dot, r.text, r.count);
    }
  }
}


// #229, the one motion signature behold spends on data: a node whose drift
// `_status` CHANGED between two renders pulses once in the colour it just
// became. Node ids are stable across renders, so the diff is a single map
// compare — no extra fetch, no per-node bookkeeping. The first render seeds the
// map and pulses nothing (everything would "change"), and a lens switch that
// swaps the id set pulses nothing either, since only ids present in BOTH
// renders can have changed. The CSS keyframes + the reduced-motion guard live
// in index.html.
let lastStatusById = new Map();
function markStatusChanges(ir, statusVar) {
  const prev = lastStatusById;
  const next = new Map();
  for (const n of ir.nodes) {
    const s = n.attrs && n.attrs._status;
    if (s) next.set(n.id, s);
  }
  lastStatusById = next;
  if (!prev.size) return;
  const svg = document.querySelector("#graph svg");
  if (!svg) return;
  for (const g of svg.querySelectorAll("[data-node-id]")) {
    const id = g.getAttribute("data-node-id");
    const now = next.get(id);
    if (!now || prev.get(id) === undefined || prev.get(id) === now) continue;
    // The pulse wears the NEW status's hue, read through whichever vocabulary
    // this graph is painted in — a node going foreign glows yellow in the drift
    // overlay; a component that rolled back glows red in the component view,
    // where the same `warn` means something else entirely.
    g.style.setProperty("--pulse", statusVar[now] || "var(--pending)");
    g.classList.add("status-changed");
  }
}

// Static-export mode (`behold export`): the SPA runs off a pre-captured bundle
// with no backend. Detect the flag the export injects, load its manifest, and
// replay every read from `snapshots/` — the graph, zoom dial, radial, inspect,
// and env/tier pickers all work; live observe + all writes are off.
const staticMode = !!window.__BEHOLD_STATIC__;
// #569: `behold serve --public` injects this flag into the page it serves. The
// reads stay live (the SSE stream, the polls); every control that writes is
// hidden, and the server refuses every method but GET, HEAD and OPTIONS anyway.
const publicMode = !!window.__BEHOLD_PUBLIC__;
let manifest = null;
if (staticMode) {
  // A snapshot has no live host behind it: the controls that only make sense
  // against one (the lanes view, substrate readiness, the target endpoint,
  // the deploy dial) are hidden by the `static` class (index.html).
  document.documentElement.classList.add("static");
  try {
    manifest = await fetch("./manifest.json").then((r) => r.json());
  } catch {
    /* no manifest → apiFetch falls back to a not-captured error */
  }
  // #824: the line `behold export --note` put at the page's foot.
  const noteEl = document.getElementById("export-note");
  if (noteEl) renderExportNote(noteEl, document, manifest);
}

/** Canonical key for a read URL — path + the lens params (whitelisted, sorted)
 * that select a distinct snapshot. MUST match src/export.ts `canonicalKey`. */
const LENS_PARAMS = ["alike", "collapse", "components", "countBy", "detail", "env", "logical", "ops", "plan", "q", "radial", "runtime", "snapshot", "stacks", "tier"]; // q, snapshot: behold#913's /api/search; countBy, plan: behold#922
function canonicalKey(path, params) {
  // Components + logical + ops views ignore detail/radial — drop them so they
  // match the single captured snapshot (MUST match src/export.ts).
  const flat = params.get("components") === "1" || params.get("logical") === "1" || params.get("ops") === "1" || params.get("stacks") === "1";
  // behold#922: `plan` picks a snapshot of /api/graph (the cards' plan facts) and /api/search only; #404's one-shot plan on an overlay replays the overlay as captured.
  const planned = path === "/api/graph" || path === "/api/search";
  const q = LENS_PARAMS.filter((k) => params.has(k) && !(flat && (k === "detail" || k === "radial")) && !(k === "plan" && !planned))
    .map((k) => `${k}=${params.get(k)}`)
    .join("&");
  return q ? `${path}?${q}` : path;
}

/** Fetch a read endpoint — live `fetch` normally; in static mode, resolve the
 * canonical key against the manifest and load the captured snapshot instead. */
function apiFetch(url) {
  if (!staticMode) return fetch(url);
  const u = new URL(url, location.origin);
  const key = canonicalKey(u.pathname, u.searchParams);
  const file = manifest && manifest.keyToFile[key];
  if (!file) return Promise.resolve(new Response(JSON.stringify({ error: `not in this static export: ${key}` }), { status: 404, headers: { "content-type": "application/json" } }));
  return fetch("./" + file);
}

// `neutral` (chant#1168, #1089): a declared node chant could not read live
// state for — distinct from `accent`/"pending" (provider confirmed it
// absent). Additive: a chant predating #1168 never emits `neutral` here.
// `runtime` (chant#1180, #1077): a live, undeclared node whose owner chain
// reaches a declared entity — expected runtime (a Pod its Deployment
// created), never foreign and never drift. Additive the same way.
const STATUS_LABEL = { good: "managed", warn: "foreign", accent: "pending", neutral: "unobserved", runtime: "runtime child" };
// #393 item 8: the same four colours, in the words of whatever the estate's
// members ARE. The server derives the set from the member kinds and puts it on
// the overlay meta (`vocabulary`, src/status-vocabulary.ts) — on a choudoufu
// estate the legend reads bound / unowned / pending / not observed, which is
// what choudoufu itself calls those states. A mixed estate keeps chant's words
// and carries a `note` the legend shows as its tooltip. No meta, or a meta from
// a behold that predates this: chant's words, exactly as before.
function statusLabels() {
  const v = lastMeta && lastMeta.vocabulary;
  return (v && v.labels) || STATUS_LABEL;
}
function statusLabel(status) {
  return statusLabels()[status];
}
function vocabularyNote() {
  const v = lastMeta && lastMeta.vocabulary;
  return (v && v.note) || "";
}
// #396 item 5: the inspect pane's LIVE section prints `ownership` raw, and
// `ownership` is a word two different readers write into the same field.
// chant's live reader answers it from the resource's own marker — `owned` /
// `foreign`, which is chant's contract for that field (chant graph-ir.d.ts).
// src/choudoufu-live.ts has no marker to read: it writes the same two words for
// choudoufu's `bound[]` and `unowned[]`, so an unowned card read `status:
// unowned` and, two rows below it, `ownership: foreign` — chant's word for
// choudoufu's state, the last of the four #393 item 8 did not reach.
//
// So this row joins the legend, the counts and the status row in being rendered
// through the estate's own vocabulary rather than printed. Translated ONLY when
// the estate's members are all of a kind that has its own words for these
// colours (`vocabulary.of`): on a chant estate, and on a mixed one — which
// keeps chant's words on the legend by design and says so in its tooltip — the
// value is printed exactly as it is today, which is the point. The mapping is
// value → the colour that value means → that colour's word, so it needs no
// table of its own beyond the two words chant's field can hold.
const OWNERSHIP_STATUS = { owned: "good", foreign: "warn" };
function ownershipLabel(value) {
  const v = lastMeta && lastMeta.vocabulary;
  if (!v || !v.labels || !v.of || v.of === "chant" || v.of === "mixed") return value;
  return v.labels[OWNERSHIP_STATUS[value]] || value;
}
// #404: whether a plan was read for this overlay, and how many cards it would
// change. `{read: false}` and `{read: true, drifted: 0}` are DIFFERENT answers
// — "nobody looked" versus "looked, nothing drifted" — and the legend must not
// print a count for the first one. Null from a behold that predates this, and
// every reader below treats null as "not read".
function driftMeta() {
  return (lastMeta && lastMeta.drift) || null;
}
// M1.1 (#57), palette hardened M2 (#54): the component-DAG live-status join
// paints the same `_status` vocabulary (good/warn/accent/neutral) but with
// different meaning — a stack-health reading, not "managed" — so the inspect
// panel picks this label set for a node that carries `_liveStatus` (see
// joinComponentStatus, src/component-status.ts). `accent` (pinhole's blue
// paint — there's no separate amber token) reads as "in progress" here,
// distinct from the entity overlay's "pending" meaning for the same colour.
const COMPONENT_STATUS_LABEL = { good: "healthy", accent: "in progress", warn: "rollback / failed", neutral: "not deployed" };
// behold#146: the artifact-presence join (src/helm-artifacts.ts) paints
// Helm::Chart nodes with the same palette but the 2-way ARTIFACT vocabulary —
// a release is "installed", never "managed": chant's docs are explicit that
// artifacts have no declared axis to classify against. `_artifact`'s presence
// (or an artifact-flavoured `_unobserved`) picks this label set.
const ARTIFACT_STATUS_LABEL = { good: "installed", warn: "installed, not healthy", accent: "not installed", neutral: "unobserved" };
// The ops lens (#284) and its converge rule table (#234) paint the same four
// colours about a DECLARED Op, where none of the entity vocabulary applies: a
// gate is not "foreign" and a rule that may dispatch is not "pending". The word
// carries the meaning here (accessible-ops: never rely on the colour alone), so
// it is picked from what the card actually is — `_step` — and not from the
// colour alone, which in this lens says four different things per step kind.
const OP_STATUS_LABEL = {
  gate: { warn: "stops here for a human", good: "approved", accent: "waiting", neutral: "declared" },
  effect: { accent: "conditional — skipped when the receipt already matches", good: "fired", warn: "failed", neutral: "skipped" },
  rule: { accent: "may dispatch on a matching tick", warn: "dispatch target not in this graph", neutral: "reports only, never mutates" },
  activity: { good: "ran ok", warn: "failed", accent: "reached, not settled", neutral: "declared, not run" },
};
function opStatusLabel(node) {
  const set = OP_STATUS_LABEL[node.attrs && node.attrs._step];
  return set && set[node.attrs._status];
}
// The render-drift axis (#146's deferred half, chant#1249/#1250 via
// src/helm-drift.ts). A chart carrying `_renderDrift` has had its PINNED
// render diffed against the live cluster, so `warn` on it means "drifted",
// not "installed, not healthy" — same word the field-drift and entity-diff
// vocabularies already use for the same fact. `in-sync`/`unobserved` never
// repaint the node, so this only overrides the artifact label on drift.
const RENDER_VERDICT_LABEL = {
  drifted: "drifted from its pinned render",
  "in-sync": "matches its pinned render",
  unobserved: "not compared to its pinned render",
};
// Why nothing was compared. Every one of these is a hole, never a clean bill —
// see src/helm-drift.ts's header.
const RENDER_UNOBSERVED_LABEL = {
  unpinned: "render is unpinned (no capability profile) — no content identity to diff",
  "no-stored-render": "chant's render store has never seen this digest",
  "nothing-observed": "the live read returned no documents at all",
  "partly-observed": "some documents matched, others could not be read",
};

// A declared attribute value may be a cross-resource reference ({$ref:"x.y"}) —
// the "static infra refs" — rather than a concrete value. Render those readably;
// concrete values (present once a resource is provisioned) show as-is.
// #259: everything else that isn't a scalar becomes the collapsible tree rather
// than a flat one-line JSON.stringify — a declared `spec` used to wrap six times
// and say nothing about its shape.
function fmtValue(v) {
  if (v && typeof v === "object" && typeof v.$ref === "string") return "→ " + v.$ref;
  return valueCell(v);
}

/**
 * A `<dd>` body for one value: an object or an array becomes the collapsible
 * tree, a scalar keeps the pane's plain voice — `deploy/api`, not
 * `"deploy/api"`. Quoting is JSON's punctuation and belongs inside a tree, not
 * beside a label, so this is NOT json-view's own `jsonCell` (which quotes; the
 * value PAIRS below want that, since they always did).
 */
function valueCell(v) {
  return isContainer(v) ? renderJson(v) : String(v);
}

/** Put a value into a `<dd>`: a rendered JSON tree is appended, a scalar's text
 * is set. Every `add`/`section` setter in this pane funnels through here (#259). */
function setCell(dd, v) {
  if (v instanceof Node) dd.appendChild(v);
  else dd.textContent = v;
}

/**
 * The pane shows values in PAIRS as often as alone — old → new (drift),
 * declared · live (field ownership), baseline · live (accepted deviation).
 * Two scalars keep the one-line form the pane always had. If either side is an
 * object or an array it becomes a collapsible tree, and an arrow wedged between
 * two trees reads as neither — so the pair stacks into labelled rows instead
 * (#259). `lead` is the sentence that precedes a field-drift pair ("owned by
 * hpa-controller — drifted"); it keeps its own line in the stacked form.
 * Returns a Node or a string, for setCell.
 */
function pairCell(aLabel, a, bLabel, b, opts = {}) {
  const { lead = "", arrow = false } = opts;
  if (!isContainer(a) && !isContainer(b)) {
    const one = arrow ? `${scalarText(a)} → ${scalarText(b)}` : `${aLabel}: ${scalarText(a)} · ${bLabel}: ${scalarText(b)}`;
    return lead ? `${lead} — ${one}` : one;
  }
  const wrap = document.createElement("div");
  if (lead) {
    const p = document.createElement("div");
    p.textContent = lead;
    wrap.appendChild(p);
  }
  for (const [label, v] of [
    [aLabel, a],
    [bLabel, b],
  ]) {
    const row = document.createElement("div");
    row.className = "pair-row";
    const tag = document.createElement("span");
    tag.className = "pair-label";
    tag.textContent = label;
    row.appendChild(tag);
    setCell(row, jsonCell(v));
    wrap.appendChild(row);
  }
  return wrap;
}

/** Shorten a `sha256:<64 hex>` to the 12 hex digits chant's own reports print. */
function shortDigest(d) {
  return typeof d === "string" && d.startsWith("sha256:") ? d.slice(7, 19) : d;
}

/**
 * The `render diff` inspect section (#146's deferred half). `r` is the
 * `_renderDrift` report src/helm-drift.ts put on the chart node.
 *
 * Reports the verdict in words first, then the counts behind it, then — on
 * drift — every document that moved, path by path, in the same
 * declared → live form the field-drift section uses for a k8s resource.
 * Provenance comes last: which bytes were compared, and where they came from.
 */
/** The identity axis (chant#2031) in one sentence — what the observed release
 * was deployed from, compared to what this project renders. */
function renderIdentityText(i) {
  const o = i.observed || {};
  const d = i.declared || {};
  switch (i.match) {
    case "content":
      return `this render, byte for byte — content ${shortDigest(o.contentDigest)} matches`;
    case "input":
      return `this render's inputs — input digest ${shortDigest(o.inputDigest)} matches (bytes may differ per cluster)`;
    case "mismatch":
      return o.contentDigest && d.contentDigest
        ? `a different render — the release records content ${shortDigest(o.contentDigest)}, this project renders ${shortDigest(d.contentDigest)}`
        : `different inputs — the release records input ${shortDigest(o.inputDigest)}, this project renders ${shortDigest(d.inputDigest)}`;
    case "unrecorded":
      return "unknown — no release record names this deploy's render (deployed outside the recorded path, or the ledger could not be read)";
    case "unpinned":
      return "not comparable — this render is unpinned, so it has no identity to compare";
    default:
      return i.match;
  }
}

function renderDriftSection(section, r) {
  const rd = section("render diff");
  rd("verdict", RENDER_VERDICT_LABEL[r.verdict] || r.verdict);
  if (r.reason) rd("reason", RENDER_UNOBSERVED_LABEL[r.reason] || r.reason);
  // chant#2031: whether what runs was deployed from this render at all — the
  // question the live diff cannot ask, answered from two recorded digests.
  if (r.identity) rd("deployed from", renderIdentityText(r.identity));
  if (r.counts) {
    const c = r.counts;
    rd(
      "documents",
      `${c.drifted} drifted (${c.changes} propert${c.changes === 1 ? "y" : "ies"}) · ${c.unchanged} matching` +
        (c.unobserved ? ` · ${c.unobserved} unread` : "") +
        (c.undeclared ? ` · ${c.undeclared} not in the render` : ""),
    );
  }
  for (const doc of r.drifted || []) {
    const d = section(doc.name);
    for (const ch of doc.changes) {
      // Same declared → live form the k8s field-drift section uses, so a
      // release's drift reads exactly like a resource's.
      d(ch.path, `${JSON.stringify(ch.declared)} → ${JSON.stringify(ch.live)}`);
    }
  }
  const p = r.provenance;
  if (!p) return;
  // chant#1228's pinned-render record: what was rendered, from which inputs,
  // by which helm and chant, against which cluster profile. #234's "is prod
  // running what staging tested" is answered by comparing these across two
  // environments — behold renders one at a time, so it shows the facts and
  // leaves the comparison to a cross-environment surface.
  const pr = section("render provenance");
  pr("content digest", shortDigest(p.contentDigest));
  pr("input digest", shortDigest(p.inputDigest));
  pr("values digest", shortDigest(p.valuesDigest));
  pr("chart", p.chartVersion ? `${p.chart} ${p.chartVersion}` : p.chart);
  if (p.repo) pr("repo", p.repo);
  pr("release", p.namespace ? `${p.namespace}/${p.releaseName}` : p.releaseName);
  if (p.profile) pr("pinned against", p.kubeVersion ? `${p.profile} (k8s ${p.kubeVersion})` : p.profile);
  if (p.sourceRef) pr("source ref", p.sourceRef);
  pr("rendered", `${p.renderedAt} · helm ${p.helmVersion} · chant ${p.chantVersion}`);
}

// ---------------------------------------------------------------------------
// #471: the "why" of a member or a card in a declared workspace.
//
// Read on demand: `chant workspace graph --intent` walks git history and takes
// seconds on a small workspace and tens of seconds on a large one, so nothing
// asks for it until someone clicks. While it reads, the section says so with
// the seconds counting and a Stop button; the rest of the page goes on as
// before. Picking something else aborts the request, and the server's read
// scheduler stops chant when nobody is waiting for it any more. In embed mode
// the section is drawn the same; clicks on the graph still go to the host.
// ---------------------------------------------------------------------------

/** The member a card or a box belongs to, when the served workspace declares it. */
function declaredMember(name) {
  const ws = projectInfo && projectInfo.workspace;
  return (ws && ws.members.find((m) => m.name === name)) || null;
}

/** Answers already read this session, by query. A source change clears them. */
const whyAnswers = new Map();
/** The read in flight, so a new pick can stop it. */
let whyInFlight = null;

function stopWhyRead() {
  if (whyInFlight) whyInFlight.abort();
  whyInFlight = null;
}

function renderWhySection(panel, ask) {
  if (publicMode) return; // #569: /api/workspace/why is refused in a public view
  stopWhyRead();
  if (staticMode) return;
  const memberName = ask.member || nodeMember(ask.node || "");
  if (!declaredMember(memberName)) return;
  const query = whyQuery(ask);
  const forId = panel.dataset.node;
  const h = document.createElement("h3");
  h.textContent = "why";
  const box = document.createElement("div");
  box.className = "why";
  box.dataset.why = query;
  panel.append(h, box);

  const button = (label, title, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "why-read";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  };
  const idle = (note) => {
    box.replaceChildren();
    const p = document.createElement("p");
    p.className = "queried";
    p.textContent = note || `The decisions that cover ${ask.node ? "this card" : `member ${memberName}`}, the runs and commits behind it, and the chain from each commit's work item to its release, from chant workspace graph --intent. Reading walks the repository's history; on a large one it takes a while.`;
    box.append(p, button("Read why", "Ask chant now. Nothing is read until you click.", read));
  };
  const read = async () => {
    stopWhyRead();
    const controller = new AbortController();
    whyInFlight = controller;
    const started = Date.now();
    box.replaceChildren();
    const status = document.createElement("p");
    status.className = "queried why-reading";
    const tick = () => (status.textContent = `reading… ${seconds(Date.now() - started)}`);
    tick();
    const timer = setInterval(tick, 250);
    box.append(status, button("Stop", "Stop the read; chant is stopped too when nothing else waits for it.", () => {
      stopWhyRead();
      idle("Stopped. Nothing was read.");
    }));
    let answer;
    try {
      answer = await fetch(query, { signal: controller.signal }).then((r) => r.json());
    } catch (e) {
      clearInterval(timer);
      if (controller.signal.aborted) return;
      answer = { error: `The why read failed: ${e.message}`, remedy: "" };
    }
    clearInterval(timer);
    if (whyInFlight === controller) whyInFlight = null;
    if (panel.dataset.node !== forId || !box.isConnected) return;
    if (!answer.refusal && !answer.error) whyAnswers.set(query, answer);
    paintWhy(box, answer, read);
  };
  const known = whyAnswers.get(query);
  if (known) paintWhy(box, known, read);
  else idle();
}

function paintWhy(box, answer, again) {
  const v = whyView(answer);
  box.replaceChildren();
  const para = (text, cls) => {
    const p = document.createElement("p");
    if (cls) p.className = cls;
    p.textContent = text;
    box.appendChild(p);
    return p;
  };
  const list = (title, rows, row) => {
    if (!rows.length) return;
    const t = document.createElement("div");
    t.className = "why-head";
    t.textContent = title;
    const ul = document.createElement("ul");
    ul.className = "why-list";
    for (const r of rows) ul.appendChild(row(r));
    box.append(t, ul);
  };
  const li = (lead, rest, meta) => {
    const el = document.createElement("li");
    const top = document.createElement("div");
    top.append(lead);
    if (rest) top.append(` ${rest}`);
    el.appendChild(top);
    if (meta) {
      const m = document.createElement("div");
      m.className = "why-meta";
      m.textContent = meta;
      el.appendChild(m);
    }
    return el;
  };
  if (v.refusal) {
    para(v.refusal.error, "why-refusal");
    if (v.refusal.remedy) para(v.refusal.remedy, "queried");
  } else {
    para(v.headline, "why-headline");
    list("decisions", v.decisions, (d) => {
      let lead;
      if (d.href) {
        lead = document.createElement("a");
        lead.href = d.href;
        lead.target = "_blank";
        lead.rel = "noreferrer noopener";
        lead.title = "Review this proposed decision in hud";
      } else {
        lead = document.createElement("code");
      }
      lead.textContent = d.id;
      return li(lead, d.title, [d.meta, d.note].filter(Boolean).join(" · "));
    });
    list("runs", v.runs, (r) => {
      const lead = document.createElement("code");
      lead.textContent = r.id;
      return li(lead, r.when ? r.when.slice(0, 10) : "", r.meta);
    });
    list(`commits${v.more ? ` · ${v.commits.length} of ${v.commits.length + v.more}` : ""}`, v.commits, (c) => {
      const lead = document.createElement("code");
      lead.textContent = c.sha;
      return li(lead, c.subject, c.meta);
    });
    for (const g of v.gaps) para(g, "why-gap");
    if (v.chain) paintChain(box, v.chain, para);
  }
  if (v.footer) para(v.footer, "queried");
  const b = document.createElement("button");
  b.type = "button";
  b.className = "why-read";
  b.textContent = "Read again";
  b.title = "Ask chant again, for changes since this read.";
  b.addEventListener("click", again);
  box.appendChild(b);
}

/**
 * #682: the chain under the why, one entry per commit chant walked, each link
 * a row: what it is, chant's words for it, and the git line that opens its
 * source record with a copy button. A missing link is drawn as missing, in
 * the pending colour, with chant's reason.
 */
function paintChain(box, chain, para) {
  const t = document.createElement("div");
  t.className = "why-head";
  t.textContent = `chain, from work item to release${chain.more ? ` · ${chain.commits.length} of ${chain.commits.length + chain.more} commits` : ""}`;
  box.appendChild(t);
  for (const r of chain.reasons) para(r, "why-gap");
  if (chain.note) {
    para(chain.note, "why-gap");
    return;
  }
  const ul = document.createElement("ul");
  ul.className = "why-list why-chain";
  for (const c of chain.commits) {
    const li = document.createElement("li");
    const top = document.createElement("div");
    const sha = document.createElement("code");
    sha.textContent = c.sha;
    top.append(sha, c.subject ? ` ${c.subject}` : "");
    li.appendChild(top);
    for (const row of c.rows) {
      const el = document.createElement("div");
      el.className = row.missing ? "why-link why-missing" : "why-link";
      const label = document.createElement("span");
      label.className = "why-meta";
      label.textContent = `${row.label} `;
      el.append(label, row.text);
      if (row.meta) {
        const m = document.createElement("div");
        m.className = "why-meta";
        m.textContent = row.meta;
        el.appendChild(m);
      }
      if (row.source) {
        const src = document.createElement("div");
        src.className = "why-source";
        const line = document.createElement("code");
        line.textContent = row.source.open;
        line.title = row.source.title;
        const copy = actButton("copy", () => copyToClipboard(row.source.open, copy), `Copy the line that opens this link's source record:\n${row.source.open}`);
        src.append(line, copy);
        el.appendChild(src);
      }
      li.appendChild(el);
    }
    ul.appendChild(li);
  }
  box.appendChild(ul);
}

/** A member's box was picked: what the declaration says of it, and its why. */
function inspectMember(name) {
  const m = declaredMember(name);
  if (!m) return;
  const panel = document.getElementById("inspect-body");
  panel.innerHTML = "<h2>inspect</h2>";
  panel.dataset.node = `member:${name}`;
  const h = document.createElement("h3");
  h.textContent = "member";
  const dl = document.createElement("dl");
  for (const [k, v] of [["name", m.name], ["dir", m.dir], ["kind", m.kind]]) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
  panel.append(h, dl);
  renderWhySection(panel, { member: name });
}

const RESILIENCE_WORD = { survives: "survives", degrades: "degrades", fails: "fails" };

/**
 * The `behaviour` inspect section (#401, M4 of #397) — one entity's whole
 * block, as rows, with the provenance badge beside every figure.
 *
 * Every row here is the engine's claim, echoed. The currency is the engine's
 * (behold converts none), the traffic level is the string the engine named
 * (there is no default one), a headroom axis the engine did not report is
 * simply not a row, and `rightSize` appears only when the engine suggested
 * something. The badge on each figure says who stated it, to what tolerance,
 * and whether it was modeled from list prices or validated against a bill.
 */
function renderBehaviourSection(section, b) {
  if (!b) return;
  const meta = behaviourMeta();
  const one = [b];
  const add = section("behaviour");
  add("at", b.at.traffic);
  add("cost", figureWithBadge(fmtCost(b.cost.perHour, b.cost.currency), one, meta));
  const axes = [];
  if (typeof b.headroom.cpu === "number") axes.push(`cpu ${fmtHeadroom(b.headroom.cpu)}`);
  if (typeof b.headroom.latency === "number") axes.push(`latency ${fmtHeadroom(b.headroom.latency)}`);
  const worst = headroomOf(b);
  add("headroom", figureWithBadge(`${axes.join(" · ")} — colors on ${fmtHeadroom(worst)}`, one, meta));
  add("error rate", figureWithBadge(`${(b.errorRate * 100).toFixed(2)}% of requests at ${b.at.traffic}`, one, meta));
  add("resilience", figureWithBadge(`${RESILIENCE_WORD[b.resilience.verdict] || b.resilience.verdict} — ${b.resilience.failure}`, one, meta));
  if (b.resilience.note) add("resilience note", b.resilience.note);
  if (b.rightSize) add("right-size", figureWithBadge(b.rightSize.suggestion + (b.rightSize.reason ? ` — ${b.rightSize.reason}` : ""), one, meta));
}

function inspect(node) {
  const panel = document.getElementById("inspect-body");
  panel.innerHTML = "<h2>inspect</h2>";
  panel.dataset.node = node.id; // so async sections can verify this node is still shown
  const section = (title) => {
    const h = document.createElement("h3");
    h.textContent = title;
    panel.appendChild(h);
    const dl = document.createElement("dl");
    panel.appendChild(dl);
    return (k, v) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      setCell(dd, v);
      dl.append(dt, dd);
    };
  };

  const id = section("identity");
  id("id", node.id);
  id("kind", node.kind);
  id("lexicon", node.lexicon);
  const st = node.attrs && node.attrs._status;
  // Component-DAG live status (#57): `_liveStatus` is only ever set by
  // joinComponentStatus, so its presence picks the component-status label set
  // over the entity overlay's managed/foreign/pending.
  const liveStatus = node.attrs && node.attrs._liveStatus;
  // chant#2027: what the operating loop's last tick said about this component
  // (src/component-status.ts's joinTickVerdicts). Same component-status
  // vocabulary as `_liveStatus`, one tier lower and dated — so it picks the same
  // label set, and it may sit alongside a live verdict rather than replacing it.
  const tickStatus = node.attrs && node.attrs._tickStatus;
  // behold#146: a Helm chart's status is artifact presence, not management —
  // the join sets `_artifact` on a match, and every Helm::Chart in an overlay
  // went through it, so the kind alone is the reliable picker.
  const isArtifact = node.kind === "Helm::Chart";
  // The render-drift axis only ever repaints on drift (src/helm-drift.ts), so
  // a `warn` chart carrying a drifted verdict is drifted, not unhealthy — the
  // artifact vocabulary would say the wrong thing about the right colour.
  const renderDrift = node.attrs && node.attrs._renderDrift;
  const driftLabel = renderDrift && renderDrift.verdict === "drifted" ? RENDER_VERDICT_LABEL.drifted : undefined;
  if (st)
    id(
      "status",
      driftLabel ||
        (node.lexicon === "op" ? opStatusLabel(node) : undefined) ||
        (isArtifact ? ARTIFACT_STATUS_LABEL[st] : liveStatus || tickStatus ? COMPONENT_STATUS_LABEL[st] : statusLabel(st)) ||
        st,
    );
  if (node.attrs && node.attrs._artifact) {
    const a = node.attrs._artifact;
    if (a.release) id("release", a.release);
    if (a.status) id("release status", a.status);
    if (a.revision) id("revision", a.revision);
    if (a.chart) id("chart", a.chart);
    // The deploy's recorded render identity, read back off the ledger
    // (chant#2031, chant ≥ 0.54.0). Absent for a release no record names.
    if (a.inputDigest) id("input digest", shortDigest(a.inputDigest));
    if (a.contentDigest) id("content digest", shortDigest(a.contentDigest));
  }
  // chant#1168 (#1089): `_unobserved` carries WHY chant couldn't read this
  // entity's live state — only ever set alongside the entity overlay's
  // `_status: "neutral"` (never the component-status join's own, unrelated
  // `neutral` = "not deployed"), so it's safe to show unconditionally here.
  if (node.attrs && node.attrs._unobserved) id("unobserved reason", node.attrs._unobserved);
  // #234's free rider: an OperatorStack's Namespace/CronJob, named. The server
  // reads this off chant's own `app.kubernetes.io/*` labels (src/operator.ts) —
  // it is a declared fact, not a naming convention behold inferred.
  if (node.attrs && node.attrs._operator) {
    const o = node.attrs._operator;
    id("operating loop", o.role === "home" ? `home · namespace ${o.namespace}` : `converge tick · ${o.op}`);
    if (o.stack) id("operator stack", o.stack);
    if (o.schedule) id("tick schedule", o.schedule);
    if (o.ticks && o.ticks.length) id("hosted ConvergeOps", o.ticks.join(", "));
  }
  // chant#1180 (#1077): `runtimeOwner` is a first-class IR field (like
  // `ownership`/`physicalId`), not an `attrs` tag — the declared entity this
  // live, undeclared node's owner chain resolves to. Shown immediately from
  // the graph node itself, no diff fetch needed.
  if (node.runtimeOwner) id("runtime owner", node.runtimeOwner);
  if (node.sourceLoc && node.sourceLoc.file) id("source", node.sourceLoc.file);

  // #490: what terragucci's reports found about this card, each dated and
  // linked to its run. Not a status: the card's fill says nothing about it.
  const tgMarks = tgAnswer && tgAnswer.cards && tgAnswer.cards[node.id];
  if (tgMarks && tgMarks.length) {
    const h = document.createElement("h3");
    h.textContent = "terragucci reports (not live)";
    panel.appendChild(h);
    const now = new Date();
    for (const m of tgMarks) {
      const p = document.createElement("p");
      p.className = "tg-inspect";
      p.textContent = markLine(m, now) + " ";
      p.title = m.addresses.join("\n");
      p.appendChild(tgLink("report", tgHref(tgAnswer, m.run.report)));
      if (m.run.job_url) p.append(" · ", tgLink("job", m.run.job_url));
      if (m.run.pull_request_url) p.append(" · ", tgLink(`PR #${m.run.pull_request}`, m.run.pull_request_url));
      if (m.run.trace_url) p.append(" · ", tgLink("trace", m.run.trace_url));
      panel.appendChild(p);
    }
  }
  // #681: what the open change set would do to this card, entry by entry.
  const csEntries = csAnswer && csOn ? csEntriesFor(csAnswer, node.id) : [];
  if (csEntries.length) {
    const h = document.createElement("h3");
    h.textContent = csInspectHeading(csAnswer);
    panel.appendChild(h);
    for (const e of csEntries) panel.appendChild(csEntryEl(e));
  }
  // #683: the feature flags of this card's member, in the environment the Flags tab draws.
  const flRows = flAnswer && flOn ? flFlagsFor(flAnswer, nodeMember(node.id), flEnv) : [];
  if (flRows.length) {
    const h = document.createElement("h3");
    h.textContent = "feature flags";
    h.title = FL_NODES_NOTE;
    panel.appendChild(h);
    for (const r of flRows) {
      const row = panelDotRow(r.color, r.text, "");
      row.title = r.title;
      panel.appendChild(row);
    }
  }
  // #825: runtime health from chant lifecycle health, and a record's rotation.
  const hmInspect = hmAnswer && hmAnswer.env === view.env ? hmRows(hmAnswer, node.id) : [];
  if (hmInspect.length) {
    const add = section(`runtime health · ${hmAnswer.env}`);
    for (const [k, v] of hmInspect) add(k, v);
  }
  // #684: the in-flight work items colliding on this card.
  const coRows = coAnswer && coOn ? coFor(coAnswer, node.id) : [];
  if (coRows.length) {
    const h = document.createElement("h3");
    h.textContent = "colliding work";
    h.title = CO_NOTE;
    panel.appendChild(h);
    for (const r of coRows) {
      const row = panelDotRow(r.color, r.text, "");
      row.title = r.title;
      panel.appendChild(row);
    }
  }
  // #526: SQL Yodeler's drift on this card, each dated by its file.
  const yrMarks = yrJoined && yrJoined.cards[node.id];
  if (yrMarks && yrMarks.length) {
    const h = document.createElement("h3");
    h.textContent = "SQL Yodeler drift (from files, not live)";
    panel.appendChild(h);
    const now = new Date();
    for (const m of yrMarks) {
      const p = document.createElement("p");
      p.className = "tg-inspect";
      p.textContent = yrMarkLine(m, now);
      p.title = m.changes.map((c) => `${c.path || ""} ${c.kind || ""}: declared ${JSON.stringify(c.declared ?? null)}, live ${JSON.stringify(c.live ?? null)}`).join("\n");
      panel.appendChild(p);
    }
  }
  // #511: the newest apply's progress on this card, dated by the records read.
  const tgProg = tgCardProgress(tgProgress && tgProgress.cards && tgProgress.cards[node.id]);
  if (tgProg) {
    const h = document.createElement("h3");
    h.textContent = "terragucci apply progress (run view, not live)";
    panel.appendChild(h);
    for (const line of tgProgressLines(tgProg, new Date())) {
      const p = document.createElement("p");
      p.className = "tg-inspect";
      p.textContent = line;
      panel.appendChild(p);
    }
  }
  // #568: the reads this card's root makes or answers, from the pull
  // request's plan or the run view, dated by its run.
  const tgReadRoot = tgAnswer && !tgAnswer.error && tgRootOfCard(tgAnswer, node.id);
  const tgReads = tgReadRoot ? tgReadEdges(tgAnswerDrawn(), tgProgress).filter((e) => e.from === tgReadRoot || e.to === tgReadRoot) : [];
  if (tgReads.length) {
    const h = document.createElement("h3");
    h.textContent = "terragucci reads between roots (not live)";
    panel.appendChild(h);
    for (const e of tgReads) {
      const p = document.createElement("p");
      p.className = "tg-inspect";
      p.textContent = tgReadLine(e);
      panel.appendChild(p);
    }
  }
  // #506: the audit record's entries for this card's root (the record names
  // roots, never a resource), newest first.
  const tgRoot = tgTimeline && tgRootOfCard(tgAnswer, node.id);
  if (tgRoot) {
    const h = document.createElement("h3");
    h.textContent = "terragucci timeline (audit record)";
    panel.append(h, tgLane(tgTimeline, { root: tgRoot }));
  }

  // Containment hierarchy: a resource shows its parent chain UP (composite →
  // component); a collapsed composite (detail 1: `attrs.members` is a count)
  // shows its member list DOWN. The parent chain is on the node itself
  // (compositeInstance/compositeParent + the src/<component>/ path) — no fetch.
  const sp = ((node.sourceLoc && node.sourceLoc.file) || "").split("/");
  const component = sp[0] === "src" && sp[1] === "examples" ? "examples/" + (sp[2] || "") : sp[0] === "src" && sp.length >= 3 ? sp[1] : null;
  const isComposite = node.attrs && typeof node.attrs.members === "number";
  if (!isComposite && (node.compositeInstance || (component && node.kind !== "Component"))) {
    const bt = section("belongs to");
    if (component) bt("component", component);
    if (node.compositeInstance) bt("composite", node.compositeParent ? `${node.compositeInstance} · ${node.compositeParent}` : node.compositeInstance);
  }
  if (isComposite) {
    const h = document.createElement("h3");
    h.textContent = `members · ${node.attrs.members}`;
    panel.appendChild(h);
    const loading = document.createElement("p");
    loading.style.color = "var(--muted)";
    loading.textContent = "loading…";
    panel.appendChild(loading);
    const dl = document.createElement("dl");
    panel.appendChild(dl);
    const forId = node.id;
    getCompositeMembers(node.id).then((members) => {
      if (panel.dataset.node !== forId) return; // selection changed while loading
      loading.remove();
      if (!members.length) {
        loading.textContent = "(no members found)";
        panel.insertBefore(loading, dl);
        return;
      }
      for (const m of members) {
        const dt = document.createElement("dt");
        dt.textContent = m.kind;
        const dd = document.createElement("dd");
        dd.textContent = m.id;
        dl.append(dt, dd);
      }
    });
  }

  // #881: trace the way in to a network card, or a workload behind one.
  if (!view.components && /^(AWS::(ECS|EC2|ElasticLoadBalancingV2|Lambda|RDS)::|GCP::(Run|Compute)::|Microsoft\.App\/)/.test(node.kind || "")) {
    panel.appendChild(actButton("trace from outside to here", () => traceTo(node.id), "Follow traffic from the internet to this card, hop by hop"));
  }
  // #877: a stack opens here: the cards it holds, each with its state.
  if (Array.isArray(node.attrs && node.attrs._stackOf)) {
    const h = document.createElement("h3");
    h.textContent = `stacked · ${node.attrs._stackOf.length}`;
    panel.appendChild(h);
    const dl = document.createElement("dl");
    for (const m of node.attrs._stackOf) {
      const dt = document.createElement("dt");
      dt.textContent = m.status ? STATUS_LABEL[m.status] || m.status : "card";
      const dd = document.createElement("dd");
      dd.textContent = m.id;
      dl.append(dt, dd);
    }
    panel.appendChild(dl);
    panel.appendChild(actButton("draw them all", () => { view.alike = false; load(); }, "Turn stacking off and draw every card"));
  }
  if (typeof (node.attrs && node.attrs._usedBy) === "number") {
    const p = document.createElement("p");
    p.style.color = "var(--muted)";
    p.textContent = `${node.attrs._usedBy} cards refer to this one; their lines are left out while alike cards are stacked.`;
    panel.appendChild(p);
  }

  // #471: why this card is the way it is, read from chant when asked. A
  // stack (#877) is behold's, not chant's, so it has no why of its own.
  if (!Array.isArray(node.attrs && node.attrs._stackOf)) renderWhySection(panel, { node: node.id });

  // #401: the behaviour block, field by field, with a badge on every figure.
  // The colour on the card carries one number at a time (whichever mode is
  // picked) and carries it as a hue; this is where the engine's whole
  // statement about this entity is legible — and where a figure without its
  // provenance would be visible as the contract violation it is.
  renderBehaviourSection(section, blockOf(node));
  // #402: what the FILE says this entity costs, beside what the account does.
  // On a card the account no longer holds this is the only behaviour row, and
  // it says so rather than reading as the card's cost.
  const declared = node.attrs && node.attrs._behaviourDeclared;
  if (declared && declared.cost) {
    const add = section("behaviour · declared");
    add("cost", figureWithBadge(fmtCost(declared.cost.perHour, declared.cost.currency), [declared], behaviourMeta()));
    if (!blockOf(node)) add("live", "no live figure — the prediction of the account does not include this entity");
  }

  // Render diff (#146's deferred half): what `chant helm diff <digest> <env>
  // --live --json` said about this chart's PINNED render. Never rely on the
  // colour alone (#57's accessibility note) — and here that matters twice
  // over, because `in-sync` and `unobserved` don't move the colour at all, so
  // this section is the only place they're reported.
  if (renderDrift) renderDriftSection(section, renderDrift);

  // Live state: what chant observed in the cloud. Only managed (provisioned)
  // nodes carry it — pending nodes have none because they aren't deployed yet.
  if (node.physicalId || node.ownership) {
    const live = section("live");
    if (node.physicalId) live("physical id", node.physicalId);
    if (node.ownership) live("ownership", ownershipLabel(node.ownership)); // #396 item 5: the estate's own word for it
  } else if (liveStatus) {
    // The colour alone doesn't carry chant's verdict or its reasoning — spell
    // both out here (never rely on the node's colour alone, #57 accessibility
    // note): reconciliation is the raw `chant components status` verdict
    // (reconciled/unrecorded/stale/drifted/unknown), detail is chant's own
    // human-readable explanation. M2 (#54, chant 0.18.29): when present, the
    // raw stack — the actual signal the palette painted from — backs it up
    // with the provider-native fact (e.g. loom-db's UPDATE_ROLLBACK_COMPLETE).
    const live = section("live status");
    live("reconciliation", liveStatus.reconciliation);
    if (liveStatus.detail) live("detail", liveStatus.detail);
    if (liveStatus.stack) {
      live("stack", liveStatus.stack.name);
      if (liveStatus.stack.status) live("stack status", liveStatus.stack.status);
      if (liveStatus.stack.healthy !== undefined) live("healthy", String(liveStatus.stack.healthy));
    }
  } else if (st === "accent" && node.lexicon !== "op") {
    // The `op` lexicon is excluded because nothing in the ops lens (#284) is an
    // estate entity: `accent` there means "may not fire at all" — an effect step
    // whose receipt already matches, a converge rule that dispatches only on a
    // tick that matches it (#234) — and "not provisioned yet" would be an answer
    // to a question the card never asked.
    const live = section("live");
    live("", "not provisioned yet (pending) — no live state");
  } else if (st === "runtime") {
    // chant#1180 (#1077): a runtime child rarely carries physicalId/ownership
    // today (it's not chant-owned in the marker sense), so make sure
    // something explains the node rather than showing an empty "live" gap.
    const live = section("live");
    live("", `runtime child — owned by ${node.runtimeOwner || "its declared parent"}, not itself declared`);
  }

  // What the operating loop's last tick said about this component (chant#2027).
  // Its own section, never folded into "live status": a tick is dated, and the
  // date is the point. Shown alongside a live verdict when there is one — the
  // two can disagree, and which is newer is the reader's to see, not behold's to
  // resolve. The heading itself carries the age, and a tick too old to have
  // painted says so in words rather than leaving its verdict to be read as now.
  if (tickStatus) {
    const ago = tickStatus.at ? waitingFor(tickStatus.at) : null;
    const tick = section(`converge tick${ago ? ` · ${ago} ago` : ""}${tickStatus.stale ? " · not painted" : ""}`);
    tick("reconciliation", tickStatus.reconciliation);
    if (tickStatus.detail) tick("detail", tickStatus.detail);
    if (tickStatus.live !== undefined) tick("observed live", String(tickStatus.live));
    if (tickStatus.unobserved) {
      tick("unobserved", tickStatus.unobserved.detail ? `${tickStatus.unobserved.reason} — ${tickStatus.unobserved.detail}` : tickStatus.unobserved.reason);
    }
    tick("recorded by", tickStatus.env ? `${tickStatus.op} (${tickStatus.env})` : tickStatus.op);
    tick("at", tickStatus.at);
    if (tickStatus.tickId) tick("tick", tickStatus.tickId);
    if (tickStatus.stale) {
      tick("", "older than the operator's own cadence allows for — this verdict is history, so no color was taken from it");
    }
  }

  // chant#2040: the Terraform address this chant entity was carved out of —
  // the manifest names the file, `chant graph` names the file, and the join is
  // a byte comparison (src/carve-manifest.ts `joinCarvedSources`).
  const carve = node.attrs && node.attrs._carve;
  if (carve) {
    const cf = section("carved from");
    cf("terraform", carve.tfType ? `${carve.target} (${carve.tfType})` : carve.target);
    cf("stage", carve.graduated ? "graduated — chant owns it" : `${carve.stage} — Terraform still owns it`);
    if (carve.at) cf("at", carve.at);
    if (carve.from) cf("estate", carve.from);
    cf("emitted as", carve.file);
  }

  // chant#2022: what an Op step touches in the estate, as the op.json states it
  // and as the lens resolved it — a resolved value names the card it joined
  // to; an unresolved one is stated as such, never guessed at (src/ops-lens.ts
  // `joinStepEntities`).
  const entityLinks = node.attrs && node.attrs._entityLinks;
  if (entityLinks) {
    const touches = section("touches");
    for (const r of entityLinks.resolved || []) touches(r.value, `${r.node} (${r.via === "id" ? "by id" : "by attribute value"})`);
    for (const v of entityLinks.unresolved || []) touches(v, "no estate node carries this value — not linked");
  }
  // The other end of the same edge: an estate card copied into the ops lens
  // because a step names it.
  const touchedBy = node.attrs && node.attrs._touchedBy;
  if (Array.isArray(touchedBy) && touchedBy.length) {
    const by = section("touched by");
    for (const step of touchedBy) by("step", step);
  }

  // The recorded release (#165, #61's second clause): the ledger row behold
  // reads on `chant components status` and, until now, read past. Its own
  // section beside "live status", because the two answer different questions
  // — what is running versus what was recorded putting it there — and the
  // reconciliation verdict above is exactly their comparison. The run is a link
  // only when the record itself carries an address (chant#2045); a bare id
  // gets its reason, never a guessed forge (web/release.js).
  const release = node.attrs && node.attrs._release;
  if (release) {
    const rel = section("release");
    for (const [k, v] of releaseRows(release)) {
      if (v && typeof v === "object" && v.href) {
        const a = document.createElement("a");
        a.href = v.href;
        a.textContent = v.text;
        a.target = "_blank";
        a.rel = "noreferrer noopener";
        a.title = `${v.href} — the address the release record itself carries (chant#2045). behold never invents this link.`;
        rel(k, a);
      } else {
        rel(k, v);
      }
    }
    // #899: a run that ended after this release and did not pass, from chant's run index.
    const since = node.attrs._runSince;
    if (since) {
      rel("since", `${since.job} ${since.status === "fail" ? "failed" : since.status} at ${since.commit.slice(0, 12)}`);
      rel("", `run ${since.runId}, ended ${since.ended}, ${since.member ? `for ${since.member}` : "for the whole workspace"}. A release records only a success, so this is what came after it.`);
    }
  }

  // Declared attributes — the source-of-truth values / cross-resource refs.
  // The `release` chip is the card's abbreviation of the section above, not a
  // declared value, so it stays out of this list when the section rendered.
  const attrKeys = Object.keys(node.attrs || {}).filter((k) => !k.startsWith("_") && !((k === "release" || k === "since") && release));
  if (attrKeys.length) {
    const decl = section("declared");
    // #393 item 10: a choudoufu card that can be adopted leads with the write
    // that does it — the two marker tags choudoufu named (`adopt_tofu_estate` /
    // `adopt_tofu_address`), or its own one-line command when it sends one.
    // behold composes neither (src/choudoufu-live.ts); this puts the line
    // first and makes it copyable, the way the moves panel already does for a
    // `live-mv` line. The paragraph explaining the omission follows.
    //
    // #413: both kinds reach here now. An UNOWNED row carries the marker pair,
    // and an adoptable one carries choudoufu's own command — so the tooltip
    // says which of the two this is rather than claiming tags either way.
    const adoptable = node.lexicon === "choudoufu" && typeof node.attrs.adopt === "string" ? "adopt" : null;
    if (adoptable) {
      const isCommand = /\s/.test(node.attrs.adopt.trim()) && !node.attrs.adopt.startsWith("tofu-estate=");
      copyableRow(decl, adoptable, node.attrs.adopt,
        isCommand ? "Copy the command that adopts this object" : "Copy the tags that adopt this object");
    }
    for (const k of attrKeys) {
      if (k === adoptable) continue;
      decl(k, fmtValue(node.attrs[k]));
    }
  }

  // #554: references from this card to a target the project does not declare
  // (chant#3912's `ir.dangling`), with the value as written. No edge is drawn
  // for any of them, so this is the one place they show.
  const dangling = danglingFor(lastGraphIr, node.id);
  if (dangling.length) {
    const row = section(danglingHeading(dangling));
    for (const [k, v] of danglingRows(dangling)) row(k, v);
    const p = document.createElement("p");
    p.style.color = "var(--muted)";
    p.textContent = DANGLING_EXPLAINED;
    panel.appendChild(p);
  }

  // CI projection facet (M1.2, #56/#58): loomster's GitLab CI is the SAME
  // component DAG projected — waves = stages, components = jobs, `dependsOn` =
  // `needs:`. Read one way it's the deployment, read the other it's the
  // pipeline. A read-only per-node detail hanging off the component by name —
  // no topology change. Only present for component nodes, and only once the
  // facet loaded (component-DAG mode; see loadCi()).
  const job = node.kind === "Component" ? ciByComponent.get(node.id) : undefined;
  if (job) {
    // The heading names the forge the pipeline was actually generated for
    // (#164) — it used to say GitLab whatever the project targeted.
    const ci = section(`CI (${{ gitlab: "GitLab", github: "GitHub Actions", forgejo: "Forgejo" }[ciForge] || ciForge || "pipeline"})`);
    // #571: a terragucci repo's declared job names the job and its wave; a
    // chant-generated pipeline names a stage and the script it runs.
    if (job.jobName) ci("job", job.jobName);
    if (job.wave !== undefined) ci("wave", String(job.wave));
    if (job.stage) ci("stage", job.stage);
    ci("needs", job.needs.length ? job.needs.join(", ") : "(none)");
    if (job.alsoIn && job.alsoIn.length) ci("also in", job.alsoIn.join(", "));
    if (job.script) ci("runs", job.script.length ? job.script.join(" && ") : `chant run --components ${node.id}`);
    // The last pipeline run of this session, when one touched this component
    // (#164) — the server joins it as `_ciJob`/`ci` on the node.
    if (node.attrs && node.attrs._ciJob) ci("last run", `${node.attrs._ciJob}: ${node.attrs.ci}`);
  }

  // Resources facet (#59 unify) — a best-effort slice of the DoD's "its
  // stack, and its resources": the AWS resources declared under this
  // component's own source directory (see loadResources(); src/server.ts
  // `/api/resources` documents why this is resources-by-source-location, not
  // a literal CFN stack lookup, and a pre-existing chant gap — verified
  // against loomster/Floci — that leaves physicalId/ownership usually empty
  // even in live mode: kind/id are always the real declared shape; treat
  // physicalId as a bonus when chant happens to supply it, not a given).
  const resources = node.kind === "Component" ? resourcesByComponent[node.id] : undefined;
  if (resources) {
    const res = section("resources");
    if (!resources.length) {
      res("", terragucciComponentsRepo ? "(none in this component's root)" : "(none found under this component's source directory)");
    } else {
      for (const r of resources) {
        res(r.kind, r.physicalId ? `${r.id} (${r.physicalId})` : r.id);
      }
    }
  }

  // A foreign node on a live-import substrate can be pulled into typed source:
  // Adopt triggers the ReconcileOp (cloud → code), which opens a reviewable PR.
  // behold never writes source — a human merges. Managed/pending nodes and
  // substrates with no live-import path show nothing.
  if (adoptable(node) && !previewMode) {
    const b = button("Adopt", "", () => runOp(adopt.reconcile.name));
    b.title = `Reconcile ${node.id} into source via ${adopt.reconcile.name} (opens a PR)`;
    const wrap = document.createElement("p");
    wrap.style.marginTop = "12px";
    wrap.appendChild(b);
    panel.appendChild(wrap);
  }

  // Live state for this node (#27/#30): a node that's already been observed
  // (managed=good or foreign=warn — that's why it's coloured) auto-loads its
  // observed state + drift, so a click shows it without a second click. Cached
  // per node (loadNodeDiff) so re-clicks are instant. A live diff is a build +
  // cloud query, so we only fire it for observed nodes, and never in static.
  //
  // chant#1168 (#1089): the entity overlay's `neutral` means "chant couldn't
  // read this" — worth a diff fetch too, since `/api/diff`'s `unobserved`
  // entries carry the richer reason/detail this panel can show (see
  // renderDiff). Guarded to `!liveStatus` so this doesn't also fire for the
  // component-status join's unrelated `neutral` ("not deployed" — no entity
  // name for `/api/diff` to match against).
  // chant#1180 (#1077): `runtime` is worth a diff fetch too — `/api/diff`'s
  // `observed` map already carries a runtime child (chant's describeResources
  // reports it the same as any other resource it found), and its own
  // `fieldDrift` may apply too on a substrate with per-field ownership.
  const observed = st === "good" || st === "warn" || st === "runtime" || (st === "neutral" && !liveStatus && !tickStatus);
  if (view.env && observed) {
    const forId = node.id;
    const loading = document.createElement("p");
    loading.style.cssText = "color:var(--muted);margin-top:12px";
    loading.textContent = "loading live state…";
    panel.appendChild(loading);
    loadNodeDiff(node.id).then((j) => {
      if (panel.dataset.node !== forId) return; // reselected while loading
      loading.remove();
      if (!j) {
        const p = document.createElement("p");
        p.style.cssText = "color:var(--muted);margin-top:12px";
        p.textContent = "live state unavailable";
        panel.appendChild(p);
        return;
      }
      renderObserved(panel, j.observed, j.health, j.healthDetail); // #30 observed state + #26/#226 health
      renderDiff(panel, j.diff); // #27 — drift since snapshot
      renderFieldDrift(panel, j.fieldDrift); // #87 — field-level (per-manager) drift
    });
  }
}

// Bulk per-node live state — ONE `chant lifecycle diff --live` sliced for every
// node (/api/diff), fetched once per env and cached, so inspecting an observed
// node is instant (no per-node query). Via apiFetch, so a static export replays
// the captured snapshot. Cache is per env; cleared on lens change / after an op.
let bulkDiffCache = null; // { env, nodes: { <id>: { observed, diff, health } } }
// #404: ONE-SHOT. Set by the "Re-check live with plan" palette row and cleared
// by the request that carries it, so `plan=1` is exactly as opt-in as the
// person's keystroke — an ordinary load, a lens change or a reconnect never
// spawns a plan. The server still serves the change set that read produced
// from its own cache on the loads that follow, so the drift stays on screen
// without anyone paying for a second full pass over the account.
let planDriftOnce = false;
// #910: ONE-SHOT, the same way: set by "Read the plan on the Terraform roots",
// consumed by the source-graph load that carries `plan=1`.
let terraformPlanOnce = false;
async function loadNodeDiff(id) {
  if (publicMode) return null; // #569: /api/diff is refused in a public view
  if (!bulkDiffCache || bulkDiffCache.env !== view.env) {
    bulkDiffCache = null;
    try {
      const res = await apiFetch(`/api/diff?env=${encodeURIComponent(view.env)}`);
      if (res.ok) bulkDiffCache = await res.json();
    } catch {
      /* leave null → empty below */
    }
    if (!bulkDiffCache || !bulkDiffCache.nodes) bulkDiffCache = { env: view.env, nodes: {} };
  }
  return bulkDiffCache.nodes[id] || null;
}

const HEALTH_COLOR = {
  healthy: "var(--managed)",
  progressing: "var(--pending)",
  degraded: "var(--degraded)",
  unknown: "var(--muted)",
};

// Render a node's observed live state (#30) + health verdict (#26).
function renderObserved(panel, o, health, healthDetail) {
  if (!o) return; // pending/foreign nodes have no observed record in the diff
  const h = document.createElement("h3");
  h.textContent = "observed";
  panel.appendChild(h);
  const dl = document.createElement("dl");
  const add = (k, v, color) => {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    setCell(dd, v);
    if (color) dd.style.color = color;
    dl.append(dt, dd);
  };
  // Health first — the "is it well?" verdict, distinct from drift. Absent when
  // the substrate reports no status (not fabricated).
  // #226: for an Argo Application or a Flux object the verdict comes from the
  // controller's own conditions, and `healthDetail` is the sentence it read
  // there — `Ready=False (BuildFailed)`, `health=Degraded, sync=OutOfSync`.
  // Appended to the verdict rather than given its own row, because it is the
  // same claim said precisely.
  if (health && health !== "unknown") {
    add("health", healthDetail ? `${health} — ${healthDetail}` : health, HEALTH_COLOR[health]);
  }
  if (o.type) add("type", o.type);
  if (o.status) add("status", o.status, HEALTH_COLOR[health] || undefined);
  if (o.physicalId) add("physical id", o.physicalId);
  if (o.ownership) add("ownership", ownershipLabel(o.ownership)); // #396 item 5: same, off /api/diff
  if (o.lastUpdated) add("last updated", o.lastUpdated);
  // What the object's own controller says is wrong with it (#86, chant#1401).
  // Placed with health and status rather than among the attributes below,
  // because it is the line that says what to DO: `Unschedulable` is the reason,
  // "0/3 nodes are available: 1 node(s) had untolerated taint" is the answer.
  // chant only sends conditions that are NOT in their happy state, so anything
  // here is worth reading; the field is absent on every substrate that records
  // none.
  const conditions = o.attributes?.conditions;
  if (Array.isArray(conditions)) {
    // Usually chant sends these pre-rendered as sentences; a substrate that
    // sends the raw condition object gets the tree instead of `[object Object]`.
    for (const c of conditions) add("condition", valueCell(c), "var(--degraded)");
  }
  // #393 item 10: the adoption line is a line to run, here as in the declared
  // section — first, and with the same copy button.
  if (typeof o.attributes?.adopt === "string") copyableRow(add, "adopt", o.attributes.adopt, "Copy the tags that adopt this object");
  // #259: an observed attribute is whatever the substrate reported — a k8s
  // `spec`, a nested `loadBalancer`, an array of ports. All of it collapsible
  // now, instead of one flat JSON.stringify line per key.
  for (const [k, v] of Object.entries(o.attributes || {})) {
    if (k === "conditions") continue; // rendered above, one line each
    if (k === "adopt" && typeof v === "string") continue; // led with, above
    add(k, valueCell(v));
  }
  panel.appendChild(dl);
}

const DIFF_LABEL = {
  drifted: "drifted since snapshot",
  // #404: a choudoufu member has no snapshot to drift FROM — the category is
  // what a plan says it would do to the live object right now, so it does not
  // borrow chant's "since snapshot" wording. The rows underneath are the same
  // `{path, oldValue, newValue}` triples, printed `before → after`.
  planned: "the plan would change this",
  missing: "declared, not in cloud",
  orphan: "in cloud, not declared",
  disappeared: "gone since snapshot",
  newlyObserved: "live — no snapshot baseline",
  unchanged: "in sync",
  // chant#1168 (#1089): its own category — chant couldn't read this entity's
  // live state at all, so this is neither drift nor a confirmed absence.
  unobserved: "chant could not read live state",
  // chant#1180 (#1077): its own category too — expected runtime, never drift
  // and never orphan/adopt.
  runtime: "expected runtime child",
};

// Render a node's live-diff into the inspect panel (#27).
function renderDiff(panel, diff) {
  const h = document.createElement("h3");
  h.textContent = "drift";
  panel.appendChild(h);
  if (!diff) {
    const p = document.createElement("p");
    p.style.color = "var(--muted)";
    p.textContent = "not present in the live diff";
    panel.appendChild(p);
    return;
  }
  const cat = document.createElement("p");
  cat.textContent = DIFF_LABEL[diff.category] || diff.category;
  panel.appendChild(cat);
  // chant#1620 (#192): where the live read actually looked — the line that
  // separates "not there" from "looked in the wrong place" (a declared k8s
  // object with no namespace reads from the DEFAULTED namespace, and only
  // this address makes that visible). Monospace so a request path scans.
  if (diff.queried) {
    const q = document.createElement("p");
    q.className = "queried"; // mono + muted, styled with the rest of the pane's scale
    q.textContent = `queried: ${diff.queried} → ${diff.category === "missing" ? "not found" : "read failed"}`;
    panel.appendChild(q);
  }
  // chant#1168 (#1089): show WHY chant couldn't look, instead of the
  // "no field changes" text below — that phrasing implies a comparison ran
  // and found nothing, which is exactly the wrong read for a hole in the
  // observation.
  if (diff.category === "unobserved") {
    const p = document.createElement("p");
    p.style.color = "var(--muted)";
    p.textContent = diff.unobservedReason
      ? `reason: ${diff.unobservedReason}${diff.unobservedDetail ? " — " + diff.unobservedDetail : ""}`
      : "chant did not report why";
    panel.appendChild(p);
    return;
  }
  // chant#1180 (#1077): never call this "drift" — it's the runtime doing its
  // job (a Pod its Deployment created); deleting it just gets it recreated.
  if (diff.category === "runtime") {
    const p = document.createElement("p");
    p.style.color = "var(--runtime)";
    p.textContent = diff.runtimeOwner
      ? `owned by ${diff.runtimeOwner} — created by its controller, not drift`
      : "created by its controller, not drift";
    panel.appendChild(p);
    return;
  }
  if (!diff.changes.length) {
    const p = document.createElement("p");
    p.style.color = "var(--muted)";
    p.textContent =
      diff.category === "newlyObserved"
        ? "no field diff yet — take a snapshot (chant lifecycle snapshot) to track changes"
        : "no field changes";
    panel.appendChild(p);
    return;
  }
  const dl = document.createElement("dl");
  for (const ch of diff.changes) {
    const dt = document.createElement("dt");
    dt.textContent = ch.path;
    const dd = document.createElement("dd");
    // #259: a drifted `spec` used to be two flat JSON blobs either side of an
    // arrow; now each side is its own collapsible tree with its own copy.
    setCell(dd, pairCell("was", ch.oldValue, "now", ch.newValue, { arrow: true }));
    dl.append(dt, dd);
  }
  panel.appendChild(dl);
}

// Field-level ownership colouring (#87, chant#1076/#1181): per-field drift
// derived from k8s managed-fields pruning — additive, only present when
// chant's `lifecycle diff --live --json` carried a `deep` section for this
// entity's lexicon (src/diff.ts's `nodeFieldDrift`). `null` on a substrate/
// chant with no deep reader — the whole-object `drift` section above is
// unaffected, per #87's fallback acceptance criterion.
//
// chant's wire contract doesn't carry a field-MANAGER name (which manager
// currently owns a path) — only whether the path is `changed` (a real
// deviation from what chant declared, whether purely chant-owned or
// contested by a foreign manager — chant's own pruning already drops a
// confidently foreign-owned, undeclared field before this ever runs),
// `undeclared` (present live, chant's source says nothing about it — the
// closest available signal to "foreign"), or `absent` (declared, not present
// live). These three are the closest honest mapping to "chant-owned vs
// foreign vs contested" the current wire data supports.
const FIELD_KIND_LABEL = { changed: "drifted", undeclared: "foreign (not declared)", absent: "declared, not present live" };
const FIELD_KIND_COLOR = { changed: "var(--degraded)", undeclared: "var(--foreign)", absent: "var(--muted)" };

function renderFieldDrift(panel, fieldDrift) {
  if (!fieldDrift) return; // no lexicon in this diff ran a deep (field-level) read
  if (!fieldDrift.drifted.length && !fieldDrift.accepted.length) return; // deep ran, nothing to report for this node
  const h = document.createElement("h3");
  h.textContent = "field ownership";
  panel.appendChild(h);
  const dl = document.createElement("dl");
  for (const ch of fieldDrift.drifted) {
    const dt = document.createElement("dt");
    dt.textContent = ch.path;
    dt.style.color = FIELD_KIND_COLOR[ch.kind] || "";
    const dd = document.createElement("dd");
    // The owning manager (#87, chant#1189) leads, because it is the part that
    // decides what to do about the field: `hpa-controller` holding
    // `spec.replicas` is a controller doing its job; `kubectl-client-side-apply`
    // holding it is somebody editing around the pipeline. Both are `changed`.
    // Absent on every substrate but k8s, where the line reads as it always did.
    const owned = ch.owner ? `owned by ${ch.owner} — ` : "";
    setCell(dd, pairCell("declared", ch.declared, "live", ch.live, { lead: `${owned}${FIELD_KIND_LABEL[ch.kind] || ch.kind}` }));
    dl.append(dt, dd);
  }
  for (const ch of fieldDrift.accepted) {
    const dt = document.createElement("dt");
    dt.textContent = ch.path;
    dt.style.color = "var(--muted)";
    const dd = document.createElement("dd");
    setCell(dd, pairCell("baseline", ch.baseline, "live", ch.live, { lead: "accepted deviation" }));
    dl.append(dt, dd);
  }
  panel.appendChild(dl);
}

function wire(ir) {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const host = document.getElementById("graph");
  for (const g of host.querySelectorAll("[data-node-id]")) {
    const node = byId.get(g.getAttribute("data-node-id"));
    if (!node) continue;
    g.style.cursor = "pointer";
    g.addEventListener("click", () => {
      if (panMoved) return; // a drag-pan ended here — don't also select
      host.querySelectorAll(".sel").forEach((n) => n.classList.remove("sel"));
      g.classList.add("sel");
      inspect(node);
      // On a phone the pane is folded under the graph; a tap on a card is asking for it.
      if (onPhone()) document.getElementById("app").classList.remove("inspect-collapsed");
      noteSelection(node.id);
      // #254: in carve mode a click is also the walkthrough's Pick step — the
      // inspect pane already shows the score arithmetic the lens spelled out,
      // and the stepper picks up the same node.
      carvePick(node);
    });
    // A double-click goes one zoom finer, at the fit.
    g.addEventListener("dblclick", (e) => {
      const next = DRILL[zoomValue()];
      if (panMoved || !next || !availableZooms().some(([, z]) => z === next)) return;
      e.preventDefault();
      applyZoom(next);
      renderStatusbar();
      load();
    });
  }
  // #475/#476: a member's box picks the member. Only boxes that are members
  // (a wave or a VPC box is not one), and only a click on the box itself, not
  // on a card inside it or after a drag-pan.
  const members = new Set(ir.nodes.map((n) => nodeMember(n.id)).filter(Boolean));
  for (const rect of host.querySelectorAll("rect[data-group-id]")) {
    const id = rect.getAttribute("data-group-id");
    if (!members.has(id)) continue;
    rect.addEventListener("click", (e) => {
      if (panMoved || e.target !== rect) return;
      host.querySelectorAll(".sel").forEach((n) => n.classList.remove("sel"));
      selectedNodeId = null;
      view.member = id;
      renderStatusbar();
      inspectMember(id);
      embedSelected(id, null);
    });
  }
}

// View state driven by the ⌘K palette's lens commands (#17, moved off the
// header pickers in #73 — see paletteCommands()). env=null → the declared
// source graph; env set → the live overlay for that env (needs cloud creds).
// detail is chant's --detail tier. components (#56) toggles the component-DAG
// projection (nodes=components, wave-laned, dependsOn edges) in place of the
// AWS entity graph. With an env picked too, components mode gets its own live
// status join (#57, per-component AWS reconciliation) instead of the entity
// overlay — see load()'s endpoint choice. tier/target (M2, #54) are the two
// new lenses: a picked tier overrides LOOM_TIER, a picked target overrides
// AWS_ENDPOINT_URL, for every chant shell-out this page's fetches trigger (see
// lensParams()). stack (#76, follow-up to #71) is a THIRD kind of lens: a
// multi-stack project's `chant.config.ts` `stacks[]` names an independently-
// deployed source tree — picking one re-points the graph at that stack's
// source (chant.ts's `graphPath`), not an env override like tier/target.
// null on a project that declares no `stacks[]` at all — the picker (and the
// status strip's stack tag) then never renders. Every fetch reads this, so
// the `changed` SSE re-pull and a palette lens change go through the same path.
// member (#475) is the estate member the view is on: a host opens behold with
// ?member=, and picking a card or a member box moves it. It changes no fetch;
// the graph is the whole estate, framed on that member's box.
// q, snapshot (#913, #914): the question the view asks and the recorded snapshot it reads. Carried in the URL and
// moved by an agent; nothing draws q until #913's search read lands.
const view = { member: null, env: null, gates: null, focus: null, run: null, q: null, snapshot: null, plan: false, countBy: null, detail: 2, components: true, logical: false, runtime: false, ops: false, tier: null, target: null, stack: null, radial: false, collapse: false, alike: true, compareTo: null };

// #182: `components` is the boot default, but a project that declares no
// components renders it as ZERO nodes — the first screen was a blank graph
// pane with only a statusbar note explaining. True exactly once, consumed by
// load(): an empty first components fetch falls back to the resources zoom
// before anything is painted. An explicit later pick of "components" (panel
// or ⌘K) still shows the honest empty view + the server's note.
let autoZoomFallback = true;

// #393 item 1: for an estate whose members are NONE of them chant projects, the
// fallback above is a round-trip too late and one degree too vague. The
// components zoom is a chant projection of a chant project's own component DAG;
// a choudoufu estate or a bare Terraform directory has no components to
// project, so the first screen was "the components lens doesn't apply to a
// composed estate yet" — an apology, every time, before the person had picked
// anything. The kinds come from /api/project (`memberKinds`, in composition
// order), so the decision is made from what the server already knows rather
// than from a zero-node answer. A chant member anywhere in the estate keeps
// #182's behaviour exactly, and picking components later still shows the note.
//
// #571: a terragucci repo that declares its roots as components
// (`terragucci.components.json`, /api/project's `terragucciComponents`) does
// have a components picture, so it opens there whatever its member kind.
function bootZoom(memberKinds, terragucciComponents, componentsDeclared) {
  if (terragucciComponents) return "components";
  // #897: an estate whose members declare no component has no components picture.
  if (componentsDeclared === false) return "resources";
  return memberKinds && memberKinds.length && !memberKinds.includes("chant") ? "resources" : "components";
}

// v0.1.0 preview lock (set from /api/project in initActions): hides the git/PR
// write ops (Rollback, Sync, Adopt, Run ▾) — the server also 403s them. Local
// deploy (Apply all / dial), Reset, Bring up, Approve, and reads stay on.
let previewMode = publicMode; // #569: a public view hides what preview hides, and more
// #489: set when /api/project says the repo is a terragucci repo — applied by
// its pipeline only, so the page offers no write at all.
let terragucciRepo = null;

// The unified "zoom" control (one granularity axis, coarse → fine). Underlying
// state stays (components, detail); zoom is just the single knob the header
// exposes, mapping "components" → the wave/component view and composites/
// resources/attributes → the entity graph at detail 1/2/3. (detail 0 / per-
// lexicon "stacks" is dropped from the UI — niche; the API still accepts it.)
// "logical" (#63) is a re-projection, not a granularity stop like the others —
// a traditional AWS architecture diagram: nested VPC/subnet ⊃ component boxes.
// region/VPC/subnet boxes with topology nodes only — but it rides the same dial
// as the coarse "infrastructure overview" the way a traditional AWS diagram sits
// beside the resource views.
const ZOOM_OPTS = [
  ["zoom: components", "components"],
  ["zoom: logical", "logical"],
  ["zoom: composites", "composites"],
  ["zoom: resources", "resources"],
  ["zoom: attributes", "attributes"],
  // Below the declaration boundary (#86): the owner-referenced children the
  // cluster maintains — the Pods under a Deployment. Its own stop rather than a
  // detail level, because it is a different axis: every tier above shows what
  // you declared, and this one shows what your declaration produced.
  ["zoom: runtime", "runtime"],
  // The ops lens (#284): the project's declared Ops — the phase track of each
  // `dist/ops/<name>/op.json`. Off the granularity axis entirely (an Op is
  // neither coarser nor finer than a resource; it's a different artifact of the
  // same chant source), so it sits last, and only appears when the served
  // estate has actually emitted Ops — `opsAvailable`, from /api/project.
  ["zoom: ops", "ops"],
  // The apply order (#426): the cross-stack ordering chant already computes at
  // synthesis — which lexicon partition must apply before which. A different
  // axis again, like `ops`: neither coarser nor finer than a resource, and the
  // only stop whose edges are about TIME rather than reference. Single-project
  // only and gated on `stacksCapable`, because two members' `aws` stacks are
  // not one stack.
  ["zoom: apply order", "stacks"],
];
const ZOOM_DETAIL = { composites: 1, resources: 2, attributes: 3, runtime: 3 };
/** How many emitted Ops the served estate has (0 = the stop doesn't exist).
 * Seeded from /api/project in initPickers(). */
let opsAvailable = 0;
/** #393 item 2: whether ANY served member could have owner-referenced children
 * — /api/project's `runtimeCapable`, decided from the members' declared
 * lexicons (src/server.ts's RUNTIME_LEXICONS). Before this the stop needed only
 * an env, so every choudoufu estate (which declares `live`) offered a
 * Kubernetes tier that could only ever answer "nothing below the declaration
 * boundary". */
let runtimeCapable = false;
/** #422: the members whose live read has not landed yet, off the progressive
 * overlay's `meta.pending`. Empty on every non-progressive load, which is every
 * single-project serve and every static snapshot. */
let pendingMembers = [];
// The frames of the progressive load in flight, replayed once it is drawn.
const memberFrames = createMemberFrames();
let pendingTotal = 0;
/** #426: whether the apply-order stop is worth offering — /api/project's
 * `stacksCapable`, which is false for an estate and for a single-lexicon
 * project, where the answer could only ever be one box. */
let stacksCapable = false;
/** #897: false when an estate's members declare no component (/api/project); undefined for a single project. */
let componentsDeclared;
/** The zoom stops this project can actually offer — `runtime` needs an env AND
 * a member whose substrate has an owner chain, `ops` needs emitted op.json
 * files. Both the panel and ⌘K read this, so a stop never appears in one
 * surface and not the other. */
function availableZooms() {
  return ZOOM_OPTS.filter(([, z]) =>
    z === "runtime" ? Boolean(view.env) && runtimeCapable : z === "ops" ? opsAvailable > 0 : z === "stacks" ? stacksCapable : z === "components" ? componentsDeclared !== false : true,
  );
}
/** The zoom a double-clicked card goes to: the next finer one. */
const DRILL = { components: "logical", logical: "composites", composites: "resources", resources: "attributes" };
/** Current zoom value from (components, logical, ops, detail). */
function zoomValue() {
  if (view.components) return "components";
  if (view.logical) return "logical";
  if (view.ops) return "ops";
  if (view.stacks) return "stacks";
  if (view.runtime) return "runtime";
  return { 1: "composites", 2: "resources", 3: "attributes" }[view.detail] ?? "resources";
}
/** Apply a zoom value back onto (components, logical, ops, detail). */
function applyZoom(z) {
  view.components = z === "components";
  view.logical = z === "logical";
  view.ops = z === "ops";
  view.stacks = z === "stacks";
  view.runtime = z === "runtime";
  if (z !== "components" && z !== "logical" && z !== "ops" && z !== "stacks") view.detail = ZOOM_DETAIL[z] ?? 2;
}

/** An estate of several projects: the stacked view and its toggle apply. */
function isEstate() {
  return !!(lastMeta && lastMeta.estate > 1);
}
/** The zooms the server stacks alike cards on: the ones that draw every card. */
function alikeZoom() {
  return ["composites", "resources", "attributes"].includes(zoomValue());
}
const ALIKE_TITLE =
  "Three or more cards of one kind in a box draw as one card with a count; a card many others refer to carries the number instead of the lines";
/** Stack or unstack alike cards. From a zoom that doesn't stack, go to resources stacked. */
function toggleAlike() {
  if (!alikeZoom()) {
    applyZoom("resources");
    view.alike = true;
    nowline("stack alike draws on the resources zoom, so the view moved there");
  } else view.alike = !view.alike;
  renderStatusbar();
  load();
}

/** Toggles over the canvas's top edge: the view features one click away. */
function ensureViewToggles(host) {
  if (!host) return;
  let bar = document.getElementById("view-toggles");
  if (!bar || bar.parentElement !== host) {
    bar = document.createElement("div");
    bar.id = "view-toggles";
    host.appendChild(bar);
  }
  bar.innerHTML = "";
  if (document.documentElement.classList.contains("kiosk-ask")) {
    bar.style.display = "none"; // behold#940: ask mode shows the graph and the prompt alone
    return;
  }
  if (isEstate()) {
    const b = button("▦ stack alike", "vt" + (view.alike && alikeZoom() ? " active" : ""), toggleAlike);
    b.title = ALIKE_TITLE;
    bar.appendChild(b);
  }
  if (!view.components && !view.ops) {
    const b = button("⇢ trace", "vt", () => {
      setPanelTab("model");
      renderPanelModel();
      const sec = document.querySelector(".net-trace");
      if (sec) sec.scrollIntoView({ block: "nearest" });
    });
    b.title = "Trace traffic hop by hop to a card, and see the network findings (Model tab)";
    bar.appendChild(b);
  }
  bar.style.display = bar.children.length ? "" : "none";
}

// --- Floating control panel content ---------------------------------------
// panel.js owns the chrome (drag, snap to edges/corners, collapse, tabs);
// these functions own what's IN the tabs, re-rendered from renderStatusbar()
// — which already runs on every load/lens change — so the panel always
// reflects current state. The Substrates and Deploy tabs are populated
// separately (renderSubstrates / initActions / renderDial): their host
// elements simply live inside the panel now. Every control here keeps its ⌘K
// twin (paletteCommands()) — the panel is the discoverable surface, the
// palette the fast one.
function panelHeading(text) {
  const h = document.createElement("h3");
  h.textContent = text;
  return h;
}
function panelMuted(text) {
  const p = document.createElement("p");
  p.className = "panel-muted";
  p.textContent = text;
  return p;
}
function panelOpt(label, active, onClick, title) {
  const b = button(label, "opt" + (active ? " active" : ""), onClick);
  if (title) b.title = title;
  return b;
}
function actButton(label, onClick, title) {
  const b = button(label, "act", onClick);
  if (title) b.title = title;
  return b;
}

// View tab: the zoom stops (the one granularity axis, coarse → fine), the
// radial toggle (entity zooms only), and the graph tools. The theme picker
// mounts once into #panel-theme at boot and is never rewritten here.
function renderPanelView() {
  const zoom = document.getElementById("panel-zoom");
  if (!zoom) return;
  zoom.innerHTML = "";
  zoom.appendChild(panelHeading("zoom"));
  const current = zoomValue();
  // runtime is only meaningful with an env: it descends below the declaration
  // boundary to owner-referenced children, which exist in a cluster and never
  // in your source. ops only exists once the project has emitted op.json.
  for (const [label, v] of availableZooms()) {
    zoom.appendChild(
      panelOpt(label.replace(/^zoom: /, ""), v === current, () => {
        applyZoom(v);
        renderStatusbar();
        foldPanelOnPhone();
        load();
      }),
    );
  }
  // #399: the three-state colour switch, beside the zoom — the other thing
  // this tab is for is "what am I looking at", and colour is half that answer.
  // Sits below the stops because it is not a granularity: every zoom paints in
  // whichever of the three you picked.
  zoom.appendChild(panelHeading("color by"));
  for (const mode of COLOUR_MODES) {
    const gate = mode === "drift" ? { available: true, reason: "" } : modeAvailability(lastMeta, mode);
    const b = panelOpt(
      mode,
      mode === activeColourMode(),
      () => {
        if (!gate.available) return;
        setColourMode(mode);
      },
      gate.available ? COLOUR_MODE_TITLE[mode] : gate.reason,
    );
    // #401: disabled VISIBLY, with the lexicon's own reason on it. A control
    // greyed out is where a person asks "why not", so that is where the answer
    // goes — never hidden, which would leave the question unasked.
    if (!gate.available) b.disabled = true;
    zoom.appendChild(b);
  }
  // Radial toggle — entity zooms only, same gate the ⌘K entry has
  // (components/logical/ops all lay themselves out: waves / nested arch boxes /
  // phase boxes).
  if (!view.components && !view.logical && !view.ops) {
    zoom.appendChild(panelHeading("layout"));
    // behold#824: an estate of several projects is laid out one box per
    // project, and the radial layout has no boxes, so the server draws the
    // same picture either way. Greyed out with the reason, like a colour mode
    // that can't apply.
    const estate = !!(lastMeta && lastMeta.estate > 1);
    const radial = panelOpt(
      "radial",
      view.radial && !estate,
      () => {
        view.radial = !view.radial;
        load();
      },
      estate ? "Radial lays out one project; this is an estate of several, drawn one box per project" : "Curl the wide DAG onto concentric rings",
    );
    if (estate) radial.disabled = true;
    zoom.appendChild(radial);
  }
  // #877: cards of one kind in a box stack into one with a count. An estate
  // lens, like collapse: the server stacks within each project's box. Offered
  // on every zoom: from one that doesn't stack, it moves to resources.
  if (isEstate()) {
    if (view.components || view.logical || view.ops) zoom.appendChild(panelHeading("layout"));
    zoom.appendChild(panelOpt("stack alike", view.alike && alikeZoom(), toggleAlike, ALIKE_TITLE));
  }
  const tools = document.getElementById("panel-viewtools");
  tools.innerHTML = "";
  tools.appendChild(panelHeading("graph"));
  const row = document.createElement("div");
  row.className = "prow";
  row.appendChild(actButton("⤢ fit", () => fitGraph(), "Reset zoom/pan to fit. Pinch or ⌘/Ctrl+scroll zooms at the cursor; drag pans."));
  row.appendChild(actButton("↓ SVG", () => exportSvg(), "Export the current graph as a standalone SVG file"));
  row.appendChild(actButton("↓ PNG", () => exportPng(), "Save the view as a picture, with the options below"));
  const collapsed = document.getElementById("app").classList.contains("inspect-collapsed");
  row.appendChild(
    actButton(collapsed ? "show inspect" : "hide inspect", () => {
      toggleInspect();
      renderPanelView();
    }),
  );
  const lanes = document.createElement("a");
  lanes.className = "lanes-link";
  lanes.href = "/lanes";
  lanes.textContent = "lanes →";
  lanes.title = "The time-lanes view — captured frames of this graph over time";
  lanes.style.cssText = "color:var(--pending);text-decoration:none;font-size:var(--t-body)";
  row.appendChild(lanes);
  tools.appendChild(row);
  // #882: the picture's options: its scale, and whether a heading and the key go in.
  const png = document.createElement("div");
  png.className = "prow png-opts";
  const scaleSel = document.createElement("select");
  for (const k of [1, 2, 3, 4]) scaleSel.add(new Option(`${k}×`, String(k), false, pngOpts.scale === k));
  scaleSel.title = "Pixels per point of the picture";
  scaleSel.addEventListener("change", () => (pngOpts.scale = Number(scaleSel.value)));
  const check = (label, prop) => {
    const l = document.createElement("label");
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = pngOpts[prop];
    c.addEventListener("change", () => (pngOpts[prop] = c.checked));
    l.append(c, ` ${label}`);
    return l;
  };
  png.append("PNG ", scaleSel, check("heading", "heading"), check("key", "key"));
  tools.appendChild(png);
}

// Scope tab: which world the graph reads — env (source vs live overlay),
// stack (#76), tier and target (M2 #54). The same lenses ⌘K offers, but
// visible: this tab is the answer to "what can I even do in behold?".
// #195: filesystem basename, for showing a project by name with the full
// path demoted to a tooltip / muted line.
function pathBasename(p) {
  return String(p || "").replace(/\/+$/, "").split("/").pop() || String(p || "");
}

// #195: pop the OS file manager (Finder on macOS) at a project directory —
// the server allowlists to served + recent projects.
async function revealProject(dir) {
  try {
    const r = await fetch("/api/project/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dir ? { dir } : {}),
    });
    const j = await r.json();
    if (j.error) showToast("✗ reveal: " + j.error, false);
  } catch (e) {
    showToast("✗ reveal: " + e.message, false);
  }
}

// #195: switch the served project. On success the page reloads — every
// client-side list and cache is project-scoped, so a clean boot is the honest
// way to re-seed all of it.
async function switchProject(dir) {
  return postSwitch("/api/project/open", { dir }, `switching to ${pathBasename(dir)}…`, "switch");
}

// #268: load a bundled demo and serve it. Same treatment as a project switch —
// it IS one, after a copy/clone + install the server runs on the click. The
// body carries the catalog NAME; the server never takes a path here.
async function openDemo(demo) {
  if (!demo.satisfiable) return;
  return postSwitch("/api/demos/open", { name: demo.name }, demoProgress(demo), "demo");
}

// The switch itself: a JSON POST behind the loading scrim, then a reload on
// success. Shared by the recents/path switch and the demo catalog above.
async function postSwitch(url, body, message, what) {
  showLoading(message);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok || j.error) {
      hideLoading();
      showToast(`✗ ${what}: ` + (j.error || r.statusText), false);
      return;
    }
    location.reload();
  } catch (e) {
    hideLoading();
    showToast(`✗ ${what}: ` + e.message, false);
  }
}

// #268: the bundled catalog, fetched once per page. `null` until it lands (the
// first Scope render kicks it off and re-renders when it does), then a list —
// empty on a server that doesn't serve the route, which renders no group.
let demoCatalog = null;
let demoCatalogPending = false;
function primeDemoCatalog() {
  if (demoCatalogPending) return;
  demoCatalogPending = true;
  fetchDemos().then((demos) => {
    demoCatalog = demos;
    renderPanelScope();
  });
}

/**
 * The manifest-backed carve state (#230 M3), as the scope panel shows it: the
 * progress read, then one row per carved address with its stage.
 *
 * Stage is carried by the WORD, with the tone reinforcing it — green for
 * graduated, the pending blue for a carve still in flight (the same blue
 * pinhole paints `accent` cards with, so the panel row and the card agree).
 * A no-op when the served estate carries no manifests: a project that was
 * never carved grows no dead section.
 *
 * `chant carve apply` is echoed per row and never offered as a button — see
 * src/carve-manifest.ts APPLY_IS_HUMAN, which `state.apply.note` carries here
 * verbatim.
 */
function renderCarveState(host, state) {
  if (!state || !state.manifests) return;
  host.appendChild(panelHeading("carved out of terraform"));
  const head = document.createElement("div");
  head.className = "count-row";
  const label = document.createElement("span");
  label.className = "grow";
  label.textContent = state.progress.label;
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = state.manifests + (state.manifests === 1 ? " manifest" : " manifests");
  tag.title = "chant's own *.carve.json state manifests — behold reads them and never writes one.";
  head.append(label, tag);
  host.appendChild(head);
  if (state.progress.detail) host.appendChild(panelMuted(state.progress.detail));
  for (const s of state.states) {
    const row = document.createElement("div");
    row.className = "count-row";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = s.graduated ? "var(--managed)" : "var(--pending)";
    const name = document.createElement("span");
    name.className = "grow";
    name.textContent = s.target;
    name.title = s.note;
    const stage = document.createElement("span");
    stage.className = "tag";
    stage.textContent = s.stage;
    row.append(dot, name, stage);
    host.appendChild(row);
    if (!s.graduated) host.appendChild(panelMuted(s.applyCommand));
  }
  host.appendChild(panelMuted(state.apply.note));
}

/**
 * One inspect row whose value is a line to run: the line itself, monospaced,
 * and a copy button beside it — the affordance the moves panel already gives a
 * `live-mv` line (#371), reused here for the tags that adopt an unowned object
 * (#393 item 10). `add` is a section's own row adder, so the row sits in the
 * section it belongs to rather than in a box of its own.
 */
function copyableRow(add, key, text, title) {
  const wrap = document.createElement("span");
  // `center`, not `baseline`: an `overflow: hidden` flex item takes its bottom
  // margin edge as its baseline, so the clipped line below would have dragged
  // the copy button down with it.
  wrap.style.cssText = "display:flex;gap:6px;align-items:center;min-width:0";
  const line = document.createElement("code");
  line.className = "grow";
  // #396 item 7c: ONE line, clipped. `tofu-estate=… tofu-address=…` wrapped
  // onto three lines in the 260px pane and pushed everything the card had to
  // say off the bottom — for a string nobody reads off the screen anyway,
  // because the copy button beside it is how it gets used. The whole of it is
  // on this row's tooltip, on the button's, and in the clipboard.
  line.style.cssText = "flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  line.textContent = text;
  line.title = text;
  const copy = actButton("copy", () => copyToClipboard(text, copy), title ? `${title}:\n${text}` : text);
  wrap.append(line, copy);
  add(key, wrap);
}

/** Copy `text` to the clipboard and say so on the button for a moment. */
function copyToClipboard(text, el) {
  const done = () => {
    const was = el.textContent;
    el.textContent = "copied ✓";
    setTimeout(() => {
      el.textContent = was;
    }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
  else done();
}

/**
 * The choudoufu move plan (#371), as the scope panel shows it: one row per
 * move (`address: from → to`), the line a person runs in the destination
 * estate's directory with a copy button, and a link to the morph page. The
 * plan is read from `/api/choudoufu/split`, which previews with choudoufu's
 * own `-dry-run` when asked and never runs the write — `apply.note` carries
 * that sentence here verbatim. A no-op when no served member carries a
 * `split.json` (or the workbench's `carve.json`).
 */
function renderChoudoufuMoves(host, info) {
  if (!info || !info.plans || !info.plans.length || staticMode || publicMode) return;
  host.appendChild(panelHeading("split (choudoufu)"));
  for (const plan of info.plans) {
    const head = document.createElement("div");
    head.className = "count-row";
    const label = document.createElement("span");
    label.className = "grow";
    label.textContent = plan;
    const morph = document.createElement("a");
    morph.className = "tag";
    morph.textContent = "split ↗";
    morph.href = "/choudoufu/split?plan=" + encodeURIComponent(plan);
    morph.target = "_blank";
    morph.title = "Every estate a box, the moved cards gliding to their destination";
    head.append(label, morph);
    host.appendChild(head);
    const rows = document.createElement("div");
    host.appendChild(rows);
    apiFetch("/api/choudoufu/split?plan=" + encodeURIComponent(plan))
      .then((r) => r.json())
      .then((body) => {
        if (!body || !Array.isArray(body.moves)) {
          rows.appendChild(panelMuted((body && body.error) || "plan unreadable"));
          return;
        }
        for (const m of body.moves) {
          const row = document.createElement("div");
          row.className = "count-row";
          const name = document.createElement("span");
          name.className = "grow";
          name.textContent = m.address + (m.newAddress ? " → " + m.newAddress : "");
          name.title = "run in " + m.runIn;
          const tag = document.createElement("span");
          tag.className = "tag";
          tag.textContent = m.from + " → " + m.to;
          const copy = actButton("copy", () => copyToClipboard(m.command, copy), "Copy the live-mv line to the clipboard");
          row.append(name, tag, copy);
          rows.appendChild(row);
          rows.appendChild(panelMuted(m.command));
        }
        if (body.apply && body.apply.note) rows.appendChild(panelMuted(body.apply.note));
      })
      .catch(() => rows.appendChild(panelMuted("plan unreadable — is the behold server still running?")));
  }
}

/**
 * The totals, per box and per estate, in the active mode (#399).
 *
 * Sits in the Scope tab because Scope is already the tab that says what this
 * estate IS — its members, its moves, its environments — and a per-box figure
 * is a fact about a member, not about the picture.
 *
 * In `drift` mode there is no row at all. Drift counts states; a sum of states
 * is not a thing, and the Model tab's legend already carries the counts.
 *
 * Where the figure comes from is on the row, every time. `cost` quotes the
 * server: `meta.behaviour.boxes[<key>]` per box and `.sum` for the estate, both
 * additions of engine figures — or `meta.behaviour.total`, the engine's own
 * estate figure, which outranks the sum and is labelled "engine total" so the
 * two can never be confused. `headroom` has no server-side aggregate, because
 * no engine states one and adding fractions of capacity would mean nothing, so
 * the SPA takes the worst and middle card of the scope itself and the row says
 * "computed".
 */
function renderBehaviourTotals(host) {
  const mode = activeColourMode();
  if (mode === "drift") return;
  const b = behaviourMeta();
  const ir = lastGraphIr;
  if (!b || !ir) return;
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const boxes = (ir.groups && ir.groups.byStack) || {};
  host.appendChild(panelHeading(`${mode} totals`));

  const row = (label, blocks, sum, engineTotal, title) => {
    const totals = totalsFor(mode, blocks, sum, engineTotal);
    if (!totals) return;
    // Stacked, not a name/value row: the panel is 260px and one of these
    // lines is "0.5669 USD/h · 41 priced · 4 unpriced" — side by side, the
    // figure takes the width and the box's name ellipses away to nothing,
    // which is the one part of the row that says WHAT is being totalled.
    const r = document.createElement("div");
    r.className = "behaviour-total";
    const name = document.createElement("div");
    name.className = "grow";
    name.style.fontWeight = "600";
    name.textContent = label;
    if (title) name.title = title;
    r.appendChild(name);
    r.appendChild(figureWithBadge(totalsText(totals), blocks.filter(Boolean), b));
    host.appendChild(r);
  };

  for (const [key, ids] of Object.entries(boxes).sort(([a], [c]) => a.localeCompare(c))) {
    const blocks = ids.map((id) => blockOf(byId.get(id)));
    row(key, blocks, (b.boxes || {})[key], undefined, `${ids.length} entities in this box`);
  }
  const all = ir.nodes.map((n) => blockOf(n));
  // `total` is the engine's word and only ever holds an engine's own figure;
  // `sum` is behold's addition. Passing both lets totalsFor apply #398's
  // precedence in one place rather than at each call site.
  row(b.total ? "estate · engine total" : "estate", all, b.sum, b.total, b.total ? "the engine stated this estate total itself; behold added nothing" : "behold's sum over the engine's per-entity figures");
  if (mode === "headroom") host.appendChild(panelMuted("min and median computed by behold over the engine's per-entity figures — no engine states a headroom aggregate."));
  if (mode === "cost") renderBehaviourDelta(host, b);
}

/**
 * Live versus declared (#402): what the account costs as it stands, what the
 * file says it should, and the difference. Present only when the overlay was
 * asked for at a traffic level, because both figures are predictions *at* one.
 * The wording of every row is `deltaRows`' (web/behaviour-scale.js).
 */
function renderBehaviourDelta(host, b) {
  const rows = deltaRows(b);
  if (!rows.length) return;
  host.appendChild(panelHeading(`live versus declared${b.at ? ` · at ${b.at.traffic}` : ""}`));
  for (const t of rows) {
    const r = document.createElement("div");
    r.className = "behaviour-total";
    const name = document.createElement("div");
    name.className = "grow";
    name.style.fontWeight = "600";
    name.textContent = t.label;
    r.appendChild(name);
    for (const [word, text] of [["live", t.live], ["declared", t.declared], ["delta", t.delta]]) {
      const line = document.createElement("div");
      line.textContent = `${word} ${text}`;
      r.appendChild(line);
    }
    host.appendChild(r);
  }
  host.appendChild(panelMuted("delta is live minus declared. A negative one means the account holds less than the file declares."));
}

function renderPanelScope() {
  const host = document.getElementById("tab-scope");
  if (!host) return;
  host.innerHTML = "";
  // #195: which project is loaded — the first thing this tab answers. Name
  // bold, full path as a muted line, every estate member listed when several
  // projects are composed, and a reveal button to pop the folder in the OS
  // file manager.
  host.appendChild(panelHeading("project"));
  const info = projectInfo || {};
  const estateDirs = info.projectDirs && info.projectDirs.length > 1 ? info.projectDirs : info.projectDir ? [info.projectDir] : [];
  for (const dir of estateDirs) {
    const row = document.createElement("div");
    row.className = "prow";
    const name = document.createElement("span");
    name.className = "grow";
    name.style.fontWeight = "600";
    name.textContent = pathBasename(dir) + (estateDirs.length > 1 && dir === info.projectDir ? " · primary" : "");
    name.title = dir;
    row.appendChild(name);
    if (!staticMode && !publicMode) row.appendChild(actButton("⌖ reveal", () => revealProject(dir), "Open this project's folder in your file manager"));
    host.appendChild(row);
    host.appendChild(panelMuted(dir));
  }
  if (!estateDirs.length) host.appendChild(panelMuted("no project loaded yet"));
  // #230 M3: the strangler-fig progress, right where the panel already
  // summarizes this estate's members. It reads off chant's own `*.carve.json`
  // manifests (chant#998), so it says the same thing after a restart as before
  // one — and it renders identically in carve mode and on an ordinary project
  // serve, because /api/project publishes one shape for both.
  renderCarveState(host, info.carve && info.carve.state);
  // #399: what the estate costs, or how much room it has left, per member box
  // and for the whole estate — right under the member list the figures are
  // about, and above the moves that would change them.
  renderBehaviourTotals(host);
  // #371: a choudoufu member's move plan — the handoff lines with copy
  // buttons, and the morph page. Read-only: behold never runs live-mv.
  renderChoudoufuMoves(host, info.choudoufu);
  // #195: switching — recents first (server-persisted, validated), then a
  // free path input. Locked in preview mode (the demo's contract) and
  // meaningless in a static export.
  if (!staticMode && !previewMode) {
    host.appendChild(panelHeading("switch project"));
    const recents = (info.recents || []).filter((d) => d !== info.projectDir);
    for (const d of recents.slice(0, 8)) {
      host.appendChild(panelOpt(pathBasename(d), false, () => switchProject(d), d));
    }
    if (!recents.length) host.appendChild(panelMuted("projects you open appear here"));
    const row = document.createElement("div");
    row.className = "prow";
    const input = document.createElement("input");
    input.className = "panel-input";
    input.placeholder = "/path/to/chant-project";
    input.title = "Absolute path to a chant project (a directory with a chant.config.ts)";
    const go = actButton("open →", () => {
      if (input.value.trim()) switchProject(input.value.trim());
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go.click();
    });
    row.append(input, go);
    host.appendChild(row);
    // #268: the bundled demo catalog, under recents — every demo `behold demo
    // --list` names, one click from wherever you are. An entry whose
    // prerequisites are missing renders disabled with the reason on it, and one
    // that would clone from the network says so before it runs.
    if (demoCatalog === null) primeDemoCatalog();
    else if (demoCatalog.length) {
      host.appendChild(panelHeading("demos"));
      for (const d of demoCatalog) {
        const b = panelOpt(demoLabel(d), false, () => openDemo(d), demoTitle(d));
        if (!d.satisfiable || d.switchable === false) b.disabled = true;
        host.appendChild(b);
      }
    }
  }
  host.appendChild(panelHeading("environment"));
  host.appendChild(
    panelOpt("(source)", !view.env, () => {
      view.env = null;
      resetDialCaches();
      renderStatusbar();
      load();
    }, "The declared source graph — no live overlay"),
  );
  for (const e of environments) {
    // #191: a k8s env shows the cluster it's bound to (`home → home-cloud`),
    // so a wrong-cluster pick is visible before the read, not after.
    const ctx = projectInfo && projectInfo.k8sContexts && projectInfo.k8sContexts[e];
    host.appendChild(
      panelOpt(ctx ? `${e} → ${ctx}` : e, view.env === e, () => {
        view.env = e;
        resetDialCaches();
        renderStatusbar();
        load();
      }, ctx ? `Live overlay for ${e} — bound to kubeconfig context ${ctx}` : `Live overlay for ${e}`),
    );
  }
  if (!environments.length) host.appendChild(panelMuted("no environments declared"));

  // #234's last remainder — "is prod running what staging tested". Only when
  // an env is picked and there is another to compare against; ledger-only, so
  // it never adds a cloud read to opening the panel (fetch happens on pick).
  if (view.env && environments.length > 1 && !staticMode && !publicMode) {
    if (view.compareTo === view.env) view.compareTo = null; // env re-picked onto the compared one
    host.appendChild(panelHeading("compare releases"));
    const sel = document.createElement("select");
    sel.add(new Option("(off)", "", view.compareTo == null, view.compareTo == null));
    for (const e of environments) {
      if (e === view.env) continue;
      sel.add(new Option(`vs ${e}`, e, false, view.compareTo === e));
    }
    sel.title = "Compare this environment's recorded releases with another's — per component, on the comparable identity (inputs for pinned deploys)";
    const result = document.createElement("div");
    const render = (payload) => {
      result.replaceChildren();
      const s = comparisonSummary(payload);
      const line = document.createElement("div");
      line.style.cssText = `font-size:var(--t-caption);color:${COMPONENT_STATUS_VAR[s.tone === "warn" ? "warn" : s.tone === "good" ? "good" : "neutral"]};margin:4px 0`;
      line.textContent = s.text;
      result.appendChild(line);
      for (const c of payload.comparisons || []) {
        const r = comparisonRow(c);
        const row = panelDotRow(COMPONENT_STATUS_VAR[r.tone === "warn" ? "warn" : r.tone === "good" ? "good" : "neutral"], r.component, r.verdict, () => selectNode(r.component));
        row.title = r.detail;
        result.appendChild(row);
      }
    };
    sel.addEventListener("change", () => {
      view.compareTo = sel.value || null;
      result.replaceChildren();
      if (!view.compareTo) return;
      result.appendChild(panelMuted("comparing…"));
      fetch(`/api/components/compare?env=${encodeURIComponent(view.env)}&to=${encodeURIComponent(view.compareTo)}`)
        .then((r) => r.json())
        .then((payload) => {
          if (view.compareTo !== sel.value) return; // re-picked while loading
          if (payload.error) {
            result.replaceChildren(panelMuted(payload.error));
            return;
          }
          render(payload);
        })
        .catch((err) => result.replaceChildren(panelMuted(`compare failed: ${err && err.message ? err.message : err}`)));
    });
    host.appendChild(sel);
    host.appendChild(result);
    // Restore an active comparison across panel re-renders.
    if (view.compareTo) sel.dispatchEvent(new Event("change"));
  }
  if (stacks.length) {
    host.appendChild(panelHeading("stack"));
    for (const s of stacks) {
      host.appendChild(
        panelOpt(s, view.stack === s, () => {
          view.stack = s;
          resetDialCaches();
          renderStatusbar();
          load();
        }),
      );
    }
  }
  if (tiers.length) {
    host.appendChild(panelHeading("tier"));
    for (const t of tiers) {
      host.appendChild(
        panelOpt(t, view.tier === t, () => {
          view.tier = t;
          resetDialCaches();
          renderStatusbar();
          load();
        }),
      );
    }
  }
  if (targets.length && !staticMode) {
    host.appendChild(panelHeading("target"));
    const sel = document.createElement("select");
    for (const t of targets) sel.add(new Option(t.endpoint, t.endpoint, false, view.target === t.endpoint));
    sel.addEventListener("change", () => {
      view.target = sel.value;
      resetDialCaches();
      renderStatusbar();
      load();
    });
    host.appendChild(sel);
  }
}

// Model tab: how the current graph's nodes stand against reality — the drift
// overlay's managed/foreign/pending or the component DAG's applied/unapplied
// (deployed / in progress / rolled back / not deployed). Replaces the two old
// header legends, with live counts; component/attention rows click through to
// the node's inspect panel.
const DRIFT_STATUS_VAR = { good: "var(--managed)", warn: "var(--foreign)", accent: "var(--pending)", neutral: "var(--muted)", runtime: "var(--runtime)" };
const COMPONENT_STATUS_VAR = { good: "var(--managed)", accent: "var(--pending)", warn: "var(--degraded)", neutral: "var(--muted)" };

/**
 * The provenance badge (#401, M4 of #397) — `{engine} {version} · {tolerance}
 * · {basis}`, beside a figure rather than once per page.
 *
 * #397's one prohibition is a prediction presented as a bill, and this element
 * is where that is prevented: the word `modeled` is on the badge and the
 * sentence "modeled, not billed" is on its hover, on every figure that carries
 * one. `blocks` is the entities the figure was derived from — one for an
 * inspect row, a whole box or estate for a totals row — because #398 puts
 * provenance on the ENTITY, so a badge over a set can only say what the set
 * agrees on (badgeFor says `mixed` where it does not).
 */
function badgeEl(blocks, meta) {
  const b = badgeFor(blocks, meta);
  if (!b) return null;
  const el = document.createElement("span");
  el.className = "tag behaviour-badge";
  el.textContent = b.text;
  el.title = b.title;
  return el;
}

/** A figure and its badge on one line — the shape every behaviour figure the
 * SPA shows takes, so none of them can end up without one. */
function figureWithBadge(text, blocks, meta) {
  const wrap = document.createElement("span");
  wrap.style.cssText = "display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;min-width:0";
  const val = document.createElement("span");
  val.textContent = text;
  wrap.appendChild(val);
  const badge = badgeEl(blocks, meta);
  if (badge) wrap.appendChild(badge);
  return wrap;
}

/**
 * One mode's legend (#399: one legend per mode).
 *
 * `drift` is not here — it keeps #393's vocabulary legend, the estate's own
 * words for the four states, which is the whole point of that issue. The two
 * behaviour modes get a ramp with its two ends labelled, the priced/unpriced
 * split, the neutral swatch that says what an unpriced card is drawn in, and
 * the badge for the figures the ramp spans.
 */
function renderBehaviourLegend(host, mode) {
  const b = behaviourMeta();
  const ir = lastGraphIr;
  if (!b || !ir) return;
  const blocks = ir.nodes.map((n) => blockOf(n));
  const values = ir.nodes.map((n) => figureOf(mode, blockOf(n)));
  const domain = domainFor(mode, values);
  const tokens = getTokens();
  const ramp = rampFor(mode, tokens);
  const currency = (blocks.find((x) => x && x.cost) || { cost: {} }).cost.currency || "";
  const heading = panelHeading(`${mode} · ${lastMeta.env}`);
  heading.title = COLOUR_MODE_TITLE[mode];
  host.appendChild(heading);

  const bar = document.createElement("div");
  bar.className = "behaviour-ramp";
  bar.style.cssText = `height:10px;border-radius:5px;border:1px solid var(--line);background:${rampGradient(ramp)}`;
  host.appendChild(bar);
  const ends = scaleEnds(mode, domain, currency);
  if (ends) {
    const row = document.createElement("div");
    row.className = "count-row";
    const lo = document.createElement("span");
    lo.className = "grow";
    lo.textContent = ends.low;
    const hi = document.createElement("span");
    hi.className = "tag";
    hi.textContent = ends.high;
    row.append(lo, hi);
    host.appendChild(row);
  }

  const counts = countFigures(mode, blocks);
  const priced = blocks.filter((x) => x && figureOf(mode, x) !== undefined);
  const line = document.createElement("div");
  line.className = "count-row";
  const txt = document.createElement("span");
  txt.className = "grow";
  txt.textContent = countsText(counts);
  line.appendChild(txt);
  const badge = badgeEl(priced, b);
  if (badge) line.appendChild(badge);
  host.appendChild(line);

  // The neutral, spelled out. Without this row the grey cards read as a third
  // band of the scale rather than as "nothing priced these".
  const theme = getTheme();
  host.appendChild(
    panelDotRow(theme ? pinTokensFor(theme).neutralFill : "var(--muted)", "unpriced — no behaviour block", String(counts.unpriced)),
  );
  if (mode === "headroom") host.appendChild(panelMuted("the lower of the axes the engine reported; a missing axis is absent, not zero"));
}

function panelDotRow(color, main, tag, onClick) {
  const row = document.createElement("div");
  row.className = onClick ? "node-row" : "count-row";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = color;
  // behold#571: the row's left bar, in its dot's state (barVarFor).
  row.style.setProperty("--bar", barVarFor(color));
  const name = document.createElement("span");
  name.className = "grow";
  name.textContent = main;
  name.title = main;
  row.append(dot, name);
  if (tag) {
    const t = document.createElement("span");
    t.className = "tag";
    t.textContent = tag;
    row.appendChild(t);
  }
  if (onClick) row.addEventListener("click", onClick);
  return row;
}

// --- #475: the view in the URL -----------------------------------------------
// The query is read once, at boot (openFromQuery), and written back with
// history.replaceState from renderStatusbar(), which every view change already
// runs through. member and node can only be checked once a graph is on screen,
// so they wait in `pendingPlace` for the first paint (afterPaint). What the
// link asked for and behold could not open is said on the now line.
let pendingPlace = null;
let urlRefusals = [];
let selectedNodeId = null;

let viewUrlReady = false; // nothing is written back until the link has been read
function openFromQuery() {
  viewUrlReady = true;
  // #827: a static export can name the view it opens on; the link's own query wins.
  applyWantedView(withOpening(manifest && manifest.opening, readViewQuery(location.search)));
}

/**
 * Move the view to what a link or the host asked for. Values the estate can't
 * honour are kept in `urlRefusals` for the now line; member and node wait in
 * `pendingPlace` for a graph to check them against. Returns whether the
 * fetch-shaping part of the view moved (a re-read is needed).
 */
function applyWantedView(want) {
  if (!Object.keys(want).length) return false;
  const before = fetchKey();
  // env first: whether the runtime stop exists depends on it.
  const first = settleView("env" in want ? { env: want.env } : {}, { envs: environments });
  if ("env" in first.apply) view.env = first.apply.env;
  const { env: _env, ...rest } = want;
  const { apply, refused } = settleView(rest, {
    zooms: availableZooms().map(([, z]) => z),
    tiers,
    lenses: COLOUR_MODES,
    env: view.env, // a snapshot is of the env the view is on
  });
  urlRefusals.push(...first.refused, ...refused);
  if (apply.tier) view.tier = apply.tier;
  if (apply.zoom) {
    applyZoom(apply.zoom);
    autoZoomFallback = false; // the link chose the zoom; an empty one is said, not swapped
  }
  if (apply.lens) colourMode = apply.lens; // not written to localStorage: the link's pick, not yours
  if ("radial" in apply) view.radial = apply.radial;
  if ("alike" in apply) view.alike = apply.alike;
  if ("gates" in apply) view.gates = apply.gates;
  if ("focus" in apply) view.focus = apply.focus; // #569: drawn by drawTgReads, no new read
  if ("run" in apply) view.run = apply.run; // #569: which run the view draws; read in the message handler
  if ("pull" in apply) view.pull = apply.pull; // the cycle's pull request: a commit's run never draws another's plan
  if ("q" in apply) view.q = apply.q; // #914 carries it; #913 draws it (drawQuery)
  if ("snapshot" in apply) view.snapshot = apply.snapshot;
  if (!view.env) view.snapshot = null; // a snapshot is of an env: the source graph has none
  // behold#922: the plan read (the cards' plan facts, q at the plan depth) and q's grouping.
  if ("plan" in apply) view.plan = apply.plan;
  if (view.plan) view.snapshot = null; // settleView refuses the two together; a plan is now
  if ("countBy" in apply) view.countBy = apply.countBy;
  if (want.member === null) {
    view.member = null;
    selectedNodeId = null;
  }
  if (apply.member && !apply.node && selectedNodeId && nodeMember(selectedNodeId) !== apply.member) {
    // Another member, and no card named in it: the old pick goes.
    selectedNodeId = null;
    document.querySelectorAll("#graph .sel").forEach((n) => n.classList.remove("sel"));
  }
  if (apply.member || apply.node) pendingPlace = { member: apply.member || null, node: apply.node || null };
  return fetchKey() !== before;
}
function fetchKey() {
  return [view.env, zoomValue(), view.tier, view.radial, view.alike, view.plan].join("|"); // plan: behold#922's plan facts on the cards
}

// #476: the host moves the view with a `behold:view` message carrying the same
// fields as the URL. Only from the host's origin (viewFromMessage).
window.addEventListener("message", (e) => {
  const want = viewFromMessage(e, embedOpts.host);
  if (!want) return;
  moveViewTo(want);
});

/** Move the view the way a host's `behold:view` does: settle it, re-read what
 * it changed, and say what couldn't be opened. An agent's move (#914) and Back
 * from one come through here too. */
function moveViewTo(want) {
  const lensBefore = colourMode;
  const gatesBefore = view.gates;
  const focusBefore = view.focus;
  const runBefore = view.run;
  const pullBefore = view.pull;
  const queryBefore = searchKey(view);
  const moved = applyWantedView(want);
  if (view.run !== runBefore || view.pull !== pullBefore) {
    if (tgServed) void loadTgProgress({ fresh: true }); // #569: the run the narration is about
    if (chantFacets) void loadChantPr(); // behold#631
    // The reports too, read fresh now, and again every few seconds while the pin's plan or run isn't written yet:
    // the reports a frame read a step ago don't hold this cycle's pull request.
    if (tgAnswer && embedOpts.bare) void refreshTgAnswer();
  }
  else if (view.focus !== focusBefore && !moved) drawTgReads(); // #569
  // #477: the host's env for the gate strip moved. Read it now, not on the
  // next `changed`; renderStatusbar below writes it into the URL.
  if (view.gates !== gatesBefore) loadWorkspaceGates({ force: true });
  if (moved) {
    resetDialCaches();
    renderStatusbar();
    load();
    return;
  }
  if (colourMode !== lensBefore) recolorNodesByCategory();
  if (searchKey(view) !== queryBefore) void drawQuery(); // #913: a new question over the same graph
  if (pendingPlace && lastGraphIr) afterPaint(lastGraphIr);
  else if (want.member === null) fitGraph();
  const line = refusalLine(urlRefusals);
  urlRefusals = [];
  if (line) nowline(line);
  renderStatusbar();
}

// --- #914: an agent moved the tab --------------------------------------------
// POST /api/view sends a `view` event on /api/events. The tab moves the way a
// host's message moves it, says who asked and when, and pushes a history entry
// so the banner's Back and the browser's Back both return to the view it left.
// The person's own changes keep replacing the entry they are on (syncViewUrl).
// An embedded frame with a host ignores the event: its view is the host's (#476).
function agentMove(data) {
  if (embedOpts.embed && embedOpts.host) return;
  let ev;
  try {
    ev = JSON.parse(data);
  } catch {
    return;
  }
  if (!ev || typeof ev !== "object") return;
  const want = wholeQuestion(viewFromObject(ev.view).want, view);
  if (!Object.keys(want).length) return;
  const move = { id: String(ev.id || ""), by: String(ev.by || "an agent"), movedAt: String(ev.movedAt || ""), q: typeof want.q === "string" ? want.q : "" };
  syncViewUrl(); // the entry being left holds the view as it is now
  const entry = agentEntry(history.state, move);
  try {
    // The new entry starts as a copy of the one being left; moveViewTo's syncViewUrl writes the new view into it.
    if (entry.push) history.pushState(entry.state, "", location.href);
    else history.replaceState(entry.state, "", location.href);
  } catch {
    /* a sandboxed frame may refuse; the move still happens */
  }
  moveViewTo(want);
  showAgentBanner(move);
}

// Back, from the banner or the browser: the URL is the view to go back to.
window.addEventListener("popstate", (e) => {
  if (!viewUrlReady) return;
  const defaults = { env: defaultEnv(manifest && manifest.opening, projectInfo && projectInfo.currentEnv), lens: savedColourMode };
  moveViewTo(restoreViewQuery(location.search, defaults));
  const move = e.state && e.state.beholdMove;
  if (move) showAgentBanner(move);
  else hideAgentBanner();
});

function showAgentBanner(move) {
  let el = document.getElementById("agent-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "agent-banner";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  const b = agentBanner(move, new Date(move.movedAt));
  el.innerHTML = "";
  const text = document.createElement("span");
  text.className = "agent-banner-text";
  text.textContent = b.text;
  el.appendChild(text);
  const back = document.createElement("button");
  back.className = "agent-banner-back";
  back.textContent = "Back";
  back.title = "Return to the view before this move";
  back.addEventListener("click", () => history.back());
  el.appendChild(back);
  const close = document.createElement("button");
  close.className = "agent-banner-close";
  close.textContent = "×";
  close.title = "Dismiss; Back in the browser still returns";
  close.addEventListener("click", hideAgentBanner);
  el.appendChild(close);
  el.hidden = false;
  el.dataset.request = move.id;
}
function hideAgentBanner() {
  const el = document.getElementById("agent-banner");
  if (el) el.hidden = true;
}

/** Tell the host what was picked: a card (member + node) or a member's box. */
function embedSelected(member, node) {
  if (embedOpts.embed && member) setInspectCollapsed(!node);
  if (!embedOpts.host || window.parent === window) return;
  try {
    window.parent.postMessage(selectMessage(member, node), embedOpts.host);
  } catch {
    /* the parent went away */
  }
}

// --- #477: a declared workspace's waiting gates --------------------------------
// Read when the env changes and when the server says something moved (the
// `changed` event, which a host's POST /api/refresh?notify=1 also sends).
// Framed, the cards carry no button: the host approves (workspace-gates.js).
let wsGates = { env: undefined, answer: null, seq: 0 };
// ?gates=<env> (#477): the env the gate strip reads, apart from the graph's.
// A host that opens behold on the source graph still wants the gates of the
// env its block watches. It is a view key (view-url.js), so the link sets it,
// a host's `behold:view` moves it, and the URL keeps it.
function gatesEnv() {
  return view.gates || view.env || "";
}
function loadWorkspaceGates({ force = false } = {}) {
  if (staticMode || publicMode) return;
  const env = gatesEnv();
  if (!force && wsGates.env === env) return paintWorkspaceGates();
  // Every read is numbered; only the newest one paints, so an answer for an
  // env the view has left never lands under the one it moved to.
  const seq = ++wsGates.seq;
  wsGates.env = env;
  // #472: the open decision points ride with the gates, so a question lands on
  // the card of the gate that waits on it in the same paint.
  const read = (url) =>
    fetch(url)
      .then((r) => r.json())
      .catch(() => null);
  Promise.all([read(`/api/workspace/gates${env ? `?env=${encodeURIComponent(env)}` : ""}`), read("/api/workspace/points")]).then(([gates, points]) => {
    if (seq !== wsGates.seq) return;
    wsGates.answer = gates;
    wsGates.points = points;
    paintWorkspaceGates();
  });
}
/** #472: one open decision point's lines, inside a gate's card or as its own. */
function pointBlock(p) {
  const box = document.createElement("div");
  box.className = "ws-point";
  box.dataset.point = p.id;
  const title = document.createElement("div");
  title.className = "ws-gate-title";
  title.textContent = p.title;
  const question = document.createElement("div");
  question.className = "ws-point-question";
  question.textContent = p.question;
  const facts = document.createElement("div");
  facts.className = "ws-gate-facts";
  facts.textContent = p.facts;
  const note = document.createElement("div");
  note.className = "ws-gate-note";
  note.textContent = p.note;
  note.title = p.command;
  box.append(title, question, facts, note);
  if (p.showCommand) {
    // Text a person copies; behold never runs it.
    const line = document.createElement("code");
    line.className = "ws-point-command";
    line.textContent = p.command;
    box.appendChild(line);
  }
  return box;
}
function paintWorkspaceGates() {
  const host = document.getElementById("ws-gates");
  if (!host) return;
  const answer = wsGates.answer;
  host.replaceChildren();
  if (!answer || !answer.workspace) {
    host.hidden = true;
    return;
  }
  const { cards, elsewhere, refusal, pointsRefusal } = gateCards(answer, { embed: embedOpts.embed, member: embedOpts.embed ? view.member : null, points: wsGates.points });
  for (const c of cards) {
    if (c.point) {
      const own = pointBlock(c);
      own.classList.add("ws-gate");
      host.appendChild(own);
      continue;
    }
    const box = document.createElement("div");
    box.className = "ws-gate";
    box.dataset.gate = c.key;
    const title = document.createElement("div");
    title.className = "ws-gate-title";
    title.textContent = c.title;
    const facts = document.createElement("div");
    facts.className = "ws-gate-facts";
    facts.textContent = c.facts;
    facts.title = c.command;
    box.append(title, facts);
    if (c.note) {
      const note = document.createElement("div");
      note.className = "ws-gate-note";
      note.textContent = c.note;
      box.appendChild(note);
    }
    if (c.button && !previewMode && !staticMode) {
      const b = button(c.button.label, "approve", () => approveWorkspaceGate(c.key, b));
      b.title = c.button.title;
      box.appendChild(b);
    }
    for (const p of c.points || []) box.appendChild(pointBlock(p));
    host.appendChild(box);
  }
  if (elsewhere) {
    const more = document.createElement("div");
    more.className = "ws-gate ws-gate-note";
    more.textContent = `${elsewhere} more gate${elsewhere === 1 ? "" : "s"} waiting in other members`;
    host.appendChild(more);
  }
  if (refusal) {
    const err = document.createElement("div");
    err.className = "ws-gate ws-gate-note";
    err.textContent = `gates unread: ${refusal.error}`;
    err.title = refusal.remedy || "";
    host.appendChild(err);
  }
  if (pointsRefusal) {
    const err = document.createElement("div");
    err.className = "ws-gate ws-gate-note";
    err.textContent = `decision points unread: ${pointsRefusal.error}`;
    err.title = pointsRefusal.remedy || "";
    host.appendChild(err);
  }
  host.hidden = !host.children.length;
}
function approveWorkspaceGate(key, btn) {
  if (btn) btn.disabled = true;
  fetch("/api/workspace/gates/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, env: wsGates.answer && wsGates.answer.env }) })
    .then((r) => r.json())
    .then((j) => {
      if (j.error) {
        showToast(`✗ approve ${key}: ${j.error}`, false);
        nowline("✗ " + j.error);
      } else {
        showToast(`✓ ${key} approved as ${j.approver}${j.signed ? ", signed" : ""}`, true);
      }
      loadWorkspaceGates({ force: true });
    })
    .catch((e) => showToast(`✗ approve ${key}: ${e}`, false))
    .finally(() => {
      if (btn) btn.disabled = false;
    });
}

/** The member names a graph shows: its member boxes, and the first segment of
 * each composed node id. */
function membersOf(ir) {
  const out = new Set();
  for (const n of (ir && ir.nodes) || []) {
    const m = nodeMember(n.id);
    if (m) out.add(m);
  }
  const svg = currentSvg();
  if (svg && out.size) for (const r of svg.querySelectorAll("rect[data-group-id]")) out.add(r.getAttribute("data-group-id"));
  return out;
}

/** After every paint: place the view where the link (or the last pick) put it. */
function afterPaint(ir) {
  const ids = new Set(((ir && ir.nodes) || []).map((n) => n.id));
  if (pendingPlace) {
    const place = settlePlace(pendingPlace, membersOf(ir), ids);
    pendingPlace = null;
    urlRefusals.push(...place.refused);
    if (place.apply.member) view.member = place.apply.member;
    if (place.apply.node) {
      selectNode(place.apply.node, { quiet: true });
      revealNode(place.apply.node);
    } else if (view.member) revealMember(view.member);
    renderStatusbar();
  } else if (selectedNodeId && !ids.has(selectedNodeId)) {
    // The pick isn't on this view any more; the URL stops naming it. The view
    // stays at the fit: a member a pick implied is no reason to zoom in on it.
    selectedNodeId = null;
    syncViewUrl();
    const panel = document.getElementById("inspect-body");
    if (panel) panel.innerHTML = '<h2>Inspect</h2><p style="color:var(--ink2)">Click a node</p>';
  }
  const line = refusalLine(urlRefusals);
  urlRefusals = [];
  if (line) nowline(line);
  void drawQuery(); // #913: every paint draws the view's question over the new svg
}

// --- behold#913: `q` drawn ----------------------------------------------------
// The view's query is read through GET /api/search (chant answers, behold
// draws: src/search.ts), once per query, env and snapshot, and again after a
// `changed` event. Each paint lights the matches, draws the edges on their
// paths, dims the rest, and says the query and chant's provenance in one line
// (web/search-view.js decides; this applies). A refused query lights and dims
// nothing; no matches dims everything and outlines the near-misses.
let queryAnswer = null; // {key, answer} once read
let queryReading = null; // {key, promise} while a read is in flight
async function readQuery(key) {
  if (queryAnswer && queryAnswer.key === key) return queryAnswer.answer;
  if (queryReading && queryReading.key === key) return queryReading.promise;
  const promise = (async () => {
    let answer;
    try {
      const res = await apiFetch(searchUrl(view));
      answer = await res.json().catch(() => ({ error: `the search answered ${res.status}` }));
      if (staticMode && res.status === 404) answer = { error: uncapturedLine(view.q, manifest && manifest.queries), uncaptured: true };
    } catch (err) {
      answer = { error: `the search failed: ${err.message}` };
    }
    if (searchKey(view) === key) queryAnswer = { key, answer };
    return answer;
  })();
  queryReading = { key, promise };
  try {
    return await promise;
  } finally {
    if (queryReading && queryReading.key === key) queryReading = null;
  }
}
/** The answer the shot frame draws: null while none is wanted, undefined while it is read. */
function queryAnswerNow() {
  const key = searchKey(view);
  if (!key) return null;
  return queryAnswer && queryAnswer.key === key ? queryAnswer.answer : undefined;
}
function clearQueryMarks(svg) {
  if (!svg) return;
  for (const el of svg.querySelectorAll("[data-q]")) el.removeAttribute("data-q");
  for (const el of svg.querySelectorAll("[data-q-near]")) {
    el.removeAttribute("data-q-near");
    const t = el.querySelector(":scope > title.q-near-title");
    if (t) t.remove();
  }
  for (const el of svg.querySelectorAll("[data-q-unobserved]")) el.removeAttribute("data-q-unobserved");
  // behold#922: a counts answer's group colours and labels.
  for (const el of svg.querySelectorAll("[data-q-group]")) {
    el.removeAttribute("data-q-group");
    el.style.removeProperty("--q-group");
  }
  for (const el of svg.querySelectorAll(".q-group-label")) el.remove();
}
async function drawQuery() {
  const key = searchKey(view);
  const lineEl = document.getElementById("q-line");
  if (!key) {
    clearQueryMarks(currentSvg());
    if (lineEl) lineEl.hidden = true;
    return;
  }
  const answer = await readQuery(key);
  if (searchKey(view) !== key) return; // the view moved on while it was read
  const svg = currentSvg();
  clearQueryMarks(svg);
  const cardEls = svg ? [...svg.querySelectorAll("[data-node-id]")] : [];
  const edgeEls = svg ? [...svg.querySelectorAll("g[data-edge-from]")] : [];
  const cardIds = new Set(cardEls.map((g) => g.getAttribute("data-node-id")));
  const stackOf = stackIndex(lastGraphIr && lastGraphIr.nodes, cardIds);
  const marks = queryMarks(
    answer,
    cardIds,
    edgeEls.map((g) => ({ from: g.getAttribute("data-edge-from"), to: g.getAttribute("data-edge-to") })),
    stackOf,
  );
  for (const g of cardEls) {
    const id = g.getAttribute("data-node-id");
    const m = marks.cardMarks.get(id);
    if (m) g.setAttribute("data-q", m);
    if (marks.unobserved.has(id)) g.setAttribute("data-q-unobserved", "1");
    if (marks.near.has(id)) {
      g.setAttribute("data-q-near", "1");
      const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
      t.setAttribute("class", "q-near-title");
      t.textContent = `near miss: fails ${marks.near.get(id)}`;
      g.prepend(t);
    }
  }
  edgeEls.forEach((g, i) => {
    if (marks.edgeMarks[i]) g.setAttribute("data-q", marks.edgeMarks[i]);
  });
  drawGroups(svg, answer, cardEls, stackOf);
  if (embedOpts.bare) return; // a bare frame has no chrome: the shot frame draws its own caption
  const line = queryLine(view, answer, marks);
  let el = lineEl;
  if (!el) {
    el = document.createElement("div");
    el.id = "q-line";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.hidden = false;
  el.dataset.tone = line.tone;
  el.innerHTML = "";
  const main = document.createElement("div");
  main.className = "q-line-main";
  main.textContent = line.text;
  el.appendChild(main);
  if (line.notSearched) {
    const ns = document.createElement("div");
    ns.className = "q-line-not-searched";
    ns.textContent = line.notSearched;
    el.appendChild(ns);
  }
}

/**
 * behold#922: a counts answer drawn: each group's cards outlined in the
 * group's colour, and the group's first drawn card labelled with the group
 * and chant's count (web/search-view.js groupMarks). The cards are already
 * lit by drawQuery; this says which group each is in.
 */
function drawGroups(svg, answer, cardEls, stackOf) {
  if (!svg) return;
  const gm = groupMarks(answer, new Set(cardEls.map((g) => g.getAttribute("data-node-id"))), stackOf);
  if (!gm.groups.length) return;
  const byId = new Map(cardEls.map((g) => [g.getAttribute("data-node-id"), g]));
  for (const [id, i] of gm.cardGroup) {
    const g = byId.get(id);
    g.setAttribute("data-q-group", gm.groups[i].group);
    g.style.setProperty("--q-group", gm.groups[i].colour);
  }
  for (const grp of gm.groups) {
    const g = grp.label && byId.get(grp.label);
    const rect = g && g.querySelector(":scope > rect");
    if (!rect) continue;
    const x = Number(rect.getAttribute("x") || 0);
    const y = Number(rect.getAttribute("y") || 0);
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("class", "q-group-label");
    t.setAttribute("x", String(x));
    t.setAttribute("y", String(y - 4));
    t.setAttribute("fill", grp.colour);
    t.textContent = groupLabel(grp);
    g.appendChild(t);
  }
}

/** A card was picked (graph click, panel row, palette, the link). */
function noteSelection(id, { quiet = false } = {}) {
  selectedNodeId = id;
  const m = nodeMember(id);
  if (m) view.member = m;
  syncViewUrl();
  // A pick the link or the host made isn't a click: the host isn't told.
  if (!quiet) embedSelected(view.member, id);
}

/** Frame one member's box, or the cards in it when the zoom draws no boxes. */
function revealMember(member) {
  const svg = currentSvg();
  if (!svg || !vbInit) return false;
  let box = null;
  const rect = svg.querySelector(`rect[data-group-id="${CSS.escape(member)}"]`);
  if (rect) {
    box = boxInSvg(svg, rect);
  } else {
    for (const g of svg.querySelectorAll("[data-node-id]")) {
      if (nodeMember(g.getAttribute("data-node-id")) !== member) continue;
      const b = boxInSvg(svg, g);
      if (b) box = box ? union(box, b) : b;
    }
  }
  if (!box || !(box.width > 0) || !(box.height > 0)) return false;
  const pad = 0.06;
  const aspect = vbInit[3] / vbInit[2];
  let w = box.width * (1 + 2 * pad);
  let h = box.height * (1 + 2 * pad);
  if (h / w > aspect) w = h / aspect;
  else h = w * aspect;
  vb = [box.x + box.width / 2 - w / 2, box.y + box.height / 2 - h / 2, w, h];
  vbAtFit = false;
  applyVB();
  return true;
}
/** An element's box in the svg's user units, after every transform on the way
 * (a dragged box is a `translate` on its wrapper, #228). */
function boxInSvg(svg, el) {
  try {
    const b = el.getBBox();
    const m = svg.getScreenCTM() && el.getScreenCTM() ? svg.getScreenCTM().inverse().multiply(el.getScreenCTM()) : null;
    if (!m) return { x: b.x, y: b.y, width: b.width, height: b.height };
    const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  } catch {
    return null;
  }
}
function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Write the view into the address bar, keeping every other parameter. */
function syncViewUrl() {
  if (!viewUrlReady) return;
  const place = pendingPlace || {};
  const state = {
    member: place.member || view.member,
    zoom: zoomValue(),
    env: view.env,
    tier: view.tier,
    lens: colourMode,
    node: place.node || selectedNodeId,
    radial: view.radial && !view.components && !view.logical && !view.ops,
    // Stacked is the default, so only an estate's every-card view is written.
    alike: isEstate() && alikeZoom() ? view.alike : undefined,
    gates: view.gates,
    focus: view.focus,
    run: view.run,
    q: view.q,
    snapshot: view.snapshot,
    plan: view.plan,
    countBy: view.countBy,
  };
  const defaults = { env: defaultEnv(manifest && manifest.opening, projectInfo && projectInfo.currentEnv), lens: savedColourMode };
  const next = location.pathname + writeViewQuery(location.search, state, defaults) + location.hash;
  if (next === location.pathname + location.search + location.hash) return;
  try {
    history.replaceState(history.state, "", next);
  } catch {
    /* a sandboxed frame may refuse; the view still works */
  }
}

// Select a node from a panel row the same way a graph click would: highlight
// its card (when it's in the current SVG) and open its inspect panel.
function selectNode(id, { quiet = false } = {}) {
  const node = lastGraphIr && lastGraphIr.nodes.find((n) => n.id === id);
  if (!node) return;
  const host = document.getElementById("graph");
  host.querySelectorAll(".sel").forEach((n) => n.classList.remove("sel"));
  const g = host.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
  if (g) g.classList.add("sel");
  inspect(node);
  noteSelection(node.id, { quiet });
  carvePick(node);
}

function renderPanelModel() {
  const host = document.getElementById("tab-model");
  if (!host) return;
  host.innerHTML = "";
  const ir = lastGraphIr;
  const m = lastMeta;
  if (!ir || !m) {
    host.appendChild(panelMuted("no graph loaded yet"));
    return;
  }
  // #393 item 7: the note in full, where there is room for it. The strip may be
  // showing the server's short form (a 260px strip cannot hold five root names,
  // two skip reasons and five block counts), so the whole sentence has to be
  // readable somewhere that is not a tooltip — and this tab is where the panel
  // already explains the picture.
  if (lastNote && lastNoteShort) {
    host.appendChild(panelHeading("note"));
    host.appendChild(panelMuted(lastNote));
  }
  const drift = m.mode === "overlay" || (m.mode === "logical" && !!m.env);
  const componentStatus = m.mode === "component-status";
  const count = (statuses) => {
    const c = Object.fromEntries(Object.keys(statuses).map((k) => [k, 0]));
    for (const n of ir.nodes) {
      const s = n.attrs && n.attrs._status;
      if (s in c) c[s]++;
    }
    return c;
  };
  if (componentStatus) {
    host.appendChild(panelHeading(`live status · ${m.env}`));
    const c = count(COMPONENT_STATUS_LABEL);
    for (const [k, label] of Object.entries(COMPONENT_STATUS_LABEL)) {
      host.appendChild(panelDotRow(COMPONENT_STATUS_VAR[k], label, String(c[k])));
    }
    host.appendChild(panelHeading("components"));
    for (const n of ir.nodes.filter((n) => n.kind === "Component")) {
      const s = n.attrs && n.attrs._status;
      host.appendChild(panelDotRow(COMPONENT_STATUS_VAR[s] || "var(--muted)", n.id, APPLY_STATUS_TAG[s] || "", () => selectNode(n.id)));
    }
  } else if (drift && activeColourMode() !== "drift") {
    // #399: one legend per mode. The drift legend below is #393's vocabulary
    // legend and stays exactly as it was — this branch is the two behaviour
    // modes, whose legend is a scale rather than a set of states.
    renderBehaviourLegend(host, activeColourMode());
  } else if (drift) {
    // #393 item 8: the legend proper. The heading carries the mixed-estate
    // sentence as its tooltip — the one case where the words on these rows are
    // not the words the members would use for themselves.
    const heading = panelHeading(`drift · ${m.env}`);
    const why = vocabularyNote();
    if (why) heading.title = why;
    host.appendChild(heading);
    const words = statusLabels();
    const c = count(words);
    for (const [k, label] of Object.entries(words)) {
      // The additive buckets (chant#1168 unobserved, chant#1180 runtime) stay
      // hidden until a chant actually emits them — same as the old legend.
      if ((k === "neutral" || k === "runtime") && !c[k]) continue;
      host.appendChild(panelDotRow(DRIFT_STATUS_VAR[k], label, String(c[k])));
    }
    // #404: attribute drift, on its own row under the ownership counts —
    // beside them, never mixed into them, because a drifted card is still
    // bound and is already counted on the row above. The row appears only when
    // a plan was actually read; where it was not, the legend says so in words
    // and prints no number, because "0 drifted" would be a claim nobody made.
    // #429: a card with NO `_status` at all. pinhole's painter falls back to
    // `neutral` for an unrecognised value, `undefined` included, so a member
    // with no live half — a Terraform root, whose `live`/`overlay`/`env` are
    // stripped in src/terraform-member.ts — paints exactly like a card behold
    // looked at and could not see. It is in no legend bucket either, so the
    // colour claimed 37 unobserved cards on an estate whose legend counted 2.
    //
    // Named rather than folded into `unobserved`, because they are different
    // claims: "I looked and could not see" against "there is nothing here to
    // look at". Same argument #399 makes for an unpriced card, and the same
    // answer — mark it, do not merely colour it.
    const noLive = ir.nodes.filter((n) => !(n.attrs && n.attrs._status)).length;
    if (noLive) {
      const row = panelDotRow("var(--muted)", "no live half", String(noLive));
      row.title = "These members declare no live half, so nothing observed them — which is not the same as unobserved, and not the same as absent.";
      host.appendChild(row);
    }
    const dm = driftMeta();
    if (dm && dm.read) {
      host.appendChild(panelDotRow("var(--degraded)", "drifted (the plan would change it)", String(dm.drifted)));
    } else if (dm) {
      host.appendChild(panelMuted("attribute drift not read — the overlay is ownership only. ⌘K → “Re-check live with plan”."));
    }
    renderHealthLegend(host); // #825: runtime health, beside drift and apart from it
    // The actionable nodes — foreign (adoptable) and pending (not applied yet).
    const attention = ir.nodes.filter((n) => {
      const s = n.attrs && n.attrs._status;
      return s === "warn" || s === "accent";
    });
    if (attention.length) {
      host.appendChild(panelHeading("needs attention"));
      for (const n of attention.slice(0, 40)) {
        const s = n.attrs._status;
        host.appendChild(panelDotRow(DRIFT_STATUS_VAR[s], n.id, statusLabel(s), () => selectNode(n.id)));
      }
      if (attention.length > 40) host.appendChild(panelMuted(`+ ${attention.length - 40} more — click nodes in the graph`));
    }
  } else {
    host.appendChild(panelHeading("model"));
    host.appendChild(panelMuted(`declared source graph — ${ir.nodes.length} nodes, ${ir.edges.length} edges.`));
    if (environments.length && !staticMode) {
      host.appendChild(panelMuted("pick an environment on the Scope tab to see live status: applied / drift / health."));
      host.appendChild(actButton("→ Scope", () => setPanelTab("scope")));
    }
  }
  renderEdgeLegend(host, ir);
  renderNetworkSection(host);
  renderBehaviourRefusal(host);
  renderBehaviourDiagnostics(host);
}

// #881: the network section. The trace reads the rules on each card, which
// only the attributes zoom (detail 3) carries, so the section reads that graph
// once per env and tier, through apiFetch (a static export captures it). The
// trace and the findings are computed here, from that graph (web/net-trace.js).
const NETWORK_KIND = /^(AWS::(EC2|ElasticLoadBalancingV2)::|GCP::(Compute|Run)::|Microsoft\.(Network|App)\/)/;
const net = { key: null, ir: null, error: null, from: OUTSIDE, to: null, port: 80, result: null };

function netKey() {
  return `${view.env || ""}|${view.tier || ""}`;
}

function loadNetworkGraph() {
  const key = netKey();
  if (net.key === key) return;
  Object.assign(net, { key, ir: null, error: null, result: null });
  const q = new URLSearchParams({ detail: "3" });
  if (view.env) q.set("env", view.env);
  if (view.tier) q.set("tier", view.tier);
  apiFetch(`${view.env ? "/api/overlay" : "/api/graph"}?${q}`)
    .then((r) => r.json())
    .then((d) => {
      if (net.key !== key) return;
      if (!d.ir) throw new Error(d.error || "no graph");
      net.ir = d.ir;
      if (net.to) runTrace();
      renderPanelModel();
    })
    .catch((err) => {
      if (net.key !== key) return;
      net.error = String(err.message || err);
      renderPanelModel();
    });
}

function runTrace() {
  if (!net.ir || !net.to) return;
  net.result = traceRoute(net.ir, { from: net.from, to: net.to, port: net.port });
  markTrace();
}

/** Trace from outside to a card, from the inspect pane. */
function traceTo(id) {
  Object.assign(net, { from: OUTSIDE, to: id });
  loadNetworkGraph();
  runTrace();
  setPanelTab("model");
  renderPanelModel();
}

/** Each hop's card marked open or closed on the canvas; the rest fade. */
function markTrace() {
  const svg = document.querySelector("#graph svg");
  if (!svg) return;
  svg.querySelectorAll(".trace-open, .trace-closed").forEach((n) => n.classList.remove("trace-open", "trace-closed"));
  const hops = (net.result && net.result.hops) || [];
  svg.classList.toggle("tracing", hops.length > 0);
  for (const h of hops) {
    const g = h.id && svg.querySelector(`g[data-node-id="${CSS.escape(h.id)}"]`);
    // A card two hops share stays closed if either is.
    if (g && !g.classList.contains("trace-closed")) g.classList.add(h.open ? "trace-open" : "trace-closed");
    if (g && !h.open) g.classList.replace("trace-open", "trace-closed");
  }
}

/** A stack-qualified id (`aws/<stack>::alb`) reads as its member and name. */
function shortIds(text) {
  return text.replace(/([^\s/]+\/)[^\s/:]*::/g, "$1");
}

/** A row whose text wraps: a dot, what it is, the sentence, and a tag. */
function netRow(color, what, text, tag, onClick) {
  const row = document.createElement("div");
  row.className = "net-row" + (onClick ? " clickable" : "");
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = color;
  const body = document.createElement("span");
  const w = document.createElement("b");
  w.textContent = what;
  // A stack-qualified id (`aws/<stack>::alb`) reads as its member and name.
  body.append(w, " " + shortIds(text));
  if (tag) {
    const t = document.createElement("span");
    t.className = "tag";
    t.textContent = tag;
    body.appendChild(t);
  }
  row.append(dot, body);
  if (onClick) row.addEventListener("click", onClick);
  return row;
}

function renderNetworkSection(host) {
  if (view.components || view.ops) return;
  // The section reads its own every-card graph, so a zoom that folds the
  // network away (composites, logical) still traces it.
  loadNetworkGraph();
  if (net.ir && !net.ir.nodes.some((n) => NETWORK_KIND.test(n.kind || ""))) return;
  host.appendChild(panelHeading("network"));
  if (net.error) {
    host.appendChild(panelMuted(`the network couldn't be read: ${net.error}`));
    return;
  }
  if (!net.ir) {
    host.appendChild(panelMuted("reading the network…"));
    return;
  }
  const findings = networkFindings(net.ir);
  if (!findings.length) host.appendChild(panelMuted("no findings: no ranges overlap, every public subnet has a way out, no load balancer sits in one zone, and no admin port is open to anyone."));
  for (const f of findings) host.appendChild(netRow("var(--degraded)", f.finding, f.text, "", () => selectNode(f.ids[0])));

  // The trace: from, to, port.
  const cards = net.ir.nodes.filter((n) => NETWORK_KIND.test(n.kind || "") || /^(AWS::(ECS|EC2|Lambda|RDS)::|GCP::Run::|Microsoft\.App\/)/.test(n.kind || "")).map((n) => n.id).sort();
  const pick = (label, value, options, onChange) => {
    const row = document.createElement("label");
    row.className = "net-pick";
    row.append(label + " ");
    const sel = document.createElement("select");
    for (const [v, text] of options) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = text;
      if (v === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => onChange(sel.value));
    row.appendChild(sel);
    return row;
  };
  const form = document.createElement("div");
  form.className = "net-trace";
  form.appendChild(pick("from", net.from, [[OUTSIDE, "outside (the internet)"], ...cards.map((c) => [c, c])], (v) => (net.from = v)));
  form.appendChild(pick("to", net.to || "", [["", "pick a card"], ...cards.map((c) => [c, c])], (v) => (net.to = v || null)));
  const portRow = document.createElement("label");
  portRow.className = "net-pick";
  portRow.append("port ");
  const port = document.createElement("input");
  port.type = "number";
  port.min = "1";
  port.max = "65535";
  port.value = String(net.port);
  port.addEventListener("change", () => (net.port = Number(port.value)));
  portRow.appendChild(port);
  form.appendChild(portRow);
  const row = document.createElement("div");
  row.className = "prow";
  row.appendChild(
    actButton("trace", () => {
      net.port = Number(port.value);
      runTrace();
      renderPanelModel();
    }, "Follow the traffic hop by hop and mark where it stops"),
  );
  if (net.result) row.appendChild(actButton("clear", () => { net.result = null; markTrace(); renderPanelModel(); }));
  form.appendChild(row);
  host.appendChild(form);

  const r = net.result;
  if (!r) return;
  if (r.unread) {
    host.appendChild(panelMuted(r.unread));
    return;
  }
  host.appendChild(panelMuted(shortIds(r.reached ? `${r.port} arrives at ${r.to}.` : `${r.port} stops at ${r.stop}.`)));
  for (const h of r.hops) {
    const row = netRow(h.open ? "var(--managed)" : "var(--degraded)", h.step, h.why, h.basis === "live" ? "live" : h.seen ? "source · card live" : "source", h.id ? () => selectNode(h.id) : undefined);
    row.title = h.basis === "live" ? "Judged from the rule as the live estate holds it" : h.seen ? "Judged from the rule in the source; the card itself was read live" : "Judged from the source alone";
    host.appendChild(row);
  }
}

// #553: the CI edge kinds this graph draws, each with a stroke drawn by the
// same rules as the graph's own edges (index.html matches `.edge-swatch` beside
// `#graph`), so the legend changes with the theme. Nothing on a graph that
// holds only references.
function renderEdgeLegend(host, ir) {
  const rows = [...edgeLegend(ir.edges || []), ...weightLegend(lastEdgeWeights)];
  if (!rows.length) return;
  host.appendChild(panelHeading("edges"));
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "count-row";
    row.title = r.title;
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "edge-swatch");
    svg.setAttribute("viewBox", "0 0 28 10");
    svg.setAttribute("width", "28");
    svg.setAttribute("height", "10");
    const g = document.createElementNS(SVGNS, "g");
    if (r.kind) g.setAttribute("data-edge-kind", r.kind);
    if (r.cross) g.setAttribute("data-edge-cross", "true");
    if (r.weight) g.setAttribute("data-edge-weight", r.weight);
    const line = document.createElementNS(SVGNS, "path");
    line.setAttribute("class", "pin-edge-line");
    line.setAttribute("d", "M 1 5 L 27 5");
    g.appendChild(line);
    svg.appendChild(g);
    const name = document.createElement("span");
    name.className = "grow";
    name.textContent = r.label;
    const t = document.createElement("span");
    t.className = "tag";
    t.textContent = String(r.count);
    row.append(svg, name, t);
    host.appendChild(row);
  }
}

/**
 * The refusal, where the legend would be (#401).
 *
 * The words are the lexicon's, in its own house style — an env-var chain and
 * the variable it wants — and behold prints them as they came. It does not
 * paraphrase them, does not soften them, and above all does not substitute a
 * number: "a missing or unreachable engine means no overlay and a refusal that
 * names why, never a locally faked number" is #397's rule, and this is the one
 * surface where a person finds out it fired.
 *
 * An ABSENCE prints nothing here. Nothing was configured, so nothing refused —
 * and a panel that announced every estate with no behavioural engine would be
 * shouting about a feature nobody asked for. The absent line is on the disabled
 * modes' tooltips instead, where the question actually gets asked.
 */
function renderBehaviourRefusal(host) {
  const b = behaviourMeta();
  if (!b || !b.refusal) return;
  host.appendChild(panelHeading("behaviour — refused"));
  const reason = panelMuted(b.refusal.reason);
  reason.style.color = "var(--degraded)";
  host.appendChild(reason);
  host.appendChild(panelMuted(b.refusal.remedy));
  host.appendChild(panelMuted("the drift overlay above is unaffected — it never depended on an engine."));
}

/** M1's diagnostics (`meta.behaviour.diagnostics`): every block behold dropped
 * and every thing it could not reconcile, under the legend where the figures
 * they are about are. They were reaching the wire and nothing was reading
 * them. */
function renderBehaviourDiagnostics(host) {
  const b = behaviourMeta();
  if (!b || !b.diagnostics || !b.diagnostics.length) return;
  host.appendChild(panelHeading(`behaviour diagnostics · ${b.diagnostics.length}`));
  for (const d of b.diagnostics) host.appendChild(panelMuted(d));
}

// ---------------------------------------------------------------------------
// The carve walkthrough (#254, M1.5 of #230)
//
// A Carve tab appears only when /api/project says this server is in carve mode,
// and its two ACTION steps light up only when it also says a demo copy is
// behind it (`carve.demo.runnable`) — a plain `behold carve report.json` gets
// the same six steps with the runs honestly greyed out, rather than buttons
// that 403.
//
// The walkthrough's state lives here and nowhere else: no session on the
// server, exactly as #254 asks. Reload and you're back at Advise, with whatever
// the previous run wrote still sitting in the demo copy.
// ---------------------------------------------------------------------------
let carveInfo = null; // /api/project's `carve` block (report meta + demo, or null)
let carveReport = null; // the raw report off /api/carve — the boundary lists live here
let carveState = initialCarveState();
let carveHost = null; // the panel section, mounted on first sight of carve mode
const carvedIds = new Set(); // addresses the walkthrough has taken all the way through

function carveMode() {
  return !!carveInfo;
}

/** The stepper's wiring. Everything that talks to the network or the graph. */
const carveActions = {
  go(index) {
    const id = CARVE_STEPS[index] && CARVE_STEPS[index].id;
    if (!id) return;
    if (blockedReason(carveState, id)) return;
    carveState.step = index;
    carveState.error = null;
    renderPanelCarve();
  },
  select(address) {
    selectNode(address); // the same path a graph click takes — inspect included
  },
  reset() {
    carveState = initialCarveState();
    renderPanelCarve();
  },
  markHandoff() {
    carveState.handoff = true;
    if (carveState.pick) {
      carvedIds.add(carveState.pick.node.id);
      markCarvedCards();
    }
    carveState.step = CARVE_STEPS.findIndex((s) => s.id === "done");
    renderPanelCarve();
  },
  runEmit: () => runCarveStep("emit"),
  runBridge: () => runCarveStep("bridge"),
  // The observe beat (#254, chant#1647). Not runCarveStep: the refusal has to
  // land on the Emit step (where the button lives), and "observe" is a live-
  // tier action on that step, not a step of its own.
  async runObserve() {
    if (carveState.busy || !carveState.pick) return;
    carveState.busy = "observe";
    carveState.error = null;
    renderPanelCarve();
    try {
      const res = await fetch("/api/carve/observe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ select: carveState.pick.node.id }),
      });
      const body = await res.json().catch(() => ({ error: "observe returned an unreadable body", remedy: "" }));
      if (!res.ok || body.error) {
        carveState.error = { step: "emit", ...body };
        showToast(`✗ observe: ${body.error || res.status}`, false);
      } else {
        carveState.observe = body;
        showToast(body.verdict === "observed" ? "✓ chant read it live — nothing blinked" : `✗ observe: ${body.verdict}`, body.verdict === "observed");
      }
    } catch (err) {
      carveState.error = { step: "emit", error: String((err && err.message) || err), remedy: "Is the behold server still running?" };
    } finally {
      carveState.busy = null;
      renderPanelCarve();
    }
  },
  async runPlan() {
    if (carveState.busy) return;
    carveState.busy = "plan";
    carveState.error = null;
    renderPanelCarve();
    try {
      const res = await fetch("/api/carve/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = await res.json().catch(() => ({ error: "plan returned an unreadable body", remedy: "" }));
      if (!res.ok || body.error) {
        carveState.error = { step: "handoff", ...body };
        showToast(`✗ terraform plan: ${body.error || res.status}`, false);
      } else {
        carveState.plan = body;
        showToast(body.noDestroy ? "✓ plan: nothing to destroy" : "✗ plan wants to destroy something", body.noDestroy);
      }
    } catch (err) {
      carveState.error = { step: "handoff", error: String((err && err.message) || err), remedy: "Is the behold server still running?" };
    } finally {
      carveState.busy = null;
      renderPanelCarve();
    }
  },
  copy(text, el) {
    const done = () => {
      el.dataset.copied = "1";
      const was = el.textContent;
      el.textContent = "copied ✓";
      setTimeout(() => {
        el.textContent = was;
      }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
    else done();
  },
};

/** Run one of the two safe steps. Both are POSTs with a `{select}` body; both
 * answer either their result or #193's `{error, code, remedy}`. */
/**
 * Re-read the manifest-backed carve state (#230 M3) after a step wrote one.
 *
 * One `/api/project` plus a graph reload: the panel's "carved so far" and the
 * repainted card both come off the manifests on disk, so an in-session update
 * and a post-restart read are the same read. A failed refresh leaves what was
 * already shown alone — stale is better than a state change nobody made.
 */
async function refreshCarveState() {
  try {
    const info = await apiFetch("/api/project").then((r) => r.json());
    projectInfo = info;
    carveInfo = info.carve || null;
  } catch {
    return;
  }
  renderPanelScope();
  renderPanelCarve();
  await load();
}

async function runCarveStep(which) {
  if (carveState.busy || !carveState.pick) return;
  carveState.busy = which;
  carveState.error = null;
  renderPanelCarve();
  try {
    const res = await fetch(`/api/carve/${which}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ select: carveState.pick.node.id }),
    });
    const body = await res.json().catch(() => ({ error: `${which} returned an unreadable body`, remedy: "" }));
    if (!res.ok || body.error) {
      carveState.error = { step: which, ...body };
      showToast(`✗ carve ${which}: ${body.error || res.status}`, false);
    } else {
      carveState[which] = body;
      // Deliberately does NOT advance. The result IS the step — the emitted
      // source and the lint verdict, the proposed patch — and skipping past it
      // to the next button would hide the thing the run was for. The "next"
      // control unlocks; pressing it stays the viewer's move.
      showToast(`✓ carve ${which} — wrote into ${(carveInfo.demo && carveInfo.demo.outLabel) || "the demo copy"}`, true);
      // #230 M3: the step just wrote a carve manifest. Re-read it rather than
      // inferring the new state from the response — the file on disk is what
      // the panel and the card claim to be showing, and after a reload it is
      // the only thing left.
      await refreshCarveState();
    }
  } catch (err) {
    carveState.error = { step: which, error: String((err && err.message) || err), remedy: "Is the behold server still running?" };
  } finally {
    carveState.busy = null;
    renderPanelCarve();
  }
}

/** A picked card becomes the walkthrough's subject. Called from the graph's
 * click handler and from selectNode(), so the panel rows and the cards agree. */
function carvePick(node) {
  if (!carveMode()) return;
  const resource = (carveReport && carveReport.resources ? carveReport.resources : []).find((r) => r.address === node.id) || null;
  const pickStep = CARVE_STEPS.findIndex((s) => s.id === "pick");
  // A NEW pick invalidates the runs that were about the old one — showing one
  // resource's emitted source under another's name is the one way this panel
  // could actively lie — and drops the walkthrough back to Pick, wherever it
  // had got to. Re-clicking the SAME card is just a re-select and moves
  // nothing, so reading a card mid-walkthrough costs no progress.
  if (!carveState.pick || carveState.pick.node.id !== node.id) {
    carveState.emit = null;
    carveState.bridge = null;
    carveState.handoff = false;
    carveState.observe = null;
    carveState.error = null;
    carveState.step = pickStep;
  } else if (carveState.step < pickStep) {
    carveState.step = pickStep;
  }
  carveState.pick = { node, resource };
  renderPanelCarve();
}

/** The "carved" marker the last step leaves on the card — a class the CSS
 * paints plus a small label. Re-applied after every render, because the SVG is
 * replaced wholesale on each load. The full morph (the box sliding out of the
 * Terraform boundary and into the chant project beside last month's carves) is
 * the follow-up; this is the honest still frame of it. */
function markCarvedCards() {
  const svg = document.querySelector("#graph svg");
  if (!svg) return;
  // chant#2040: a chant node whose declaring file a carve manifest names is
  // carved out of Terraform — the server joins it as `_carve` on the entity
  // graph and the overlay, so the same still frame the walkthrough draws also
  // appears on an ordinary estate that holds manifests.
  const joined = new Set((lastGraphIr && lastGraphIr.nodes ? lastGraphIr.nodes : []).filter((n) => n.attrs && n.attrs._carve).map((n) => n.id));
  if (!carvedIds.size && !joined.size) return;
  for (const g of svg.querySelectorAll("[data-node-id]")) {
    const id = g.getAttribute("data-node-id");
    if ((!carvedIds.has(id) && !joined.has(id)) || g.querySelector('[data-carved="1"]')) continue;
    g.classList.add("carved");
    // Measured, not read off attributes: pinhole sizes the card from its
    // content and doesn't always stamp width/height, and a missing attribute
    // read as 0 parks the label at the group's origin — which is off the card
    // entirely (seen in the browser before this was measured instead).
    const rect = g.querySelector("rect");
    const box = rect && rect.getBBox ? rect.getBBox() : null;
    const tag = document.createElementNS("http://www.w3.org/2000/svg", "text");
    tag.setAttribute("data-carved", "1");
    // Inside the card's own box, bottom-right — the one corner the terraform
    // presentation pack leaves empty.
    tag.setAttribute("x", String((box ? box.x + box.width : 150) - 10));
    tag.setAttribute("y", String((box ? box.y + box.height : 60) - 9));
    tag.setAttribute("text-anchor", "end");
    tag.setAttribute("font-size", "11");
    tag.setAttribute("font-weight", "600");
    tag.setAttribute("fill", "var(--managed)");
    tag.textContent = "✓ carved → chant";
    g.appendChild(tag);
  }
}

/**
 * #284 item 2: mark the step the playhead sits on, on the graph itself.
 *
 * The card's tone already moved (the server paints `_status`), but "here" and
 * "done" must not read the same, so the position also wears a dashed edge —
 * the same after-the-render SVG stamp markCarvedCards() uses, for the same
 * reason: the SVG is replaced wholesale on every render.
 */
function markPlayhead(ir) {
  const svg = document.querySelector("#graph svg");
  if (!svg) return;
  const here = (ir.nodes || []).find((n) => n.attrs && n.attrs._playhead);
  if (!here) return;
  const g = svg.querySelector('[data-node-id="' + CSS.escape(here.id) + '"]');
  if (g) g.classList.add("playhead");
}

/**
 * #234's free rider: name the operating loop's home in the estate graph.
 *
 * An `OperatorStack` (chant#1940) renders as an ordinary namespace of CronJobs,
 * so the loop was already on the picture — anonymously. The server marks the
 * Namespace and its tick CronJobs from chant's own labels (`_operator`, see
 * src/operator.ts); this is the paint, in the same after-the-render stamp shape
 * markCarvedCards() uses, and for the same reason: the SVG is replaced wholesale
 * on every render.
 */
const OPERATOR_MARK_LABEL = { home: "⟳ operating loop", tick: "⟳ converge tick" };
function markOperatorCards(ir) {
  const svg = document.querySelector("#graph svg");
  if (!svg) return;
  for (const n of ir.nodes || []) {
    const mark = n.attrs && n.attrs._operator;
    if (!mark || !OPERATOR_MARK_LABEL[mark.role]) continue;
    const g = svg.querySelector('[data-node-id="' + CSS.escape(n.id) + '"]');
    if (!g || g.querySelector('[data-operator="1"]')) continue;
    g.classList.add("operator-home");
    // Measured, not read off attributes — markCarvedCards()'s note applies here
    // verbatim (pinhole sizes a card from its content).
    const rect = g.querySelector("rect");
    const box = rect && rect.getBBox ? rect.getBBox() : null;
    const tag = document.createElementNS("http://www.w3.org/2000/svg", "text");
    tag.setAttribute("data-operator", "1");
    tag.setAttribute("x", String((box ? box.x + box.width : 150) - 10));
    tag.setAttribute("y", String((box ? box.y + box.height : 60) - 9));
    tag.setAttribute("text-anchor", "end");
    tag.setAttribute("font-size", "11");
    tag.setAttribute("font-weight", "600");
    tag.setAttribute("fill", "var(--pending)");
    tag.textContent = OPERATOR_MARK_LABEL[mark.role];
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent =
      mark.role === "home"
        ? `The operating loop's home: namespace ${mark.namespace}${mark.stack ? ` (OperatorStack ${mark.stack})` : ""}` +
          `${mark.ticks && mark.ticks.length ? ` — ticks ${mark.ticks.join(", ")}` : ""}`
        : `Ticks the ConvergeOp ${mark.op}${mark.schedule ? ` on ${mark.schedule}` : ""}`;
    g.appendChild(title);
    g.appendChild(tag);
  }
}

/**
 * #404: the second signal on a bound choudoufu card — the plan would change an
 * attribute on a resource the estate demonstrably owns.
 *
 * The ownership verdict keeps the card's FILL: bound is still green, and this
 * only adds a stroke and a corner glyph, the same post-render stamp
 * `markCarvedCards`/`markOperatorCards` use (pinhole's SVG arrives from the
 * server as a string and is replaced on every render, so a mark has to be
 * re-applied here rather than asked for at layout time).
 *
 * `~` is OpenTofu's own symbol for update-in-place, so the card and the
 * terminal read the same. The corner is the bottom-right one the carve and
 * operator marks also use — a choudoufu card is never carved (that is chant
 * source) and never the operating loop's home (that is Kubernetes), so on the
 * estates this can appear on the corner is free; the guard below still skips a
 * card that already carries one of those, rather than drawing over it.
 */
/**
 * The cards whose member is still being read (#422).
 *
 * The same post-render stamp `markCarvedCards`/`markDriftedCards` use, and for
 * the same reason: pinhole's SVG arrives as a string and is replaced on every
 * render, so a mark is re-applied here rather than asked for at layout time.
 *
 * A dashed outline and a muted corner rather than a fill, because the fill is
 * the status channel and this card HAS no status yet — painting one would be
 * the claim the whole milestone exists to avoid. `_pendingRead` rides its own
 * attr for the same reason: a fifth `_status` value falls back to neutral in
 * pinhole's painter, which reads as "unobserved", which is a different and
 * wrong thing.
 */
function markPendingCards(ir) {
  const svg = document.querySelector("#graph svg");
  if (!svg) return;
  for (const n of (ir && ir.nodes) || []) {
    const g = svg.querySelector('[data-node-id="' + CSS.escape(n.id) + '"]');
    if (!g) continue;
    const pending = !!(n.attrs && n.attrs._pendingRead);
    g.toggleAttribute("data-pending-read", pending);
    if (pending && !g.querySelector("title")) {
      const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
      t.textContent = "still reading this member — not yet observed";
      g.appendChild(t);
    }
  }
}

/**
 * The marker-vs-derived mark on each choudoufu card the live overlay bound
 * (`attrs._identity`, src/choudoufu-live.ts): a small tag badge on the card's
 * top-right edge, filled when the object wears the estate's marker and
 * outlined when it does not. A card has no free corner for words, so they are
 * the badge's tooltip, and the inspect pane's `bound` and `marker` rows. Same
 * after-the-render stamp as markCarvedCards(), for the same reason.
 */
function markIdentityCards(ir) {
  const svg = document.querySelector("#graph svg");
  if (!svg) return;
  // A member frame merges identities into lastGraphIr (web/pending.js), and a
  // re-render (a theme change, a fit) may paint from another IR object, so
  // both are read.
  const known = new Map();
  for (const src of [lastGraphIr, ir]) for (const n of (src && src.nodes) || []) if (n.attrs && n.attrs._identity) known.set(n.id, n.attrs._identity);
  for (const [id, identity] of known) {
    const n = { id };
    const mark = identityMark(identity);
    if (!mark || mark.glyph === "none") continue;
    const g = svg.querySelector('[data-node-id="' + CSS.escape(n.id) + '"]');
    if (!g || g.querySelector('[data-identity="1"]')) continue;
    const rect = g.querySelector("rect");
    const box = rect && rect.getBBox ? rect.getBBox() : null;
    const size = 14;
    const x = (box ? box.x + box.width : 150) - size - 6;
    const y = (box ? box.y : 0) - size / 2;
    const wrap = document.createElementNS("http://www.w3.org/2000/svg", "g");
    wrap.setAttribute("data-identity", "1");
    wrap.setAttribute("class", "identity-mark");
    wrap.innerHTML =
      `<rect x="${x - 3}" y="${y - 2}" width="${size + 6}" height="${size + 4}" rx="5" fill="var(--bg)" stroke="var(--managed)" stroke-width="1"/>` +
      tagGlyphSvg(mark.glyph, x, y, size, "var(--managed)");
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${mark.label}: ${mark.tip}`;
    wrap.prepend(title);
    g.appendChild(wrap);
  }
}

function markDriftedCards(ir) {
  const svg = document.querySelector("#graph svg");
  if (!svg) return;
  for (const n of ir.nodes || []) {
    const mark = n.attrs && n.attrs._planDrift;
    if (!mark || !mark.attributes || !mark.attributes.length) continue;
    const g = svg.querySelector('[data-node-id="' + CSS.escape(n.id) + '"]');
    if (!g || g.querySelector('[data-plan-drift="1"]')) continue;
    if (g.querySelector('[data-carved="1"]') || g.querySelector('[data-operator="1"]')) continue;
    g.classList.add("plan-drifted");
    // Measured, not read off attributes — markCarvedCards()'s note applies
    // here verbatim (pinhole sizes a card from its content).
    const rect = g.querySelector("rect");
    const box = rect && rect.getBBox ? rect.getBBox() : null;
    const tag = document.createElementNS("http://www.w3.org/2000/svg", "text");
    tag.setAttribute("data-plan-drift", "1");
    tag.setAttribute("x", String((box ? box.x + box.width : 150) - 10));
    tag.setAttribute("y", String((box ? box.y + box.height : 60) - 9));
    tag.setAttribute("text-anchor", "end");
    tag.setAttribute("font-size", "11");
    tag.setAttribute("font-weight", "600");
    tag.setAttribute("fill", "var(--degraded)");
    // A COUNT, not the attribute names: a name like `image_tag_mutability` is
    // wider than the corner and runs into the card's own subtitle (seen in the
    // browser). The count is bounded whatever the provider calls its fields,
    // and the names are one hover — or one click, in the pane — away.
    const count_ = mark.attributes.length;
    tag.textContent = `~ ${count_} attribute${count_ === 1 ? "" : "s"}`;
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `The plan would ${(mark.actions || ["update"]).join("+")} this: ${mark.attributes.join(", ")}. Ownership is unchanged — the card's color is still its ownership verdict.`;
    g.appendChild(title);
    g.appendChild(tag);
  }
}

// --- #490: a terragucci estate, painted from its reports ----------------------
// /api/terragucci answers each root's newest plan, drift and apply run, the
// cards they flag and the waves waiting for an approval. Marks are dated
// corner glyphs, never a fill: the fill is the live-status channel, and none
// of this is live. A waiting wave offers its approve line to copy, no button.
let tgAnswer = null;
let tgHost = null;
let tgTimeline = null; // #506: /api/terragucci/timeline, the audit record's lane
let tgHistory = null; // #522: /api/lifecycle/history, the gate ledgers' history
/** behold#752: whether serve reads terragucci's reports; without them a pin's run view is never asked (chant's demo has none). */
let tgServed = false;
async function initTerragucci() {
  const project = await apiFetch("/api/project").then((r) => r.json()).catch(() => ({}));
  kioskRoots = project.terragucciRoots || null; // behold#571
  if (!project.terragucciReports) return;
  tgServed = true;
  // #715: the live carve's gate, asked beside the reports; closed, nothing below changes.
  if (!staticMode) void liveCarveGate();
  await loadTerragucci();
  // #505: the chant/lifecycle lane, and what moved while this page is open.
  if (staticMode) return;
  await loadTerragucciLane();
  watchTerragucci();
}
// --- #715: the live carve ------------------------------------------------------
// /api/terragucci/carve answers `live: true` only when the estate has
// choudoufu roots or the reports hold estate rosters. Until it does (and has a
// resource to draw), the dots layer is never mounted and the page is as it
// was; the gate is asked again now and then, since the first wave's rosters
// may land after the page opened.
var liveCarve = null; // var: render() may run before this line is reached
let liveGateTimer = 0;
const LIVE_GATE_MS = 30_000;
// The gate is open but nothing is drawable yet (a cycle's start, before the stock roster lands): ask again soon (#711).
const LIVE_GATE_OPEN_MS = 5_000;
async function liveCarveGate() {
  clearTimeout(liveGateTimer);
  let a = null;
  try {
    a = await apiFetch("/api/terragucci/carve").then((r) => r.json());
  } catch {
    a = null;
  }
  if (carveDrawable(a)) {
    liveCarve = a;
    const g = document.getElementById("graph");
    const svgEl = currentSvg();
    if (g && svgEl) mountLiveCarve(g, svgEl);
    return;
  }
  liveGateTimer = setTimeout(() => void liveCarveGate(), a && a.live === true ? LIVE_GATE_OPEN_MS : LIVE_GATE_MS);
}
function mountLiveCarve(g, svgEl) {
  if (!vbInit) return;
  mountDots({
    host: g,
    svg: svgEl,
    meta: {},
    vbInit: vbInit.slice(),
    getVB: () => vb,
    setVB: (a) => {
      // A held small stage in Watch keeps its one framing: only the carve's director moves the camera then.
      if (kioskHeld && kioskShot && !dotsCarving()) return;
      vb = a.slice();
      vbAtFit = false;
      applyVB();
    },
    live: liveCarve,
    kiosk: !!embedOpts.bare,
    // The kiosk's shot waits while the carve directs, and takes the camera back after.
    onCarving: (on) => {
      if (on && shotAnim) {
        cancelAnimationFrame(shotAnim.raf);
        shotAnim = null;
      }
      if (!on && kioskShot) queueMicrotask(() => applyKioskShot(true));
    },
  })
    .then(fitClearOfRail)
    .catch((err) => console.warn("live carve:", err));
}

/** behold#729: the rail mounts after the graph's first fit; a view still at its fit or shot moves clear of it. */
function fitClearOfRail() {
  if (kioskShot) applyKioskShot(false);
  else if (vbAtFit) fitGraph();
}

let tgLifecycle = null;
let tgPolled = null;
async function loadTerragucciLane({ fresh = false } = {}) {
  tgLifecycle = await apiFetch(`/api/terragucci/lifecycle${fresh ? "?fresh=1" : ""}`)
    .then((r) => r.json())
    .catch((e) => ({ error: String(e) }));
  renderTerragucciPanel();
}
// The server polls only while this stream is open, and stops when the page goes.
function watchTerragucci() {
  if (typeof EventSource === "undefined") return;
  const es = new EventSource("/api/terragucci/events");
  es.addEventListener("reports", () => loadTerragucci({ fresh: true }));
  // #511: the run view moved while a wave applies.
  es.addEventListener("progress", (e) => {
    const pushed = JSON.parse(e.data);
    // #569: the pushed view is the newest run's; a view pinned to another run reads its own again.
    if (tgPushFits(pushed)) {
      tgProgress = pushed;
      paintTgProgress();
    } else if (tgPinsCommit(view.run)) void loadTgProgress({ fresh: true });
  });
  es.addEventListener("lifecycle", (e) => {
    tgLifecycle = JSON.parse(e.data);
    renderTerragucciPanel();
  });
  es.addEventListener("polled", (e) => {
    tgPolled = JSON.parse(e.data);
    renderTerragucciPanel();
  });
}
function renderTerragucciLane(host, now) {
  if (staticMode || (!tgLifecycle && !tgPolled)) return;
  renderLane(host, tgLifecycle, tgPolled, now, { button, copy: copyToClipboard, link: tgLink });
}
async function loadTerragucci({ fresh = false } = {}) {
  const answer = await apiFetch(`/api/terragucci${fresh ? "?fresh=1" : ""}`)
    .then((r) => r.json())
    .catch((e) => ({ error: String(e), code: "terragucci-report", remedy: "" }));
  tgAnswer = answer;
  sceneInPlaceOfRefusal();
  klGate();
  // #506: the timeline, whole; the inspect pane filters it by a card's root.
  tgTimeline = await apiFetch(`/api/terragucci/timeline${fresh ? "?fresh=1" : ""}`)
    .then((r) => r.json())
    .catch((e) => ({ error: String(e), code: "terragucci-report", remedy: "" }));
  // #522: the gate ledgers' history, with or in place of the audit record.
  tgHistory = await apiFetch(`/api/lifecycle/history${fresh ? "?fresh=1" : ""}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  renderTerragucciPanel();
  markTerragucciCards();
  if (!staticMode) await loadTgProgress({ fresh });
  tgRefreshSoon();
}
/**
 * The kiosk's frame is pinned to one step's run (#569) and swapped for the next step's, so it reads again soon while
 * what its pin names isn't written yet: the pull request's plan (the plan job is still running), or the merge's run
 * view (the waves have not started). The plan then lights from planned on, and the waves' own states take over as
 * soon as their run view is there, without waiting for the reports poll.
 */
var tgSoon = null;
var TG_SOON_MS = 5_000;
/** The reports alone, read fresh and drawn at once: the timeline and the gate ledgers' history (slow reads) wait for the next full read. */
async function refreshTgAnswer() {
  const answer = await apiFetch("/api/terragucci?fresh=1")
    .then((r) => r.json())
    .catch((e) => ({ error: String(e), code: "terragucci-report", remedy: "" }));
  if (!answer.error || !tgAnswer) tgAnswer = answer;
  sceneInPlaceOfRefusal();
  renderTerragucciPanel();
  markTerragucciCards();
  drawTgReads();
  tgRefreshSoon();
}
function tgRefreshSoon() {
  if (!embedOpts.bare || staticMode || tgSoon) return;
  const waits = tgPinWaits(tgAnswer, tgProgress, view.run, view.pull || null);
  if (!waits.plan && !waits.run) return;
  tgSoon = setTimeout(() => {
    tgSoon = null;
    // Asked again now: the pin may have moved while the timer ran.
    const now = tgPinWaits(tgAnswer, tgProgress, view.run, view.pull || null);
    if (now.plan) void refreshTgAnswer();
    else if (now.run) void loadTgProgress({ fresh: true }).then(tgRefreshSoon);
  }, TG_SOON_MS);
}
// #511: /api/terragucci/progress, the newest apply's run view on the cards.
let tgProgress = null;
async function loadTgProgress({ fresh = false } = {}) {
  // #569: `run` pins the run view: a commit's, or none at all (a pull request's plan, or the base).
  const pin = view.run;
  if (pin && !tgPinsCommit(pin)) {
    tgProgress = null;
    paintTgProgress();
    return;
  }
  const q = new URLSearchParams();
  if (pin) q.set("commit", pin);
  if (fresh) q.set("fresh", "1");
  const qs = q.toString();
  const answer = await apiFetch(`/api/terragucci/progress${qs ? `?${qs}` : ""}`)
    .then((r) => r.json())
    .catch((e) => ({ error: String(e) }));
  if (view.run !== pin) return; // the pin moved while this read ran
  tgProgress = answer;
  paintTgProgress();
}
/** #569: whether a pushed run view is the one the view draws: any, unless `run` pins another. */
function tgPushFits(answer) {
  const pin = view.run;
  if (!pin) return true;
  if (!tgPinsCommit(pin)) return false;
  return !!(answer && answer.run && answer.run.commit && (answer.run.commit.startsWith(pin) || pin.startsWith(answer.run.commit)));
}
/** #569: the reports as the view draws them: at `run=base` no pull request, at `run=pull-<n>` only that one's plan. */
function tgAnswerDrawn() {
  return tgPinnedAnswer(tgAnswer, view.run, view.pull || null);
}
// A prompt-driven step holds the graph from the moment its prompt starts until its reply is done or its status shows
// (the kiosk posts behold:hold, then a behold:light): progress that lands in between is queued, the latest one drawn then.
let klHold = null;
let klHeldPaint = false;
function klReleaseHold() {
  if (klHold) clearTimeout(klHold);
  klHold = null;
  if (klHeldPaint) {
    klHeldPaint = false;
    paintTgProgress();
  }
}
function paintTgProgress() {
  if (klHold) {
    klHeldPaint = true;
    return;
  }
  tgStampProgress(document.querySelector("#graph svg"), tgProgress, new Date());
  drawTgReads(); // #568: the run view's reads, once the change merged
  renderTerragucciPanel();
}
// behold#937: the kiosk's last `behold:light` message and what draws it (web/kiosk-light-frame.js).
let klMsg = null;
let klCtx = null;
const klPulsed = { token: null };
function klRedraw() {
  if (!klCtx || !klMsg || !klCtx.svg.isConnected) return;
  klDraw(klCtx.svg, klMsg, klCtx.drawnAnswer, tgStoryOn() ? tgPacedProgress() : tgProgress, { cardsOf: klCtx.cardsOf, rootBox: klCtx.rootBox, boxHost: klCtx.boxHost, compMode: klCtx.compMode, pulsed: klCtx.pulsed, below: document.documentElement.classList.contains("kiosk-ask") });
  klTellLit();
}
// behold#tips-yield: where the lit cards are on screen (frame pixels), so the kiosk's tip card never covers what the
// prompt talks about. Told when the lighting is drawn and again whenever the boxes move (a fit, a zoom), only on change.
let klLitSaid = "";
function klTellLit() {
  if (!embedOpts.host || window.parent === window || !document.documentElement.classList.contains("kiosk-ask")) return;
  const rects = [...document.querySelectorAll('#graph [data-kl="lit"]')]
    .map((g) => g.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]);
  const said = JSON.stringify(rects);
  if (said === klLitSaid) return;
  klLitSaid = said;
  try {
    window.parent.postMessage({ type: "behold:lit-rects", rects }, embedOpts.host);
  } catch {
    /* the parent went away */
  }
}
setInterval(klTellLit, 400);
// behold#940: the kiosk's word that ask mode is on, which holds between the shots (the frame's class follows it or a shot's `ask`).
let klAskFlag = false;
let klAskHeard = false;
let klArranged = false;
function klSetAsk(on) {
  const root = document.documentElement.classList;
  const was = root.contains("kiosk-ask");
  root.toggle("kiosk-ask", on);
  klGate();
  if (was !== on && embedOpts.bare) drawTgReads();
}
/** The room the graph has in ask mode, in the pane's own pixels: the pane less what the prompt covers. */
function klRoom() {
  const host = document.getElementById("graph");
  if (!host) return null;
  const pane = host.getBoundingClientRect();
  const i = kioskShot ? kioskPaneInsets(kioskShot) : { top: 0, right: 0, bottom: 0, left: 0 };
  const width = pane.width - i.left - i.right;
  const height = pane.height - i.top - i.bottom;
  return width > 0 && height > 0 ? { width, height } : { width: pane.width, height: pane.height };
}
/**
 * Ask mode lays the roots out for the room (web/kiosk-ask-layout.js): stacked, upstream on top, so the cards fill a
 * wide screen. A composed choudoufu run has none of its resources in the graph, so its scene is drawn from the run's
 * reports in place of the graph's cards (web/kiosk-estate-scene.js). Left, the graph goes back as it was drawn.
 * Idempotent: each call paints from what the graph drew.
 */
function sceneUpOn(svg) {
  return !!(svg && svg.querySelector(":scope > [data-kl-scene]"));
}
/** The frame may show its svg (web/kiosk-graph-pane.js graphMayShow), and the class that lets it (kiosk.html: hidden otherwise in ask mode). */
function klGate() {
  const svg = document.querySelector("#graph svg");
  const settled = !!(tgAnswer && !tgAnswer.error && Array.isArray(tgAnswer.roots));
  const mayShow = graphMayShow({ askOn: document.documentElement.classList.contains("kiosk-ask"), components: !!view.components, sceneUp: sceneUpOn(svg), answerSettled: settled, answerHasScene: settled && !!tgAnswer.estateScene });
  document.documentElement.classList.toggle("kl-show", mayShow);
  return { mayShow };
}
function klArrange(svg) {
  const on = document.documentElement.classList.contains("kiosk-ask") && !view.components;
  const answer = on ? tgAnswerDrawn() : null;
  if (!on || !answer || answer.error || !Array.isArray(answer.roots) || !answer.roots.length) {
    // Ask mode still on and a scene up: a read that is stale or failed for a moment (the reports as they are written)
    // keeps the last drawn scene. A composed run's graph has no cards of its own, so going back to it would be blank.
    if (keepsSceneInAsk({ askOn: on, sceneUp: sceneUpOn(svg) })) return;
    if (klArranged) {
      clearScene(svg);
      reloadLayoutDeltas();
      klArranged = false;
    }
    return;
  }
  const progress = tgStoryOn() ? tgPacedProgress() : tgProgress;
  const plan = klPlanOf(answer, progress);
  const open = klRoom();
  // The pin hides the plan for now (a pull request being planned, the reset): the estates' boxes, each waiting for
  // its cards, in place of a dark pane or the last act's cards.
  const model = sceneModel(answer, plan, progress, open) || klWaitingModel(answer, progress, open);
  if (model) {
    const first = !klArranged;
    drawScene(svg, model);
    klArranged = true;
    klGate();
    // The first draw: fit to it at once (no swoop from the graph's own framing), and again once layout and paint settle.
    if (first) {
      refitNow();
      afterFrames(requestAnimationFrame, refitNow);
    }
    return;
  }
  // Ask mode: the plain graph never paints. A scene up stays when the pin hides the plan for a moment, and with none up
  // yet the graph's own drawing is held back (klPlainGate) until the scene comes.
  if (sceneUpOn(svg) || !klGate().mayShow) return;
  if (svg.__klStash) clearScene(svg);
  if (!layoutIndex) return;
  const extras = Object.fromEntries(Object.entries(klSlotCounts(plan)).map(([id, n]) => [id, n * 22 + 6]));
  const got = askDeltas({ roots: answer.roots, nodes: layoutIndex.nodes, boxes: layoutIndex.boxes, extras, edges: plan.edges, open });
  if (!got) return;
  layoutDeltas = got.deltas;
  renderLayout();
  klArranged = true;
}
/** behold: the waiting scene, from the unpinned reports' estates, when the pinned answer is the same run's with its plan held back. */
function klWaitingModel(pinned, progress, open) {
  if (!tgAnswer || tgAnswer.error || pinned.estateScene) return null;
  return waitingModel(tgAnswer, klPlanOf(tgAnswer, progress), open);
}
// #568: the reads edges between roots of one repo, drawn over the card view.
// #569: drawn so the view shows the change without the panel: each read is a
// line from the reader (its data card when the checkout draws one, else its
// root's box) to the box of the root it reads, ending at the box's border,
// arrowed, over the boxes, with what it reads written on it; each root's box
// carries its wave and that wave's state, in the state's colour; a caption
// says which run all of it comes from. `view.focus` brings some roots forward
// and dims the rest. From the pull request's plan, or from the run view once
// merged. Not live; redrawn on each render and each read.
// behold#571: the state colours as the frame draws them on cards and boxes, each legible on every ground (theme.js frameInks).
const TG_TONE = { plan: "var(--frame-pending, var(--pending))", wait: "var(--frame-foreign, var(--foreign))", busy: "var(--frame-runtime, var(--runtime))", ok: "var(--frame-managed, var(--managed))", bad: "var(--frame-degraded, var(--degraded))", idle: "var(--frame-neutral, var(--neutral))" };
/** The same, for words on a card: read on the card's own ground. */
const TG_CARD_TONE = Object.fromEntries(Object.entries(TG_TONE).map(([k, v]) => [k, v.replace("--frame-", "--frame-card-")]));
function drawTgReads() {
  klGate();
  if (embedOpts.bare) queueMicrotask(kioskDecorate); // behold#571: once this draw is done
  if (embedOpts.bare) queueMicrotask(() => (kioskShot ? applyKioskShot(false) : kioskTellBoxes())); // behold#571: the marks moved the boxes
  if (embedOpts.bare) queueMicrotask(kioskTellDrawn); // behold#571: the kiosk swaps a reloaded frame in once it has drawn
  watchTgRuns();
  watchChantPr(); // behold#631 // #571: the wave boxes' jobs, while the components zoom is on screen
  const svg = document.querySelector("#graph svg");
  if (!svg) return;
  drawPipelineMarks(svg); // behold#571: the forge and tool marks, before the wave boxes' status finds room around them
  for (const old of svg.querySelectorAll("[data-tg-reads]")) old.remove();
  tgReadEdgesNow = []; // behold#744
  // behold#762: an edge a read line stood for comes back; this draw hides the ones its own lines stand for.
  for (const g of svg.querySelectorAll("g[data-tg-read-covers]")) g.removeAttribute("data-tg-read-covers");
  for (const old of svg.querySelectorAll("[data-tg-root]")) old.remove();
  for (const r of svg.querySelectorAll("rect[data-tg-stroke0]")) {
    r.setAttribute("stroke", r.getAttribute("data-tg-stroke0"));
    r.setAttribute("stroke-width", r.getAttribute("data-tg-width0") || "1.2");
    r.removeAttribute("data-tg-stroke0");
    r.removeAttribute("data-tg-width0");
  }
  // A card grown to hold a cone's lines goes back to its own height (drawTgComponentMarks).
  for (const r of svg.querySelectorAll("rect[data-tg-h0]")) {
    r.setAttribute("height", r.getAttribute("data-tg-h0"));
    r.removeAttribute("data-tg-h0");
  }
  for (const r of svg.querySelectorAll("[data-tg-fill0]")) {
    r.setAttribute("fill", r.getAttribute("data-tg-fill0"));
    r.removeAttribute("data-tg-fill0");
  }
  for (const t of svg.querySelectorAll("[data-tg-hid]")) {
    t.removeAttribute("data-tg-hid");
    if (!t.hasAttribute("data-kiosk-quiet")) t.removeAttribute("visibility");
  }
  for (const g of svg.querySelectorAll("[data-tg-dim]")) {
    g.removeAttribute("data-tg-dim");
    g.style.opacity = "";
  }
  // behold#631: a chant repo's pull-request loop marks its components from chant's records, not terragucci's reports.
  const chantMode = chantPrDrawn();
  // Report minor 34: last draw's cone lights go; drawConeLights sets this draw's.
  if (chantMode || !tgAnswer || tgAnswer.error || !tgAnswer.roots) drawConeLights(svg, { stage: null });
  if (!chantMode && (!tgAnswer || tgAnswer.error || !tgAnswer.roots)) return;
  if (embedOpts.bare && !chantMode) klArrange(svg); // behold#940
  const toSvg = svg.getScreenCTM && svg.getScreenCTM();
  if (!toSvg) return;
  const inv = toSvg.inverse();
  // A card's box in the svg's own coordinates, whatever transform a layout put on it.
  const boxOf = (g) => {
    let b;
    try {
      b = g.getBBox();
    } catch {
      return null;
    }
    const ctm = g.getScreenCTM && g.getScreenCTM();
    if (!ctm || !b.width) return null;
    const m = inv.multiply(ctm);
    const pts = [[b.x, b.y], [b.x + b.width, b.y + b.height]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
    return { x: Math.min(pts[0].x, pts[1].x), y: Math.min(pts[0].y, pts[1].y), x2: Math.max(pts[0].x, pts[1].x), y2: Math.max(pts[0].y, pts[1].y) };
  };
  const union = (boxes) => (boxes.length ? { x: Math.min(...boxes.map((b) => b.x)), y: Math.min(...boxes.map((b) => b.y)), x2: Math.max(...boxes.map((b) => b.x2)), y2: Math.max(...boxes.map((b) => b.y2)) } : null);
  const rootOf = (path) => tgAnswer.roots.find((x) => x.path === path) || null;
  // #571: on a terragucci repo's components zoom each root is one card, in a
  // box per wave: the reads run card to card, and the marks go on the cards
  // and the wave boxes (drawTgComponentMarks).
  const compMode = !!(view.components && terragucciComponentsRepo && tgComponentFacets);
  const componentsOfRoot = (r) => {
    const roots = (tgComponentFacets && tgComponentFacets.roots) || {};
    const named = (tgComponentFacets && tgComponentFacets.jobs ? tgComponentFacets.jobs.map((j) => j.component) : []).filter((c) => (roots[c] || c) === r.path || (roots[c] || c) === r.name);
    return named.length ? named : [r.name];
  };
  const groupRect = (path) => {
    const r = rootOf(path);
    if (compMode) return null;
    return r ? svg.querySelector(`rect[data-group-id="${CSS.escape(r.name)}"]`) : null;
  };
  const cardsOf = (path) => {
    const r = rootOf(path);
    if (!r) return [];
    if (compMode) return componentsOfRoot(r).map((c) => svg.querySelector(`[data-node-id="${CSS.escape(c)}"]`)).filter(Boolean);
    const prefix = `${r.member}/${r.name}/`;
    return [...svg.querySelectorAll("[data-node-id]")].filter((g) => (g.getAttribute("data-node-id") || "").startsWith(prefix));
  };
  const rootBox = (path) => {
    const rect = groupRect(path);
    return (rect && boxOf(rect)) || union(cardsOf(path).map(boxOf).filter(Boolean));
  };
  // behold#940: the box's own group and rect, in the group's own units, for a label that rides with the box.
  const boxHost = (path) => {
    const rect = groupRect(path);
    const parent = rect && rect.parentNode;
    if (!parent || !parent.hasAttribute || !parent.hasAttribute("data-layout-box")) return null;
    const x = parseFloat(rect.getAttribute("x"));
    const y = parseFloat(rect.getAttribute("y"));
    const h = parseFloat(rect.getAttribute("height"));
    return Number.isFinite(x) && Number.isFinite(y) && h > 0 ? { parent, x, y, y2: y + h } : null;
  };
  const NS = "http://www.w3.org/2000/svg";
  const make = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text !== undefined) n.textContent = text;
    return n;
  };
  if (chantMode) {
    // behold#631: a kiosk passer-by can't place a card's type glyph (it reads as a checkbox): a chant repo's kiosk hides it.
    if (embedOpts.bare) kioskCardGlyphs(svg);
    const chantMarks = chantComponentMarks(chantPaced(), chantFacets, { kiosk: !!embedOpts.bare });
    if (embedOpts.bare) chantKioskWaves(svg, boxOf, chantMarks.waveFont || 18);
    drawTgComponentMarks(svg, { marks: chantMarks, focus: null, boxOf, make, edgePoints: chantEdgePoints(svg) });
    drawReach(svg, chantMarks.reach || null, boxOf, chantMarks.waveFont || 18);
    tipComponentEdges(svg); // behold#744
    return;
  }
  const layer = make("g", { "data-tg-reads": "1", "pointer-events": "none" });
  svg.appendChild(layer); // over the boxes and cards: the lines end at the borders, and the labels carry a background
  // behold#744: the read lines' pointer targets, under the cards (a line crossing a card leaves the card its pointer) and over the edges.
  const hits = make("g", { "data-tg-reads": "hits" });
  let under = svg.querySelector("[data-node-id]");
  while (under && under.parentNode !== svg) under = under.parentNode;
  svg.insertBefore(hits, under || layer);
  // A pill of text with a background, centred on (cx, cy); measured once it is in the svg.
  const pill = (parent, cx, cy, text, { stroke, fill = "var(--panel)", color = "var(--fg)", size = 13, weight = 600, anchor = "middle", cls = "", attrs = {} } = {}) => {
    const g = make("g", { ...(cls ? { class: cls } : {}), ...attrs }); // behold#744: a read's pill is hidden from its first style, never faded out
    const rect = make("rect", { rx: 6, fill, stroke: stroke || "var(--rule)", "stroke-width": 1.5 });
    const t = make("text", { x: cx, y: cy, "text-anchor": anchor, "dominant-baseline": "central", "font-size": size, "font-weight": weight, fill: color }, text);
    g.append(rect, t);
    parent.appendChild(g);
    let w = text.length * size * 0.58;
    try {
      w = t.getComputedTextLength() || w;
    } catch {
      /* not laid out: the estimate stands */
    }
    const padX = 8;
    const h = size + 10;
    const left = anchor === "end" ? cx - w : anchor === "start" ? cx : cx - w / 2;
    rect.setAttribute("x", String(left - padX));
    rect.setAttribute("y", String(cy - h / 2));
    rect.setAttribute("width", String(w + 2 * padX));
    rect.setAttribute("height", String(h));
    return { g, w: w + 2 * padX, h };
  };

  // The roots: each box's wave and state, in its colour.
  const drawnAnswer = tgAnswerDrawn();
  const states = tgRootStates(drawnAnswer, tgProgress);
  const focus = view.focus ? new Set(view.focus.split(",")) : null;
  const boxes = [];
  for (const r of tgAnswer.roots) {
    const rect = groupRect(r.path);
    const st = states.roots[r.path];
    const b = rootBox(r.path);
    if (b) boxes.push(b);
    if (focus && !focus.has(r.path) && !focus.has(r.name)) {
      for (const el of [rect && rect.parentElement, ...cardsOf(r.path)]) {
        if (!el) continue;
        // #571: a card on the components zoom keeps its body opaque, so the graph's edges behind it stay hidden; what is on it dims.
        const parts = compMode ? [...el.children].filter((c) => c !== el.querySelector(":scope > rect")) : [el];
        for (const part of parts) {
          part.setAttribute("data-tg-dim", "1");
          part.style.opacity = "0.5";
        }
      }
    }
    if (!rect || !st || !b) continue;
    const tone = TG_TONE[st.tone] || TG_TONE.idle;
    rect.setAttribute("data-tg-stroke0", rect.getAttribute("stroke") || "");
    rect.setAttribute("data-tg-width0", rect.getAttribute("stroke-width") || "1.2");
    if (st.state !== "outside" && st.state !== "unchanged") {
      rect.setAttribute("stroke", tone);
      rect.setAttribute("stroke-width", focus && (focus.has(r.path) || focus.has(r.name)) ? "4" : "2.5");
    }
    const mark = make("g", { "data-tg-root": r.path, "pointer-events": "none" });
    if (focus && !focus.has(r.path) && !focus.has(r.name)) mark.style.opacity = "0.6";
    layer.parentNode.insertBefore(mark, layer);
    // The badge: on the box's top border, right-aligned, like a tab; the "N
    // resources" count in the header row under it gives way.
    // In the svg's own units, where the box is now: a box moved by a layout delta sits in a group that carries its offset.
    const placed = boxOf(rect);
    const local = placed ? { x: placed.x, y: placed.y, width: placed.x2 - placed.x, height: placed.y2 - placed.y } : rect.getBBox();
    const headY = local.y + 23;
    const tabY = local.y;
    for (const t of svg.querySelectorAll("text")) {
      if (t.closest("[data-node-id]") || t.closest("[data-tg-root]") || t.closest("[data-tg-reads]")) continue;
      const tb = t.getBBox();
      if (/^\d+ resources?$/.test((t.textContent || "").trim()) && Math.abs(tb.y + tb.height / 2 - headY) < 12 && tb.x > local.x && tb.x < local.x + local.width) {
        t.setAttribute("visibility", "hidden");
        t.setAttribute("data-tg-hid", "1");
      }
    }
    // Filled when something happened or waits on the root; an outline when nothing has yet.
    const solid = st.state !== "outside" && st.state !== "not-started" && st.state !== "unchanged";
    // behold#940: in ask mode the badge says the step's own word, with no wave.
    const askWords = embedOpts.bare && document.documentElement.classList.contains("kiosk-ask") ? klBadge(st, r.path, tgStoryOn() ? tgPacedProgress() : tgProgress) : null;
    const badgeText = askWords || st.words;
    const badge = pill(mark, local.x + local.width - 16, tabY, badgeText, { stroke: tone, fill: solid ? tone : "var(--panel)", color: solid ? "var(--bg)" : "var(--fg)", size: 14, weight: 700, anchor: "end", cls: st.state === "applying" ? "pin-pulse" : "" });
    badge.g.appendChild(make("title", {}, [badgeText, ...st.facts].join("\n") + "\n(from terragucci's reports, not live)"));
    // The facts under it, at the box's bottom right: the plan a wave waits on, its changes.
    // Packed into one line that fits the box, most telling first; the rest is in the badge's tooltip.
    if (st.facts.length) {
      // Right-aligned and at most about three fifths of the box, so a read's arrow leaving the box has room beside it.
      const room = local.width * 0.6 - 14;
      const fill = st.state === "waiting" ? tone : "var(--muted)";
      const probe = make("text", { "font-size": 12.5, "font-weight": 600 });
      mark.appendChild(probe);
      const width = (t) => {
        probe.textContent = t;
        try {
          return probe.getComputedTextLength();
        } catch {
          return t.length * 7;
        }
      };
      const lines = [];
      let cur = "";
      const more = width(" …");
      for (const f of st.facts) {
        const next = cur ? `${cur} · ${f}` : f;
        if (!cur || width(next) <= room - more) cur = next;
        else {
          lines.push(cur);
          cur = f;
        }
      }
      if (cur) lines.push(cur);
      probe.remove();
      // One line: the box's bottom padding holds no more without touching a card.
      const shown = lines.slice(0, 1);
      if (lines.length > 1) shown[0] += " …";
      shown.forEach((t, i) => {
        mark.appendChild(make("text", { x: local.x + local.width - 14, y: local.y + local.height - 10 - (shown.length - 1 - i) * 15, "text-anchor": "end", "font-size": 12.5, "font-weight": 600, fill, "data-tg-box-facts": "1" }, t));
      });
    }
  }

  // Report minor 34: a cone plan lights what it planned and dims the rest, never hiding it (web/cone.js).
  drawConeLights(svg, { stage: states.stage, drawnAnswer, compMode, componentsOfRoot, rootOf });

  // behold#762: one line per pair. Where a read joins the two cards a dependency edge joins (either way round), the read's
  // line says both, so the edge is hidden (not removed: the layout and every index of the edges stay as they were), before
  // the read lines are routed clear of the edges that still show. An edge whose read draws no line shows again below.
  const edges = tgReadEdges(drawnAnswer, tgProgress);
  const depEdges = compMode ? [...svg.querySelectorAll("g[data-edge-from]")] : [];
  tgCoveredEdges(edges, depEdges.map((g) => ({ from: g.getAttribute("data-edge-from"), to: g.getAttribute("data-edge-to") }))).forEach((key, i) => key && depEdges[i].setAttribute("data-tg-read-covers", key));
  if (depEdges.length) ensureTgReadStyle();
  // #571: the components zoom's own marks; its wave boxes are the boxes the caption and the labels keep clear of.
  const edgePoints = compMode ? chantEdgePoints(svg) : [];
  let readMarks = null; // behold#744: the cards' and waves' states (a story's paced) that a read's pill flashes on
  if (compMode) {
    boxes.length = 0;
    // behold#741: a kiosk telling a chapter-carrying scenario looks as chant's loop does: no type glyph, the waves
    // read bottom to top, the bigger words, and the reach wedge. Without a chapter, today's marks alone.
    const story = tgStoryMarks();
    if (story) kioskCardGlyphs(svg);
    const marks = story ? tgComponentMarks(drawnAnswer, tgPacedProgress(), tgComponentFacets, { runs: tgRuns, pin: view.run || null, story }) : null;
    if (marks) {
      readMarks = marks;
      tgStoryRemember(marks);
      chantKioskWaves(svg, boxOf, marks.waveFont || 18);
    }
    boxes.push(...drawTgComponentMarks(svg, { drawnAnswer, focus, boxOf, make, edgePoints, ...(marks ? { marks } : {}) }));
    if (marks) drawReach(svg, marks.reach || null, boxOf, marks.waveFont || 18, marks.needs || {});
  }

  // The reads. #569 review: no line or label crosses text. Each line is the
  // shortest one, from a point on the reader's card (or box) border to a point
  // on the read root's box border, that crosses no text and as few cards as
  // there are; each label then sits beside its line where it covers no text
  // and crosses no line.
  if (compMode) tipComponentEdges(svg, edges); // behold#744
  const centre = (b) => ({ x: (b.x + b.x2) / 2, y: (b.y + b.y2) / 2 });
  const grow = (b, d) => ({ x: b.x - d, y: b.y - d, x2: b.x2 + d, y2: b.y2 + d });
  // Whether the segment p-q passes through the box (Liang-Barsky).
  const crosses = (p, q, b) => {
    let t0 = 0;
    let t1 = 1;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    for (const [pp, qq] of [[-dx, p.x - b.x], [dx, b.x2 - p.x], [-dy, p.y - b.y], [dy, b.y2 - p.y]]) {
      if (pp === 0) {
        if (qq < 0) return false;
        continue;
      }
      const r = qq / pp;
      if (pp < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
    return true;
  };
  // Points along a box's four sides, its corners left out.
  const borderPoints = (b, fractions) => {
    const out = [];
    for (const f of fractions) {
      const x = b.x + (b.x2 - b.x) * f;
      const y = b.y + (b.y2 - b.y) * f;
      out.push({ x, y: b.y }, { x, y: b.y2 }, { x: b.x, y }, { x: b.x2, y });
    }
    return out;
  };
  // Text to keep clear: every text drawn so far (cards, box names, badges,
  // facts, the checkout's own edge labels), a little grown.
  // behold#571: and each wave box's forge and tool marks, icons too.
  const textBoxes = [...svg.querySelectorAll("text"), ...svg.querySelectorAll(".pipeline-marks")]
    .filter((t) => !t.closest("[data-tg-reads]") && t.getAttribute("visibility") !== "hidden" && t.style.display !== "none" && (t.textContent || "").trim())
    .map(boxOf)
    .filter(Boolean)
    .map((b) => grow(b, 3));
  // behold#571: a box's title grows as the view zooms out (scaleBoxLabels), so it is kept clear at the largest it gets.
  textBoxes.push(...boxTitlesAtMost(svg, boxOf).map((b) => grow(b, 3)));
  const cardEls = [...svg.querySelectorAll("[data-node-id]")];
  const cardBoxOf = new Map(cardEls.map((g) => [g, boxOf(g)]));
  // #571: how many of the components graph's own edge points a segment runs over, so a read never hides a dependency line.
  const nearEdge = (a, z, d = 6) => {
    if (!edgePoints.length) return 0;
    const dx = z.x - a.x;
    const dy = z.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    let n = 0;
    for (const p of edgePoints) {
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      if (Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y) < d) n++;
    }
    return n;
  };
  const edgeIn = (r) => edgePoints.filter((p) => p.x >= r.x - 3 && p.x <= r.x2 + 3 && p.y >= r.y - 3 && p.y <= r.y2 + 3).length;
  const defs = svg.querySelector("defs") || svg.insertBefore(make("defs", {}), svg.firstChild);
  for (const [id, color] of [["tg-arrow-unknown", "var(--frame-foreign, var(--foreign))"], ["tg-arrow-planned", "var(--frame-pending, var(--pending))"], ["tg-arrow-applied", "var(--frame-focus, var(--focus))"]]) {
    if (svg.querySelector(`#${id}`)) continue;
    const m = make("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse", "data-tg-reads": "marker" });
    m.appendChild(make("path", { d: "M0,0 L10,5 L0,10 z", fill: color }));
    defs.appendChild(m);
  }
  const labels = [];
  const drawn = [];
  for (const e of edges) {
    const card = tgReadCardIds(tgAnswer, e).map((id) => svg.querySelector('[data-node-id="' + CSS.escape(id) + '"]')).find(Boolean);
    const kind = e.unknown.length ? "unknown" : e.outputs === "planned" ? "planned" : "applied";
    const color = kind === "unknown" ? "var(--frame-foreign, var(--foreign))" : kind === "planned" ? "var(--frame-pending, var(--pending))" : "var(--frame-focus, var(--focus))";
    if (card) {
      // The tag on the reader's card, at its bottom right, clear of the card's own "root:" line.
      const rect = card.querySelector("rect");
      const local = rect && rect.getBBox ? rect.getBBox() : null;
      const tag = make("text", { "data-tg-reads": "tag", x: (local ? local.x + local.width : 150) - 10, y: (local ? local.y + local.height : 60) - 9, "text-anchor": "end", "font-size": 11, "font-weight": 700, fill: (card.querySelector("text") && card.querySelector("text").getAttribute("fill")) || "var(--fg)", opacity: 0.8 }, tgReadTag(e));
      card.append(make("title", { "data-tg-reads": "title" }, tgReadLine(e) + "\n(from terragucci reports, not live)"), tag);
    }
    const fromBox = (card && cardBoxOf.get(card)) || (card && boxOf(card)) || rootBox(e.from);
    const toBox = rootBox(e.to);
    if (!fromBox || !toBox) continue;
    const others = cardEls.filter((g) => g !== card).map((g) => cardBoxOf.get(g)).filter((b) => b && b !== fromBox && b !== toBox && !(compMode && (sameBox(b, fromBox) || sameBox(b, toBox))));
    let best = null;
    for (const p0 of borderPoints(fromBox, [0.25, 0.5, 0.75])) {
      for (const p1 of borderPoints(toBox, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9])) {
        // Pull the ends a hair off the borders, so a line never counts the box it starts or ends on.
        const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
        if (len < 20) continue;
        const ux = (p1.x - p0.x) / len;
        const uy = (p1.y - p0.y) / len;
        const a = { x: p0.x + ux * 2, y: p0.y + uy * 2 };
        const z = { x: p1.x - ux * 2, y: p1.y - uy * 2 };
        // Leaving the reader inward, or reaching the read box from inside it, is no route.
        if (crosses({ x: a.x + ux * 4, y: a.y + uy * 4 }, { x: a.x + ux * 4, y: a.y + uy * 4 }, fromBox)) continue;
        if (crosses({ x: z.x - ux * 4, y: z.y - uy * 4 }, { x: z.x - ux * 4, y: z.y - uy * 4 }, toBox)) continue;
        const texts = textBoxes.filter((t) => crosses(a, z, t)).length;
        // behold#571: the arrowhead, not only the line, ends clear of every title and mark: a head over text costs most of all.
        const head = arrowheadBox(p0, p1);
        const heads = textBoxes.filter((t) => head.x < t.x2 && head.x2 > t.x && head.y < t.y2 && head.y2 > t.y).length;
        const cards = others.filter((c) => crosses(a, z, c)).length;
        const lines = drawn.filter((d) => crosses(a, z, grow({ x: Math.min(d.p0.x, d.p1.x), y: Math.min(d.p0.y, d.p1.y), x2: Math.max(d.p0.x, d.p1.x), y2: Math.max(d.p0.y, d.p1.y) }, 0)) && Math.hypot(d.p1.x - p1.x, d.p1.y - p1.y) < 30).length;
        const score = heads * 30000 + texts * 10000 + cards * 2000 + lines * 500 + nearEdge(a, z) * 400 + len;
        if (!best || score < best.score) best = { p0, p1, score };
      }
    }
    if (!best) continue;
    const { p0, p1 } = best;
    const key = tgReadKey(e);
    const line = make("line", { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, stroke: color, "stroke-width": 3, "stroke-dasharray": e.outputs === "planned" ? "9 6" : "none", "marker-end": `url(#tg-arrow-${kind})`, "data-tg-read-from": e.from, "data-tg-read-to": e.to, "data-tg-read": key });
    if (focus && !(focus.has(e.from) || focus.has(e.to))) line.style.opacity = "0.5";
    layer.appendChild(line);
    // behold#744: a wide clear stroke along the line takes the pointer (the drawn layer lets it through): pointing at it shows the
    // read's pill; outside a kiosk frame the shared tooltip adds the whole sentence (data-tip, no <title>: no second, native one).
    // behold#762: a line that stands for a hidden dependency edge says what the edge said too, in a kiosk frame as well.
    const stands = depEdges.filter((g) => g.getAttribute("data-tg-read-covers") === key).map((g) => tgDependsLine({ from: g.getAttribute("data-edge-from"), to: g.getAttribute("data-edge-to") }));
    const tip = stands.length ? [...stands, tgReadLine(e)].join("\n") : embedOpts.bare ? null : tgReadLine(e);
    hits.appendChild(make("line", { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, stroke: "transparent", "stroke-width": 16, "pointer-events": "stroke", "data-tg-read-hit": key, ...(tip ? { "data-tip": tip } : {}) }));
    drawn.push({ p0, p1 });
    labels.push({ e, p0, p1, color, kind, key, fromBox });
  }
  // behold#762: a read that found no route (or no card) drew no line: its pair keeps the dependency edge.
  const lined = new Set(labels.map((l) => l.key));
  for (const g of depEdges) if (g.hasAttribute("data-tg-read-covers") && !lined.has(g.getAttribute("data-tg-read-covers"))) g.removeAttribute("data-tg-read-covers");
  // behold#571: the marks step aside from the read lines, and a box lifts its marks off an arrowhead (its box then reaches higher).
  for (const [rect] of clearMarksOfReads(svg, drawn)) {
    const now = boxOf(rect);
    for (const b of boxes) if (now && Math.abs(b.x - now.x) < 0.5 && Math.abs(b.x2 - now.x2) < 0.5 && Math.abs(b.y2 - now.y2) < 0.5) b.y = now.y;
  }
  // behold#744: each read's words in a pill at the reader's end of its line, beside the reader's card and joined to it by a
  // short leader in the line's colour: covering no text where it can, never out in open ground. Drawn hidden; the pointer
  // (on the reader, the root it reads or the line), a kiosk's flash or an Inspect focus shows it (tgReadShow).
  const cardBoxes = cardEls.map((g) => cardBoxOf.get(g)).filter(Boolean);
  const headers = boxes.map((b) => ({ x: b.x, y: b.y - 14, x2: b.x2, y2: b.y + 36 }));
  const placed = [];
  const pillsBy = []; // behold#743: each pill's rect and its reader, shown or not
  const overlap = (r, b) => Math.max(0, Math.min(r.x2, b.x2) - Math.max(r.x, b.x)) * Math.max(0, Math.min(r.y2, b.y2) - Math.max(r.y, b.y));
  const sum = (r, list, k) => list.reduce((a, b) => a + k * overlap(r, b), 0);
  const span = union(boxes);
  // A kiosk with no chapters flashes on the marks drawTgComponentMarks drew from the same reads (wave jobs' status included).
  if (embedOpts.bare && compMode && !readMarks) readMarks = tgComponentMarks(drawnAnswer, tgProgress, tgComponentFacets, { runs: tgRuns, pin: view.run || null });
  const flash = embedOpts.bare ? new Map(tgReadFlash.live(edges, tgReaderStates(readMarks, states.roots)).map((f) => [f.key, f.age])) : new Map();
  // The flashing pills first: they show together, so each keeps clear of the others; a hidden one only shows with its own root's.
  const lit = [];
  for (const l of [...labels].sort((a, b) => Number(flash.has(b.key)) - Number(flash.has(a.key)))) {
    const words = `${l.e.from} ${tgReadLabel(l.e)}`;
    const size = embedOpts.bare ? 15 : 13; // a kiosk's card words are bigger too
    const p = pill(layer, 0, 0, words, { stroke: l.color, fill: "var(--bg)", color: "var(--fg)", size, weight: 600, attrs: { "data-tg-read-pill": "1", "data-tg-read": l.key } });
    const { w, h } = p;
    // The pill's own line may run under it; every other read line costs, though only a few pills show at once.
    const others = drawn.filter((d) => !(d.p0 === l.p0 && d.p1 === l.p1));
    let best = null;
    // A kiosk frame's popover opens to the right of a pointed card (placePopover): the pill keeps out from under it.
    const fb = l.fromBox;
    const popRoom = embedOpts.bare ? [{ x: fb.x2, y: fb.y, x2: fb.x2 + 3 * (fb.x2 - fb.x), y2: fb.y + 3 * (fb.y2 - fb.y) }] : [];
    // A kiosk's camera (Watch's shot) frames part of the graph: a pill stays inside what it shows.
    const vb = embedOpts.bare && svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width ? svg.viewBox.baseVal : null;
    const seen = vb ? { x: vb.x + 8, y: vb.y + 8, x2: vb.x + vb.width - 8, y2: vb.y + vb.height - 8 } : null;
    for (const s of tgPillSpots(fb, l.p0, w, h)) {
      const r = s.r;
      const lineHits = others.filter((d) => crosses(d.p0, d.p1, r)).length;
      // Outside the boxes' own span the pill may leave the drawing when the view is fitted: keep it in, and never above the
      // top box, where the caption says which run the marks are from (behold#571).
      const out = span ? (r.x2 - r.x) * (r.y2 - r.y) - overlap(r, { x: span.x - 40, y: span.y, x2: span.x2 + 40, y2: span.y2 + 40 }) : 0;
      const unseen = seen ? (r.x2 - r.x) * (r.y2 - r.y) - overlap(r, seen) : 0;
      const score = out * 80 + unseen * 80 + lineHits * 2000 + edgeIn(r) * 30 + sum(r, textBoxes, 50) + sum(r, lit, 200) + sum(r, placed, 50) + sum(r, cardBoxes, 50) + sum(r, headers, 20) + sum(r, popRoom, 4) + s.far * 12 + s.gap * 3 + s.round * 150;
      if (!best || score < best.score) best = { s, score };
    }
    if (!best) {
      p.g.remove();
      continue;
    }
    const { c, r } = best.s;
    (flash.has(l.key) ? lit : placed).push(r);
    pillsBy.push({ from: l.e.from, r, lit: flash.has(l.key) });
    p.g.setAttribute("transform", `translate(${c.x} ${c.y})`);
    // The leader: from the line's start on the card's border to the pill's nearest edge, with a dot where it leaves the card.
    const q = tgNearestOn(r, l.p0);
    p.g.insertBefore(make("line", { x1: l.p0.x - c.x, y1: l.p0.y - c.y, x2: q.x - c.x, y2: q.y - c.y, stroke: l.color, "stroke-width": 2.5 }), p.g.firstChild);
    p.g.insertBefore(make("circle", { cx: l.p0.x - c.x, cy: l.p0.y - c.y, r: 4, fill: l.color }), p.g.firstChild);
    if (flash.has(l.key)) {
      // A kiosk's flash: TG_FLASH_MS from when its reader came into the state, so a redraw midway carries on where it was.
      p.g.classList.add("tg-flash");
      p.g.style.animationDuration = `${TG_FLASH_MS}ms`;
      p.g.style.animationDelay = `-${Math.round(flash.get(l.key))}ms`;
    }
    // Inspect's focus keeps the focused roots' reads in words, as every read was before.
    if (!embedOpts.bare && focus && (focus.has(l.e.from) || focus.has(l.e.to))) p.g.classList.add("tg-shown");
  }
  tgReadEdgesNow = edges;
  tgReadShow(svg);
  // behold#937: a demo step's lighting, the states' files and looks, the unknown slots, over the marks just drawn.
  if (embedOpts.bare) {
    klCtx = { svg, drawnAnswer, rootBox, boxHost, compMode, cardsOf, pulsed: klPulsed };
    klRedraw();
  }

  // Which run the marks come from, above the boxes.
  // #569: a pin that holds the view off every plan says why in its own words.
  const shown = tgViewCaption(drawnAnswer, tgProgress, new Date(), { merged: tgPinsCommit(view.run) });
  const caption = tgPinnedCaption(tgAnswer, view.run, view.pull || null, tgProgress) || (shown ? `Showing ${shown}` : null);
  const all = union(boxes);
  if (caption && all) {
    const line = make("text", { "data-tg-reads": "caption", x: all.x, y: all.y - 22, "font-size": 16, "font-weight": 600, fill: "var(--muted)" }, caption);
    layer.appendChild(line);
    // #571: the components zoom is narrow; a caption wider than its boxes goes on two lines, broken after its colon or comma.
    let wide = 0;
    try {
      wide = line.getComputedTextLength();
    } catch {
      /* not laid out */
    }
    const cut = caption.indexOf(": ") > 0 ? caption.indexOf(": ") : caption.indexOf(", ");
    if (compMode && cut > 0 && wide > all.x2 - all.x + 40) {
      line.textContent = caption.slice(0, cut + 1);
      line.setAttribute("y", String(all.y - 42));
      layer.appendChild(make("text", { "data-tg-reads": "caption", x: all.x, y: all.y - 22, "font-size": 16, "font-weight": 600, fill: "var(--muted)" }, caption.slice(cut + 2)));
    }
  }
  // behold#743: an apply made outside the pipeline, on its estate's card, clear of the reads' pills and the caption.
  if (compMode && readMarks) {
    const captions = [...layer.querySelectorAll("text[data-tg-reads=caption]")].map(boxOf).filter(Boolean).map((b) => grow(b, 4));
    drawTgOutside(svg, { layer, make, boxOf, marks: readMarks, roots: states.roots, cardBoxOf, avoid: { pills: pillsBy, texts: textBoxes, captions, headers }, edgeIn, crosses });
  }
}

/**
 * behold#743: demo.json's `outside` (an operator's apply to app-01's estate while the pipeline's wave 3 applies it),
 * drawn as a mark joined to the estate's card: dashed, tagged "outside the pipeline", with who ran it, the command, its
 * state and its resources, and what the pipeline does to the same estate meanwhile; once both land, both changes. Only
 * a kiosk frame telling a chapter-carrying story draws it, and only while the step carries one: other scenarios, and
 * steps without it, draw nothing new. The mark is a child of the reads' layer, so the kiosk's modals and callouts keep
 * clear of it as of the pills (kioskTellBoxes' `labels`).
 */
function drawTgOutside(svg, { layer, make, boxOf, marks, roots, cardBoxOf, avoid, edgeIn, crosses }) {
  const outside = tgStoryOn() && tgStory.outside ? tgStory.outside : null;
  if (!outside || !marks || !marks.cards) return;
  const cards = marks.cards;
  const id = tgOutsideCard(outside.estate, [...Object.keys(cards), ...Object.values(cards).map((c) => c && c.root)]);
  const cid = id && (cards[id] ? id : Object.keys(cards).find((k) => cards[k] && cards[k].root === id));
  const el = cid ? svg.querySelector(`[data-node-id="${CSS.escape(cid)}"]`) : null;
  const cardBox = el ? cardBoxOf.get(el) || boxOf(el) : null;
  if (!cardBox) return;
  const m = cards[cid];
  // The pipeline's own state for the card, as the reads' flash reads it: a card whose wave's job runs now is applying.
  const pipeline = tgReaderStates(marks, roots)[m.root] || m.state;
  const plans = (m.facts || []).find((f) => /^plans /.test(f));
  const model = tgOutsideModel(outside, { pipeline, card: cid, change: plans ? plans.slice(6) : null, wave: Number.isInteger(m.wave) ? m.wave : null });
  if (!model) return;
  const tone = TG_TONE[model.tone] || TG_TONE.idle;
  const g = make("g", { "data-tg-outside": cid, "pointer-events": "none" });
  layer.appendChild(g);
  // The card's own ring, dashed in the mark's tone: the estate the outside apply is on.
  const ring = make("rect", { x: cardBox.x - 6, y: cardBox.y - 6, width: cardBox.x2 - cardBox.x + 12, height: cardBox.y2 - cardBox.y + 12, rx: 10, fill: "none", stroke: tone, "stroke-width": 2.5, "stroke-dasharray": "7 5" });
  g.appendChild(ring);
  // The words, measured where they are drawn; the box is sized to them.
  const size = embedOpts.bare ? 15 : 13;
  const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const style = {
    who: { size, weight: 700, fill: tone },
    landed: { size, weight: 700, fill: tone },
    command: { size: size - 2, weight: 500, fill: "var(--fg)", family: mono },
    resources: { size: size - 1, weight: 600, fill: "var(--fg)", family: mono },
    pipeline: { size: size - 1, weight: 600, fill: "var(--muted)" },
  };
  const body = make("g", {});
  g.appendChild(body);
  const texts = model.lines.map((l) => {
    const s = style[l.kind] || style.pipeline;
    const t = make("text", { "font-size": s.size, "font-weight": s.weight, fill: s.fill, ...(s.family ? { "font-family": s.family } : {}) }, l.text);
    if (l.kind === "who" && model.pulse) t.setAttribute("class", "pin-pulse");
    body.appendChild(t);
    let w = l.text.length * s.size * 0.6;
    try {
      w = t.getComputedTextLength() || w;
    } catch {
      /* not laid out: the estimate stands */
    }
    return { t, w, s };
  });
  const tagSize = size - 3;
  const tag = make("text", { "font-size": tagSize, "font-weight": 800, fill: "var(--bg)", "letter-spacing": "0.04em" }, model.tag.toUpperCase());
  let tagW = model.tag.length * tagSize * 0.72;
  g.appendChild(tag);
  try {
    tagW = tag.getComputedTextLength() || tagW;
  } catch {
    /* not laid out */
  }
  const padX = 14;
  const lineGap = 7;
  const top = 18; // under the tag, which sits across the top border
  const w = Math.max(tagW + 24, ...texts.map((x) => x.w)) + 2 * padX;
  const h = top + texts.reduce((a, x) => a + x.s.size + lineGap, 0) + 6;
  // Where it goes: beside the card, clear of the other cards, the card's read pills (behold#744), the caption and the
  // text around, and inside what Watch's camera shows.
  const vbb = embedOpts.bare && svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width ? svg.viewBox.baseVal : null;
  const seen = vbb ? { x: vbb.x + 8, y: vbb.y + 8, x2: vbb.x + vbb.width - 8, y2: vbb.y + vbb.height - 8 } : null;
  const overlap = (r, b) => Math.max(0, Math.min(r.x2, b.x2) - Math.max(r.x, b.x)) * Math.max(0, Math.min(r.y2, b.y2) - Math.max(r.y, b.y));
  const sum = (r, list, k) => list.reduce((a, b) => a + k * overlap(r, b), 0);
  const others = [...cardBoxOf.values()].filter((b) => b && b !== cardBox);
  const ringBox = { x: cardBox.x - 8, y: cardBox.y - 8, x2: cardBox.x2 + 8, y2: cardBox.y2 + 8 };
  // The card's own read pills (behold#744) and the ones flashing now must stay clear; the others show only on a pointer.
  const ownPills = avoid.pills.filter((x) => x.lit || x.from === m.root || x.from === cid).map((x) => x.r);
  const restPills = avoid.pills.filter((x) => !(x.lit || x.from === m.root || x.from === cid)).map((x) => x.r);
  // The leader: from the box's nearest edge to the card's ring, which it meets with a dot.
  const inner = { x: ringBox.x + 2, y: ringBox.y + 2, x2: ringBox.x2 - 2, y2: ringBox.y2 - 2 };
  const leaderOf = (r) => {
    const q = tgNearestOn(r, { x: (cardBox.x + cardBox.x2) / 2, y: (cardBox.y + cardBox.y2) / 2 });
    return { p: tgNearestOn(inner, q), q };
  };
  let best = null;
  // Slid further along a side than a pill is: the mark is wide, and a caption may sit over the card's box.
  for (const s of tgOutsideSpots(ringBox, w, h + 12, { gaps: [12, 28, 48, 72, 100, 140, 180], slides: [0, -0.25, 0.25, -0.5, 0.5, 0.75, 1, 1.25, 1.5, 1.75, -0.75, -1, -1.25] })) {
    const r = { ...s.r, y: s.r.y + 12 }; // the tag reaches 12 above the box
    const hit = { ...r, y: r.y - 12 };
    const unseen = seen ? (hit.x2 - hit.x) * (hit.y2 - hit.y) - overlap(hit, seen) : 0;
    const { p, q } = leaderOf(r);
    const across = [...avoid.texts, ...avoid.captions, ...ownPills, ...others].filter((t) => crosses(p, q, t)).length;
    const score = sum(hit, [ringBox], 400) + sum(hit, others, 200) + sum(hit, ownPills, 300) + sum(hit, restPills, 10) + sum(hit, avoid.captions, 300) + sum(hit, avoid.texts, 60) + sum(hit, avoid.headers, 15) + unseen * 120 + edgeIn(hit) * 4 + across * 4000 + s.far * 6;
    if (!best || score < best.score) best = { r, score };
  }
  if (!best) return g.remove();
  const r = best.r;
  body.prepend(make("rect", { x: r.x, y: r.y, width: w, height: h, rx: 9, fill: "var(--bg)", stroke: tone, "stroke-width": 2.5, "stroke-dasharray": "9 5" }));
  // The tag across the top border, filled, so it reads as a label of the box and not as one of the pipeline's states.
  g.insertBefore(make("rect", { x: r.x + padX - 8, y: r.y - 12, width: tagW + 16, height: 24, rx: 12, fill: tone }), tag);
  tag.setAttribute("x", String(r.x + padX));
  tag.setAttribute("y", String(r.y));
  tag.setAttribute("dominant-baseline", "central");
  let y = r.y + top;
  for (const x of texts) {
    y += x.s.size;
    x.t.setAttribute("x", String(r.x + padX));
    x.t.setAttribute("y", String(y));
    y += lineGap;
  }
  const { p, q } = leaderOf(r);
  if (Math.hypot(q.x - p.x, q.y - p.y) > 3) {
    g.insertBefore(make("line", { x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: tone, "stroke-width": 2.5, "stroke-dasharray": "6 4" }), body);
    g.insertBefore(make("circle", { cx: p.x, cy: p.y, r: 4.5, fill: tone }), body);
  }
  g.appendChild(make("title", {}, [`${model.tag}: ${outside.who} ran ${outside.command} on ${outside.estate}`, `${outside.state}${(outside.resources || []).length ? ` · ${outside.resources.join(", ")}` : ""}`, ...(outside.log || []).slice(-3)].join("\n") + "\n(from the demo's narration, demo.json)"));
}
/**
 * Report minor 34: while the view draws a pull request's plan that has a cone
 * view, each card of a root it names takes `data-cone`: `changed` and `lit`
 * (planned: outlined in the plan's colour), or `dim` (not planned: faded,
 * still drawn). A components card, one per root, lights as its root does.
 * The dots layer is told the same lights. Any other plan sets nothing.
 */
function drawConeLights(svg, { stage, drawnAnswer, compMode, componentsOfRoot, rootOf }) {
  for (const g of svg.querySelectorAll("[data-cone]")) g.removeAttribute("data-cone");
  for (const g of svg.querySelectorAll("[data-cone-dim]")) {
    g.removeAttribute("data-cone-dim");
    g.style.opacity = g.getAttribute("data-tg-dim") ? "0.5" : "";
  }
  const lights = stage === "pull-request" ? coneLights(coneOf(drawnAnswer && drawnAnswer.pull_request)) : null;
  setDotsCone(lights);
  if (!lights) return;
  const outline = (g, width) => {
    const r = g.querySelector(":scope > rect");
    if (!r) return;
    if (!r.hasAttribute("data-tg-stroke0")) {
      r.setAttribute("data-tg-stroke0", r.getAttribute("stroke") || "");
      r.setAttribute("data-tg-width0", r.getAttribute("stroke-width") || "1.2");
    }
    r.setAttribute("stroke", TG_TONE.plan);
    r.setAttribute("stroke-width", width);
  };
  const dim = (g) => {
    g.setAttribute("data-cone-dim", "1");
    g.style.opacity = "0.35";
  };
  const mark = (g, light) => {
    if (!light) return;
    g.setAttribute("data-cone", light);
    if (light === "dim") dim(g);
    // A components card is outlined by its root's state already (drawTgComponentMarks), which keeps the original stroke to put back.
    else if (!compMode) outline(g, light === "changed" ? "4" : "2.5");
  };
  if (compMode) {
    // Each components card by the root its job names (terragucci.components.json), else by the answer's root.
    const named = (tgComponentFacets && tgComponentFacets.roots) || {};
    const done = new Set();
    for (const g of svg.querySelectorAll("[data-node-id]")) {
      const id = g.getAttribute("data-node-id");
      const path = [named[id], id].find((p) => p && lights.roots.has(p));
      if (path) {
        mark(g, coneRootLight(lights, path));
        done.add(g);
      }
    }
    for (const path of lights.roots.keys()) {
      const r = rootOf(path);
      if (!r) continue;
      for (const c of componentsOfRoot(r)) {
        const g = svg.querySelector(`[data-node-id="${CSS.escape(c)}"]`);
        if (g && !done.has(g)) mark(g, coneRootLight(lights, path));
      }
    }
    return;
  }
  for (const g of svg.querySelectorAll("[data-node-id]")) {
    const at = coneCardRoot(g.getAttribute("data-node-id"), lights, (tgAnswer && tgAnswer.roots) || []);
    if (at) mark(g, coneResourceLight(lights, at.root, at.address));
  }
  // Each root's box says how the plan took it (the badge's words, web/terragucci-change.js rootStates).
  for (const m of svg.querySelectorAll("g[data-tg-root]")) {
    const light = coneRootLight(lights, m.getAttribute("data-tg-root"));
    if (light) m.setAttribute("data-cone", light);
  }
}
/**
 * How far a card (`b`, svg units) may grow down: to the next card under it, or the bottom of the box that holds it,
 * with a gap; nothing when no box holds it, so a grown card never changes what the graph spans.
 */
function roomUnder(b, svg, boxOf, own, need = 0) {
  // The innermost box that holds the card.
  let box = null;
  let boxB = null;
  for (const r of svg.querySelectorAll("rect[data-group-id]")) {
    const g = boxOf(r);
    if (g && b.x >= g.x - 0.5 && b.x2 <= g.x2 + 0.5 && b.y >= g.y - 0.5 && b.y2 <= g.y2 + 0.5 && (!boxB || g.y2 - g.y < boxB.y2 - boxB.y)) {
      box = r;
      boxB = g;
    }
  }
  if (!box) return 0;
  let cardRoom = Infinity;
  for (const c of svg.querySelectorAll("[data-node-id]")) {
    if (c === own) continue;
    const o = boxOf(c);
    if (o && o.x < b.x2 && o.x2 > b.x && o.y >= b.y2 - 0.5) cardRoom = Math.min(cardRoom, o.y - b.y2 - 8);
  }
  let room = boxB.y2 - b.y2 - 10;
  // Not enough in the box, and no card under this one in it: the box grows too, when nothing lies under the box.
  if (need > room && cardRoom === Infinity) {
    const extra = need - room;
    const below = [...svg.querySelectorAll("rect[data-group-id], [data-node-id]")].some((n) => {
      if (n === box || n === own || box.contains(n)) return false;
      const o = boxOf(n);
      return o && o.x < boxB.x2 && o.x2 > boxB.x && o.y >= boxB.y2 - 0.5 && o.y < boxB.y2 + extra + 12;
    });
    if (!below) {
      const h0 = Number(box.getAttribute("height"));
      if (!box.hasAttribute("data-tg-h0")) box.setAttribute("data-tg-h0", String(h0));
      box.setAttribute("height", String(h0 + extra));
      room = need;
    }
  }
  return Math.max(0, Math.min(room, cardRoom));
}
const sameBox = (a, b) => !!a && !!b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.x2 - b.x2) < 0.5 && Math.abs(a.y2 - b.y2) < 0.5;

/**
 * behold#744: on the components zoom an edge says what it means, not only "app-01 → cluster-a": the one depends on the
 * other, which applies first, and what it reads of it. In its <title>, which the shared tooltip shows (a kiosk frame's too).
 */
function tipComponentEdges(svg, edges = []) {
  for (const g of svg.querySelectorAll("g[data-edge-from]")) {
    const from = g.getAttribute("data-edge-from");
    const to = g.getAttribute("data-edge-to");
    const title = [...g.children].find((c) => c.localName === "title");
    if (!from || !to || !title) continue;
    const read = edges.find((e) => (e.from === from || e.from.endsWith(`/${from}`)) && (e.to === to || e.to.endsWith(`/${to}`)));
    title.textContent = `${from} → ${to}\n${from} depends on ${to}, so ${to} applies first${read ? `\n${tgReadLine(read)}` : ""}`;
  }
}

// behold#744: the reads' pills show while they matter (web/tg-read-pills.js): the pointer's, a kiosk's flash, Inspect's focus.
const tgReadFlash = createReadFlash();
let tgReadEdgesNow = [];
let tgReadHot = [];
/** The reads the pointer (or the focus) on `target` lights: a read's line, or a card or box of a root that reads or is read. */
function tgReadHotOf(target) {
  if (!target || !target.closest || !target.closest("#graph svg") || !tgReadEdgesNow.length) return [];
  const hit = target.closest("[data-tg-read-hit]");
  if (hit) return tgHotReads(tgReadEdgesNow, { key: hit.getAttribute("data-tg-read-hit") });
  const h = kioskHoverOf(target);
  return h && h.root ? tgHotReads(tgReadEdgesNow, { root: h.root }) : [];
}
function tgReadSetHot(keys) {
  if (keys.length === tgReadHot.length && keys.every((k, i) => k === tgReadHot[i])) return;
  tgReadHot = keys;
  const svg = document.querySelector("#graph svg");
  if (svg) tgReadShow(svg);
}
/** Light the hot reads' pills and lines, the lit pills last in their layer so they sit over the rest. */
function tgReadShow(svg) {
  ensureTgReadStyle();
  const hot = new Set(tgReadHot);
  for (const el of svg.querySelectorAll("[data-tg-read]")) el.classList.toggle("tg-hot", hot.has(el.getAttribute("data-tg-read")));
  for (const g of svg.querySelectorAll("g[data-tg-read-pill].tg-hot")) g.parentNode.appendChild(g);
  tgPillsKeepIn(svg);
}
/**
 * behold#764: a kiosk frame's shown pills stay inside what the frame shows. A pill is placed when the reads are drawn,
 * against the shot's viewBox then; the camera moves after, and a pointed card lights the pills of readers it has
 * panned out of view (331px over the frame's top on /tofu-fanout). A pill whose reader is out of view does not show
 * (tg-off): its leader would point at nothing. One whose reader shows slides in by as little as keeps it inside
 * (shiftInto), its leader and dot left on the reader's card. Run after each light and each camera move.
 */
function tgPillsKeepIn(svg) {
  if (!embedOpts.bare || !svg || !svg.getScreenCTM) return;
  const ctm = svg.getScreenCTM();
  const scale = ctm && ctm.a ? ctm.a : 1;
  const host = document.getElementById("graph");
  const pane = host ? host.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const coveredBelow = kioskShot && kioskShot.insets ? Math.max(0, kioskShot.insets.bottom || 0) : 0;
  const bottom = Math.min(pane.bottom, window.innerHeight - coveredBelow);
  const view = { left: Math.max(0, pane.left), top: Math.max(0, pane.top), width: Math.min(window.innerWidth, pane.right) - Math.max(0, pane.left), height: bottom - Math.max(0, pane.top) };
  for (const g of svg.querySelectorAll("g[data-tg-read-pill]")) {
    const lead = g.querySelector(":scope > line");
    const dot = g.querySelector(":scope > circle");
    const body = g.querySelector(":scope > rect");
    if (!lead || !dot || !body) continue;
    // Where the draw put it, kept on the group: each pass starts from there.
    if (!g.dataset.tgAt) {
      const m = /translate\(([-\d.e]+)[ ,]+([-\d.e]+)\)/.exec(g.getAttribute("transform") || "");
      if (!m) continue;
      g.dataset.tgAt = `${m[1]} ${m[2]} ${lead.getAttribute("x1")} ${lead.getAttribute("y1")} ${lead.getAttribute("x2")} ${lead.getAttribute("y2")}`;
    }
    const [cx, cy, lx1, ly1, lx2, ly2] = g.dataset.tgAt.split(" ").map(Number);
    const set = (x, y) => {
      g.setAttribute("transform", `translate(${x} ${y})`);
      const ax = cx + lx1 - x;
      const ay = cy + ly1 - y;
      const bx = Number(body.getAttribute("x"));
      const by = Number(body.getAttribute("y"));
      const near = tgNearestOn({ x: bx, y: by, x2: bx + Number(body.getAttribute("width")), y2: by + Number(body.getAttribute("height")) }, { x: ax, y: ay });
      const moved = x !== cx || y !== cy;
      lead.setAttribute("x1", String(ax));
      lead.setAttribute("y1", String(ay));
      lead.setAttribute("x2", String(moved ? near.x : lx2));
      lead.setAttribute("y2", String(moved ? near.y : ly2));
      dot.setAttribute("cx", String(ax));
      dot.setAttribute("cy", String(ay));
    };
    set(cx, cy);
    g.style.display = ""; // measured where it is drawn, then hidden again below if its reader is out of view
    if (!(view.width > 0 && view.height > 0)) continue;
    const d = dot.getBoundingClientRect();
    const dx0 = d.left + d.width / 2;
    const dy0 = d.top + d.height / 2;
    const off = dx0 < view.left || dx0 > view.left + view.width || dy0 < view.top || dy0 > view.top + view.height;
    g.classList.toggle("tg-off", off);
    // Gone at once, whatever its fade or flash is doing (an opacity rule lost to a running transition on the kiosk).
    g.style.display = off ? "none" : "";
    if (off) continue;
    const r = body.getBoundingClientRect();
    const { dx, dy } = shiftInto({ left: r.left, top: r.top, width: r.width, height: r.height }, view, 8);
    if (dx || dy) set(cx + dx / scale, cy + dy / scale);
  }
  // behold#748's outside mark, the same way: its box and tag slide in (its ring stays on the card, its leader's
  // card end too). It was 2px over the frame's top on /choudoufu-fanout at the end of the run.
  for (const g of svg.querySelectorAll("g[data-tg-outside]")) {
    const ring = g.firstElementChild;
    const lead = g.querySelector(":scope > line");
    const moving = [...g.children].filter((c) => c !== ring && c !== lead && c.localName !== "circle" && c.localName !== "title");
    if (!moving.length) continue;
    if (!g.dataset.tgAt) g.dataset.tgAt = lead ? `${lead.getAttribute("x2")} ${lead.getAttribute("y2")}` : "";
    for (const c of moving) c.removeAttribute("transform");
    if (lead && g.dataset.tgAt) {
      const [x2, y2] = g.dataset.tgAt.split(" ");
      lead.setAttribute("x2", x2);
      lead.setAttribute("y2", y2);
    }
    if (!(view.width > 0 && view.height > 0)) continue;
    const rs = moving.map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0);
    if (!rs.length) continue;
    const left = Math.min(...rs.map((r) => r.left));
    const top = Math.min(...rs.map((r) => r.top));
    const box = { left, top, width: Math.max(...rs.map((r) => r.right)) - left, height: Math.max(...rs.map((r) => r.bottom)) - top };
    const { dx, dy } = shiftInto(box, view, 8);
    if (!dx && !dy) continue;
    for (const c of moving) c.setAttribute("transform", `translate(${dx / scale} ${dy / scale})`);
    if (lead && g.dataset.tgAt) {
      const [x2, y2] = g.dataset.tgAt.split(" ").map(Number);
      lead.setAttribute("x2", String(x2 + dx / scale));
      lead.setAttribute("y2", String(y2 + dy / scale));
    }
  }
}
let tgReadWired = false;
function wireTgReadHover() {
  if (tgReadWired || typeof document === "undefined") return;
  tgReadWired = true;
  document.addEventListener("pointerover", (e) => tgReadSetHot(tgReadHotOf(e.target)));
  document.addEventListener("pointerout", (e) => !e.relatedTarget && tgReadSetHot([]));
  document.addEventListener("focusin", (e) => tgReadSetHot(tgReadHotOf(e.target)));
  document.addEventListener("focusout", (e) => !e.relatedTarget && tgReadSetHot([]));
}
/** The pills' looks, once per document: hidden until lit; a flash shows and fades; no fade under prefers-reduced-motion. */
function ensureTgReadStyle() {
  wireTgReadHover();
  if (document.getElementById("tg-read-style")) return;
  const st = document.createElement("style");
  st.id = "tg-read-style";
  st.textContent = `#graph g[data-tg-read-pill] { opacity: 0; }
#graph g[data-tg-read-pill].tg-hot, #graph g[data-tg-read-pill].tg-shown { opacity: 1 !important; }
#graph g[data-tg-read-pill].tg-off { opacity: 0 !important; animation: none; }
#graph g[data-tg-read-pill].tg-hot { transition: opacity .15s ease; }
#graph g[data-tg-read-pill].tg-flash { animation: tg-read-flash 6s linear both; }
#graph line[data-tg-read].tg-hot { stroke-width: 5; filter: drop-shadow(0 0 3px var(--bg)); }
#graph g[data-tg-read-covers] { display: none !important; }
/* Ask mode never paints the checkout's plain resource graph: the svg is held (kl-show) until the estate scene is drawn. */
html.kiosk-ask:not(.kl-show) #graph svg { visibility: hidden; }
html.kiosk-ask #view-toggles, html.kiosk-ask #graph text[data-tg-reads="caption"], html.kiosk-ask #graph text[data-tg-root="wave-fact"], html.kiosk-ask #graph text[data-tg-box-facts] { display: none; }
@keyframes tg-read-flash { 0% { opacity: 0; } 4%, 80% { opacity: 1; } 100% { opacity: 0; } }
@keyframes tg-read-flash-step { 0%, 99.9% { opacity: 1; } 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  #graph g[data-tg-read-pill].tg-hot { transition: none; }
  #graph g[data-tg-read-pill].tg-flash { animation-name: tg-read-flash-step; animation-timing-function: step-end; }
}`;
  document.head.appendChild(st);
}

/** #571: points along the components graph's own edges, in the svg's coordinates, every few units. */
function chantEdgePoints(svg) {
  const toSvg = svg.getScreenCTM && svg.getScreenCTM();
  if (!toSvg) return [];
  const inv = toSvg.inverse();
  const out = [];
  for (const path of svg.querySelectorAll("path.pin-edge-line")) {
    if (path.closest("[data-tg-read-covers]")) continue; // behold#762: hidden, a read line stands for it
    let len = 0;
    try {
      len = path.getTotalLength();
    } catch {
      continue;
    }
    const ctm = path.getScreenCTM && path.getScreenCTM();
    if (!ctm || !len) continue;
    const m = inv.multiply(ctm);
    for (let d = 0; d <= len; d += 5) {
      const p = path.getPointAtLength(d);
      out.push(new DOMPoint(p.x, p.y).matrixTransform(m));
    }
  }
  return out;
}

// #571: the pipeline's runs (terragucci#1038), for the components zoom's wave
// boxes: each box's job and its status on the run the view draws.
let tgRuns = null;
let tgRunsTimer = null;
async function loadTgRuns() {
  const was = JSON.stringify(tgRuns && tgRuns.doc ? tgRuns.doc.runs : null);
  tgRuns = await apiFetch("/api/terragucci/runs")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (JSON.stringify(tgRuns && tgRuns.doc ? tgRuns.doc.runs : null) !== was) drawTgReads();
}
/** Read the runs while the components zoom of a terragucci repo is on screen, every few seconds as the kiosk does. */
function watchTgRuns() {
  const on = !staticMode && !!tgAnswer && !tgAnswer.error && view.components && terragucciComponentsRepo;
  if (on && !tgRunsTimer) {
    void loadTgRuns();
    tgRunsTimer = setInterval(() => void loadTgRuns(), 3_000);
  } else if (!on && tgRunsTimer) {
    clearInterval(tgRunsTimer);
    tgRunsTimer = null;
  }
}

/**
 * #571: the live marks on a terragucci repo's components zoom, for the run
 * the view draws (`view.run`): each card in its wave's state, each wave box
 * outlined in its wave's state with its job's status after its title and its
 * first fact (a waiting wave's plan digest) in its bottom padding. Text goes
 * only where it covers no text, no card and no edge of the graph: the first
 * spot that is clear, in the words that fit, else only in the tooltip.
 * Returns the wave boxes, in the svg's coordinates.
 */
/** behold#631: a kiosk passer-by can't place a card's type glyph (it reads as a checkbox): hide it, once per card. */
function kioskCardGlyphs(svg) {
  for (const card of svg.querySelectorAll("[data-node-id]")) {
    const icon = card.querySelector(":scope > g[transform]");
    if (!icon || card.hasAttribute("data-kiosk-glyph")) continue;
    icon.setAttribute("visibility", "hidden");
    // The name and the state line take the glyph's room, so the bigger state words fit.
    card.setAttribute("data-kiosk-glyph", "1");
    for (const t of card.querySelectorAll(":scope > text")) t.setAttribute("x", String(Number(t.getAttribute("x")) - 30));
  }
}
/** The convex hull of points (monotone chain), counter-clockwise. */
function hullOf(points) {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
/** A closed path through a hull, each corner rounded by at most `r`, the `sharp` point (the apex) left a point. */
function smoothPath(h, sharp = null, r = 28) {
  if (h.length < 3) return "";
  const f = (n) => Math.round(n * 10) / 10;
  const toward = (p, q, d) => {
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    return { x: p.x + ((q.x - p.x) / len) * d, y: p.y + ((q.y - p.y) / len) * d };
  };
  let d = "";
  h.forEach((p, i) => {
    const prev = h[(i - 1 + h.length) % h.length];
    const next = h[(i + 1) % h.length];
    if (sharp && p.x === sharp.x && p.y === sharp.y) {
      d += `${i ? "L" : "M"}${f(p.x)},${f(p.y)} `;
      return;
    }
    const k = Math.min(r, Math.hypot(prev.x - p.x, prev.y - p.y) / 2, Math.hypot(next.x - p.x, next.y - p.y) / 2);
    const a = toward(p, prev, k);
    const b = toward(p, next, k);
    d += `${i ? "L" : "M"}${f(a.x)},${f(a.y)} Q${f(p.x)},${f(p.y)} ${f(b.x)},${f(b.y)} `;
  });
  return `${d}Z`;
}
const REACH_TONE = { plan: "var(--frame-pending, var(--pending))", bad: "var(--frame-degraded, var(--degraded))" };
/**
 * behold#631: what a change reaches, drawn on a chant repo's components graph:
 * a soft wedge per root, from the root card's top centre up over the cards
 * downstream of it, padded, behind the cards and in front of the wave boxes.
 * It grows from the root outward over about 1.2 s (none under reduced motion)
 * and then rests faint, with its words at its upper edge. A new reach
 * crossfades the old one out; the same one redrawn only follows the cards.
 */
function drawReach(svg, reach, boxOf, size = 18, needs = null) {
  // Its words inside it, beside its apex: just right of the root card, in the open space between the root's wave box and the one above.
  const labelAt = (shapes) => {
    const at = shapes[0];
    const waveBoxes = [...svg.querySelectorAll("rect[data-group-id]")].map((r) => boxOf(r)).filter(Boolean);
    const inBox = waveBoxes.find((b) => at.root.x >= b.x && at.root.x2 <= b.x2 && at.root.y >= b.y && at.root.y2 <= b.y2) || null;
    const above = inBox ? waveBoxes.filter((b) => b.y2 <= inBox.y + 1).sort((a, b) => b.y2 - a.y2)[0] : null;
    return { x: at.root.x2 + 14, y: inBox && above ? (inBox.y + above.y2) / 2 : at.root.y - 24 };
  };
  const NS = "http://www.w3.org/2000/svg";
  const old = svg.querySelector("g[data-reach]");
  const key = reach ? reach.key : null;
  const fadeOut = (g) => {
    if (!g) return;
    // Its words, drawn on top in their own group, go with it.
    const words = svg.querySelector(`g[data-reach-words="${CSS.escape(g.getAttribute("data-reach") || "")}"]`);
    if (words) {
      words.removeAttribute("data-reach-words");
      words.style.transition = "opacity 0.5s ease-out";
      words.style.opacity = "0";
      setTimeout(() => words.remove(), 600);
    }
    g.removeAttribute("data-reach");
    g.setAttribute("data-reach-old", "1");
    g.style.transition = "opacity 0.5s ease-out";
    g.style.opacity = "0";
    setTimeout(() => g.remove(), 600);
  };
  if (!reach) return fadeOut(old);
  const card = (id) => svg.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
  const box = (id) => {
    const g = card(id);
    return g ? boxOf(g) : null;
  };
  const pad = 16;
  const shapes = [];
  const covered = new Set(reach.covered);
  // behold#741: a terragucci repo's marks carry their own edges (the plan report's reads, the run view's).
  const needsOf = needs || (chantFacets && chantFacets.needs) || {};
  for (const root of reach.roots) {
    const rb = box(root);
    if (!rb) continue;
    // This root's own reach: the covered cards downstream of it.
    const mine = [...covered].filter((c) => c !== root && (reach.roots.length === 1 || reachesFrom(root, c, needsOf)));
    const boxes = mine.map(box).filter(Boolean);
    if (!boxes.length) continue;
    // The apex just below the root card's bottom centre; the root card itself inside, so the shape comes out of it.
    const apex = { x: (rb.x + rb.x2) / 2, y: rb.y2 + pad + 10 };
    const pts = [apex];
    for (const b of [rb, ...boxes]) pts.push({ x: b.x - pad, y: b.y - pad }, { x: b.x2 + pad, y: b.y - pad }, { x: b.x - pad, y: b.y2 + pad }, { x: b.x2 + pad, y: b.y2 + pad });
    const top = Math.min(...boxes.map((b) => b.y)) - pad;
    shapes.push({ d: smoothPath(hullOf(pts), apex), apex, root: rb, top, cx: (Math.min(...boxes.map((b) => b.x)) + Math.max(...boxes.map((b) => b.x2))) / 2, reachR: Math.max(...pts.map((p) => Math.hypot(p.x - apex.x, p.y - apex.y))) });
  }
  if (!shapes.length) return fadeOut(old);
  const tone = REACH_TONE[reach.tone] || REACH_TONE.plan;
  if (old && old.getAttribute("data-reach") === key) {
    // The same reach: follow the cards, no new growth, and never left part-grown (a frame drawn while hidden pauses its animation).
    old.querySelectorAll("path[data-reach-shape], path[data-reach-edge]").forEach((p) => {
      const i = Number(p.getAttribute("data-reach-i"));
      if (shapes[i]) p.setAttribute("d", shapes[i].d);
    });
    reachFinal(old, shapes, labelAt(shapes));
    return;
  }
  fadeOut(old);
  const g = document.createElementNS(NS, "g");
  g.setAttribute("data-reach", key);
  g.setAttribute("pointer-events", "none");
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const id = `reach-${Date.now().toString(36)}`;
  // The growth: each wedge revealed by a circle from its apex, widening out and up as if along the edges.
  const defs = document.createElementNS(NS, "defs");
  const clip = document.createElementNS(NS, "clipPath");
  clip.setAttribute("id", id);
  for (const sh of shapes) {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", String(sh.apex.x));
    c.setAttribute("cy", String(sh.apex.y));
    c.setAttribute("r", reduce ? String(sh.reachR) : "0");
    if (!reduce) {
      const a = document.createElementNS(NS, "animate");
      for (const [k, v] of Object.entries({ attributeName: "r", from: "0", to: String(sh.reachR), dur: "1.2s", fill: "freeze", calcMode: "spline", keyTimes: "0;1", keySplines: "0.16 1 0.3 1" })) a.setAttribute(k, v);
      c.appendChild(a);
    }
    clip.appendChild(c);
  }
  defs.appendChild(clip);
  g.appendChild(defs);
  // One fill for all the wedges, so where two roots' wedges meet they merge rather than darken.
  const fill = document.createElementNS(NS, "g");
  fill.setAttribute("clip-path", `url(#${id})`);
  fill.setAttribute("opacity", "0.13");
  const edge = document.createElementNS(NS, "g");
  edge.setAttribute("clip-path", `url(#${id})`);
  for (const sh of shapes) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", sh.d);
    p.setAttribute("fill", tone);
    p.setAttribute("data-reach-shape", "1");
    p.setAttribute("data-reach-i", String(shapes.indexOf(sh)));
    fill.appendChild(p);
    const e = document.createElementNS(NS, "path");
    e.setAttribute("d", sh.d);
    e.setAttribute("fill", "none");
    e.setAttribute("stroke", tone);
    e.setAttribute("stroke-opacity", "0.55");
    e.setAttribute("stroke-width", "1.5");
    e.setAttribute("data-reach-edge", "1");
    e.setAttribute("data-reach-i", String(shapes.indexOf(sh)));
    edge.appendChild(e);
  }
  g.append(fill, edge);
  const where = labelAt(shapes);
  const label = document.createElementNS(NS, "text");
  for (const [k, v] of Object.entries({ x: String(where.x), y: String(where.y), "text-anchor": "start", "dominant-baseline": "central", "font-size": String(size), "font-weight": "700", fill: tone, stroke: "var(--bg)", "stroke-width": "5", "paint-order": "stroke", "stroke-linejoin": "round", "data-reach-label": "1" })) label.setAttribute(k, v);
  label.textContent = reach.label;
  if (!reduce) {
    label.style.opacity = "0";
    label.style.transition = "opacity 0.4s ease-out 1s";
    requestAnimationFrame(() => (label.style.opacity = "1"));
  }
  // The shape lies under everything, a shadow on the stage floor: before the wave boxes, the edges and the cards.
  // Its words sit on top, in their own group, so they stay readable.
  const words = document.createElementNS(NS, "g");
  words.setAttribute("data-reach-words", key);
  words.setAttribute("pointer-events", "none");
  words.appendChild(label);
  // Above the stage's own backdrop (pinhole's gradient and dot pattern), under all else.
  const backdrop = (n) => n.tagName.toLowerCase() === "rect" && !n.hasAttribute("data-group-id") && /^url\(#pin-/.test(n.getAttribute("fill") || "");
  const floor = [...svg.children].find((n) => !["defs", "style", "title"].includes(n.tagName.toLowerCase()) && !backdrop(n) && !n.hasAttribute("data-reach-old"));
  if (floor) svg.insertBefore(g, floor);
  else svg.appendChild(g);
  svg.appendChild(words);
  // Whatever the animation did (a hidden frame pauses it), the reach ends whole, its words up.
  setTimeout(() => g.isConnected && reachFinal(g, shapes, labelAt(shapes)), reduce ? 0 : 1_400);
}
/**
 * behold#631: a chant kiosk reads its waves bottom to top. Each wave box's
 * title says "wave N" at the header's size in a readable tone, each edge
 * carries an arrowhead at its dependent's end (so up reads as "then"), and
 * the bottom box says once that the waves apply from the bottom up.
 */
function chantKioskWaves(svg, boxOf, size) {
  const NS = "http://www.w3.org/2000/svg";
  let relabelled = false;
  for (const rect of svg.querySelectorAll("rect[data-group-id]")) {
    const n = tgWaveOfKey(rect.getAttribute("data-group-id"));
    if (n === null) continue;
    let title = null;
    for (let el = rect.nextElementSibling; el; el = el.nextElementSibling) {
      if (el.tagName.toLowerCase() === "text") {
        title = el;
        break;
      }
      if (el.tagName.toLowerCase() === "rect") break;
    }
    // The reach lies under the boxes: on a chant kiosk their fill lets it show through faintly; the border stays.
    if (!rect.hasAttribute("data-kiosk-fill")) {
      rect.setAttribute("data-kiosk-fill", rect.getAttribute("fill-opacity") || "");
      rect.setAttribute("fill-opacity", "0.3");
    }
    if (!title || title.hasAttribute("data-kiosk-wave")) continue;
    title.setAttribute("data-kiosk-wave", "1");
    title.textContent = `wave ${n}`;
    title.setAttribute("font-size", String(size));
    title.dataset.pinFont = String(size);
    title.setAttribute("fill", "var(--fg)");
    relabelled = true;
  }
  // scaleBoxLabels indexed the titles at pinhole's size: index them again at this one.
  if (relabelled) {
    boxLabelCache = { svg: null, labels: [] };
    boxLabelScale = null;
  }
  // Arrowheads: one marker, at the end of each edge that meets its dependent (the edge's `from`, consumer -> producer).
  if (!svg.querySelector("#k-then-arrow")) {
    const defs = svg.querySelector("defs") || svg.insertBefore(document.createElementNS(NS, "defs"), svg.firstChild);
    const m = document.createElementNS(NS, "marker");
    for (const [k, v] of Object.entries({ id: "k-then-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" })) m.setAttribute(k, v);
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", "M0,0 L10,5 L0,10 z");
    p.setAttribute("fill", "var(--muted)");
    m.appendChild(p);
    defs.appendChild(m);
  }
  for (const g of svg.querySelectorAll("g[data-edge-from]")) {
    const path = g.querySelector("path.pin-edge-line") || g.querySelector("path");
    if (!path || path.hasAttribute("data-kiosk-then")) continue;
    path.setAttribute("data-kiosk-then", "1");
    const from = svg.querySelector(`[data-node-id="${CSS.escape(g.getAttribute("data-edge-from"))}"]`);
    const fb = from ? boxOf(from) : null;
    let start = null;
    let end = null;
    try {
      const len = path.getTotalLength();
      start = path.getPointAtLength(0);
      end = path.getPointAtLength(len);
    } catch {
      continue;
    }
    if (!fb || !start || !end) continue;
    const near = (p) => Math.hypot(p.x - (fb.x + fb.x2) / 2, p.y - (fb.y + fb.y2) / 2);
    // The arrow points into the dependent: at whichever end of the path meets it.
    if (near(start) < near(end)) path.setAttribute("marker-start", "url(#k-then-arrow)");
    else path.setAttribute("marker-end", "url(#k-then-arrow)");
  }
  // The bottom box says which way the waves go, once.
  if (!svg.querySelector("text[data-kiosk-upward]") && !composedRun(tgAnswer, tgProgress)) {
    const boxes = [...svg.querySelectorAll("rect[data-group-id]")].filter((r) => tgWaveOfKey(r.getAttribute("data-group-id")) !== null);
    const low = boxes.map((r) => ({ r, b: boxOf(r) })).filter((x) => x.b).sort((a, b) => b.b.y2 - a.b.y2)[0];
    if (low) {
      const t = document.createElementNS(NS, "text");
      for (const [k, v] of Object.entries({ x: String(low.b.x + 18), y: String(low.b.y2 - 12), "font-size": "13", "font-weight": "600", fill: "var(--muted)", "data-kiosk-upward": "1" })) t.setAttribute(k, v);
      t.textContent = "the waves apply from the bottom up";
      svg.appendChild(t);
    }
  }
}
/** A reach at its end state: each clip circle at full radius on its apex, no animation left, its words shown where they go. */
function reachFinal(g, shapes, where) {
  const svgEl = g.ownerSVGElement || g.parentNode;
  g.querySelectorAll("clipPath circle").forEach((c, i) => {
    for (const a of c.querySelectorAll("animate")) a.remove();
    const sh = shapes[i];
    if (!sh) return;
    c.setAttribute("cx", String(sh.apex.x));
    c.setAttribute("cy", String(sh.apex.y));
    c.setAttribute("r", String(sh.reachR));
  });
  const key = g.getAttribute("data-reach") || "";
  const words = svgEl && svgEl.querySelector ? svgEl.querySelector(`g[data-reach-words="${CSS.escape(key)}"]`) : null;
  const label = (words && words.querySelector("text[data-reach-label]")) || g.querySelector("text[data-reach-label]");
  if (label) {
    label.setAttribute("x", String(where.x));
    label.setAttribute("y", String(where.y));
    label.style.transition = "";
    label.style.opacity = "1";
  }
}
/** Whether `c` is downstream of `root` along `needs`. */
function reachesFrom(root, c, needs) {
  const seen = new Set();
  const up = (n) => {
    for (const d of needs[n] || []) {
      if (d === root) return true;
      if (seen.has(d)) continue;
      seen.add(d);
      if (up(d)) return true;
    }
    return false;
  };
  return up(c);
}
/** behold#631: the "working" outline pulse, once per document; no motion under prefers-reduced-motion. */
function ensureWorkingStyle() {
  if (document.getElementById("k-working-style")) return;
  const st = document.createElement("style");
  st.id = "k-working-style";
  st.textContent = `@media (prefers-reduced-motion: no-preference) {
  rect.k-working { animation: k-working 1.6s ease-in-out infinite; stroke: var(--frame-runtime, var(--runtime)); }
  @keyframes k-working { 0%, 100% { stroke-opacity: 0.35; stroke-width: 1.5; } 50% { stroke-opacity: 1; stroke-width: 3; } }
}`;
  document.head.appendChild(st);
}
function drawTgComponentMarks(svg, { drawnAnswer, focus, boxOf, make, edgePoints, marks: given = null }) {
  const marks = given || tgComponentMarks(drawnAnswer, tgProgress, tgComponentFacets, { runs: tgRuns, pin: view.run || null });
  kioskTellMarks(marks);
  // behold#631: where the marks came from, said in each tooltip.
  const cardSource = marks.source || "(from terragucci's reports, not live)";
  const boxSource = marks.source || "(the job's status from the pipeline's runs; the wave's from terragucci's reports)";
  const group = make("g", { "data-tg-root": "components", "pointer-events": "none" });
  svg.appendChild(group);
  const grow = (b, d) => ({ x: b.x - d, y: b.y - d, x2: b.x2 + d, y2: b.y2 + d });
  const hits = (a, b) => a.x < b.x2 && a.x2 > b.x && a.y < b.y2 && a.y2 > b.y;
  const textBoxes = () =>
    [...svg.querySelectorAll("text")]
      .filter((t) => t.getAttribute("visibility") !== "hidden" && (t.textContent || "").trim() && !t.closest("[data-tg-reads]") && !t.closest(".pipeline-marks"))
      .map(boxOf)
      .filter(Boolean);
  const cardEls = [...svg.querySelectorAll("[data-node-id]")];
  // behold#631: last draw's "working" pulse goes; this draw's marks say which cards still have it.
  for (const r of svg.querySelectorAll("rect.k-working")) r.setAttribute("class", (r.getAttribute("class") || "").replace(/\bk-working\b/g, "").trim());
  const cardBoxes = cardEls.map(boxOf).filter(Boolean);
  const edgeHit = (r) => edgePoints.some((p) => p.x >= r.x - 4 && p.x <= r.x2 + 4 && p.y >= r.y - 4 && p.y <= r.y2 + 4);
  const probe = make("text", { "font-size": 12, "font-weight": 700 });
  group.appendChild(probe);
  const width = (t, size, weight) => {
    probe.setAttribute("font-size", String(size));
    probe.setAttribute("font-weight", String(weight));
    probe.textContent = t;
    try {
      return probe.getComputedTextLength() || t.length * size * 0.58;
    } catch {
      return t.length * size * 0.58;
    }
  };
  const tone = (t) => TG_TONE[t] || TG_TONE.idle;

  // The cards: outlined and barred in their state's colour, the state in the
  // line under the name (the "Component · chant" line gives way to it).
  for (const g of cardEls) {
    const id = g.getAttribute("data-node-id");
    const m = marks.cards[id];
    if (!m) continue;
    const rects = [...g.querySelectorAll(":scope > rect")];
    const body = rects.reduce((a, r) => (!a || Number(r.getAttribute("width")) * Number(r.getAttribute("height")) > Number(a.getAttribute("width")) * Number(a.getAttribute("height")) ? r : a), null);
    const bar = rects.find((r) => r !== body && Number(r.getAttribute("width")) <= 6);
    const quiet = m.state === "outside" || m.state === "unchanged" || m.state === "not-started" || m.state === "reading";
    const inFocus = !focus || focus.has(m.root) || focus.has(id);
    if (body) {
      body.setAttribute("data-tg-stroke0", body.getAttribute("stroke") || "");
      body.setAttribute("data-tg-width0", body.getAttribute("stroke-width") || "1.2");
      if (!quiet) {
        body.setAttribute("stroke", tone(m.tone));
        body.setAttribute("stroke-width", focus && inFocus ? "4" : "2.5");
      }
    }
    if (bar && !quiet) {
      bar.setAttribute("data-tg-fill0", bar.getAttribute("fill") || "");
      bar.setAttribute("fill", tone(m.tone));
    }
    // behold#631: a card the pipeline is about to work on, between events, pulses its outline (none under reduced motion).
    if (body) {
      if (m.working) body.setAttribute("class", `${body.getAttribute("class") || ""} k-working`.trim());
      else if ((body.getAttribute("class") || "").includes("k-working")) body.setAttribute("class", (body.getAttribute("class") || "").replace(/\bk-working\b/g, "").trim());
      if (m.working) ensureWorkingStyle();
    }
    if (!m.words && m.working) continue;
    const texts = [...g.querySelectorAll(":scope > text")];
    const sub = texts.find((t) => /^Component\b/.test((t.textContent || "").trim())) || texts[1];
    if (!sub || !body) continue;
    const x = Number(sub.getAttribute("x"));
    const y = Number(sub.getAttribute("y"));
    const room = Number(body.getAttribute("x")) + Number(body.getAttribute("width")) - 10 - x;
    // behold#631: a middle form (a failure's first words, a blocker's name) before the one-word short.
    // behold#631: a chant kiosk says a card's state at the size of its name, readable from a few feet.
    const cardFont = marks.cardFont || 12;
    // A cone root's words that don't fit: the state on this line, the cone's size wrapped under it (never cut).
    const coneCard = m.cone === "cone" || m.cone === "full";
    // behold#736: a fallback's line breaks after "planned in full", its kind under it ("empty cone").
    const coneCut = coneCard ? m.words.indexOf(m.cone === "full" ? ": " : " · ") : -1;
    const words = width(m.words, cardFont, 700) <= room ? m.words : coneCut > 0 ? m.words.slice(0, coneCut) : m.mid && width(m.mid, cardFont, 700) <= room ? m.mid : m.short;
    sub.setAttribute("visibility", "hidden");
    sub.setAttribute("data-tg-hid", "1");
    const t = make("text", { "data-tg-root": "card", x, y: marks.cardFont ? y + 4 : y, "font-size": cardFont, "font-weight": 700, fill: quiet ? "var(--frame-card-muted, var(--muted))" : TG_CARD_TONE[m.tone] || TG_CARD_TONE.idle }, words);
    if (m.state === "applying") t.setAttribute("class", "pin-pulse");
    if (!inFocus) t.style.opacity = "0.6";
    // The tooltip (with where the marks come from) beside the words, in a group of their own, so the card's text is its words alone.
    const tip = make("g", { "data-tg-root": "card-tip" });
    tip.append(make("title", {}, [`wave ${m.wave} · ${m.words}`, ...m.facts].join("\n") + "\n" + cardSource), t);
    g.appendChild(tip);
    // Report minor 34: under the state, what didn't fit of its words (the cone's size), then the cone's resources, a
    // line each, each wrapped to the card's width (web/cone.js wrapWords) so it reads in full. The card's body grows
    // to hold them when the gap under it has room; no box round them.
    const rest = words !== m.words && coneCut > 0 ? [m.words.slice(words.length).replace(/^(?: · |: )/, "")] : [];
    // behold#736: a story's cards say their state at its bigger size (cardFont); the lines under it follow, a size smaller.
    const lineFont = marks.cardFont ? cardFont - 2 : 11.5;
    const y0 = marks.cardFont ? y + 4 : y;
    const said = [...rest, ...(m.lines || [])].flatMap((line) => wrapWords(line, room, (txt) => width(txt, lineFont, 600)));
    if (said.length) {
      const LH = lineFont + 3.5;
      const top = Number(body.getAttribute("y"));
      const h0 = Number(body.getAttribute("height"));
      const need = y0 + LH * said.length + 8 - top;
      if (need > h0) {
        // Grow into the gap under the card, never onto another card; its box grows with it when nothing lies under the box.
        const b = boxOf(body);
        const gap = b ? roomUnder(b, svg, boxOf, g, need - h0) : 0;
        const grow = Math.max(0, Math.min(need - h0, gap));
        if (grow > 0) {
          body.setAttribute("data-tg-h0", String(h0));
          body.setAttribute("height", String(h0 + grow));
        }
      }
      const floor = top + Number(body.getAttribute("height")) - 6;
      said.forEach((line, k) => {
        const ly = y0 + LH * (k + 1);
        if (ly > floor) return;
        const last = k === said.length - 1 || y0 + LH * (k + 2) <= floor ? line : `${line} …`;
        g.appendChild(make("text", { "data-tg-root": "cone-line", x, y: ly, "font-size": lineFont, "font-weight": 600, fill: "var(--frame-card-muted, var(--muted))" }, last));
      });
    }
  }

  // The wave boxes.
  const out = [];
  const placed = [];
  for (const rect of svg.querySelectorAll("rect[data-group-id]")) {
    const n = tgWaveOfKey(rect.getAttribute("data-group-id"));
    const w = n === null ? null : marks.waves[n];
    const b = boxOf(rect);
    if (!b) continue;
    out.push(b);
    if (!w) continue;
    const quiet = !w.state || w.state === "not-started";
    rect.setAttribute("data-tg-stroke0", rect.getAttribute("stroke") || "");
    rect.setAttribute("data-tg-width0", rect.getAttribute("stroke-width") || "1.2");
    if (!quiet) {
      rect.setAttribute("stroke", tone(w.tone));
      rect.setAttribute("stroke-width", "2.5");
    }
    const title = [...svg.querySelectorAll("text[data-layout-move]")].find((t) => t.getAttribute("data-layout-move") === `box:${rect.getAttribute("data-group-id")}`);
    const tb = title ? boxOf(title) : null;
    const others = () => [...textBoxes(), ...placed].filter((x) => !(tb && sameBox(x, tb)));
    const clear = (r) => r.x >= b.x + 6 && r.x2 <= b.x2 - 6 && !edgeHit(r) && !others().some((x) => hits(grow(x, 2), r)) && !cardBoxes.some((c) => hits(grow(c, 4), r));
    // behold#571: the wave's forge and tool marks (drawPipelineMarks) left the job's status its room after the title.
    const row = svg.querySelector(`.pipeline-marks[data-pm-wave="${n}"]`);
    const rb = row && row.style.display !== "none" ? boxOf(row) : null;
    if (rb) placed.push(rb);
    // The job's status: after the title on its line, else at the right of that line.
    if (w.status && tb) {
      // behold#631: a chant kiosk's wave words half again as big.
      const size = marks.waveFont || 12;
      const cy = (tb.y + tb.y2) / 2;
      // Right after the title, as "apply-wave-2 · held at the gate"; else alone at the right of the title's line.
      const spots = [{ words: `· ${w.status.words}`, at: () => tb.x2 + 6 }, { words: w.status.words, at: (wd) => b.x2 - 16 - wd }];
      // behold#631: a chant kiosk's box titles grow with the fit (scaleBoxLabels), which would run into words set just after them: the right of the line first.
      if (marks.statusRight) spots.reverse();
      // behold#693: a narrow box whose full words would cross an edge says the short form.
      const short = tgStatusShort(w.status);
      if (short && short !== w.status.words) spots.push({ words: `· ${short}`, at: () => tb.x2 + 6 }, { words: short, at: (wd) => b.x2 - 16 - wd });
      for (const { words, at } of spots) {
        const wd = width(words, size, 700);
        const x = at(wd);
        const r = { x, y: cy - size / 2 - 2, x2: x + wd, y2: cy + size / 2 + 2 };
        if (x < tb.x2 + 4 || !clear(r)) continue;
        const t = make("text", { "data-tg-root": "wave-status", x, y: cy, "dominant-baseline": "central", "font-size": size, "font-weight": 700, fill: tone(w.status.tone) }, words);
        if (w.status.status === "running") t.setAttribute("class", "pin-pulse");
        group.appendChild(t);
        placed.push(r);
        break;
      }
    }
    if (title) {
      const tip = make("title", { "data-tg-root": "tip" }, [w.title, ...(w.state ? [`wave ${n} ${tgStateWords[w.state] || w.state}`] : []), ...w.facts].join("\n") + "\n" + boxSource);
      title.appendChild(tip);
    }
    // The wave's first fact (a waiting wave's plan digest) in the box's bottom padding, where it fits.
    const fact = w.facts[0];
    if (fact) {
      const size = 12.5;
      const digest = /^approve plan (\S+)/.exec(fact);
      // behold#631: a fact may carry shorter forms of itself (a failure's reason, cut), tried in turn.
      const say = digest ? [fact, `plan ${digest[1]}`, `plan ${digest[1].slice(0, 8)}`, digest[1].slice(0, 8)] : [fact, ...(Array.isArray(w.factShort) ? w.factShort : [])];
      const fill = w.state === "waiting" ? tone(w.tone) : "var(--muted)";
      let done = false;
      for (const words of say) {
        const wd = width(words, size, 600);
        for (const x of [b.x2 - 14 - wd, b.x + 18]) {
          const cy = b.y2 - 14;
          const r = { x, y: cy - size / 2 - 2, x2: x + wd, y2: cy + size / 2 + 2 };
          if (!clear(r)) continue;
          group.appendChild(make("text", { "data-tg-root": "wave-fact", x, y: cy, "dominant-baseline": "central", "font-size": size, "font-weight": 600, fill }, words));
          placed.push(r);
          done = true;
          break;
        }
        if (done) break;
      }
    }
  }
  probe.remove();
  return out;
}
function markTerragucciCards() {
  recolorNodesByCategory(); // #569 review: the reports arrived, so the cards may go neutral
  const svg = document.querySelector("#graph svg");
  tgStampProgress(svg, tgProgress, new Date()); // #511
  if (!svg || !tgAnswer || !tgAnswer.cards) return;
  const now = new Date();
  // #505: a pushed read replaces the marks, so the old ones go first.
  for (const old of svg.querySelectorAll("[data-tg-mark]")) old.remove();
  for (const g of svg.querySelectorAll(".tg-marked")) g.classList.remove("tg-marked", "tg-drift", "tg-wave", "tg-plan");
  for (const [id, marks] of Object.entries(tgAnswer.cards)) {
    const g = svg.querySelector('[data-node-id="' + CSS.escape(id) + '"]');
    if (!g) continue;
    const corner = cornerOf(marks);
    g.classList.add("tg-marked", `tg-${corner.tone}`);
    const rect = g.querySelector("rect");
    const box = rect && rect.getBBox ? rect.getBBox() : null;
    const tag = document.createElementNS("http://www.w3.org/2000/svg", "text");
    tag.setAttribute("data-tg-mark", "1");
    tag.setAttribute("x", String((box ? box.x + box.width : 150) - 10));
    tag.setAttribute("y", String((box ? box.y + box.height : 60) - 9));
    tag.setAttribute("text-anchor", "end");
    tag.setAttribute("font-size", "11");
    tag.setAttribute("font-weight", "600");
    tag.setAttribute("fill", corner.tone === "drift" ? "var(--frame-card-degraded, var(--degraded))" : corner.tone === "wave" ? "var(--frame-card-pending, var(--pending))" : "var(--frame-card-muted, var(--muted))");
    tag.textContent = `${corner.text} · ${markAge(marks)}`;
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.setAttribute("data-tg-mark", "title");
    title.textContent = marks.map((m) => markLine(m, now)).join("\n") + "\n(from terragucci reports, not live: the Terragucci tab links each run)";
    g.append(title, tag);
  }
  drawTgReads(); // #568
}
// --- behold#571: the kiosk frame's popover, root colours and hover links -------
// The kiosk frames this page bare, with no Inspect pane. Pointing at a card
// shows a popover beside it (web/kiosk-popover.js says what it holds); a
// click keeps it open. Each root's name carries a dot in its own colour, and
// hovering a card or box here lights its root and wave in the kiosk's other
// panes, and theirs light it here (`behold:hover`, web/kiosk-roots.js).
// Nothing happens until someone points: a TV with no pointer sees the page
// as before.
let kioskRoots = null; // /api/project's terragucciRoots: { roots, waves }
let kioskPop = popState();
let kioskHover = null; // this frame's pointer: { root } | { wave } | null
let kioskHostHover = null; // the kiosk's pointer, from its message
function kioskRootList() {
  if (kioskRoots && Array.isArray(kioskRoots.roots) && kioskRoots.roots.length) return kioskRoots.roots;
  return tgAnswer && Array.isArray(tgAnswer.roots) ? tgAnswer.roots.map((r) => r.path) : [];
}
function kioskWaves() {
  return (kioskRoots && kioskRoots.waves) || [];
}
function kioskLight() {
  return isLightBg(getComputedStyle(document.documentElement).getPropertyValue("--bg"));
}
function kioskCompMode() {
  return !!(view.components && terragucciComponentsRepo && tgComponentFacets);
}
function kioskRootOfComponent(c) {
  const m = (tgComponentFacets && tgComponentFacets.roots) || {};
  return m[c] || c;
}
/** The terragucci root (its path) of a resources-zoom box name. */
function kioskRootOfBox(name) {
  const r = tgAnswer && Array.isArray(tgAnswer.roots) ? tgAnswer.roots.find((x) => x.name === name) : null;
  return r ? r.path : name;
}
/** What the pointer is on: a card's or a box's root, or a wave's box. */
function kioskHoverOf(target) {
  if (!target || !target.closest) return null;
  const card = target.closest("[data-node-id]");
  if (card) {
    const id = card.getAttribute("data-node-id");
    if (kioskCompMode()) return { root: kioskRootOfComponent(id) };
    const at = popCardRoot(tgAnswer, id);
    return at ? { root: at.path } : null;
  }
  const rect = target.closest("rect[data-group-id]");
  if (!rect) return null;
  const g = rect.getAttribute("data-group-id") || "";
  const w = /^wave-(\d+)$/.exec(g);
  if (w) return { wave: Number(w[1]) };
  const root = kioskRootOfBox(g);
  return kioskRootList().includes(root) ? { root } : null;
}
const sameHover = (a, b) => (a && a.root) === (b && b.root) && (a && a.wave) === (b && b.wave);
function kioskSetHover(h) {
  if (sameHover(h, kioskHover)) return;
  kioskHover = h;
  kioskGlow();
  if (!embedOpts.host || window.parent === window) return;
  try {
    window.parent.postMessage(hoverMessage(h), embedOpts.host);
  } catch {
    /* the parent went away */
  }
}
/** Light what the two pointers link: a root's box (or card) and a wave's box, with one style element that survives a redraw. */
function kioskGlow() {
  let style = document.getElementById("k-hover-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "k-hover-style";
    document.head.appendChild(style);
  }
  const a = hoverLinks(kioskHover, kioskWaves());
  const b = hoverLinks(kioskHostHover, kioskWaves());
  const links = { roots: [...new Set([...a.roots, ...b.roots])], waves: [...new Set([...a.waves, ...b.waves])] };
  const boxes = (root) => {
    const names = new Set([root]);
    const r = tgAnswer && Array.isArray(tgAnswer.roots) ? tgAnswer.roots.find((x) => x.path === root || x.name === root) : null;
    if (r) names.add(r.name);
    const comps = tgComponentFacets && tgComponentFacets.roots ? Object.keys(tgComponentFacets.roots).filter((c) => tgComponentFacets.roots[c] === root) : [];
    for (const c of comps) names.add(c);
    return [...names].map((n) => `#graph rect[data-group-id=${cssString(n)}], #graph g[data-node-id=${cssString(n)}]`).join(", ");
  };
  style.textContent = hoverCss(links, { root: boxes, wave: (w) => `#graph rect[data-group-id="wave-${w}"]` }, "filter: drop-shadow(0 0 2px var(--focus)) drop-shadow(0 0 7px var(--focus));");
}
/** The dots by each root's name: on its box's title (Resources) or its card (Components). */
function kioskDots(svg) {
  for (const d of svg.querySelectorAll("[data-k-dot]")) d.remove();
  const roots = kioskRootList();
  if (!roots.length) return;
  const light = kioskLight();
  const dotBy = (text, root) => {
    const colour = rootPaint(root, roots, { light });
    if (!colour) return;
    let bb;
    try {
      bb = text.getBBox();
    } catch {
      return;
    }
    if (!bb.width) return;
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("data-k-dot", "1");
    // After the name: before it sits the card's icon.
    c.setAttribute("cx", String(bb.x + bb.width + 9));
    c.setAttribute("cy", String(bb.y + bb.height / 2));
    c.setAttribute("r", "5.5");
    // The theme's own root colour (--root-<i>): a style, since a fill attribute takes no var().
    c.style.fill = colour;
    c.setAttribute("pointer-events", "none");
    text.parentNode.insertBefore(c, text.nextSibling);
  };
  if (kioskCompMode()) {
    for (const card of svg.querySelectorAll("[data-node-id]")) {
      const id = card.getAttribute("data-node-id");
      const t = [...card.querySelectorAll("text")].find((x) => (x.textContent || "").trim() === id);
      if (t) dotBy(t, kioskRootOfComponent(id));
    }
    return;
  }
  for (const rect of svg.querySelectorAll("rect[data-group-id]")) {
    const name = rect.getAttribute("data-group-id");
    const root = kioskRootOfBox(name);
    if (!roots.includes(root)) continue;
    const t = [...(rect.parentNode ? rect.parentNode.querySelectorAll(":scope > text") : [])].find((x) => (x.textContent || "").trim() === name && x.getAttribute("visibility") !== "hidden");
    if (t) dotBy(t, root);
  }
}
function kioskDecorate() {
  const svg = document.querySelector("#graph svg");
  if (!svg) return;
  kioskDots(svg);
  kioskGlow();
  kioskPopRender();
}
function kioskPopEvent(ev) {
  const next = popReduce(kioskPop, ev, Date.now());
  if (next === kioskPop) return;
  kioskPop = next;
  kioskPopRender();
}
function kioskPopRender() {
  let pop = document.getElementById("k-pop");
  const svg = document.querySelector("#graph svg");
  const id = kioskPop.shown;
  const card = id && svg ? svg.querySelector(`[data-node-id="${CSS.escape(id)}"]`) : null;
  const answer = tgAnswerDrawn();
  const content = !card || !answer ? null : kioskCompMode() ? rootPopover(answer, kioskRootOfComponent(id), resourcesByComponent[id]) : resourcePopover(answer, id);
  if (!content) {
    if (pop) pop.hidden = true;
    kioskTellPop(pop);
    return;
  }
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "k-pop";
    pop.setAttribute("role", "tooltip");
    document.body.appendChild(pop);
  }
  pop.replaceChildren();
  pop.classList.toggle("k-pinned", kioskPop.pinned);
  const roots = kioskRootList();
  const light = kioskLight();
  const add = (tag, cls, text) => {
    const n = document.createElement(tag);
    n.className = cls;
    if (text !== undefined) n.textContent = text;
    pop.appendChild(n);
    return n;
  };
  const list = (rows) => {
    const ul = add("ul", "k-pop-lines");
    for (const r of rows) {
      const li = document.createElement("li");
      li.className = r.tone === "unknown" ? "k-pop-unknown" : "";
      li.textContent = r.text;
      ul.appendChild(li);
    }
    return ul;
  };
  if (content.address !== undefined) {
    add("div", "k-pop-addr", content.address);
    add("div", "k-pop-root").appendChild(rootText(document, `It sits in root ${content.root}.`, roots, { light }));
    add("p", "k-pop-head", content.head);
    if (content.lines.length) {
      const ul = list(content.lines);
      if (content.more) ul.appendChild(Object.assign(document.createElement("li"), { className: "k-pop-more", textContent: `and ${content.more} more` }));
    }
    if (content.applied) {
      add("p", "k-pop-note", content.applied.when);
      list(content.applied.lines);
    } else if (content.note) add("p", "k-pop-note", content.note);
  } else {
    add("div", "k-pop-addr").appendChild(rootText(document, content.root, roots, { light }));
    add("p", "k-pop-head", content.head);
    const ul = add("ul", "k-pop-lines");
    for (const r of content.rows) {
      const li = document.createElement("li");
      li.className = "k-pop-res";
      const st = document.createElement("span");
      st.className = `k-pop-state k-pop-${r.state}`;
      st.textContent = r.words;
      li.append(document.createTextNode(`${r.address} `), st);
      ul.appendChild(li);
    }
    if (content.more > 0) ul.appendChild(Object.assign(document.createElement("li"), { className: "k-pop-more", textContent: `and ${content.more} more` }));
  }
  // behold#571: a finger opens the popover with a tap, so a touch screen reads the tap's words.
  const touchOnly = typeof matchMedia === "function" && matchMedia("(hover: none)").matches;
  add("p", "k-pop-hint", kioskPop.pinned ? (touchOnly ? POP_WORDS.tapPinnedHint : POP_WORDS.pinnedHint) : POP_WORDS.pinHint);
  pop.hidden = false;
  // behold#764: measured at its own height, then capped (its body scrolls) when the frame's view is shorter.
  pop.style.maxHeight = "";
  const cb = card.getBoundingClientRect();
  const pb = pop.getBoundingClientRect();
  // The part of the frame that shows: Watch's caption and track cover its bottom (the shot's insets), unless that leaves too little.
  const coveredBelow = kioskShot && kioskShot.insets ? Math.max(0, kioskShot.insets.bottom || 0) : 0;
  const height = window.innerHeight - coveredBelow >= 240 ? window.innerHeight - coveredBelow : window.innerHeight;
  const at = placePopover({ left: cb.left, top: cb.top, width: cb.width, height: cb.height }, { width: pb.width, height: pb.height }, { width: window.innerWidth, height });
  pop.style.maxHeight = at.maxHeight ? `${Math.floor(at.maxHeight)}px` : "";
  pop.style.left = `${Math.round(at.left)}px`;
  pop.style.top = `${Math.round(at.top)}px`;
  kioskTellPop(pop);
}
/** behold#764: tell the kiosk where the card's details popover is (or that none is open), so its modals never cover it. */
function kioskTellPop(pop) {
  if (!embedOpts.bare || !embedOpts.host || window.parent === window) return;
  const r = pop && !pop.hidden ? pop.getBoundingClientRect() : null;
  const at = r && r.width ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
  const key = JSON.stringify(at);
  if (key === kioskPopTold) return;
  kioskPopTold = key;
  try {
    window.parent.postMessage({ type: "behold:pop", at }, embedOpts.host);
  } catch {
    /* the parent went away */
  }
}
var kioskPopTold = "null"; // var: kioskPopRender may run before this line is reached
/**
 * behold#776: tell the kiosk the cards' and waves' marks as words (web/kiosk-wave-list.js), with each card's
 * popover content, so a phone too narrow to read the graph lists them. Posted when they change.
 */
function kioskTellMarks(marks) {
  if (!embedOpts.bare || !embedOpts.host || window.parent === window) return;
  const answer = tgAnswerDrawn();
  const details = {};
  if (answer && !answer.error) for (const [id, c] of Object.entries((marks && marks.cards) || {})) if (c && c.root) details[id] = rootPopover(answer, c.root, resourcesByComponent[id]);
  const list = waveListOf(marks, details);
  const key = waveListKey(list);
  if (key === kioskMarksTold) return;
  kioskMarksTold = key;
  try {
    window.parent.postMessage({ type: "behold:marks", list }, embedOpts.host);
  } catch {
    /* the parent went away */
  }
}
var kioskMarksTold = ""; // var: the marks may draw before this line is reached
/** Wire the frame's pointer once: the popover, and the hover links to the kiosk. Bare frames only. */
// --- behold#571: the kiosk's Watch mode -------------------------------------
// The kiosk sends a `behold:shot` (web/kiosk-shot.js) with each step: the
// roots or waves the step is about, or the whole graph, and how much of the
// pane its caption and callouts cover. The frame pans and zooms there, calm
// and short, and holds the shot through re-renders and resizes. It tells the
// kiosk where each wave box sits after every move (`behold:boxes`), so the
// callouts, the log drawer and the badges ride the boxes they describe. A
// viewer's own pan or zoom drops the shot and says so (`behold:viewer`).
var kioskShot = null; // var: read by the viewBox code, which may run before this line is reached
var shotAnim = null;
var boxesQueued = false;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** An element's box in the svg's user units, whatever transform sits over it. */
function userBoxOf(svg, el) {
  let b;
  try {
    b = el.getBBox();
  } catch {
    return null;
  }
  // getScreenCTM on both: svg.getCTM() is the viewBox's matrix in Chrome but the identity in Firefox, which put every box off
  // screen there. The screen matrices both include the viewBox, so root^-1 * el is the element's matrix in the svg's user units.
  const ctm = el.getScreenCTM && el.getScreenCTM();
  const root = svg.getScreenCTM && svg.getScreenCTM();
  if (!ctm || !root || !(b.width > 0 || b.height > 0)) return null;
  const m = root.inverse().multiply(ctm);
  const pts = [[b.x, b.y], [b.x + b.width, b.y + b.height]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
  return { x: Math.min(pts[0].x, pts[1].x), y: Math.min(pts[0].y, pts[1].y), x2: Math.max(pts[0].x, pts[1].x), y2: Math.max(pts[0].y, pts[1].y) };
}

/** What a shot frames, in svg units: its roots' cards and the reads between them, its waves' boxes, else the whole graph. */
/** What hangs under the lowest box in ask mode: its state label. */
const ASK_LABEL_ROOM = 32;
function kioskShotTarget(svg, shot) {
  if (!vbInit) return null;
  const boxes = [];
  if (shot.whole) {
    // The whole graph is what is drawn: the boxes, the cards and the reads, not pinhole's margins round them.
    // behold#744: not the reads' pills, which show and go while the shot stays.
    for (const n of svg.querySelectorAll("rect[data-group-id], [data-node-id], [data-tg-reads] > g:not([data-tg-read-pill]), line[data-tg-read-from], text[data-tg-reads='caption'], g[data-kl-state]")) boxes.push(userBoxOf(svg, n));
    const u = unionBox(boxes);
    // Ask mode: each box's state label hangs under it, and may not have drawn yet; the fit always leaves room for it, so the
    // stack sits the same before and after the labels (and centred, not low).
    if (u && shot.ask) {
      const low = Math.max(...[...svg.querySelectorAll("rect[data-group-id]")].map((r) => (userBoxOf(svg, r) || { y2: -Infinity }).y2));
      if (Number.isFinite(low)) u.y2 = Math.max(u.y2, low + ASK_LABEL_ROOM);
    }
    return u || { x: vbInit[0], y: vbInit[1], x2: vbInit[0] + vbInit[2], y2: vbInit[1] + vbInit[3] };
  }
  const named = (tgComponentFacets && tgComponentFacets.roots) || {};
  const roots = new Set(shot.roots);
  for (const g of svg.querySelectorAll("[data-node-id]")) {
    const id = g.getAttribute("data-node-id");
    if (roots.has(id) || roots.has(named[id])) boxes.push(userBoxOf(svg, g));
  }
  // Each card's wave box with it, so a shot never cuts a box's title off.
  const cards = boxes.filter(Boolean);
  for (const r of svg.querySelectorAll("rect[data-group-id]")) {
    const b = userBoxOf(svg, r);
    if (b && cards.some((c) => (c.x + c.x2) / 2 > b.x && (c.x + c.x2) / 2 < b.x2 && (c.y + c.y2) / 2 > b.y && (c.y + c.y2) / 2 < b.y2)) boxes.push(b);
  }
  for (const l of svg.querySelectorAll("line[data-tg-read-from]")) {
    if (roots.has(l.getAttribute("data-tg-read-from")) && roots.has(l.getAttribute("data-tg-read-to"))) boxes.push(userBoxOf(svg, l));
  }
  for (const n of shot.waves) {
    const r = svg.querySelector(`rect[data-group-id="wave-${n}"]`);
    if (r) boxes.push(userBoxOf(svg, r));
  }
  const u = unionBox(boxes);
  return u || { x: vbInit[0], y: vbInit[1], x2: vbInit[0] + vbInit[2], y2: vbInit[1] + vbInit[3] };
}

/** The viewBox of the kiosk's shot, at the pane's size now; the insets are the frame's window's, so the pane's own offset comes off them. */
function kioskShotBox() {
  const svg = currentSvg();
  const host = document.getElementById("graph");
  if (!svg || !host || !kioskShot) return null;
  const pane = host.getBoundingClientRect();
  const insets = kioskPaneInsets(kioskShot);
  // One framing on a small stage (web/kiosk-shot.js): when the whole graph fits with its cards readable, every step's
  // shot is the whole graph, and the viewBox holds from step to step and cycle to cycle while the repo, the view and
  // the pane stay. Judged with the room the held framing keeps, so a caption's height never flips the rule.
  // heldInsets: the run's caption's room at the top and the caption under the stage; nothing a step shows sits at the side.
  const docked = heldInsets(insets, kioskShot.room || 0);
  const rects = [...svg.querySelectorAll("[data-node-id] > rect")];
  const graph = `${new URLSearchParams(location.search).get("repo") || ""}|${view.components ? "components" : "resources"}`;
  // The graph itself, its boxes and cards: the marks, the reads' labels and the caption on it change from step to step.
  // Only the boxes' and the cards' own rects: a card's group also spans its hidden text and tooltips, and anything
  // else on the page (the reads' labels, the caption, the marks) is drawn over the graph, not part of what it spans.
  // A card or box grown to hold a cone's lines counts at its own height: the lines grow into the room under the
  // graph that the framing keeps, so they come and go with no move.
  const own = (r) => {
    const b = userBoxOf(svg, r);
    const h0 = Number(r.getAttribute("data-tg-h0"));
    const h = Number(r.getAttribute("height"));
    return b && h0 > 0 && h > 0 ? { ...b, y2: b.y + ((b.y2 - b.y) * h0) / h } : b;
  };
  // Only what is drawn: a rect hidden, or with no size on screen, is not part of the graph.
  const drawn = (r) => {
    const c = r.getBoundingClientRect();
    return c.width > 0 && c.height > 0 && !r.closest("[visibility='hidden'], [display='none']") && getComputedStyle(r).visibility !== "hidden";
  };
  const whole = heldTarget([...svg.querySelectorAll("rect[data-group-id]")].filter(drawn).map(own), rects.filter(drawn).map(own));
  const cardW = medianWidth(rects.map((r) => {
    const b = userBoxOf(svg, r);
    return b ? b.x2 - b.x : 0;
  }));
  // A frame the kiosk swapped in (a new pin each step) takes up the framing the last one held.
  if (!kioskHeld) kioskHeld = readHeld();
  const held = kioskHeld && kioskHeld.key === graph ? kioskHeld : null;
  // Only an estate on choudoufu's live backend (the cone scenario's) is held; every other keeps a shot per step, as on main.
  // behold#736: a story's stage (fan-out-choudoufu, a chapter-carrying scenario, behold#741) is never held: it keeps
  // the story's own look, its result card, #745's pills and #748's outside mark.
  // Ask mode is never held: the held framing is the union of every target it has seen (the graph before the scene drew included), which leaves the scene off-centre. It is fitted to the scene as drawn, every time.
  // Nor while the kiosk says ask mode is on (klAskFlag): a shot between its prompts, or a reset's, frames the scene too,
  // and never restores a framing this tab's session kept from an earlier graph.
  if (whole && !kioskShot.ask && !klAskFlag && !tgStoryOn() && holdsStage(tgAnswer && !tgAnswer.error ? tgAnswer.binaries : null) && smallStage(whole, pane, held ? held.insets : docked, cardW)) {
    kioskHeld = heldFrame(kioskHeld, { key: graph, pane, insets: docked, target: whole });
    writeHeld(kioskHeld);
    document.documentElement.classList.add("kiosk-held");
    // What the framing was made of, for a check from outside: the inputs, and why it last framed again.
    window.__kioskHeld = () => ({ ...kioskHeld, inputs: { pane: { width: pane.width, height: pane.height }, insets: docked, shot: kioskShot.insets, room: kioskShot.room || 0, cards: rects.length, cardW, target: whole } });
    return kioskHeld.vb;
  }
  kioskHeld = null;
  document.documentElement.classList.remove("kiosk-held");
  // behold#939: a prompt-driven step fills the room above the pane (the graph is small, and the pane says the rest).
  return shotViewBox(kioskShotTarget(svg, kioskShot), pane, { ...insets, right: Math.max(insets.right, railInset(pane)) }, kioskShot.ask ? { maxScale: ASK_MAX_SCALE } : undefined);
}
/** The whole-graph framing Watch holds on a small stage while the graph and the pane stay (web/kiosk-shot.js heldFrame); null on a bigger one. */
var kioskHeld = null;
/** Where the held framing is kept for the frame the kiosk swaps in next: this tab's session, same origin as every frame. */
var HELD_STORE = "behold.kiosk.held.v3";
function readHeld() {
  try {
    const h = JSON.parse(sessionStorage.getItem(HELD_STORE) || "null");
    return h && typeof h.key === "string" && Array.isArray(h.vb) && h.pane && h.insets && h.target ? h : null;
  } catch {
    return null;
  }
}
function writeHeld(h) {
  try {
    sessionStorage.setItem(HELD_STORE, JSON.stringify(h));
  } catch {
    /* no storage: this frame still holds its own framing */
  }
}

/** A shot's insets (the frame's window px) as the graph pane's own: the pane's offset in the window comes off them. */
function kioskPaneInsets(shot) {
  const host = document.getElementById("graph");
  const i = (shot && shot.insets) || {};
  if (!host) return { top: 0, right: 0, bottom: 0, left: 0 };
  const pane = host.getBoundingClientRect();
  return {
    top: Math.max(0, (i.top || 0) - pane.top),
    left: Math.max(0, (i.left || 0) - pane.left),
    bottom: Math.max(0, (i.bottom || 0) - (window.innerHeight - pane.bottom)),
    right: Math.max(0, (i.right || 0) - (window.innerWidth - pane.right)),
  };
}

/** Move to the shot: a pan and zoom over its time, or at once (a re-render, a resize, reduced motion). */
function applyKioskShot(animate) {
  // "now": a refit (a resize, the fonts, the first draw settling) sets the view directly, over any move under way.
  if (animate === "now") {
    animate = false;
    if (shotAnim) {
      cancelAnimationFrame(shotAnim.raf);
      shotAnim = null;
    }
  }
  // #715: while a live carve runs, its director has the camera; the shot waits for it to end.
  if (dotsCarving()) return kioskTellBoxes();
  const to = kioskShotBox();
  if (!to || !vb) return kioskTellBoxes();
  if (shotAnim && !animate) {
    shotAnim.to = to; // a move under way lands on the shot as it is now
    return;
  }
  if (sameViewBox(vb, to)) return kioskTellBoxes();
  // A held small stage lands on its one framing at once: a frame the kiosk swapped in never moves into it on screen.
  const landing = !!kioskHeld && vbAtFit;
  vbAtFit = false;
  const ms = kioskShot.ms;
  if (!animate || landing || reducedMotion() || !(ms > 0)) {
    if (shotAnim) cancelAnimationFrame(shotAnim.raf);
    shotAnim = null;
    vb = to;
    applyVB();
    return;
  }
  if (shotAnim) cancelAnimationFrame(shotAnim.raf);
  const from = vb.slice();
  const start = performance.now();
  shotAnim = { to, raf: 0 };
  const step = (t) => {
    if (!shotAnim) return;
    const f = Math.min(1, (t - start) / ms);
    vb = tweenViewBox(from, shotAnim.to, f);
    applyVB();
    if (f < 1) shotAnim.raf = requestAnimationFrame(step);
    else shotAnim = null;
  };
  shotAnim.raf = requestAnimationFrame(step);
}

/** A viewer moved the graph: the shot goes, and the kiosk holds the view. */
var viewerToldAt = 0;
function kioskViewerMoved() {
  if (!embedOpts.bare) return;
  if (shotAnim) cancelAnimationFrame(shotAnim.raf);
  shotAnim = null;
  kioskShot = null;
  const t = Date.now();
  if (t - viewerToldAt < 400 || !embedOpts.host || window.parent === window) return;
  viewerToldAt = t;
  try {
    window.parent.postMessage({ type: "behold:viewer" }, embedOpts.host);
  } catch {
    /* the parent went away */
  }
}

/** Tell the kiosk where each wave box sits in the frame's window, once a frame. */
function kioskTellBoxes() {
  if (!embedOpts.bare || !embedOpts.host || window.parent === window || boxesQueued) return;
  boxesQueued = true;
  requestAnimationFrame(() => {
    boxesQueued = false;
    const svg = currentSvg();
    if (!svg) return;
    tgPillsKeepIn(svg); // behold#764: the camera moved; the shown pills stay in view
    const waves = {};
    const rect = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
    for (const r of svg.querySelectorAll("rect[data-group-id]")) {
      const n = tgWaveOfKey(r.getAttribute("data-group-id"));
      if (n !== null) waves[n] = rect(r.getBoundingClientRect());
    }
    // behold#571 event-help: each root's cards, where the kiosk's tips about a root point.
    const roots = {};
    const named = (tgComponentFacets && tgComponentFacets.roots) || {};
    for (const g of svg.querySelectorAll("[data-node-id]")) {
      const id = g.getAttribute("data-node-id");
      const r = g.getBoundingClientRect();
      if (!r.width) continue;
      for (const root of new Set([id, named[id]].filter(Boolean))) {
        const had = roots[root];
        roots[root] = had ? { x: Math.min(had.x, Math.round(r.left)), y: Math.min(had.y, Math.round(r.top)), w: Math.round(Math.max(had.x + had.w, r.right) - Math.min(had.x, r.left)), h: Math.round(Math.max(had.y + had.h, r.bottom) - Math.min(had.y, r.top)) } : rect(r);
      }
    }
    // The reads' labels too, which the kiosk's callouts keep clear of.
    // behold#744: a read's pill only while it shows.
    const labels = [...svg.querySelectorAll("[data-tg-reads] > g:not([data-tg-read-pill]), [data-tg-reads] > g.tg-flash, [data-tg-reads] > g.tg-hot, [data-tg-reads] > g.tg-shown")].map((g) => rect(g.getBoundingClientRect())).filter((r) => r.w > 0);
    const host = document.getElementById("graph");
    const pane = host ? rect(host.getBoundingClientRect()) : null;
    try {
      // held: one framing holds the small stage.
      window.parent.postMessage({ type: "behold:boxes", waves, roots, labels, pane, moving: !!shotAnim, held: !!kioskHeld }, embedOpts.host);
    } catch {
      /* the parent went away */
    }
  });
}

/**
 * behold#571: tell the kiosk this page has drawn its graph, once: cards on
 * the canvas and terragucci's marks on them (or their read answered, or
 * failed). The kiosk loads a new frame out of sight and swaps it in on this,
 * so the graph pane never shows an empty frame.
 */
var drawnTold = false;
/** Whether the graph has drawn with its marks: "failed" when it could not, true once drawn, false while it is still coming. */
function graphDrawnState() {
  const svg = currentSvg();
  if (document.querySelector("#graph > .err")) return "failed";
  if (!(svg && svg.querySelector("[data-node-id]"))) return false;
  // The marks: terragucci's reports answered (or refused), or chant's loop has its own.
  if (terragucciComponentsRepo && !tgAnswer && !chantPrDrawn()) return false;
  // behold#631: a chant repo's loop: its first read of /api/chant/pr, answered or not.
  if (!terragucciComponentsRepo && view.components && chantFacets && !staticMode && !chantPrRead) return false;
  return true;
}
function kioskTellDrawn() {
  if (drawnTold || !embedOpts.host || window.parent === window) return;
  const drawnState = graphDrawnState();
  if (!drawnState) return;
  // Ask mode: not drawn until the estate scene is (or the kiosk's word that ask mode is on has not come in a while: a failed draw says so at once).
  if (drawnState !== "failed" && !mayTellDrawn({ askHeard: klAskHeard, waitedMs: performance.now(), askOn: document.documentElement.classList.contains("kiosk-ask"), mayShow: klGate().mayShow })) return;
  const failed = drawnState === "failed";
  drawnTold = true;
  try {
    window.parent.postMessage({ type: "behold:drawn", failed }, embedOpts.host);
  } catch {
    /* the parent went away */
  }
}
// A graph that failed draws no svg and no reads: say so too, so the kiosk is never left waiting.
if (embedOpts.bare) setInterval(kioskTellDrawn, 1000);

// --- behold#915: the page `behold shot` photographs ---------------------------
// `?embed=1&bare=1&frame=matches` (web/shot-frame.js). Once the graph has
// drawn, the cards the view asks for are lit and the rest dimmed, the lit
// cards are framed with the kiosk's arithmetic at once (no move), one caption
// line says what was asked, from where and when, and <html> gets
// `data-behold-shot`. A graph that never draws never sets it, so the driver
// times out and writes nothing.
const shotFrameOn = !!embedOpts.bare && readShotFrame(location.search) === "matches";
// The link as loaded: the page rewrites its URL as it settles the view (a card it lacks drops out), and the shot answers what was asked.
const shotAsked = new URLSearchParams(location.search);
var shotFrameDone = false; // var: setupGraphViewBox reads it, and may run before this line is reached
var shotQueryFailed = false; // behold#913: the query was refused, or its live read failed
function shotFrameTick() {
  if (!shotFrameOn || shotFrameDone) return;
  const drawnState = graphDrawnState();
  if (!drawnState) return;
  // behold#913: a query is drawn once chant has answered it (drawQuery marks the cards first).
  if (drawnState !== "failed" && queryAnswerNow() === undefined) return;
  shotFrameDone = true;
  const state = shotFrameApply(drawnState === "failed");
  // Two frames, so what was set above is painted before the driver looks.
  requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.setAttribute(SHOT_ATTR, state)));
}
/** Light, dim, frame and caption the graph as it is drawn now; the state the shot reports. */
function shotFrameApply(failed = !!document.querySelector("#graph > .err")) {
  const params = shotAsked;
  const svg = currentSvg();
  const host = document.getElementById("graph");
  let lit = { ids: [], asked: false, label: null };
  if (!failed && svg && host) {
    const ownRect = (g) => g.querySelector(":scope > rect") || g;
    const cards = [...svg.querySelectorAll("[data-node-id]")].map((g) => ({ id: g.getAttribute("data-node-id"), g, box: userBoxOf(svg, ownRect(g)) }));
    const groups = [...svg.querySelectorAll("rect[data-group-id]")].map((r) => ({ id: r.getAttribute("data-group-id"), box: userBoxOf(svg, r) }));
    // behold#913: the query's matched node ids (drawQuery has marked the cards and the path edges). Without a
    // query, the link's own node and focus, as asked: a card the graph lacks is a question with no answer, never the whole graph.
    const qa = queryAnswerNow();
    // #908 stage 3: the matches and the frame come from drawQuery's marks, so a stack holding a match counts and the path is in the picture.
    const qf = qa && qa.draw ? queryFrame(cards.map((c) => ({ id: c.id, mark: c.g.getAttribute("data-q") }))) : null;
    lit = shotLit({ node: params.get("node"), focus: params.get("focus") }, cards, groups, qa ? (qf ? qf.lit : []) : null);
    shotQueryFailed = !!qa && (!qa.draw || !!qa.draw.failure);
    const on = new Set(lit.ids);
    for (const c of cards) {
      // A query's on-path cards stay at full weight; a refused query dims nothing.
      const dim = qa ? c.g.getAttribute("data-q") === "dim" : lit.asked && !on.has(c.id);
      c.g.style.opacity = dim ? String(SHOT_DIM) : "";
      if (dim || (qa && !on.has(c.id))) c.g.setAttribute("data-shot-dim", "1");
      else c.g.removeAttribute("data-shot-dim");
    }
    for (const e of svg.querySelectorAll("[data-edge-from]")) {
      const mark = e.getAttribute("data-q");
      const dim = qa ? mark === "dim" : lit.asked && !(on.has(e.getAttribute("data-edge-from")) && on.has(e.getAttribute("data-edge-to")));
      e.style.opacity = dim ? String(SHOT_DIM) : "";
    }
    // The lit cards, or with none lit the whole graph as drawn (its boxes' titles and all).
    const whole = vbInit && { x: vbInit[0], y: vbInit[1], x2: vbInit[0] + vbInit[2], y2: vbInit[1] + vbInit[3] };
    const framed = qf ? new Set(qf.frame) : on;
    const target = (lit.ids.length && unionBox(cards.filter((c) => framed.has(c.id)).map((c) => c.box))) || whole;
    const pane = host.getBoundingClientRect();
    const to = target && shotViewBox(target, { width: pane.width, height: pane.height }, { bottom: SHOT_CAPTION_PX });
    if (to) {
      vb = to;
      vbAtFit = false;
      applyVB();
    }
  }
  const qa = queryAnswerNow();
  const state = shotState({ failed: failed || shotQueryFailed, lit });
  const err = document.querySelector("#graph > .err");
  let cap = document.getElementById("shot-caption");
  if (!cap) {
    cap = document.createElement("div");
    cap.id = "shot-caption";
    cap.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${SHOT_CAPTION_PX}px;padding:0 12px;font:13px/1 system-ui,sans-serif;line-height:${SHOT_CAPTION_PX}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:50;background:var(--bg, #0d1117);color:var(--fg, #e6edf3);border-top:1px solid var(--border, #30363d)`;
    document.body.appendChild(cap);
  }
  cap.style.color = state === "failed" ? "var(--degraded, #f85149)" : "var(--fg, #e6edf3)";
  // behold#913: chant's own provenance line, and its failure, when a query was asked.
  const qFailure = qa ? (qa.draw ? qa.draw.failure && [qa.draw.failure.message, qa.draw.failure.hint].filter(Boolean).join(". ") : qa.error || "the search failed") : null;
  cap.textContent = shotCaption({
    query: params.get("q") || (params.get("countBy") ? "the whole graph" : null),
    counts: qa && qa.draw && qa.draw.counts ? countsLine(qa.draw.counts) : null,
    label: lit.label,
    provenance: (qa && qa.draw && qa.draw.provenance) || shotProvenance({ env: view.env, snapshot: params.get("snapshot") }),
    failure: state === "failed" ? (err ? (err.textContent || "the graph failed to draw").split("\n")[0] : qFailure || "the graph failed to draw") : null,
    state,
    plan: !!view.plan,
  });
  return state;
}
if (shotFrameOn) setInterval(shotFrameTick, 250);

window.addEventListener("message", (e) => {
  if (!embedOpts.bare) return;
  const shot = shotFromMessage(e, embedOpts.host);
  if (!shot) return;
  if (shot.release) {
    if (shotAnim) cancelAnimationFrame(shotAnim.raf);
    shotAnim = null;
    kioskShot = null;
    document.documentElement.classList.remove("kiosk-held"); // Inspect: the zoom rail is the viewer's again
    klSetAsk(klAskFlag);
    fitGraph();
    return;
  }
  kioskShot = shot;
  klAskHeard = true;
  klSetAsk(!!shot.ask || klAskFlag);
  applyKioskShot(true);
});

function wireKioskFrame() {
  if (!embedOpts.bare) return;
  const graph = document.getElementById("graph");
  if (!graph) return;
  graph.addEventListener("pointerover", (e) => {
    const card = e.target.closest && e.target.closest("[data-node-id]");
    if (card) {
      // The card's own tooltips would sit over the popover.
      for (const t of card.querySelectorAll("title")) t.remove();
      kioskPopEvent({ type: "enter", id: card.getAttribute("data-node-id") });
    }
    kioskSetHover(kioskHoverOf(e.target));
  });
  graph.addEventListener("pointerout", (e) => {
    const card = e.target.closest && e.target.closest("[data-node-id]");
    const into = e.relatedTarget;
    if (card && !(into && card.contains(into))) kioskPopEvent({ type: "leave", id: card.getAttribute("data-node-id") });
    if (!into || !graph.contains(into)) kioskSetHover(null);
  });
  graph.addEventListener(
    "click",
    (e) => {
      const card = e.target.closest && e.target.closest("[data-node-id]");
      if (card) kioskPopEvent({ type: "click", id: card.getAttribute("data-node-id") });
      else kioskPopEvent({ type: "outside" });
      // behold#571: a click on the graph holds the kiosk's shot where the viewer is reading.
      if (card && kioskShot) kioskViewerMoved();
      // behold#571: a click on a wave's box (not a card in it) asks the kiosk for that wave's trace, or its log.
      // While the dots layer has the SVG out of the paint, its wave boxes are not on screen: a tap there is on a dot or a card.
      const svgShown = !(currentSvg() && currentSvg().style.visibility === "hidden");
      if (!card && !panMoved && svgShown && embedOpts.host && window.parent !== window) {
        const box = e.target.closest && (e.target.closest("rect[data-group-id]") || e.target.closest("[data-group-id]"));
        let n = box ? tgWaveOfKey(box.getAttribute("data-group-id")) : null;
        if (n === null) {
          // A box's title or marks sit over it: find the box the click is inside.
          const svg = currentSvg();
          for (const r of svg ? svg.querySelectorAll("rect[data-group-id]") : []) {
            const b = r.getBoundingClientRect();
            const w = tgWaveOfKey(r.getAttribute("data-group-id"));
            if (w !== null && e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom) n = w;
          }
        }
        if (n !== null) {
          try {
            window.parent.postMessage({ type: "behold:wave", wave: n }, embedOpts.host);
          } catch {
            /* the parent went away */
          }
        }
      }
    },
    true,
  );
  document.addEventListener("click", (e) => {
    if (!graph.contains(e.target) && !(e.target.closest && e.target.closest("#k-pop"))) kioskPopEvent({ type: "outside" });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") kioskPopEvent({ type: "escape" });
  });
  setInterval(() => kioskPopEvent({ type: "tick" }), 1000);
  window.addEventListener("message", (e) => {
    if (!embedOpts.host || e.origin !== embedOpts.host) return;
    if (e.data && e.data.type === "behold:unpin") return kioskPopEvent({ type: "outside" });
    // behold#937: the demo step's lighting from the kiosk (web/kiosk-light.js lightMessage).
    if (e.data && e.data.type === "behold:hold") {
      if (klHold) clearTimeout(klHold);
      klHold = setTimeout(klReleaseHold, 120000); // slow typing and queued steps hold it for a while; a step that never finishes does not freeze the graph for good
      return;
    }
    if (e.data && e.data.type === "behold:light") {
      const wasHeld = !!klHold;
      if (klHold) {
        clearTimeout(klHold);
        klHold = null;
      }
      klMsg = { labels: e.data.labels === true, lit: e.data.lit === true, ids: Array.isArray(e.data.ids) ? e.data.ids.filter((x) => typeof x === "string") : [], roots: Array.isArray(e.data.roots) ? e.data.roots.filter((x) => typeof x === "string") : [], ghost: e.data.ghost === true, token: e.data.token ?? null };
      klRedraw();
      if (wasHeld && klHeldPaint) {
        klHeldPaint = false;
        paintTgProgress();
      }
      // behold#940: drawn at once from what the frame holds, and again as soon as its reads are fresh: never at a poll's turn.
      if (!staticMode && tgAnswer) {
        void refreshTgAnswer();
        void loadTgProgress({ fresh: true });
      }
      return;
    }
    // behold#940: ask mode is on or off for this step, whatever the shots say between prompts.
    if (e.data && e.data.type === "behold:ask") {
      klAskFlag = e.data.on === true;
      klAskHeard = true;
      klSetAsk(klAskFlag || !!(kioskShot && kioskShot.ask));
      return;
    }
    // behold#571: the kiosk's theme picker moved; follow it here without a reload.
    if (e.data && e.data.type === "behold:theme" && typeof e.data.name === "string") return void setTheme(e.data.name, { persist: false });
    // behold#741: the scenario carries chapters (or stopped carrying them): the kiosk's look, and the wave blocks, follow.
    if (e.data && e.data.type === "behold:story") {
      const on = e.data.on === true;
      const cycle = Number.isInteger(e.data.cycle) ? e.data.cycle : null;
      const was = tgStoryOn();
      // behold#743: the step's apply made outside the pipeline, or null; a change redraws the marks.
      const outside = e.data.outside && typeof e.data.outside === "object" && typeof e.data.outside.estate === "string" ? e.data.outside : null;
      const outsideMoved = JSON.stringify(outside) !== JSON.stringify((tgStory && tgStory.outside) || null);
      tgStory = { on, cycle, outside };
      if (tgStoryOn() !== was && view.components && terragucciComponentsRepo) load({ quiet: true });
      else if (outsideMoved && tgStoryOn()) drawTgReads();
      return;
    }
    const h = hoverFromMessage(e.data);
    if (h === undefined) return;
    kioskHostHover = h;
    kioskGlow();
  });
}
wireKioskFrame();

function markAge(marks) {
  const newest = marks.map((m) => m.run.finished).sort().pop();
  const s = Math.max(0, (Date.now() - Date.parse(newest)) / 1000);
  return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
}
function tgLink(text, href) {
  const a = document.createElement("a");
  a.textContent = text;
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}
function renderTerragucciPanel() {
  if (!tgHost) {
    tgHost = addPanelTab("terragucci", "Terragucci", "What terragucci's reports found: each root's newest drift check, plan and apply wave, dated. Not live.");
    if (!tgHost) return;
    tgHost.id = "tab-terragucci";
  }
  const host = tgHost;
  host.replaceChildren();
  const a = tgAnswer;
  if (!a || a.error) {
    const err = document.createElement("div");
    err.className = "tg-refusal";
    err.textContent = a ? a.error : "terragucci reports not read";
    if (a && a.remedy) err.title = a.remedy;
    const fix = document.createElement("div");
    fix.className = "tg-legend";
    fix.textContent = (a && a.remedy) || "";
    host.append(err, fix);
    renderTerragucciLane(host, new Date());
    return;
  }
  const now = new Date();
  const head = document.createElement("div");
  head.className = "tg-legend";
  const lg = tgLegend(a, now);
  head.textContent = lg.text;
  head.title = lg.title;
  host.appendChild(head);
  const est = estateLine(a, now);
  if (est) {
    const line = document.createElement("div");
    line.className = "tg-estate";
    line.appendChild(tgLink(est.text, est.href));
    host.appendChild(line);
  }
  renderTerragucciLane(host, now);
  if (tgProgress) host.appendChild(tgProgressSection(tgProgress, now, tgLink)); // #511
  host.appendChild(tgChangeSection(a, tgProgress, now, { link: tgLink, button, copy: copyToClipboard })); // #568
  for (const w of waveCards(a, now)) {
    const box = document.createElement("div");
    box.className = "ws-gate tg-wave";
    const title = document.createElement("div");
    title.className = "ws-gate-title";
    title.textContent = w.title;
    const facts = document.createElement("div");
    facts.className = "ws-gate-facts";
    facts.textContent = w.facts;
    box.append(title, facts);
    for (const d of w.destroys) {
      const row = document.createElement("div");
      row.className = "ws-gate-note";
      row.textContent = `destroys ${d}`;
      box.appendChild(row);
    }
    const cmd = document.createElement("code");
    cmd.className = "tg-command";
    cmd.textContent = w.command;
    const copy = button("Copy", "", () => copyToClipboard(w.command, copy));
    copy.title = "Copy the line. Run it at your shell: the approval is yours, signed, in git.";
    const note = document.createElement("div");
    note.className = "ws-gate-note";
    note.textContent = w.note;
    const links = document.createElement("div");
    links.className = "ws-gate-note";
    links.appendChild(tgLink("report", w.report));
    if (w.job) links.append(" · ", tgLink("job", w.job));
    box.append(cmd, copy, note, links);
    host.appendChild(box);
  }
  for (const r of tgRootRows(a, now)) {
    const row = document.createElement("div");
    row.className = "tg-root";
    const path = document.createElement("div");
    path.className = "tg-path";
    path.textContent = r.path;
    path.title = `${r.member}/${r.name}`;
    const cells = document.createElement("div");
    cells.className = "tg-cells";
    for (const k of ["drift", "plan", "apply"]) {
      const span = document.createElement("span");
      span.className = `tg-${r[k].tone}`;
      span.dataset.stage = k;
      if (r[k].href) span.appendChild(tgLink(r[k].text, r[k].href));
      else span.textContent = r[k].text;
      if (r[k].title) span.title = r[k].title;
      cells.appendChild(span);
    }
    row.append(path, cells);
    host.appendChild(row);
  }
  if (a.unmatched && (a.unmatched.roots.length || a.unmatched.changes.length)) {
    const um = document.createElement("div");
    um.className = "tg-legend";
    um.textContent = [
      a.unmatched.roots.length ? `reported roots this checkout does not declare: ${a.unmatched.roots.join(", ")}` : "",
      a.unmatched.changes.length ? `changes no card is: ${a.unmatched.changes.map((c) => `${c.root}: ${c.address}`).join(", ")}` : "",
    ].filter(Boolean).join(" · ");
    host.appendChild(um);
  }
  if (tgTimeline || tgHistory) {
    const h = document.createElement("div");
    h.className = "tg-timeline-title";
    h.textContent = "Timeline";
    host.append(h);
    // #522: the audit record, and the ledger's history beside it, each
    // labelled by its source. Without an audit.jsonl the record's lane is its
    // one "has no audit.jsonl" sentence and the ledger carries the history.
    if (tgTimeline) host.append(tgLane(tgTimeline));
    if (tgHistory) host.append(tgHistoryLane(tgHistory));
  }
  if (!staticMode) {
    const again = button("Read the reports again", "", () => {
      loadTerragucci({ fresh: true });
      loadTerragucciLane({ fresh: true }); // #505: and chant/lifecycle
    });
    host.appendChild(again);
  }
}
initTerragucci();
// #525: each environment's newest release from the release ledger on
// chant/lifecycle, with a cell whose schema the environment before it does
// not hold marked. Dated and read-only; a static export carries its snapshot.
let relHost = null;
async function initReleases() {
  const project = await apiFetch("/api/project").then((r) => r.json()).catch(() => ({}));
  if (!project.releaseLedger) return;
  await loadReleases();
}
async function loadReleases({ fresh = false } = {}) {
  const a = await apiFetch(`/api/lifecycle/releases${fresh ? "?fresh=1" : ""}`)
    .then((r) => r.json())
    .catch((e) => ({ error: String(e) }));
  if (!relHost) {
    relHost = addPanelTab("releases", "Releases", "Each environment's newest release from the release ledger on chant/lifecycle, dated. Not live.");
    if (!relHost) return;
    relHost.id = "tab-releases";
  }
  renderReleases(relHost, a, new Date(), { link: tgLink });
  if (!staticMode) {
    const again = button("Read again", "", () => loadReleases({ fresh: true }));
    again.title = "Read chant/lifecycle again and redraw.";
    relHost.appendChild(again);
  }
}
initReleases();

// --- #680: the trunk lane ---------------------------------------------------
// /api/workspace/lane: the trunk's commits, then per environment in promotion
// order what runs and what waits at a gate. A served workspace gets the tab;
// the lane is read when the tab is opened (and on "Read again"), never at boot,
// since it asks chant once per environment. Approving posts to the gate
// strip's route, then both are read again.
let laneHost = null;
let laneRead = false;
async function initTrunkLane() {
  if (staticMode || publicMode) return; // #569: /api/workspace/* is refused in a public view
  const project = await apiFetch("/api/project").then((r) => r.json()).catch(() => ({}));
  if (!project.workspace) return;
  laneHost = addPanelTab("trunk", "Trunk", "The trunk's recent commits and, per environment in promotion order, what runs there and what waits at a gate. Read from chant when you open the tab.");
  if (!laneHost) return;
  laneHost.id = "tab-trunk";
  const tab = document.querySelector('#panel-tabs button[data-tab="trunk"]');
  if (tab) tab.addEventListener("click", () => laneRead || loadTrunkLane());
  if (laneHost.classList.contains("active")) loadTrunkLane();
}
async function loadTrunkLane() {
  laneRead = true;
  const reading = document.createElement("div");
  reading.className = "tg-legend";
  reading.textContent = "reading the trunk from chant";
  laneHost.replaceChildren(reading);
  const a = await apiFetch("/api/workspace/lane")
    .then((r) => r.json())
    .catch((e) => ({ error: String(e) }));
  renderTrunkLane(laneHost, a, new Date(), { button, link: tgLink, embed: embedOpts.embed, canApprove: !previewMode && !staticMode, approve: approveFromLane, openChangeSet });
  const again = button("Read again", "", () => loadTrunkLane());
  again.title = "Read the trunk and every environment again.";
  laneHost.appendChild(again);
}
function approveFromLane(key, env, btn) {
  if (btn) btn.disabled = true;
  fetch("/api/workspace/gates/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, env }) })
    .then((r) => r.json())
    .then((j) => {
      if (j.error) {
        showToast(`✗ approve ${key}: ${j.error}`, false);
        nowline("✗ " + j.error);
      } else {
        showToast(`✓ ${key} approved as ${j.approver}${j.signed ? ", signed" : ""}`, true);
      }
      loadTrunkLane();
      loadWorkspaceGates({ force: true });
    })
    .catch((e) => showToast(`✗ approve ${key}: ${e}`, false))
    .finally(() => {
      if (btn) btn.disabled = false;
    });
}
initTrunkLane();

// --- behold#685: run a plan job locally ---------------------------------------
// chant ci run plan --local at a commit, drawn in the runs pane's run view
// beside CI's run of the same job. It starts a command, so it is drawn only
// where behold may start one: a served workspace, never in a public view, an
// embed, a static export, preview mode or a terragucci or SQL Yodeler repo.
async function initLocalRuns() {
  if (staticMode || publicMode || embedOpts.embed) return;
  const project = await apiFetch("/api/project").then((r) => r.json()).catch(() => ({}));
  if (!project.workspace || project.previewMode || project.publicMode || project.terragucci || project.sqlYodeler) return;
  const host = addPanelTab("local-runs", "Local", "Run a CI plan job on this machine with chant ci run --local, beside CI's run of it.");
  if (!host) return;
  host.id = "tab-local-runs";
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    startLocalRuns(host, { fetchJson: (url, init) => fetch(url, init).then((r) => r.json()), events, toast: showToast });
  };
  const tab = document.querySelector('#panel-tabs button[data-tab="local-runs"]');
  if (tab) tab.addEventListener("click", start);
  if (host.classList.contains("active")) start();
}
initLocalRuns();

// --- #683: feature flags, on or off per environment ---------------------------
// The Flags tab reads /api/workspace/flags when it is opened: each flag of the
// workspace with its owner, work item and value per environment, a flip
// waiting at a gate as the link that opens that gate's change set (#681), and
// otherwise the lines a person runs to turn it on. behold changes no flag. The
// tab picks an environment, and every card of a flagged member gets a tag under
// it, since chant names no node that reads a build parameter.
let flAnswer = null;
let flOn = true;
let flEnv = null;
let flHost = null;
let flRead = false;
async function initFlags() {
  if (staticMode || publicMode) return; // /api/workspace/* is refused in a public view
  const project = await apiFetch("/api/project").then((r) => r.json()).catch(() => ({}));
  if (!project.workspace) return;
  flHost = addPanelTab("flags", "Flags", "The workspace's feature flags, on or off per environment, with their owner and work item. Read from chant when you open the tab.");
  if (!flHost) return;
  flHost.id = "tab-flags";
  const tab = document.querySelector('#panel-tabs button[data-tab="flags"]');
  if (tab) tab.addEventListener("click", () => flRead || loadFlags());
  if (flHost.classList.contains("active")) loadFlags();
}
async function loadFlags() {
  flRead = true;
  const reading = document.createElement("div");
  reading.className = "tg-legend";
  reading.textContent = "reading the flags from chant";
  flHost.replaceChildren(reading);
  flAnswer = await apiFetch("/api/workspace/flags")
    .then((r) => r.json())
    .catch((e) => ({ error: String(e) }));
  flEnv = flPickEnv(flAnswer, flEnv || view.env);
  markFlagCards();
}
function markFlagCards() {
  const svg = document.querySelector("#graph svg");
  if (svg) {
    for (const old of svg.querySelectorAll("[data-fl-mark]")) old.remove();
    if (flAnswer && flOn) {
      const ids = [...svg.querySelectorAll("[data-node-id]")].map((g) => g.getAttribute("data-node-id"));
      for (const [id, m] of Object.entries(flFlagMarks(flAnswer, flEnv, ids, nodeMember))) {
        const g = svg.querySelector('[data-node-id="' + CSS.escape(id) + '"]');
        if (!g) continue;
        const rect = g.querySelector("rect");
        const box = rect && rect.getBBox ? rect.getBBox() : { x: 0, y: 0, width: 150, height: 60 };
        const tag = document.createElementNS("http://www.w3.org/2000/svg", "text");
        tag.setAttribute("data-fl-mark", "tag");
        tag.setAttribute("x", String(box.x));
        tag.setAttribute("y", String(box.y + box.height + 13));
        tag.setAttribute("font-size", "11");
        tag.setAttribute("font-weight", "700");
        tag.setAttribute("fill", m.stale ? FL_STALE_COLOR : m.color);
        tag.textContent = m.tag;
        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.setAttribute("data-fl-mark", "title");
        title.textContent = m.title;
        tag.appendChild(title);
        g.append(tag);
      }
    }
  }
  renderFlagsTab();
}
function renderFlagsTab() {
  if (!flHost) return;
  flHost.replaceChildren();
  const line = (cls, text, title, host = flHost) => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    if (title) d.title = title;
    host.appendChild(d);
    return d;
  };
  const h = flHeader(flAnswer);
  line(h.tone === "refusal" ? "tg-refusal" : "fl-title", h.text, h.title);
  const refused = !flAnswer || flAnswer.error || flAnswer.refusal;
  if (refused && flAnswer && flAnswer.degraded) line("tg-legend", `Without it, ${flAnswer.degraded}.`);
  if (!refused) {
    line("tg-legend", FL_NODES_NOTE);
    if (flAnswer.environments.length) {
      const pick = document.createElement("div");
      pick.className = "fl-envs";
      const label = document.createElement("span");
      label.textContent = "on the graph in";
      pick.appendChild(label);
      for (const env of flAnswer.environments) {
        const b = button(env, env === flEnv ? "fl-env on" : "fl-env", () => {
          flEnv = env;
          markFlagCards();
        });
        b.setAttribute("aria-pressed", String(env === flEnv));
        b.title = `Mark each flagged card with its flags' values in ${env}.`;
        pick.appendChild(b);
      }
      flHost.appendChild(pick);
    }
    for (const g of flGapLines(flAnswer)) line("tg-refusal", g.text, g.title);
    const toggle = button(flOn ? "Turn off the marks" : "Turn on the marks", "", () => {
      flOn = !flOn;
      markFlagCards();
    });
    toggle.title = flOn ? "Remove the flag marks from the graph. The tab keeps the flags." : "Mark the flagged cards on the graph again.";
    flHost.appendChild(toggle);
    if (!flAnswer.flags.length) line("tg-legend", "no member has a feature flag");
    for (const f of flAnswer.flags) {
      const r = flFlagRow(f, flEnv);
      const box = document.createElement("div");
      box.className = "fl-flag";
      const title = line("fl-flag-title", r.title, r.path, box);
      if (r.stale) {
        const s = document.createElement("span");
        s.className = "fl-stale";
        s.textContent = ` · ${r.stale.text}`;
        s.title = r.stale.title;
        title.appendChild(s);
      }
      line("fl-facts", r.facts, "", box);
      const values = document.createElement("div");
      values.className = "fl-values";
      for (const v of r.values) {
        const span = document.createElement("span");
        span.className = v.current ? "fl-value current" : "fl-value";
        span.style.setProperty("--dot", v.color);
        span.textContent = v.text;
        values.appendChild(span);
      }
      box.appendChild(values);
      for (const w of r.waiting) {
        const d = line("fl-waiting", `${w.text} · `, "", box);
        const a = document.createElement("a");
        a.href = "#";
        a.className = "lane-change-set";
        a.textContent = w.link;
        a.title = w.title;
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          openChangeSet(w.gate, w.env);
        });
        d.appendChild(a);
      }
      for (const t of r.turnOn) {
        line("fl-turn-on", t.head, FL_TURN_ON_NOTE, box);
        const pre = document.createElement("pre");
        pre.className = "fl-lines";
        pre.textContent = t.lines.join("\n");
        pre.title = FL_TURN_ON_NOTE;
        box.appendChild(pre);
      }
      flHost.appendChild(box);
    }
    if (flAnswer.flags.some((f) => f.turnOn.length)) line("tg-legend", FL_TURN_ON_NOTE);
  }
  if (!staticMode) {
    const again = button("Read again", "", () => loadFlags());
    again.title = "Read the flags and every environment's gates from chant again.";
    flHost.appendChild(again);
  }
}
initFlags();

// behold#931: the Repos tab of an org-level workspace. One entry per repo
// member: its URL and pinned revision, then the members of that repository's
// workspace with each one's status and reason, from /api/workspace/repos (one
// chant workspace graph). A failed fetch shows chant's reason as given.
let orgHost = null;
let orgRead = false;
async function initOrgRepos() {
  if (staticMode || publicMode) return; // /api/workspace/* is refused in a public view
  const project = await apiFetch("/api/project").then((r) => r.json()).catch(() => ({}));
  if (!project.workspace || !project.workspace.org) return;
  orgHost = addPanelTab("repos", "Repos", "The repositories this org workspace names, each with its pinned revision and the members of its workspace. Read from chant when you open the tab.");
  if (!orgHost) return;
  orgHost.id = "tab-repos";
  const tab = document.querySelector('#panel-tabs button[data-tab="repos"]');
  if (tab) tab.addEventListener("click", () => orgRead || loadOrgRepos());
  if (orgHost.classList.contains("active")) loadOrgRepos();
}
async function loadOrgRepos() {
  orgRead = true;
  const reading = document.createElement("div");
  reading.className = "tg-legend";
  reading.textContent = "reading the repositories from chant (it fetches each pinned revision)";
  orgHost.replaceChildren(reading);
  const answer = await apiFetch("/api/workspace/repos")
    .then((r) => r.json())
    .catch((e) => ({ error: String(e) }));
  renderOrgRepos(answer);
}
function renderOrgRepos(answer) {
  orgHost.replaceChildren();
  const line = (cls, text, title, host = orgHost) => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    if (title) d.title = title;
    host.appendChild(d);
    return d;
  };
  if (answer.error || answer.refusal) {
    const r = answer.refusal || { error: answer.error, remedy: "" };
    line("tg-refusal", [r.error, r.remedy].filter(Boolean).join(" "));
    if (answer.degraded) line("tg-legend", "Without it, " + answer.degraded + ".");
    return;
  }
  line("fl-title", answer.repos.length + " repositor" + (answer.repos.length === 1 ? "y" : "ies") + (answer.repo ? " in " + answer.repo : ""));
  for (const r of answer.repos) {
    const box = document.createElement("div");
    box.className = "fl-flag";
    line("fl-flag-title", r.name + " · " + r.url + " @ " + r.rev.slice(0, 12), r.rev, box);
    line("fl-facts", (r.workspaceName ? "workspace " + r.workspaceName + " · " : "") + (r.read ? "read as " + r.read + " · " : "") + r.status, "", box);
    if (r.reason) line("tg-refusal", r.reason.code + ": " + r.reason.message, "", box);
    for (const m of r.members) {
      line("fl-facts", m.name + " (" + m.kind + ") " + m.status + (m.reason ? " · " + m.reason.code + ": " + m.reason.message : ""), "", box);
    }
    orgHost.appendChild(box);
  }
  if (!staticMode) {
    const again = button("Read again", "", () => loadOrgRepos());
    again.title = "Fetch and read every repository's pinned revision again.";
    orgHost.appendChild(again);
  }
}
initOrgRepos();

// --- #684: collision marks, nodes touched by two in-flight work items --------
// The Collisions tab reads /api/workspace/collisions when it is opened: the
// in-flight work items chant reports (workspace status overlap, chant#4025),
// the nodes two of them reach through a waiting gate's change set (a ring and
// a tag on each card), and on the side the files they both changed, which
// have no node. The filter keeps only colliding work: the other cards and the
// edges that touch them are hidden. behold records and locks nothing.
let coAnswer = null;
let coOn = true;
let coOnly = false;
let coHost = null;
let coRead = false;
async function initCollisions() {
  if (staticMode || publicMode) return; // /api/workspace/* is refused in a public view
  const project = await apiFetch("/api/project").then((r) => r.json()).catch(() => ({}));
  if (!project.workspace) return;
  coHost = addPanelTab("collisions", "Collisions", "In-flight work items that touch the same resource, marked on the graph. Read from chant when you open the tab.");
  if (!coHost) return;
  coHost.id = "tab-collisions";
  const tab = document.querySelector('#panel-tabs button[data-tab="collisions"]');
  if (tab) tab.addEventListener("click", () => coRead || loadCollisions());
  if (coHost.classList.contains("active")) loadCollisions();
}
async function loadCollisions() {
  coRead = true;
  const reading = document.createElement("div");
  reading.className = "tg-legend";
  reading.textContent = "reading the work overlap from chant";
  coHost.replaceChildren(reading);
  coAnswer = await apiFetch("/api/workspace/collisions")
    .then((r) => r.json())
    .catch((e) => ({ error: String(e) }));
  markCollisionCards();
}
function markCollisionCards() {
  const svg = document.querySelector("#graph svg");
  if (svg) {
    for (const old of svg.querySelectorAll("[data-co-mark]")) old.remove();
    for (const h of svg.querySelectorAll("[data-co-hidden]")) {
      h.removeAttribute("data-co-hidden");
      h.style.display = "";
    }
    if (coAnswer && coOn) {
      const ids = [...svg.querySelectorAll("[data-node-id]")].map((g) => g.getAttribute("data-node-id"));
      for (const [id, m] of Object.entries(coMarks(coAnswer, ids))) {
        const g = svg.querySelector('[data-node-id="' + CSS.escape(id) + '"]');
        if (!g) continue;
        const rect = g.querySelector("rect");
        const box = rect && rect.getBBox ? rect.getBBox() : { x: 0, y: 0, width: 150, height: 60 };
        const ring = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        ring.setAttribute("data-co-mark", "ring");
        ring.setAttribute("x", String(box.x - 3));
        ring.setAttribute("y", String(box.y - 3));
        ring.setAttribute("width", String(box.width + 6));
        ring.setAttribute("height", String(box.height + 6));
        ring.setAttribute("rx", "8");
        ring.setAttribute("fill", "none");
        ring.setAttribute("stroke", m.color);
        ring.setAttribute("stroke-width", "2");
        ring.setAttribute("stroke-dasharray", "5 3");
        ring.setAttribute("pointer-events", "none");
        const tag = document.createElementNS("http://www.w3.org/2000/svg", "text");
        tag.setAttribute("data-co-mark", "tag");
        tag.setAttribute("x", String(box.x));
        tag.setAttribute("y", String(box.y + box.height + 26));
        tag.setAttribute("font-size", "11");
        tag.setAttribute("font-weight", "700");
        tag.setAttribute("fill", m.color);
        tag.textContent = m.tag;
        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.setAttribute("data-co-mark", "title");
        title.textContent = m.title;
        tag.appendChild(title);
        g.append(ring, tag);
      }
      if (coOnly) {
        for (const id of coFilter(coAnswer, ids, true).hide) {
          const g = svg.querySelector('[data-node-id="' + CSS.escape(id) + '"]');
          if (g) {
            g.setAttribute("data-co-hidden", "true");
            g.style.display = "none";
          }
        }
        for (const e of svg.querySelectorAll("g[data-edge-from]")) {
          if (!coHideEdge(coAnswer, e.getAttribute("data-edge-from"), e.getAttribute("data-edge-to"), true)) continue;
          e.setAttribute("data-co-hidden", "true");
          e.style.display = "none";
        }
      }
    }
  }
  renderCollisionsTab();
}
function renderCollisionsTab() {
  if (!coHost) return;
  coHost.replaceChildren();
  const line = (cls, text, title, host = coHost) => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    if (title) d.title = title;
    host.appendChild(d);
    return d;
  };
  const h = coHeader(coAnswer);
  line(h.tone === "refusal" ? "tg-refusal" : "fl-title", h.text, h.title);
  const refused = !coAnswer || coAnswer.error || coAnswer.refusal;
  if (refused && coAnswer && coAnswer.degraded) line("tg-legend", `Without it, ${coAnswer.degraded}.`);
  if (!refused) {
    for (const g of coGapLines(coAnswer)) line("tg-legend", g.text, g.title);
    const filter = button(coOnly ? CO_FILTER_ON : CO_FILTER_OFF, "", () => {
      coOnly = !coOnly;
      markCollisionCards();
    });
    filter.setAttribute("aria-pressed", String(coOnly));
    filter.title = coOnly ? "Draw every card and every work item again." : "Hide the cards that no two work items touch, and the work items that collide with none.";
    coHost.appendChild(filter);
    const toggle = button(coOn ? "Turn off the marks" : "Turn on the marks", "", () => {
      coOn = !coOn;
      markCollisionCards();
    });
    toggle.title = coOn ? "Remove the collision marks from the graph. The tab keeps the work items." : "Mark the colliding cards on the graph again.";
    coHost.appendChild(toggle);
    const ids = [...document.querySelectorAll("#graph svg [data-node-id]")].map((g) => g.getAttribute("data-node-id"));
    const shown = coFilter(coAnswer, ids, coOnly);
    if (shown.nodes.length) {
      line("fl-title", "nodes touched by two or more work items", CO_NOTE);
      for (const n of shown.nodes.map(coNodeRow)) line("fl-facts", n.text, n.title);
    }
    const side = coSideLines(coAnswer);
    if (side.length) {
      line("fl-title", "no graph node", CO_FILES_NOTE);
      for (const s of side) line("fl-facts", s.text, s.title);
    }
    if (!shown.items.length) line("tg-legend", coOnly ? "no work item collides with another" : "no in-flight work item has a linked commit");
    for (const i of shown.items.map(coItemRow)) {
      const box = document.createElement("div");
      box.className = "fl-flag";
      line("fl-flag-title", i.title, "", box);
      line("fl-facts", i.facts, "", box);
      line(i.colliding ? "fl-stale" : "fl-facts", i.with, "", box);
      coHost.appendChild(box);
    }
  }
  if (!staticMode) {
    const again = button("Read again", "", () => loadCollisions());
    again.title = "Read the work overlap from chant again.";
    coHost.appendChild(again);
  }
}
initCollisions();

// --- #825: runtime health and rotation ---------------------------------------
// When the graph shows an environment, /api/health is read once for it (a
// static export replays the captured snapshot): per card that has a health
// read, healthy, unhealthy or unknown from `chant lifecycle health`, or a hole
// with chant's reason when the read failed; and per Route 53 record whose
// HealthCheckId names a declared check, its rotation. Health never touches a
// card's fill, which stays the drift overlay's. A tag under the card says the
// state, an unhealthy card gets a solid ring and a hole a dashed one, and a
// record out of rotation is dimmed with its edges. "Re-check live" reads it
// again with ?fresh=1.
let hmAnswer = null;
let hmLoading = null;
function syncHealth(m) {
  // `progressive` is the overlay while members are still reading (#422).
  const drift = !!m && !!m.env && ["overlay", "progressive", "logical"].includes(m.mode);
  if (!drift || publicMode) {
    markHealthCards(null);
    return;
  }
  if (hmAnswer && hmAnswer.env === m.env) {
    markHealthCards(hmAnswer);
    return;
  }
  loadHealth(m.env, false);
}
async function loadHealth(env, fresh) {
  if (publicMode) return;
  if (hmLoading === env && !fresh) return;
  hmLoading = env;
  const answer = await apiFetch(`/api/health?env=${encodeURIComponent(env)}${fresh ? "&fresh=1" : ""}`)
    .then((r) => r.json())
    .catch((e) => ({ error: String(e) }));
  if (hmLoading !== env) return; // a newer env was asked for meanwhile
  hmLoading = null;
  hmAnswer = { ...answer, env };
  if (view.env === env) {
    markHealthCards(hmAnswer);
    renderPanel();
    renderGraphLegend();
  }
}
function markHealthCards(a) {
  const svg = document.querySelector("#graph svg");
  if (!svg) return;
  for (const old of svg.querySelectorAll("[data-hm-mark]")) old.remove();
  for (const d of svg.querySelectorAll("[data-hm-dim]")) {
    d.removeAttribute("data-hm-dim");
    d.style.opacity = "";
  }
  if (!a) return;
  const ids = [...svg.querySelectorAll("[data-node-id]")].map((g) => g.getAttribute("data-node-id"));
  for (const [id, mk] of Object.entries(hmMarks(a, ids))) {
    const g = svg.querySelector('[data-node-id="' + CSS.escape(id) + '"]');
    if (!g) continue;
    const rect = g.querySelector("rect");
    const box = rect && rect.getBBox ? rect.getBBox() : { x: 0, y: 0, width: 150, height: 60 };
    if (mk.ring) {
      const ring = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      ring.setAttribute("data-hm-mark", "ring");
      for (const [k, v] of Object.entries({ x: box.x - 3, y: box.y - 3, width: box.width + 6, height: box.height + 6, rx: 8, fill: "none", stroke: mk.color, "stroke-width": 2, "pointer-events": "none" })) ring.setAttribute(k, String(v));
      if (mk.ring === "dashed") ring.setAttribute("stroke-dasharray", "4 4");
      g.appendChild(ring);
    }
    const tag = document.createElementNS("http://www.w3.org/2000/svg", "text");
    tag.setAttribute("data-hm-mark", "tag");
    tag.setAttribute("x", String(box.x));
    // Under the card, where the flag tag sits (#683): above it, a card in a
    // box's top row would run into the box's own header.
    tag.setAttribute("y", String(box.y + box.height + 13));
    tag.setAttribute("font-size", "11");
    tag.setAttribute("font-weight", "700");
    tag.setAttribute("fill", mk.color);
    tag.textContent = `● ${mk.tag}`;
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = mk.title;
    tag.appendChild(title);
    g.appendChild(tag);
    if (mk.dim) {
      // The card and its own text go faint; the tag under it stays legible.
      for (const child of g.children) {
        if (child.hasAttribute("data-hm-mark")) continue;
        child.setAttribute("data-hm-dim", "1");
        child.style.opacity = "0.35";
      }
    }
  }
  for (const e of svg.querySelectorAll("g[data-edge-from]")) {
    if (!hmDimEdge(a, e.getAttribute("data-edge-from"), e.getAttribute("data-edge-to"))) continue;
    e.setAttribute("data-hm-dim", "1");
    e.style.opacity = "0.25";
  }
}
/** The Model tab's health legend, under the drift legend. */
function renderHealthLegend(host) {
  if (!hmAnswer || hmAnswer.env !== view.env || publicMode) return;
  const h = hmHeader(hmAnswer);
  const heading = panelHeading(h.text);
  heading.title = h.title || HM_NOTE;
  if (h.tone === "refusal") heading.style.color = "var(--degraded)";
  host.appendChild(heading);
  for (const r of hmLegendRows(hmAnswer)) host.appendChild(panelDotRow(r.color, r.text, r.count));
  for (const [id, r] of Object.entries(hmAnswer.rotation || {})) {
    if (r.inRotation !== false) continue;
    host.appendChild(panelDotRow("var(--degraded)", id, "out of rotation", () => selectNode(id)));
  }
  for (const l of hmMemberLines(hmAnswer)) {
    const p = panelMuted(l.text);
    p.title = l.title;
    host.appendChild(p);
  }
}

// --- #681: a waiting gate's change set, on the graph -------------------------
// Opened from a gate card's "change set" link in the Trunk tab. The server
// reads the gate from status and the stored change set from chant change-set
// show; the page draws each entry's node with an outline and a tag above the
// card, in the drift legend's colours, and lists the entries chant mapped to
// no node, or whose node this view does not draw, in the Change set tab. The
// fill stays the live-status channel. Turning the overlay off removes the
// marks; the tab keeps the change set until another one is opened.
let csAnswer = null;
let csOn = true;
let csHost = null;
let csAsk = null; // {key, env}: what "Read again" reads
function openChangeSet(key, env) {
  csAsk = { key, env };
  csOn = true;
  if (!csHost) {
    csHost = addPanelTab("change-set", "Change set", "A waiting gate's change set, drawn on the graph as a preview: what approving the gate lets chant create, change or delete.");
    if (!csHost) return;
    csHost.id = "tab-change-set";
  }
  setPanelTab("change-set");
  loadChangeSet();
}
async function loadChangeSet() {
  if (!csAsk || !csHost) return;
  const reading = document.createElement("div");
  reading.className = "tg-legend";
  reading.textContent = "reading the change set from chant";
  csHost.replaceChildren(reading);
  const q = new URLSearchParams({ gate: csAsk.key, env: csAsk.env });
  csAnswer = await apiFetch(`/api/workspace/change-set?${q}`)
    .then((r) => r.json())
    .catch((e) => ({ error: String(e) }));
  markChangeSetCards();
}
/** The node ids the graph draws now. */
function drawnNodeIds() {
  const svg = document.querySelector("#graph svg");
  return new Set(svg ? [...svg.querySelectorAll("[data-node-id]")].map((g) => g.getAttribute("data-node-id")) : []);
}
function markChangeSetCards() {
  const svg = document.querySelector("#graph svg");
  if (svg) {
    for (const old of svg.querySelectorAll("[data-cs-mark]")) old.remove();
    if (csAnswer && csOn) {
      for (const [id, m] of Object.entries(csNodeMarks(csAnswer))) {
        const g = svg.querySelector('[data-node-id="' + CSS.escape(id) + '"]');
        if (!g) continue;
        const rect = g.querySelector("rect");
        const box = rect && rect.getBBox ? rect.getBBox() : { x: 0, y: 0, width: 150, height: 60 };
        const ring = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        ring.setAttribute("data-cs-mark", "ring");
        for (const [k, v] of Object.entries({ x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8, rx: 8, fill: "none", stroke: m.color, "stroke-width": 3, "pointer-events": "none" })) ring.setAttribute(k, String(v));
        const tag = document.createElementNS("http://www.w3.org/2000/svg", "text");
        tag.setAttribute("data-cs-mark", "tag");
        tag.setAttribute("x", String(box.x));
        tag.setAttribute("y", String(box.y - 9));
        tag.setAttribute("font-size", "11");
        tag.setAttribute("font-weight", "700");
        tag.setAttribute("fill", m.color);
        tag.textContent = m.tag;
        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.setAttribute("data-cs-mark", "title");
        title.textContent = m.title;
        g.append(ring, tag, title);
      }
    }
  }
  renderChangeSetTab();
}
function csEntryEl(e) {
  const row = document.createElement("div");
  row.className = "cs-entry";
  row.style.setProperty("--bar", barVarFor(e.color));
  const head = document.createElement("div");
  head.className = "cs-entry-head";
  head.textContent = e.node ? `${e.head} · ${e.node}` : e.head;
  row.appendChild(head);
  if (e.facts) {
    const f = document.createElement("div");
    f.className = "cs-entry-facts";
    f.textContent = e.facts;
    row.appendChild(f);
  }
  for (const line of e.fields) {
    const f = document.createElement("div");
    f.className = "cs-entry-field";
    f.textContent = line;
    row.appendChild(f);
  }
  return row;
}
function renderChangeSetTab() {
  if (!csHost || !csAsk) return;
  csHost.replaceChildren();
  const line = (cls, text, title) => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    if (title) d.title = title;
    csHost.appendChild(d);
    return d;
  };
  const h = csHeader(csAnswer);
  h.lines.forEach((t, i) => line(h.tone === "refusal" ? "tg-refusal" : i ? "tg-legend" : "cs-title", t, h.title));
  const refused = !csAnswer || csAnswer.error || csAnswer.refusal;
  if (!refused) {
    line("tg-legend", CS_PREVIEW_NOTE);
    for (const r of csLegend(csAnswer)) {
      const row = panelDotRow(r.color, r.label, String(r.count));
      row.title = r.title;
      csHost.appendChild(row);
    }
    for (const g of csGapLines(csAnswer)) line("tg-refusal", g.text, g.title);
    const toggle = button(csOn ? "Turn off the overlay" : "Turn on the overlay", "", () => {
      csOn = !csOn;
      markChangeSetCards();
    });
    toggle.title = csOn ? "Remove the change set's marks from the graph. The tab keeps it." : "Draw the change set's marks on the graph again.";
    csHost.appendChild(toggle);
    const marks = csNodeMarks(csAnswer);
    const drawn = drawnNodeIds();
    const ids = Object.keys(marks).filter((id) => drawn.has(id));
    if (ids.length) {
      csHost.appendChild(panelHeading("on the graph"));
      for (const id of ids) csHost.appendChild(panelDotRow(marks[id].color, id, marks[id].tag, () => selectNode(id)));
    }
    const off = csOffGraph(csAnswer, drawn);
    if (off.noNode.length) {
      const hd = panelHeading("not on the graph");
      hd.title = "chant mapped these entries to no graph node, such as a delete of a block the planning commit no longer declares.";
      csHost.appendChild(hd);
      for (const e of off.noNode) csHost.appendChild(csEntryEl(e));
    }
    if (off.notDrawn.length) {
      const hd = panelHeading("not in this view");
      hd.title = "Their nodes are not drawn in the current view. Switch to the workspace graph to see them.";
      csHost.appendChild(hd);
      for (const e of off.notDrawn) csHost.appendChild(csEntryEl(e));
    }
    if (!csAnswer.entries.length) line("tg-legend", "this change set changes nothing");
  }
  if (!staticMode) {
    const again = button("Read again", "", () => loadChangeSet());
    again.title = "Read the gate and its change set from chant again.";
    csHost.appendChild(again);
  }
}


// --- #526: SQL Yodeler's report and drift, from files ------------------------
// /api/yodel-report reads `yodel report --json` and drift JSON the person or
// their pipeline wrote, checked against SQL Yodeler's schemas. Drift marks are
// dated corner tags on the cards they name; environments and gaps go in the
// panel. Nothing is live, and behold never runs yodel.
let yrAnswer = null;
let yrJoined = null;
let yrHost = null;
async function initYodelReport() {
  const project = await apiFetch("/api/project").then((r) => r.json()).catch(() => ({}));
  if (!project.yodelReport) return;
  await loadYodelReport();
}
async function loadYodelReport() {
  yrAnswer = await apiFetch("/api/yodel-report")
    .then((r) => r.json())
    .catch((e) => ({ error: String(e), code: "yodel-report", remedy: "" }));
  markYodelCards();
}
function markYodelCards() {
  if (!yrAnswer) return;
  const svg = document.querySelector("#graph svg");
  if (svg) {
    for (const old of svg.querySelectorAll("[data-yr-mark]")) old.remove();
    const ids = [...svg.querySelectorAll("[data-node-id]")].map((g) => g.getAttribute("data-node-id"));
    yrJoined = yrAnswer.error ? null : yrJoin(yrAnswer, ids);
    const now = new Date();
    for (const [id, marks] of Object.entries(yrJoined ? yrJoined.cards : {})) {
      const g = svg.querySelector('[data-node-id="' + CSS.escape(id) + '"]');
      if (!g) continue;
      const rect = g.querySelector("rect");
      const box = rect && rect.getBBox ? rect.getBBox() : null;
      const tag = document.createElementNS("http://www.w3.org/2000/svg", "text");
      tag.setAttribute("data-yr-mark", "1");
      tag.setAttribute("x", String((box ? box.x + box.width : 150) - 10));
      tag.setAttribute("y", String((box ? box.y : 0) + 14));
      tag.setAttribute("text-anchor", "end");
      tag.setAttribute("font-size", "11");
      tag.setAttribute("font-weight", "600");
      tag.setAttribute("fill", "var(--degraded)");
      tag.textContent = yrCorner(marks, now);
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.setAttribute("data-yr-mark", "title");
      title.textContent = marks.map((m) => yrMarkLine(m, now)).join("\n") + "\n(from SQL Yodeler drift files, not live)";
      g.append(title, tag);
    }
  }
  renderYodelPanel();
}
function renderYodelPanel() {
  if (!yrHost) {
    yrHost = addPanelTab("yodel", "SQL Yodeler", "SQL Yodeler's report and drift, read from files: each environment's applied migrations and gaps, dated. Not live.");
    if (!yrHost) return;
    yrHost.id = "tab-yodel";
  }
  const host = yrHost;
  host.replaceChildren();
  const a = yrAnswer;
  const line = (cls, text, title) => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    if (title) d.title = title;
    host.appendChild(d);
    return d;
  };
  if (!a || a.error) {
    line("tg-refusal", a ? `${a.code}: ${a.error}` : "SQL Yodeler report not read");
    if (a && a.remedy) line("tg-legend", a.remedy);
    return;
  }
  const now = new Date();
  const lg = yrLegend(a, now);
  line("tg-legend", lg.text, lg.title);
  for (const e of a.environments) {
    const h = document.createElement("h3");
    h.textContent = e.op ? `${e.name} (op ${e.op.name}, gate ${e.op.gate})` : e.name;
    host.appendChild(h);
    for (const t of yrEnvLines(e, now)) line("tg-inspect", t);
    line("tg-legend", `from ${yrDated(e.dated, now)}`);
    drawAudit((a.audit || []).filter((x) => x.environment === e.name));
  }
  // #537: audit entries for an environment the report lists no row for.
  const named = new Set(a.environments.map((e) => e.name));
  const loose = (a.audit || []).filter((x) => !named.has(x.environment));
  if (loose.length) {
    const h = document.createElement("h3");
    h.textContent = "audit, environments the report lists no row for";
    host.appendChild(h);
    drawAudit(loose, true);
  }
  function drawAudit(entries, withEnv = false) {
    if (!entries.length) return;
    const sub = document.createElement("div");
    sub.className = "tg-legend";
    sub.textContent = `audit, ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, oldest first`;
    host.appendChild(sub);
    for (const x of entries) {
      const l = yrAuditLines(x, now);
      line("tg-inspect", withEnv ? `${x.environment}: ${l.text}` : l.text, l.source);
      line("tg-legend", l.source);
    }
  }
  for (const d of a.drift) {
    const h = document.createElement("h3");
    h.textContent = `${d.environment} drift`;
    host.appendChild(h);
    line("tg-inspect", d.drifted ? `${d.changed} changed, ${d.missing} missing` : "no drift in what could be read");
    for (const u of d.unobserved) line("tg-inspect", `not read: ${u.name}${u.reason ? ` (${u.reason})` : ""}`);
    line("tg-legend", `from ${yrDated(d.dated, now)}${d.server ? ` · ${d.server}` : ""}`);
  }
  const unmatched = (yrJoined && yrJoined.unmatched) || [];
  if (unmatched.length) {
    const h = document.createElement("h3");
    h.textContent = "drift on no card";
    host.appendChild(h);
    for (const m of unmatched) line("tg-inspect", `${m.object}: ${yrMarkLine(m, now)}`);
  }
  if (a.ignored.length) line("tg-legend", `not read (neither a report nor drift): ${a.ignored.join(", ")}`);
  if (!staticMode) host.appendChild(button("Read the files again", "", () => loadYodelReport()));
}
initYodelReport();

// --- #524: a SQL Yodeler repo's lane over chant/lifecycle -------------------
// /api/sql-yodeler/lifecycle: each environment's wave gate and migrations-op
// gate, in the order of applies, with the approve line to copy. Below it,
// the gate ledgers' history (#522). Read-only and dated; never live.
let ylHost = null;
async function initYodelLane() {
  if (publicMode) return; // #569: /api/sql-yodeler/lifecycle is refused in a public view
  // #537: a static export carries the lane as a snapshot (src/export.ts), so it draws here too.
  const project = await apiFetch("/api/project").then((r) => r.json()).catch(() => ({}));
  if (!project.sqlYodeler) return;
  await loadYodelLane();
}
async function loadYodelLane({ fresh = false } = {}) {
  const q = fresh ? "?fresh=1" : "";
  const [lane, history] = await Promise.all([
    apiFetch(`/api/sql-yodeler/lifecycle${q}`).then((r) => r.json()).catch((e) => ({ error: String(e) })),
    apiFetch(`/api/lifecycle/history${q}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (!ylHost) {
    ylHost = addPanelTab("yodel-lane", "Pipeline", "SQL Yodeler's gates on chant/lifecycle: each environment's wave and migrations op, in the order of applies, dated. Not live.");
    if (!ylHost) return;
    ylHost.id = "tab-yodel-lane";
  }
  ylHost.replaceChildren();
  renderYodelLane(ylHost, lane, new Date(), { button, copy: copyToClipboard, link: tgLink });
  if (history) ylHost.appendChild(tgHistoryLane(history));
  if (staticMode) return;
  const again = button("Read again", "", () => loadYodelLane({ fresh: true }));
  again.title = "Fetch chant/lifecycle again and redraw.";
  ylHost.appendChild(again);
}
initYodelLane();
// #509: a control repo draws its projects from estate.json and their run views.
initTerragucciEstate({ fetchUrl: apiFetch, copy: copyToClipboard });

function renderPanelCarve() {
  if (!carveMode()) return;
  if (!carveHost) {
    carveHost = addPanelTab("carve", "Carve", "The peel walkthrough: advise → pick → emit → bridge → handoff → done.");
    if (!carveHost) return;
    carveHost.id = "tab-carve";
  }
  renderCarvePanel(
    carveHost,
    carveState,
    { carve: carveInfo, demo: carveInfo && carveInfo.demo, report: carveReport, renderJson },
    carveActions,
  );
}

/** Carve mode's one extra fetch: the raw report, for the per-resource boundary
 * lists the graph IR deliberately doesn't carry. Best-effort — the stepper
 * degrades to the counts in the IR's own attrs. */
async function loadCarveReport() {
  if (!carveMode()) return;
  try {
    carveReport = await apiFetch("/api/carve").then((r) => r.json());
  } catch {
    carveReport = null;
  }
  renderPanelCarve();
  // A readiness marker, so a test can wait for the extra fetch instead of
  // racing it. The panel itself never waits: `cutSummary` falls back to the
  // counts the IR node already carries, which is what the report would have
  // told it anyway on a chant that publishes no edge lists.
  if (carveHost) carveHost.dataset.report = carveReport ? "1" : "0";
}

function renderPanel() {
  renderPanelView();
  renderPanelScope();
  renderPanelModel();
  if (carveMode()) renderPanelCarve();
}

function renderStatusbar() {
  renderPanel();
  const el = document.getElementById("statusbar");
  if (!el) return;
  // The strip looks clickable whether or not it is, so make it act like it:
  // clicking opens the palette rather than doing nothing.
  if (!el.dataset.clickable) {
    el.dataset.clickable = "1";
    el.style.cursor = "pointer";
    el.title = "zoom · env · stack · tier — change on the panel, or ⌘K";
    el.addEventListener("click", () => openPalette());
  }
  // Pure state — the strip echoes the axes whose controls live on the floating
  // panel and in ⌘K, so the current view stays legible with the panel collapsed.
  const parts = [`zoom: ${zoomValue()}`, view.env ? `env: ${view.env}` : "env: (source)"];
  if (view.member) parts.unshift(`member: ${view.member}`);
  // #399: which colour the graph is in is state, not a control, so it belongs
  // on the strip the same way the zoom and the env do. Only when it is not
  // drift — drift is what the strip has always implied.
  if (activeColourMode() !== "drift") parts.push(`color: ${activeColourMode()}`);
  if (view.stack) parts.push(`stack: ${view.stack}`);
  if (axes.tier) parts.push(`tier: ${axes.tier}`);
  if (view.radial && !view.components && !view.logical && !view.ops) parts.push("radial");
  // #422: what the picture is still waiting on, while it is waiting. Ahead of
  // the zoom note, because a half-read estate is the more urgent fact about
  // what is on screen.
  const stillReading = pendingLine(pendingMembers, pendingTotal);
  if (stillReading) parts.push(stillReading);
  el.textContent = parts.join(" · ");
  syncViewUrl();
  // #477: gates don't wait on the graph (a member that fails to draw can still
  // have a gate waiting). Re-read only when the env moved; `changed` forces it.
  if (projectInfo) loadWorkspaceGates();
  // #131: why this level rendered empty, or as the one below it. The server
  // decides (src/zoom-notes.ts) — the SPA never infers it, so the note always
  // describes the graph that actually came back. Appended rather than mixed
  // into `parts` so it can carry its own emphasis without the zoom/env strip
  // changing shape when there is nothing to say.
  if (lastNote) {
    const note = document.createElement("span");
    note.className = "statusbar-note";
    // #393 item 7: the strip is a strip. A Terraform estate's note names every
    // root, every skipped directory with its reason, and every block class the
    // zoom left out — ~60 words, in a 260px panel, at every zoom. The server
    // sends the short form beside the long one (`meta.noteShort`) when it has
    // one; the full text stays one hover away here and is printed in full on
    // the panel's Model tab. Nothing is truncated client-side: the SPA does not
    // write notes, and a note with no short form is already a line.
    note.textContent = " — " + (lastNoteShort || lastNote);
    if (lastNoteShort) note.title = lastNote;
    el.appendChild(note);
  }
}

// The note from the last /api/graph or /api/overlay response (`meta.note`),
// or null. Set on every load so a level that stops degrading stops explaining
// itself.
let lastNote = null;
// #393 item 7: the same note as the strip can hold (`meta.noteShort`), or null
// when the long one already fits. Never derived here — see renderStatusbar().
let lastNoteShort = null;

// The `meta` of the last rendered graph — the panel's Model tab reads its
// mode/env to pick the status vocabulary (drift vs component live status).
let lastMeta = null;

// The deploy axes as currently displayed in the header (#59 unify, M2 #54
// lenses) — seeded once from /api/project (server-derived from the process
// env at launch; see deployAxes() in src/server.ts), then kept in sync with
// whatever the last /api/graph response actually observed (its `meta.tier`/
// `meta.target`, since a picked lens can differ from the launch-time default).
let axes = { tier: null, target: null };

// Query params for the tier/target lenses (M2, #54) — shared by every fetch
// this page makes, so picking a lens re-parameterizes the component graph,
// its CI/resources facets, and the reconcile summary all the same way.
// stack (#76) rides along too — server.ts's `optsFromQuery` parses `?stack=`
// the same way, but only `graphPath`'s callers (the graph/overlay fetches in
// load()) actually consult it; the CI/resources/reconcile facets don't take a
// source path at all, so they ignore an extra `stack=` harmlessly.
function lensParams(params) {
  if (view.tier) params.set("tier", view.tier);
  if (view.target) params.set("target", view.target);
  if (view.stack) params.set("stack", view.stack);
  return params;
}

// CI projection facet (M1.2, #58): the component DAG's GitLab CI reading —
// component name → {jobName, stage, needs, script}, from `/api/ci` (`chant
// build --components --generate gitlab`). Loaded once per components-mode
// load() and cached here so inspect() (fired per click, not per fetch) reads
// it synchronously. Component-DAG mode only — cleared otherwise.
let ciByComponent = new Map();
let ciForge = null; // the forge the pipeline was generated for (#164) — heads the inspect section
// #571: the served repo declares its components in terragucci.components.json.
// Its CI and resources facets then ride the components graph response
// (`meta.terragucciComponents`, see takeTerragucciFacets), which a public view
// can read, so the two facet fetches below are skipped.
let terragucciComponentsRepo = false;
/**
 * behold#741: the kiosk's word that the scenario it shows carries chapters (demo.json's step `chapter`), with the
 * cycle: `{ on, cycle }` from a `behold:story` message, null until one comes. Only a kiosk frame (bare) of a
 * terragucci repo's components zoom acts on it; b-waves, failure and tg-planned-outputs send `on: false`.
 * behold#743: `outside` too, the step's apply made outside the pipeline (demo.json's), or null.
 */
let tgStory = null;
function tgStoryOn() {
  return !!(embedOpts.bare && tgStory && tgStory.on && terragucciComponentsRepo);
}
// behold#741: what landed in this cycle's earlier apply, and what its failure left, for the next pull request's cards.
let tgStoryEarlier = { cycle: null, earlier: new Set(), lastStates: {} };
function tgStoryMarks() {
  if (!tgStoryOn() || !view.components) return null;
  if (tgStoryEarlier.cycle !== tgStory.cycle || view.run === "base") tgStoryEarlier = { cycle: tgStory.cycle, earlier: new Set(), lastStates: {} };
  return { kiosk: true, earlier: tgStoryEarlier.earlier, lastStates: tgStoryEarlier.lastStates };
}
/** Keep what an apply's cards say: applied roots land in `earlier`; a failed or blocked one keeps that state until it applies. */
function tgStoryRemember(marks) {
  if (!marks || marks.stage !== "apply") return;
  for (const c of Object.values(marks.cards)) {
    if (c.state === "applied") {
      tgStoryEarlier.earlier.add(c.root);
      delete tgStoryEarlier.lastStates[c.root];
    } else if (c.state === "failed" || c.state === "blocked") tgStoryEarlier.lastStates[c.root] = { state: c.state, words: c.words, ...(c.blockedBy ? { blockedBy: c.blockedBy } : {}) };
  }
}
// behold#741: the run view's waves at the pace chant's are played (web/terragucci-live-pace.js), while the story is on.
const tgPacer = createProgressPacer();
let tgPaceTimer = null;
function tgPacedProgress() {
  const p = tgPacer.progress(tgProgress);
  if (tgPacer.pending && !tgPaceTimer) {
    let was = JSON.stringify(p && p.states);
    tgPaceTimer = setInterval(() => {
      const next = tgPacer.progress(tgProgress);
      const now = JSON.stringify(next && next.states);
      if (now !== was) {
        was = now;
        drawTgReads();
      }
      if (!tgPacer.pending) {
        clearInterval(tgPaceTimer);
        tgPaceTimer = null;
      }
    }, 400);
  }
  return p;
}
// #571: the components graph's facets (jobs, component -> root), for the live marks drawTgReads puts on it.
let tgComponentFacets = null;
// behold#631: a chant repo's pull-request loop: the graph's `meta.chantPr` and /api/chant/pr's answer at the view's run pin.
let chantFacets = null;
let chantPrAnswer = null;
let chantPrTimer = null;
/** Whether /api/chant/pr has answered (or failed) once since the components view drew, so a kiosk frame swaps in with its marks on. */
let chantPrRead = false;
// behold#631: a fast apply played at a pace a viewer can follow (web/chant-live-pace.js).
const chantPacer = createLivePacer();
let chantPaceTimer = null;
let chantPacedWas = null;
/** The answer as the pacer shows it now; while it is behind the stream, redraw as it plays. */
function chantPaced() {
  const a = chantPacer.answer(chantPrAnswer);
  chantPacedWas = JSON.stringify(a && a.live ? a.live.apply : null);
  if (chantPacer.pending && !chantPaceTimer) {
    chantPaceTimer = setInterval(() => {
      const next = chantPacer.answer(chantPrAnswer);
      const was = chantPacedWas;
      if (JSON.stringify(next && next.live ? next.live.apply : null) !== was) drawTgReads();
      if (!chantPacer.pending) {
        clearInterval(chantPaceTimer);
        chantPaceTimer = null;
      }
    }, 400);
  }
  return a;
}
function chantPrDrawn() {
  return !!(view.components && chantFacets && !terragucciComponentsRepo && chantPrAnswer && !chantPrAnswer.error && chantPrAnswer.loop);
}
async function loadChantPr() {
  const pin = view.run || "";
  const was = JSON.stringify(chantPrAnswer);
  let answer = await apiFetch(`/api/chant/pr${pin ? `?pin=${encodeURIComponent(pin)}` : ""}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if ((view.run || "") !== pin) return; // the pin moved while this read ran
  // behold#631: at the merge, before the apply's run is listed, the merge commit names no pull request yet and the
  // answer comes back empty: the cards keep the plan they had until the apply's own records replace it.
  const nothing = (a) => a && !a.error && !a.plan && !a.apply && !a.running && !(a.live && (a.live.apply || a.live.plan));
  if (nothing(answer) && chantPrAnswer && chantPrAnswer.plan && pin && pin !== "base" && pin !== "none" && !/^pull/.test(pin)) answer = { ...answer, pull: chantPrAnswer.pull, plan: chantPrAnswer.plan, gate: chantPrAnswer.gate, ...(chantPrAnswer.live ? { live: { ...chantPrAnswer.live, apply: null, plan: null } } : {}), carried: true };
  // behold#631: a new pull request of the cycle (the fix) that has no plan yet: its cards keep what they were.
  // What landed reads applied earlier; a failed or blocked card keeps that state until the fix's plan says otherwise.
  const noPlanYet = (a) => a && !a.error && !a.plan && !a.apply && !(a.live && (a.live.apply || a.live.plan));
  if (noPlanYet(answer) && /^pull/.test(pin) && chantPrAnswer && chantFacets) {
    const prev = chantPrAnswer;
    let lastStates = prev.lastStates && prev.pull === answer.pull ? prev.lastStates : null;
    let landed = new Set(prev.live && prev.live.earlier ? prev.live.earlier.applied : []);
    if (!lastStates && (prev.plan || (prev.live && prev.live.apply)) && prev.pull !== answer.pull) {
      const cards = chantComponentMarks(chantPacer.answer(prev), chantFacets).cards;
      lastStates = {};
      for (const [c, m] of Object.entries(cards)) {
        if (m.state === "failed" || m.state === "blocked") lastStates[c] = m.state;
        else if (m.state === "applied" || m.state === "already-applied" || m.state === "applied-earlier") landed.add(c);
      }
    }
    if (lastStates) answer = { ...answer, lastStates, live: { ...(answer.live || { reportUrl: null, via: "pipeline" }), plan: null, apply: null, earlier: { runs: (answer.live && answer.live.earlier && answer.live.earlier.runs) || [], applied: [...new Set([...landed, ...((answer.live && answer.live.earlier && answer.live.earlier.applied) || [])])] } } };
  }
  chantPrAnswer = answer;
  chantPrRead = true;
  if (JSON.stringify(answer) !== was) drawTgReads();
}
/** Read the loop every few seconds while a chant repo's components view is on screen. */
function watchChantPr() {
  const on = !staticMode && !!(view.components && chantFacets && !terragucciComponentsRepo);
  if (on && !chantPrTimer) {
    void loadChantPr();
    chantPrTimer = setInterval(() => void loadChantPr(), 3_000);
  } else if (!on && chantPrTimer) {
    clearInterval(chantPrTimer);
    chantPrTimer = null;
  }
}

/** #571: the CI and resources facets from a terragucci repo's components
 * graph: component -> its declared job ({jobName, needs, wave, alsoIn}), and
 * component -> the resources its root holds. */
function takeTerragucciFacets(m) {
  chantFacets = (m && m.chantPr) || null; // behold#631
  const tg = m && m.terragucciComponents;
  tgComponentFacets = tg || null;
  if (!tg) return;
  ciByComponent = new Map((tg.jobs || []).map((job) => [job.component, job]));
  ciForge = tg.forge || null;
  resourcesByComponent = tg.resources || {};
}

async function loadCi() {
  if (publicMode) return; // #569: /api/ci is refused in a public view
  if (terragucciComponentsRepo) return; // #571: carried on the graph response
  try {
    const q = lensParams(new URLSearchParams(view.env ? { env: view.env } : {}));
    const res = await apiFetch(`/api/ci?${q}`);
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || res.statusText);
    ciByComponent = new Map((j.jobs || []).map((job) => [job.component, job]));
    ciForge = j.forge || null;
  } catch {
    // Non-fatal: the component DAG still renders without the CI facet (e.g. a
    // served chant predating generate mode) — inspect() just omits the section.
    ciByComponent = new Map();
    ciForge = null;
  }
}

// Resources facet (#59 unify) — component name -> its AWS resources, from
// `/api/resources` (src/server.ts documents what this is and isn't: a
// source-location convention match, not the literal CFN stack — chant's own
// `groups.byStack` is lexicon-only today, not per-stack). Loaded once per
// components-mode load(), same caching shape as `ciByComponent`; a click
// reads it synchronously.
let resourcesByComponent = {};

async function loadResources() {
  if (publicMode) return; // #569: /api/resources is refused in a public view
  if (terragucciComponentsRepo) return; // #571: carried on the graph response
  try {
    const q = lensParams(new URLSearchParams(view.env ? { env: view.env } : {}));
    const res = await apiFetch(`/api/resources?${q}`);
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || res.statusText);
    resourcesByComponent = j.byComponent || {};
  } catch {
    // Non-fatal, same rationale as loadCi(): the DAG and its other facets
    // still render without the resources facet.
    resourcesByComponent = {};
  }
}

// The observe → reconcile → apply dial (M2 #54 observe/reconcile, M3 #54
// apply): where the selected target sits on the lifecycle progression, per
// the epic's design. `observe` is always live already — it's the
// component-status view above (render()'s `componentStatus` branch IS
// observe); clicking the step just switches into it. `reconcile` is a
// click-to-fetch summary (`/api/reconcile`, a full build + cloud query — on
// demand, like #27's live diff), cached until the env/tier/target lens
// changes. `apply` (M3) is a REAL delegated write: click opens a small
// component/all picker, confirm triggers `POST /api/apply`
// (`chant run <target> --components --env <env> --events-json`: behold
// triggers, chant executes), and the structured wave/phase progress it
// streams back (chant's run events, folded by src/run-events.ts into
// src/apply.ts's model, broadcast as the `apply` SSE event, #679) renders
// live below the dial: the primary surface for an apply, not the raw now-line.
let reconcileCache = null; // last ReconcileSummary for the current env/tier/target, or null
let applyProgress = null; // last ApplyProgressState (src/apply.ts) for the current env, or null — hydrated from /api/ops on load, then kept live by the `apply` SSE event
let applyPicker = false; // whether the inline "apply <component|all> →" prompt is open
// #284 item 2 — the run playhead. `runState` is src/run-playhead.ts's RunState:
// hydrated from /api/ops on load (so a reload mid-run doesn't start blank) and
// kept live by the `run` SSE event. `gateCard` is the graph's own richer answer
// (meta.gate — it knows which declared step the gate holds back), used when the
// ops lens has been loaded; the panel falls back to deriving one from runState.
// Deliberately NOT reset by resetDialCaches(): a run belongs to an Op, not to
// whichever env/tier lens happens to be picked.
let runState = null;
let gateCard = null;
let runStatusInFlight = false;
// #234 joins 3 + 1 — the operating loop. src/operator.ts's OperatorState:
// `declared` (the ConvergeOps the built project declares, from op.json) arrives
// with the ops lens, the rest from `/api/operator/status`; kept live by the
// `operator` SSE event. Deliberately NOT reset by resetDialCaches(), for the
// playhead's reason: a loop belongs to its project, not to a picked env/tier.
let operatorState = null;
let operatorInFlight = false;
// #234, chant#2029 — the converge timeline behind the strip. Closed until a
// human opens it, read once when they do, and never on a timer: the strip is the
// at-a-glance line that ages by itself, the history is a ledger's past and does
// not change while you read it. `data` is src/operator.ts's OperatorHistory.
let operatorHistory = { open: false, loading: false, error: null, data: null };
let componentChoices = []; // component names for the apply picker — loaded lazily (independent of whether the graph pane is currently in components mode)
let componentStatusById = {}; // id -> _status ("good"|"accent"|"warn"|"neutral"), populated alongside componentChoices — lets the picker show which stacks are already applied

// How a component's live status reads in the apply picker (and the apply-all
// summary): a glyph + words, so "which stacks are applied" is legible at a
// glance rather than a bare name list. Mirrors COMPONENT_STATUS_LABEL's buckets.
const APPLY_STATUS_TAG = {
  good: "✓ deployed",
  accent: "⋯ in progress",
  warn: "⚠ rolled back / failed",
  neutral: "○ not deployed",
};
function applyOptionLabel(name) {
  const tag = APPLY_STATUS_TAG[componentStatusById[name]];
  return tag ? `${name} — ${tag}` : name;
}

// Disruption severity (chant#1665, #284) → an existing palette token. No new
// colours: the drift palette's own two "look at this" tones do the work, which
// keeps a reconcile row reading the same as the overlay a user just came from.
// --foreign is the mild one (the yellow an adoptable node wears — go look);
// --degraded is the strong one (the tone the component dial already spends on
// a failure). `in-place` gets NO tint: a pending row whose update mutates in
// place must read exactly as every pending row read before this landed.
//
// `unknown` takes the mild tone rather than none. chant's contract is that
// `unknown` is the default and the ONLY fallback — a silent, broken, or absent
// classifier all land there — so it means "nobody could say", and painting it
// like `in-place` would turn "unclassified" into "safe", which is the one
// reading #1665 exists to prevent.
const DISRUPTION_VAR = {
  "in-place": "",
  rolling: "var(--foreign)",
  replace: "var(--degraded)",
  destroy: "var(--degraded)",
  unknown: "var(--foreign)",
};

// The word is the carrier; the tone only reinforces it (accessible-ops: colour
// is never the only thing saying this row is expensive — the same reason the
// drift panel's dot rows always ship a label beside the dot). These lines are
// the row tooltip's second half.
const DISRUPTION_WHY = {
  "in-place": "the provider mutates the existing resource — no new identity, no window where it is absent",
  rolling: "the resource survives, but its workload is replaced incrementally — disruptive to what is running",
  replace: "a new resource is built and the old one removed — the physical id changes",
  destroy: "the old resource is deleted FIRST, then rebuilt — there is a window with nothing in it",
  unknown: "no lexicon could classify this change. Unknown is not \"in place\" — go read it",
};

// The levels worth putting on the dial badge, loudest last. `in-place` is
// omitted on purpose: it is the "nothing new to say" verdict, and listing it
// would lengthen the badge without changing what anyone does about it. It is
// still named in full on any row where it IS the worst verdict, because
// "classified in-place" and "never classified" have to look different.
const DISRUPTION_BADGE_LEVELS = ["rolling", "unknown", "replace", "destroy"];

/** The dial button's disruption suffix, e.g. " · 1 replace". Empty against a
 * chant that doesn't classify (every count 0), so the badge is unchanged. */
function disruptionBadge(d) {
  if (!d) return "";
  return DISRUPTION_BADGE_LEVELS.filter((l) => d[l]).map((l) => ` · ${d[l]} ${l}`).join("");
}

// Reset the dial's per-target caches (reconcile summary, apply picker/progress,
// component-name list) when the env/tier/target lens changes — all three are
// scoped to "whatever target is currently picked", so switching targets must
// not show a stale reconcile count or a finished apply's progress from a
// DIFFERENT target as if it were current.
function resetDialCaches() {
  reconcileCache = null;
  applyProgress = null;
  applyPicker = false;
  componentChoices = [];
  componentStatusById = {};
  compositeMembersCache = null;
  bulkDiffCache = null;
}

// Composite → member list, for the inspect pane. Derived once from the base
// (attribute-tier) source graph, where every node carries its `compositeInstance`
// (indexed by web/composite-members.js, #828)
// — then a detail-1 composite node lists what it expands to. Cached per lens
// (reset in resetDialCaches); structural, so no live/env call needed.
let compositeMembersCache = null;
async function getCompositeMembers(instanceId) {
  if (!compositeMembersCache) {
    compositeMembersCache = {};
    try {
      const q = lensParams(new URLSearchParams({ detail: "3" }));
      const j = await apiFetch(`/api/graph?${q}`).then((r) => r.json());
      compositeMembersCache = indexCompositeMembers(j.ir && j.ir.nodes);
    } catch {
      /* leave the cache empty — the members section shows "(no members found)" */
    }
  }
  return compositeMembersCache[instanceId] || [];
}

function dialArrow() {
  const s = document.createElement("span");
  s.className = "dial-arrow";
  s.textContent = "→";
  return s;
}

// --- behold#571: event-help in the full app ---------------------------------
// A converge gate that waits for a person opens event-help's modal in live
// mode (web/event-help-modal.js): what the gate covers, behold's own gate
// card, and an Approve button that calls the route the card's button calls
// (approveConvergeGate). It waits for the person, and closes when they
// dismiss it or when the gate leaves the pending list. Only where behold may
// approve: never framed, in a snapshot, in a preview or in a public view.
// The Tips switch, the kiosk's too, turns it off.
const ehApp = { seen: new Set(), modal: null };
const ehShelf = (() => {
  try {
    return localStorage;
  } catch {
    return null;
  }
})();
(function wireTips() {
  modalStyle(document);
  const label = document.getElementById("panel-tips");
  const box = label && label.querySelector("input");
  if (!box) return;
  box.checked = ehStored(ehShelf);
  box.addEventListener("change", () => {
    ehStore(ehShelf, box.checked);
    if (!box.checked && ehApp.modal) ehApp.modal.api.close();
  });
})();
const ehGateKey = (g) => `${g.op}|${g.gate}|${g.since || ""}`;
function ehAppGates() {
  if (embedOpts.embed || staticMode || previewMode || publicMode) return;
  const gates = (operatorState && operatorState.gates) || [];
  // The event resolved: the gate left the pending list.
  if (ehApp.modal && !gates.some((g) => ehGateKey(g) === ehApp.modal.key)) ehApp.modal.api.resolve(APPROVED_SEMANTICS);
  if (!ehStored(ehShelf)) return;
  for (const g of gates) {
    const key = ehGateKey(g);
    if (ehApp.seen.has(key)) continue;
    ehApp.seen.add(key);
    if (ehApp.modal) continue;
    // behold's own card, without its button: the modal's Approve is the same act.
    const card = renderConvergeGateCard(g, { approve: () => {} });
    for (const b of card.querySelectorAll("button")) b.remove();
    const host = document.getElementById("eh-modals") || document.body;
    const api = openEventModal(host, {
      mode: "live",
      kind: "held",
      data: { title: `${g.gate} waits for an approval`, lines: [{ text: `${g.op} wants a person's approval before the converge loop applies its change.` }], panel: card, gate: { kind: "converge", op: g.op, gate: g.gate, approve: g.approve }, verbs: { verb: "Record approval", ing: "Recording…", past: "Recorded" } },
      actions: { approve: () => approveConvergeGate(g.op, g.gate) },
      reduced: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
      onClose: () => (ehApp.modal = null),
    });
    ehApp.modal = { key, api };
  }
}

function renderDial() {
  ehAppGates();
  const host = document.getElementById("dial");
  if (!view.env) {
    // The dial used to vanish entirely here, with nothing saying why — someone
    // who launched without --env saw no observe/reconcile/apply path at all.
    // Say what's missing instead (a static export keeps the old silence: there
    // is genuinely nothing to offer).
    host.innerHTML = "";
    if (staticMode || !environments.length) {
      host.style.display = "none";
      return;
    }
    host.style.display = "flex";
    const hint = document.createElement("span");
    hint.style.cssText = "font-size:var(--t-caption);color:var(--muted);align-self:center";
    hint.textContent = "observe → reconcile → apply needs an environment — pick one in ⌘K (env: …)";
    host.appendChild(hint);
    // A pipeline run (#163) is env-less — its progress still belongs here.
    if (applyProgress && applyProgress.waves.length) host.appendChild(renderApplyProgress(applyProgress));
    mountPlayhead(host);
    return;
  }
  host.style.display = "flex";
  host.innerHTML = "";

  const track = document.createElement("div");
  track.className = "dial-track";

  const observeBtn = button("observe", "dial-step" + (view.components ? " active" : ""), () => {
    view.components = true;
    load();
  });
  observeBtn.title = `Live per-component status for ${view.env} (chant components status --live) — the palette this graph paints when "components" is on.`;
  track.appendChild(observeBtn);
  track.appendChild(dialArrow());

  // chant#1168 (#1089): `unobserved` is its own count, appended rather than
  // folded into "pending" — reconcileCache.unobserved is 0 against an older
  // chant, so this is a no-op suffix until #1168 ships.
  // chant#1180 (#1077): `runtime` gets the identical treatment — its own
  // count, 0 against a chant predating it.
  // chant#1665 (#284): the disruption suffix is NOT a fourth count — it's a
  // re-cut of the `pending` number by what applying it costs, so "4 pending ·
  // 1 replace" means one of those four rebuilds the resource. Empty against a
  // chant that doesn't classify, same no-op suffix discipline as the two above.
  const reconcileBtn = button(
    reconcileCache
      ? `reconcile · ${reconcileCache.total} pending` +
        disruptionBadge(reconcileCache.disruption) +
        (reconcileCache.unobserved ? ` · ${reconcileCache.unobserved} unobserved` : "") +
        (reconcileCache.runtime ? ` · ${reconcileCache.runtime} runtime` : "")
      : "reconcile",
    "dial-step",
    loadReconcile,
  );
  reconcileBtn.title = `Pending change set for ${view.env} (chant lifecycle plan --live, read-only) — click to load.`;
  track.appendChild(reconcileBtn);

  // Apply is the write step — omitted in a static export (observe + reconcile
  // above are reads and stay).
  const applying = applyProgress && applyProgress.status === "running";
  if (!staticMode && !publicMode) {
    track.appendChild(dialArrow());
    const applyBtn = button(
      applying ? "apply · running…" : "apply",
      "dial-step" + (applyPicker || applying ? " active" : ""),
      () => {
        if (applying) return; // a run is already in flight — its progress is on screen below
        applyPicker = !applyPicker;
        if (applyPicker) loadComponentChoices().then(renderDial);
        renderDial();
      },
    );
    applyBtn.title = `Delegated write: chant run <component|all> --components --env ${view.env} --events-json. behold triggers, chant executes.`;
    track.appendChild(applyBtn);
  }

  host.appendChild(track);
  if (reconcileCache) host.appendChild(renderReconcileDetail(reconcileCache));
  if (applyPicker && !applying && !staticMode && !publicMode) host.appendChild(renderApplyPicker());
  if (applyProgress && applyProgress.waves.length) host.appendChild(renderApplyProgress(applyProgress));
  mountOperator(host);
  mountPlayhead(host);
}

// #234 joins 3 + 1 — the operator strip. Only on the ops lens: the operating
// loop is a fact about the project's declared Ops, and it belongs beside the
// track they draw rather than on top of whichever env the dial is pointed at.
// Gated on a DECLARED ConvergeOp, so an estate that runs no loop grows nothing.
function mountOperator(host) {
  if (!view.ops || !hasOperator(operatorState)) return;
  const box = document.createElement("div");
  box.className = "operator-strip";
  renderOperator(
    box,
    operatorState,
    {
      approve: embedOpts.embed || previewMode || staticMode || terragucciRepo ? null : (op, gate) => approveConvergeGate(op, gate),
      approver: projectInfo && projectInfo.approver,
      why: embedOpts.embed ? "host" : publicMode ? "public" : previewMode ? "preview" : "static",
      // A static export has no server to ask, so it gets no history affordance
      // at all rather than a button that can only fail.
      ...(staticMode ? {} : { history: () => toggleOperatorHistory() }),
    },
    operatorHistory,
  );
  host.appendChild(box);
}

// #284 item 2 — the run playhead panel: the run's honest verdict, the pending
// gate as a first-class card (#234) with its delegated approve, and the steps
// that have actually settled. Env-less on purpose, like a pipeline run: an Op
// belongs to its project, not to whichever env the dial is pointed at.
function mountPlayhead(host) {
  if (!hasPlayhead(runState)) return;
  const box = document.createElement("div");
  box.className = "run-playhead";
  renderPlayhead(box, runState, gateCard, { approve: embedOpts.embed || previewMode || staticMode || terragucciRepo ? null : (op, gate) => signal(op, gate), approver: projectInfo && projectInfo.approver, why: embedOpts.embed ? "host" : publicMode ? "public" : previewMode ? "preview" : "static" });
  host.appendChild(box);
}

// Apply picker (M3): "which component(s)?" prompt for the dial's apply step —
// mirrors openRollback's inline select+confirm+cancel shape. Defaults to "all
// components" (chant's own `run --components all` selector); loadComponentChoices()
// supplies the individual names regardless of the graph pane's current mode.
function renderApplyPicker() {
  const wrap = document.createElement("div");
  wrap.className = "dial-detail";
  wrap.style.gap = "6px";
  const sel = document.createElement("select");
  sel.style.cssText =
    "background:var(--well);color:var(--fg);border:1px solid var(--line);border-radius:var(--r-ctl);padding:3px 8px;font-size:var(--t-body)";
  sel.add(new Option("all components", "all"));
  for (const name of componentChoices) sel.add(new Option(applyOptionLabel(name), name));
  const go = button("Apply →", "", () => {
    const component = sel.value;
    const what = component === "all" ? "ALL components" : component;
    if (!window.confirm(`Apply ${what} to ${view.env}?\nThis is a real write: chant run --components --events-json.`)) return;
    applyPicker = false;
    runApply(component);
  });
  const cancel = button("✕", "", () => {
    applyPicker = false;
    renderDial();
  });
  wrap.append(sel, go, cancel);
  return wrap;
}

async function loadComponentChoices() {
  if (componentChoices.length) return componentChoices;
  try {
    const q = lensParams(new URLSearchParams({ components: "1", ...(view.env ? { env: view.env } : {}) }));
    const res = await apiFetch(`/api/graph?${q}`);
    const j = await res.json();
    const nodes = (j.ir && j.ir.nodes ? j.ir.nodes : []).filter((n) => n.kind === "Component");
    componentChoices = nodes.map((n) => n.id);
    // Per-component live status for the picker labels — only present when an env
    // is picked (the status join needs one); source-only graphs leave it blank.
    componentStatusById = {};
    for (const n of nodes) if (n.attrs && n.attrs._status) componentStatusById[n.id] = n.attrs._status;
  } catch {
    componentChoices = []; // the picker still offers "all components" — just no per-name list
    componentStatusById = {};
  }
  return componentChoices;
}

// "Apply all" from the header (M3): the discoverable equivalent of Sync when a
// project has no committed ApplyOp — deploy every component. Uses the current
// env (kept live by the picker); confirms since it's a real write. The dial's
// structured progress then renders the run.
async function confirmApplyAll() {
  const env = view.env;
  if (!env) {
    nowline("✗ apply all: pick an env first (env drives the target)");
    return;
  }
  // Route around Floci #16 (github.com/lex00/floci/issues/16): re-applying an
  // already-deployed stack collides on its fixed-name resources ("... already
  // exists") and rolls the stack back — the emulator can't no-op an unchanged
  // resource on update. So the honest states, from the accurate per-component
  // live status (the stack-status seam):
  //   all healthy      -> nothing to apply; re-apply would only break things.
  //   some undeployed  -> apply is fine for a fresh emulator.
  //   some rolled-back -> re-apply won't recover them; a reset is the clean path.
  let deployed = 0;
  let total = 0;
  let rolledBack = 0;
  try {
    const j = await apiFetch(`/api/graph?components=1&env=${encodeURIComponent(env)}`).then((r) => r.json());
    const nodes = (j.ir && j.ir.nodes) || [];
    total = nodes.length;
    deployed = nodes.filter((n) => n.attrs && n.attrs._status === "good").length;
    rolledBack = nodes.filter((n) => n.attrs && n.attrs._status === "warn").length;
  } catch {
    /* couldn't check — fall through to the plain confirm */
  }
  // The Floci #16 story (re-apply collides on the emulator's fixed-name
  // resources) only exists where applies actually hit Floci. On a k8s/helm
  // estate a re-apply is the normal sync gesture, and warning about an
  // emulator the project doesn't use was wrong twice over — the server's
  // /api/apply pre-flight is gated the same way.
  const onFloci = lastSubstrates.some((s) => s.name === "floci" && s.status === "up");
  if (onFloci && total > 0 && deployed === total) {
    showToast(`✓ nothing to apply — all ${total} components are already deployed & in sync (re-applying would collide on Floci #16)`, true);
    return;
  }
  const brokenNote = onFloci && rolledBack > 0
    ? `⚠ ${rolledBack} component(s) are rolled back. Re-applying WON'T recover them on the emulator — their fixed-name resources still exist (Floci #16). Use the "Reset" button on the Floci substrate pill — it reboots the emulator and redeploys clean (don't apply after).\n\n`
    : "";
  const reapplyNote = onFloci && deployed > 0
    ? `Note: ${deployed} of ${total} are already deployed and will be re-applied — that can fail on the local emulator (Floci #16).\n\n`
    : "";
  if (
    !window.confirm(
      `${brokenNote}${reapplyNote}Apply ALL components to ${env}?\nReal write: chant run --components all --env ${env} --events-json.\nLive progress appears in the dial.`,
    )
  )
    return;
  runApply("all");
}

function runApply(component) {
  const q = new URLSearchParams({ env: view.env, component });
  fetch(`/api/apply?${q}`, { method: "POST" })
    .then((r) => r.json())
    .then((j) => {
      if (j.error) {
        showToast(`✗ apply: ${j.error}`, false);
        nowline("✗ apply: " + j.error);
      } else {
        showToast(`▶ applying ${component} → ${view.env} — progress on the dial`, true);
        nowline(`▶ apply ${component} → ${view.env}`);
      }
      renderDial();
    });
}

// Structured wave/phase progress (M3): the primary surface for an apply — an
// ordered list of waves, each showing its components' current phase/step and
// status, coloured the same way the rest of the SPA colours health (managed=
// ok, pending=running, degraded=failed, muted=not-yet-reached). Replaces the
// raw-log-tail now-line as the thing you actually watch during a deploy; the
// now-line still gets chant's human summary + any non-progress line as a
// fallback (src/op-runner.ts's apply() only filters OUT the run-event lines,
// and an older chant's progress lines, from that channel).
// `lost` (#165 §6): the CI follow stream died without a verdict — same tone
// as the run playhead's lost (RUN_STATUS_COLOR), because it is the same fact.
// #679: `gated` and `waiting` wait on a person, in the pending tone, never red.
const APPLY_STATUS_COLOR = { pending: "var(--muted)", running: "var(--pending)", ok: "var(--managed)", failed: "var(--degraded)", gated: "var(--pending)", waiting: "var(--pending)", lost: "var(--foreign)" };

function renderApplyProgress(state) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;width:100%;margin-top:4px";
  const summary = document.createElement("div");
  summary.style.cssText = `font-size:var(--t-caption);color:${APPLY_STATUS_COLOR[state.status] || "var(--muted)"}`;
  // A pipeline run (#163) reuses this whole panel — same shape, different
  // executor — and says so instead of claiming to be an apply.
  summary.textContent = `${state.kind || "apply"}: ${state.status}`;
  wrap.appendChild(summary);
  // #679: where the progress came from. A pipeline chant did not run is read
  // from its runner's log, and the dial says that is best-effort; an older
  // chant's run says it is degraded.
  const from = sourceLabel(state.source, null);
  if (from) {
    const src = document.createElement("div");
    src.className = "apply-source";
    src.style.cssText = `font-size:var(--t-caption);color:${RUN_STATUS_COLOR[from.tone] || "var(--muted)"}`;
    src.textContent = from.text;
    wrap.appendChild(src);
  }
  for (const text of [state.lost, waitingLine(state.waitingOn)]) {
    if (!text) continue;
    const line = document.createElement("div");
    line.style.cssText = "font-size:var(--t-caption);color:var(--muted)";
    line.textContent = text;
    wrap.appendChild(line);
  }
  // #165: a dispatched run's own page — the one place an environment
  // protection rule's approval can be granted. A link, never a button: behold
  // holds no identity that could clear a forge gate, and must not acquire one.
  if (state.kind === "pipeline" && state.url) {
    const a = document.createElement("a");
    a.href = state.url;
    a.target = "_blank";
    a.rel = "noreferrer noopener";
    a.textContent = `run on the forge — approval, if required, is granted there`;
    a.style.cssText = "font-size:var(--t-caption)";
    a.title = state.url;
    wrap.appendChild(a);
  }
  for (const w of state.waves) {
    const row = document.createElement("div");
    row.className = "apply-wave-row";
    row.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap";
    // behold#571: the wave's left bar, in its status.
    row.style.setProperty("--bar", barVarFor(APPLY_STATUS_COLOR[w.status]));
    const label = document.createElement("span");
    label.style.cssText = `font-size:var(--t-caption);color:${APPLY_STATUS_COLOR[w.status] || "var(--muted)"};min-width:52px`;
    label.textContent = `wave ${w.wave}`;
    row.appendChild(label);
    for (const cname of w.components) {
      const c = (state.components || []).find((x) => x.component === cname) || { status: "pending" };
      const color = APPLY_STATUS_COLOR[c.status] || "var(--muted)";
      const chip = document.createElement("span");
      chip.style.cssText = `border:1px solid ${color};color:${color};border-radius:var(--r-ctl);padding:2px 8px;font-size:var(--t-caption)`;
      chip.textContent = applyChipText(cname, c);
      if (c.error) chip.title = c.error;
      row.appendChild(chip);
    }
    wrap.appendChild(row);
  }
  return wrap;
}

function renderReconcileDetail(r) {
  const wrap = document.createElement("div");
  wrap.className = "dial-detail";
  const rows = Object.entries(r.byComponent).sort((a, b) => b[1] - a[1]);
  // chant#1168 (#1089): `unobserved` is its own category — a plan that's ALL
  // unobserved (nothing pending, nothing uncorrelated) must not read as
  // "no pending changes", which would claim everything's confirmed in sync.
  const hasUnobserved = !!r.unobserved;
  // chant#1180 (#1077): `runtime` gets the identical treatment.
  const hasRuntime = !!r.runtime;
  if (!rows.length && !r.uncorrelated && !hasUnobserved && !hasRuntime) {
    wrap.textContent = "no pending changes";
    return wrap;
  }
  // chant#1665 (#284): a row carries the loudest verdict among its pending
  // changes, as a WORD plus a tone — an update that rebuilds the resource is a
  // materially different pending item from one that flips a tag, and until now
  // both read as "worker: 1". A component whose entries carry no verdict (an
  // older chant, or no `update` among them) gets neither, which is the same row
  // it drew before — absence is not `in-place`.
  const severity = (span, level) => {
    if (!level) return;
    const tint = DISRUPTION_VAR[level];
    if (tint) span.style.color = tint;
    span.textContent += ` · ${level}`;
    const why = `Worst pending change here: ${level} — ${DISRUPTION_WHY[level]}.`;
    span.title = span.title ? `${span.title}\n${why}` : why;
  };
  for (const [component, count] of rows) {
    const span = document.createElement("span");
    span.textContent = `${component}: ${count}`;
    severity(span, r.disruptionByComponent && r.disruptionByComponent[component]);
    wrap.appendChild(span);
  }
  if (r.uncorrelated) {
    const span = document.createElement("span");
    span.textContent = `${r.uncorrelated} uncorrelated`;
    span.title = "Pending changes that couldn't be mapped to a component by source location.";
    severity(span, r.disruptionUncorrelated);
    wrap.appendChild(span);
  }
  if (hasUnobserved) {
    const span = document.createElement("span");
    span.style.color = "var(--muted)";
    span.textContent = `${r.unobserved} unobserved`;
    span.title = "Declared entities chant could not read live state for — not a pending change, not confirmed in sync.";
    wrap.appendChild(span);
  }
  if (hasRuntime) {
    const span = document.createElement("span");
    span.style.color = "var(--runtime)";
    span.textContent = `${r.runtime} runtime`;
    span.title = "Live, undeclared resources whose owner chain reaches a declared entity — expected runtime, not a pending change.";
    wrap.appendChild(span);
  }
  return wrap;
}

async function loadReconcile() {
  if (publicMode) return; // #569: /api/reconcile is refused in a public view
  try {
    const q = lensParams(new URLSearchParams({ env: view.env }));
    const res = await apiFetch(`/api/reconcile?${q}`);
    const j = await res.json();
    // #72: the structured {error, code, remedy} src/server.ts's errorResponse
    // now sends for every classified failure (tier included — `error` already
    // carries the full tier-scoped message, replacing the old `tierNote`).
    if (!res.ok) throw new Error(j.error || res.statusText);
    reconcileCache = j;
    renderDial();
  } catch (e) {
    nowline("✗ reconcile: " + e.message);
  }
}

// #553: pinhole writes the IR edge's `viaAttr` on the chip ("uses",
// "workflow_run"). A CI edge's chip says its kind instead, with the attribute
// when it adds something ("calls (uses)"), as chant's Mermaid does. The pill
// is re-sized around the new text with pinhole's own metrics (5.7 per
// character plus 14), centred where pinhole centred it.
function relabelEdgeChip(chip, kind, via) {
  if (!isCiKind(kind)) return;
  const text = chip.querySelector("text");
  const rect = chip.querySelector("rect");
  const label = edgeLabel({ kind, via });
  if (!text || !label || text.textContent === label) return;
  text.textContent = label;
  if (!rect) return;
  const cx = Number(text.getAttribute("x"));
  const w = label.length * 5.7 + 14;
  if (!Number.isFinite(cx)) return;
  rect.setAttribute("width", w.toFixed(1));
  rect.setAttribute("x", (cx - w / 2).toFixed(1));
}

// Edge hover-highlight (helps trace one edge through an overlapping bundle — see
// index.html's `.pin-edge-line` rules). pinhole already paints a fat transparent
// hit-path per edge, so the CSS `:hover` does the visual work; this adds two
// things CSS can't: raise the hovered edge to the top of the paint order (SVG has
// no z-index) so it's not buried, and light up every edge touching a hovered node
// (the `.edge-hi` class) so hovering a card traces all its connections.
// Human-readable "why does this edge exist" from the IR edge's `viaAttr` and,
// for a CI edge (#553), its `kind` and `crossPipeline` (web/edge-kind.js says
// them in words). Shown as a native SVG <title> tooltip on hover; the stamped
// attributes also drive the dashed and per-kind styles (index.html).
let lastEdgeWeights = new Map();
function wireEdgeHighlight(svgEl, ir) {
  const edges = [...svgEl.querySelectorAll("g[data-edge-from]")];
  if (!edges.length) return;
  // Reason per edge, keyed by from, to and kind (pinhole's edgeKey, #564), so
  // two kinds on one pair keep their own reason. pinhole stamps data-edge-via
  // itself; this fills it in where it did not.
  const viaOf = viaIndex(ir.edges || []);
  // #878: each reference weighed by how it was found (web/edge-weight.js).
  lastEdgeWeights = edgeWeights(ir.edges || [], new Map((ir.nodes || []).map((n) => [n.id, n.kind])));
  for (const g of edges) {
    const w = lastEdgeWeights.get(`${g.getAttribute("data-edge-from")}→${g.getAttribute("data-edge-to")}`);
    if (w) g.setAttribute("data-edge-weight", w);
  }
  for (const g of edges) {
    const from = g.getAttribute("data-edge-from");
    const to = g.getAttribute("data-edge-to");
    const kind = g.getAttribute("data-edge-kind") || "ref";
    const via = g.getAttribute("data-edge-via") || viaOf.get(edgeKey({ from, to, kind }));
    if (via) g.setAttribute("data-edge-via", via); // drives the dashed style
    const cross = g.getAttribute("data-edge-cross") === "true";
    if (!g.querySelector("path")) relabelEdgeChip(g, kind, via);
    const title = document.createElementNS(SVGNS, "title");
    title.textContent = edgeTitle(from, to, { kind, via, cross });
    g.insertBefore(title, g.firstChild);
  }
  // behold#744: raised under the terragucci reads' layer, whose lines and pills stay over every edge.
  const raise = (g) => g.parentNode && g.parentNode.insertBefore(g, g.parentNode.querySelector(":scope > [data-tg-reads]"));
  wireEdgeLabelPeek(svgEl);
  // Delegated: light and raise whichever edge the pointer is over (its hit-path
  // catches it). Lit by a class, not `:hover`: raising re-inserts the element,
  // and a re-inserted element loses `:hover` until the pointer moves again, so
  // the line flickered rather than lit.
  svgEl.addEventListener("mouseover", (e) => {
    const g = e.target.closest && e.target.closest("g[data-edge-from]");
    if (!g) return;
    g.classList.add("edge-over");
    const top = g.parentNode && g.parentNode.querySelector(":scope > [data-tg-reads]");
    if (g.nextElementSibling !== top) raise(g);
  });
  svgEl.addEventListener("mouseout", (e) => {
    const g = e.target.closest && e.target.closest("g[data-edge-from]");
    if (g && !(e.relatedTarget && g.contains(e.relatedTarget))) g.classList.remove("edge-over");
  });
  // Hovering a node lights (and raises) every edge on it.
  for (const card of svgEl.querySelectorAll("[data-node-id]")) {
    const id = card.getAttribute("data-node-id");
    const touching = edges.filter((g) => g.getAttribute("data-edge-from") === id || g.getAttribute("data-edge-to") === id);
    if (!touching.length) continue;
    card.addEventListener("mouseenter", () => touching.forEach((g) => (g.classList.add("edge-hi"), raise(g))));
    card.addEventListener("mouseleave", () => touching.forEach((g) => g.classList.remove("edge-hi")));
  }
}

const SVGNS = "http://www.w3.org/2000/svg";

// behold#571: the marks on each wave box's title row of the Components view,
// so the CI projection says which forge runs each wave and which tools its
// job runs: the forge's mark (linked to the wave's job when a report carried
// its URL), then each tool's (web/forge-mark.js, web/tool-mark.js). Each is
// a small icon and the name beside it. Right-aligned in the row after the
// title; when the row is short the icons go first, then the marks from the
// end, so a name stays. On chant's own GitLab-generated projection the row
// holds the forge chant generated for (the tanuki since #58).
const MARK_STEP = 6; // between two marks in a row

/** What a wave's row says: its forge, its job and its tools; null for no row. */
function pipelineMarksFor(n) {
  if (!view.components) return null;
  if (terragucciComponentsRepo && tgComponentFacets) {
    const jobs = (tgComponentFacets.jobs || []).filter((j) => j.wave === n);
    // The repo's tools, and what the wave's roots carry inside them (a SQL Yodeler project under app/).
    const roots = jobs.map((j) => (tgComponentFacets.roots && tgComponentFacets.roots[j.component]) || j.component);
    const carried = roots.flatMap((r) => (tgComponentFacets.rootTools && tgComponentFacets.rootTools[r]) || []);
    return { forge: componentsForge(tgComponentFacets, tgAnswer), job: jobs[0] ? jobs[0].jobName : null, tools: orderTools([...(tgComponentFacets.tools || []), ...carried]) };
  }
  // behold#631: a chant repo's pull-request loop: its forge and chant, with the engine its roots run.
  if (chantFacets) return { forge: forgeOfName(chantFacets.forge), job: chantFacets.workflow, tools: orderTools(chantFacets.tools || []), loop: true };
  if (ciByComponent.size) return { forge: forgeOfName(ciForge), job: null, tools: [], projection: true };
  return null;
}

/** One mark: an icon and the name, with its tooltip; an `<a>` for the forge so it can link. */
function markElement(tag, cls, spec, name, tip, light) {
  const el = document.createElementNS(SVGNS, tag);
  el.setAttribute("class", `pm-mark ${cls}`);
  const title = document.createElementNS(SVGNS, "title");
  title.textContent = tip;
  el.appendChild(title);
  if (spec) {
    const icon = iconSvg(document, spec, MARK.size, { light });
    icon.setAttribute("class", "pm-icon");
    el.appendChild(icon);
  }
  const text = document.createElementNS(SVGNS, "text");
  text.setAttribute("class", "pm-label");
  text.setAttribute("font-size", String(MARK.font));
  text.setAttribute("font-weight", "600");
  text.setAttribute("fill", "var(--muted)");
  text.setAttribute("dominant-baseline", "central");
  text.textContent = name;
  el.appendChild(text);
  return el;
}

/** Each mark's label width, measured. */
function markWidths(marks) {
  return marks.map((m) => {
    const label = m.querySelector(".pm-label");
    try {
      return label.getComputedTextLength() || label.textContent.length * MARK.font * 0.6;
    } catch {
      return label.textContent.length * MARK.font * 0.6;
    }
  });
}

/** Put a row's marks at `xs` (each mark's left), `icons` with or without their icon; marks past `k` hidden. */
function placeMarks(row, marks, widths, xs, icons, k, cys = null) {
  const cy0 = Number(row.getAttribute("data-pm-cy"));
  const show = (n, on) => (n.style.display = on ? "" : "none");
  show(row, k > 0);
  marks.forEach((m, i) => {
    show(m, i < k);
    if (i >= k) return;
    const icon = m.querySelector(".pm-icon");
    const label = m.querySelector(".pm-label");
    const cy = cys ? cys[i] : cy0;
    let x = xs[i];
    if (icon) show(icon, icons);
    if (icon && icons) {
      icon.setAttribute("x", x.toFixed(1));
      icon.setAttribute("y", (cy - MARK.size / 2).toFixed(1));
      x += MARK.size + MARK.gap;
    }
    label.setAttribute("x", x.toFixed(1));
    label.setAttribute("y", cy.toFixed(1));
  });
}

/** One mark's width, with or without its icon. */
const markWidth = (m, w, icons) => w + (icons && m.querySelector(".pm-icon") ? MARK.size + MARK.gap : 0);

/**
 * The title row: every mark with its icon, right-aligned in the rightmost
 * gap between `left` and the box's right edge that the edges crossing the
 * row (`data-pm-avoid`) leave. True when they fit; else nothing is placed.
 */
function titleRowFits(row, left) {
  const right = Number(row.getAttribute("data-pm-right"));
  const marks = [...row.querySelectorAll(":scope > .pm-mark")];
  const widths = markWidths(marks);
  const need = marks.reduce((s, m, i) => s + markWidth(m, widths[i], true), 0) + MARK_STEP * (marks.length - 1);
  const cuts = (row.getAttribute("data-pm-avoid") || "").split(",").filter(Boolean).map(Number).filter((x) => x > left && x < right).sort((a, b) => a - b);
  const gaps = [];
  let at = left;
  for (const x of cuts) {
    if (x - 5 > at) gaps.push([at, x - 5]);
    at = Math.max(at, x + 5);
  }
  if (right > at) gaps.push([at, right]);
  const gap = gaps.reverse().find(([a, z]) => z - a >= need);
  if (!gap) return false;
  const xs = [];
  let x = gap[1] - need;
  marks.forEach((m, i) => {
    xs.push(x);
    x += markWidth(m, widths[i], true) + MARK_STEP;
  });
  placeMarks(row, marks, widths, xs, true, marks.length);
  row.setAttribute("data-pm-mode", "title");
  return true;
}

/**
 * The marks' own row, just under the title: the box grows upward by a row
 * and its title moves up into it, so no card moves and none is covered. The
 * marks stay one cluster, the forge first, at the row's start or end where
 * no edge crosses it, else at its start with the edge behind. They keep
 * their icons: short of room the cluster runs onto another row, and the box
 * grows by that one too. Only at phone width do the icons go
 * first, while one row of names alone holds them.
 */
function marksOwnRow(row, rect, title, grown = 0) {
  const G = MARK.size + 6;
  const left = Number(row.getAttribute("data-pm-start"));
  const right = Number(row.getAttribute("data-pm-end"));
  const cy = Number(row.getAttribute("data-pm-cy"));
  const avoid = (row.getAttribute("data-pm-avoid") || "").split(",").filter(Boolean).map(Number);
  const marks = [...row.querySelectorAll(":scope > .pm-mark")];
  const widths = markWidths(marks);
  // One cluster, the forge first, then the tools: in rows when one row can't hold it, each row's
  // part together. A part goes at the row's start or its end, whichever an edge doesn't cross
  // (`clear`); else at the start, any edge passing behind it.
  const lay = (icons, clear, maxRows) => {
    const parts = [[]];
    let used = 0;
    for (let i = 0; i < marks.length; i++) {
      const w = markWidth(marks[i], widths[i], icons);
      const part = parts[parts.length - 1];
      const need = used + (part.length ? MARK_STEP : 0) + w;
      if (part.length && need > right - left) {
        parts.push([i]);
        used = w;
      } else {
        part.push(i);
        used = need;
      }
      if (w > right - left || parts.length > maxRows) return null;
    }
    const xs = [];
    const rowOf = [];
    for (const [r, part] of parts.entries()) {
      const width = part.reduce((s, i) => s + markWidth(marks[i], widths[i], icons), 0) + MARK_STEP * (part.length - 1);
      const crosses = (x0) => avoid.some((e) => e > x0 - 4 && e < x0 + width + 4);
      let x0 = left;
      if (clear) {
        const spot = [left, right - width].find((x) => !crosses(x));
        if (spot === undefined) return null;
        x0 = spot;
      }
      for (const i of part) {
        xs[i] = x0;
        rowOf[i] = r;
        x0 += markWidth(marks[i], widths[i], icons) + MARK_STEP;
      }
    }
    return { xs, rowOf, rows: parts.length };
  };
  // Phone width is the viewer's screen: the kiosk frames this page narrow on a wide one.
  const phone = (() => {
    try {
      return (window.top || window).innerWidth <= 600;
    } catch {
      return window.innerWidth <= 600;
    }
  })();
  // A second pass (`grown`, the rows the box already grew by) keeps within those rows.
  const most = grown || marks.length;
  const tries = [[true, true, 1], [true, false, 1]];
  if (phone) tries.push([false, true, 1], [false, false, 1]);
  tries.push([true, true, most], [true, false, most], [false, true, most], [false, false, most]);
  let fit = null;
  for (const [icons, step, maxRows] of tries) {
    const l = lay(icons, step, maxRows);
    if (l) {
      fit = { ...l, icons };
      break;
    }
  }
  row.setAttribute("data-pm-mode", "row");
  if (!fit) return grown ? false : placeMarks(row, marks, widths, [], true, 0);
  const rows = grown || fit.rows;
  if (!grown) {
    const grow = G * rows;
    rect.setAttribute("y", String(Number(rect.getAttribute("y")) - grow));
    rect.setAttribute("height", String(Number(rect.getAttribute("height")) + grow));
    if (title) title.setAttribute("y", String(Number(title.getAttribute("y")) - grow));
    row.setAttribute("data-pm-rows", String(rows));
  }
  // The last row stands where the title stood, just over the cards; the others above it.
  const cys = fit.rowOf.map((r) => cy - (rows - 1 - r) * G);
  placeMarks(row, marks, widths, fit.xs, fit.icons, marks.length, cys);
  return true;
}

/**
 * Once the reads are drawn: each wave box's marks stand clear of the read
 * lines that cross their row too, where the row has room; else they stay.
 */
function clearMarksOfReads(svgEl, lines) {
  for (const row of svgEl.querySelectorAll(".pipeline-marks")) {
    if (row.style.display === "none") continue;
    const m = /translate\(\s*([-\d.]+)[\s,]+([-\d.]+)/.exec((row.parentNode.getAttribute && row.parentNode.getAttribute("transform")) || "");
    const dx = m ? Number(m[1]) : 0;
    const dy = m ? Number(m[2]) : 0;
    const G = MARK.size + 6;
    const cy = Number(row.getAttribute("data-pm-cy"));
    const own = row.getAttribute("data-pm-mode") === "row";
    const top = cy - (own ? (Number(row.getAttribute("data-pm-rows")) || 1) * G : 0) - MARK.size / 2 - 2 + dy;
    const bottom = cy + MARK.size / 2 + 2 + dy;
    const xs = [];
    for (const { p0, p1 } of lines) {
      if (Math.max(p0.y, p1.y) < top || Math.min(p0.y, p1.y) > bottom) continue;
      for (const y of [top, (top + bottom) / 2, bottom]) {
        const f = p1.y === p0.y ? 0.5 : (y - p0.y) / (p1.y - p0.y);
        if (f >= 0 && f <= 1) xs.push(p0.x + (p1.x - p0.x) * f - dx);
      }
    }
    if (xs.length) stepAside(row, xs, own);
  }
  return liftOffArrowheads(svgEl, lines);
}

/** Lay a row out again clear of `xs` too, or leave it as it was where that doesn't fit. */
function stepAside(row, xs, own) {
  {
    const was = row.getAttribute("data-pm-avoid") || "";
    row.setAttribute("data-pm-avoid", [was, ...xs.map((x) => x.toFixed(1))].filter(Boolean).join(","));
    // The old places, should the new avoidance not fit.
    const keep = [...row.querySelectorAll("[x], [y]")].map((n) => [n, n.getAttribute("x"), n.getAttribute("y"), n.style.display]);
    const ok = own ? marksOwnRow(row, null, null, Number(row.getAttribute("data-pm-rows")) || 1) : titleRowFits(row, Number(row.getAttribute("data-pm-left")));
    if (!ok) {
      row.setAttribute("data-pm-avoid", was);
      for (const [n, x, y, d] of keep) {
        if (x !== null) n.setAttribute("x", x);
        if (y !== null) n.setAttribute("y", y);
        n.style.display = d;
      }
    }
  }
}

/** How far a read's arrowhead reaches back from its tip, and how wide it spreads (marker 7 x stroke 3). */
const ARROWHEAD = { length: 22, half: 11 };

/** behold#571: the box an arrowhead drawn from p0 to p1 covers, in the svg's units. */
function arrowheadBox(p0, p1) {
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
  const bx = p1.x - ((p1.x - p0.x) / len) * ARROWHEAD.length;
  const by = p1.y - ((p1.y - p0.y) / len) * ARROWHEAD.length;
  const h = ARROWHEAD.half;
  return { x: Math.min(p1.x, bx) - h, y: Math.min(p1.y, by) - h, x2: Math.max(p1.x, bx) + h, y2: Math.max(p1.y, by) + h };
}

/**
 * behold#571: each box title's box at the largest size scaleBoxLabels gives
 * it (a zoomed-out view draws it bigger), grown from its anchor, so a line or
 * an arrowhead placed clear of it stays clear at every zoom.
 */
function boxTitlesAtMost(svg, boxOf) {
  const out = [];
  for (const l of boxLabelsOf(svg)) {
    const b = boxOf(l.el);
    if (!b) continue;
    const chars = Math.max(4, (l.el.textContent || "").length);
    const cap = Math.max(l.base, Math.min(l.box.h / BOX_LABEL_MAX_H, l.box.w / (chars * BOX_LABEL_EM)));
    const now = parseFloat(l.el.getAttribute("font-size")) || l.base;
    const f = cap / now;
    if (!(f > 1)) continue;
    const w = (b.x2 - b.x) * f;
    const h = (b.y2 - b.y) * f;
    const anchor = l.el.getAttribute("text-anchor");
    const x = anchor === "end" ? b.x2 - w : anchor === "middle" ? (b.x + b.x2) / 2 - w / 2 : b.x;
    out.push({ x, y: b.y2 - h, x2: x + w, y2: b.y2 });
  }
  return out;
}

/**
 * No arrowhead sits on a mark. A read that ends in a box whose marks its head
 * would cover lifts the box's title and marks a row up, the box growing by
 * that row, so the head lands on open ground just over the card. Returns each
 * lifted box as [its rect, the rows it grew by].
 */
function liftOffArrowheads(svgEl, lines) {
  const G = MARK.size + 6;
  const lifted = [];
  const hit = (a, b) => a.x < b.x2 && a.x2 > b.x && a.y < b.y2 && a.y2 > b.y;
  const heads = lines.map(({ p0, p1 }) => {
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
    const bx = p1.x - ((p1.x - p0.x) / len) * ARROWHEAD.length;
    const by = p1.y - ((p1.y - p0.y) / len) * ARROWHEAD.length;
    const h = ARROWHEAD.half;
    return { x: Math.min(p1.x, bx) - h, y: Math.min(p1.y, by) - h, x2: Math.max(p1.x, bx) + h, y2: Math.max(p1.y, by) + h };
  });
  for (const row of svgEl.querySelectorAll(".pipeline-marks")) {
    if (row.style.display === "none") continue;
    const m = /translate\(\s*([-\d.]+)[\s,]+([-\d.]+)/.exec((row.parentNode.getAttribute && row.parentNode.getAttribute("transform")) || "");
    const dx = m ? Number(m[1]) : 0;
    const dy = m ? Number(m[2]) : 0;
    const boxes = [...row.querySelectorAll(":scope > .pm-mark")]
      .filter((mk) => mk.style.display !== "none")
      .map((mk) => {
        try {
          const b = mk.getBBox();
          return { x: b.x + dx - 2, y: b.y + dy - 2, x2: b.x + b.width + dx + 2, y2: b.y + b.height + dy + 2 };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const title = row.nextElementSibling && row.nextElementSibling.tagName.toLowerCase() === "text" ? row.nextElementSibling : null;
    // behold#571: the box's title is a mark too: a head over it lifts the row as well.
    if (title) {
      try {
        const b = title.getBBox();
        boxes.push({ x: b.x + dx - 2, y: b.y + dy - 2, x2: b.x + b.width + dx + 2, y2: b.y + b.height + dy + 2 });
      } catch {
        /* not laid out */
      }
    }
    if (!heads.some((h) => boxes.some((b) => hit(h, b)))) continue;
    const rect = svgEl.querySelector(`rect[data-group-id="wave-${row.getAttribute("data-pm-wave")}"]`);
    if (!rect) continue;
    if (!rect.hasAttribute("data-pm-y0")) {
      rect.setAttribute("data-pm-y0", rect.getAttribute("y"));
      rect.setAttribute("data-pm-h0", rect.getAttribute("height"));
    }
    if (title && !title.hasAttribute("data-pm-ty0")) title.setAttribute("data-pm-ty0", title.getAttribute("y"));
    const titleCy = title ? Number(title.getAttribute("y")) : null;
    rect.setAttribute("y", String(Number(rect.getAttribute("y")) - G));
    rect.setAttribute("height", String(Number(rect.getAttribute("height")) + G));
    if (title) title.setAttribute("y", String(titleCy - G));
    row.setAttribute("data-pm-cy", String(Number(row.getAttribute("data-pm-cy")) - G));
    for (const n of row.querySelectorAll(".pm-icon, .pm-label")) n.setAttribute("y", String(Number(n.getAttribute("y")) - G));
    // The job's status rides its title's line.
    if (title) {
      const tb = title.getBBox();
      for (const s of svgEl.querySelectorAll('[data-tg-root="wave-status"]')) {
        const y = Number(s.getAttribute("y"));
        if (Math.abs(y - (tb.y + tb.height / 2 + G + dy)) < tb.height) s.setAttribute("y", String(y - G));
      }
    }
    lifted.push([rect, G]);
  }
  return lifted;
}

/** The x's at which the graph's edges cross a band of the svg (`y0`..`y1`), in the svg's own coordinates. */
function edgeXsIn(svgEl, y0, y1) {
  const xs = [];
  for (const path of svgEl.querySelectorAll("g[data-edge-from] path, g[data-edge-from] line")) {
    let len = 0;
    try {
      len = path.getTotalLength();
    } catch {
      continue;
    }
    for (let d = 0; d <= len; d += 3) {
      const p = path.getPointAtLength(d);
      if (p.y >= y0 && p.y <= y1) xs.push(p.x);
    }
  }
  return xs;
}

/** The width of the job's status words a terragucci wave box will say after its title, or 0. */
function waveStatusRoom(svgEl, n) {
  if (!(terragucciComponentsRepo && tgComponentFacets && tgAnswer && !tgAnswer.error)) return 0;
  let w;
  try {
    w = tgComponentMarks(tgAnswerDrawn(), tgProgress, tgComponentFacets, { runs: tgRuns, pin: view.run || null }).waves[n];
  } catch {
    return 0;
  }
  if (!w || !w.status) return 0;
  const probe = document.createElementNS(SVGNS, "text");
  probe.setAttribute("font-size", "12");
  probe.setAttribute("font-weight", "700");
  probe.textContent = `· ${w.status.words}`;
  svgEl.appendChild(probe);
  let len = 0;
  try {
    len = probe.getComputedTextLength();
  } catch {
    len = probe.textContent.length * 7;
  }
  probe.remove();
  return len + 6 + 10;
}

/** Draw every wave box's row afresh: in the title row when the marks fit there with their icons, else in their own row under it. */
function drawPipelineMarks(svgEl) {
  for (const old of svgEl.querySelectorAll(".pipeline-marks")) old.remove();
  // A box an earlier draw grew for its marks' row goes back as pinhole drew it.
  for (const r of svgEl.querySelectorAll("rect[data-pm-y0]")) {
    r.setAttribute("y", r.getAttribute("data-pm-y0"));
    r.setAttribute("height", r.getAttribute("data-pm-h0"));
    r.removeAttribute("data-pm-y0");
    r.removeAttribute("data-pm-h0");
  }
  for (const tx of svgEl.querySelectorAll("text[data-pm-ty0]")) {
    tx.setAttribute("y", tx.getAttribute("data-pm-ty0"));
    tx.removeAttribute("data-pm-ty0");
  }
  const light = kioskLight();
  const pin = view.run || null;
  const commit = tgRunsCommit(pin, tgProgress);
  // behold#631: on a kiosk, a chant repo's forge and tool are named once, with their logos, in the kiosk's title line:
  // the wave boxes carry no marks of their own there. Inspect keeps them.
  const chantKiosk = !!(embedOpts.bare && view.components && chantFacets && !terragucciComponentsRepo);
  if (chantKiosk) return;
  const onlyWave = null;
  for (const rect of svgEl.querySelectorAll("rect[data-group-id]")) {
    const key = rect.getAttribute("data-group-id");
    const n = tgWaveOfKey(key);
    if (n === null) continue;
    if (onlyWave !== null && n !== onlyWave) continue;
    const what = pipelineMarksFor(n);
    if (!what) continue;
    const forge = what.forge && FORGES[what.forge] ? what.forge : null;
    const tools = what.tools.filter((t) => TOOLS[t]);
    if (!forge && !tools.length) continue;
    // The box's title: the text right after its rect (pinhole's order), inside the box's group once wrapped.
    let title = null;
    for (let el = rect.nextElementSibling; el; el = el.nextElementSibling) {
      if (el.tagName.toLowerCase() === "text") {
        title = el;
        break;
      }
      if (el.tagName.toLowerCase() === "rect") break;
    }
    const rx = Number(rect.getAttribute("x"));
    const ry = Number(rect.getAttribute("y"));
    const rw = Number(rect.getAttribute("width"));
    let tb = null;
    try {
      tb = title ? title.getBBox() : null;
    } catch {
      tb = null;
    }
    const cy = tb && tb.height ? tb.y + tb.height / 2 : ry + 10 + MARK.size / 2;
    const row = document.createElementNS(SVGNS, "g");
    row.setAttribute("class", "pipeline-marks");
    row.setAttribute("data-pm-wave", String(n));
    row.setAttribute("data-pm-right", String(rx + rw - MARK.pad));
    row.setAttribute("data-pm-cy", String(cy));
    row.setAttribute("data-pm-start", String(rx + 12));
    row.setAttribute("data-pm-end", String(rx + rw - 10));
    if (forge) {
      const f = FORGES[forge];
      const url = what.projection ? null : markLink(waveJobUrl(tgAnswer, n, commit), forge);
      const tip = what.projection ? `${key} is a ${f.label} CI stage of the pipeline chant generates` : markTitle(what.job, forge);
      const a = markElement("a", `pm-forge pm-forge-${forge}`, f, f.label, tip, light);
      if (url) {
        a.setAttribute("href", url);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      }
      row.appendChild(a);
    }
    for (const t of tools) {
      const tool = TOOLS[t];
      row.appendChild(markElement("g", `pm-tool pm-tool-${t}`, tool.icon, tool.name, what.job ? `${what.job} runs ${tool.name}` : `Runs ${tool.name}`, light));
    }
    // The edges that run through the title row, so the marks stand clear of them. Pinhole draws edges
    // in the svg's coordinates and a moved box carries a translate, so their x's are taken back into the box's.
    const shift = (() => {
      const m = /translate\(\s*([-\d.]+)/.exec((rect.parentNode.getAttribute && rect.parentNode.getAttribute("transform")) || "");
      return m ? Number(m[1]) : 0;
    })();
    const band = edgeXsIn(svgEl, cy - MARK.size / 2 - 2, cy + MARK.size / 2 + 2).map((x) => x - shift);
    row.setAttribute("data-pm-avoid", band.filter((x) => x >= rx && x <= rx + rw).map((x) => x.toFixed(1)).join(","));
    rect.parentNode.insertBefore(row, title || rect.nextSibling);
    // The title row holds the title, the job's status after it, then the marks; else the marks take their own row.
    const left = (tb && tb.width ? tb.x + tb.width : rx + 12) + 8 + waveStatusRoom(svgEl, n);
    row.setAttribute("data-pm-left", String(left));
    if (titleRowFits(row, left)) continue;
    rect.setAttribute("data-pm-y0", rect.getAttribute("y"));
    rect.setAttribute("data-pm-h0", rect.getAttribute("height"));
    if (title) title.setAttribute("data-pm-ty0", title.getAttribute("y"));
    marksOwnRow(row, rect, title);
  }
}

// Paint a fetched graph: the SVG, the meta line (with a drift summary in overlay
// mode), the legend, and click-inspect wiring. Shared by load() and refresh().
function render(ir, svg, m) {
  // #131: set before anything can early-return, so a level that stopped
  // degrading stops explaining itself on the very next render.
  lastNote = m.note || null;
  lastNoteShort = m.noteShort || null;
  // The panel's Model tab reads both of these via renderStatusbar() →
  // renderPanel() below — set them first so it renders THIS graph, not the
  // previous one (recolorNodesByCategory also sets lastGraphIr; harmless).
  lastMeta = m;
  lastGraphIr = ir;
  // #284 item 2: the ops lens answers with the run state it painted with and
  // the pending gate card it built (which knows the declared step the gate
  // holds back — the SPA can't derive that from runState alone). Only the ops
  // lens carries them; every other lens leaves the playhead exactly as it was.
  // (render() ends with renderDial(), so the panel picks these up there.)
  if (m.mode === "ops") {
    if (m.run) runState = m.run;
    gateCard = m.gate || null;
    // #234 join 3: the lens's answer carries which ConvergeOps the project
    // DECLARES (read from the same op.json it just parsed — no subprocess). The
    // strip's content arrives from the poll below.
    if (m.operator) operatorState = m.operator;
  }
  const overlay = m.mode === "overlay";
  // Logical/architecture lens (#63): its own mode, but when an env is picked the
  // projected nodes still carry the drift `_status`, so it reads as a drift view
  // (same summary + legend as the entity overlay).
  const logical = m.mode === "logical";
  const drift = overlay || (logical && !!m.env);
  // M1.1 (#57): the component DAG's live per-component AWS status — a
  // different join than the entity overlay (see server's /api/graph), so it
  // gets its own summary + legend rather than reusing `overlay`'s.
  const componentStatus = m.mode === "component-status";
  let tail = ` · ${ir.edges.length} edges`;
  if (drift) {
    // Summarise drift so "everything's blue" reads as "N pending". `neutral`
    // (chant#1168, #1089) is its own bucket — a declared node chant couldn't
    // read live state for is neither managed, foreign, nor (confirmed)
    // pending, and folding it into any of those would misreport a hole in
    // the observation as a verdict. Additive: a chant predating #1168 never
    // tags a node `neutral` here, so `c.neutral` stays 0 against an older chant.
    // `runtime` (chant#1180, #1077) is its own bucket too — a live,
    // undeclared node whose owner chain reaches a declared entity is neither
    // managed, foreign, nor pending; folding it into any of those would
    // misreport expected runtime as drift or as a proposed create. Additive
    // the same way — `c.runtime` stays 0 against a chant predating #1180.
    const c = { good: 0, warn: 0, accent: 0, neutral: 0, runtime: 0 };
    for (const n of ir.nodes) {
      const s = n.attrs && n.attrs._status;
      if (s in c) c[s]++;
    }
    // #393 item 8: the estate's own words for these four colours — chant's
    // managed/foreign/pending/unobserved on a chant estate, choudoufu's
    // bound/unowned/pending/not observed on one whose members are choudoufu.
    const w = statusLabels();
    tail = ` · ${c.good} ${w.good} · ${c.warn} ${w.warn} · ${c.accent} ${w.accent}`;
    if (c.neutral) tail += ` · ${c.neutral} ${w.neutral}`;
    if (c.runtime) tail += ` · ${c.runtime} runtime`;
    // #404: beside the ownership counts, never folded into them — a drifted
    // card is bound and is already inside `c.good`. Silent when no plan was
    // read, so the strip never implies the question was asked and answered.
    const dm = driftMeta();
    if (dm && dm.read) tail += ` · ${dm.drifted} drifted`;
    // Nothing observed live in this env — explain the all-blue rather than let it
    // read as a bug (#32).
    if (c.good === 0 && c.warn === 0 && c.accent > 0) tail += ` — nothing deployed in ${m.env} yet`;
  } else if (componentStatus) {
    // M2 (#54): 4 buckets now (good/accent/warn/neutral) — see
    // COMPONENT_STATUS_LABEL and src/component-status.ts's palette doc comment.
    const c = { good: 0, accent: 0, warn: 0, neutral: 0 };
    for (const n of ir.nodes) {
      const s = n.attrs && n.attrs._status;
      if (s in c) c[s]++;
    }
    tail = ` · ${c.good} healthy · ${c.accent} in progress · ${c.warn} rollback/failed · ${c.neutral} not deployed`;
  }
  // Multi-estate (#31): note the composed project count; the graph draws one box per project.
  // #186: the meta line lives in the panel's 272px footer now — the directory
  // basename reads better than an absolute path (full path in the tooltip).
  // #393 item 4: one member is a project, not "1 projects".
  const scope = m.estate
    ? `estate of ${m.estate} project${m.estate === 1 ? "" : "s"}`
    : String(m.projectDir || "").replace(/\/+$/, "").split("/").pop() || m.projectDir;
  // The deploy axes (#59 unify, M2 #54 lenses) — tier/target, kept in sync with
  // what this response actually observed (falls back to the launch-time value
  // from /api/project when a route doesn't echo them, e.g. /api/overlay).
  if (m.tier !== undefined) axes.tier = m.tier;
  if (m.target !== undefined) axes.target = m.target;
  // A snapshot's target is the host it was captured from (a localhost
  // emulator, usually), which means nothing to whoever reads the page.
  const axesTail = `${axes.tier ? " · tier " + axes.tier : ""}${axes.target && !staticMode ? " · target " + axes.target : ""}`;
  const metaEl = document.getElementById("meta");
  metaEl.title = m.projectDir || "";
  // #195: the browser tab names the loaded project — with the header gone
  // (#186) the title bar is free chrome, and it's what shows in cmd-tab /
  // tab-hover when several behold instances are up.
  document.title = `behold — ${scope}`;
  metaEl.textContent =
    `${scope}${m.env ? " · env " + m.env : ""}${axesTail}${overlay ? " · overlay" : ""}${logical ? " · logical" : ""}${m.components ? " · components" : ""}${componentStatus ? " · live status" : ""} · ${ir.nodes.length} nodes${tail}`;
  // Keep the persistent state strip + the floating panel in sync (the panel's
  // Model tab is what replaced the two old header legends).
  renderStatusbar();
  const g = document.getElementById("graph");
  // Ghostty theming (#62): strip pinhole's baked-in `:root{--pin-*}` defaults from the
  // inlined SVG so its var(--pin-*) fills resolve from behold's live documentElement tokens
  // (theme.js applyTheme), not the frozen dark palette. Without this, every theme renders
  // green — the SVG's own :root shadows behold's override within the graph subtree.
  g.innerHTML = svg.replace(/:root\s*\{[^{}]*--pin-[^{}]*\}/g, "");
  recolorNodesByCategory(ir); // #62: category-hued fills from the theme's full palette
  markStatusChanges(ir, componentStatus ? COMPONENT_STATUS_VAR : DRIFT_STATUS_VAR); // #229
  const svgEl = g.querySelector("svg");
  if (svgEl) {
    // Drop pinhole's fixed pixel size so the viewBox drives sizing; behold then
    // pans/zooms by mutating the viewBox (setupGraphViewBox + the wheel/drag
    // handlers). Starts fit-to-pane, then pinch / ⌘+scroll zooms, drag pans.
    svgEl.removeAttribute("width");
    svgEl.removeAttribute("height");
    svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
    // behold#571: the kiosk's frame drops the cards' kind and meta lines.
    if (embedOpts.bare) quietCardLines(svgEl);
    setupGraphViewBox(svgEl);
    wireEdgeHighlight(svgEl, ir);
    markTrace(); // #881: a trace stays marked across a redraw
  }
  // #712: only the dots preview's meta carries `dots`. #715: a live carve, when the gate opened.
  if (svgEl && m && m.dots) {
    mountDots({ host: g, svg: svgEl, meta: m, vbInit: vbInit.slice(), getVB: () => vb, setVB: (a) => { vb = a.slice(); vbAtFit = false; applyVB(); } })
      .then(fitClearOfRail)
      .catch((err) => console.warn("dots preview:", err));
  } else if (svgEl && liveCarve) mountLiveCarve(g, svgEl);
  else unmountDots();
  ensureZoomControls(g);
  ensureBackToInfra(g);
  wire(ir);
  if (view.radial && !view.components && !view.logical && !view.ops) addRadialLabels(ir);
  markCarvedCards(); // #254: the SVG is replaced per render — re-stamp the marker
  markPlayhead(ir); // #284 item 2: same, for the step the run is sitting on
  markOperatorCards(ir); // #234 free rider: same, for the operating loop's home
  markIdentityCards(ir); // the identity mark: a tag badge on the card's top-right edge
  markDriftedCards(ir); // #404: same, for a bound card the plan would change — after the carve/operator stamps, so it can see and yield to them
  markPendingCards(ir); // #422: and the cards whose member has not answered yet
  markTerragucciCards(); // #490: and what terragucci's reports found, dated
  markYodelCards(); // #526: and SQL Yodeler's drift, dated
  if (csAnswer) markChangeSetCards(); // #681: and the change set a gate binds, as a preview
  if (flAnswer) markFlagCards(); // #683: and the feature flags of each flagged member
  if (coAnswer) markCollisionCards(); // #684: and the nodes two in-flight work items touch
  syncHealth(m); // #825: and runtime health, with the records out of rotation
  applyLayout(); // #228: last, so the hand-placed deltas ride on top of every other pass
  drawTgReads(); // #568: after the layout, so the reads lines meet the cards where they now sit
  renderDial();
}

// The radial layout clusters each component into an angular wedge, but nothing
// says which wedge is which. Label each: read every node's position from its
// `data-node-id` transform (SVG/viewBox coords, so labels pan/zoom with the
// graph), group by component, and drop the component name just outside its
// wedge at its mean angle. Cue only — pointer-events off so clicks pass through.
function radialGroupOf(node) {
  const p = (node.sourceLoc?.file || "").split("/");
  if (p[0] === "src" && p[1] === "examples") return "examples";
  if (p[0] === "src" && p.length >= 3) return p[1];
  return node.lexicon || "other";
}
function addRadialLabels(ir) {
  const svg = document.querySelector("#graph svg");
  if (!svg) return;
  const groupOf = new Map(ir.nodes.map((n) => [n.id, radialGroupOf(n)]));
  const pos = new Map();
  for (const g of svg.querySelectorAll("[data-node-id]")) {
    const m = (g.getAttribute("transform") || "").match(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)/);
    if (m) pos.set(g.getAttribute("data-node-id"), { x: +m[1], y: +m[2] });
  }
  if (pos.size < 2) return;
  let cx = 0, cy = 0;
  pos.forEach((p) => { cx += p.x; cy += p.y; });
  cx /= pos.size; cy /= pos.size;
  const groups = new Map(); // key -> {sx,sy,n,maxR}
  pos.forEach((p, id) => {
    const k = groupOf.get(id);
    if (!k) return;
    const dx = p.x - cx, dy = p.y - cy;
    const g = groups.get(k) || { sx: 0, sy: 0, n: 0, maxR: 0 };
    g.sx += dx; g.sy += dy; g.n++; g.maxR = Math.max(g.maxR, Math.hypot(dx, dy));
    groups.set(k, g);
  });
  const NS = "http://www.w3.org/2000/svg";
  const layer = document.createElementNS(NS, "g");
  layer.setAttribute("id", "radial-labels");
  layer.setAttribute("pointer-events", "none");
  const vb = (svg.getAttribute("viewBox") || "0 0 1000 1000").split(/\s+/).map(Number);
  const fontSize = Math.max(18, Math.round(vb[2] / 60));
  groups.forEach((g, key) => {
    const ang = Math.atan2(g.sy, g.sx);
    const r = g.maxR + fontSize * 2.2;
    const x = cx + r * Math.cos(ang), y = cy + r * Math.sin(ang);
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", x);
    t.setAttribute("y", y);
    t.setAttribute("text-anchor", Math.abs(Math.cos(ang)) < 0.4 ? "middle" : Math.cos(ang) < 0 ? "end" : "start");
    t.setAttribute("dominant-baseline", "middle");
    t.setAttribute("fill", "var(--fg)");
    t.setAttribute("opacity", "0.72");
    t.setAttribute("font-size", String(fontSize));
    t.setAttribute("font-weight", "700");
    t.textContent = key;
    layer.appendChild(t);
  });
  svg.appendChild(layer);
}

// When observe (or the zoom picker) drops you into the components view, float a
// "zoom in ⤢" link on the graph itself — the exit where the eye already is, not
// buried in the toolbar. Zooms one step finer (components → resources). Shown
// only in the components view.
function ensureBackToInfra(host) {
  let link = document.getElementById("back-to-infra");
  if (!link) {
    link = document.createElement("button");
    link.id = "back-to-infra";
    link.textContent = "zoom in ⤢ resources";
    link.title = "Zoom finer — from components to the resource graph.";
    link.addEventListener("click", (e) => {
      e.stopPropagation();
      applyZoom("resources");
      load();
    });
    host.appendChild(link);
  }
  link.style.display = view.components ? "" : "none";
}

// --- Graph zoom/pan, driven by the SVG viewBox (works for a 7-node DAG or a
// 180-node estate alike: fit-to-pane by default, then zoom IN to read). Pinch
// or ⌘/Ctrl+scroll zooms at the cursor; drag pans; "⤢ fit" resets. ---
let vb = null; // current viewBox [x,y,w,h]
let vbInit = null; // the graph's natural viewBox (fit)
let panMoved = false; // true once a drag moved — suppresses the node click on release
let zoomWired = false;

function setupGraphViewBox(svg) {
  const a = (svg.getAttribute("viewBox") || "").split(/\s+/).map(Number);
  if (a.length === 4 && a.every((n) => !Number.isNaN(n))) {
    vbInit = a.slice();
    // #396 item 2: land on the fit that keeps the panel's footprint clear, not
    // on the raw box — a re-render (a zoom change, an env change, the SSE
    // re-pull) goes through here and never through fitGraph, so the first
    // column would slide back under the panel at every one of them.
    vb = fittedViewBox() || a.slice();
    vbAtFit = true;
    applyVB();
    // behold#571: in the kiosk's Watch mode a re-render keeps the shot the kiosk asked for.
    if (kioskShot) queueMicrotask(() => applyKioskShot(false));
    // behold#915: a re-render keeps the shot's lights and framing.
    if (shotFrameDone) queueMicrotask(() => shotFrameApply());
  } else {
    vbInit = vb = null;
  }
}
function currentSvg() {
  return document.querySelector("#graph svg");
}
function applyVB() {
  const s = currentSvg();
  if (s && vb) s.setAttribute("viewBox", vb.join(" "));
  scaleBoxLabels(); // #396 item 7b: box titles/badges keep a legible size at every zoom
  scaleEdgeLabels(); // behold#824: an edge's label keeps a legible size too
  dotsCamera(); // #712: a no-op unless the dots preview is mounted
  kioskTellBoxes(); // behold#571: the kiosk's overlays ride the boxes they describe
}

// #396 item 2: the panel is `position: fixed` and floats OVER the graph pane
// (index.html), so "fit the pane" put the leftmost column of cards underneath
// it — a whole column of the terralith, half waterpark's `github` box — at
// boot and after every re-render. The panel is furniture the reader cannot see
// through, so the fit's target is the pane MINUS whatever the panel is
// currently covering.
//
// Read at fit time, never remembered: the panel drags, docks to either side and
// collapses to its tab bar, and a fit computed against where it used to be is
// the same bug with a different offset. Collapsed or hidden → no footprint, and
// the fit is the whole pane exactly as before.
//
// Horizontal only. The panel is a tall palette that docks left or right; a
// top/bottom dock still leaves the full width, and insetting vertically for it
// would shrink the graph for a strip the cards mostly clear anyway.
const FIT_PANEL_MAX = 0.45; // the panel can never claim more than this of the pane

function panelInsets(pane) {
  const none = { left: 0, right: 0 };
  const p = document.getElementById("panel");
  if (!p || p.classList.contains("collapsed")) return none;
  const cs = getComputedStyle(p);
  if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return none;
  const r = p.getBoundingClientRect();
  if (!r.width || !r.height) return none;
  // Nothing to inset for a panel that has been dragged clear of the graph pane.
  if (r.bottom <= pane.top || r.top >= pane.bottom || r.right <= pane.left || r.left >= pane.right) return none;
  const cap = pane.width * FIT_PANEL_MAX;
  // Whichever side it is nearer to is the side it eats.
  return (r.left + r.right) / 2 < (pane.left + pane.right) / 2
    ? { left: Math.min(cap, Math.max(0, r.right - pane.left)), right: 0 }
    : { left: 0, right: Math.min(cap, Math.max(0, pane.right - r.left)) };
}

// behold#729: the dots zoom rail floats on the pane's right edge, so a fit or a
// kiosk shot that ignores it leaves the rightmost cards under it. Read at fit
// time like the panel: Watch hides it, a held stage and a directing carve fade
// it out, and then it covers nothing.
const RAIL_GAP = 8;
function railInset(pane) {
  const rail = document.querySelector("#dots-ui .dots-rail");
  if (!rail) return 0;
  const cs = getComputedStyle(rail);
  if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return 0;
  const r = rail.getBoundingClientRect();
  if (!r.width || r.bottom <= pane.top || r.top >= pane.bottom || r.left >= pane.right) return 0;
  return Math.min(pane.width * 0.3, Math.max(0, pane.right - r.left + RAIL_GAP));
}

/**
 * The viewBox that fits the whole graph into the pane's UNCOVERED part.
 *
 * The returned box is given the pane's own aspect ratio, so `xMidYMid meet`
 * letterboxes nothing and the pane's pixels map to viewBox units at one known
 * scale: the graph is then placed by arithmetic — centred inside the band
 * between the insets, centred vertically — instead of wherever `meet` would
 * have dropped it. With no insets the result is pixel-identical to the old
 * `vb = vbInit`, which is why nothing without a panel over it moves.
 */
function fittedViewBox() {
  if (!vbInit) return null;
  const host = document.getElementById("graph");
  if (!host) return null;
  const pane = host.getBoundingClientRect();
  const [x0, y0, w0, h0] = vbInit;
  if (!(pane.width > 0 && pane.height > 0 && w0 > 0 && h0 > 0)) return null;
  const { left, right: panelRight } = panelInsets(pane);
  const right = Math.max(panelRight, railInset(pane));
  const band = Math.max(1, pane.width - left - right);
  const s = Math.min(band / w0, pane.height / h0);
  const vw = pane.width / s;
  const vh = pane.height / s;
  return [x0 - left / s - (band / s - w0) / 2, y0 - (vh - h0) / 2, vw, vh];
}

function fitGraph() {
  if (!vbInit) return;
  if (kioskShot) return applyKioskShot(false); // behold#571: the kiosk's shot stands in for the fit
  vb = fittedViewBox() || vbInit.slice();
  vbAtFit = true;
  applyVB();
}

// #396 item 2: the fit now depends on the pane — its size, and what the panel
// covers of it — where `vbInit` alone depended on neither, so a graph sitting
// at fit has to be re-fitted when the pane moves under it. It moves more often
// than a window resize: the statusbar's note wraps onto a second line, the
// inspect pane is dragged wider, a panel tab's content grows. Only while the
// view IS the fit: a pan or a zoom takes ownership of the viewBox, and nothing
// here may pull it back out from under the reader's hands.
let vbAtFit = false;
function watchPaneForFit(host) {
  if (typeof ResizeObserver === "undefined") return;
  // The refit waits for the last size change and sets the view directly: no swoop, and a resize burst fits once.
  // It moves the viewBox, never the host's box, so the observer cannot trigger itself.
  // Each change also sets the view at once, so a box is never off screen on the old framing while the burst lasts.
  const refit = debounced(refitNow);
  const onSize = () => (refitNow(), refit());
  new ResizeObserver(onSize).observe(host);
  window.addEventListener("resize", onSize);
  // Web fonts change the text's width, and with it the boxes.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refitNow, () => {});
}
/** Fit again as things stand, at once. Idempotent: a fit that is already right sets nothing. */
function refitNow() {
  if (kioskShot) applyKioskShot("now");
  else if (vbAtFit) fitGraph();
}

// --- #396 item 7b: box titles and badges that survive the fit ---------------
//
// pinhole draws a group box's title at a flat `font-size="12"` and its badge at
// `11`, in viewBox UNITS. That reads as 12px on a graph whose fit is 1:1 and as
// 7px on terralith-4, whose box is 8000 units wide — the one label that says
// which member 301 cards belong to, and the one that counts them, are the two
// things on the canvas a person cannot read at the zoom they arrive at.
//
// So the label is given a floor in SCREEN pixels: its size in units is raised
// by the inverse of the current scale until it renders at its natural size, and
// never below it, so anything already legible is untouched (zoomed IN, the
// attribute is left at 12 and grows with the graph, exactly as before). The
// anchor never moves — x, y and `text-anchor` are pinhole's — so a title stays
// welded to its box's top-left corner and a badge to its top-right through
// every pan and zoom; only the type gets bigger.
//
// The floor yields to the box: a label may not grow past a fraction of the
// box's height, nor past its width. A sub-box too small to hold readable type at this zoom says
// so by staying small, rather than by writing across its neighbours. A title
// pinhole's own size can't fit across its box shrinks to fit.
//
// pinhole's baseline is set for its own size, so a title grown in place would
// rise out through the box's top edge. As it grows its baseline steps down
// by the same amount, keeping its top inside the box.
const BOX_LABEL_PAD = 6; // units between a box's top edge and the top of its grown title
const BOX_LABEL_ASCENT = 0.95; // the font's ascent above the baseline, as a fraction of the size
const BOX_LABEL_MIN = 7; // the smallest a title shrinks to fit across its box
const BOX_LABEL_GUTTER = 34; // units below a box's top edge that the title row occupies
const BOX_LABEL_MAX_H = 8; // a label may be at most box height / this
const BOX_LABEL_EM = 0.62; // rough advance width per char, as a fraction of the size

let boxLabelCache = { svg: null, labels: [] };
let boxLabelScale = null;

/** The `<text>` elements pinhole put in each group box's title gutter, with the
 * box they belong to and the size it drew them at. Matched by geometry rather
 * than by sibling order: a box's optional identity mark sits between the title
 * and the badge, and #228's layout pass lifts the rect and its title into a
 * wrapper `<g>` after the render, so neither order nor a common parent holds.
 * What geometry alone would let through — a card's own text, an edge chip's —
 * is excluded by the ancestor it sits under. */
function boxLabelsOf(svg) {
  if (boxLabelCache.svg === svg) return boxLabelCache.labels;
  const labels = [];
  const boxes = [];
  for (const rect of svg.querySelectorAll("rect[data-group-id]")) {
    const b = {
      x: parseFloat(rect.getAttribute("x")),
      y: parseFloat(rect.getAttribute("y")),
      w: parseFloat(rect.getAttribute("width")),
      h: parseFloat(rect.getAttribute("height")),
    };
    if ([b.x, b.y, b.w, b.h].every((n) => Number.isFinite(n))) boxes.push(b);
  }
  if (boxes.length) {
    for (const t of svg.querySelectorAll("text")) {
      const x = parseFloat(t.getAttribute("x"));
      const y = parseFloat(t.getAttribute("y"));
      // pinhole's own size, stashed the first time so a re-index can never
      // read a size this pass already raised as if it were the natural one.
      const base = parseFloat(t.dataset.pinFont ?? t.getAttribute("font-size"));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(base)) continue;
      // Not a card's own text (inside its `g[data-node-id]`), not an edge
      // chip's (inside the edge's `g`), not a radial wedge label behold adds
      // itself. What is left at a box's title row IS the box's title row.
      if (t.closest("[data-node-id], [data-edge-from], [data-edge-to], #radial-labels")) continue;
      const box = boxes.find((b) => y > b.y && y <= b.y + BOX_LABEL_GUTTER && x >= b.x - 2 && x <= b.x + b.w + 2);
      if (!box) continue;
      t.dataset.pinFont = String(base);
      labels.push({ el: t, box, base, y, shift: 0 });
    }
  }
  boxLabelCache = { svg, labels };
  boxLabelScale = null;
  return labels;
}

/** Re-size every box label for the current zoom. Cheap and idempotent: the
 * scale is remembered, so the pan handler's stream of `applyVB` calls (which
 * move the viewBox without changing its width) touches no attribute at all. */
function scaleBoxLabels() {
  const svg = currentSvg();
  if (!svg || !vb) return;
  const labels = boxLabelsOf(svg);
  if (!labels.length) return;
  const pane = svg.getBoundingClientRect();
  if (!(pane.width > 0 && pane.height > 0)) return;
  const scale = Math.min(pane.width / vb[2], pane.height / vb[3]);
  if (!(scale > 0) || scale === boxLabelScale) return;
  boxLabelScale = scale;
  for (const l of labels) {
    const chars = Math.max(4, (l.el.textContent || "").length);
    const across = (l.box.w - 2 * BOX_LABEL_PAD) / (chars * BOX_LABEL_EM);
    const floor = Math.max(BOX_LABEL_MIN, Math.min(l.base, across));
    const cap = Math.max(floor, Math.min(l.box.h / BOX_LABEL_MAX_H, across));
    const size = Math.round(Math.max(floor, Math.min(l.base / scale, cap)) * 10) / 10;
    l.el.setAttribute("font-size", String(size));
    // Step the baseline down as far as the title grew; read y live, since a placement move shifts it.
    const shift = Math.max(0, l.box.y + BOX_LABEL_PAD + size * BOX_LABEL_ASCENT - l.y);
    if (shift !== l.shift) {
      const y = parseFloat(l.el.getAttribute("y"));
      if (Number.isFinite(y)) l.el.setAttribute("y", String(Math.round((y - l.shift + shift) * 10) / 10));
      l.shift = shift;
    }
  }
  declutterBoxHeads(labels);
}

/**
 * A narrow box can't hold its title and its count badge on one row: the two
 * ran into each other ("awscards · all managed"). The title is the box's
 * name, so it keeps the row; the badge steps aside and becomes the box's
 * tooltip instead, and comes back once the zoom leaves it room (behold#824).
 */
function declutterBoxHeads(labels) {
  const byBox = new Map();
  for (const l of labels) (byBox.get(l.box) ?? byBox.set(l.box, []).get(l.box)).push(l.el);
  for (const els of byBox.values()) {
    const badge = els.find((t) => t.getAttribute("text-anchor") === "end");
    const title = els.find((t) => t !== badge);
    if (!badge || !title) continue;
    badge.style.display = "";
    let clash = false;
    try {
      const a = title.getBBox();
      const b = badge.getBBox();
      clash = a.x + a.width + 6 > b.x;
    } catch {
      continue;
    }
    badge.style.display = clash ? "none" : "";
    const rect = title.parentNode && title.parentNode.querySelector(":scope > rect[data-group-id]");
    if (rect && clash && !rect.querySelector(":scope > title")) {
      const tip = document.createElementNS(SVGNS, "title");
      tip.textContent = `${rect.getAttribute("data-group-id")}: ${badge.textContent}`;
      rect.appendChild(tip);
    }
  }
}

// behold#824: an edge's label (`import`, `HealthCheckId`) is drawn at 10.5
// units, which on a graph fitted at a quarter scale is under 3px, and enlarged
// to be readable there it piles onto the cards around it. So a label shows at
// its own size once the zoom makes it readable (EDGE_LABEL_MIN_PX on screen),
// and below that it is hidden unless its edge is lit: hovering a card lights
// every edge on it (`.edge-hi`), and hovering an edge peeks its own labels.
// A lit small label is drawn up to EDGE_LABEL_MAX_K times larger, so it can be
// read; only a card's few edges light at once, so they don't pile up.
const EDGE_LABEL_MIN_PX = 8;
const EDGE_LABEL_MAX_K = 4;
let edgeLabelState = { svg: null, scale: null };

function scaleEdgeLabels() {
  const svg = currentSvg();
  if (!svg || !vb) return;
  const pane = svg.getBoundingClientRect();
  if (!(pane.width > 0 && pane.height > 0)) return;
  const scale = Math.min(pane.width / vb[2], pane.height / vb[3]);
  if (!(scale > 0) || (edgeLabelState.svg === svg && edgeLabelState.scale === scale)) return;
  edgeLabelState = { svg, scale };
  for (const g of svg.querySelectorAll("g[data-edge-via]")) {
    const text = g.querySelector(":scope > text");
    const rect = g.querySelector(":scope > rect");
    if (!text) continue;
    const size = parseFloat(text.getAttribute("font-size")) || 10.5;
    const small = size * scale < EDGE_LABEL_MIN_PX;
    g.toggleAttribute("data-label-small", small);
    // A small label shows only while its edge is lit, a few at a time, so it
    // is drawn big enough to read then, scaled about its pill's centre.
    const k = small ? Math.min(EDGE_LABEL_MAX_K, EDGE_LABEL_MIN_PX / (size * scale)) : 1;
    const cx = rect ? Number(rect.getAttribute("x")) + Number(rect.getAttribute("width")) / 2 : Number(text.getAttribute("x"));
    const cy = rect ? Number(rect.getAttribute("y")) + Number(rect.getAttribute("height")) / 2 : Number(text.getAttribute("y"));
    const t = k === 1 ? null : `translate(${cx} ${cy}) scale(${Math.round(k * 100) / 100}) translate(${-cx} ${-cy})`;
    for (const el of rect ? [rect, text] : [text]) t ? el.setAttribute("transform", t) : el.removeAttribute("transform");
  }
}

/** Hovering an edge shows the labels that belong to it, however far out the zoom. */
function wireEdgeLabelPeek(svgEl) {
  const labelsOf = (from, to) => svgEl.querySelectorAll(`g[data-edge-from="${CSS.escape(from)}"][data-edge-to="${CSS.escape(to)}"][data-edge-via]`);
  svgEl.addEventListener("mouseover", (e) => {
    const g = e.target.closest && e.target.closest("g[data-edge-from]");
    if (!g) return;
    for (const l of labelsOf(g.getAttribute("data-edge-from"), g.getAttribute("data-edge-to"))) l.classList.add("label-peek");
  });
  svgEl.addEventListener("mouseout", (e) => {
    const g = e.target.closest && e.target.closest("g[data-edge-from]");
    if (!g) return;
    for (const l of labelsOf(g.getAttribute("data-edge-from"), g.getAttribute("data-edge-to"))) l.classList.remove("label-peek");
  });
}

// How much of the viewBox one card should take when ⌘K lands on it (#393): the
// window is this many card-widths across, so a 301-card estate arrives readable
// rather than at whatever zoom the last gesture left. Never wider than the fit,
// which is the whole graph — there is nothing beyond it to show.
const REVEAL_CARDS_ACROSS = 9;

/**
 * Pan (and zoom) the graph so one card sits in the middle of the pane (#393
 * item 4). The same viewBox the wheel/drag handlers drive and "⤢ fit" resets —
 * there was no programmatic pan before this, only the reset.
 *
 * The card's rectangle comes from the DOM rather than from the IR: pinhole
 * paints a card as a `<g data-node-id>` whose first `<rect>` carries absolute
 * viewBox coordinates (no transform on the estate view, unlike the radial one),
 * and `getBBox()` covers whichever it is. Returns false when there is no such
 * card on the canvas — a node the current zoom elided — so the caller can say
 * so instead of panning to nowhere.
 */
function revealNode(id) {
  const svg = currentSvg();
  if (!svg || !vb || !vbInit) return false;
  const g = svg.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
  if (!g) return false;
  let box;
  try {
    box = g.getBBox();
  } catch {
    const r = g.querySelector("rect");
    if (!r) return false;
    box = { x: +r.getAttribute("x"), y: +r.getAttribute("y"), width: +r.getAttribute("width"), height: +r.getAttribute("height") };
  }
  if (!box.width || !box.height) return false;
  const w = Math.min(vbInit[2], Math.max(box.width * REVEAL_CARDS_ACROSS, vbInit[2] / 60));
  const h = w * (vbInit[3] / vbInit[2]);
  vb = [box.x + box.width / 2 - w / 2, box.y + box.height / 2 - h / 2, w, h];
  vbAtFit = false;
  applyVB();
  return true;
}
function ensureZoomControls(host) {
  let btn = document.getElementById("zoom-toggle");
  if (!btn || btn.parentElement !== host) {
    btn = document.createElement("button");
    btn.id = "zoom-toggle";
    btn.textContent = "⤢ fit";
    btn.title = "Reset to fit. Pinch or ⌘/Ctrl+scroll to zoom at the cursor; drag to pan.";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      fitGraph();
    });
    host.appendChild(btn);
  }
  if (zoomWired) return;
  zoomWired = true;
  watchPaneForFit(host);
  host.addEventListener(
    "wheel",
    (e) => {
      // Trackpad pinch fires wheel+ctrlKey; ⌘/Ctrl+scroll is the explicit gesture.
      // Plain scroll is left alone (nothing to scroll when fit), except in the kiosk's
      // bare frame: the graph is the whole stage there, so a mouse wheel zooms it, as a map's does.
      if (!vb || !(e.ctrlKey || e.metaKey || wheelZoomsBare(embedOpts.bare, e))) return;
      e.preventDefault();
      const s = currentSvg();
      if (!s) return;
      const r = s.getBoundingClientRect();
      const cx = vb[0] + ((e.clientX - r.left) / r.width) * vb[2];
      const cy = vb[1] + ((e.clientY - r.top) / r.height) * vb[3];
      const f = Math.exp(wheelPx(e) * 0.0025); // scroll up → f<1 → zoom in
      // While the dots layer draws the roster's cards, no further in than a little past them: past that is an empty stage.
      const minW = Math.max(vbInit[2] / 60, dotsMinViewWidth() ?? 0);
      const maxW = vbInit[2] * (dotsZoomOutFactor() ?? 3); // #712: the dots preview zooms out further
      const nw = Math.min(maxW, Math.max(minW, vb[2] * f));
      const nh = nw * (vb[3] / vb[2]);
      vb[0] = cx - ((cx - vb[0]) * nw) / vb[2];
      vb[1] = cy - ((cy - vb[1]) * nh) / vb[3];
      vb[2] = nw;
      vb[3] = nh;
      vbAtFit = false;
      applyVB();
      kioskViewerMoved();
    },
    { passive: false },
  );
  // behold#571: on a touch screen (the kiosk on a phone), one finger pans and two pinch to zoom.
  let touch = null;
  const touchPoints = (e) => [...e.touches].map((t) => ({ x: t.clientX, y: t.clientY }));
  host.addEventListener(
    "touchstart",
    (e) => {
      if (!vb) return;
      touch = { pts: touchPoints(e), moved: false };
    },
    { passive: true },
  );
  host.addEventListener(
    "touchmove",
    (e) => {
      const s = currentSvg();
      if (!touch || !vb || !s) return;
      const pts = touchPoints(e);
      // The kiosk on a phone leaves one finger to the page's scroll, until a gesture has had two.
      if (kioskTouch() && pts.length < 2 && !touch.pinched) return;
      if (pts.length >= 2) touch.pinched = true;
      const r = s.getBoundingClientRect();
      e.preventDefault();
      if (pts.length >= 2 && touch.pts.length >= 2) {
        const dist = (p) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1;
        const mid = (p) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });
        const f = dist(touch.pts) / dist(pts);
        const m = mid(pts);
        const m0 = mid(touch.pts);
        const cx = vb[0] + ((m.x - r.left) / r.width) * vb[2];
        const cy = vb[1] + ((m.y - r.top) / r.height) * vb[3];
        const nw = Math.min(vbInit[2] * (dotsZoomOutFactor() ?? 3), Math.max(vbInit[2] / 60, dotsMinViewWidth() ?? 0, vb[2] * f));
        const nh = nw * (vb[3] / vb[2]);
        vb[0] = cx - ((cx - vb[0]) * nw) / vb[2] - ((m.x - m0.x) / r.width) * nw;
        vb[1] = cy - ((cy - vb[1]) * nh) / vb[3] - ((m.y - m0.y) / r.height) * nh;
        vb[2] = nw;
        vb[3] = nh;
      } else if (pts.length === 1 && touch.pts.length === 1) {
        vb[0] -= ((pts[0].x - touch.pts[0].x) / r.width) * vb[2];
        vb[1] -= ((pts[0].y - touch.pts[0].y) / r.height) * vb[3];
      }
      if (!touch.moved && touch.pts.length && Math.abs(pts[0].x - touch.pts[0].x) + Math.abs(pts[0].y - touch.pts[0].y) > 3) touch.moved = true;
      if (touch.moved) panMoved = true;
      touch.pts = pts;
      vbAtFit = false;
      applyVB();
      if (touch.moved || pts.length >= 2) kioskViewerMoved();
    },
    { passive: false },
  );
  host.addEventListener("touchend", (e) => {
    touch = e.touches.length ? { pts: touchPoints(e), moved: !!(touch && touch.moved), pinched: !!(touch && touch.pinched) } : null;
  });
  let drag = false;
  let px = 0;
  let py = 0;
  host.addEventListener("mousedown", (e) => {
    if (!vb) return;
    // #228: pan is the default on empty ground, but a node card (or a box's
    // title / resize handle) belongs to the layout drag — starting a pan too
    // would move the graph out from under the thing you grabbed. The layout
    // drag owns the panMoved latch for the rest of the gesture.
    if (layoutTargetOf(e)) return;
    drag = true;
    panMoved = false;
    px = e.clientX;
    py = e.clientY;
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag || !vb) return;
    const s = currentSvg();
    if (!s) return;
    const r = s.getBoundingClientRect();
    const dx = e.clientX - px;
    const dy = e.clientY - py;
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      panMoved = true;
      s.classList.add("grabbing");
    }
    vb[0] -= (dx / r.width) * vb[2];
    vb[1] -= (dy / r.height) * vb[3];
    vbAtFit = false;
    px = e.clientX;
    py = e.clientY;
    applyVB();
    if (panMoved) kioskViewerMoved();
  });
  window.addEventListener("mouseup", () => {
    drag = false;
    const s = currentSvg();
    if (s) s.classList.remove("grabbing");
  });
}

// --- Hand layout (#228): drag a node, resize a containment box -------------
// dagre is a good first draft and a bad final layout. A pointer-drag on a card
// writes a {dx,dy} for that `data-node-id`; a corner handle on a containment
// box writes {dw,dh} (and its title drags the box). The deltas live in
// localStorage per project + lens (web/layout-store.js) and are re-applied at
// the end of every render(), so the graph underneath stays chant's and a
// delta for a node that left the estate is simply not applied.
//
// Two tiers now (#228's second half): localStorage, and the server's per-user
// layout cache (outside the project, #469) behind GET/POST /api/layout. On load the server's map
// merges UNDER the local one (`mergeLayouts` — the drag you can see always
// wins); on a finished gesture the current lens is POSTed, debounced. A server
// that refuses — a static export, preview mode, an unwritable cache, an older
// behold with no such route — leaves the localStorage tier working exactly as
// it did before, and says nothing.
//
// What this does NOT do, said plainly rather than faked:
//   * a resized box does not reflow its children — that is dagre's job on the
//     next layout, and the reset control's tooltip says so;
//   * an edge touching a displaced node is redrawn as a STRAIGHT line between
//     its original anchor points, each shifted by its own node's delta. #228
//     accepts the straight-line fallback; spline re-routing is pinhole's job.
//     An edge with both ends where dagre put them keeps its bezier untouched.
//     Everything anchored TO that edge rides with it (#267): both paths in the
//     group — the visible line and pinhole's fat transparent hit-path — and the
//     `viaAttr` chip, which lands on the new midpoint (see edgeLabelOf).
//     A box's title needs nothing: pinhole paints it at the rect's top-left
//     corner, which is the one corner a resize never moves, and a box move
//     translates the whole wrapper group the title is already inside.
//   * the server bakes {dx,dy} into an exported SVG but not a box's {dw,dh} —
//     only pinhole's ARCHITECTURE boxes carry an id to bake against, and a bake
//     that worked on some lenses and not others would be worse than none
//     (src/layout.ts says the same at more length).
let layoutIndex = null; // {nodes,boxes,edges} for the SVG currently on screen
let layoutDeltas = {}; // the deltas in force for the current key
let layoutDrag = null; // the gesture in flight
let layoutWired = false;
// The sidecar tier, cached per lens: one GET when a lens is first shown, not
// one per render (render() runs on every SSE nudge and every settle poll).
let layoutServer = { lens: null, deltas: {}, writable: false };

/** The storage key for the project + lens on screen; null before /api/project lands. */
function currentLayoutKey() {
  if (!projectInfo) return null;
  return layoutKey(projectKeyOf(projectInfo), currentLensKey());
}

/** The lens half of the key — also what /api/layout is keyed by (the project
 * half is implicit there: the sidecar lives inside the project). */
function currentLensKey() {
  return lensKeyOf({ zoom: zoomValue(), radial: view.radial, stack: view.stack });
}

/**
 * Wrap each containment box in a `<g data-layout-box>` and give it a corner
 * handle, once per rendered SVG.
 *
 * ONE WAY TO FIND A BOX (#250, closed): `rect[data-group-id]` — pinhole stamps
 * the group key on every layout's boxes from 0.3.5 (layoutArchitecture since
 * 0.3.3, pinhole#103/#104; layoutIr's wave/stack/container boxes via
 * pinhole#111), the same hook `data-node-id` gives a card. That key is also
 * what the box's delta is stored under, so a box keeps its size when its title
 * changes and two boxes that happen to read alike stay separate placements.
 * The structural match #245 shipped (rx sniff + next-sibling text + svg-root
 * parentage, marked fragile by construction) served its one fallback release
 * and is deleted — the ^0.3.5 floor guarantees the attribute.
 *
 * Identification runs over a DOM nothing has moved yet and the wrapping happens
 * after: the title walk reads `nextElementSibling`, and inserting a wrapper
 * mid-walk would put one box's `<g>` in the middle of the next box's member run.
 *
 * MIGRATION, said plainly: a box that gains an id changes storage key —
 * `layoutArchitecture` titles a box `<id>  ·  <kind>`, so `box:vpc  ·  VPC`
 * becomes `box:vpc` — and `applicable` drops the old key on the next render.
 * That is a deliberate one-time loss of hand-set box sizes on the logical
 * views, taken rather than carrying a key-rewriting migration for a delta that
 * is cosmetic and one drag to redo. Node placements are untouched: they were
 * always keyed by `data-node-id`.
 */
function wrapContainmentBoxes(svgEl) {
  const boxes = new Map();
  const handleSize = Math.max(12, Math.round((vbInit ? vbInit[2] : 1000) / 90));
  const found = [];
  const claimed = new Set();
  for (const rect of [...svgEl.children]) {
    if (rect.tagName.toLowerCase() !== "rect") continue;
    const groupId = (rect.getAttribute("data-group-id") || "").trim();
    const x = parseFloat(rect.getAttribute("x"));
    const y = parseFloat(rect.getAttribute("y"));
    const w = parseFloat(rect.getAttribute("width"));
    const h = parseFloat(rect.getAttribute("height"));
    if (!(w > 0) || !(h > 0) || Number.isNaN(x) || Number.isNaN(y)) continue;
    // An unstamped rect is not a group box — the page-background rects and any
    // decoration pinhole paints at the root stay untouched.
    if (!groupId) continue;
    // Collect rect → title, stepping over anything already stamped between
    // them (the GitLab wave badge), and bail at the next box or card.
    const members = [rect];
    let title = null;
    for (let el = rect.nextElementSibling; el; el = el.nextElementSibling) {
      const tag = el.tagName.toLowerCase();
      if (tag === "rect" || (tag === "g" && (el.hasAttribute("data-node-id") || el.hasAttribute("data-edge-from")))) break;
      members.push(el);
      if (tag === "text") {
        title = el;
        break;
      }
    }
    // A titleless box keeps its resize handle and simply has no drag-by-title.
    // It also keeps nothing but its own rect: the walk above only stops at a
    // title, so without one it has swept up whatever pinhole painted next,
    // which is not this box's to move.
    const id = `box:${groupId}`;
    if (claimed.has(id)) continue;
    claimed.add(id);
    found.push({ id, rect, members: title ? members : [rect], title, x, y, w, h });
  }
  for (const { id, rect, members, title, x, y, w, h } of found) {
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("data-layout-box", id);
    rect.parentNode.insertBefore(g, rect);
    members.forEach((m) => g.appendChild(m));
    // The title doubles as the box's move handle — the interior stays pan
    // territory, which on a logical view is most of the canvas.
    if (title) {
      title.setAttribute("data-layout-move", id);
      title.setAttribute("cursor", "move");
    }
    const handle = document.createElementNS(SVGNS, "g");
    handle.setAttribute("data-layout-resize", id);
    handle.setAttribute("cursor", "nwse-resize");
    handle.setAttribute("opacity", "0"); // CSS reveals it on hover; a static export never shows it
    const grip = document.createElementNS(SVGNS, "rect");
    grip.setAttribute("width", String(handleSize));
    grip.setAttribute("height", String(handleSize));
    grip.setAttribute("rx", "3");
    grip.setAttribute("fill", "var(--focus)");
    const tip = document.createElementNS(SVGNS, "title");
    tip.textContent = "Drag to resize this box. Children don't move with it — that's the next layout's job.";
    handle.append(tip, grip);
    g.appendChild(handle);
    boxes.set(id, { g, rect, handle, x, y, w0: w, h0: h, size: handleSize });
  }
  return boxes;
}

/** Park the corner handle at the box's current bottom-right. */
function positionBoxHandle(b, w, h) {
  b.handle.setAttribute("transform", `translate(${b.x + w - b.size - 3}, ${b.y + h - b.size - 3})`);
}

/** A box's rect as it stands right now: pinhole's, plus whatever the hand did to
 * it. One definition for the painter and for the clamp, so growing a box really
 * does buy its children room (#267) and cannot drift from what you can see. */
function boxRect(b, d) {
  return {
    x: b.x + ((d && d.dx) || 0),
    y: b.y + ((d && d.dy) || 0),
    w: Math.max(b.size * 3, b.w0 + ((d && d.dw) || 0)),
    h: Math.max(b.size * 3, b.h0 + ((d && d.dh) || 0)),
  };
}

/** Screen pixels → this SVG's own user units, as a function. Null when the SVG
 * isn't laid out (a hidden pane, a detached document) — and a null mapper means
 * no measured geometry, which the clamp reads as "don't clamp". */
function userSpaceMapper(svgEl) {
  const m = svgEl.getScreenCTM && svgEl.getScreenCTM();
  if (!m || typeof svgEl.createSVGPoint !== "function") return null;
  const inv = m.inverse();
  const pt = svgEl.createSVGPoint();
  return (x, y) => {
    pt.x = x;
    pt.y = y;
    return pt.matrixTransform(inv);
  };
}

/** An element's box in SVG user units. MEASURED, not parsed off attributes:
 * pinhole's cards carry absolute coordinates and no transform, the smoke stub's
 * carry a `translate()`, and a measurement holds either without this code
 * knowing which. Only ever taken on a freshly rendered SVG, before any delta is
 * painted — it is the dagre-placed rect the clamp reasons about. */
function userRect(el, toUser) {
  if (!toUser || typeof el.getBoundingClientRect !== "function") return null;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0)) return null;
  const a = toUser(r.left, r.top);
  const b = toUser(r.right, r.bottom);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/**
 * The chip pinhole paints on a labelled edge (`project`, `sourceRef`,
 * `selector` — the IR edge's `viaAttr`), or null if this edge has none.
 *
 * HOW THE TWO ARE ASSOCIATED: pinhole stamps the chip group with its edge's
 * own `data-edge-from`/`data-edge-to` (pinhole#110, 0.3.5 — the same ask boxes
 * made and won with `data-group-id`), so the pair is an attribute match. The
 * chip is the stamped sibling that holds no `path` — the line group always
 * carries one. The sibling-order + text-sniffing inference this replaces
 * (#267/#271) went with the ^0.3.5 floor.
 *
 * Still read at index time and kept as an element reference, never re-derived:
 * wireEdgeHighlight's `raise()` re-appends hovered groups, so document order is
 * unstable even though identity now isn't.
 */
function edgeLabelOf(g) {
  if (!(g.getAttribute("data-edge-via") || "").trim()) return null;
  // The pair and the kind (pinhole#128, #564): two kinds on one pair draw two
  // lines with a chip each, and each line keeps its own chip.
  const key = edgeKeyOf(g);
  for (const cand of g.parentNode ? g.parentNode.children : []) {
    if (cand === g || cand.tagName.toLowerCase() !== "g") continue;
    if (!cand.hasAttribute("data-edge-from") || edgeKeyOf(cand) !== key) continue;
    if (cand.hasAttribute("data-node-id") || cand.querySelector("path")) continue;
    return cand;
  }
  return null;
}

/** A drawn edge group's identity, pinhole's `edgeKey` over its stamped
 * attributes (no `data-edge-kind` is a reference). */
function edgeKeyOf(g) {
  return edgeKey({ from: g.getAttribute("data-edge-from"), to: g.getAttribute("data-edge-to"), kind: g.getAttribute("data-edge-kind") || "ref" });
}

/** Index the freshly rendered SVG: node groups, containment boxes, edge paths. */
function indexLayout(svgEl) {
  const toUser = userSpaceMapper(svgEl);
  const nodes = new Map();
  for (const el of svgEl.querySelectorAll("[data-node-id]")) {
    const id = el.getAttribute("data-node-id");
    if (!nodes.has(id)) nodes.set(id, { el, base: el.getAttribute("transform") || "", rect: userRect(el, toUser) });
  }
  const edges = [];
  for (const g of svgEl.querySelectorAll("g[data-edge-from]")) {
    const paths = [...g.querySelectorAll("path")];
    if (!paths.length) continue;
    const d0 = paths[0].getAttribute("d");
    const label = edgeLabelOf(g);
    edges.push({
      from: g.getAttribute("data-edge-from"),
      to: g.getAttribute("data-edge-to"),
      paths,
      d0,
      anchors: pathAnchors(d0),
      label,
      labelBase: label ? label.getAttribute("transform") || "" : "",
    });
  }
  layoutIndex = { nodes, boxes: wrapContainmentBoxes(svgEl), edges };
}

/**
 * The box a card sits in, geometrically — the containment is visual and nothing
 * in the DOM says which card belongs to which box. The SMALLEST box whose
 * CURRENT rect covers the card's original centre wins, so a card in a namespace
 * nested inside a cluster clamps to the namespace, not the cluster.
 *
 * `current` is the load-bearing word: growing a box is the sanctioned way to
 * make room, so the wall a drag stops at has to be the box as it is now.
 */
function containerOf(rect) {
  if (!layoutIndex || !rect) return null;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  let best = null;
  for (const [id, b] of layoutIndex.boxes) {
    const r = boxRect(b, layoutDeltas[id]);
    if (cx < r.x || cx > r.x + r.w || cy < r.y || cy > r.y + r.h) continue;
    if (!best || r.w * r.h < best.w * best.h) best = r;
  }
  return best;
}

/** A node's delta, clamped to whatever contains it: its box, or failing that
 * the canvas pinhole drew (`vbInit` — the graph's own extent, NOT the panned
 * and zoomed `vb`, which is just where you happen to be looking).
 *
 * Nodes only. A box's own gesture is the escape hatch, so clamping a box would
 * put the only way to make room behind the wall it enforces. And an id with no
 * measured rect is returned untouched — see clampDelta on failing open. */
function clampNodeDelta(id, delta) {
  const n = layoutIndex && layoutIndex.nodes.get(id);
  if (!n || !n.rect) return delta;
  const canvas = vbInit ? { x: vbInit[0], y: vbInit[1], w: vbInit[2], h: vbInit[3] } : null;
  const bounds = containerOf(n.rect) || canvas;
  return bounds ? clampDelta(delta, n.rect, bounds) : delta;
}

/** Bring every stored node delta back inside its container. Clamped, never
 * discarded (#267): a placement made before this rule existed — or against a
 * box someone has since shrunk — keeps everything about it except the part that
 * escaped. Box deltas are read as-is, which is why this runs after they land. */
function clampStoredDeltas(deltas) {
  if (!layoutIndex) return deltas;
  let out = deltas;
  for (const id of layoutIndex.nodes.keys()) {
    const d = out[id];
    if (!d || (!d.dx && !d.dy)) continue;
    const c = clampNodeDelta(id, d);
    if (c.dx !== (d.dx || 0) || c.dy !== (d.dy || 0)) out = setDelta(out, id, { ...d, dx: c.dx, dy: c.dy });
  }
  return out;
}

/** Paint `layoutDeltas` onto the indexed SVG. Idempotent: always from the original. */
function renderLayout() {
  if (!layoutIndex) return;
  for (const [id, n] of layoutIndex.nodes) {
    const t = nodeTransform(n.base, layoutDeltas[id] || {});
    if (t) n.el.setAttribute("transform", t);
    else n.el.removeAttribute("transform");
  }
  for (const [id, b] of layoutIndex.boxes) {
    const d = layoutDeltas[id] || {};
    const { w, h } = boxRect(b, d);
    b.rect.setAttribute("width", String(w));
    b.rect.setAttribute("height", String(h));
    // The title rides inside this same group, and pinhole anchors it to the
    // rect's top-left — the one corner a resize leaves alone — so a box's
    // caption never detaches from its box (#267 asked; nothing to fix).
    if (d.dx || d.dy) b.g.setAttribute("transform", `translate(${d.dx || 0}, ${d.dy || 0})`);
    else b.g.removeAttribute("transform");
    positionBoxHandle(b, w, h);
  }
  for (const e of layoutIndex.edges) {
    const a = layoutDeltas[e.from];
    const z = layoutDeltas[e.to];
    if ((!a && !z) || !e.anchors) {
      if (e.paths[0].getAttribute("d") !== e.d0) e.paths.forEach((p) => p.setAttribute("d", e.d0));
      placeEdgeLabel(e, 0, 0);
      continue;
    }
    const d = straightEdge(e.anchors, a, z);
    // EVERY path in the group: the visible line and pinhole's 14-wide
    // transparent hit-path both, so the edge you can grab stays under the edge
    // you can see.
    e.paths.forEach((p) => p.setAttribute("d", d));
    // The chip was painted at the midpoint of the two anchors, so the midpoint
    // of the re-anchored line is that point plus the MEAN of the two ends'
    // deltas. No re-reading of the chip's own coordinates, and no assumption
    // about how pinhole spelled them.
    placeEdgeLabel(e, (((a && a.dx) || 0) + ((z && z.dx) || 0)) / 2, (((a && a.dy) || 0) + ((z && z.dy) || 0)) / 2);
  }
}

/** Shift an edge's label chip by `(sx,sy)`, from its painted position. Composed
 * onto whatever transform it was painted with (none, today) and removed when
 * the shift is zero — so this is idempotent, like the rest of renderLayout. */
function placeEdgeLabel(e, sx, sy) {
  if (!e.label) return;
  const t = nodeTransform(e.labelBase, { dx: sx, dy: sy });
  if (t) e.label.setAttribute("transform", t);
  else e.label.removeAttribute("transform");
}

/** Re-index the SVG, load this lens's deltas, paint them. Called from render(). */
function applyLayout() {
  const svgEl = currentSvg();
  const host = document.getElementById("graph");
  if (!svgEl || !host) return;
  indexLayout(svgEl);
  reloadLayoutDeltas();
  ensureLayoutReset(host);
  ensureViewToggles(host);
  ensureLayoutDrag(host);
  const lens = currentLensKey();
  if (currentLayoutKey() && layoutServer.lens !== lens) pullServerLayout(lens);
}

/** Recompute both tiers onto the SVG already indexed, and repaint. Separate
 * from applyLayout() because it must NOT re-index: renderLayout paints from
 * each node's ORIGINAL transform, so re-indexing an already-painted SVG would
 * take the displaced transform as the new base and apply the delta twice. */
function reloadLayoutDeltas() {
  if (!layoutIndex) return;
  const key = currentLayoutKey();
  const lens = currentLensKey();
  // Stale ids are dropped on apply, not on write: a lens the user hasn't
  // opened in a while shouldn't have its deltas quietly deleted because this
  // render happened to be a different projection of the same estate.
  const merged = key ? mergeLayouts(readLayout(localStorage, key), layoutServer.lens === lens ? layoutServer.deltas : {}) : {};
  layoutDeltas = applicable(merged, [...layoutIndex.nodes.keys(), ...layoutIndex.boxes.keys()]);
  layoutDeltas = clampStoredDeltas(layoutDeltas);
  renderLayout();
}

/** One GET per lens. Whatever comes back is merged UNDER the local tier and
 * repainted; a refusal is cached as an empty, unwritable answer, so a serve
 * with no sidecar (or no server at all) costs exactly one request per lens. */
async function pullServerLayout(lens) {
  layoutServer = { lens, deltas: {}, writable: false }; // claim it first — no request storm
  const got = await fetchServerLayout(apiFetch, lens);
  if (layoutServer.lens !== lens) return; // the view moved on while we waited
  layoutServer = { lens, ...got };
  if (!Object.keys(got.deltas).length || currentLensKey() !== lens) return;
  reloadLayoutDeltas();
  ensureLayoutReset(document.getElementById("graph"));
}

/** Push the current lens to the sidecar, once the hand has stopped moving.
 * Nothing here is load-bearing: `writable` false (static export, preview mode,
 * read-only project, older behold) simply never pushes, and a failed push is
 * not reported — the localStorage tier already has it. */
const pushServerLayout = debounce((lens, deltas) => {
  if (staticMode || publicMode || !layoutServer.writable || layoutServer.lens !== lens) return;
  postServerLayout((url, init) => fetch(url, init), lens, deltas);
}, 600);
// A reload (or a tab closing) within the debounce window would otherwise drop
// the last placement on the floor — localStorage has it, the sidecar wouldn't.
// The push rides `keepalive`, so it survives the document.
window.addEventListener("pagehide", () => pushServerLayout.flush());

/** The grabbable thing at or above `el`, if any. */
function layoutTargetIn(el) {
  if (!el || typeof el.closest !== "function") return null;
  const resize = el.closest("[data-layout-resize]");
  if (resize) return { kind: "resize", id: resize.getAttribute("data-layout-resize") };
  const move = el.closest("[data-layout-move]");
  if (move) return { kind: "move", id: move.getAttribute("data-layout-move") };
  const node = el.closest("[data-node-id]");
  if (node) return { kind: "move", id: node.getAttribute("data-node-id") };
  return null;
}

/** What (if anything) a pointerdown grabbed. Also the pan handler's bail test. */
function layoutTargetOf(e) {
  const direct = layoutTargetIn(e.target);
  if (direct) return direct;
  // An edge can swallow the grab: wireEdgeHighlight raises every edge on a
  // hovered card to the top of the SVG, and pinhole's 14-wide transparent
  // hit-path is anchored at the card's own centre — so by the time the pointer
  // is down, the edge you just lit is lying across the card you meant to move.
  // Look through the stack for the card underneath instead of giving up.
  if (!e.target || typeof e.target.closest !== "function" || !e.target.closest("g[data-edge-from]")) return null;
  for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
    const t = layoutTargetIn(el);
    if (t) return t;
  }
  return null;
}

/** Screen pixels → viewBox units at the current zoom. */
function userPerPixel(svgEl) {
  const m = svgEl.getScreenCTM && svgEl.getScreenCTM();
  if (m && m.a && m.d) return { x: 1 / m.a, y: 1 / m.d };
  const r = svgEl.getBoundingClientRect();
  return vb && r.width && r.height ? { x: vb[2] / r.width, y: vb[3] / r.height } : { x: 1, y: 1 };
}

function ensureLayoutDrag(host) {
  if (layoutWired) return;
  layoutWired = true;
  host.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !layoutIndex) return;
    // behold#571: in the kiosk's bare frame a finger pans the graph; it never moves a card.
    if (e.pointerType === "touch" && embedOpts.bare) return;
    const t = layoutTargetOf(e);
    if (!t || !currentSvg()) return;
    layoutDrag = { ...t, x0: e.clientX, y0: e.clientY, base: layoutDeltas[t.id] || {}, moved: false };
    // The same latch pan uses (wire()'s click-inspect bails on it): claim it on
    // grab so a drag is never also a click, and so the NEXT plain click on a
    // node isn't swallowed by a stale `true` from the gesture before it.
    panMoved = false;
    // Deliberately no preventDefault(): cancelling pointerdown suppresses the
    // compatibility mouse events, and click-inspect rides on those. The pan is
    // held off by its own guard instead, and the text selection a drag would
    // otherwise smear across the graph by `user-select: none` on the SVG.
  });
  window.addEventListener("pointermove", (e) => {
    if (!layoutDrag) return;
    const svgEl = currentSvg();
    if (!svgEl) return;
    const px = e.clientX - layoutDrag.x0;
    const py = e.clientY - layoutDrag.y0;
    if (!layoutDrag.moved && Math.abs(px) + Math.abs(py) <= 3) return;
    layoutDrag.moved = true;
    panMoved = true;
    const s = userPerPixel(svgEl);
    const dx = px * s.x;
    const dy = py * s.y;
    const b = layoutDrag.base;
    const next =
      layoutDrag.kind === "resize"
        ? { dx: b.dx || 0, dy: b.dy || 0, dw: (b.dw || 0) + dx, dh: (b.dh || 0) + dy }
        : { dx: (b.dx || 0) + dx, dy: (b.dy || 0) + dy, dw: b.dw || 0, dh: b.dh || 0 };
    // #267: the card stops at its box's wall while the pointer keeps going. A
    // no-op for a box id and for a resize, and the box's CURRENT size is what
    // is read — so widening a box mid-session immediately buys its children the
    // room, no re-render needed.
    layoutDeltas = setDelta(layoutDeltas, layoutDrag.id, clampNodeDelta(layoutDrag.id, next));
    renderLayout();
  });
  window.addEventListener("pointerup", () => {
    if (!layoutDrag) return;
    const moved = layoutDrag.moved;
    layoutDrag = null;
    if (!moved) return;
    const key = currentLayoutKey();
    if (key) writeLayout(localStorage, key, layoutDeltas);
    // The sidecar gets the WHOLE lens map, not the one id that moved: it is a
    // per-lens document, and the local tier is the authority the user is
    // looking at. Debounced, so a drag is one write and not sixty.
    if (key) pushServerLayout(currentLensKey(), layoutDeltas);
    ensureLayoutReset(document.getElementById("graph"));
  });
}

/** The "↺ placement" control beside ⤢ fit — shown only while something is hand-placed. */
function ensureLayoutReset(host) {
  if (!host) return;
  let btn = document.getElementById("layout-reset");
  if (!btn || btn.parentElement !== host) {
    btn = document.createElement("button");
    btn.id = "layout-reset";
    btn.textContent = "↺ placement";
    btn.title =
      "Put every card and box you moved on this lens back where behold placed them. " +
      "(A resized box never reflows what's inside it; only the next layout does that.)";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = currentLayoutKey();
      if (key) clearLayout(localStorage, key);
      // Both tiers, or it isn't a reset: clearing only localStorage would let
      // the next merge pull the sidecar's deltas straight back in.
      const lens = currentLensKey();
      layoutServer = { lens, deltas: {}, writable: layoutServer.lens === lens && layoutServer.writable };
      pushServerLayout(lens, {});
      layoutDeltas = {};
      renderLayout();
      ensureLayoutReset(host);
      nowline("↺ placement reset: every card is back where behold placed it");
    });
    host.appendChild(btn);
  }
  btn.style.display = isEmpty(layoutDeltas) ? "none" : "";
}

// Precondition-failure codes (#72) → a short, human title for the entry/error
// screen below. Mirrors every `code` a read route's structured error can
// carry (src/server.ts RouteErrorCode: chant.ts's lint/not-installed/eval,
// plus "tier" — a picked tier that needs creds this host lacks, M2 #54).
const PRECONDITION_TITLE = {
  lint: "This project doesn't pass chant lint",
  "not-installed": "This project isn't installed",
  tier: "This tier needs credentials",
  eval: "chant couldn't evaluate this project",
  // #193: behold was pointed at a directory that isn't a chant project at all
  // — the first screen must say so, not draw a blank graph.
  "no-project": "This isn't a chant project",
  // #252: carve mode is served a `chant carve advise --json` report, not a
  // project — so a bad file is a bad REPORT, and the card must not blame chant
  // for failing to evaluate a project that was never involved.
  "carve-report": "This isn't a carve report",
};

// A precondition failure — the lint gate, a not-installed/no-typegen project,
// or a tier that needs credentials (#72) — gets a readable card with chant's
// own message and a suggested remedy, not a blank canvas or a raw stack
// trace. Generalizes what used to be a tier-only `tierNote` (the server now
// sends the same structured {error, code, remedy} for every classified
// failure — src/server.ts errorResponse). Text content only (never
// innerHTML) — `error` embeds chant's own stderr verbatim.
function renderPreconditionError(body) {
  const host = document.getElementById("graph");
  host.innerHTML = "";
  const card = document.createElement("div");
  card.className = "precondition-error";
  const title = document.createElement("div");
  title.className = "precondition-error-title";
  title.textContent = PRECONDITION_TITLE[body.code] || "chant couldn't evaluate this project";
  card.appendChild(title);
  if (body.error) {
    const message = document.createElement("div");
    message.className = "precondition-error-message";
    message.textContent = body.error;
    card.appendChild(message);
  }
  if (body.remedy) {
    const remedy = document.createElement("div");
    remedy.className = "precondition-error-remedy";
    remedy.textContent = body.remedy;
    card.appendChild(remedy);
  }
  // #259: the rest of the /api error payload. The card above is the human
  // reading — code, error, remedy — but the server sends more than those three
  // (chant's argv, exit code, the endpoint it queried), and until now that
  // detail was simply dropped on the floor. Collapsed by default so the calm
  // card stays calm, copyable in one gesture for a bug report.
  const raw = document.createElement("div");
  raw.className = "precondition-error-raw";
  const label = document.createElement("div");
  label.className = "precondition-error-rawlabel";
  label.textContent = "response payload";
  raw.append(label, renderJson(body, { openDepth: -1 }));
  card.appendChild(raw);
  host.appendChild(card);
}

// A kiosk frame's graph refused its checkout (a precondition: a chant project whose packages the view never
// installed fails lint). A composed run's scene is drawn from the run's reports in place of the graph's cards
// (web/kiosk-estate-scene.js), so it needs none of the graph: once the reports hold a scene, the frame draws it on an
// empty svg instead of the refusal's card. A frame whose reports hold no scene keeps the card.
let graphRefusal = null;
const SCENE_ONLY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600"></svg>';
function sceneInPlaceOfRefusal() {
  if (!refusalHoldsScene({ refusal: graphRefusal, bare: embedOpts.bare, answer: tgAnswer })) return false;
  const note = `the graph is not drawn (${graphRefusal.code}): the run's reports draw the scene`;
  graphRefusal = null;
  render({ nodes: [], edges: [], groups: [] }, SCENE_ONLY_SVG, { note, noteShort: note });
  afterPaint({ nodes: [] });
  return true;
}

// Fetch the current view (source graph, or the picked env's live overlay).
const load = createRefreshQueue(loadOnce);
async function loadOnce(opts = {}, isCurrent = () => true) {
  const meta = document.getElementById("meta");
  // #422: set when this load asks for the progressive overlay; `frameLoad` is
  // its turn in memberFrames, so an older load's end never releases a newer one.
  let progressive = false;
  let frameLoad = 0;
  // A background settle re-pull (post-apply) shouldn't flash the meta/overlay.
  if (!opts.quiet) {
    meta.textContent = view.env ? `loading overlay for ${view.env}…` : "loading…";
    // A view change shells chant live (seconds on a slow box) — cover the UI with
    // a blocking overlay so clicks can't queue a second pull mid-flight.
    showLoading(`loading ${zoomValue()}${view.env ? " · " + view.env : ""}…`);
  }
  try {
    let q = lensParams(new URLSearchParams({ detail: String(view.detail) }));
    let endpoint = "/api/graph";
    // #712: the dots preview's source rides along; absent from every other page's URL.
    const dotsSource = new URLSearchParams(location.search).get("dots");
    if (view.components) {
      // M1.1 (#57): the component DAG stays on /api/graph even with an env
      // picked — the server joins live per-component status onto it there
      // (component name -> CFN stack), instead of routing to /api/overlay's
      // cross-substrate entity overlay, which components never use.
      q.set("components", "1");
      if (view.env) q.set("env", view.env);
      // behold#741: a chapter-carrying scenario's fan-out wave as one block per parent, as chant's loop lays it out.
      if (tgStoryOn()) q.set("blocks", "1");
      // The kiosk's frame of a choudoufu estate (the held small stage): its waves in a row, wave 1 on the left, so
      // the graph's shape is the stage's and the held framing can zoom in as far as the width allows. A story's
      // fan-out (fan-out-choudoufu) keeps its blocks.
      else if (embedOpts.bare && projectInfo && projectInfo.terragucciChoudoufu) q.set("waves", "row");
    } else if (view.stacks) {
      // The apply-order lens (#426): chant's cross-stack ordering, built fresh
      // for the same reason the ops lens is — it reads none of the entity
      // knobs. No env (it is computed at synthesis, with no substrate), no
      // detail, no radial. Tier rides along because a project's source can
      // branch on one, which can change which lexicons it partitions into.
      q = new URLSearchParams({ stacks: "1" });
      if (view.tier) q.set("tier", view.tier);
    } else if (view.ops) {
      // The ops lens (#284): the declared Ops, read from each Op's emitted
      // op.json. Built fresh rather than layered onto the entity lenses,
      // because this view reads NONE of them — no env, no detail, no radial,
      // and no tier (a tier re-evaluates tier-conditioned source, and an Op's
      // IR was already resolved at build). Sending them anyway would also give
      // a static export a different key per tier for one identical snapshot.
      // `entities=1` (chant#2022): link each step to the estate cards its
      // contract-declared entity args name. It is the one thing on the ops
      // branch that may read a member IR (through the cache the graph above
      // already warmed), so it is asked for explicitly rather than implied.
      q = new URLSearchParams({ ops: "1", entities: "1" });
      // #284 item 2: this is the view run state paints over, so this is when
      // it's worth shelling chant for the one thing the record stream can't
      // carry — whether a gate is pending. Asked once per lens load; the
      // in-flight run has its own tick above. The server only broadcasts a
      // CHANGED answer, so this can't chase its own re-pull.
      pollRunStatus();
      // #234 join 3: same pull-not-push discipline for the operating loop — ask
      // once per lens load, and only from the lens the strip lives on.
      pollOperatorStatus();
    } else if (view.logical) {
      // Logical/architecture lens (#63): the server re-projects at detail 3
      // regardless of the dial, so detail/radial don't apply. With an env it
      // projects the live overlay (drift colours preserved), else the source.
      q.set("logical", "1");
      if (view.env) {
        endpoint = "/api/overlay";
        q.set("env", view.env);
      }
    } else if (view.env) {
      endpoint = "/api/overlay";
      q.set("env", view.env);
      // #422: draw the estate from source at once and recolour each member as
      // its own live read lands, instead of a blank canvas until the slowest
      // one finishes. The server only honours it for a composed estate, and
      // never in a static snapshot, where there is no stream to follow.
      if (!staticMode) {
        q.set("progressive", "1");
        progressive = true;
      }
      // The runtime tier (#86) descends below the declaration boundary. It is
      // live-only by nature — owner-referenced children exist in the cluster,
      // never in your source — so it rides the overlay and means nothing
      // without an env.
      if (view.runtime) q.set("runtime", "1");
      // #404: the attribute-drift read, when this load is the one the person
      // asked for it on. Consumed here — the next load goes without it.
      if (planDriftOnce || view.plan) {
        q.set("plan", "1"); // behold#922: a view with plan=1 reads the plan on every load
        planDriftOnce = false;
      }
    } else if ((terraformPlanOnce || view.plan) && !view.components) {
      // #910: the plan on the stock Terraform roots, read through chant onto
      // the source graph's cards. One-shot, like #404's above.
      q.set("plan", "1");
      terraformPlanOnce = false;
    }
    // Radial layout (entity view only) — curl the wide DAG onto concentric rings.
    if (view.radial && !view.components && !view.logical && !view.ops) q.set("radial", "1");
    // Collapse large boxes (#393): a member box over the server's limit draws
    // as one card carrying its counts. An estate-box lens — the component DAG
    // and the ops view have no member boxes to shut — and it rides both the
    // source graph and the overlay, so picking an env doesn't undo it.
    if (view.collapse && !view.components && !view.ops) q.set("collapse", "1");
    // #877: an estate stacks alike cards by default; `alike=0` draws every card.
    if (!view.alike && !view.components && !view.logical && !view.ops) q.set("alike", "0");
    // The CI + resources facets are component-DAG-mode-only details. Load
    // both whenever components mode is on, env picked or not — #59 unifies
    // the CI facet (#58), the live-status join (#57), and resources (#59) so
    // a component node's inspect panel shows all of them at once, not just one.
    if (view.components) {
      await Promise.all([loadCi(), loadResources()]);
    } else {
      ciByComponent = new Map();
      resourcesByComponent = {};
    }
    if (progressive) frameLoad = memberFrames.begin();
    if (dotsSource) q.set("dots", dotsSource);
    const res = await apiFetch(`${endpoint}?${q}`);
    const body = await res.json();
    if (!isCurrent()) return; // a newer view/event is pending; do not paint the old result
    if (!res.ok) {
      // #72: a classified precondition failure (lint gate, not installed, a
      // tier that needs credentials) gets the calmer entry/error card instead
      // of the generic red error box — see renderPreconditionError().
      if (body.code) {
        graphRefusal = embedOpts.bare ? body : null;
        if (sceneInPlaceOfRefusal()) return;
        renderPreconditionError(body);
        meta.textContent = body.code === "tier" ? `tier ${view.tier} unavailable here` : "error";
        renderDial();
        return;
      }
      throw new Error(body.error || res.statusText);
    }
    // #182: an empty first components view → re-load at the resources zoom
    // instead of painting a blank pane. Checked before render() so the blank
    // graph never flashes; the loading scrim stays up across the second fetch
    // (showLoading is ref-counted).
    if (autoZoomFallback && view.components && !((body.ir && body.ir.nodes) || []).length) {
      autoZoomFallback = false;
      applyZoom("resources");
      renderStatusbar();
      return loadOnce(opts, isCurrent);
    }
    autoZoomFallback = false;
    // #422: a progressive answer names the members it is still reading, and
    // the `member` stream above clears them one at a time. Any other answer
    // resets it, so a switch away from a progressive load never leaves a stale
    // "still reading" claim on screen.
    pendingMembers = body.meta && body.meta.mode === "progressive" ? [...(body.meta.pending || [])] : [];
    pendingTotal = pendingMembers.length;
    if (view.components) takeTerragucciFacets(body.meta);
    graphRefusal = null;
    render(body.ir, body.svg, body.meta);
    afterPaint(body.ir);
    if (progressive) replayMemberFrames(frameLoad);
  } catch (err) {
    // A background settle poll must not blow away a good graph on a transient error.
    if (!opts.quiet && isCurrent()) {
      // Text, never innerHTML — `err.message` embeds chant's own stderr, which
      // is not ours to interpolate as markup (the sibling precondition card has
      // said so since #72; this branch had been left behind).
      const graph = document.getElementById("graph");
      graph.innerHTML = "";
      const box = document.createElement("div");
      box.className = "err";
      box.textContent = `graph failed: ${err.message}`;
      graph.appendChild(box);
      meta.textContent = "error";
    }
  } finally {
    if (!opts.quiet) hideLoading();
    // Drawn, refused or superseded: either way nothing waits on this load's
    // answer any more, so a later frame applies as it lands.
    if (progressive) memberFrames.cancel(frameLoad);
  }
}

/** The frames that landed before this load's answer was drawn, folded into it now. */
function replayMemberFrames(load) {
  if (!lastGraphIr) return;
  const r = memberFrames.replay(lastGraphIr, pendingMembers, load);
  if (!r) return;
  pendingMembers = r.pending;
  if (r.failed) nowline(`the estate read failed — ${r.failed}`);
  if (r.moved.length) recolorNodesByCategory(lastGraphIr);
  markPendingCards(lastGraphIr);
  markIdentityCards(lastGraphIr);
  renderStatusbar();
}

/**
 * #404: re-read the overlay AND ask for the attribute-drift plan.
 *
 * A second row rather than a flag on `refresh()` above, for two reasons.
 *
 * The costs are different in kind. The ownership read a refresh already makes
 * (`live-ls` + `live-plan`) is answered out of the account's tagging index —
 * a handful of calls whatever the estate's size. `plan` refreshes every
 * resource, which is one provider read per card: on the workbench's
 * terralith-4 that is 301 reads for one keypress. Putting them on one button
 * would make the cheap, repeatable "did anything move?" silently cost the
 * expensive question every time.
 *
 * And they are not even the same request. `refresh()` is `POST /api/refresh`,
 * which re-observes the PRIMARY project and captures a lanes frame; it never
 * composes the estate. A choudoufu member is served through the estate branch
 * of `GET /api/overlay`, which is where the drift read lives — so this row
 * goes through `load()`, the path that actually renders those cards.
 */
async function readTerraformPlan() {
  terraformPlanOnce = true;
  nowline("↻ reading the plan on the Terraform roots…");
  await load();
  const note = lastMeta && lastMeta.note ? String(lastMeta.note).split(" · ").find((p) => p.startsWith("plan: ")) : null;
  nowline(note ? `↻ ${note}` : "↻ the plan could not be read");
}

async function refreshWithPlan() {
  planDriftOnce = true;
  bulkDiffCache = null; // the pane's rows come from /api/diff — re-fetch them against the new plan
  nowline("↻ planning — a full read of the account…");
  await load();
  const dm = driftMeta();
  if (dm && dm.read) nowline(dm.drifted ? `↻ plan read — ${dm.drifted} drifted` : "↻ plan read — nothing drifted");
  else nowline("↻ the plan could not be read — the overlay is ownership only");
}

// Refresh (#24): re-check live drift now and capture a lanes frame, in one
// round-trip. Renders the returned graph directly (no second pull); the server's
// `frames` event updates the lanes view.
async function refresh() {
  const meta = document.getElementById("meta");
  const prev = meta.textContent;
  meta.textContent = "refreshing…";
  showLoading("refreshing live state…");
  try {
    // Carry the active zoom's runtime flag so a refresh from the resources
    // tier doesn't come back wearing the runtime tier's Pods (#144).
    const runtime = zoomValue() === "runtime" ? "&runtime=1" : "";
    const q = view.env ? `?env=${encodeURIComponent(view.env)}${runtime}` : "";
    const res = await fetch(`/api/refresh${q}`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const { ir, svg, meta: m, captured } = await res.json();
    render(ir, svg, m);
    if (view.env) loadHealth(view.env, true); // #825: health moves on its own; read it again too
    nowline(captured ? "↻ refreshed — new lanes frame" : "↻ refreshed — no change");
  } catch (err) {
    meta.textContent = prev;
    nowline("✗ refresh: " + err.message);
  } finally {
    hideLoading();
  }
}

// The env/tier/target/stack lenses (M2 #54; stack #76) — used to be header
// <select>s; #73 moved picking them into the ⌘K palette (paletteCommands()
// reads these lists), so they're module-level now instead of local to the
// picker-building closure that used to render them. Populated once in
// initPickers().
let environments = [];
let tiers = [];
let targets = [];
let stacks = [];
// #195: the last /api/project payload — the Scope tab's project section reads
// projectDir/projectDirs/recents from it.
let projectInfo = null;

// Fetch the project once, seed view/axes + the lens lists above, then do the
// first load. previously also built the header's env/zoom/radial/tier/target
// controls; those are now ⌘K palette commands (#73) — renderStatusbar() is
// what keeps their CURRENT value visible without opening the palette.
async function initPickers() {
  const info = await apiFetch("/api/project")
    .then((r) => r.json())
    .catch(() => ({ environments: [], currentEnv: null }));
  projectInfo = info;
  view.env = info.currentEnv || null;
  view.tier = info.tier || null;
  view.target = (info.targets && info.targets[0] && info.targets[0].endpoint) || null;
  // The stack picker's default (#76, design: "default = the FIRST stack when
  // the project declares stacks[] and none is selected") — mirrors `target`
  // above, which defaults to its own first option the same way. `info.stacks`
  // is only present at all when `chant.config.ts` declares `stacks[]` (see
  // server.ts's `/api/project`, gated on `info.stacks?.length`), so a project
  // with none leaves `view.stack` (and the picker + status tag) null.
  stacks = info.stacks || [];
  view.stack = stacks[0] || null;
  // #284: the ops stop exists only for an estate that has emitted op.json —
  // `info.ops` is the count, absent when there are none (server.ts gates it the
  // way it gates `tiers`/`stacks`), so an unbuilt project or a chant < 0.50
  // never grows a stop that would refuse.
  opsAvailable = info.ops || 0;
  // #393: whether the runtime stop exists here, and where this estate can
  // honestly open. Both are read before the first load() below, so a non-chant
  // estate never paints the components apology on its way to a picture.
  runtimeCapable = !!info.runtimeCapable;
  stacksCapable = !!info.stacksCapable;
  terragucciComponentsRepo = !!info.terragucciComponents;
  componentsDeclared = info.componentsDeclared;
  const boot = bootZoom(info.memberKinds, terragucciComponentsRepo, componentsDeclared);
  if (boot !== "components") {
    applyZoom(boot);
    autoZoomFallback = false;
  }
  // #254: carve mode declares itself here. The Carve tab is mounted at runtime
  // (panel.js's addPanelTab), so nothing else grows a dead tab.
  carveInfo = info.carve || null;
  if (carveMode()) {
    renderPanelCarve();
    loadCarveReport();
  }
  axes = { tier: info.tier || null, target: info.target || null };
  environments = info.environments || [];
  tiers = info.tiers || [];
  targets = info.targets || [];
  openFromQuery();
  renderStatusbar();
  load();
}
initPickers();

// Live updates (#3): re-pull when the server signals the served source changed.
// EventSource reconnects on its own if the server restarts.
// No backend in a static export → no live event stream; a no-op keeps the
// `events.addEventListener(...)` wiring below harmless.
const events = staticMode ? { addEventListener() {} } : new EventSource("/api/events");
// One notification requests one refresh. Further notifications during a slow
// read collapse to one follow-up; no wall-clock timers multiply estate scans.
// #422: one frame per member as its live read settles. Payload-carrying, like
// `apply` and `run` — the node set is already on screen, so this is id ->
// status and the client repaints in place. Nothing is re-fetched: a refetch
// here would re-run the whole estate read this stream exists to narrate.
events.addEventListener("member", (e) => {
  let frame;
  try {
    frame = JSON.parse(e.data);
  } catch {
    return;
  }
  // The live pass itself failed. Say so on the now-line and stop claiming the
  // remaining members are still arriving, because nothing more is coming.
  // A frame that lands while its load's answer is still on the way waits
  // for the draw, which replays it (web/pending.js createMemberFrames).
  if (!memberFrames.note(frame)) return;
  if (frame.error) {
    pendingMembers = [];
    nowline(`the estate read failed — ${frame.error}`);
    renderStatusbar();
    return;
  }
  if (!lastGraphIr) return;
  const moved = applyMemberFrame(lastGraphIr, frame);
  pendingMembers = stillPending(pendingMembers, frame);
  if (moved.length) recolorNodesByCategory(lastGraphIr);
  markPendingCards(lastGraphIr);
  markIdentityCards(lastGraphIr);
  renderStatusbar();
});

// #914: an agent's POST /api/view.
events.addEventListener("view", (e) => agentMove(e.data));

events.addEventListener("changed", () => {
  queryAnswer = null; // #913: the source or the estate moved: the next paint asks again
  bulkDiffCache = null; // an op ran → per-node live state may have changed
  whyAnswers.clear(); // #471: a why read before the change may no longer hold
  load();
  loadWorkspaceGates({ force: true });
  loadSubstrates(); // a bring-up (or any op) finished → re-detect readiness
});

// Substrate readiness (M5, #54): is each substrate the project needs actually
// up? Poll /api/substrates and render rows on the panel's Substrates tab —
// status dot + name + state, with the bring-up/reset/pipeline actions inline
// again (#73 moved those into ⌘K; they remain there too, via lastSubstrates).
async function loadSubstrates() {
  if (publicMode) return; // #569: /api/substrates is refused in a public view
  try {
    const { substrates } = await apiFetch("/api/substrates").then((r) => r.json());
    renderSubstrates(substrates || []);
  } catch {
    /* transient — leave whatever's shown */
  }
}

// The last substrates list — read by paletteCommands() to build "Bring up
// <label>" / "Reset local emulator" entries with the same gating renderSubstrates()
// used to apply to its now-removed inline buttons.
let lastSubstrates = [];

function renderSubstrates(subs) {
  lastSubstrates = subs;
  const host = document.getElementById("substrates");
  if (!host) return;
  // Rebuilt only when the data changes — this runs on a 5s poll, and wiping
  // identical rows would yank a button out from under the cursor.
  const sig = JSON.stringify(subs) + `|${staticMode}|${previewMode}`;
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.innerHTML = "";
  if (!subs.length) {
    host.appendChild(panelMuted("no substrates detected for this project"));
    return;
  }
  for (const s of subs) {
    const row = document.createElement("div");
    row.className = `sub ${s.status}`;
    row.title = s.detail || "";
    const dot = document.createElement("span");
    dot.className = "dot";
    const name = document.createElement("span");
    name.className = "grow";
    name.textContent = s.label;
    const status = document.createElement("span");
    status.className = "tag";
    status.textContent = s.status;
    row.append(dot, name, status);
    // Writes — none in a static export; the GitHub dispatch also respects the
    // preview lock, mirroring paletteCommands()'s gating exactly.
    if (!staticMode && !publicMode) {
      if (s.bringUp) row.appendChild(actButton("bring up", () => bringUpSubstrate(s)));
      if (s.name === "floci" && s.status === "up")
        row.appendChild(actButton("reset", () => resetLocal(), "Reset the local emulator — wipes every stack, reboots, redeploys clean"));
      if (s.name === "github" && !previewMode)
        row.appendChild(actButton("run", () => dispatchPipeline(), "Dispatch the GitHub Actions pipeline via your gh login"));
    }
    host.appendChild(row);
  }
}

function resetLocal() {
  if (
    !window.confirm(
      "Reset the local emulator?\nRuns local-down + local-up: wipes every stack, reboots the emulator, and redeploys all components clean.\nThis is the recovery for rolled-back stacks (Floci #16) — do NOT apply afterward (that re-apply is what collides).\n\nOutput streams in the log below; takes a few minutes.",
    )
  )
    return;
  nowline("▶ resetting local emulator (local-down + local-up, redeploys clean) …");
  fetch("/api/local/reset", { method: "POST" })
    .then((r) => r.json())
    .then((j) => nowline(j.error ? "✗ " + j.error : `▶ reset: ${j.ran} — reboots + redeploys; watch the log, no apply needed`))
    .catch((e) => nowline("✗ reset: " + e.message));
}

function bringUpSubstrate(s) {
  if (
    !window.confirm(
      `Bring up ${s.label}?\nRuns: ${s.bringUp.cmd} ${s.bringUp.args.join(" ")}\nOutput streams in the log below — this can take a minute.`,
    )
  )
    return;
  nowline(`▶ bringing up ${s.label} …`);
  fetch(`/api/substrates/${encodeURIComponent(s.name)}/up`, { method: "POST" })
    .then((r) => r.json())
    .then((j) => nowline(j.error ? "✗ " + j.error : `▶ ${s.label}: ${j.ran}`))
    .catch((e) => nowline("✗ bring up: " + e.message));
}

// Dispatch a GitHub Actions run (#164) — through the operator's own `gh`
// login. The server refuses honestly (no gh, unauthenticated, no matching
// workflow_dispatch workflow) and the reason lands as a toast. Shared by the
// Substrates tab's button and the ⌘K entry.
function dispatchPipeline(env) {
  const target = env || view.env || opsInitialEnv;
  if (!window.confirm(`Dispatch the GitHub Actions pipeline${target ? ` for ${target}` : ""}?\nRuns via YOUR gh login (gh workflow run); behold follows the run on the dial.`)) return;
  fetch(`/api/ci/dispatch${target ? `?env=${encodeURIComponent(target)}` : ""}`, { method: "POST" })
    .then((r) => r.json())
    .then((j) => {
      if (j.error) {
        showToast(`✗ dispatch: ${j.error}`, false);
        nowline("✗ dispatch: " + j.error);
      } else {
        showToast(`▶ dispatched ${j.workflow} @ ${j.ref} (${j.jobs} jobs) — following on the dial`, true);
      }
    });
}

loadSubstrates();
// Poll readiness so pills update as things come up on their own (Docker
// starting, a bring-up provisioning) without needing a `changed` event.
setInterval(loadSubstrates, 5000);
// #284 item 2, #459: every run is local now, and a gated one exits at its gate
// (status `gated`), so there is nothing to poll while one runs. The `run`
// event below asks for the gate once the run stops there.
// #234 join 3: the operating loop ticks on its own schedule (chant's operator
// defaults to a 60s round, a CronJob to whatever it declares), so the strip goes
// stale without anyone clicking. Same discipline as the gate tick above rather
// than a second pattern: an interval only while it is RELEVANT — the ops lens is
// what the strip lives on, and a project with no declared ConvergeOp shells
// nothing, ever. The server broadcasts only a CHANGED answer, so a quiet loop
// costs one read and no repaint.
setInterval(() => {
  if (view.ops && hasOperator(operatorState)) pollOperatorStatus();
}, 15000);

// Delegated writes (#7 Sync / #8 Adopt). behold never mutates — these buttons
// trigger the project's committed Ops on the executor; the now-line streams phases.
// A blocking load overlay (#slow-box): a live view change shells chant and can
// take seconds. Cover the whole app with a scrim + spinner so a stray click
// can't fire a second pull while one's in flight. Ref-counted — nested loads
// (graph + CI + resources) only lift the scrim when the last finishes.
let loadingDepth = 0;
// #421: what the LAST read cost, shown while this one runs. The person watching
// the scrim wants to know whether to wait or go away, and behold has never told
// them. Fetched after a load settles rather than during one — asking the server
// how slow it is while it is being slow helps nobody — so the line always
// describes the previous read and never guesses at this one.
let lastReadCost = null;
function showLoading(msg) {
  loadingDepth++;
  const o = document.getElementById("loading-overlay");
  if (!o) return;
  document.getElementById("loading-msg").textContent = msg || "loading…";
  const cost = document.getElementById("loading-cost");
  if (cost) cost.textContent = lastReadCost || "";
  o.hidden = false;
}
function hideLoading() {
  loadingDepth = Math.max(0, loadingDepth - 1);
  if (loadingDepth > 0) return;
  const o = document.getElementById("loading-overlay");
  if (o) o.hidden = true;
  void refreshReadCost();
}

// One cheap call on counters, never on the read path. `?reads=1` is what makes
// that true: the bare route also runs the full doctor diagnosis, whose substrate
// probes spawn docker/gh/helm/k3d with no timeout, and this runs after every
// load settles. A cost line is never worth breaking a load over, so every
// failure here leaves the previous line standing.
//
// A static export has no backend to ask and no reads to report, so it does not
// ask. Without this guard the bundle logs a 404 on every page load and relies on
// the fetch failing to stay silent, which is an outcome rather than a rule.
async function refreshReadCost() {
  if (staticMode || publicMode) return; // #569: /api/doctor is refused in a public view
  try {
    const res = await fetch("/api/doctor?reads=1");
    if (!res.ok) return;
    lastReadCost = readCostLine((await res.json()).reads);
  } catch {
    /* no line rather than a wrong one */
  }
}

// #259: the op stream is chant's own stdout, and an Op that reports as JSON
// (a plan summary, a run report, a structured line that
// src/op-runner.ts didn't filter out) used to land here as one unbroken line.
// Parse it; if it IS a JSON object or array, show the collapsible tree instead.
// Anything else — every ordinary human log line — is untouched text.
function asJsonPayload(line) {
  const s = String(line).trim();
  if (!(s.startsWith("{") || s.startsWith("["))) return null;
  try {
    const v = JSON.parse(s);
    return isContainer(v) ? v : null;
  } catch {
    return null;
  }
}

function nowline(line) {
  const p = document.getElementById("nowline");
  p.style.display = "block";
  const payload = asJsonPayload(line);
  const d = payload ? renderJson(payload) : document.createElement("div");
  if (!payload) d.textContent = line;
  p.appendChild(d);
  p.scrollTop = p.scrollHeight;
}
events.addEventListener("op", (e) => nowline(e.data));

// Transient toast for action feedback. The now-line is a bottom log pane that
// is display:none until something writes to it and may be scrolled out of
// view — an error that only lands there after the palette closed is an error
// nobody sees. Errors get BOTH: the toast for now, the now-line for the
// record. Auto-dismisses; click to dismiss sooner.
function showToast(msg, ok) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    host.style.cssText = "position:fixed;top:12px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:60;max-width:420px";
    document.body.appendChild(host);
  }
  const t = document.createElement("div");
  const color = ok ? "var(--managed)" : "var(--degraded)";
  t.style.cssText = `background:var(--panel);color:var(--fg);border:1px solid ${color};border-left:4px solid ${color};border-radius:var(--r-ctl);padding:8px 12px;font-size:var(--t-body);box-shadow:0 6px 18px color-mix(in srgb, var(--shadow) 50%, transparent);cursor:pointer;white-space:pre-wrap`;
  t.textContent = msg;
  t.onclick = () => t.remove();
  host.appendChild(t);
  setTimeout(() => t.remove(), ok ? 5000 : 10000);
}

// Structured apply progress (M3, #54): the server broadcasts the full
// ApplyProgressState (src/apply.ts) after every run event chant streams
// (#679); see src/op-runner.ts's apply(). Re-render the dial's progress panel each
// time; renderDial() is cheap (rebuilds a small DOM subtree) so no diffing.
events.addEventListener("apply", (e) => {
  try {
    applyProgress = JSON.parse(e.data);
  } catch {
    return;
  }
  renderDial();
});

// #284 item 2 — the run playhead. Same channel and same shape as `apply` above:
// the server broadcasts the whole RunState (src/run-playhead.ts) after every
// run event (a step's start and settle, a gate) and every status read, so a client that (re)subscribes
// mid-run renders correctly from the very next event. Repaint the dial always;
// re-pull the graph only when the ops lens is what's on screen, since that's
// the view the run state paints over.
events.addEventListener("run", (e) => {
  let wasGated = false;
  try {
    wasGated = !!runState && runState.status === "gated";
    runState = JSON.parse(e.data);
  } catch {
    return;
  }
  // #459: a run that just stopped at its gate: ask which gate, once.
  if (runState && runState.status === "gated" && !runState.gate && !wasGated) pollRunStatus();
  renderDial();
  if (view.ops) load({ quiet: true });
});

// #234 join 3 — the operator strip. Same channel and shape as `run` above: the
// server broadcasts the whole OperatorState after every CHANGED status read, so
// a client that (re)subscribes renders correctly from the next event. Repaint
// the dial only: the strip paints nothing onto the graph, so there is no re-pull
// to make here (which is also what stops the poll and the broadcast chasing each
// other).
events.addEventListener("operator", (e) => {
  try {
    operatorState = JSON.parse(e.data);
  } catch {
    return;
  }
  renderDial();
});

/**
 * Ask the server for the Op's durable run status — the ONLY way to learn
 * gateState (chant#1676 made it a workflow query, not part of the record
 * stream). Pull, not push: one shell-out per ask, and only while there is a
 * durable run to ask about, rather than a background poll against Temporal for
 * an Op nobody is watching.
 *
 * A refusal (no Temporal, no run, an older chant) is not an error to shout
 * about — the server folds its reason into `runState.gateNote` and the panel
 * states it. What must never happen is a silent fallback to "no gate pending".
 */
function runStatusTarget() {
  if (runState && runState.op) return runState.op;
  // Nothing has run this session: the one Op whose gate the Approve button
  // already targets is the honest thing to ask about.
  return opsApply && opsApply.gate ? opsApply.name : null;
}
function pollRunStatus() {
  if (staticMode || publicMode || runStatusInFlight) return; // #569: a public serve refuses the op tools
  const name = runStatusTarget();
  if (!name) return;
  // A run still in flight has no settled status to read yet (#459).
  if (runState && runState.status === "running") return;
  runStatusInFlight = true;
  apiFetch(`/api/ops/${encodeURIComponent(name)}/status`)
    .then((r) => r.json())
    .then((j) => {
      if (j && j.runState) runState = j.runState;
      renderDial();
    })
    .catch(() => {})
    .finally(() => {
      runStatusInFlight = false;
    });
}

/**
 * Ask the server for the operating loop's status (#234 join 3).
 *
 * Pull, not push, exactly like `pollRunStatus`: one shell-out per ask, and only
 * for a project that DECLARES a ConvergeOp. A refusal (no loop, a chant older
 * than 0.52, an answer behold can't read) comes back on the state as `note` +
 * `code` and the strip states it — what must never happen is a silently empty
 * strip standing in for "behold couldn't ask".
 */
function pollOperatorStatus() {
  if (staticMode || publicMode || operatorInFlight) return;
  operatorInFlight = true;
  apiFetch("/api/operator/status")
    .then((r) => r.json())
    .then((j) => {
      if (j && j.operator) operatorState = j.operator;
      renderDial();
    })
    .catch(() => {})
    .finally(() => {
      operatorInFlight = false;
    });
}

/**
 * Open or close the converge history (#234, chant#2029), reading it the first
 * time it is opened.
 *
 * This is the whole poll discipline for the timeline: a click. `chant operator
 * log` walks the project's `chant/lifecycle` ledger, and an interval against it
 * would spend a process per tick of the clock to be handed a past that hasn't
 * moved. Re-opening re-reads, so a human who wants the newest ticks closes and
 * opens — an explicit ask, which is what this surface is.
 */
function toggleOperatorHistory() {
  operatorHistory = { ...operatorHistory, open: !operatorHistory.open };
  if (operatorHistory.open) loadOperatorHistory();
  renderDial();
}

/**
 * Read one bounded window of the converge timeline.
 *
 * The server clamps and reports the window it used (src/operator.ts's
 * OPERATOR_LOG_MAX_LIMIT), so the panel states the bound rather than implying it
 * is showing everything. A refusal — a chant older than the `operator log`
 * subcommand, an unreadable answer — lands on the panel as its own sentence: an
 * empty timeline must never stand in for "behold couldn't ask".
 */
function loadOperatorHistory() {
  if (staticMode || publicMode || operatorHistory.loading) return;
  operatorHistory = { ...operatorHistory, loading: true, error: null };
  apiFetch("/api/operator/log")
    .then((r) => r.json())
    .then((j) => {
      operatorHistory = j && j.history
        ? { open: true, loading: false, error: null, data: j.history }
        : { open: true, loading: false, error: (j && j.error) || "the server answered with no timeline", data: null };
      renderDial();
    })
    .catch((e) => {
      operatorHistory = { open: true, loading: false, error: String(e), data: null };
      renderDial();
    });
}

/**
 * Record a converge gate's resolution — `chant approve <op> <gate>`, delegated
 * exactly as the run gate's signal is.
 *
 * It is NOT the same act, and the toast says so: chant's gate ledger writes a
 * fact, and the local executor still refuses the gated dispatch. The next tick
 * is what reads the fact. Re-poll once either way — on success the gate should
 * have left `pendingGates` (a card that lingered would read as if a human were
 * still owed something), and on failure it should still be there.
 */
function approveConvergeGate(op, gate) {
  fetch(`/api/operator/approve/${encodeURIComponent(op)}/${encodeURIComponent(gate)}`, { method: "POST" })
    .then((r) => r.json())
    .then((j) => {
      if (j.error) {
        showToast(`✗ approve ${gate}: ${j.error}`, false);
        nowline("✗ " + j.error);
      } else {
        showToast(`✓ ${gate} — ${APPROVED_SEMANTICS}`, true);
      }
      pollOperatorStatus();
      // A resolution just became a ledger record. Re-read the timeline only if
      // it is already open — still a human's ask, not a background refresh.
      if (operatorHistory.open) loadOperatorHistory();
    });
}

function button(label, cls, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener("click", onClick);
  return b;
}
function runOp(name) {
  fetch(`/api/ops/${encodeURIComponent(name)}/run`, { method: "POST" })
    .then((r) => r.json())
    .then((j) => {
      if (j.error) {
        showToast(`✗ ${name}: ${j.error}`, false);
        nowline("✗ " + j.error);
      } else {
        showToast(`▶ running ${name} — output streams in the log below`, true);
      }
    });
}
function signal(name, gate) {
  fetch(`/api/ops/${encodeURIComponent(name)}/signal/${encodeURIComponent(gate)}`, { method: "POST" })
    .then((r) => r.json())
    .then((j) => {
      if (j.error) {
        showToast(`✗ approve ${gate}: ${j.error}`, false);
        nowline("✗ " + j.error);
      } else {
        // #459: the local runtime reads the approval when the Op runs again;
        // chant's own line says so, and comes back as `next`.
        showToast(`✓ approved ${gate}${j.next ? ` — ${j.next}` : ""}`, true);
      }
      // #284 item 2: re-ask gateState either way. On success the gate should be
      // gone (the pending card must not linger as if a human were still owed);
      // on failure it should still be there, and the card is what says so.
      pollRunStatus();
    });
}
// Adopt is a per-node gesture (a *foreign* node → ReconcileOp → PR), so it lives
// in the inspect panel, not the global bar. Stash the reconcile op + the
// live-import lexicons the server allows so inspect() can gate the button.
let adopt = { reconcile: null, lexicons: [] };
function adoptable(node) {
  // `warn` is chant's overlay tag for foreign — "foreign" is only ever the
  // display label (STATUS_LABEL above), never the attr's value (#145).
  return (
    adopt.reconcile &&
    node.attrs &&
    node.attrs._status === "warn" &&
    adopt.lexicons.includes(node.lexicon)
  );
}

// Rollback (#28): fetch recent source commits, let the user pick one, and trigger
// the delegated rollback (opens a PR). Replaces the button with a picker + confirm.
async function openRollback(btn) {
  const commits = await fetch("/api/history")
    .then((r) => r.json())
    .then((j) => j.commits)
    .catch(() => []);
  if (!commits.length) {
    nowline("rollback: no git history found");
    return;
  }
  const wrap = document.createElement("span");
  wrap.style.cssText = "display:flex;gap:6px;align-self:center";
  const sel = document.createElement("select");
  sel.style.cssText =
    "background:var(--well);color:var(--fg);border:1px solid var(--line);border-radius:var(--r-ctl);padding:4px 8px;font-size:var(--t-body);max-width:340px";
  for (const c of commits) sel.add(new Option(`${c.sha} · ${c.subject} (${c.date})`, c.sha));
  const go = button("Roll back →", "", () => {
    const to = sel.value;
    if (!window.confirm(`Open a rollback PR restoring source to ${to}?\nA human reviews + merges, then Sync applies it.`)) return;
    fetch(`/api/rollback?to=${encodeURIComponent(to)}`, { method: "POST" })
      .then((r) => r.json())
      .then((j) => nowline(j.error ? "✗ " + j.error : `▶ rollback → ${to} (opening PR…)`));
    wrap.remove();
  });
  const cancel = button("✕", "", () => wrap.remove());
  wrap.append(sel, go, cancel);
  btn.replaceWith(wrap);
}

// #73: Rollback used to be a permanent toolbar button (openRollback(rb) swapped
// it for the picker, then restored it after). Triggered from the ⌘K palette
// instead now — there's no permanent button to restore, so this drops a
// throwaway one into the (now otherwise action-free) actions bar just to host
// the inline picker; openRollback's own wrap.remove() above cleans it up.
function paletteRollback() {
  const bar = document.getElementById("actions");
  const rb = button("Rollback", "", () => {});
  bar.appendChild(rb);
  openRollback(rb);
}

// #165: per-env executor designations, off /api/project. A designated env's
// Deploy dispatches the forge workflow instead of running chant here; a
// designation behold cannot honour disables Deploy with its reason.
let executorInfo = {};
function designatedFor(env) {
  return env && executorInfo && executorInfo[env] ? executorInfo[env] : null;
}

// Deploy/ops state for the ⌘K palette (#73) — populated once in initActions(),
// which used to turn each of these straight into a toolbar button. previewMode
// (declared above, near view) is what the palette gates on: it hides exactly
// the git/PR write actions the buttons hid (Rollback, Sync, Run <op>) — Apply
// all, Reset, Bring up, Approve, and every read stay reachable in preview,
// same as before.
let opsApply = null; // the committed ApplyOp ({name, gate}), or null
let opsRunnable = []; // generic Ops (backup/restore/audit/…) for "Run: <name>"
let opsInitialEnv = null; // env behold launched with — gates "Apply all"

async function initActions() {
  const bar = document.getElementById("actions");
  if (staticMode) {
    // A frozen snapshot — no live actions at all. Show when it was captured.
    const pill = document.createElement("span");
    pill.textContent = `● static snapshot${manifest && manifest.capturedAt ? " · " + manifest.capturedAt.slice(0, 16).replace("T", " ") : ""}`;
    pill.title = "An exported, read-only snapshot — no live observe or deploy.";
    pill.style.cssText = "align-self:center;font:var(--t-caption)/1.4 var(--font-mono);color:var(--muted);border:1px solid var(--line);border-radius:var(--r-ctl);padding:2px 8px";
    bar.appendChild(pill);
    // #510: other commits' views, when ../history.json sits beside this one.
    // The deploy tab stays hidden unless there is history to pick from.
    mountHistoryPicker(bar).then((picker) => {
      if (picker) document.documentElement.classList.add("static-history");
    });
    previewMode = true;
    return; // nothing else in the bar is a read
  }
  // The env behold launched with (reliable regardless of picker-init ordering) —
  // gates the first-class "Apply all" affordance below; also carries the preview
  // lock that hides the git/PR ops.
  const project = await apiFetch("/api/project").then((r) => r.json()).catch(() => ({}));
  opsInitialEnv = project.currentEnv || null;
  // #165: which envs deploy through a forge, and whether Deploy can dispatch
  // them right now (`/api/project`'s executor block).
  executorInfo = project.executor || {};
  previewMode = staticMode || publicMode || !!project.previewMode; // static ⇒ read-only, no writes at all
  // #517: a SQL Yodeler repo is guarded the same way.
  const guarded = project.terragucci || project.sqlYodeler;
  if (guarded) {
    terragucciRepo = guarded;
    previewMode = true;
    const pill = document.createElement("span");
    pill.textContent = project.terragucci ? "● applied by terragucci" : "● migrated by SQL Yodeler";
    pill.title = `${guarded.error}\n\n${guarded.remedy}`;
    pill.style.cssText = "align-self:center;font:var(--t-caption)/1.4 var(--font-mono);color:var(--muted);border:1px solid var(--line);border-radius:var(--r-ctl);padding:2px 8px";
    bar.appendChild(pill);
    return; // no Deploy, no Run, no Approve: the pipeline is the only way to apply
  }
  // #569: a public view. Nothing in the bar writes; the pill says why.
  if (publicMode || project.publicMode) {
    previewMode = true;
    const pill = document.createElement("span");
    pill.textContent = "● public view, read-only";
    pill.title = "behold serve --public: this page reads and follows; it starts nothing and approves nothing.";
    pill.style.cssText = "align-self:center;font:var(--t-caption)/1.4 var(--font-mono);color:var(--muted);border:1px solid var(--line);border-radius:var(--r-ctl);padding:2px 8px";
    bar.appendChild(pill);
    return;
  }
  const { ops, adoptLexicons, autoSync, local, applyProgress: apInit, runState: runInit, operatorState: opInit } = await apiFetch("/api/ops")
    .then((r) => r.json())
    .catch(() => ({ ops: [], adoptLexicons: [] }));
  // M3 (#54): hydrate the dial's apply progress from the server's last known
  // state — a page load (or reload) mid-apply picks up the structured view
  // instead of starting blank; the `apply` SSE listener keeps it live from here.
  if (apInit && apInit.waves && apInit.waves.length) {
    applyProgress = apInit;
    renderDial();
  }
  // #284 item 2: the same hydration for the run playhead — a reload mid-run
  // picks up the settled steps and any pending gate instead of starting blank.
  if (runInit && runInit.op) {
    runState = runInit;
    renderDial();
  }
  // #234 join 3: and the same for the operator strip — a reload with the ops
  // lens open picks up the last status read rather than showing an empty strip
  // until the next poll comes back.
  if (opInit && opInit.declared && opInit.declared.length) {
    operatorState = opInit;
    renderDial();
  }
  // Local-mode banner (#46) — the emulator(s) behold booted with --local, so it's
  // obvious deploys/overlay hit them (no cloud creds), not a real account.
  if (local && local.emulators && local.emulators.length) {
    const pill = document.createElement("span");
    const names = local.emulators.map((e) => e.name).join(", ");
    pill.textContent = `● local · ${names} up`;
    pill.title =
      "Emulator(s) booted by --local: " +
      local.emulators.map((e) => `${e.lexicon} ${e.name} @ ${e.endpoint}`).join("; ") +
      ". Deploys and the overlay observe them — no cloud creds.";
    pill.style.cssText =
      "align-self:center;font:var(--t-caption)/1.4 var(--font-mono);color:var(--managed);border:1px solid var(--managed);border-radius:var(--r-ctl);padding:2px 8px";
    bar.appendChild(pill);
  }
  // Auto-sync banner (#29) — make an active self-heal loop visible, not silent.
  if (autoSync && autoSync !== "off") {
    const pill = document.createElement("span");
    pill.textContent = `⟳ auto-sync: ${autoSync}`;
    pill.title = `On polled drift, behold triggers the ${autoSync === "apply" ? "ApplyOp (heal)" : "ReconcileOp (adopt)"}. Gated applies still wait for Approve.`;
    pill.style.cssText =
      "align-self:center;font:var(--t-caption)/1.4 var(--font-mono);color:var(--pending);border:1px solid var(--pending);border-radius:var(--r-ctl);padding:2px 8px";
    bar.appendChild(pill);
  }
  opsApply = ops.find((o) => o.kind === "apply") ?? null;
  adopt = { reconcile: ops.find((o) => o.kind === "reconcile") ?? null, lexicons: adoptLexicons ?? [] };
  // Generic Ops (backup, restore, seed, watch, teardown, …) — "Run: <name>" in
  // the palette, same set the old "Run ▾" dropdown offered.
  opsRunnable = ops.filter((o) => o.kind === "op" || o.kind === "audit");

  // The one visible deploy affordance (#73 follow-up). Moving every write into
  // the ⌘K palette left the header with zero action buttons — behold looked
  // read-only unless you happened to press ⌘K, and the docs' "click Run/Sync"
  // still described the old toolbar. The PRIMARY deploy gesture gets a real
  // button back; everything else stays in the palette. One intent, one word:
  // the button says Deploy whether the project routes it through a committed
  // ApplyOp or a raw `chant run --components` — the tooltip carries the
  // mechanism.
  const deployEnv = view.env || opsInitialEnv;
  const designated = designatedFor(deployEnv);
  if (designated && !previewMode) {
    // #165: the env deploys through a forge. One button, the forge's name on
    // it, dispatching the DESIGNATED workflow through the operator's own gh —
    // and disabled, with the reason, when the designation cannot be honoured.
    // Never the local button: falling back is what the contract forbids.
    const forge = { github: "GitHub Actions", gitlab: "GitLab CI", forgejo: "Forgejo" }[designated.forge] || designated.forge || "the forge";
    const deploy = button(`▶ Deploy via ${forge}`, "", () => dispatchPipeline(deployEnv));
    if (!designated.ok) {
      deploy.disabled = true;
      deploy.title = `Deploy is disabled for ${deployEnv}: ${designated.reason}`;
    } else {
      deploy.title = `gh workflow run ${designated.workflow} — ${deployEnv} deploys through ${forge} per .behold.json. behold dispatches through YOUR gh and follows the run on the dial; any approval the workflow's environment requires is granted on the forge, not here.`;
    }
    bar.appendChild(deploy);
    const note = document.createElement("span");
    note.style.cssText = "color:var(--muted);font-size:var(--t-caption);align-self:center";
    note.textContent = designated.ok ? `${deployEnv}: approval, if any, lives on ${forge}` : `${deployEnv}: ${designated.reason}`;
    bar.appendChild(note);
  } else if (opsApply && !previewMode) {
    const deploy = button(`▶ Deploy (${opsApply.name})`, "", () => {
      if (window.confirm(`Run the committed ApplyOp "${opsApply.name}"?\nDelegated write: behold triggers, chant's executor applies.`)) runOp(opsApply.name);
    });
    deploy.title = `chant run ${opsApply.name} — the committed ApplyOp (Build → Plan → Apply). Also in ⌘K as "Deploy: Sync".`;
    bar.appendChild(deploy);
    if (opsApply.gate) {
      const approve = button(`Approve ${opsApply.gate}`, "approve", () => signal(opsApply.name, opsApply.gate));
      approve.title = `chant run approve ${opsApply.name} ${opsApply.gate} — records the gate's resolution; the Op runs on from it.`;
      bar.appendChild(approve);
    }
  } else if (opsInitialEnv || view.env) {
    const deploy = button("▶ Deploy…", "", () => {
      if (!view.env) {
        showToast("Deploy needs an environment — pick one in ⌘K (env: …)", false);
        return;
      }
      applyPicker = true;
      loadComponentChoices().then(renderDial);
      renderDial();
      setPanelTab("deploy"); // the dial lives on the panel's Deploy tab
    });
    deploy.title = `chant run <component|all> --components --env ${view.env || opsInitialEnv} --events-json: opens the component picker on the dial. behold triggers, chant executes.`;
    bar.appendChild(deploy);
  }

  // Only complain when there's genuinely nothing to do (never in the preview —
  // its deploy path is Apply all, not committed Ops).
  if (ops.length === 0 && !previewMode && !opsInitialEnv) {
    const hint = document.createElement("span");
    hint.style.cssText = "color:var(--muted);font-size:var(--t-caption);align-self:center";
    hint.textContent = "no Ops — commit an *.op.ts (ApplyOp / ReconcileOp / any deploy Op) to act";
    hint.title = "behold triggers committed Ops on your executor. Add one to enable Deploy / Adopt / Run.";
    bar.appendChild(hint);
  }
}
initActions();
// #476: a frame keeps its own inspect state, folded until something is picked.
const INSPECT_COLLAPSED_KEY = embedOpts.embed ? "behold.inspectCollapsed.embed" : "behold.inspectCollapsed";
initInspectPane();

// Inspect pane chrome (#15): collapse (chevron / edge tab) + drag-to-resize, with
// the width and collapsed state persisted so the layout survives reloads.
// setInspectCollapsed/toggleInspect are module-level (not local to initInspectPane)
// so the ⌘K palette (#73) can drive the same collapse/reopen the chevron does.
function setInspectCollapsed(on) {
  document.getElementById("app").classList.toggle("inspect-collapsed", on);
  try {
    localStorage.setItem(INSPECT_COLLAPSED_KEY, on ? "1" : "0");
  } catch {
    /* private mode */
  }
}
function toggleInspect() {
  setInspectCollapsed(!document.getElementById("app").classList.contains("inspect-collapsed"));
}

function initInspectPane() {
  const app = document.getElementById("app");
  const pane = document.getElementById("inspect");
  const MIN = 240, MAX = 720;
  // Restore persisted width + collapsed state.
  const savedW = Number(localStorage.getItem("behold.inspectW"));
  if (savedW >= MIN && savedW <= MAX) document.documentElement.style.setProperty("--inspect-w", savedW + "px");
  let folded = null;
  try {
    folded = localStorage.getItem(INSPECT_COLLAPSED_KEY);
  } catch {
    /* private mode */
  }
  // behold#696: folded on a phone too, where the pane beside the graph left it a sliver.
  const phone = typeof matchMedia === "function" && matchMedia(INSPECT_PHONE_QUERY).matches;
  if (inspectStartsFolded(folded, { embed: embedOpts.embed, phone })) app.classList.add("inspect-collapsed");

  document.getElementById("inspect-collapse").addEventListener("click", () => setInspectCollapsed(true));
  document.getElementById("inspect-reopen").addEventListener("click", () => setInspectCollapsed(false));

  // Drag the left edge to resize; width grows as the handle moves left.
  const handle = document.getElementById("inspect-resize");
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = pane.getBoundingClientRect().width;
    document.body.style.cursor = "col-resize";
    const onMove = (ev) => {
      const w = Math.min(MAX, Math.max(MIN, startW + (startX - ev.clientX)));
      document.documentElement.style.setProperty("--inspect-w", w + "px");
    };
    const onUp = () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--inspect-w"));
      if (w) localStorage.setItem("behold.inspectW", String(w));
      // Graph viewBox is pane-relative; refit so nothing clips after a resize.
      if (typeof fitGraph === "function") fitGraph();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

// The opened PR (chant #841 surfaces it as a ReconcileOp outcome). Link it in the
// now-line and pin it in the header so the review target is one click away.
events.addEventListener("pr", (e) => {
  const url = e.data;
  nowline("→ opened PR: " + url);
  let slot = document.getElementById("pr-link");
  if (!slot) {
    slot = document.createElement("a");
    slot.id = "pr-link";
    slot.target = "_blank";
    slot.rel = "noopener";
    slot.style.cssText = "color:var(--managed);text-decoration:none;font-size:var(--t-body);align-self:center";
    document.getElementById("actions").after(slot);
  }
  slot.href = url;
  slot.textContent = "PR opened →";
});

// Export the current graph as a standalone SVG file — the inlined pinhole SVG
// already IS the full rendered graph (see render()), so this is a pure client-
// side download, no server round-trip. Works in a static export too.
function exportSvg() {
  const svg = currentSvg();
  if (!svg) {
    nowline("✗ export: no graph loaded yet");
    return;
  }
  const blob = new Blob([svg.outerHTML], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `behold-${zoomValue()}${view.env ? "-" + view.env : ""}.svg`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  nowline(`↓ exported ${a.download}`);
}

// behold#882: the graph as a picture, for a document or a slide. The SVG on
// the page leans on the stylesheet (theme variables, the cloud tints, edge
// styles) and on linked vendor marks, none of which a bare copy carries, so
// the copy gets every element's computed paint written onto it and each mark
// inlined. It is the view as it stands (zoomed in, it is the zoomed view),
// at 1-4x, optionally under a heading and with the graph's key drawn in.
const PNG_PAINT = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "opacity", "fill-opacity", "stroke-opacity", "font-size", "font-family", "font-weight", "display", "visibility"];
const PNG_HEAD = 44;
let pngOpts = { scale: 2, heading: true, key: true };

async function inlineMarks(clone) {
  for (const img of clone.querySelectorAll("image")) {
    const href = img.getAttribute("href") || img.getAttribute("xlink:href") || "";
    if (!href || href.startsWith("data:")) continue;
    try {
      const text = await (await fetch(href)).text();
      img.setAttribute("href", `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`);
    } catch {
      img.remove();
    }
  }
}

function keyRows() {
  const legend = document.getElementById("graph-legend");
  if (!legend || legend.classList.contains("closed")) return [];
  const rows = [];
  for (const el of legend.children) {
    if (el.classList.contains("gl-head")) continue;
    if (el.classList.contains("gl-sub")) {
      rows.push({ sub: el.textContent });
      continue;
    }
    const swatch = el.firstElementChild;
    const colours = swatch && swatch.children.length ? [...swatch.children].map((c) => getComputedStyle(c).backgroundColor) : swatch ? [getComputedStyle(swatch).backgroundColor] : [];
    const text = el.querySelector(".grow")?.textContent ?? "";
    const count = el.querySelector(".gl-count")?.textContent ?? "";
    rows.push({ colours, text, count });
  }
  return rows;
}

async function exportPng() {
  const svg = currentSvg();
  if (!svg || !vb) {
    nowline("✗ export: no graph loaded yet");
    return;
  }
  const { scale, heading, key } = pngOpts;
  // At the fit the view leaves room for the floating panel; the picture takes
  // the graph's own bounds instead, with a margin. Zoomed or panned, it takes
  // the view as it stands.
  const pad = vbInit ? Math.max(vbInit[2], vbInit[3]) * 0.02 : 0;
  const area = vbAtFit && vbInit ? [vbInit[0] - pad, vbInit[1] - pad, vbInit[2] + 2 * pad, vbInit[3] + 2 * pad] : vb;
  const box = svg.getBoundingClientRect();
  const w = Math.round(box.width);
  const h = Math.round((w * area[3]) / area[2]);
  const head = heading ? PNG_HEAD : 0;
  // The key gets a band of its own under the graph, never drawn over it.
  const rowsForKey = key ? keyRows() : [];
  const keyLine = 17;
  const keyBand = rowsForKey.length ? rowsForKey.length * keyLine + 28 : 0;
  const clone = svg.cloneNode(true);
  const from = [svg, ...svg.querySelectorAll("*")];
  const to = [clone, ...clone.querySelectorAll("*")];
  for (let i = 0; i < from.length && i < to.length; i++) {
    const cs = getComputedStyle(from[i]);
    to[i].setAttribute("style", PNG_PAINT.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
  }
  await inlineMarks(clone);
  clone.setAttribute("x", "0");
  clone.setAttribute("y", String(head));
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  clone.setAttribute("viewBox", area.join(" "));
  const root = getComputedStyle(document.documentElement);
  const bg = root.getPropertyValue("--bg").trim() || "#ffffff";
  const fg = root.getPropertyValue("--fg").trim() || "#000000";
  const muted = root.getPropertyValue("--muted").trim() || fg;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const title = esc(document.title || "behold");
  const sub = esc(document.getElementById("meta")?.textContent?.trim() ?? "");
  const total = h + head + keyBand;
  const parts = [`<rect width="${w}" height="${total}" fill="${bg}"/>`];
  if (heading) {
    parts.push(`<text x="16" y="22" fill="${fg}" font-family="system-ui, sans-serif" font-size="16" font-weight="700">${title}</text>`);
    parts.push(`<text x="16" y="38" fill="${muted}" font-family="system-ui, sans-serif" font-size="11">${sub}</text>`);
  }
  parts.push(new XMLSerializer().serializeToString(clone));
  if (rowsForKey.length) {
    const kx = 16;
    const ky = head + h + 14;
    rowsForKey.forEach((r, i) => {
      const y = ky + i * keyLine + 9;
      if (r.sub) {
        parts.push(`<text x="${kx}" y="${y + 3}" fill="${muted}" font-family="system-ui, sans-serif" font-size="10.5">${esc(r.sub)}</text>`);
        return;
      }
      r.colours.forEach((c, j) => parts.push(`<rect x="${kx + j * 9}" y="${y - 6}" width="7" height="11" rx="1.5" fill="${c}"/>`));
      parts.push(`<text x="${kx + 32}" y="${y + 3}" fill="${fg}" font-family="system-ui, sans-serif" font-size="11.5">${esc(r.text)}${r.count ? ` <tspan fill="${muted}">${esc(r.count)}</tspan>` : ""}</text>`);
    });
  }
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${total}" viewBox="0 0 ${w} ${total}">${parts.join("")}</svg>`;
  const url = URL.createObjectURL(new Blob([doc], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise((ok, fail) => {
      img.onload = ok;
      img.onerror = () => fail(new Error("the picture did not render"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = w * scale;
    canvas.height = total * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise((ok) => canvas.toBlob(ok, "image/png"));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `behold-${zoomValue()}${view.env ? "-" + view.env : ""}@${scale}x.png`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    nowline(`↓ exported ${a.download}`);
  } catch (e) {
    nowline(`✗ export: ${e.message}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// --- Command palette (⌘K / Ctrl+K, #73) -----------------------------------
// Ported from spicypath's FG-036 pattern (../spicypath/src/index.html: search
// `#palette`, `paletteCommands`, `openPalette`) — same shape (module-level
// palCmds/palSel/palCurrent, paletteCommands() rebuilding a fresh {label, run}
// list from live state on every open, palRender() filtering + repainting,
// openPalette()/closePalette() toggling the `.on` class), retargeted at
// behold's own handlers instead of spicypath's. "Hide controls, never state"
// (spicypath's own design rule, carried over): every control here also lives
// on the floating panel now, and the current values stay visible in the
// header (renderStatusbar(), #meta) — the palette is the fast surface, the
// panel the discoverable one.
const palette = document.getElementById("palette");
const palInput = document.getElementById("pal-input");
const palList = document.getElementById("pal-list");
let palCmds = [], palSel = 0, palCurrent = [];

// Builds the live command list fresh on every open, so it always reflects
// current state (which env is picked, whether the inspect pane is collapsed,
// what previewMode hides) rather than a snapshot from page load.
function paletteCommands() {
  const c = [];

  // Reads — always available, even in a static export or the preview lock.
  // #569: not in a public view — Refresh is a POST.
  if (!staticMode && !publicMode) c.push(["Re-check live (refresh drift)", () => refresh()]);
  // #404: the expensive sibling, listed beside it and named for what it costs.
  // Offered only with an env picked — there is no overlay to plan against
  // without one — and disabled-with-its-reason otherwise, the convention the
  // colour-mode and carve rows below already follow.
  if (!staticMode && !publicMode) {
    c.push(
      view.env
        ? ["Re-check live with plan (attribute drift) — a full read of the account", () => refreshWithPlan()]
        : ["Re-check live with plan (attribute drift) — pick an environment first", () => showToast("attribute drift is read from a plan, which needs an environment to plan against", false)],
    );
  }
  // #910: a stock Terraform root's plan, through chant, onto its cards.
  if (!staticMode && !publicMode && !view.env && projectInfo && (projectInfo.memberKinds || []).includes("terraform")) {
    c.push(["Read the plan on the Terraform roots (replaces, forcing attributes, unknowns, drift)", () => readTerraformPlan()]);
  }
  c.push(["Fit graph to view", () => fitGraph()]);
  c.push(["Export: current graph as SVG", () => exportSvg()]);
  const inspectCollapsed = document.getElementById("app").classList.contains("inspect-collapsed");
  c.push([inspectCollapsed ? "Show inspect panel" : "Hide inspect panel", () => toggleInspect()]);
  // The floating control panel (panel.js): collapse/expand + jump to a tab.
  c.push([isPanelCollapsed() ? "Expand control panel" : "Collapse control panel", () => togglePanelCollapsed()]);
  for (const b of document.querySelectorAll("#panel-tabs button[data-tab]")) {
    c.push([`Panel: ${b.textContent}`, () => setPanelTab(b.dataset.tab)]);
  }
  // #254: the walkthrough's steps get palette twins like every other control.
  // Blocked steps are listed with their reason rather than hidden — "why can't
  // I do that yet" is the question the palette should be able to answer.
  if (carveMode()) {
    CARVE_STEPS.forEach((s, i) => {
      const why = blockedReason(carveState, s.id);
      c.push([
        `Carve: ${i + 1}. ${s.label}${why ? ` — ${why}` : ""}`,
        () => {
          if (why) return showToast(why, false);
          setPanelTab("carve");
          carveActions.go(i);
        },
      ]);
    });
  }

  // Lens/zoom switches (#56, #63) — replaces the old header zoom picker.
  for (const [label, v] of availableZooms()) {
    c.push([label + (v === zoomValue() ? " ✓" : ""), () => { applyZoom(v); load(); }]);
  }
  // #399: the colour-by modes, with the same ✓ every other lens row carries.
  // A disabled mode is LISTED with its reason rather than hidden — same rule
  // #254's blocked carve steps follow, and the same reason: "why can't I do
  // that" is a question the palette should be able to answer.
  for (const mode of COLOUR_MODES) {
    const gate = mode === "drift" ? { available: true, reason: "" } : modeAvailability(lastMeta, mode);
    const why = gate.available ? "" : ` — ${gate.reason}`;
    c.push([
      `color by: ${mode}${mode === activeColourMode() ? " ✓" : ""}${why}`,
      () => {
        if (!gate.available) return showToast(gate.reason, false);
        setColourMode(mode);
      },
    ]);
  }
  // Radial toggle — entity zooms only, same gate the removed checkbox had
  // (components/logical/ops all lay themselves out: waves / nested arch boxes /
  // phase boxes).
  if (!view.components && !view.logical && !view.ops && !(lastMeta && lastMeta.estate > 1)) {
    c.push([(view.radial ? "Disable" : "Enable") + " radial layout", () => { view.radial = !view.radial; load(); }]);
  }
  // #393: 301 cards in one box read as a strip at any zoom. This shuts every
  // box over the server's limit down to a card carrying its own counts, so an
  // estate can be read at the level of its members first.
  //
  // Not in a static export: `captureKeys` (src/export.ts) captures the estate
  // once, expanded, and a bundle that offers a stop it has no snapshot behind
  // answers the click with "not in this static export". `collapse` is in
  // `canonicalKey`'s LENS_PARAMS all the same, so the day a bundle does carry
  // both, the two keys are already distinct.
  if (!staticMode && !view.components && !view.ops) {
    c.push([view.collapse ? "Expand all" : "Collapse large boxes", () => { view.collapse = !view.collapse; load(); }]);
  }
  if (isEstate()) c.push([view.alike && alikeZoom() ? "Unstack alike cards" : "Stack alike cards", toggleAlike]);

  // Env/stack/tier/target selection — replaces the old header pickers.
  if (view.member) c.push([`member: whole estate (leave ${view.member})`, () => { view.member = null; selectedNodeId = null; renderStatusbar(); fitGraph(); }]);
  for (const m of lastGraphIr ? membersOf(lastGraphIr) : []) {
    if (m !== view.member) c.push([`member: ${m}`, () => { view.member = m; selectedNodeId = null; renderStatusbar(); revealMember(m); }]);
  }
  c.push(["env: (source)" + (!view.env ? " ✓" : ""), () => { view.env = null; resetDialCaches(); load(); }]);
  for (const e of environments) {
    c.push([`env: ${e}` + (view.env === e ? " ✓" : ""), () => { view.env = e; resetDialCaches(); load(); }]);
  }
  // The stack picker (#76, follow-up to #71) — only ever populated (`stacks`,
  // seeded in initPickers()) when the served project declares `chant.config.
  // ts`'s `stacks[]`; empty on every single-stack/sourceDir-only/legacy
  // project, so this loop (and the status strip's `stack:` tag) is a no-op
  // there. No "stack: (none)" escape hatch like env's "(source)" above —
  // the design's locked default is always the first declared stack, never "no
  // stack selected".
  for (const s of stacks) {
    c.push([`stack: ${s}` + (view.stack === s ? " ✓" : ""), () => { view.stack = s; resetDialCaches(); load(); }]);
  }
  for (const t of tiers) {
    c.push([`tier: ${t}` + (view.tier === t ? " ✓" : ""), () => { view.tier = t; resetDialCaches(); load(); }]);
  }
  for (const t of targets) {
    c.push([`target: ${t.endpoint}` + (view.target === t.endpoint ? " ✓" : ""), () => { view.target = t.endpoint; resetDialCaches(); load(); }]);
  }

  if (staticMode || publicMode || terragucciRepo) return c.map(([label, run]) => ({ label, run })); // no writes at all in a static export, a public view (#569) or a terragucci repo

  // Deploy / write actions — previewMode hides exactly the git/PR write
  // affordances the toolbar hid (Rollback, Sync, Run <op>); Apply all, Reset,
  // Bring up, and Approve stay reachable, mirroring initActions()'s and
  // renderSubstrates()'s previous button-gating precisely.
  if (!previewMode) {
    if (opsApply) {
      // #165: not for a designated env — its ApplyOp is refused server-side too.
      if (!designatedFor(view.env || opsInitialEnv)) c.push([`Deploy: Sync (${opsApply.name})`, () => runOp(opsApply.name)]);
      if (opsApply.gate && !embedOpts.embed) c.push([`Approve ${opsApply.gate}`, () => signal(opsApply.name, opsApply.gate)]);
    }
    // #165: a designated env's applies happen on the forge, so a rollback PR
    // opened from here would have nothing local to land — hidden, as designed.
    if (!designatedFor(view.env || opsInitialEnv)) c.push(["Rollback to a prior revision…", () => paletteRollback()]);
    for (const op of opsRunnable) {
      c.push([`Run: ${op.name}`, () => { if (window.confirm(`Run Op "${op.name}"?`)) runOp(op.name); }]);
    }
  }
  // No committed ApplyOp, but there's an env → "Apply all" is the equivalent
  // deploy action (M3) — stays available in preview (a local write, not git/PR).
  if (!opsApply && opsInitialEnv && !designatedFor(opsInitialEnv)) c.push([`Deploy: Apply all → ${opsInitialEnv}`, () => confirmApplyAll()]);
  // #165: a designated env deploys through its forge, from the palette too.
  if (designatedFor(view.env || opsInitialEnv) && !previewMode) {
    const d = designatedFor(view.env || opsInitialEnv);
    if (d.ok) c.push([`Deploy via ${d.forge} → ${view.env || opsInitialEnv}`, () => dispatchPipeline(view.env || opsInitialEnv)]);
  }

  for (const s of lastSubstrates) {
    if (s.bringUp) c.push([`Bring up ${s.label}`, () => bringUpSubstrate(s)]);
    if (s.name === "floci" && s.status === "up") c.push(["Reset local emulator (Floci)", () => resetLocal()]);
    // Dispatch a GitHub Actions run (#164) — through the operator's own `gh`
    // login. Offered whenever the pill exists; the server refuses honestly
    // (no gh, unauthenticated, no matching workflow_dispatch workflow) and
    // the reason lands as a toast.
    if (s.name === "github" && !previewMode) {
      c.push(["Run pipeline: GitHub Actions", () => dispatchPipeline()]);
    }
  }

  return c.map(([label, run]) => ({ label, run }));
}

// --- ⌘K takes an address (#393 item 4) ---------------------------------------
// The audit's finding was that the palette had zoom, env, panel and deploy
// commands and nothing that took a node. The SPA already holds the IR it
// painted (`lastGraphIr`), so the whole feature is a filter over it.
//
// Built per keystroke rather than baked into `paletteCommands()` on open: a
// 301-card estate would otherwise put 301 rows in front of somebody who typed
// nothing, and push every command below them. Nothing at all until two
// characters are typed, and at most {@link PAL_NODE_ROWS} rows after that.
//
// Outside `paletteCommands()` for a second reason: that function returns early
// in a static export (no writes there at all), and finding a card is a READ.
// Nothing below fetches anything — the IR is the one the page painted and the
// pan is a viewBox — so a bundle answers ⌘K exactly as a served project does.

/** How many node rows the palette will show. A cap, not a ranking: past a
 * dozen the reader is scrolling a list rather than recognising a name, and the
 * answer is a longer query. */
const PAL_NODE_ROWS = 12;

/** The address inside a composed id — `terralith-4/aws_iam_role.x` is the id,
 * `aws_iam_role.x` is what a person types. A member name cannot hold a slash
 * (composeStacks' `shortStackNames`), so the FIRST one splits it. */
function nodeAddress(id) {
  const slash = id.indexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}
function nodeMember(id) {
  const slash = id.indexOf("/");
  return slash >= 0 ? id.slice(0, slash) : "";
}

/** The node rows for a query: matches on the composed id and on the address,
 * with anything that STARTS with the query first — typing `aws_iam_role.team_00`
 * should reach `aws_iam_role.team_0007_role` before a card that merely mentions
 * it. Stable within each half (the IR's own order), so the list does not
 * reshuffle as a query grows. */
function paletteNodes(q) {
  if (!lastGraphIr || q.length < 2) return [];
  const prefix = [];
  const rest = [];
  for (const n of lastGraphIr.nodes) {
    const address = nodeAddress(n.id);
    const id = n.id.toLowerCase();
    const a = address.toLowerCase();
    if (a.startsWith(q) || id.startsWith(q)) prefix.push({ n, address });
    else if (a.includes(q) || id.includes(q)) rest.push({ n, address });
    if (prefix.length >= PAL_NODE_ROWS) break;
  }
  return [...prefix, ...rest].slice(0, PAL_NODE_ROWS).map(({ n, address }) => ({
    label: `node: ${address}`,
    // What the address alone does not say: which member it is in, and what it
    // is. Two members of one estate can declare the same address.
    sub: [nodeMember(n.id), n.kind, n.lexicon].filter(Boolean).join(" · "),
    run: () => {
      selectNode(n.id); // the same path a graph click takes — inspect included
      if (!revealNode(n.id)) showToast(`${address} is not on this view — it may be elided at this zoom`, false);
    },
  }));
}

function palRender() {
  const q = palInput.value.toLowerCase().trim();
  const cmds = q ? palCmds.filter((c) => c.label.toLowerCase().includes(q)) : palCmds;
  // Nodes first: a query that matches a card is nearly always somebody looking
  // for that card, and a query that matches no card costs nothing.
  palCurrent = [...paletteNodes(q), ...cmds];
  palSel = Math.max(0, Math.min(palSel, palCurrent.length - 1));
  palList.replaceChildren();
  if (!palCurrent.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "no matching command";
    palList.appendChild(e);
    return;
  }
  palCurrent.forEach((c, i) => {
    const d = document.createElement("div");
    d.className = "row" + (i === palSel ? " sel" : "");
    d.textContent = c.label;
    if (c.sub) {
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = c.sub;
      d.appendChild(sub);
    }
    d.onmousedown = (ev) => {
      ev.preventDefault();
      closePalette();
      c.run();
    };
    palList.appendChild(d);
  });
}
function openPalette() {
  palCmds = paletteCommands();
  palSel = 0;
  palInput.value = "";
  palRender();
  palette.classList.add("on");
  palInput.focus();
}
function closePalette() {
  palette.classList.remove("on");
}
palInput.oninput = () => { palSel = 0; palRender(); };
palInput.onkeydown = (e) => {
  if (e.key === "ArrowDown") { palSel++; palRender(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { palSel--; palRender(); e.preventDefault(); }
  else if (e.key === "Enter") { const c = palCurrent[palSel]; closePalette(); if (c) c.run(); e.preventDefault(); }
  else if (e.key === "Escape") { closePalette(); e.stopPropagation(); e.preventDefault(); }
};
palette.onmousedown = (e) => { if (e.target === palette) closePalette(); }; // backdrop click
document.getElementById("hintk").addEventListener("click", openPalette);

// Global ⌘K / Ctrl+K toggle — fires even while focus is inside another input
// (e.g. an apply-picker <select>), matching spicypath's own keymap.
window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    palette.classList.contains("on") ? closePalette() : openPalette();
  }
});

// Readable text on the accent-filled selected row (spicypath's --on-accent),
// across all 552 Ghostty themes — behold has no static equivalent since
// --pending's lightness varies per theme, so this reuses theme.js's own
// contrast helper (the same one recolorNodesByCategory() uses for node labels)
// instead of assuming light-on-dark or dark-on-light.
function applyPaletteContrast() {
  const t = getTokens();
  if (t) document.documentElement.style.setProperty("--pal-sel-fg", readableOn(t.pending));
}
applyPaletteContrast();
onThemeChange(applyPaletteContrast);
