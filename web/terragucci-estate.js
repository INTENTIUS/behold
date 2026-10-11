// #509: a terragucci control repo, across its projects. app.js calls
// initTerragucciEstate once; when /api/project names a control repo, this reads
// /api/terragucci/estate and draws it over the (empty) graph area:
//
// - one box per project, its roots grouped by wave inside it, a solid arrow
//   for each read within a project and a dashed one for each read between
//   projects (an arrow points from a root to the root that reads its state,
//   as on terragucci's estate page);
// - on each box, terragucci's counts and the run view it was drawn from,
//   each with its age and source;
// - below, per project, its waiting waves with the approve line to copy (no
//   button approves), its links, and how to serve its own checkout.
//
// A project with no run view is drawn as a box that says so, never dropped.
// Nothing here is live: every figure is dated by estate.json's `generated` or
// a run view's `updated`. The layout functions are pure and tested.

import { ago, clock } from "./terragucci.js";

export const COL_W = 176;
export const ROW_H = 26;
export const PAD = 12;
export const HEAD_H = 64;
export const WAVE_H = 22;
export const GAP = 72;
export const NO_RUN_W = 300;

/** The address a key opens at: this server's file route. */
export function keyHref(answer, key) {
  return `${answer.files || ""}${answer.files && answer.files.includes("?") ? encodeURIComponent(key) : key}`;
}

/**
 * Projects in drawing order: a project whose roots another reads comes before
 * the reader, so a dashed edge runs left to right where it can. Ties keep
 * estate.json's order.
 */
export function projectOrder(answer) {
  const names = answer.projects.map((p) => p.project);
  const before = new Map(names.map((n) => [n, new Set()]));
  for (const e of answer.edges || []) if (e.cross && before.has(e.to.project) && before.has(e.from.project)) before.get(e.to.project).add(e.from.project);
  const out = [];
  const seen = new Set();
  const visit = (n, stack) => {
    if (seen.has(n) || stack.has(n)) return;
    stack.add(n);
    for (const m of names) if (before.get(n).has(m)) visit(m, stack);
    stack.delete(n);
    seen.add(n);
    out.push(n);
  };
  for (const n of names) visit(n, new Set());
  return out.map((n) => answer.projects.find((p) => p.project === n));
}

/** The waves a project's box has columns for: its run view's waves and any wave a root names, ascending. */
export function wavesOf(run) {
  const n = new Set([...(run.waves || []).map((w) => w.number), ...(run.roots || []).map((r) => r.wave)]);
  return [...n].sort((a, b) => a - b);
}

/**
 * Where everything goes: each project's box, each wave column in it, each
 * root's rect, and each edge's path. Coordinates are SVG user units.
 */
export function estateLayout(answer) {
  const boxes = [];
  const at = new Map(); // "project\u0000root" -> rect
  let x = PAD;
  let height = 0;
  for (const p of projectOrder(answer)) {
    const run = p.run;
    const waves = run ? wavesOf(run) : [];
    const rows = run ? Math.max(1, ...waves.map((n) => run.roots.filter((r) => r.wave === n).length)) : 0;
    const w = run && waves.length ? waves.length * COL_W + PAD * 2 : NO_RUN_W;
    const h = run ? HEAD_H + WAVE_H + rows * ROW_H + PAD : HEAD_H + PAD;
    const box = { project: p.project, x, y: PAD, w, h, waves: [] };
    if (run) {
      waves.forEach((n, i) => {
        const wx = x + PAD + i * COL_W;
        const meta = run.waves.find((v) => v.number === n);
        const roots = run.roots
          .filter((r) => r.wave === n)
          .sort((a, b) => (a.root < b.root ? -1 : 1))
          .map((r, j) => {
            const rect = { root: r.root, x: wx, y: PAD + HEAD_H + WAVE_H + j * ROW_H, w: COL_W - 16, h: ROW_H - 6 };
            at.set(`${p.project}\u0000${r.root}`, rect);
            return rect;
          });
        box.waves.push({ number: n, x: wx, y: PAD + HEAD_H, state: meta ? meta.state : "not-started", roots });
      });
    }
    boxes.push(box);
    x += w + GAP;
    height = Math.max(height, box.y + h);
  }
  const edges = [];
  for (const e of answer.edges || []) {
    const a = at.get(`${e.from.project}\u0000${e.from.root}`);
    const b = at.get(`${e.to.project}\u0000${e.to.root}`);
    if (!a || !b) continue;
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const bend = Math.max(36, Math.abs(x2 - x1) / 3);
    edges.push({ from: e.from, to: e.to, cross: !!e.cross, d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}` });
  }
  return { width: Math.max(x - GAP + PAD, NO_RUN_W + PAD * 2), height: height + PAD, boxes, edges };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** terragucci's counts for a project, with their age and source. */
export function countsLine(p, now = new Date()) {
  if (!p.counts) return { text: p.status === "not-in-estate" ? "not in estate.json" : "no counts", title: p.missing || "" };
  const c = p.counts;
  return {
    text: `${plural(c.drifted, "root")} drifted · ${c.failed} failed · ${plural(c.waiting, "wave")} waiting · ${ago(c.dated.at, now)}`,
    title: `from ${c.dated.key}, generated ${clock(c.dated.at, now)} (${ago(c.dated.at, now)}); not live`,
  };
}

/** Which run view the box was drawn from, or why it has none. */
export function runLine(p, now = new Date()) {
  if (p.run) {
    return {
      text: `run view ${p.run.commit.slice(0, 12)} · updated ${ago(p.run.updated, now)}`,
      title: `${p.run.key}, the run view of ${p.run.commit}, named by estate.json's ${p.run.from === "run_view" ? "run_view" : "newest apply"}; a wave last wrote it ${clock(p.run.updated, now)}`,
      tone: "ok",
    };
  }
  if (p.refused) return { text: "run view refused", title: `${p.refused.error}\n${p.refused.remedy}`, tone: "bad" };
  return { text: "no run view", title: p.missing || "no run view", tone: "none" };
}

/** A waiting wave as a line and its approve command. */
export function waitingRows(p, now = new Date()) {
  return (p.waiting || []).map((w) => ({
    text: `wave ${w.wave} waiting since ${clock(w.since, now)}, ${ago(w.since, now)} · commit ${w.commit.slice(0, 12)}${w.digest ? ` · plan ${String(w.digest).replace(/^jcs1-sha256:/, "").slice(0, 12)}` : ""}`,
    title: `from ${w.dated.key}, generated ${clock(w.dated.at, now)}`,
    command: w.command,
    digestKnown: !!w.digest,
    report: w.report,
  }));
}

/** The line over the picture: whose estate, how old, how checked. */
export function estateLegend(answer, now = new Date()) {
  const cross = (answer.edges || []).filter((e) => e.cross).length;
  const drawn = answer.projects.filter((p) => p.run).length;
  const checked = (v) => (v.by === "schema" ? `terragucci ${v.terragucci}'s schema` : "a structural check");
  return {
    text: `terragucci estate of ${plural(answer.projects.length, "project")}, not live · estate.json generated ${ago(answer.estate.generated, now)} · ${drawn} drawn from a run view · ${plural(cross, "read")} between projects`,
    title: [`read from ${answer.source} (${answer.gets} GETs)`, `estate.json checked with ${checked(answer.validation.estate)}`, `run views checked with ${checked(answer.validation.run)}`, `config: ${answer.config}`].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// The DOM. Text only, never innerHTML: every string here came from a bucket.
// ---------------------------------------------------------------------------

const SVG = "http://www.w3.org/2000/svg";

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function svgEl(doc, tag, attrs = {}, text) {
  const e = doc.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}
function link(doc, text, href) {
  const a = el(doc, "a", "", text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}
function titled(doc, node, title) {
  if (title) node.appendChild(svgEl(doc, "title", {}, title));
  return node;
}

/** The picture: boxes, wave columns, roots and edges. */
export function renderEstateSvg(answer, now = new Date(), doc = document) {
  const L = estateLayout(answer);
  const svg = svgEl(doc, "svg", { width: L.width, height: L.height, viewBox: `0 0 ${L.width} ${L.height}`, class: "tg-estate-svg", role: "img", "aria-label": "terragucci estate: projects, their roots by wave, and the reads between them" });
  const defs = svgEl(doc, "defs");
  const marker = svgEl(doc, "marker", { id: "tg-estate-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
  marker.appendChild(svgEl(doc, "path", { d: "M0,0 L10,5 L0,10 z", fill: "var(--edge)" }));
  defs.appendChild(marker);
  svg.appendChild(defs);
  const byName = new Map(answer.projects.map((p) => [p.project, p]));
  for (const b of L.boxes) {
    const p = byName.get(b.project);
    const g = svgEl(doc, "g", { class: "tg-project", "data-project": b.project });
    g.appendChild(svgEl(doc, "rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 6, class: `tg-project-box${p.run ? "" : " tg-no-run"}` }));
    const name = svgEl(doc, "text", { x: b.x + PAD, y: b.y + 20, class: "tg-project-name" }, b.project);
    if (p.index) {
      const a = svgEl(doc, "a", { href: keyHref(answer, p.index), target: "_blank" });
      a.appendChild(name);
      g.appendChild(a);
    } else g.appendChild(name);
    const counts = countsLine(p, now);
    g.appendChild(titled(doc, svgEl(doc, "text", { x: b.x + PAD, y: b.y + 38, class: "tg-project-counts" }, counts.text), counts.title));
    const run = runLine(p, now);
    g.appendChild(titled(doc, svgEl(doc, "text", { x: b.x + PAD, y: b.y + 55, class: `tg-project-run tg-${run.tone}` }, run.text), run.title));
    for (const w of b.waves) {
      g.appendChild(svgEl(doc, "text", { x: w.x, y: w.y + 14, class: `tg-wave-label tg-wave-${w.state}`, "data-wave": w.number }, `wave ${w.number} · ${w.state === "not-started" ? "not started" : w.state}`));
      for (const r of w.roots) {
        const node = svgEl(doc, "g", { class: "tg-root-node", "data-root": r.root });
        node.appendChild(svgEl(doc, "rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 4 }));
        node.appendChild(titled(doc, svgEl(doc, "text", { x: r.x + 6, y: r.y + r.h / 2 + 4 }, r.root.length > 24 ? `…${r.root.slice(-23)}` : r.root), `${b.project}: ${r.root}, wave ${w.number}`));
        g.appendChild(node);
      }
    }
    svg.appendChild(g);
  }
  for (const e of L.edges) {
    const path = svgEl(doc, "path", { d: e.d, class: `tg-edge${e.cross ? " tg-edge-cross" : ""}`, "marker-end": "url(#tg-estate-arrow)", "data-from": `${e.from.project} ${e.from.root}`, "data-to": `${e.to.project} ${e.to.root}` });
    svg.appendChild(titled(doc, path, `${e.to.project}: ${e.to.root} reads ${e.from.project}: ${e.from.root}`));
  }
  return svg;
}

/** Draw the whole view into `host`. `copy(text, buttonEl)` puts a line on the clipboard. */
export function renderEstate(host, answer, { copy = () => {}, refresh, now = new Date(), doc = document } = {}) {
  host.replaceChildren();
  if (!answer || answer.error) {
    host.append(el(doc, "div", "tg-refusal", answer ? answer.error : "the estate was not read"), el(doc, "div", "tg-legend", (answer && answer.remedy) || ""));
    return;
  }
  const lg = estateLegend(answer, now);
  const head = el(doc, "div", "tg-legend", lg.text);
  head.title = lg.title;
  const top = el(doc, "div", "tg-estate-head");
  top.append(head, link(doc, "terragucci's estate page", keyHref(answer, answer.estate.html)));
  if (refresh) {
    const again = el(doc, "button", "", "Read again");
    again.addEventListener("click", refresh);
    top.appendChild(again);
  }
  host.appendChild(top);
  const wrap = el(doc, "div", "tg-estate-graph");
  wrap.appendChild(renderEstateSvg(answer, now, doc));
  host.appendChild(wrap);
  const list = el(doc, "div", "tg-estate-projects");
  const copyRow = (text) => {
    const row = el(doc, "div", "tg-estate-cmd");
    const code = el(doc, "code", "tg-command", text);
    const b = el(doc, "button", "", "Copy");
    b.title = "Copy the line and run it at your shell. behold runs nothing here.";
    b.addEventListener("click", () => copy(text, b));
    row.append(code, b);
    return row;
  };
  for (const p of projectOrder(answer)) {
    const card = el(doc, "section", "tg-estate-project");
    card.dataset.project = p.project;
    const title = el(doc, "div", "tg-estate-title", p.project);
    card.appendChild(title);
    const links = el(doc, "div", "tg-legend");
    const parts = [];
    if (p.index) parts.push(link(doc, "its index", keyHref(answer, p.index)));
    parts.push(link(doc, "estate.html", keyHref(answer, answer.estate.html)));
    if (p.run) parts.push(link(doc, "run view", keyHref(answer, p.run.page)));
    parts.forEach((a, i) => links.append(...(i ? [" · ", a] : [a])));
    card.appendChild(links);
    const counts = countsLine(p, now);
    const c = el(doc, "div", "tg-estate-counts", counts.text);
    c.title = counts.title;
    card.appendChild(c);
    const run = runLine(p, now);
    const r = el(doc, "div", `tg-estate-run tg-${run.tone}`, run.tone === "ok" ? run.text : `${run.text}: ${p.refused ? p.refused.error : p.missing || ""}`);
    r.title = run.title;
    card.appendChild(r);
    for (const w of waitingRows(p, now)) {
      const box = el(doc, "div", "ws-gate tg-wave");
      const t = el(doc, "div", "ws-gate-facts", w.text);
      t.title = w.title;
      box.append(t, copyRow(w.command));
      const note = el(doc, "div", "ws-gate-note", w.digestKnown ? "Run it in the project's own checkout: the approval is a signed git record bound to this plan digest. behold does not approve." : "Run it in the project's own checkout, with the plan digest from the wave's report. behold does not approve.");
      box.appendChild(note);
      if (w.report) {
        const l = el(doc, "div", "ws-gate-note");
        l.appendChild(link(doc, "report", keyHref(answer, w.report)));
        box.appendChild(l);
      }
      card.appendChild(box);
    }
    if (p.checkout) {
      card.appendChild(el(doc, "div", "tg-legend", `checked out at ${p.checkout.path}; serve it to see its roots:`));
      card.appendChild(copyRow(p.checkout.command));
    }
    list.appendChild(card);
  }
  host.appendChild(list);
}

/**
 * Once, at boot: when /api/project names a terragucci control repo, read the
 * estate and draw it in a layer over the graph area. `fetchUrl(url)` is
 * app.js's apiFetch, `copy` its copyToClipboard.
 */
export async function initTerragucciEstate({ fetchUrl, copy, doc = document } = {}) {
  const project = await fetchUrl("/api/project").then((r) => r.json()).catch(() => ({}));
  if (!project.terragucciControl || !project.terragucciReports) return;
  const graph = doc.getElementById("graph");
  if (!graph || !graph.parentElement) return;
  let host = doc.getElementById("tg-estate");
  if (!host) {
    host = el(doc, "div");
    host.id = "tg-estate";
    graph.parentElement.insertBefore(host, graph.nextSibling);
  }
  const load = async (fresh) => {
    const answer = await fetchUrl(`/api/terragucci/estate${fresh ? "?fresh=1" : ""}`)
      .then((r) => r.json())
      .catch((e) => ({ error: String(e), code: "terragucci-report", remedy: "" }));
    renderEstate(host, answer, { copy, refresh: () => load(true), doc });
  };
  await load(false);
}
