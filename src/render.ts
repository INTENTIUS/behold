/**
 * Painter — behold reuses pinhole's mature SVG painter as a library (pinhole #82).
 * pinhole lays the IR out (dagre, no native dep) and paints it; its `_status`
 * colouring already speaks the overlay vocabulary (managed/foreign/pending), so
 * drift renders the moment chant #821 feeds it. behold owns the live data + the
 * server + (later) the temporal/action layers around this.
 */
import { layoutIr, renderSvg } from "@intentius/pinhole";
import type { GraphIR } from "@intentius/chant";

export interface RenderResult {
  svg: string;
}

/** Paint a graph IR into an SVG document. Title is behold's job (the SPA header),
 * so pinhole's own title band is suppressed. */
export function renderGraph(ir: GraphIR, opts: { theme?: string } = {}): RenderResult {
  const layout = layoutIr(ir, { fit: true });
  const svg = renderSvg(ir, layout, {
    fit: true,
    hideTitle: true,
    ...(opts.theme ? { theme: opts.theme as never } : {}),
  });
  return { svg };
}
