/**
 * behold#1028: the index diff overlay on the graph pane (web/graph.html).
 *
 * Picks a scope and two of its versions from GET /api/graphdb/index-versions,
 * asks GET /api/graphdb/index-diff, and draws the answer's overlay: added
 * nodes and edges green, removed red, changed amber with the changed paths
 * in the tooltip, and not-observed grey and dashed (an unobserved type is
 * never drawn as removed). Both reads' stamps are shown above the drawing.
 * Every request is a GET.
 *
 * The pure helpers are exported for web/index-diff.test.js.
 */
import { circleLayout } from "./graph-query.js";

/** The diff route for a scope and two versions; empty arguments are left to the server's defaults. */
export function diffUrl(scope, from, to) {
  const q = new URLSearchParams();
  if (scope) q.set("scope", scope);
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  const s = q.toString();
  return `/api/graphdb/index-diff${s ? `?${s}` : ""}`;
}

/** The two stamps and the counts, as lines. */
export function diffSummary(diff) {
  if (!diff) return [];
  const stamp = (s) => `${s.version ?? "?"}: observed ${s.observedAt}${s.completedAt ? ` to ${s.completedAt}` : ""}, digest ${String(s.digest).slice(0, 12)}`;
  const c = diff.counts;
  const lines = [`scope ${diff.scopeKey}`, `from ${stamp(diff.from)}`, `to   ${stamp(diff.to)}`];
  if (diff.unchanged) lines.push("unchanged: both reads have the same digest");
  else {
    lines.push(`${c.added} added, ${c.removed} removed, ${c.changed} changed (${c.properties} properties), ${c.notObserved} not observed in one read`);
    lines.push(`edges: ${c.edgesAdded} added, ${c.edgesRemoved} removed, ${c.edgesNotObserved} not observed`);
  }
  for (const n of diff.nodes?.changed ?? []) for (const p of n.properties) lines.push(`  ${n.key} ${p.path}: ${JSON.stringify(p.before)} -> ${JSON.stringify(p.after)}`);
  for (const k of diff.coverage ?? []) lines.push(`  coverage ${k.listedType} in ${k.location}: ${k.before ?? "absent"} -> ${k.after ?? "absent"}`);
  return lines;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

/** The overlay as SVG text. Each node and edge carries its change as a class: d-added, d-removed, d-changed, d-not-observed, d-same. */
export function drawOverlaySvg(draw, size = 520) {
  const nodes = draw?.nodes ?? [];
  if (!nodes.length) return "";
  const at = circleLayout(nodes, size);
  const edges = (draw.edges ?? [])
    .filter((e) => at[e.from] && at[e.to])
    .map((e) => {
      const a = at[e.from];
      const b = at[e.to];
      return `<line class="g-edge d-${esc(e.change)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" marker-end="url(#g-arrow)"><title>${esc(`${e.from} -> ${e.to}${e.viaAttr ? ` via ${e.viaAttr}` : ""}: ${e.change}`)}</title></line>`;
    })
    .join("");
  const dots = nodes
    .map((n) => {
      const p = at[n.key];
      const label = n.name || n.key;
      const title = `${n.key} (${n.kind}): ${n.change}${n.detail ? `, ${n.detail}` : ""}`;
      return `<g class="g-node d-${esc(n.change)}"><circle cx="${p.x}" cy="${p.y}" r="7"><title>${esc(title)}</title></circle><text x="${p.x + 10}" y="${p.y + 4}">${esc(label.length > 32 ? `${label.slice(0, 29)}...` : label)}</text></g>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="index diff overlay"><defs><marker id="g-arrow" viewBox="0 0 10 10" refX="16" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="g-arrowhead"/></marker></defs>${edges}${dots}</svg>`;
}

/* c8 ignore start: the DOM half, driven by the page */
export function initIndexDiff(doc = document, fetchJson = (u) => fetch(u, { headers: { accept: "application/json" } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))) {
  const $ = (id) => doc.getElementById(id);
  if (!$("d-form")) return;
  let scopes = [];
  const fill = (sel, items, pick) => {
    sel.innerHTML = "";
    for (const v of items) {
      const o = doc.createElement("option");
      o.value = v;
      o.textContent = v;
      sel.append(o);
    }
    if (pick !== undefined) sel.value = pick;
  };
  const versionsFor = () => {
    const s = scopes.find((x) => x.scopeKey === $("d-scope").value);
    const vs = (s?.versions ?? []).map((v) => v.version);
    fill($("d-from"), vs, vs[vs.length - 2]);
    fill($("d-to"), vs, vs[vs.length - 1]);
  };
  fetchJson("/api/graphdb/index-versions").then((r) => {
    if (r.status !== 200) return;
    scopes = r.body.scopes ?? [];
    fill($("d-scope"), scopes.map((s) => s.scopeKey));
    versionsFor();
    $("d-hint").textContent = scopes.length ? "" : "No index versions yet: run behold index <substrate> twice on one scope.";
  });
  $("d-scope").addEventListener("change", versionsFor);
  $("d-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const r = await fetchJson(diffUrl($("d-scope").value, $("d-from").value, $("d-to").value));
    if (r.status !== 200) {
      $("g-error").textContent = `${r.body.error ?? "Refused."}${r.body.code ? ` (${r.body.code})` : ""}`;
      return;
    }
    $("g-error").textContent = "";
    $("g-rows").innerHTML = "";
    $("g-draw").innerHTML = drawOverlaySvg(r.body.draw);
    $("d-summary").textContent = [...diffSummary(r.body.diff), `coverage rule: ${r.body.coverageRule}`, r.body.draw.omitted ? `${r.body.draw.omitted} unchanged nodes not drawn` : ""].filter(Boolean).join("\n");
  });
}
/* c8 ignore stop */
