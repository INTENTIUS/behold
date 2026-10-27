/**
 * behold#1027: the graph pane's page logic (web/graph.html).
 *
 * A Cypher box over GET /api/graphdb/query, a resolve box over
 * GET /api/graphdb/resolve with the templates that apply to the node it lands
 * on, and a small drawing of each answer: its nodes and the REF edges among
 * them, derived edges dashed and labelled with their rule. Every answer shows
 * when each source was read. The page only reads: every request it makes is a
 * GET.
 *
 * The pure helpers are exported for web/graph-query.test.js; `initGraphPane`
 * wires them to the page.
 */

/** The route URL for a Cypher query and its parameters. */
export function queryUrl(cypher, params) {
  const q = new URLSearchParams({ cypher });
  if (params && Object.keys(params).length) q.set("params", JSON.stringify(params));
  return `/api/graphdb/query?${q}`;
}

/** The route URL for resolving a resource. */
export function resolveUrl(ref) {
  return `/api/graphdb/resolve?${new URLSearchParams({ ref })}`;
}

/** The route URL for one template on one node. */
export function templateUrl(name, node, inputs = {}) {
  const q = new URLSearchParams({ name, node });
  for (const [k, v] of Object.entries(inputs)) q.set(`in.${k}`, v);
  return `/api/graphdb/template?${q}`;
}

/** One line per source: what it is and when it was read ("declared" when nothing was read live). */
export function sourceLines(sources) {
  return (sources ?? []).map((s) => {
    const what = `${s.member ? `${s.member}: ` : ""}${s.name}${s.version ? ` ${s.version}` : ""} (${s.source}, ${s.scopeKey})`;
    const when = s.observedAt ? `observed ${s.observedAt}` : "declared source, not observed";
    return `${what}: ${when}; loaded ${s.readAt}; ${s.nodes} nodes, ${s.edges} edges`;
  });
}

/** Node positions on a circle, in answer order; small answers get a readable radius. */
export function circleLayout(nodes, size = 520) {
  const n = nodes.length;
  const r = n <= 1 ? 0 : Math.min(size / 2 - 60, 40 + n * 14);
  const c = size / 2;
  const at = {};
  nodes.forEach((node, i) => {
    const a = (2 * Math.PI * i) / Math.max(n, 1) - Math.PI / 2;
    at[node.key] = { x: Math.round(c + r * Math.cos(a)), y: Math.round(c + r * Math.sin(a)) };
  });
  return at;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

/** The answer's drawing as SVG text. */
export function drawSvg(draw, size = 520) {
  const nodes = draw?.nodes ?? [];
  if (!nodes.length) return "";
  const at = circleLayout(nodes, size);
  const edges = (draw.edges ?? [])
    .filter((e) => at[e.from] && at[e.to])
    .map((e) => {
      const a = at[e.from];
      const b = at[e.to];
      const derived = e.origin === "derived";
      const title = `${e.from} -> ${e.to}${e.viaAttr ? ` via ${e.viaAttr}` : ""}${derived ? ` (derived: ${e.rule})` : ""}`;
      return `<line class="g-edge${derived ? " derived" : ""}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" marker-end="url(#g-arrow)"><title>${esc(title)}</title></line>`;
    })
    .join("");
  const dots = nodes
    .map((n) => {
      const p = at[n.key];
      const label = n.name || n.key;
      return `<g class="g-node ${esc(n.source)}"><circle cx="${p.x}" cy="${p.y}" r="7"><title>${esc(`${n.key} (${n.kind}, ${n.scopeKey})`)}</title></circle><text x="${p.x + 10}" y="${p.y + 4}">${esc(label.length > 32 ? `${label.slice(0, 29)}...` : label)}</text></g>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="answer graph"><defs><marker id="g-arrow" viewBox="0 0 10 10" refX="16" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="g-arrowhead"/></marker></defs>${edges}${dots}</svg>`;
}

/** A table of the answer's rows as HTML text. */
export function rowsTable(columns, rows) {
  if (!rows?.length) return "<p class=\"g-muted\">No rows.</p>";
  const cell = (v) => esc(typeof v === "string" ? v : JSON.stringify(v));
  const head = columns.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = rows.map((r) => `<tr>${columns.map((c) => `<td>${cell(r[c])}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** The refusal text a failed answer shows: the error, and the install line when the peer is missing. */
export function refusalText(body) {
  if (!body) return "No answer.";
  const lines = [body.error ?? "Refused."];
  if (body.code === "graph-peer-missing") lines.push(`Install: ${body.install}`, ...(body.stillWorks ?? []).map((w) => `Still works: ${w}`));
  else if (body.remedy) lines.push(body.remedy);
  return lines.join("\n");
}

/* c8 ignore start: the DOM half, driven by the page */
export function initGraphPane(doc = document, fetchJson = (u) => fetch(u, { headers: { accept: "application/json" } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))) {
  const $ = (id) => doc.getElementById(id);
  const show = (answer) => {
    const { status, body } = answer;
    $("g-error").textContent = status === 200 ? "" : refusalText(body);
    $("g-draw").innerHTML = status === 200 ? drawSvg(body.draw) : "";
    $("g-rows").innerHTML = status === 200 && body.columns ? rowsTable(body.columns, body.rows) : "";
    $("g-sources").textContent = sourceLines(body.sources).join("\n");
    const link = $("g-link");
    if (status === 200 && body.link) {
      link.href = body.link;
      link.hidden = false;
    } else link.hidden = true;
  };
  const status = async () => {
    const s = await fetchJson("/api/graphdb");
    if (s.status !== 200) return show(s);
    const peer = s.body.peer;
    $("g-peer").textContent = peer?.available ? `LadybugDB ${peer.version ?? ""}`.trim() : refusalText(peer?.refusal);
    $("g-counts").textContent = `${s.body.counts.resources} resources, ${s.body.counts.refs} edges (${s.body.counts.derived} derived), ${s.body.counts.cloudIds} cloud ids`;
    $("g-sources").textContent = sourceLines(s.body.sources).join("\n");
    $("g-notes").textContent = (s.body.notes ?? []).join("\n");
  };
  $("g-cypher-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    let params;
    const raw = $("g-params").value.trim();
    if (raw) {
      try {
        params = JSON.parse(raw);
      } catch {
        $("g-error").textContent = "Parameters are a JSON object.";
        return;
      }
    }
    show(await fetchJson(queryUrl($("g-cypher").value, params)));
  });
  $("g-resolve-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const r = await fetchJson(resolveUrl($("g-ref").value));
    show(r);
    const list = $("g-candidates");
    list.innerHTML = "";
    if (r.status !== 200) return;
    for (const c of r.body.candidates) {
      const li = doc.createElement("li");
      li.textContent = `${c.key} (${c.kind}, ${c.source}, matched by ${c.matchedBy})`;
      list.append(li);
    }
    const menu = $("g-templates");
    menu.innerHTML = "";
    const node = r.body.resolved ? r.body.candidates[0].key : null;
    for (const t of r.body.templates ?? []) {
      const b = doc.createElement("button");
      b.type = "button";
      b.textContent = `${t.title}${t.language === "cypher" ? " (Cypher)" : ""}`;
      b.disabled = !t.available;
      if (!t.available) b.title = `${t.refusal} ${t.install}`;
      b.addEventListener("click", async () => {
        const inputs = {};
        for (const i of t.inputs) {
          const v = globalThis.prompt?.(`${t.title}: ${i.description}`);
          if (!v) return;
          inputs[i.name] = v;
        }
        const a = await fetchJson(templateUrl(t.name, node, inputs));
        if (a.status === 200 && a.body.search) {
          // A search template draws in behold's own view, through the q key.
          globalThis.location.href = a.body.link;
          return;
        }
        show(a);
      });
      menu.append(b);
    }
  });
  status();
}
/* c8 ignore stop */
