// behold SPA (bootstrap painter). Fetches the read-only graph + layout from the
// server and draws it as SVG. Deliberately minimal: this is the seam where
// pinhole's painter drops in once it exposes a library (pinhole is a mature
// painter; see behold README). Colours honour chant's overlay `_status` tag
// (managed/foreign/pending) so drift renders the moment chant #821 feeds it.
const SVGNS = "http://www.w3.org/2000/svg";

function statusOf(node) {
  const s = node.attrs && node.attrs._status;
  return s === "good" ? "managed" : s === "warn" ? "foreign" : s === "accent" ? "pending" : "";
}

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (parent) parent.appendChild(n);
  return n;
}

function inspect(node) {
  const panel = document.getElementById("inspect");
  const fields = Object.entries(node.attrs || {}).filter(([k]) => !k.startsWith("_"));
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
  const st = statusOf(node);
  if (st) add("status", st);
  if (node.sourceLoc && node.sourceLoc.file) add("source", node.sourceLoc.file);
  for (const [k, v] of fields) add(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  panel.appendChild(dl);
}

function draw({ ir, layout, meta }) {
  document.getElementById("meta").textContent =
    `${meta.projectDir}${meta.env ? " · env " + meta.env : ""} · ${ir.nodes.length} nodes · ${ir.edges.length} edges`;

  const pos = new Map(layout.nodes.map((n) => [n.id, n]));
  const H = layout.height;
  const flip = (n) => ({ x: n.x, y: H - n.y - n.h, w: n.w, h: n.h, cx: n.x + n.w / 2, cy: H - n.y - n.h / 2 });

  const host = document.getElementById("graph");
  host.innerHTML = "";
  const svg = el("svg", { width: layout.width + 40, height: layout.height + 40, viewBox: `-20 -20 ${layout.width + 40} ${layout.height + 40}` }, host);

  // edges first (under nodes)
  for (const e of ir.edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const fa = flip(a), fb = flip(b);
    el("line", { class: "edge", x1: fa.cx, y1: fa.cy, x2: fb.cx, y2: fb.cy }, svg);
  }

  for (const node of ir.nodes) {
    const p = pos.get(node.id);
    if (!p) continue;
    const f = flip(p);
    const g = el("g", { class: "node", "data-status": statusOf(node) }, svg);
    el("rect", { x: f.x, y: f.y, width: f.w, height: f.h, rx: 6 }, g);
    const label = el("text", { x: f.x + 8, y: f.y + 18 }, g);
    label.textContent = node.id.length > 22 ? node.id.slice(0, 21) + "…" : node.id;
    const lex = el("text", { class: "lex", x: f.x + 8, y: f.y + f.h - 8 }, g);
    lex.textContent = node.lexicon;
    g.addEventListener("click", () => {
      document.querySelectorAll(".node.sel").forEach((n) => n.classList.remove("sel"));
      g.classList.add("sel");
      inspect(node);
    });
  }
}

async function load() {
  try {
    const res = await fetch("/api/graph");
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    draw(await res.json());
  } catch (err) {
    document.getElementById("graph").innerHTML = `<div class="err">graph failed: ${err.message}</div>`;
    document.getElementById("meta").textContent = "error";
  }
}

load();
