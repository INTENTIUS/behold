// behold SPA. Fetches the read-only graph from the server — chant's IR + pinhole's
// rendered SVG — inlines the SVG and wires click-inspect. The visual is pinhole's
// mature painter (themes, icons, `_status` drift colouring); behold owns the data,
// the inspect panel, and (later) the lanes + delegated actions.

function inspect(node) {
  const panel = document.getElementById("inspect");
  panel.innerHTML = "<h2>inspect</h2>";
  const dl = document.createElement("dl");
  const add = (k, v) => {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  };
  add("id", node.id);
  add("kind", node.kind);
  add("lexicon", node.lexicon);
  const st = node.attrs && node.attrs._status;
  if (st) add("status", { good: "managed", warn: "foreign", accent: "pending" }[st] || st);
  if (node.sourceLoc && node.sourceLoc.file) add("source", node.sourceLoc.file);
  for (const [k, v] of Object.entries(node.attrs || {})) {
    if (k.startsWith("_")) continue;
    add(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  panel.appendChild(dl);

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

async function load() {
  try {
    // With an environment configured, show the live drift overlay (source-anchored:
    // declared topology + managed/foreign/pending). Otherwise, the source graph.
    const health = await fetch("/healthz").then((r) => r.json()).catch(() => ({}));
    const endpoint = health.env ? "/api/overlay" : "/api/graph";
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const { ir, svg, meta } = await res.json();
    const drift = meta.mode === "overlay" ? " · overlay" : "";
    document.getElementById("meta").textContent =
      `${meta.projectDir}${meta.env ? " · env " + meta.env : ""}${drift} · ${ir.nodes.length} nodes · ${ir.edges.length} edges`;
    document.getElementById("graph").innerHTML = svg;
    wire(ir);
  } catch (err) {
    document.getElementById("graph").innerHTML = `<div class="err">graph failed: ${err.message}</div>`;
    document.getElementById("meta").textContent = "error";
  }
}

load();

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
  const { ops, adoptLexicons } = await fetch("/api/ops")
    .then((r) => r.json())
    .catch(() => ({ ops: [], adoptLexicons: [] }));
  const apply = ops.find((o) => o.kind === "apply");
  adopt = { reconcile: ops.find((o) => o.kind === "reconcile") ?? null, lexicons: adoptLexicons ?? [] };
  if (apply) {
    bar.appendChild(button("Sync", "", () => runOp(apply.name)));
    if (apply.gate) bar.appendChild(button("Approve", "approve", () => signal(apply.name, apply.gate)));
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
