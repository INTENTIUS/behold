// behold SPA. Fetches the read-only graph from the server — chant's IR + pinhole's
// rendered SVG — inlines the SVG and wires click-inspect. The visual is pinhole's
// mature painter (themes, icons, `_status` drift colouring); behold owns the data,
// the inspect panel, and (later) the lanes + delegated actions.

const STATUS_LABEL = { good: "managed", warn: "foreign", accent: "pending" };
// M1.1 (#57), palette hardened M2 (#54): the component-DAG live-status join
// paints the same `_status` vocabulary (good/warn/accent/neutral) but with
// different meaning — a stack-health reading, not "managed" — so the inspect
// panel picks this label set for a node that carries `_liveStatus` (see
// joinComponentStatus, src/component-status.ts). `accent` (pinhole's blue
// paint — there's no separate amber token) reads as "in progress" here,
// distinct from the entity overlay's "pending" meaning for the same colour.
const COMPONENT_STATUS_LABEL = { good: "healthy", accent: "in progress", warn: "rollback / failed", neutral: "not deployed" };

// A declared attribute value may be a cross-resource reference ({$ref:"x.y"}) —
// the "static infra refs" — rather than a concrete value. Render those readably;
// concrete values (present once a resource is provisioned) show as-is.
function fmtValue(v) {
  if (v && typeof v === "object") {
    if (typeof v.$ref === "string") return "→ " + v.$ref;
    return JSON.stringify(v);
  }
  return String(v);
}

function inspect(node) {
  const panel = document.getElementById("inspect");
  panel.innerHTML = "<h2>inspect</h2>";
  const section = (title) => {
    const h = document.createElement("h3");
    h.textContent = title;
    h.style.cssText = "font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin:14px 0 6px";
    panel.appendChild(h);
    const dl = document.createElement("dl");
    panel.appendChild(dl);
    return (k, v) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
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
  if (st) id("status", (liveStatus ? COMPONENT_STATUS_LABEL[st] : STATUS_LABEL[st]) || st);
  if (node.sourceLoc && node.sourceLoc.file) id("source", node.sourceLoc.file);

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
  } else if (st === "accent") {
    const live = section("live");
    live("", "not provisioned yet (pending) — no live state");
  }

  // Declared attributes — the source-of-truth values / cross-resource refs.
  const attrKeys = Object.keys(node.attrs || {}).filter((k) => !k.startsWith("_"));
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
    const ci = section("CI (GitLab)");
    ci("stage", job.stage);
    ci("needs", job.needs.length ? job.needs.join(", ") : "(none)");
    ci("runs", job.script.length ? job.script.join(" && ") : `chant run --components ${node.id}`);
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
  if (adoptable(node)) {
    const b = button("Adopt", "", () => runOp(adopt.reconcile.name));
    b.title = `Reconcile ${node.id} into source via ${adopt.reconcile.name} (opens a PR)`;
    const wrap = document.createElement("p");
    wrap.style.marginTop = "12px";
    wrap.appendChild(b);
    panel.appendChild(wrap);
  }

  // Live drift for this node (#27): field-level changes since the last snapshot,
  // or its presence category. On demand — a live diff is a build + cloud query,
  // so it's a click, not automatic. Only meaningful with an env (overlay mode).
  if (view.env && st) {
    const wrap = document.createElement("p");
    wrap.style.marginTop = "12px";
    const b = button("Load live state", "", async () => {
      b.disabled = true;
      b.textContent = "loading…";
      try {
        const res = await fetch(`/api/diff/${encodeURIComponent(node.id)}?env=${encodeURIComponent(view.env)}`);
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || res.statusText);
        wrap.remove();
        renderObserved(panel, j.observed, j.health); // #30 observed state + #26 health
        renderDiff(panel, j.diff); // #27 — drift since snapshot
      } catch (e) {
        b.disabled = false;
        b.textContent = "Load live state";
        nowline("✗ live: " + e.message);
      }
    });
    b.title = `Query ${node.id} live (chant lifecycle diff --live): observed state + drift`;
    wrap.appendChild(b);
    panel.appendChild(wrap);
  }
}

const HEALTH_COLOR = {
  healthy: "var(--managed)",
  progressing: "var(--pending)",
  degraded: "var(--degraded)",
  unknown: "var(--muted)",
};

// Render a node's observed live state (#30) + health verdict (#26).
function renderObserved(panel, o, health) {
  if (!o) return; // pending/foreign nodes have no observed record in the diff
  const h = document.createElement("h3");
  h.textContent = "observed";
  h.style.cssText = "font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin:14px 0 6px";
  panel.appendChild(h);
  const dl = document.createElement("dl");
  const add = (k, v, color) => {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    if (color) dd.style.color = color;
    dl.append(dt, dd);
  };
  // Health first — the "is it well?" verdict, distinct from drift. Absent when
  // the substrate reports no status (not fabricated).
  if (health && health !== "unknown") add("health", health, HEALTH_COLOR[health]);
  if (o.type) add("type", o.type);
  if (o.status) add("status", o.status, HEALTH_COLOR[health] || undefined);
  if (o.physicalId) add("physical id", o.physicalId);
  if (o.ownership) add("ownership", o.ownership);
  if (o.lastUpdated) add("last updated", o.lastUpdated);
  for (const [k, v] of Object.entries(o.attributes || {})) {
    add(k, typeof v === "object" ? JSON.stringify(v) : String(v));
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
};

// Render a node's live-diff into the inspect panel (#27).
function renderDiff(panel, diff) {
  const h = document.createElement("h3");
  h.textContent = "drift";
  h.style.cssText = "font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin:14px 0 6px";
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
    dd.textContent = `${JSON.stringify(ch.oldValue)} → ${JSON.stringify(ch.newValue)}`;
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
    });
  }
}

// View state driven by the header pickers (#17). env=null → the declared source
// graph; env set → the live overlay for that env (needs cloud creds). detail is
// chant's --detail tier. components (#56) toggles the component-DAG projection
// (nodes=components, wave-laned, dependsOn edges) in place of the AWS entity
// graph. With an env picked too, components mode gets its own live status join
// (#57, per-component AWS reconciliation) instead of the entity overlay — see
// load()'s endpoint choice. tier/target (M2, #54) are the two new lenses: a
// picked tier overrides LOOM_TIER, a picked target overrides AWS_ENDPOINT_URL,
// for every chant shell-out this page's fetches trigger (see lensParams()).
// Every fetch reads this, so the `changed` SSE re-pull and a picker change go
// through the same path.
const view = { env: null, detail: 2, components: false, tier: null, target: null };

// The deploy axes as currently displayed in the header (#59 unify, M2 #54
// lenses) — seeded once from /api/project (server-derived from the process
// env at launch; see deployAxes() in src/server.ts), then kept in sync with
// whatever the last /api/graph response actually observed (its `meta.tier`/
// `meta.target`, since a picked lens can differ from the launch-time default).
let axes = { tier: null, target: null };

// Query params for the tier/target lenses (M2, #54) — shared by every fetch
// this page makes, so picking a lens re-parameterizes the component graph,
// its CI/resources facets, and the reconcile summary all the same way.
function lensParams(params) {
  if (view.tier) params.set("tier", view.tier);
  if (view.target) params.set("target", view.target);
  return params;
}

// CI projection facet (M1.2, #58): the component DAG's GitLab CI reading —
// component name → {jobName, stage, needs, script}, from `/api/ci` (`chant
// build --components --generate gitlab`). Loaded once per components-mode
// load() and cached here so inspect() (fired per click, not per fetch) reads
// it synchronously. Component-DAG mode only — cleared otherwise.
let ciByComponent = new Map();

async function loadCi() {
  try {
    const q = lensParams(new URLSearchParams(view.env ? { env: view.env } : {}));
    const res = await fetch(`/api/ci?${q}`);
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || res.statusText);
    ciByComponent = new Map((j.jobs || []).map((job) => [job.component, job]));
  } catch {
    // Non-fatal: the component DAG still renders without the CI facet (e.g. a
    // served chant predating generate mode) — inspect() just omits the section.
    ciByComponent = new Map();
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
    const res = await fetch(`/api/resources?${q}`);
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
let componentChoices = []; // component names for the apply picker — loaded lazily (independent of whether the graph pane is currently in components mode)

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
    host.style.display = "none";
    host.innerHTML = "";
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

  const reconcileBtn = button(
    reconcileCache ? `reconcile · ${reconcileCache.total} pending` : "reconcile",
    "dial-step",
    loadReconcile,
  );
  reconcileBtn.title = `Pending change set for ${view.env} (chant lifecycle plan --live, read-only) — click to load.`;
  track.appendChild(reconcileBtn);
  track.appendChild(dialArrow());

  const applying = applyProgress && applyProgress.status === "running";
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

  host.appendChild(track);
  if (reconcileCache) host.appendChild(renderReconcileDetail(reconcileCache));
  if (applyPicker && !applying) host.appendChild(renderApplyPicker());
  if (applyProgress && applyProgress.waves.length) host.appendChild(renderApplyProgress(applyProgress));
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
    "background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 8px;font-size:12px";
  sel.add(new Option("all components", "all"));
  for (const name of componentChoices) sel.add(new Option(name, name));
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
    const res = await fetch(`/api/graph?${q}`);
    const j = await res.json();
    componentChoices = (j.ir && j.ir.nodes ? j.ir.nodes : [])
      .filter((n) => n.kind === "Component")
      .map((n) => n.id);
  } catch {
    componentChoices = []; // the picker still offers "all components" — just no per-name list
  }
  return componentChoices;
}

// "Apply all" from the header (M3): the discoverable equivalent of Sync when a
// project has no committed ApplyOp — deploy every component. Uses the current
// env (kept live by the picker); confirms since it's a real write. The dial's
// structured progress then renders the run.
function confirmApplyAll() {
  const env = view.env;
  if (!env) {
    nowline("✗ apply all: pick an env first (env drives the target)");
    return;
  }
  if (!window.confirm(`Apply ALL components to ${env}?\nThis is a real write — chant run --components all --env ${env} --progress-json.\nLive progress appears in the dial.`)) return;
  runApply("all");
}

function runApply(component) {
  const q = new URLSearchParams({ env: view.env, component });
  fetch(`/api/apply?${q}`, { method: "POST" })
    .then((r) => r.json())
    .then((j) => {
      if (j.error) {
        nowline("✗ apply: " + j.error);
      } else {
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
  summary.style.cssText = `font-size:11px;color:${APPLY_STATUS_COLOR[state.status] || "var(--muted)"}`;
  summary.textContent = `apply: ${state.status}`;
  wrap.appendChild(summary);
  for (const w of state.waves) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap";
    const label = document.createElement("span");
    label.style.cssText = `font-size:11px;color:${APPLY_STATUS_COLOR[w.status] || "var(--muted)"};min-width:52px`;
    label.textContent = `wave ${w.wave}`;
    row.appendChild(label);
    for (const cname of w.components) {
      const c = (state.components || []).find((x) => x.component === cname) || { status: "pending" };
      const color = APPLY_STATUS_COLOR[c.status] || "var(--muted)";
      const chip = document.createElement("span");
      chip.style.cssText = `border:1px solid ${color};color:${color};border-radius:6px;padding:2px 8px;font-size:11px`;
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
  if (!rows.length && !r.uncorrelated) {
    wrap.textContent = "no pending changes";
    return wrap;
  }
  for (const [component, count] of rows) {
    const span = document.createElement("span");
    span.textContent = `${component}: ${count}`;
    wrap.appendChild(span);
  }
  if (r.uncorrelated) {
    const span = document.createElement("span");
    span.textContent = `${r.uncorrelated} uncorrelated`;
    span.title = "Pending changes that couldn't be mapped to a component by source location.";
    wrap.appendChild(span);
  }
  return wrap;
}

async function loadReconcile() {
  try {
    const q = lensParams(new URLSearchParams({ env: view.env }));
    const res = await fetch(`/api/reconcile?${q}`);
    const j = await res.json();
    if (!res.ok) throw new Error(j.tierNote || j.error || res.statusText);
    reconcileCache = j;
    renderDial();
  } catch (e) {
    nowline("✗ reconcile: " + e.message);
  }
}

// Paint a fetched graph: the SVG, the meta line (with a drift summary in overlay
// mode), the legend, and click-inspect wiring. Shared by load() and refresh().
function render(ir, svg, m) {
  const overlay = m.mode === "overlay";
  // M1.1 (#57): the component DAG's live per-component AWS status — a
  // different join than the entity overlay (see server's /api/graph), so it
  // gets its own summary + legend rather than reusing `overlay`'s.
  const componentStatus = m.mode === "component-status";
  let tail = ` · ${ir.edges.length} edges`;
  if (overlay) {
    // Summarise drift so "everything's blue" reads as "N pending".
    const c = { good: 0, warn: 0, accent: 0 };
    for (const n of ir.nodes) {
      const s = n.attrs && n.attrs._status;
      if (s in c) c[s]++;
    }
    tail = ` · ${c.good} managed · ${c.warn} foreign · ${c.accent} pending`;
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
  const scope = m.estate ? `estate of ${m.estate} projects` : m.projectDir;
  // The deploy axes (#59 unify, M2 #54 lenses) — tier/target, kept in sync with
  // what this response actually observed (falls back to the launch-time value
  // from /api/project when a route doesn't echo them, e.g. /api/overlay).
  if (m.tier !== undefined) axes.tier = m.tier;
  if (m.target !== undefined) axes.target = m.target;
  const axesTail = `${axes.tier ? " · tier " + axes.tier : ""}${axes.target ? " · target " + axes.target : ""}`;
  document.getElementById("meta").textContent =
    `${scope}${m.env ? " · env " + m.env : ""}${axesTail}${overlay ? " · overlay" : ""}${m.components ? " · components" : ""}${componentStatus ? " · live status" : ""} · ${ir.nodes.length} nodes${tail}`;
  document.getElementById("legend").style.display = overlay ? "flex" : "none";
  document.getElementById("component-legend").style.display = componentStatus ? "flex" : "none";
  const g = document.getElementById("graph");
  g.innerHTML = svg;
  const svgEl = g.querySelector("svg");
  if (svgEl) {
    // Drop pinhole's fixed pixel size so the viewBox drives sizing; behold then
    // pans/zooms by mutating the viewBox (setupGraphViewBox + the wheel/drag
    // handlers). Starts fit-to-pane, then pinch / ⌘+scroll zooms, drag pans.
    svgEl.removeAttribute("width");
    svgEl.removeAttribute("height");
    svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
    setupGraphViewBox(svgEl);
  }
  ensureZoomControls(g);
  wire(ir);
  renderDial();
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

// A graph/facet failure under a picked tier (M2, #54): the server explains it
// via `tierNote` (src/server.ts `tierErrorNote`) instead of a bare error — a
// calmer inline note in the graph pane, not the alarming red error box. Built
// via textContent, not innerHTML — the note embeds chant's own stderr text.
function renderTierNote(note) {
  const host = document.getElementById("graph");
  host.innerHTML = "";
  const div = document.createElement("div");
  div.className = "tier-note";
  div.textContent = note;
  host.appendChild(div);
  document.getElementById("legend").style.display = "none";
  document.getElementById("component-legend").style.display = "none";
}

// Fetch the current view (source graph, or the picked env's live overlay).
async function load() {
  const meta = document.getElementById("meta");
  meta.textContent = view.env ? `loading overlay for ${view.env}…` : "loading…";
  try {
    const q = lensParams(new URLSearchParams({ detail: String(view.detail) }));
    let endpoint = "/api/graph";
    if (view.components) {
      // M1.1 (#57): the component DAG stays on /api/graph even with an env
      // picked — the server joins live per-component status onto it there
      // (component name -> CFN stack), instead of routing to /api/overlay's
      // cross-substrate entity overlay, which components never use.
      q.set("components", "1");
      if (view.env) q.set("env", view.env);
    } else if (view.env) {
      endpoint = "/api/overlay";
      q.set("env", view.env);
    }
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
    const res = await fetch(`${endpoint}?${q}`);
    const body = await res.json();
    if (!res.ok) {
      // M2 (#54): a tier-scoped failure gets the calmer inline note instead of
      // the generic red error box — see renderTierNote().
      if (body.tierNote) {
        renderTierNote(body.tierNote);
        meta.textContent = `tier ${view.tier} unavailable here`;
        renderDial();
        return;
      }
      throw new Error(body.error || res.statusText);
    }
    render(body.ir, body.svg, body.meta);
  } catch (err) {
    document.getElementById("graph").innerHTML = `<div class="err">graph failed: ${err.message}</div>`;
    meta.textContent = "error";
  }
}

// Refresh (#24): re-check live drift now and capture a lanes frame, in one
// round-trip. Renders the returned graph directly (no second pull); the server's
// `frames` event updates the lanes view.
async function refresh() {
  const meta = document.getElementById("meta");
  const prev = meta.textContent;
  meta.textContent = "refreshing…";
  try {
    const q = view.env ? `?env=${encodeURIComponent(view.env)}` : "";
    const res = await fetch(`/api/refresh${q}`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const { ir, svg, meta: m, captured } = await res.json();
    render(ir, svg, m);
    nowline(captured ? "↻ refreshed — new lanes frame" : "↻ refreshed — no change");
  } catch (err) {
    meta.textContent = prev;
    nowline("✗ refresh: " + err.message);
  }
}

// Populate the header pickers from the project, then do the first load. The env
// picker is the headline: (source) + each declared environment. Selecting one
// switches to that env's live overlay with no restart.
function picker(label, opts, value, onChange) {
  const sel = document.createElement("select");
  sel.title = label;
  for (const [text, val] of opts) sel.add(new Option(text, val));
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

// Component DAG ↔ resource graph toggle (#56). A plain checkbox, not a select —
// it's a binary view switch, not a pick-one-of-many like env/detail.
function toggle(label, title, checked, onChange) {
  const wrap = document.createElement("label");
  wrap.title = title;
  wrap.style.cssText = "display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);cursor:pointer";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = checked;
  cb.addEventListener("change", () => onChange(cb.checked));
  wrap.append(cb, label);
  return wrap;
}

async function initPickers() {
  const info = await fetch("/api/project")
    .then((r) => r.json())
    .catch(() => ({ environments: [], currentEnv: null }));
  view.env = info.currentEnv || null;
  view.tier = info.tier || null;
  view.target = (info.targets && info.targets[0] && info.targets[0].endpoint) || null;
  axes = { tier: info.tier || null, target: info.target || null };
  const host = document.getElementById("pickers");
  const envOpts = [["(source)", ""], ...info.environments.map((e) => [`env: ${e}`, e])];
  host.appendChild(
    picker("environment", envOpts, view.env || "", (v) => {
      view.env = v || null;
      resetDialCaches();
      load();
    }),
  );
  host.appendChild(
    picker("detail tier", [0, 1, 2, 3].map((d) => [`detail ${d}`, String(d)]), String(view.detail), (v) => {
      view.detail = Number(v);
      load();
    }),
  );
  host.appendChild(
    toggle(
      "components",
      "Switch to the component DAG (chant graph --components): one node per component, wave-laned, dependsOn edges. With an env picked, nodes are coloured by live per-component AWS status (chant components status --live). Click a node for its CI job (stage/needs/script) alongside its live status.",
      view.components,
      (v) => {
        view.components = v;
        load();
      },
    ),
  );
  // The tier lens (M2, #54): only offered when the served project already
  // showed LOOM_TIER is in play (info.tier set at launch — same gate
  // deployAxes() uses server-side). Picking a tier re-evaluates the
  // tier-conditioned source for every subsequent fetch (lensParams()).
  if (info.tiers && info.tiers.length) {
    host.appendChild(
      picker(
        "tier",
        info.tiers.map((t) => [`tier: ${t}`, t]),
        view.tier || info.tiers[0],
        (v) => {
          view.tier = v;
          resetDialCaches();
          load();
        },
      ),
    );
  }
  // The target lens (M2, #54): the deploy target/endpoint (Floci locally).
  // Modelled as a picker even with one option today, so M4's estate (several
  // live targets) is a straight extension — see deployTargets() server-side.
  if (info.targets && info.targets.length) {
    host.appendChild(
      picker(
        "target",
        info.targets.map((t) => [`target: ${t.endpoint}`, t.endpoint]),
        view.target || info.targets[0].endpoint,
        (v) => {
          view.target = v;
          resetDialCaches();
          load();
        },
      ),
    );
  }
  load();
}
initPickers();

// Live updates (#3): re-pull when the server signals the served source changed.
// EventSource reconnects on its own if the server restarts.
const events = new EventSource("/api/events");
events.addEventListener("changed", () => load());

// Delegated writes (#7 Sync / #8 Adopt). behold never mutates — these buttons
// trigger the project's committed Ops on the executor; the now-line streams phases.
function nowline(line) {
  const p = document.getElementById("nowline");
  p.style.display = "block";
  const d = document.createElement("div");
  d.textContent = line;
  p.appendChild(d);
  p.scrollTop = p.scrollHeight;
}
events.addEventListener("op", (e) => nowline(e.data));

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
    .then((j) => j.error && nowline("✗ " + j.error));
}
function signal(name, gate) {
  fetch(`/api/ops/${encodeURIComponent(name)}/signal/${encodeURIComponent(gate)}`, { method: "POST" })
    .then((r) => r.json())
    .then((j) => j.error && nowline("✗ " + j.error));
}
// Adopt is a per-node gesture (a *foreign* node → ReconcileOp → PR), so it lives
// in the inspect panel, not the global bar. Stash the reconcile op + the
// live-import lexicons the server allows so inspect() can gate the button.
let adopt = { reconcile: null, lexicons: [] };
function adoptable(node) {
  return (
    adopt.reconcile &&
    node.attrs &&
    node.attrs._status === "foreign" &&
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
    "background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font-size:12px;max-width:340px";
  for (const c of commits) sel.add(new Option(`${c.sha} · ${c.subject} (${c.date})`, c.sha));
  const go = button("Roll back →", "", () => {
    const to = sel.value;
    if (!window.confirm(`Open a rollback PR restoring source to ${to}?\nA human reviews + merges, then Sync applies it.`)) return;
    fetch(`/api/rollback?to=${encodeURIComponent(to)}`, { method: "POST" })
      .then((r) => r.json())
      .then((j) => nowline(j.error ? "✗ " + j.error : `▶ rollback → ${to} (opening PR…)`));
    wrap.replaceWith(btn);
  });
  const cancel = button("✕", "", () => wrap.replaceWith(btn));
  wrap.append(sel, go, cancel);
  btn.replaceWith(wrap);
}

async function initActions() {
  const bar = document.getElementById("actions");
  // Refresh is always available (even for a project with no Ops) — re-check live
  // drift now and drop a lanes frame.
  const r = button("↻ Refresh", "", refresh);
  r.title = "Re-check live drift now and capture a lanes frame";
  bar.appendChild(r);
  // Rollback (#28): pick a prior source revision → open a reviewable PR restoring
  // it. Never a direct write; a human merges and Syncs to apply.
  const rb = button("Rollback", "", () => openRollback(rb));
  rb.title = "Restore source to a prior revision via a reviewable PR";
  bar.appendChild(rb);
  const { ops, adoptLexicons, autoSync, local, applyProgress: apInit } = await fetch("/api/ops")
    .then((r) => r.json())
    .catch(() => ({ ops: [], adoptLexicons: [] }));
  // The env behold launched with (reliable regardless of picker-init ordering) —
  // gates the first-class "Apply all" affordance below.
  const initialEnv = await fetch("/api/project")
    .then((r) => r.json())
    .then((p) => p.currentEnv || null)
    .catch(() => null);
  // M3 (#54): hydrate the dial's apply progress from the server's last known
  // state — a page load (or reload) mid-apply picks up the structured view
  // instead of starting blank; the `apply` SSE listener keeps it live from here.
  if (apInit && apInit.waves && apInit.waves.length) {
    applyProgress = apInit;
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
      "align-self:center;font-size:11px;color:var(--managed);border:1px solid var(--managed);border-radius:6px;padding:2px 8px";
    bar.appendChild(pill);
  }
  // Auto-sync banner (#29) — make an active self-heal loop visible, not silent.
  if (autoSync && autoSync !== "off") {
    const pill = document.createElement("span");
    pill.textContent = `⟳ auto-sync: ${autoSync}`;
    pill.title = `On polled drift, behold triggers the ${autoSync === "apply" ? "ApplyOp (heal)" : "ReconcileOp (adopt)"}. Gated applies still wait for Approve.`;
    pill.style.cssText =
      "align-self:center;font-size:11px;color:var(--pending);border:1px solid var(--pending);border-radius:6px;padding:2px 8px";
    bar.appendChild(pill);
  }
  const apply = ops.find((o) => o.kind === "apply");
  adopt = { reconcile: ops.find((o) => o.kind === "reconcile") ?? null, lexicons: adoptLexicons ?? [] };
  if (apply) {
    // A committed ApplyOp exists → the classic "Sync" (trigger the heal Op).
    const s = button("Sync", "approve", () => runOp(apply.name));
    s.title = `Apply the committed state via ${apply.name} (chant run ${apply.name}) — behold triggers, the executor applies.`;
    bar.appendChild(s);
    if (apply.gate) bar.appendChild(button("Approve", "approve", () => signal(apply.name, apply.gate)));
  } else if (initialEnv) {
    // No ApplyOp, but there's an env → the equivalent "apply everything" IS the
    // component driver's `run --components all` (M3), which otherwise lives only
    // in the dial. Surface it as a first-class "Apply all" so it's the obvious
    // deploy action, not something you have to discover in the dial.
    const a = button("Apply all", "approve", () => confirmApplyAll());
    a.title = `Deploy every component to ${initialEnv} (chant run --components all --env ${initialEnv} --progress-json). Live progress shows in the dial.`;
    bar.appendChild(a);
  }
  // Generic Ops (backup, restore, seed, watch, teardown, …) collapse into ONE
  // "Run ▾" menu instead of a button each — loomster alone has ~9, which flooded
  // the bar. Sync / Apply all / Rollback stay first-class; everything else is a
  // pick-and-run dropdown. behold still only *triggers* the Op on the executor.
  const runnable = ops.filter((o) => o.kind === "op" || o.kind === "audit");
  if (runnable.length) {
    const sel = document.createElement("select");
    sel.title = "Run a committed Op (backup, restore, audit, …) on the executor";
    sel.style.cssText =
      "background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer";
    sel.add(new Option(`Run ▾ (${runnable.length})`, ""));
    for (const op of runnable) sel.add(new Option(op.name + (op.dir ? " · " + op.dir.split("/").pop() : ""), op.name));
    sel.addEventListener("change", () => {
      const name = sel.value;
      sel.selectedIndex = 0;
      if (name && window.confirm(`Run Op "${name}"?`)) runOp(name);
    });
    bar.appendChild(sel);
  }
  // Only complain when there's genuinely nothing to do.
  if (ops.length === 0) {
    const hint = document.createElement("span");
    hint.style.cssText = "color:var(--muted);font-size:11px;align-self:center";
    hint.textContent = "no Ops — commit an *.op.ts (ApplyOp / ReconcileOp / any deploy Op) to act";
    hint.title = "behold triggers committed Ops on your executor. Add one to enable Sync / Adopt / Run.";
    bar.appendChild(hint);
  }
}
initActions();

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
    slot.style.cssText = "color:var(--managed);text-decoration:none;font-size:12px;align-self:center";
    document.getElementById("actions").after(slot);
  }
  slot.href = url;
  slot.textContent = "PR opened →";
});
