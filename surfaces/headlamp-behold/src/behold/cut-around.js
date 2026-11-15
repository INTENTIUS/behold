// The one walk behind every "cut around" in behold (#1081, and #1067 over a
// behold-graph/1 document). Plain ESM, no imports at all: a browser host, a
// Node reader and a test load it the same way.
//
// A cut keeps the seeds, what they reach upstream, what reaches them
// downstream, and the groups (boxes) those nodes sit in. An edge runs from a
// consumer to what it needs (`from` needs `to`, as chant's IR draws it), so
// "up" follows `from -> to` and "down" follows `to -> from`. Each direction is
// its own closure, as chant's `blast:` lens does it: two things that merely
// share a dependency are not neighbours of each other.
//
// Two budgets bound the walk. `depth` counts hops between "inside" nodes. The
// host says what inside is with `inside(node)`; with none, every node is
// inside and `outside` never applies, which is the plain depth-bounded cut.
// `outside` counts hops past the last inside node, so a Kubernetes host can
// keep two hops beyond the cluster (a service account, the cloud identity it
// is bound to, the project that owns it) without a long walk through the
// cloud estate. A hop never goes from outside back to inside.
//
// #1067 wraps this: it turns a box id into its member ids, calls cutAround,
// and adds `cut` and `notes` to the document it returns. Nothing there should
// walk the graph a second time.

/** Adjacency for one direction: node id -> ids it leads to. */
function adjacency(edges, direction) {
  const next = new Map();
  for (const e of edges || []) {
    const [a, b] = direction === "up" ? [e.from, e.to] : [e.to, e.from];
    if (a === undefined || b === undefined) continue;
    let list = next.get(a);
    if (!list) next.set(a, (list = []));
    list.push(b);
  }
  return next;
}

/** Ids reached walking one direction from `seeds`, seeds included. */
function reach(next, seeds, byId, depth, outside, inside) {
  const kept = new Set(seeds);
  const insideSeeds = seeds.filter((id) => inside(byId.get(id)));
  const outsideSeeds = seeds.filter((id) => !inside(byId.get(id)));
  // Inside phase: breadth-first to `depth` hops, over inside nodes only.
  const insideKept = new Set(insideSeeds);
  let layer = insideSeeds;
  for (let hop = 0; hop < depth && layer.length; hop++) {
    const following = [];
    for (const id of layer) {
      for (const m of next.get(id) || []) {
        const node = byId.get(m);
        if (!node || !inside(node) || insideKept.has(m)) continue;
        insideKept.add(m);
        following.push(m);
      }
    }
    layer = following;
  }
  for (const id of insideKept) kept.add(id);
  // Outside phase: from every kept inside node and every outside seed, up to
  // `outside` hops through outside nodes. Breadth-first from all of them at
  // once, so a node is reached with the fewest outside hops it can be.
  const seen = new Set(outsideSeeds);
  const expand = (ids) => {
    const following = [];
    for (const id of ids) {
      for (const m of next.get(id) || []) {
        const node = byId.get(m);
        if (!node || inside(node) || seen.has(m)) continue;
        seen.add(m);
        following.push(m);
      }
    }
    return following;
  };
  let wave = expand([...insideKept, ...outsideSeeds]);
  for (let hop = 1; hop <= outside && wave.length; hop++) {
    for (const id of wave) kept.add(id);
    wave = expand(wave);
  }
  return kept;
}

/**
 * Cut `graph` (`{ nodes, edges, groups }`, the `ir` of /api/graph or a
 * behold-graph/1 document) around `startIds`.
 *
 * Options: `depth` (default 1), `up` and `down` (default true), `outside`
 * (default 2, used only when `inside` is given), `inside(node) -> boolean`.
 *
 * Returns `{ nodes, edges, groups, seeds }`. `seeds` are the start ids the
 * graph holds, in the order given. An id the graph does not hold is not
 * silently dropped: with none of them found, `nodes` is empty and `reason`
 * names every missing id; with some found, `missing` lists the rest. Edges are
 * kept only when both ends are kept. `groups` keeps, for each group key, the
 * boxes that still hold a kept node, filtered to the kept ids.
 */
export function cutAround(graph, startIds, opts = {}) {
  const { depth = 1, up = true, down = true, outside = 2, inside = null } = opts;
  const isInside = typeof inside === "function" ? inside : () => true;
  const nodes = (graph && graph.nodes) || [];
  const edges = (graph && graph.edges) || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const wanted = [...new Set(startIds || [])];
  const seeds = wanted.filter((id) => byId.has(id));
  const missing = wanted.filter((id) => !byId.has(id));
  if (!seeds.length) {
    const reason = wanted.length ? `the graph holds no node ${missing.map((m) => `"${m}"`).join(", ")}` : "no start node was given";
    return { nodes: [], edges: [], groups: {}, seeds: [], missing, reason };
  }
  const kept = new Set(seeds);
  const budget = Math.max(0, Number.isFinite(depth) ? Math.floor(depth) : 0);
  const out = Math.max(0, Number.isFinite(outside) ? Math.floor(outside) : 0);
  if (up) for (const id of reach(adjacency(edges, "up"), seeds, byId, budget, out, isInside)) kept.add(id);
  if (down) for (const id of reach(adjacency(edges, "down"), seeds, byId, budget, out, isInside)) kept.add(id);
  const cut = {
    nodes: nodes.filter((n) => kept.has(n.id)),
    edges: edges.filter((e) => kept.has(e.from) && kept.has(e.to)),
    groups: cutGroups(graph && graph.groups, kept),
    seeds,
  };
  if (missing.length) cut.missing = missing;
  return cut;
}

/** Each `{ key: { box: [ids] } }` group set, reduced to the kept ids; empty boxes drop. */
function cutGroups(groups, kept) {
  const out = {};
  for (const [key, boxes] of Object.entries(groups || {})) {
    if (!boxes || typeof boxes !== "object" || Array.isArray(boxes)) continue;
    const reduced = {};
    for (const [box, ids] of Object.entries(boxes)) {
      if (!Array.isArray(ids)) continue;
      const keep = ids.filter((id) => kept.has(id));
      if (keep.length) reduced[box] = keep;
    }
    if (Object.keys(reduced).length) out[key] = reduced;
  }
  return out;
}
