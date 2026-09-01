// behold SPA. Fetches the read-only graph from the server — chant's IR + pinhole's
// rendered SVG — inlines the SVG and wires click-inspect. The visual is pinhole's
// mature painter (themes, icons, `_status` drift colouring); behold owns the data,
// the inspect panel, and (later) the lanes + delegated actions.

// Ghostty colour themes (#62): apply the persisted/default theme's tokens as CSS vars
// before first paint (so the whole graph + chrome recolour from one source). Then the
// floating control panel's chrome (panel.js — drag/snap/collapse/tabs, persisted
// position), and the theme picker into the panel's View-tab slot (a stable element
// renderPanelView never rewrites, so the select mounts once and survives re-renders).
import { initTheme, mountThemePicker, readableOn, colorForCategory, onThemeChange, getTokens } from "./theme.js";
import { addPanelTab, initPanel, setPanelTab, togglePanelCollapsed, isPanelCollapsed } from "./panel.js";
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
import { hasPlayhead, renderPlayhead, waitingFor } from "./run-playhead.js";
// #234 joins 3 + 1: the operator strip (one honestly-dated tick per ConvergeOp,
// the lease, the pending gate count) and the converge gate card, whose Approve
// records a fact for the next tick rather than releasing anything. Same split as
// the playhead — the decisions are pure in there, the fetches stay here.
import { hasOperator, renderOperator, APPROVED_SEMANTICS } from "./operator.js";
// #165: the recorded release on a component — which run put it here, from
// which commit, approved by whom — and, when the ledger's run id cannot be
// followed, the reason in words rather than a guessed link.
import { releaseRows } from "./release.js";
initTheme();
initPanel();
mountThemePicker(document.getElementById("panel-theme"));

// Colour node fills by category/kind using the theme's FULL palette (spicypath-style, so the
// graph shows the theme's many colours), while pinhole's drift stays on the bar/stroke. Node
// labels/icons get readable ink (black/white) on the category fill. Re-runs on theme switch,
// since the categorical hues come from the active theme's palette.
let lastGraphIr = null;
function recolorNodesByCategory(ir) {
  if (ir) lastGraphIr = ir;
  const graphIr = ir || lastGraphIr;
  const svg = document.querySelector("#graph svg");
  if (!svg || !graphIr) return;
  const kindOf = new Map(graphIr.nodes.map((n) => [n.id, n.kind || n.lexicon || "node"]));
  for (const g of svg.querySelectorAll("[data-node-id]")) {
    const kind = kindOf.get(g.getAttribute("data-node-id"));
    if (!kind) continue;
    const cat = colorForCategory(kind), ink = readableOn(cat);
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
}
onThemeChange(() => recolorNodesByCategory());

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
let manifest = null;
if (staticMode) {
  try {
    manifest = await fetch("./manifest.json").then((r) => r.json());
  } catch {
    /* no manifest → apiFetch falls back to a not-captured error */
  }
}

/** Canonical key for a read URL — path + the lens params (whitelisted, sorted)
 * that select a distinct snapshot. MUST match src/export.ts `canonicalKey`. */
const LENS_PARAMS = ["components", "detail", "env", "logical", "ops", "radial", "runtime", "tier"];
function canonicalKey(path, params) {
  // Components + logical + ops views ignore detail/radial — drop them so they
  // match the single captured snapshot (MUST match src/export.ts).
  const flat = params.get("components") === "1" || params.get("logical") === "1" || params.get("ops") === "1";
  const q = LENS_PARAMS.filter((k) => params.has(k) && !(flat && (k === "detail" || k === "radial")))
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
function renderDriftSection(section, r) {
  const rd = section("render diff");
  rd("verdict", RENDER_VERDICT_LABEL[r.verdict] || r.verdict);
  if (r.reason) rd("reason", RENDER_UNOBSERVED_LABEL[r.reason] || r.reason);
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
        (isArtifact ? ARTIFACT_STATUS_LABEL[st] : liveStatus || tickStatus ? COMPONENT_STATUS_LABEL[st] : STATUS_LABEL[st]) ||
        st,
    );
  if (node.attrs && node.attrs._artifact) {
    const a = node.attrs._artifact;
    if (a.release) id("release", a.release);
    if (a.status) id("release status", a.status);
    if (a.revision) id("revision", a.revision);
    if (a.chart) id("chart", a.chart);
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
    if (node.ownership) live("ownership", node.ownership);
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
      tick("", "older than the operator's own cadence allows for — this verdict is history, so no colour was taken from it");
    }
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
  }

  // Declared attributes — the source-of-truth values / cross-resource refs.
  // The `release` chip is the card's abbreviation of the section above, not a
  // declared value, so it stays out of this list when the section rendered.
  const attrKeys = Object.keys(node.attrs || {}).filter((k) => !k.startsWith("_") && !(k === "release" && release));
  if (attrKeys.length) {
    const decl = section("declared");
    for (const k of attrKeys) decl(k, fmtValue(node.attrs[k]));
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
    ci("stage", job.stage);
    ci("needs", job.needs.length ? job.needs.join(", ") : "(none)");
    ci("runs", job.script.length ? job.script.join(" && ") : `chant run --components ${node.id}`);
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
      res("", "(none found under this component's source directory)");
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
async function loadNodeDiff(id) {
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
  if (o.ownership) add("ownership", o.ownership);
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
  // #259: an observed attribute is whatever the substrate reported — a k8s
  // `spec`, a nested `loadBalancer`, an array of ports. All of it collapsible
  // now, instead of one flat JSON.stringify line per key.
  for (const [k, v] of Object.entries(o.attributes || {})) {
    if (k === "conditions") continue; // rendered above, one line each
    add(k, valueCell(v));
  }
  panel.appendChild(dl);
}

const DIFF_LABEL = {
  drifted: "drifted since snapshot",
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
      // #254: in carve mode a click is also the walkthrough's Pick step — the
      // inspect pane already shows the score arithmetic the lens spelled out,
      // and the stepper picks up the same node.
      carvePick(node);
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
const view = { env: null, detail: 2, components: true, logical: false, runtime: false, ops: false, tier: null, target: null, stack: null, radial: false };

// #182: `components` is the boot default, but a project that declares no
// components renders it as ZERO nodes — the first screen was a blank graph
// pane with only a statusbar note explaining. True exactly once, consumed by
// load(): an empty first components fetch falls back to the resources zoom
// before anything is painted. An explicit later pick of "components" (panel
// or ⌘K) still shows the honest empty view + the server's note.
let autoZoomFallback = true;

// v0.1.0 preview lock (set from /api/project in initActions): hides the git/PR
// write ops (Rollback, Sync, Adopt, Run ▾) — the server also 403s them. Local
// deploy (Apply all / dial), Reset, Bring up, Approve, and reads stay on.
let previewMode = false;

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
];
const ZOOM_DETAIL = { composites: 1, resources: 2, attributes: 3, runtime: 3 };
/** How many emitted Ops the served estate has (0 = the stop doesn't exist).
 * Seeded from /api/project in initPickers(). */
let opsAvailable = 0;
/** The zoom stops this project can actually offer — `runtime` needs an env,
 * `ops` needs emitted op.json files. Both the panel and ⌘K read this, so a stop
 * never appears in one surface and not the other. */
function availableZooms() {
  return ZOOM_OPTS.filter(([, z]) => (z === "runtime" ? Boolean(view.env) : z === "ops" ? opsAvailable > 0 : true));
}
/** Current zoom value from (components, logical, ops, detail). */
function zoomValue() {
  if (view.components) return "components";
  if (view.logical) return "logical";
  if (view.ops) return "ops";
  if (view.runtime) return "runtime";
  return { 1: "composites", 2: "resources", 3: "attributes" }[view.detail] ?? "resources";
}
/** Apply a zoom value back onto (components, logical, ops, detail). */
function applyZoom(z) {
  view.components = z === "components";
  view.logical = z === "logical";
  view.ops = z === "ops";
  view.runtime = z === "runtime";
  if (z !== "components" && z !== "logical" && z !== "ops") view.detail = ZOOM_DETAIL[z] ?? 2;
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
        load();
      }),
    );
  }
  // Radial toggle — entity zooms only, same gate the ⌘K entry has
  // (components/logical/ops all lay themselves out: waves / nested arch boxes /
  // phase boxes).
  if (!view.components && !view.logical && !view.ops) {
    zoom.appendChild(panelHeading("layout"));
    zoom.appendChild(
      panelOpt("radial", view.radial, () => {
        view.radial = !view.radial;
        load();
      }, "Curl the wide DAG onto concentric rings"),
    );
  }
  const tools = document.getElementById("panel-viewtools");
  tools.innerHTML = "";
  tools.appendChild(panelHeading("graph"));
  const row = document.createElement("div");
  row.className = "prow";
  row.appendChild(actButton("⤢ fit", () => fitGraph(), "Reset zoom/pan to fit. Pinch or ⌘/Ctrl+scroll zooms at the cursor; drag pans."));
  row.appendChild(actButton("↓ SVG", () => exportSvg(), "Export the current graph as a standalone SVG file"));
  const collapsed = document.getElementById("app").classList.contains("inspect-collapsed");
  row.appendChild(
    actButton(collapsed ? "show inspect" : "hide inspect", () => {
      toggleInspect();
      renderPanelView();
    }),
  );
  const lanes = document.createElement("a");
  lanes.href = "/lanes";
  lanes.textContent = "lanes →";
  lanes.title = "The time-lanes view — captured frames of this graph over time";
  lanes.style.cssText = "color:var(--pending);text-decoration:none;font-size:var(--t-body)";
  row.appendChild(lanes);
  tools.appendChild(row);
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
    if (!staticMode) row.appendChild(actButton("⌖ reveal", () => revealProject(dir), "Open this project's folder in your file manager"));
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
  if (targets.length) {
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

function panelDotRow(color, main, tag, onClick) {
  const row = document.createElement("div");
  row.className = onClick ? "node-row" : "count-row";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = color;
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

// Select a node from a panel row the same way a graph click would: highlight
// its card (when it's in the current SVG) and open its inspect panel.
function selectNode(id) {
  const node = lastGraphIr && lastGraphIr.nodes.find((n) => n.id === id);
  if (!node) return;
  const host = document.getElementById("graph");
  host.querySelectorAll(".sel").forEach((n) => n.classList.remove("sel"));
  const g = host.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
  if (g) g.classList.add("sel");
  inspect(node);
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
  } else if (drift) {
    host.appendChild(panelHeading(`drift · ${m.env}`));
    const c = count(STATUS_LABEL);
    for (const [k, label] of Object.entries(STATUS_LABEL)) {
      // The additive buckets (chant#1168 unobserved, chant#1180 runtime) stay
      // hidden until a chant actually emits them — same as the old legend.
      if ((k === "neutral" || k === "runtime") && !c[k]) continue;
      host.appendChild(panelDotRow(DRIFT_STATUS_VAR[k], label, String(c[k])));
    }
    // The actionable nodes — foreign (adoptable) and pending (not applied yet).
    const attention = ir.nodes.filter((n) => {
      const s = n.attrs && n.attrs._status;
      return s === "warn" || s === "accent";
    });
    if (attention.length) {
      host.appendChild(panelHeading("needs attention"));
      for (const n of attention.slice(0, 40)) {
        const s = n.attrs._status;
        host.appendChild(panelDotRow(DRIFT_STATUS_VAR[s], n.id, STATUS_LABEL[s], () => selectNode(n.id)));
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
  if (!svg || !carvedIds.size) return;
  for (const g of svg.querySelectorAll("[data-node-id]")) {
    const id = g.getAttribute("data-node-id");
    if (!carvedIds.has(id) || g.querySelector('[data-carved="1"]')) continue;
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
  if (view.stack) parts.push(`stack: ${view.stack}`);
  if (axes.tier) parts.push(`tier: ${axes.tier}`);
  if (view.radial && !view.components && !view.logical && !view.ops) parts.push("radial");
  el.textContent = parts.join(" · ");
  // #131: why this level rendered empty, or as the one below it. The server
  // decides (src/zoom-notes.ts) — the SPA never infers it, so the note always
  // describes the graph that actually came back. Appended rather than mixed
  // into `parts` so it can carry its own emphasis without the zoom/env strip
  // changing shape when there is nothing to say.
  if (lastNote) {
    const note = document.createElement("span");
    note.className = "statusbar-note";
    note.textContent = " — " + lastNote;
    el.appendChild(note);
  }
}

// The note from the last /api/graph or /api/overlay response (`meta.note`),
// or null. Set on every load so a level that stops degrading stops explaining
// itself.
let lastNote = null;

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

async function loadCi() {
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
// (`chant run <target> --components --env <env> --progress-json` — behold
// triggers, chant executes), and the structured wave/phase progress it
// streams back (see applyProgressReducer in src/apply.ts, broadcast as the
// `apply` SSE event) renders live below the dial — the primary surface for
// an apply, not the raw now-line.
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
// — then a detail-1 composite node lists what it expands to. Cached per lens
// (reset in resetDialCaches); structural, so no live/env call needed.
let compositeMembersCache = null;
async function getCompositeMembers(instanceId) {
  if (!compositeMembersCache) {
    compositeMembersCache = {};
    try {
      const q = lensParams(new URLSearchParams({ detail: "3" }));
      const j = await apiFetch(`/api/graph?${q}`).then((r) => r.json());
      for (const n of (j.ir && j.ir.nodes) || []) {
        if (n.compositeInstance) (compositeMembersCache[n.compositeInstance] ||= []).push({ id: n.id, kind: n.kind });
      }
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

function renderDial() {
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
  if (!staticMode) {
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
    applyBtn.title = `Delegated write: chant run <component|all> --components --env ${view.env} --progress-json — behold triggers, chant executes.`;
    track.appendChild(applyBtn);
  }

  host.appendChild(track);
  if (reconcileCache) host.appendChild(renderReconcileDetail(reconcileCache));
  if (applyPicker && !applying && !staticMode) host.appendChild(renderApplyPicker());
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
      approve: (op, gate) => approveConvergeGate(op, gate),
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
  renderPlayhead(box, runState, gateCard, { approve: (op, gate) => signal(op, gate) });
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
    if (!window.confirm(`Apply ${what} to ${view.env}?\nThis is a real write — chant run --components --progress-json.`)) return;
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
      `${brokenNote}${reapplyNote}Apply ALL components to ${env}?\nReal write — chant run --components all --env ${env} --progress-json.\nLive progress appears in the dial.`,
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
// fallback (src/op-runner.ts's apply() only filters OUT recognized
// RunProgressEvent lines from that channel).
const APPLY_STATUS_COLOR = { pending: "var(--muted)", running: "var(--pending)", ok: "var(--managed)", failed: "var(--degraded)" };

function renderApplyProgress(state) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;width:100%;margin-top:4px";
  const summary = document.createElement("div");
  summary.style.cssText = `font-size:var(--t-caption);color:${APPLY_STATUS_COLOR[state.status] || "var(--muted)"}`;
  // A pipeline run (#163) reuses this whole panel — same shape, different
  // executor — and says so instead of claiming to be an apply.
  summary.textContent = `${state.kind || "apply"}: ${state.status}`;
  wrap.appendChild(summary);
  for (const w of state.waves) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap";
    const label = document.createElement("span");
    label.style.cssText = `font-size:var(--t-caption);color:${APPLY_STATUS_COLOR[w.status] || "var(--muted)"};min-width:52px`;
    label.textContent = `wave ${w.wave}`;
    row.appendChild(label);
    for (const cname of w.components) {
      const c = (state.components || []).find((x) => x.component === cname) || { status: "pending" };
      const color = APPLY_STATUS_COLOR[c.status] || "var(--muted)";
      const chip = document.createElement("span");
      chip.style.cssText = `border:1px solid ${color};color:${color};border-radius:var(--r-ctl);padding:2px 8px;font-size:var(--t-caption)`;
      const detail = [c.phase, c.step].filter(Boolean).join(" · ");
      chip.textContent = `${cname}${detail ? " · " + detail : ""} (${c.status})`;
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

// Edge hover-highlight (helps trace one edge through an overlapping bundle — see
// index.html's `.pin-edge-line` rules). pinhole already paints a fat transparent
// hit-path per edge, so the CSS `:hover` does the visual work; this adds two
// things CSS can't: raise the hovered edge to the top of the paint order (SVG has
// no z-index) so it's not buried, and light up every edge touching a hovered node
// (the `.edge-hi` class) so hovering a card traces all its connections.
// Human-readable "why does this edge exist" from the IR edge's `viaAttr`
// (src/logical.ts tags them). Shown as a native SVG <title> tooltip on hover;
// the value also drives a dashed style for data-dependency links (index.html).
const EDGE_REASON = {
  "security-group ingress": "security-group ingress — traffic is allowed here",
  "data dependency": "data dependency — reads/uses this store",
};
function wireEdgeHighlight(svgEl, ir) {
  const edges = [...svgEl.querySelectorAll("g[data-edge-from]")];
  if (!edges.length) return;
  // Reason per edge, keyed by from|to (and its reverse, since pinhole may paint
  // an edge in either direction relative to the IR).
  const viaOf = new Map();
  for (const e of ir.edges || []) {
    if (!e.viaAttr) continue;
    viaOf.set(`${e.from}|${e.to}`, e.viaAttr);
    viaOf.set(`${e.to}|${e.from}`, e.viaAttr);
  }
  for (const g of edges) {
    const from = g.getAttribute("data-edge-from");
    const to = g.getAttribute("data-edge-to");
    const via = viaOf.get(`${from}|${to}`);
    if (via) g.setAttribute("data-edge-via", via); // drives the dashed style
    const title = document.createElementNS(SVGNS, "title");
    title.textContent = `${from} → ${to}${via ? "\n" + (EDGE_REASON[via] || via) : ""}`;
    g.insertBefore(title, g.firstChild);
  }
  const raise = (g) => g.parentNode && g.parentNode.appendChild(g);
  // Delegated: raise whichever edge the pointer is over (its hit-path catches it).
  svgEl.addEventListener("mouseover", (e) => {
    const g = e.target.closest && e.target.closest("g[data-edge-from]");
    if (g) raise(g);
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

// GitLab's tanuki, one filled silhouette (the widely-used single-path mark),
// scaled into a small badge. Self-contained (no external URL) so it survives the
// static export + the CSP.
const GITLAB_TANUKI =
  "M23.6004 9.5927l-.0337-.0862L20.3.9814a.851.851 0 00-.3362-.405.8748.8748 0 00-.9997.0539.8748.8748 0 00-.29.4399l-2.2055 6.748H7.5375l-2.2055-6.748a.8573.8573 0 00-.29-.4412.8748.8748 0 00-.9997-.0537.8585.8585 0 00-.3362.405L.4332 9.5065l-.0325.0862a6.0657 6.0657 0 002.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 001.2197 0l1.4995-1.1321 2.462-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 002.0094-7.003z";
const SVGNS = "http://www.w3.org/2000/svg";

// Stamp a GitLab tanuki in the top-right corner of each wave lane — a visual cue
// that the waves ARE the GitLab CI pipeline's stages (job `stage` = `wave-N`).
// Post-processes the inlined SVG: each wave box is a `<rect>` immediately
// followed by its `<text>wave-N</text>` title, so the rect gives the corner.
function addGitlabWaveBadges(svgEl) {
  const SIZE = 17;
  for (const text of svgEl.querySelectorAll("text")) {
    if (!/^wave-/i.test((text.textContent || "").trim())) continue;
    const rect = text.previousElementSibling;
    if (!rect || rect.tagName.toLowerCase() !== "rect") continue;
    const rx = parseFloat(rect.getAttribute("x"));
    const ry = parseFloat(rect.getAttribute("y"));
    const rw = parseFloat(rect.getAttribute("width"));
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", "gitlab-wave-badge");
    g.setAttribute("transform", `translate(${rx + rw - SIZE - 12}, ${ry + 10}) scale(${SIZE / 24})`);
    const path = document.createElementNS(SVGNS, "path");
    path.setAttribute("d", GITLAB_TANUKI);
    path.setAttribute("fill", "#FC6D26"); // GitLab brand orange
    const title = document.createElementNS(SVGNS, "title");
    title.textContent = "This wave is a GitLab CI stage (chant → GitLab pipeline)";
    g.append(title, path);
    rect.parentNode.insertBefore(g, text);
  }
}

// Paint a fetched graph: the SVG, the meta line (with a drift summary in overlay
// mode), the legend, and click-inspect wiring. Shared by load() and refresh().
function render(ir, svg, m) {
  // #131: set before anything can early-return, so a level that stopped
  // degrading stops explaining itself on the very next render.
  lastNote = m.note || null;
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
    tail = ` · ${c.good} managed · ${c.warn} foreign · ${c.accent} pending`;
    if (c.neutral) tail += ` · ${c.neutral} unobserved`;
    if (c.runtime) tail += ` · ${c.runtime} runtime`;
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
  const scope = m.estate
    ? `estate of ${m.estate} projects`
    : String(m.projectDir || "").replace(/\/+$/, "").split("/").pop() || m.projectDir;
  // The deploy axes (#59 unify, M2 #54 lenses) — tier/target, kept in sync with
  // what this response actually observed (falls back to the launch-time value
  // from /api/project when a route doesn't echo them, e.g. /api/overlay).
  if (m.tier !== undefined) axes.tier = m.tier;
  if (m.target !== undefined) axes.target = m.target;
  const axesTail = `${axes.tier ? " · tier " + axes.tier : ""}${axes.target ? " · target " + axes.target : ""}`;
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
    setupGraphViewBox(svgEl);
    wireEdgeHighlight(svgEl, ir);
    // Mark each wave lane as a GitLab CI stage when the CI projection is loaded
    // (components view only) — waves ARE the pipeline's stages (`chant build
    // --components --generate gitlab`, see loadCi / #58).
    if (view.components && ciByComponent.size) addGitlabWaveBadges(svgEl);
  }
  ensureZoomControls(g);
  ensureBackToInfra(g);
  wire(ir);
  if (view.radial && !view.components && !view.logical && !view.ops) addRadialLabels(ir);
  markCarvedCards(); // #254: the SVG is replaced per render — re-stamp the marker
  markPlayhead(ir); // #284 item 2: same, for the step the run is sitting on
  markOperatorCards(ir); // #234 free rider: same, for the operating loop's home
  applyLayout(); // #228: last, so the hand-placed deltas ride on top of every other pass
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
    vb = a.slice();
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
}
function fitGraph() {
  if (vbInit) {
    vb = vbInit.slice();
    applyVB();
  }
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
  host.addEventListener(
    "wheel",
    (e) => {
      // Trackpad pinch fires wheel+ctrlKey; ⌘/Ctrl+scroll is the explicit gesture.
      // Plain scroll is left alone (nothing to scroll when fit).
      if (!vb || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const s = currentSvg();
      if (!s) return;
      const r = s.getBoundingClientRect();
      const cx = vb[0] + ((e.clientX - r.left) / r.width) * vb[2];
      const cy = vb[1] + ((e.clientY - r.top) / r.height) * vb[3];
      const f = Math.exp(e.deltaY * 0.0025); // scroll up → f<1 → zoom in
      const minW = vbInit[2] / 60;
      const maxW = vbInit[2] * 3;
      const nw = Math.min(maxW, Math.max(minW, vb[2] * f));
      const nh = nw * (vb[3] / vb[2]);
      vb[0] = cx - ((cx - vb[0]) * nw) / vb[2];
      vb[1] = cy - ((cy - vb[1]) * nh) / vb[3];
      vb[2] = nw;
      vb[3] = nh;
      applyVB();
    },
    { passive: false },
  );
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
    px = e.clientX;
    py = e.clientY;
    applyVB();
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
// Two tiers now (#228's second half): localStorage, and the project's own
// `.behold/layout.json` behind GET/POST /api/layout. On load the server's map
// merges UNDER the local one (`mergeLayouts` — the drag you can see always
// wins); on a finished gesture the current lens is POSTed, debounced. A server
// that refuses — a static export, preview mode, a read-only project, an older
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
  const from = g.getAttribute("data-edge-from");
  const to = g.getAttribute("data-edge-to");
  for (const cand of g.parentNode ? g.parentNode.children : []) {
    if (cand === g || cand.tagName.toLowerCase() !== "g") continue;
    if (cand.getAttribute("data-edge-from") !== from || cand.getAttribute("data-edge-to") !== to) continue;
    if (cand.hasAttribute("data-node-id") || cand.querySelector("path")) continue;
    return cand;
  }
  return null;
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
  if (staticMode || !layoutServer.writable || layoutServer.lens !== lens) return;
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

/** The "↺ layout" control beside ⤢ fit — shown only while something is hand-placed. */
function ensureLayoutReset(host) {
  if (!host) return;
  let btn = document.getElementById("layout-reset");
  if (!btn || btn.parentElement !== host) {
    btn = document.createElement("button");
    btn.id = "layout-reset";
    btn.textContent = "↺ layout";
    btn.title =
      "Drop the hand-placed layout for this project + this lens and go back to dagre's. " +
      "(A resized box never reflows what's inside it — only the next layout does that.)";
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
      nowline("↺ layout reset — back to dagre's placement");
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

// Fetch the current view (source graph, or the picked env's live overlay).
async function load(opts = {}) {
  const meta = document.getElementById("meta");
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
    if (view.components) {
      // M1.1 (#57): the component DAG stays on /api/graph even with an env
      // picked — the server joins live per-component status onto it there
      // (component name -> CFN stack), instead of routing to /api/overlay's
      // cross-substrate entity overlay, which components never use.
      q.set("components", "1");
      if (view.env) q.set("env", view.env);
    } else if (view.ops) {
      // The ops lens (#284): the declared Ops, read from each Op's emitted
      // op.json. Built fresh rather than layered onto the entity lenses,
      // because this view reads NONE of them — no env, no detail, no radial,
      // and no tier (a tier re-evaluates tier-conditioned source, and an Op's
      // IR was already resolved at build). Sending them anyway would also give
      // a static export a different key per tier for one identical snapshot.
      q = new URLSearchParams({ ops: "1" });
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
      // The runtime tier (#86) descends below the declaration boundary. It is
      // live-only by nature — owner-referenced children exist in the cluster,
      // never in your source — so it rides the overlay and means nothing
      // without an env.
      if (view.runtime) q.set("runtime", "1");
    }
    // Radial layout (entity view only) — curl the wide DAG onto concentric rings.
    if (view.radial && !view.components && !view.logical && !view.ops) q.set("radial", "1");
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
    const res = await apiFetch(`${endpoint}?${q}`);
    const body = await res.json();
    if (!res.ok) {
      // #72: a classified precondition failure (lint gate, not installed, a
      // tier that needs credentials) gets the calmer entry/error card instead
      // of the generic red error box — see renderPreconditionError().
      if (body.code) {
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
      return load(opts);
    }
    autoZoomFallback = false;
    render(body.ir, body.svg, body.meta);
  } catch (err) {
    // A background settle poll must not blow away a good graph on a transient error.
    if (!opts.quiet) {
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
  }
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
  renderStatusbar();
  load();
}
initPickers();

// Live updates (#3): re-pull when the server signals the served source changed.
// EventSource reconnects on its own if the server restarts.
// No backend in a static export → no live event stream; a no-op keeps the
// `events.addEventListener(...)` wiring below harmless.
const events = staticMode ? { addEventListener() {} } : new EventSource("/api/events");
// Post-op settle re-pull: an apply's CLI can exit while the last stacks are still
// flipping to *_COMPLETE, so the immediate reload catches a few components mid-
// deploy ("all done, 3 still pending"). Quietly re-pull a couple more times so
// the graph lands on the final colours without a manual Re-check live.
let settleTimers = [];
function scheduleSettle() {
  settleTimers.forEach(clearTimeout);
  settleTimers = [3000, 8000, 15000].map((ms) => setTimeout(() => load({ quiet: true }), ms));
}
events.addEventListener("changed", () => {
  bulkDiffCache = null; // an op ran → per-node live state may have changed
  load();
  loadSubstrates(); // a bring-up (or any op) finished → re-detect readiness
  scheduleSettle();
});

// Substrate readiness (M5, #54): is each substrate the project needs actually
// up? Poll /api/substrates and render rows on the panel's Substrates tab —
// status dot + name + state, with the bring-up/reset/pipeline actions inline
// again (#73 moved those into ⌘K; they remain there too, via lastSubstrates).
async function loadSubstrates() {
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
    if (!staticMode) {
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
function dispatchPipeline() {
  if (!window.confirm("Dispatch the GitHub Actions pipeline?\nRuns via YOUR gh login (gh workflow run); behold follows the run on the dial.")) return;
  fetch("/api/ci/dispatch", { method: "POST" })
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
// #284 item 2: while a DURABLE run is in flight, a gate can open at any moment
// — and the record stream falls silent exactly when it does, so a stalled
// playhead is not evidence of anything. Ask. Only while a run is actually
// running, so an idle behold shells nothing.
setInterval(() => {
  if (runState && runState.status === "running" && runState.mode === "temporal") pollRunStatus();
}, 5000);
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
function showLoading(msg) {
  loadingDepth++;
  const o = document.getElementById("loading-overlay");
  if (!o) return;
  document.getElementById("loading-msg").textContent = msg || "loading…";
  o.hidden = false;
}
function hideLoading() {
  loadingDepth = Math.max(0, loadingDepth - 1);
  if (loadingDepth > 0) return;
  const o = document.getElementById("loading-overlay");
  if (o) o.hidden = true;
}

// #259: the op stream is chant's own stdout, and an Op that reports as JSON
// (a plan summary, a run report, an unrecognized `--progress-json` line that
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
// ApplyProgressState (src/apply.ts) after every recognized RunProgressEvent —
// see src/op-runner.ts's apply(). Re-render the dial's progress panel each
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
// settled StepRecord and every gateState read, so a client that (re)subscribes
// mid-run renders correctly from the very next event. Repaint the dial always;
// re-pull the graph only when the ops lens is what's on screen, since that's
// the view the run state paints over.
events.addEventListener("run", (e) => {
  try {
    runState = JSON.parse(e.data);
  } catch {
    return;
  }
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
  if (staticMode || runStatusInFlight) return;
  const name = runStatusTarget();
  if (!name) return;
  // Only a durable run has gate state at all. A local run's playhead is
  // complete without it, so don't shell chant to be told so.
  if (runState && runState.mode === "local") return;
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
  if (staticMode || operatorInFlight) return;
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
  if (staticMode || operatorHistory.loading) return;
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
        showToast(`✓ approved ${gate}`, true);
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
    previewMode = true;
    return; // nothing else in the bar is a read
  }
  // The env behold launched with (reliable regardless of picker-init ordering) —
  // gates the first-class "Apply all" affordance below; also carries the preview
  // lock that hides the git/PR ops.
  const project = await apiFetch("/api/project").then((r) => r.json()).catch(() => ({}));
  opsInitialEnv = project.currentEnv || null;
  previewMode = staticMode || !!project.previewMode; // static ⇒ read-only, no writes at all
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
  if (opsApply && !previewMode) {
    const deploy = button(`▶ Deploy (${opsApply.name})`, "", () => {
      if (window.confirm(`Run the committed ApplyOp "${opsApply.name}"?\nDelegated write: behold triggers, chant's executor applies.`)) runOp(opsApply.name);
    });
    deploy.title = `chant run ${opsApply.name} — the committed ApplyOp (Build → Plan → Apply). Also in ⌘K as "Deploy: Sync".`;
    bar.appendChild(deploy);
    if (opsApply.gate) {
      const approve = button(`Approve ${opsApply.gate}`, "approve", () => signal(opsApply.name, opsApply.gate));
      approve.title = `chant run signal ${opsApply.name} ${opsApply.gate} — releases the Op's human gate.`;
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
    deploy.title = `chant run <component|all> --components --env ${view.env || opsInitialEnv} --progress-json — opens the component picker on the dial. behold triggers, chant executes.`;
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
initInspectPane();

// Inspect pane chrome (#15): collapse (chevron / edge tab) + drag-to-resize, with
// the width and collapsed state persisted so the layout survives reloads.
// setInspectCollapsed/toggleInspect are module-level (not local to initInspectPane)
// so the ⌘K palette (#73) can drive the same collapse/reopen the chevron does.
function setInspectCollapsed(on) {
  document.getElementById("app").classList.toggle("inspect-collapsed", on);
  localStorage.setItem("behold.inspectCollapsed", on ? "1" : "0");
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
  if (localStorage.getItem("behold.inspectCollapsed") === "1") app.classList.add("inspect-collapsed");

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
  if (!staticMode) c.push(["Re-check live (refresh drift)", () => refresh()]);
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
  // Radial toggle — entity zooms only, same gate the removed checkbox had
  // (components/logical/ops all lay themselves out: waves / nested arch boxes /
  // phase boxes).
  if (!view.components && !view.logical && !view.ops) {
    c.push([(view.radial ? "Disable" : "Enable") + " radial layout", () => { view.radial = !view.radial; load(); }]);
  }

  // Env/stack/tier/target selection — replaces the old header pickers.
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

  if (staticMode) return c.map(([label, run]) => ({ label, run })); // no writes at all in a static export

  // Deploy / write actions — previewMode hides exactly the git/PR write
  // affordances the toolbar hid (Rollback, Sync, Run <op>); Apply all, Reset,
  // Bring up, and Approve stay reachable, mirroring initActions()'s and
  // renderSubstrates()'s previous button-gating precisely.
  if (!previewMode) {
    if (opsApply) {
      c.push([`Deploy: Sync (${opsApply.name})`, () => runOp(opsApply.name)]);
      if (opsApply.gate) c.push([`Approve ${opsApply.gate}`, () => signal(opsApply.name, opsApply.gate)]);
    }
    c.push(["Rollback to a prior revision…", () => paletteRollback()]);
    for (const op of opsRunnable) {
      c.push([`Run: ${op.name}`, () => { if (window.confirm(`Run Op "${op.name}"?`)) runOp(op.name); }]);
    }
  }
  // No committed ApplyOp, but there's an env → "Apply all" is the equivalent
  // deploy action (M3) — stays available in preview (a local write, not git/PR).
  if (!opsApply && opsInitialEnv) c.push([`Deploy: Apply all → ${opsInitialEnv}`, () => confirmApplyAll()]);

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

function palRender() {
  const q = palInput.value.toLowerCase().trim();
  palCurrent = q ? palCmds.filter((c) => c.label.toLowerCase().includes(q)) : palCmds;
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
