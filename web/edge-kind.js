// #553: an edge's kind, in words. chant 0.124.20 (chant#3912) gives every IR
// edge a `kind` (ref | needs | calls | triggers | includes | extends) and marks
// an edge that leaves its workflow or pipeline `crossPipeline`. pinhole 0.4.0
// stamps both on the drawn edge and its chip as `data-edge-kind` (left off for
// "ref") and `data-edge-cross="true"`; index.html styles them, and this module
// writes the chip text, the hover tooltip and the Model tab's edge rows.
// Pure, so web/edge-kind.test.js can pin the words.

/** The CI kinds, in the order the legend lists them. */
export const CI_KINDS = ["needs", "calls", "triggers", "includes", "extends"];

/** What each CI kind means, for the tooltip and the legend row's title. */
export const KIND_MEANING = {
  needs: "waits for the other job to finish",
  calls: "runs the other workflow as a reusable workflow",
  triggers: "starts the other workflow or pipeline",
  includes: "pulls the other file into this pipeline",
  extends: "takes the other job's settings",
};

/** The sentence a cross-pipeline edge adds, here and on the legend row. */
export const CROSS_MEANING = "cross-pipeline: leaves its own workflow or pipeline";

// The reason sentences for behold's own `ref` edges (src/logical.ts tags them).
const REF_REASON = {
  "security-group ingress": "security-group ingress — traffic is allowed here",
  "data dependency": "data dependency — reads/uses this store",
};

/** A missing or "ref" kind is a reference; anything else is a CI kind. */
export function isCiKind(kind) {
  return !!kind && kind !== "ref";
}

/**
 * The chip text, as chant's Mermaid and DOT writers label the edge
 * (graph-mermaid.ts `edgeLabel`): a CI edge by its kind, plus the attribute
 * when that says something more (`needs (stage)`, `calls (uses)`); a
 * reference by the attribute it flows through. Empty when there is nothing
 * to say.
 */
export function edgeLabel({ kind, via, toAttr } = {}) {
  if (!isCiKind(kind)) return [via, toAttr].filter(Boolean).join(" → ");
  return via && via !== kind ? `${kind} (${via})` : kind;
}

/**
 * The hover tooltip: who points at whom on the first line, then the kind
 * (with its meaning) for a CI edge or the reason for a reference, then the
 * cross-pipeline sentence when the edge carries it.
 */
export function edgeTitle(from, to, { kind, via, cross } = {}) {
  const lines = [`${from} → ${to}`];
  if (isCiKind(kind)) {
    const meaning = KIND_MEANING[kind];
    lines.push(meaning ? `${edgeLabel({ kind, via })}: ${meaning}` : edgeLabel({ kind, via }));
  } else if (via) {
    lines.push(REF_REASON[via] || via);
  }
  if (cross) lines.push(CROSS_MEANING);
  return lines.join("\n");
}

/**
 * The Model tab's edge rows: one per CI kind the graph holds, with its count,
 * then one for the cross-pipeline edges. A kind whose every edge is
 * cross-pipeline (GitHub's `calls` and `triggers`) is drawn dashed on its row
 * too, as it is on the graph. Empty when the graph has neither, so an
 * infrastructure graph shows no edge legend.
 */
export function edgeLegend(edges = []) {
  const counts = new Map();
  const crossCounts = new Map();
  let cross = 0;
  for (const e of edges) {
    if (isCiKind(e.kind)) {
      counts.set(e.kind, (counts.get(e.kind) || 0) + 1);
      if (e.crossPipeline) crossCounts.set(e.kind, (crossCounts.get(e.kind) || 0) + 1);
    }
    if (e.crossPipeline) cross++;
  }
  const known = CI_KINDS.filter((k) => counts.has(k));
  const other = [...counts.keys()].filter((k) => !CI_KINDS.includes(k)).sort();
  const rows = [...known, ...other].map((kind) => ({
    kind,
    cross: crossCounts.get(kind) === counts.get(kind),
    label: kind,
    count: counts.get(kind),
    title: KIND_MEANING[kind] || kind,
  }));
  if (cross) rows.push({ kind: null, cross: true, label: "cross-pipeline (dashed)", count: cross, title: CROSS_MEANING });
  return rows;
}
