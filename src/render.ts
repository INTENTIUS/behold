/**
 * Painter — behold reuses pinhole's mature SVG painter as a library (pinhole #82).
 * pinhole lays the IR out (dagre, no native dep) and paints it; its `_status`
 * colouring already speaks the overlay vocabulary (managed/foreign/pending) —
 * chant #821 (source-anchored overlay, shipped 0.18.31) feeds it, see
 * src/overlay.ts. behold owns the live data + the server + (later) the
 * temporal/action layers around this.
 */
import { layoutIr, renderSvg } from "@intentius/pinhole";
import type { GraphIR, IRGroups } from "@intentius/chant";

export interface RenderResult {
  svg: string;
}

/** `groups.byWave` (component DAG, M1.0 spike) and `groups.byStack` (multi-
 * estate composition, #31/M4 — pinhole's `composeStacks` per-project grouping):
 * name → member node ids. Declared locally because behold's pinned
 * `@intentius/chant` predates `byWave`; a served project's own (newer) chant
 * still emits it on the IR JSON, this just types the read. Drop `byWave` once
 * behold's chant dependency ships it (spike note: chant 0.18.27+). */
type ExtraGroups = IRGroups & { byWave?: Record<string, string[]>; byStack?: Record<string, string[]> };

/** Paint a graph IR into an SVG document. Title is behold's job (the SPA header),
 * so pinhole's own title band is suppressed.
 *
 * Boundary boxes, via pinhole's existing grouped/compound layout: when the IR
 * carries `groups.byWave` (chant's component-DAG projection) each wave draws as
 * a titled box, auto-detected — no caller opt-in needed. The multi-estate view
 * (#31/M4, `composeEstate`) wants `groups.byStack` boxed instead (one box per
 * composed project) — deliberately NOT auto-detected the same way, because a
 * single (non-composed) project's own `chant graph` IR also carries a
 * `groups.byStack` field, but there it's a lexicon partition (see
 * src/resources.ts), not a project boundary — auto-boxing it would surprise
 * every M1–M3 view with an unrequested box. A caller that knows it's rendering
 * a composed estate opts in explicitly via `opts.boxes: "byStack"`. */
export function renderGraph(ir: GraphIR, opts: { theme?: string; boxes?: "byStack" } = {}): RenderResult {
  const groups = ir.groups as ExtraGroups;
  const boxKey = groups.byWave ? "byWave" : opts.boxes;
  const boxes = boxKey ? groups[boxKey] : undefined;
  const layout = layoutIr(ir, { fit: true, ...(boxes ? { groups: boxes } : {}) });
  const svg = renderSvg(ir, layout, {
    fit: true,
    hideTitle: true,
    ...(boxes ? { groups: layout.groups } : {}),
    ...(opts.theme ? { theme: opts.theme as never } : {}),
  });
  return { svg };
}
