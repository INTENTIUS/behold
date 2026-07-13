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
