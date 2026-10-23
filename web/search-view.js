// behold#913: `q`, a chant search query drawn over the graph.
//
// The server runs the query through chant (GET /api/search, src/search.ts)
// and answers chant's document plus `draw`, the projection of it the page
// draws: the matched ids, the ids and edges on their paths, the rows a live
// read could not observe, the near-misses, the provenance line, a failure,
// and the members chant did not search. This module decides, from that answer
// and what is on screen, what each card and edge looks like and what the one
// query line says. No DOM: app.js applies it.

/** The read a view's query asks for. The keys are the ones the export captures it under (canonicalKey). */
export function searchUrl(view) {
  const v = view || {};
  const p = new URLSearchParams();
  if (v.countBy) p.set("countBy", v.countBy); // behold#922
  if (v.env) p.set("env", v.env);
  if (v.plan) p.set("plan", "1"); // behold#922
  p.set("q", v.q || "");
  if (v.env && v.snapshot && !v.plan) p.set("snapshot", v.snapshot);
  return `/api/search?${p}`;
}

/** What identifies one answer: a new query, env, snapshot, grouping or plan is a new read. A grouping alone counts the whole graph. */
export function searchKey(view) {
  const v = view || {};
  return v.q || v.countBy ? JSON.stringify([v.q || "", v.env || null, (v.env && !v.plan && v.snapshot) || null, v.countBy || null, !!v.plan]) : null;
}

/** behold#922: the colours a group is drawn in, in chant's group order, repeating past the last. */
export const GROUP_COLOURS = ["#58a6ff", "#f0883e", "#3fb950", "#d2a8ff", "#ff7b72", "#e3b341", "#39c5cf", "#f778ba"];

/**
 * behold#922: how a counts answer (chant's `--count-by`, src/search.ts
 * `drawnOf`'s `counts`) is drawn against the cards on screen. One entry per
 * chant group, in chant's order: its name, chant's count, its colour, the ids
 * of its cards that are drawn, and `label`, the first of them, where the
 * group's label goes. `cardGroup` maps each drawn card to its group's index.
 * A group whose cards are all stacked or elided at this zoom has no label
 * card; the line still lists it. Groups behold can't light (an older chant
 * listed no ids) have `ids: null`.
 */
export function groupMarks(answer, cards) {
  const drawnIds = cards instanceof Set ? cards : new Set(cards || []);
  const d = (answer && answer.draw) || null;
  const out = { groups: [], cardGroup: new Map(), total: 0, by: "" };
  if (!d || !d.counts) return out;
  out.total = d.counts.total;
  out.by = d.counts.by;
  d.counts.groups.forEach((g, i) => {
    const drawn = (g.ids || []).filter((id) => drawnIds.has(id));
    for (const id of drawn) out.cardGroup.set(id, i);
    out.groups.push({ group: g.group, count: g.count, colour: GROUP_COLOURS[i % GROUP_COLOURS.length], drawn, label: drawn[0] || null, ids: g.ids });
  });
  return out;
}

/** behold#922: the label a group's first card wears: its name and chant's count. */
export function groupLabel(g) {
  return `${one(g.group)} · ${g.count}`;
}

/** behold#922: the line's account of a counts answer: each group and its count in chant's order, then the total. */
export function countsLine(counts) {
  if (!counts) return "";
  const shown = counts.groups.slice(0, 12).map((g) => `${one(g.group)} ${g.count}`);
  const more = counts.groups.length > 12 ? `, and ${counts.groups.length - 12} more` : "";
  const noIds = counts.groups.some((g) => !g.ids) ? "; this chant lists no ids per group, so no group is lit (chant 0.124.46 does)" : "";
  return `${counts.groups.length} group${counts.groups.length === 1 ? "" : "s"} by ${one(counts.by)}: ${shown.join(", ")}${more} · ${counts.total} total${noIds}`;
}

const one = (s) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

/**
 * How the page draws one answer, against what is on screen. `cards` is the
 * set of drawn card ids, `edges` the drawn edges as `{from, to}`.
 *
 * `cardMarks`: id -> "lit" | "path" | "dim" (every drawn card gets one, or
 * none when nothing is to be dimmed: a grammar error or a refusal). `near`:
 * id -> the term it fails, for the no-matches view. `unobserved`: the lit ids
 * a live read could not observe. `edgeMarks`: one entry per drawn edge, in
 * order: "path" (a hop on a match's path), "lit" (both ends lit), or "dim".
 * `state`: drawn | no-matches | failed | refused, as the shot reports it.
 */
export function queryMarks(answer, cards, edges) {
  const drawnIds = cards instanceof Set ? cards : new Set(cards || []);
  const edgeList = edges || [];
  const a = answer || {};
  const d = a.draw || null;
  const out = { cardMarks: new Map(), near: new Map(), unobserved: new Set(), edgeMarks: edgeList.map(() => null), state: "refused", litDrawn: 0, litTotal: 0 };
  if (!d) return out; // a refusal: nothing lit, nothing dimmed
  if (d.failure && d.failure.kind === "query") {
    out.state = "failed";
    return out; // chant refused the query: nothing lit and nothing dimmed
  }
  const lit = new Set(d.lit || []);
  const onPath = new Set((d.onPath || []).filter((id) => !lit.has(id)));
  out.litTotal = lit.size;
  for (const id of drawnIds) {
    const mark = lit.has(id) ? "lit" : onPath.has(id) ? "path" : "dim";
    out.cardMarks.set(id, mark);
    if (mark === "lit") out.litDrawn++;
  }
  for (const id of Object.keys(d.unobserved || {})) if (drawnIds.has(id)) out.unobserved.add(id);
  const hops = new Set();
  for (const h of d.edges || []) {
    hops.add(`${h.from}\u0000${h.to}`);
    hops.add(`${h.to}\u0000${h.from}`); // behold may draw the edge the other way round
  }
  out.edgeMarks = edgeList.map((e) => {
    if (hops.has(`${e.from}\u0000${e.to}`)) return "path";
    if (lit.has(e.from) && lit.has(e.to)) return "lit";
    return "dim";
  });
  if (!lit.size) for (const n of d.nearMisses || []) if (drawnIds.has(n.id)) out.near.set(n.id, n.fails);
  out.state = d.failure ? "failed" : lit.size || (d.counts && d.counts.total) ? "drawn" : "no-matches";
  return out;
}

/** The universe count `--explain` gives, summed over the plain or the workspace form. */
function universe(doc) {
  const sum = { matched: 0, of: 0, seen: false };
  const add = (ex) => {
    const u = ex && ex.universe;
    if (u && typeof u.matched === "number" && typeof u.of === "number") {
      sum.matched += u.matched;
      sum.of += u.of;
      sum.seen = true;
    }
  };
  if (doc) {
    add(doc.explain);
    for (const m of Array.isArray(doc.members) ? doc.members : []) add(m && m.explain);
  }
  return sum.seen ? sum : null;
}

/**
 * The one line the view shows for a query: what was asked, what came back,
 * and chant's provenance. `{text, tone, notSearched}`: tone is "ok",
 * "empty" or "failed"; notSearched is a second line naming the members chant
 * did not search, or "".
 */
export function queryLine(view, answer, marks) {
  const q = view && view.q ? `"${one(view.q)}"` : "the whole graph";
  const a = answer || {};
  const d = a.draw;
  if (!d) {
    // A refusal (an old chant, a loose estate, an export that didn't capture this query) or a failed request.
    return { text: `${q} not searched: ${one(a.error || "the search failed")}${a.remedy ? ` ${one(a.remedy)}` : ""}`, tone: "failed", notSearched: "" };
  }
  const notSearched = (d.notSearched || []).length
    ? `not searched: ${d.notSearched.map((m) => `${one(m.member)} (${one(m.code || m.status)}${m.message ? `: ${one(m.message)}` : ""})`).join("; ")}`
    : "";
  if (d.failure && d.failure.kind === "query") {
    return { text: `${q} was refused by chant: ${one(d.failure.message)}${d.failure.hint ? `. ${one(d.failure.hint)}` : ""}`, tone: "failed", notSearched };
  }
  const prov = d.provenance ? one(d.provenance) : "";
  const m = marks || queryMarks(answer, [], []);
  const parts = [];
  if (d.failure && d.failure.kind === "live") parts.push(one(d.failure.message));
  if (d.counts) {
    // behold#922: chant's groups and total, and how many lit cards are drawn at this zoom.
    const hidden = (d.lit || []).length - m.litDrawn;
    parts.push(`${q}: ${countsLine(d.counts)}${hidden > 0 ? `; ${hidden} not drawn at this zoom` : ""}`);
  } else if (!(d.lit || []).length) {
    const u = universe(a.document);
    parts.push(`no matches for ${q}${u ? `, 0 of ${u.of} nodes` : ""}${m.near.size ? `; near misses outlined (${m.near.size})` : ""}`);
  } else {
    const n = d.lit.length;
    const hidden = n - m.litDrawn;
    parts.push(`${q}: ${n} match${n === 1 ? "" : "es"}${hidden > 0 ? `, ${hidden} not drawn at this zoom` : ""}${(d.edges || []).length ? `, path edges drawn` : ""}`);
  }
  if (prov) parts.push(prov);
  if (view && view.plan) parts.push("at the plan depth");
  const tone = d.failure ? "failed" : (d.lit || []).length || (d.counts && d.counts.total) ? "ok" : "empty";
  return { text: parts.join(" · "), tone, notSearched };
}

/** The line a static export shows for a query it didn't capture. Lights nothing. */
export function uncapturedLine(q, queries) {
  const list = (queries || []).filter((x) => typeof x === "string");
  if (!list.length) return `"${one(q)}" not searched: this export captured no queries (behold export --q "<query>" captures one).`;
  return `"${one(q)}" not searched: this export answers ${list.length} captured quer${list.length === 1 ? "y" : "ies"}, and this is not one of them: ${list.map((x) => `"${one(x)}"`).join(", ")}.`;
}
