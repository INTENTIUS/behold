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
 * wires them to the page. behold#1182: LadybugDB's badge beside the Cypher
 * heading (#g-engine-badge) moves while a query, a resolve or a template runs
 * and a few seconds after a fresh result set (web/engine-badge.js).
 */
import { bindEngineBadge } from "./engine-badge.js";

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

/**
 * The resolve answer's candidates as the page lists them. When the reference
 * named more than one node (a cloud id that chant, an engine and an index all
 * know), each candidate can be opened: resolving its key lands on that one
 * node, with its templates.
 */
export function candidateItems(body) {
  const many = !body?.resolved && (body?.candidates?.length ?? 0) > 1;
  return (body?.candidates ?? []).map((c) => ({ key: c.key, label: `${c.key} (${c.kind}, ${c.source}, matched by ${c.matchedBy})`, open: many }));
}

/** One line per source: what it is and when it was read ("declared" when nothing was read live). */
export function sourceLines(sources) {
  return (sources ?? []).map((s) => {
    const what = `${s.member ? `${s.member}: ` : ""}${s.name}${s.version ? ` ${s.version}` : ""} (${s.source}, ${s.scopeKey})`;
    const when = s.observedAt ? `observed ${s.observedAt}` : "declared source, not observed";
    return `${what}: ${when}; loaded ${s.readAt}; ${s.nodes} nodes, ${s.edges} edges`;
  });
}

const CANNOT_LIST = /^(.*?): Cloud Control cannot list (\S+): (.*)$/;

/**
 * behold#1177: the status notes, one line each, with a Cloud Control index's
 * "cannot list <type>" notes grouped: one line per source and per answer,
 * naming how many types gave it and which. The answer keeps its words, with
 * the type shown as <type>. A note that stands alone prints unchanged.
 */
export function noteLines(notes) {
  const out = [];
  const groups = new Map();
  for (const n of notes ?? []) {
    const m = typeof n === "string" ? CANNOT_LIST.exec(n) : null;
    if (!m) {
      out.push({ line: n });
      continue;
    }
    const [, scope, type, answer] = m;
    const key = `${scope}\u0000${answer.split(type).join("<type>")}`;
    let g = groups.get(key);
    if (!g) {
      g = { scope, answer: answer.split(type).join("<type>"), types: [], notes: [] };
      groups.set(key, g);
      out.push(g);
    }
    g.types.push(type);
    g.notes.push(n);
  }
  return out.map((x) =>
    x.line !== undefined ? x.line : x.types.length === 1 ? x.notes[0] : `${x.scope}: Cloud Control cannot list ${x.types.length} types (${x.types.join(", ")}). Each answered ${x.answer}`,
  );
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

/**
 * behold#1190: the columns of an answer that hold graph keys: every value
 * that is not null is a string `known` has (a Set or Map of Resource keys),
 * and there is at least one. Nothing is guessed from a value's shape: a
 * column of names, kinds or scope keys is not one, however it looks.
 */
export function keyColumns(columns, rows, known) {
  const has = (v) => typeof v === "string" && known.has(v);
  return (columns ?? []).filter((c) => {
    const vals = (rows ?? []).map((r) => (r && typeof r === "object" ? r[c] : undefined)).filter((v) => v !== null && v !== undefined);
    return vals.length > 0 && vals.every(has);
  });
}

/**
 * behold#1190: what an answer's drawing shows, as `{ nodes, edges, lit,
 * keyColumns }`. `known` maps Resource keys to their nodes (`{ key, kind,
 * name, source, scopeKey }`): the rows a page holds (graphdb.json's
 * resources), or none, when only the answer's own drawing names nodes.
 *
 * The nodes are the answer's drawing (its keys, with the REF edges among
 * them) and every value of a key column ({@link keyColumns}), so both ends
 * of each row are drawn. A row that pairs two keys is drawn as an edge from
 * its first key column's value to the other's, labelled with that column's
 * name (`origin: "row"`). behold invents no edges: these are the answer's
 * own rows drawn as the query paired them, not a join behold makes, and the
 * label says which column did. A REF edge between the same two nodes keeps
 * its own line and takes the label. `lit` is every drawn node the answer
 * names. Pure: the ask demo's recorded turns, a visitor's query there and
 * the /graph pane draw with it.
 */
export function answerDrawing(body, known = new Map()) {
  const draw = body?.draw ?? {};
  const byKey = new Map(known);
  for (const n of draw.nodes ?? []) if (n && typeof n.key === "string") byKey.set(n.key, n);
  const cols = keyColumns(body?.columns, body?.rows, byKey);
  const nodes = [...(draw.nodes ?? [])];
  const drawn = new Set(nodes.map((n) => n.key));
  const add = (k) => {
    if (drawn.has(k)) return;
    drawn.add(k);
    nodes.push(byKey.get(k));
  };
  for (const r of body?.rows ?? []) for (const c of cols) if (typeof r[c] === "string") add(r[c]);
  const edges = (draw.edges ?? []).filter((e) => drawn.has(e.from) && drawn.has(e.to)).map((e) => ({ ...e }));
  const [first, ...rest] = cols;
  const seen = new Set();
  for (const r of body?.rows ?? []) {
    const from = r[first];
    for (const c of rest) {
      const to = r[c];
      if (typeof from !== "string" || typeof to !== "string" || from === to || seen.has(`${from}\u0000${to}\u0000${c}`)) continue;
      seen.add(`${from}\u0000${to}\u0000${c}`);
      const ref = edges.find((e) => e.from === from && e.to === to && e.column === undefined);
      if (ref) ref.column = c;
      else edges.push({ from, to, origin: "row", column: c });
    }
  }
  const named = new Set([...(body?.keys ?? []), ...(body?.rows ?? []).flatMap((r) => cols.map((c) => r[c]))]);
  return { nodes, edges, lit: nodes.map((n) => n.key).filter((k) => named.has(k)), keyColumns: cols };
}

/** The room a two-column drawing gives each side's labels, in its own units, and a label's width per character. */
const SIDE = 0.4;
const CHAR = 7.8;
/** A two-column drawing is at least this wide, in its own units, so a side holds about 24 characters. */
const COLUMNS_WIDTH = 520;

/**
 * behold#1190: a drawing with row edges in two columns: the first key
 * column's nodes on the left, the rest on the right, each in answer order,
 * the taller one `gap` apart, the shorter spread over the same height.
 */
export function columnLayout(draw, width = 520, gap = 34) {
  const from = new Set(draw.edges.filter((e) => e.column !== undefined).map((e) => e.from));
  const left = draw.nodes.filter((n) => from.has(n.key));
  const right = draw.nodes.filter((n) => !from.has(n.key));
  const height = Math.max(left.length, right.length, 2) * gap + gap;
  const at = {};
  // Each column spread over the drawing's height, so a short one does not bunch up in the middle.
  const place = (list, x) => {
    const step = (height - gap) / Math.max(list.length, 1);
    list.forEach((n, i) => (at[n.key] = { x: Math.round(x), y: Math.round(gap / 2 + step * (i + 0.5)), side: x < width / 2 ? "left" : "right" }));
  };
  place(left, width * SIDE);
  place(right, width * (1 - SIDE));
  return { at, width, height };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const clip = (s, n) => (s.length > n ? `${s.slice(0, Math.max(1, n - 3))}...` : s);

/**
 * The answer's drawing as SVG text. Each node carries its key; the keys in
 * `lit` (behold#1163, the ask demo) are drawn lit. A drawing with labelled
 * edges (behold#1190, {@link answerDrawing}) is laid out in two columns, each
 * edge's column name written once beside the node it reaches; otherwise the
 * nodes sit on a circle.
 */
export function drawSvg(draw, size = 520, lit = []) {
  const on = new Set(lit);
  const nodes = draw?.nodes ?? [];
  if (!nodes.length) return "";
  const labelled = (draw.edges ?? []).some((e) => e.column !== undefined);
  const lay = labelled ? columnLayout(draw, Math.max(size, COLUMNS_WIDTH)) : { at: circleLayout(nodes, size), width: size, height: size };
  const at = lay.at;
  const shown = (draw.edges ?? []).filter((e) => at[e.from] && at[e.to]);
  const edges = shown
    .map((e) => {
      const a = at[e.from];
      const b = at[e.to];
      const derived = e.origin === "derived";
      const row = e.origin === "row";
      const title = `${e.from} -> ${e.to}${e.column ? ` (the answer's ${e.column} column)` : ""}${e.viaAttr ? ` via ${e.viaAttr}` : ""}${derived ? ` (derived: ${e.rule})` : ""}`;
      const label = e.column ? ` data-label="${esc(e.column)}"` : "";
      return `<line class="g-edge${derived ? " derived" : ""}${row ? " row" : ""}"${label} x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" marker-end="url(#g-arrow)"><title>${esc(title)}</title></line>`;
    })
    .join("");
  // Each column's name once beside each node it reaches, between the columns.
  const names = new Map();
  for (const e of shown) if (e.column && at[e.to].side === "right") names.set(e.to, [...new Set([...(names.get(e.to) ?? []), e.column])]);
  const words = [...names]
    .map(([k, cols]) => `<text class="g-edge-label" x="${at[k].x - 12}" y="${at[k].y - 6}" text-anchor="end">${esc(cols.join(", "))}</text>`)
    .join("");
  const room = Math.floor((lay.width * SIDE - 18) / CHAR);
  const dots = nodes
    .map((n) => {
      const p = at[n.key];
      const label = n.name || n.key;
      const left = p.side === "left";
      const text = labelled ? clip(label, room) : clip(label, 32);
      const tx = left ? p.x - 12 : p.x + 10;
      return `<g class="g-node ${esc(n.source)}${on.has(n.key) ? " lit" : ""}" data-key="${esc(n.key)}"><circle cx="${p.x}" cy="${p.y}" r="7"><title>${esc(`${n.key} (${n.kind}, ${n.scopeKey})`)}</title></circle><text x="${tx}" y="${p.y + 4}"${left ? ' text-anchor="end"' : ""}><title>${esc(n.key)}</title>${esc(text)}</text></g>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${lay.width} ${lay.height}" role="img" aria-label="answer graph"><defs><marker id="g-arrow" viewBox="0 0 10 10" refX="16" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="g-arrowhead"/></marker></defs>${edges}${words}${dots}</svg>`;
}

/** A table of the answer's rows as HTML text. */
export function rowsTable(columns, rows) {
  if (!rows?.length) return "<p class=\"g-muted\">No rows.</p>";
  const cell = (v) => esc(typeof v === "string" ? v : JSON.stringify(v));
  const head = columns.map((c) => `<th>${esc(c)}</th>`).join("");
  // Each cell's whole value on hover too, for a page that cuts long cells short (behold#1190, the ask demo).
  const body = rows.map((r) => `<tr>${columns.map((c) => `<td title="${cell(r[c])}">${cell(r[c])}</td>`).join("")}</tr>`).join("");
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

/** behold#1180: the line under the template list in a bundle, when it lists a search template. */
export const STATIC_SEARCH_LINE = "Search templates run on behold serve; the Cypher templates run in this page.";

/**
 * One template's button: its label, whether it is disabled, and its tooltip.
 * `bundle` is undefined on the server, where every available template runs.
 * In a bundle (`{ estate, searches }`, behold#1180) a search template runs
 * only when the bundle has an estate view and `--q` captured the exact query
 * it expands to; resolve gives that query for a template without inputs.
 */
export function templateControl(t, bundle) {
  const label = `${t.title}${t.language === "cypher" ? " (Cypher)" : ""}${t.origin === "project" ? ", this project's" : ""}`;
  if (!t.available) return { label, disabled: true, title: `${t.refusal} ${t.install}`, staticSearch: false };
  if (!bundle || t.language !== "search") return { label, disabled: false, title: "", staticSearch: false };
  const q = t.expanded?.query?.trim();
  if (bundle.estate && q && (bundle.searches ?? []).includes(q)) return { label, disabled: false, title: "Opens the estate view, which this export captured the query for.", staticSearch: false };
  const capture = bundle.estate && q ? ` This export did not capture it; behold export --q "${q}" captures it.` : "";
  return { label, disabled: true, title: `Runs on behold serve; the Cypher templates run in this page.${capture}`, staticSearch: true };
}

/* c8 ignore start: the DOM half, driven by the page */
/**
 * `opts` (behold#1180) is for a bundle's page: `bundle` ({ estate, searches })
 * limits the search templates as {@link templateControl} says, and
 * `viewLinks: false` hides an answer's estate link. The server passes none.
 */
export function initGraphPane(doc = document, fetchJson = (u) => fetch(u, { headers: { accept: "application/json" } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })), opts = {}) {
  const viewLinks = opts.viewLinks !== false;
  const $ = (id) => doc.getElementById(id);
  const badge = bindEngineBadge($("g-engine-badge"));
  /** A read the visitor asked for: the badge moves while it runs. The pane's own status read is not one. */
  const ask = (url) => badge.run(fetchJson(url));
  const show = (answer) => {
    const { status, body } = answer;
    $("g-error").textContent = status === 200 ? "" : refusalText(body);
    // behold#1190: both ends of each row, where the answer's drawing names them.
    $("g-draw").innerHTML = status === 200 ? drawSvg(answerDrawing(body)) : "";
    $("g-rows").innerHTML = status === 200 && body.columns ? rowsTable(body.columns, body.rows) : "";
    $("g-sources").textContent = sourceLines(body.sources).join("\n");
    const link = $("g-link");
    if (viewLinks && status === 200 && body.link) {
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
    $("g-notes").textContent = noteLines(s.body.notes).join("\n");
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
    show(await ask(queryUrl($("g-cypher").value, params)));
  });
  $("g-resolve-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const r = await ask(resolveUrl($("g-ref").value));
    show(r);
    const list = $("g-candidates");
    list.innerHTML = "";
    if (r.status !== 200) return;
    for (const c of candidateItems(r.body)) {
      const li = doc.createElement("li");
      li.textContent = c.label;
      if (c.open) {
        const b = doc.createElement("button");
        b.type = "button";
        b.textContent = "open";
        b.title = `Resolve ${c.key}`;
        b.addEventListener("click", () => {
          $("g-ref").value = c.key;
          $("g-resolve-form").requestSubmit();
        });
        li.append(" ", b);
      }
      list.append(li);
    }
    const menu = $("g-templates");
    menu.innerHTML = "";
    const node = r.body.resolved ? r.body.candidates[0].key : null;
    let staticSearch = false;
    for (const t of r.body.templates ?? []) {
      const b = doc.createElement("button");
      b.type = "button";
      const c = templateControl(t, opts.bundle);
      b.textContent = c.label;
      b.disabled = c.disabled;
      if (c.title) b.title = c.title;
      staticSearch ||= c.staticSearch;
      b.addEventListener("click", async () => {
        const inputs = {};
        for (const i of t.inputs) {
          const v = globalThis.prompt?.(`${t.title}: ${i.description}`);
          if (!v) return;
          inputs[i.name] = v;
        }
        const a = await ask(templateUrl(t.name, node, inputs));
        if (a.status === 200 && a.body.search) {
          // A search template draws in behold's own view, through the q key.
          globalThis.location.href = a.body.link;
          return;
        }
        show(a);
      });
      menu.append(b);
    }
    if (staticSearch) {
      const line = doc.createElement("p");
      line.className = "g-muted";
      line.textContent = STATIC_SEARCH_LINE;
      menu.append(line);
    }
  });
  status();
}
/* c8 ignore stop */
