// #554: a CI reference whose target this project does not declare, such as
// another repository's reusable workflow or a local composite action. chant
// keeps each one on `ir.dangling` (chant#3912) with the value as written, and
// behold draws no edge for it, so the card holding it is where it is listed.
// The pure half, tested without a DOM the way web/release.js is.

/** The dangling references `nodeId` holds, in the order chant listed them. */
export function danglingFor(ir, nodeId) {
  const all = ir && Array.isArray(ir.dangling) ? ir.dangling : [];
  return all.filter((d) => d && d.from === nodeId);
}

/** One `[label, value]` row per reference: the edge kind it would have been
 * and where on the card it was written, then the value exactly as written. A
 * reference that leaves the pipeline says so. */
export function danglingRows(refs) {
  return refs.map((d) => {
    const label = d.path ? `${d.kind} · ${d.path}` : String(d.kind);
    return [label, d.crossPipeline ? `${d.value} (cross-pipeline)` : String(d.value)];
  });
}

/** The section heading, with the count. */
export function danglingHeading(refs) {
  return `not declared here · ${refs.length}`;
}

/** The line under the rows, saying why no edge is drawn for them. */
export const DANGLING_EXPLAINED = "these targets are not declared in this project, so no edge is drawn to them";
