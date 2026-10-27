/**
 * behold#1027: the documents the graph pane loads, held structurally.
 *
 * Three of them are chant's (INTENTIUS/chant#4527, on chant's
 * integration/consolidation-graph, not yet on npm): the engine graph document
 * choudoufu and plunge print (`EngineGraphDocument`, a `GraphIR` at version 1
 * with `meta.engineGraph`, designed on chant#4520 section 3), the engine facts
 * on its nodes (`EngineFacts`, nested in `facts`, ruled on behold#1025 Q1), and
 * the index document (`IndexDocument`, chant#4519, laid out on behold#1025).
 * The fourth is behold's own: the cloud lister's `ListingResult`
 * (src/cloud-lister/types.ts, behold#1029).
 *
 * behold must build against published chant, and the published `IRNode` and
 * `IREdge` have no `facts`, `grain` or instance fields yet. So these are local
 * copies of chant's shapes, every field optional where chant's is, and a
 * reader that does not find a field reads it as unknown.
 *
 * TODO(behold#1027, chant#4527): once the chant release that carries
 * `@intentius/chant`'s `EngineFacts`, `EngineGraphDocument` and
 * `IndexDocument` is published, flip src/chant-release.ts's switch and make
 * this file re-export chant's types instead (the same swap
 * src/cloud-lister/types.ts names for the listing types).
 */
import type { GraphIR, IREdge, IRNode } from "@intentius/chant";

/** chant#4527 `EngineCloudId`. */
export interface EngineCloudId {
  kind: "import-id" | "arn" | "provider-id" | "self-link" | "k8s-uid";
  value: string;
}

/** chant#4527 `EngineMarkers`. */
export interface EngineMarkers {
  owner?: string;
  address?: string;
  encoding: "plain" | "escaped" | "digest";
  source: "live" | "record";
}

/** chant#4527 `EngineRecordVersions`. */
export interface EngineRecordVersions {
  kept: boolean;
  versions: Array<{ id: string; writtenAt: string; current: boolean; deleted: boolean }>;
}

/** chant#4527 `EngineFacts`: what an ownership engine observed about one node. Never read for a decision. */
export interface EngineFacts {
  ownership?: "bound" | "unowned" | "pending" | "foreign";
  markers?: EngineMarkers;
  ownedBy?: "marker" | "record" | "name";
  cloudIds?: EngineCloudId[];
  recordVersions?: EngineRecordVersions;
  observedAt?: string;
}

/** chant#4527 `EdgeGrain`. */
export type EdgeGrain = "block" | "instance" | "property";

/** A published `IRNode` plus the fields chant#4527 adds. */
export interface FactNode extends IRNode {
  facts?: EngineFacts;
  instanceOf?: string;
  instanceKey?: string;
  instanceScope?: string;
}

/** A published `IREdge` plus chant#4527's `grain` and behold#1025's edge fields. */
export interface FactEdge extends IREdge {
  grain?: EdgeGrain;
  origin?: "declared" | "observed" | "derived";
  rule?: string;
  relation?: "reference" | "containment";
  ambiguous?: boolean;
}

/** A `GraphIR` whose nodes and edges may carry the fields above. */
export interface FactGraph extends Omit<GraphIR, "nodes" | "edges"> {
  nodes: FactNode[];
  edges: FactEdge[];
}

/** chant#4527 `EngineGraphScope`. */
export type EngineGraphScope = { kind: "estate"; estate: string } | { kind: "stack"; project: string; stack: string };

/** chant#4527 `EngineGraphMeta`, `meta.engineGraph` on an engine graph document. */
export interface EngineGraphMeta {
  format: 1;
  engine: { name: string; version?: string };
  scope: EngineGraphScope;
  /** When the read started. behold prints it as the "read at" line (chant#4520 section 5). */
  observedAt?: string;
  markerScheme?: {
    ownerKey: string;
    addressKey: string;
    continuationKeys?: string[];
    encoding: { tags: "plain" | "escaped" | "digest"; labels: "plain" | "escaped" | "digest" };
  };
  gaps?: Array<{ address: string; reason: string; detail?: string }>;
}

/** chant#4527 `EngineGraphDocument`: what `choudoufu live-graph -json` and `plunge graph --json` print. */
export interface EngineGraphDocument extends Omit<FactGraph, "version" | "meta"> {
  version: 1;
  meta: { engineGraph: EngineGraphMeta; [key: string]: unknown };
}

/** chant#4519 `IndexScope`, the three kinds. */
export type IndexScope =
  | {
      kind: "cloud";
      substrate: "aws" | "azure" | "gcp" | "kubernetes";
      scopeId: string;
      locations: readonly string[] | "*";
      types: readonly string[] | "*";
      tagFilter?: Readonly<Record<string, string>>;
    }
  | { kind: "engine"; engine: string; estate?: string; project?: string; stack?: string; backend?: string }
  | { kind: "chant"; member: string; env: string; stack?: string; lexicon: string };

/** chant#4519 `IndexStamp`. */
export interface IndexStamp {
  source: { kind: "cloud" | "engine" | "chant"; name: string; version?: string };
  scope: IndexScope;
  scopeKey: string;
  observedAt: string;
  completedAt?: string;
  commit?: string;
  digest: string;
}

/** chant#4519 `IndexDocument`: one immutable index version. */
export interface IndexDocument {
  index: "v1";
  stamp: IndexStamp;
  coverage: Array<{ listedType: string; location: string; verdict: string; detail?: string }>;
  graph: FactGraph;
  notes?: Array<{ kind?: string; code?: string; message: string; listedType?: string; location?: string }>;
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
export function isListingResult(v: unknown): v is import("../cloud-lister/types.ts").ListingResult {
  if (!v || typeof v !== "object") return false;
  const d = v as { listing?: unknown; resources?: unknown; scope?: unknown };
  return d.listing === "v1" && Array.isArray(d.resources) && !!d.scope && typeof d.scope === "object";
}
