/**
 * Source-anchored overlay — the seam behold's spatial view depends on.
 *
 * SHIPPED (M4): chant #821 landed in chant core as `sourceOverlayGraphs`
 * (chant 0.18.31) and is the DEFAULT anchor for `chant graph --live --overlay`
 * (`--overlay-anchor=live` opts back into the older `overlayGraphs` behaviour).
 * The declared graph is the canvas, so cross-substrate edges (an ECS service
 * wired to a GKE workload) survive — that wiring is a source-graph property,
 * since live reconstruction is per-substrate (identifier value-match) and never
 * crosses providers. Each declared node is classified against live observation
 * and tagged `_status` (good=managed / accent=pending); provisioned-but-
 * undeclared resources are appended as `warn` (foreign), with any live edges
 * that touch them.
 *
 * behold does none of this joining itself — `src/chant.ts`'s `graphIr()` just
 * passes `--live --overlay` through to the project's own chant, and the join
 * lives entirely in chant core. This module's only job is reading the `_status`
 * tag chant paints (below) so pinhole's painter, which already speaks this
 * vocabulary (pinhole #80), colours the node. Verified end-to-end against
 * loomster on Floci: `chant graph src --live --overlay --env local --format ir`
 * returns 132 nodes / 65 edges, `_status` good/accent (no foreign nodes on a
 * clean deploy) — see docs/roadmap/m1-cli-notes.md for the M1-era state this
 * superseded (Q2 there predates the #821 core fix and the multi-stack
 * `describeResources` fix that shipped alongside it in 0.18.31).
 */

/** Overlay status a renderer colours (mirrors chant `sourceOverlayGraphs`/
 * `overlayGraphs` `_status`). */
export type OverlayStatus = "managed" | "foreign" | "pending";

/** Read the overlay status a node carries, if any (from chant's `_status` tag). */
export function overlayStatus(node: { attrs?: Record<string, unknown> }): OverlayStatus | undefined {
  const s = node.attrs?._status;
  if (s === "good") return "managed";
  if (s === "warn") return "foreign";
  if (s === "accent") return "pending";
  return undefined;
}

interface OverlayNode {
  id: string;
  kind: string;
  sourceLoc?: { file?: string };
  attrs?: Record<string, unknown>;
}

/** The `src/<component>/` a node is declared under, or undefined for a bare
 * `src/<file>`, a non-src path, or `src/examples/…` (examples aren't a
 * component). Mirrors resources.ts's convention. */
function componentDir(node: OverlayNode): string | undefined {
  const parts = node.sourceLoc?.file?.split("/") ?? [];
  if (parts[0] !== "src" || parts[1] === "examples" || parts.length < 3) return undefined;
  return parts[1];
}

/** Fix up an overlay IR's `_status` so the infra graph stops painting deployment
 * *wiring* and *examples* as "pending" (accent) when the deployment is actually
 * done — chant's overlay marks any declared node with no matching live resource
 * as pending, but two kinds of node aren't resources at all:
 *
 *   - **CloudFormation Parameters** are cross-stack inputs, resolved at build
 *     time (loomster seeds them), so they never exist as a live resource — yet
 *     they ARE part of the deployment, declared under their component
 *     (`src/<component>/params.ts`). Give a Parameter its component's status:
 *     if that component has any managed resource, the Parameter is part of a
 *     deployed stack → managed, not pending.
 *
 *   - **`src/examples/` nodes** are byo scaffolding, never deployed here.
 *     "pending" reads as "about to deploy," which is wrong — tag them `_byo`
 *     and clear the status so they render neutral (an example, not drift).
 *
 * Mutates + returns `ir`. Pure w.r.t. I/O — a display reclassification, not a
 * re-observation. */
export function reclassifyOverlay<T extends { nodes: OverlayNode[] }>(ir: T): T {
  const deployedComponents = new Set<string>();
  for (const n of ir.nodes) {
    if (n.attrs?._status === "good") {
      const c = componentDir(n);
      if (c) deployedComponents.add(c);
    }
  }
  for (const n of ir.nodes) {
    const file = n.sourceLoc?.file ?? "";
    if (file.startsWith("src/examples/")) {
      n.attrs = { ...n.attrs, _byo: true };
      delete n.attrs._status; // neutral — an example, not pending drift
    } else if (n.kind === "AWS::CloudFormation::Parameter") {
      const c = componentDir(n);
      if (c && deployedComponents.has(c)) {
        n.attrs = { ...n.attrs, _status: "good" }; // wiring of a deployed component — part of the deployment
      }
    }
  }
  return ir;
}
