// behold SPA. Fetches the read-only graph from the server — chant's IR + pinhole's
// rendered SVG — inlines the SVG and wires click-inspect. The visual is pinhole's
// mature painter (themes, icons, `_status` drift colouring); behold owns the data,
// the inspect panel, and (later) the lanes + delegated actions.

const STATUS_LABEL = { good: "managed", warn: "foreign", accent: "pending" };

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
  if (st) id("status", STATUS_LABEL[st] || st);
  if (node.sourceLoc && node.sourceLoc.file) id("source", node.sourceLoc.file);

  // Live state: what chant observed in the cloud. Only managed (provisioned)
  // nodes carry it — pending nodes have none because they aren't deployed yet.
  if (node.physicalId || node.ownership) {
    const live = section("live");
    if (node.physicalId) live("physical id", node.physicalId);
    if (node.ownership) live("ownership", node.ownership);
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
      host.querySelectorAll(".sel").forEach((n) => n.classList.remove("sel"));
      g.classList.add("sel");
      inspect(node);
    });
  }
}

// View state driven by the header pickers (#17). env=null → the declared source
// graph; env set → the live overlay for that env (needs cloud creds). detail is
// chant's --detail tier. Every fetch reads this, so the `changed` SSE re-pull and
// a picker change go through the same path.
const view = { env: null, detail: 2 };

// Paint a fetched graph: the SVG, the meta line (with a drift summary in overlay
// mode), the legend, and click-inspect wiring. Shared by load() and refresh().
function render(ir, svg, m) {
  const overlay = m.mode === "overlay";
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
  }
  document.getElementById("meta").textContent =
    `${m.projectDir}${m.env ? " · env " + m.env : ""}${overlay ? " · overlay" : ""} · ${ir.nodes.length} nodes${tail}`;
  document.getElementById("legend").style.display = overlay ? "flex" : "none";
  document.getElementById("graph").innerHTML = svg;
  wire(ir);
}

// Fetch the current view (source graph, or the picked env's live overlay).
async function load() {
  const meta = document.getElementById("meta");
  meta.textContent = view.env ? `loading overlay for ${view.env}…` : "loading…";
  try {
    const q = new URLSearchParams({ detail: String(view.detail) });
    let endpoint = "/api/graph";
    if (view.env) {
      endpoint = "/api/overlay";
      q.set("env", view.env);
    }
    const res = await fetch(`${endpoint}?${q}`);
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const { ir, svg, meta: m } = await res.json();
    render(ir, svg, m);
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
async function initPickers() {
  const info = await fetch("/api/project")
    .then((r) => r.json())
    .catch(() => ({ environments: [], currentEnv: null }));
  view.env = info.currentEnv || null;
  const host = document.getElementById("pickers");
  const envOpts = [["(source)", ""], ...info.environments.map((e) => [`env: ${e}`, e])];
  host.appendChild(
    picker("environment", envOpts, view.env || "", (v) => {
      view.env = v || null;
      load();
    }),
  );
  host.appendChild(
    picker("detail tier", [0, 1, 2, 3].map((d) => [`detail ${d}`, String(d)]), String(view.detail), (v) => {
      view.detail = Number(v);
      load();
    }),
  );
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

async function initActions() {
  const bar = document.getElementById("actions");
  // Refresh is always available (even for a project with no Ops) — re-check live
  // drift now and drop a lanes frame.
  const r = button("↻ Refresh", "", refresh);
  r.title = "Re-check live drift now and capture a lanes frame";
  bar.appendChild(r);
  const { ops, adoptLexicons, autoSync } = await fetch("/api/ops")
    .then((r) => r.json())
    .catch(() => ({ ops: [], adoptLexicons: [] }));
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
    bar.appendChild(button("Sync", "", () => runOp(apply.name)));
    if (apply.gate) bar.appendChild(button("Approve", "approve", () => signal(apply.name, apply.gate)));
  } else {
    // No ApplyOp → no Sync. Say so, rather than an unexplained missing button (#32).
    const hint = document.createElement("span");
    hint.style.cssText = "color:var(--muted);font-size:11px;align-self:center";
    hint.textContent = ops.length ? "no ApplyOp — Sync unavailable" : "no Ops — add an ApplyOp to enable Sync";
    hint.title = "Delegated writes trigger a committed *.op.ts (ApplyOp / ReconcileOp) on your executor. Commit one to enable Sync/Adopt.";
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
