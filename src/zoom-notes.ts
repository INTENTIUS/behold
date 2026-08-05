/**
 * Why a zoom level rendered what it rendered (#131).
 *
 * Four of the six levels can legitimately produce a picture that is either
 * empty or identical to the level below, and until now none of them said so.
 * A user stepping through the picker saw the same view repeatedly and read the
 * control as stuck — which is how #131 was reported.
 *
 * None of these are errors. `logical` on a k8s estate is correctly empty (#74,
 * the projection's headline kinds are AWS-only) and `composites` with no
 * component ownership is correctly the resource graph. The defect is silence,
 * so this module produces one short line saying which of those happened, and
 * `renderStatusbar()` in web/app.js puts it beside the zoom name that caused
 * it.
 *
 * Deliberately not a `RouteError` (src/server.ts): those replace the canvas
 * with a card, and are for a view that could not be produced at all. These
 * views were produced and are honest; they just need a caption.
 *
 * Every function is pure and takes the finished IR, so a note describes what
 * was actually rendered rather than what the request asked for. Nothing here
 * infers intent from query parameters.
 */

/** The finished graph a note is written about — only the parts a note reads. */
export interface NotableGraph {
  nodes: unknown[];
  edges: unknown[];
  groups?: { byContainer?: Record<string, string[]> };
}

/** Which zoom produced the graph. Mirrors web/app.js's `ZOOM_OPTS` values. */
export type Zoom = "components" | "logical" | "composites" | "resources" | "attributes" | "runtime";

/**
 * The note for a rendered graph, or `undefined` when the view is unremarkable.
 *
 * `composites` is the one that needs a second input: it is *defined* as the
 * resource graph plus the component DAG's `dependsOn` edges, so "did any get
 * attached" is the question, and that is not visible from the finished IR
 * alone — an estate can legitimately have zero edges either way (#84).
 */
export function zoomNote(zoom: Zoom, ir: NotableGraph, compositeEdgesAttached?: number): string | undefined {
  const empty = ir.nodes.length === 0;

  if (zoom === "components") {
    return empty ? "no components discovered — nothing declares one in this project" : undefined;
  }

  if (zoom === "logical") {
    // #74: src/logical.ts's headline kinds are literal `AWS::*`, so a project
    // with no AWS resources matches nothing. Correct, and indistinguishable
    // from a broken lens without saying it.
    return empty ? "logical is an AWS projection — no AWS resources in this estate" : undefined;
  }

  if (zoom === "composites") {
    // Attached edges are what makes this level different from `resources`.
    // Zero means the component→node mapping found nothing to join (#138), so
    // the user is looking at the resource graph under a different name.
    return compositeEdgesAttached === 0
      ? "no component ownership to join — showing the resource graph unchanged"
      : undefined;
  }

  if (zoom === "runtime") {
    const boxes = Object.keys(ir.groups?.byContainer ?? {}).length;
    return boxes === 0
      ? "nothing below the declaration boundary — no owner-referenced children on this substrate"
      : undefined;
  }

  return undefined;
}

/**
 * A second note, orthogonal to the zoom: an estate whose nodes relate to
 * nothing.
 *
 * A graph with nodes and no edges lays out as a single flat row, which reads
 * as a broken renderer rather than as an accurate picture of a project that
 * declares no references. Worth saying once, on the levels where an edge would
 * have been drawn if there were any.
 *
 * `components` and `logical` are exempt: the first draws its own DAG and the
 * second lays itself out as nested boxes, so neither is judged on edge count.
 */
export function edgelessNote(zoom: Zoom, ir: NotableGraph): string | undefined {
  if (zoom === "components" || zoom === "logical") return undefined;
  if (ir.nodes.length === 0 || ir.edges.length > 0) return undefined;
  return "no edges — nothing in this estate references anything else";
}

/** Both notes for a view, in reading order, joined for a one-line statusbar. */
export function notesFor(
  zoom: Zoom,
  ir: NotableGraph,
  compositeEdgesAttached?: number,
): string | undefined {
  const notes = [zoomNote(zoom, ir, compositeEdgesAttached), edgelessNote(zoom, ir)].filter(
    (n): n is string => n !== undefined,
  );
  return notes.length ? notes.join(" · ") : undefined;
}
