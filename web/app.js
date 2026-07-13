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

// View state driven by the header pickers (#17). env=null → the declared source
// graph; env set → the live overlay for that env (needs cloud creds). detail is
// chant's --detail tier. Every fetch reads this, so the `changed` SSE re-pull and
// a picker change go through the same path.
const view = { env: null, detail: 2 };

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
    const drift = m.mode === "overlay" ? " · overlay" : "";
    meta.textContent =
      `${m.projectDir}${m.env ? " · env " + m.env : ""}${drift} · ${ir.nodes.length} nodes · ${ir.edges.length} edges`;
    document.getElementById("graph").innerHTML = svg;
    wire(ir);
  } catch (err) {
    document.getElementById("graph").innerHTML = `<div class="err">graph failed: ${err.message}</div>`;
    meta.textContent = "error";
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
