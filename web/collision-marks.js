// #684: collision marks. Pure words and colours from
// /api/workspace/collisions; app.js draws them.
//
// A graph node is marked when two or more in-flight work items reach it: both
// have a commit that changed the file declaring it, and a waiting gate's
// change set has an entry on it (chant#4025). The mark is a ring round the
// card and a tag under it that names the items; the tooltip lists the items
// and the entries behind it. Files two items both changed have no node, so
// the Collisions tab lists them on the side. The filter keeps only colliding
// work: the colliding nodes on the graph (the rest are hidden, with the edges
// that touch them) and the colliding items in the tab.
//
// behold records and locks nothing. chant reports, and the people on the two
// items sort the overlap out.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const short = (s) => (s ? String(s).replace(/^(jcs1-)?sha256:/, "").slice(0, 12) : "");
const sha7 = (s) => (s ? String(s).slice(0, 7) : "");
const id = (item) => String(item).replace(/^[^:]*:/, "");

/** The colour of the ring and the tag. */
export const COLLISION_COLOR = "var(--degraded)";
/** The note on what a collision is. */
export const COLLISION_NOTE = "Two in-flight work items changed the file that declares this resource, and a waiting gate's change set has an entry on it. behold only reports it; nothing is locked.";
/** The note on the side list. */
export const FILES_NOTE = "These files have no graph node, so they are listed here and not marked on the graph.";
/** The filter's button, by whether it is on. */
export const FILTER_ON = "Show all work";
export const FILTER_OFF = "Show only colliding work";

/** The tab's first line: what was read, or why it wasn't. */
export function collisionHeader(a) {
  if (!a || a.error) return { text: `collisions not read${a && a.error ? `: ${a.error}` : ""}`, title: "", tone: "refusal" };
  if (a.refusal) return { text: `collisions not read: ${a.refusal.error}`, title: [a.refusal.remedy, a.degraded ? `Without it, ${a.degraded}.` : ""].filter(Boolean).join("\n"), tone: "refusal" };
  const colliding = a.items.filter((i) => i.with.length).length;
  const n = a.nodes.length;
  if (!colliding) return { text: `no work items collide (${plural(a.items.length, "work item")} in flight)`, title: COLLISION_NOTE, tone: "quiet" };
  return { text: `${plural(colliding, "work item")} collide, ${plural(n, "node")} marked`, title: COLLISION_NOTE, tone: "quiet" };
}

/** The marks to draw: per node id in `ids` that a collision names, a tag, the items and a tooltip. */
export function collisionMarks(a, ids) {
  const out = {};
  if (!a || a.error || a.refusal || !a.nodes) return out;
  const want = new Set(ids);
  for (const n of a.nodes) {
    if (!want.has(n.node)) continue;
    const lines = n.entries.map((e) => `${e.address} in change set ${short(e.changeSet)}, declared in ${e.source}: ${e.items.join(" and ")}`);
    out[n.node] = {
      color: COLLISION_COLOR,
      items: n.items,
      tag: `collision: ${n.items.map(id).join(", ")}`,
      title: [`${n.node} is touched by ${plural(n.items.length, "in-flight work item")}:`, ...n.items, "", ...lines, "", COLLISION_NOTE].join("\n"),
    };
  }
  return out;
}

/** Whether a node id stays on the graph with the filter on. */
export function keepNode(a, nodeId) {
  return !!a && !a.error && !a.refusal && !!a.nodes && a.nodes.some((n) => n.node === nodeId);
}

/**
 * What the filter leaves: the ids of `ids` to hide on the graph, and the items
 * and files the tab lists. With the filter off nothing is hidden and every
 * in-flight item is listed; with it on, only the colliding nodes (and the
 * edges between them) and the items that collide.
 */
export function collisionFilter(a, ids, on) {
  if (!a || a.error || a.refusal || !a.items) return { hide: [], items: [], nodes: [], files: [] };
  const nodes = a.nodes;
  if (!on) return { hide: [], items: a.items, nodes, files: a.files };
  const keep = new Set(nodes.map((n) => n.node));
  return { hide: ids.filter((i) => !keep.has(i)), items: a.items.filter((i) => i.with.length), nodes, files: a.files };
}

/** Whether an edge between two node ids is hidden with the filter on: when either end is. */
export function hideEdge(a, from, to, on) {
  return !!on && !(keepNode(a, from) && keepNode(a, to));
}

/** One item's row in the tab. */
export function itemRow(i) {
  const facts = [i.state || "no state", i.path, `${plural(i.commits.length, "commit")}${i.commits.length ? ` (${i.commits.map(sha7).join(", ")})` : ""}`];
  return {
    key: i.item,
    title: i.item,
    facts: facts.filter(Boolean).join(" · "),
    with: i.with.length ? `collides with ${i.with.join(", ")}` : "collides with none",
    colliding: i.with.length > 0,
  };
}

/** One marked node's row: the node and the items there. */
export function nodeRow(n) {
  return {
    node: n.node,
    text: `${n.node}: ${n.items.join(" and ")}`,
    title: n.entries.map((e) => `${e.address} in change set ${short(e.changeSet)}, declared in ${e.source}`).join("\n"),
  };
}

/** The side list: files two items both changed, and shared entries chant mapped to no node. */
export function sideLines(a) {
  if (!a || a.error || a.refusal) return [];
  return [
    ...a.files.map((f) => ({ text: `${f.items.join(" and ")}: ${f.files.join(", ")}`, title: FILES_NOTE })),
    ...a.unplaced.map((u) => ({ text: `${u.items.join(" and ")}: ${u.address} of ${u.member} in change set ${short(u.changeSet)}, declared in ${u.source}`, title: "chant maps this entry to no graph node, so it is listed here and not marked on the graph." })),
  ];
}

/** The items colliding on one card, for the inspect pane. */
export function collisionsFor(a, nodeId) {
  if (!a || a.error || a.refusal || !a.nodes) return [];
  const n = a.nodes.find((x) => x.node === nodeId);
  return n ? n.items.map((item) => ({ text: item, color: COLLISION_COLOR, title: n.entries.map((e) => `${e.address} in change set ${short(e.changeSet)}, declared in ${e.source}`).join("\n") })) : [];
}

/** Lines for what the answer leaves out, when it says so. */
export function gapLines(a) {
  if (!a || a.error || a.refusal) return [];
  return a.unattributed ? [{ text: `${plural(a.unattributed, "change-set entry", "change-set entries")} could not be attributed to a work item`, title: "chant attributes an entry through the file that declares its node. An entry stored by an older chant, or on a node with no source file, goes to no item." }] : [];
}
