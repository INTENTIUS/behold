/**
 * Painter — behold reuses pinhole's mature SVG painter as a library (pinhole #82).
 * pinhole lays the IR out (dagre, no native dep) and paints it; its `_status`
 * colouring already speaks the overlay vocabulary (managed/foreign/pending), so
 * drift renders the moment chant #821 feeds it. behold owns the live data + the
 * server + (later) the temporal/action layers around this.
 */
import { layoutIr, renderSvg } from "@intentius/pinhole";
import type { GraphIR, IRGroups } from "@intentius/chant";

export interface RenderResult {
  svg: string;
}

/** `groups.byWave` (component DAG, M1.0 spike): wave name → member component ids
 * — the parallel-safe deploy waves. Declared locally because behold's pinned
 * `@intentius/chant` predates the field; a served project's own (newer) chant
 * still emits it on the IR JSON, this just types the read. Drop once behold's
 * chant dependency ships it (spike note: chant 0.18.27+). */
type WaveGroups = IRGroups & { byWave?: Record<string, string[]> };

/** Paint a graph IR into an SVG document. Title is behold's job (the SPA header),
 * so pinhole's own title band is suppressed. When the IR carries `groups.byWave`
 * — chant's component-DAG projection — each wave is drawn as a titled boundary
 * box via pinhole's existing grouped/compound layout (the same mechanism as
 * `byStack` boxes elsewhere): no lane-specific rendering code, behold paints
 * whatever chant hands it. */
export function renderGraph(ir: GraphIR, opts: { theme?: string } = {}): RenderResult {
  const byWave = (ir.groups as WaveGroups).byWave;
  const layout = layoutIr(ir, { fit: true, ...(byWave ? { groups: byWave } : {}) });
  const svg = renderSvg(ir, layout, {
    fit: true,
    hideTitle: true,
    ...(byWave ? { groups: layout.groups } : {}),
    ...(opts.theme ? { theme: opts.theme as never } : {}),
  });
  return { svg };
}
