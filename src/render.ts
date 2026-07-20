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
export function renderGraph(ir: GraphIR, opts: { theme?: string; boxes?: "byStack"; radial?: boolean } = {}): RenderResult {
  const groups = ir.groups as ExtraGroups;
  const boxKey = groups.byWave ? "byWave" : opts.boxes;
  const boxes = boxKey ? groups[boxKey] : undefined;
  const layout = layoutIr(ir, { fit: true, ...(boxes ? { groups: boxes } : {}) });
  // Radial layout (opt-in): dagre lays a wide DAG out in horizontal ranks that
  // sprawl off-screen. Re-place the same nodes on concentric rings — one ring
  // per rank — so the graph curls around a centre and far more fits in view. Only
  // for ungrouped graphs (the entity/infra view); the wave-boxed component graph
  // keeps its lanes.
  if (opts.radial && !boxes) radializeLayout(layout as unknown as RadialLayout);
  const svg = renderSvg(ir, layout, {
    fit: true,
    hideTitle: true,
    ...(boxes ? { groups: layout.groups } : {}),
    ...(opts.theme ? { theme: opts.theme as never } : {}),
  });
  return { svg };
}

/** Re-place a laid-out graph's nodes on concentric rings by dagre rank (the
 * layout's discrete Y levels), so a wide horizontal DAG becomes a compact radial
 * one. Each ring's radius grows enough to seat its nodes without crowding
 * (circumference ≥ total node width), and rank 0 sits at/near the centre.
 * Mutates `layout.X`/`layout.Y` in place; edges re-anchor to the new centres. */
interface RadialLayout {
  nodes: Array<{ id: string; x: number; y: number }>;
  width: number;
  height: number;
}

/** Typical card width — the layout node carries no per-node size, so use a
 * constant when spacing a ring so neighbours don't overlap. */
const NODE_W = 175;

function radializeLayout(layout: RadialLayout): void {
  const nodes = layout.nodes;
  if (!Array.isArray(nodes) || nodes.length < 3) return;
  // Discrete ranks = distinct y levels (dagre aligns a rank to one y). Cluster
  // near-equal ys to be robust to sub-pixel drift.
  const bucket = (y: number) => Math.round(y / 8) * 8;
  const levels = [...new Set(nodes.map((n) => bucket(n.y)))].sort((a, b) => a - b);
  const rankOf = new Map(levels.map((y, i) => [y, i]));
  const byRank = new Map<number, RadialLayout["nodes"]>();
  for (const n of nodes) {
    const r = rankOf.get(bucket(n.y)) ?? 0;
    (byRank.get(r) ?? byRank.set(r, []).get(r)!).push(n);
  }
  const gap = 60;
  const ringStep = 130;
  let radius = 0;
  for (let r = 0; r < levels.length; r++) {
    const ring = (byRank.get(r) ?? []).sort((a, b) => a.x - b.x); // keep left→right order as angle order
    const n = ring.length;
    // Grow the radius by a fixed ring step, but also enough circumference to
    // seat n nodes without crowding.
    const byCrowd = n <= 1 ? 0 : ((NODE_W + gap) * n) / (2 * Math.PI);
    radius = r === 0 && n === 1 ? 0 : Math.max(radius + ringStep, byCrowd);
    ring.forEach((node, i) => {
      if (radius === 0) {
        node.x = 0;
        node.y = 0;
        return;
      }
      const angle = (i / n) * 2 * Math.PI - Math.PI / 2; // start at top, clockwise
      node.x = radius * Math.cos(angle);
      node.y = radius * Math.sin(angle);
    });
  }
  // Shift to positive coords and reset the bounding box so renderSvg's viewBox
  // wraps the ring cluster, not the old wide extent.
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const pad = NODE_W;
  for (const n of nodes) {
    n.x = n.x - minX + pad;
    n.y = n.y - minY + pad;
  }
  layout.width = Math.max(...xs) - minX + pad * 2;
  layout.height = Math.max(...ys) - minY + pad * 2;
}
