/**
 * Source-anchored overlay — the seam behold's spatial view depends on.
 *
 * VERIFIED in chant core (2026-07): cross-substrate edges (an ECS service wired to
 * a GKE workload) are a **source-graph** property — `buildGraphIr` composes all
 * lexicons' AttrRefs into direct edges. But `chant graph --live --overlay` returns
 * the *live* graph's edges (per-substrate islands, reconstructed by identifier
 * value-match) and appends declared "pending" nodes edgeless. So overlay today
 * gives drift status but flattens the cross-substrate topology.
 *
 * behold needs the inverse: **declared edges as the canvas** (keep the cross-
 * substrate wiring) + live status/ownership joined per node by id + foreign live
 * nodes appended. That is chant #821 (a new core function beside `overlayGraphs`).
 *
 * Until #821 lands, behold's server renders the **source** graph (which already
 * carries the mixed-substrate edges — the read-only mixed-graph, provable today).
 * When #821 ships, swap the server's `graphIr` call for the source-anchored
 * overlay and colour nodes by `_status` (good=managed / warn=foreign /
 * accent=pending) — the pinhole painter already reads that tag (pinhole #80).
 */
import type { GraphIR } from "@intentius/chant";

/** Overlay status a renderer colours (mirrors chant `overlayGraphs` `_status`). */
export type OverlayStatus = "managed" | "foreign" | "pending";

/** Read the overlay status a node carries, if any (from chant's `_status` tag). */
export function overlayStatus(node: { attrs?: Record<string, unknown> }): OverlayStatus | undefined {
  const s = node.attrs?._status;
  if (s === "good") return "managed";
  if (s === "warn") return "foreign";
  if (s === "accent") return "pending";
  return undefined;
}

/** Placeholder until chant #821. A client-side join of a live IR onto a declared
 * IR — kept declared-anchored so cross-substrate edges survive — is a stopgap the
 * server could use before the core primitive exists. Not implemented yet on
 * purpose: doing it right belongs in core, where both IRs are already in hand. */
export function sourceAnchoredOverlay(_declared: GraphIR, _live: GraphIR): GraphIR {
  throw new Error("source-anchored overlay not implemented — tracked as chant #821");
}
