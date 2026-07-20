/**
 * Painter — behold reuses pinhole's mature SVG painter as a library (pinhole #82).
 * pinhole lays the IR out (dagre, no native dep) and paints it; its `_status`
 * colouring already speaks the overlay vocabulary (managed/foreign/pending) —
 * chant #821 (source-anchored overlay, shipped 0.18.31) feeds it, see
 * src/overlay.ts. behold owns the live data + the server + (later) the
 * temporal/action layers around this.
 */
import { layoutIr, layoutArchitecture, renderSvg } from "@intentius/pinhole";
import type { GraphIR, IRGroups } from "@intentius/chant";
import type { ByContainer } from "./logical.ts";

export interface RenderResult {
  svg: string;
}

/** Paint the logical/architecture view (#63) — pinhole's `layoutArchitecture`
 * (chant#74) nests the resource cards inside their container boxes (VPC ⊃ subnet
 * ⊃ component ⊃ resource, per `byContainer`) and routes the surviving edges
 * between them; `renderSvg` paints the nested boundary boxes. behold's own title
 * band is suppressed (the SPA header owns it). */
export function renderArchitecture(ir: GraphIR, byContainer: ByContainer, opts: { theme?: string } = {}): RenderResult {
  const layout = layoutArchitecture(ir, byContainer, { fit: true });
  const svg = renderSvg(ir, layout, {
    fit: true,
    hideTitle: true,
    groups: layout.groups,
    ...(opts.theme ? { theme: opts.theme as never } : {}),
  });
  return { svg };
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
  if (opts.radial && !boxes) radializeLayout(layout as unknown as RadialLayout, groupKeyByNode(ir));
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

/** Group key per node id — the `src/<component>/` a node is declared under, with
 * `src/examples/…` folded to "examples" and non-src nodes bucketed by lexicon.
 * This is the grouping the radial layout clusters into wedges. */
function groupKeyByNode(ir: GraphIR): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of ir.nodes) {
    const parts = (n.sourceLoc?.file ?? "").split("/");
    let key: string;
    if (parts[0] === "src" && parts[1] === "examples") key = "examples";
    else if (parts[0] === "src" && parts.length >= 3) key = parts[1];
    else key = n.lexicon || "other";
    out.set(n.id, key);
  }
  return out;
}

/** Re-place a laid-out graph's nodes radially, CLUSTERED BY GROUP: each group
 * (component) gets a contiguous angular wedge sized to its node count, and
 * within a wedge nodes sit by dependency depth (dagre rank → radius) fanned
 * across the wedge's angle. So each pie-slice is a component (real structure,
 * not the old even/false symmetry), a component's edges stay local to its wedge
 * (less crossing), and the frontend can label each wedge from node positions.
 * Mutates node x/y and the layout bounds. */
function radializeLayout(layout: RadialLayout, groupOf: Map<string, string>): void {
  const nodes = layout.nodes;
  if (!Array.isArray(nodes) || nodes.length < 3) return;

  // Global dagre rank (distinct y levels) orders nodes inner→outer by dependency
  // depth; exact radius is decided by the arc-packing below so nothing overlaps.
  const bucket = (y: number) => Math.round(y / 8) * 8;
  const levels = [...new Set(nodes.map((n) => bucket(n.y)))].sort((a, b) => a - b);
  const rankOf = new Map(levels.map((y, i) => [y, i]));
  // Inner radius large enough that even the narrowest wedges' innermost nodes
  // clear each other angularly (r0 · min angular separation ≳ card width).
  const r0 = 380;

  // Nodes by group; wedge order is stable (by key) so the picture doesn't jump.
  const groups = new Map<string, RadialLayout["nodes"]>();
  for (const n of nodes) {
    const k = groupOf.get(n.id) ?? "other";
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(n);
  }
  const order = [...groups.keys()].sort();
  const gapAngle = 0.08; // radians between wedges
  const usable = 2 * Math.PI - gapAngle * order.length;
  // Floor every wedge at a minimum width so a tiny (1–2 node) component still
  // gets a readable slice and its inner node clears its neighbours; the rest of
  // the circle is shared out proportionally by node count.
  const minWidth = Math.min(0.4, (usable / order.length) * 0.7);
  const flexible = usable - minWidth * order.length;

  // Pack each wedge's nodes into concentric arcs (collision detection): fill an
  // arc only to the count its circumference can seat — arc length (radius·width)
  // ≥ (NODE_W+gap) per node — then step outward. So nodes never overlap
  // angularly (capacity bound) OR radially (rowStep ≥ card height). Nodes are
  // ordered by dependency depth (rank) then x, so inner arcs read as upstream.
  const gap = 55;
  // Radially-adjacent arcs stack at the same angle in a 1-node-wide wedge; their
  // separation must exceed the card WIDTH (not height) or a horizontally-oriented
  // wedge overlaps in x. Geometry: rowStep > NODE_W means no angle can put a pair
  // within both the card's width AND height. (This, not the relaxation, was the
  // main source of residual overlaps.)
  const rowStep = 190;
  let angle = -Math.PI / 2; // first wedge starts at top
  for (const key of order) {
    const gnodes = groups
      .get(key)!
      .slice()
      .sort((a, b) => (rankOf.get(bucket(a.y)) ?? 0) - (rankOf.get(bucket(b.y)) ?? 0) || a.x - b.x);
    const width = minWidth + flexible * (gnodes.length / nodes.length);
    const start = angle;
    let radius = r0;
    let i = 0;
    while (i < gnodes.length) {
      const capacity = Math.max(1, Math.floor((radius * width) / (NODE_W + gap)));
      const arc = gnodes.slice(i, i + capacity);
      const c = arc.length;
      arc.forEach((n, j) => {
        const a = c === 1 ? start + width / 2 : start + width * ((j + 0.5) / c);
        n.x = radius * Math.cos(a);
        n.y = radius * Math.sin(a);
      });
      radius += rowStep;
      i += capacity;
    }
    angle = start + width + gapAngle;
  }

  // Second pass — box-overlap relaxation. Arc-packing clears intra-wedge crowding
  // but two cards from neighbouring wedges (or arcs) can still overlap at a seam.
  // Iteratively separate any pair whose card rectangles intersect, pushing along
  // the axis of least penetration (the cheapest nudge). Converges fast for the
  // node counts here; capped so it always terminates.
  const cardW = NODE_W + 45; // generous target margin so even a jammed pair that
  const cardH = 104; //         only partly separates still clears the real footprint
  // Break exact symmetry deterministically (no RNG available) so a node caught
  // between two neighbours never sits at a frustrated fixed point where opposing
  // pushes cancel — otherwise separation stalls with a few residual overlaps.
  nodes.forEach((n, k) => {
    n.x += (((k * 13) % 7) - 3) * 0.4;
    n.y += (((k * 7) % 5) - 2) * 0.4;
  });
  for (let iter = 0; iter < 2500; iter++) {
    let overlaps = 0;
    // In-place (Gauss-Seidel): each resolved pair is seen by the next, which
    // moves a squeezed middle node instead of leaving it stuck.
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const dx = nodes[b].x - nodes[a].x;
        const dy = nodes[b].y - nodes[a].y;
        const ox = cardW - Math.abs(dx); // >0 ⟺ x-ranges overlap
        const oy = cardH - Math.abs(dy); // >0 ⟺ y-ranges overlap
        if (ox <= 0 || oy <= 0) continue; // rectangles clear
        overlaps++;
        // Push along the centre-to-centre line by half the penetration. Unlike a
        // min-axis (MTV) push, this doesn't flip axes and oscillate when a pair
        // overlaps near a corner (ox ≈ oy) — the case that left residual overlaps.
        const d = Math.hypot(dx, dy) || 0.01;
        const push = Math.min(ox, oy) * 0.75 + 2; // over-relax to escape local jams
        const ux = dx / d;
        const uy = dy / d;
        nodes[a].x -= ux * push;
        nodes[a].y -= uy * push;
        nodes[b].x += ux * push;
        nodes[b].y += uy * push;
      }
    }
    if (overlaps === 0) break;
  }

  // Shift to positive coords + reset bounds so renderSvg's viewBox wraps the disc.
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
