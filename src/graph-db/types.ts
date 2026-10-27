/**
 * behold#1027: the documents the graph pane loads.
 *
 * Three of them are chant's, imported from the chant release behold depends
 * on (behold#1005 flipped src/chant-release.ts): the engine graph document
 * choudoufu and plunge print (`EngineGraphDocument`, chant#4527, a `GraphIR`
 * at version 1 with `meta.engineGraph`, designed on chant#4520 section 3),
 * the engine facts on its nodes (`EngineFacts`, nested in `facts`, ruled on
 * behold#1025 Q1), and the index document (`IndexDocument`, chant#4519, laid
 * out on behold#1025). The fourth is the cloud lister's `ListingResult`
 * (chant#4532), re-exported from src/graph-db/listing.ts.
 *
 * What stays behold's: the `ambiguous` mark behold#1025 puts on an edge
 * (chant's `IREdge` has no such field) and the three shape guards below.
 */
import type { GraphIR, IREdge, IRNode } from "@intentius/chant";

export type {
  EdgeGrain,
  EngineCloudId,
  EngineFacts,
  EngineGraphDocument,
  EngineGraphMeta,
  EngineGraphScope,
  EngineMarkers,
  EngineRecordVersions,
} from "@intentius/chant/engine-facts";
export type { IndexDocument, IndexScope, IndexStamp } from "@intentius/chant/lifecycle/index-document";
import type { EngineGraphDocument } from "@intentius/chant/engine-facts";
import type { IndexDocument } from "@intentius/chant/lifecycle/index-document";

/** chant's `IRNode`, which carries chant#4527's `facts` and instance fields. */
export type FactNode = IRNode;

/** chant's `IREdge` (with chant#4527's `grain` and behold#1025's origin, rule and relation), plus behold's `ambiguous` mark. */
export interface FactEdge extends IREdge {
  ambiguous?: boolean;
}

/** A `GraphIR` whose edges may carry behold's `ambiguous` mark. */
export interface FactGraph extends Omit<GraphIR, "edges"> {
  edges: FactEdge[];
}

/** Whether `v` is shaped like an engine graph document. */
export function isEngineGraphDocument(v: unknown): v is EngineGraphDocument {
  if (!v || typeof v !== "object") return false;
  const d = v as { version?: unknown; meta?: { engineGraph?: { format?: unknown; engine?: { name?: unknown } } }; nodes?: unknown };
  return d.version === 1 && d.meta?.engineGraph?.format === 1 && typeof d.meta.engineGraph.engine?.name === "string" && Array.isArray(d.nodes);
}

/** Whether `v` is shaped like an index document. */
export function isIndexDocument(v: unknown): v is IndexDocument {
  if (!v || typeof v !== "object") return false;
  const d = v as { index?: unknown; stamp?: { scopeKey?: unknown }; graph?: { nodes?: unknown } };
  return d.index === "v1" && typeof d.stamp?.scopeKey === "string" && Array.isArray(d.graph?.nodes);
}

/** Whether `v` is shaped like the cloud lister's `ListingResult` (behold#1029). */
export function isListingResult(v: unknown): v is import("./listing.ts").ListingResult {
  if (!v || typeof v !== "object") return false;
  const d = v as { listing?: unknown; resources?: unknown; scope?: unknown };
  return d.listing === "v1" && Array.isArray(d.resources) && !!d.scope && typeof d.scope === "object";
}
