/**
 * Per-node live diff (#27). behold shells `chant lifecycle diff <env> --live --json`
 * (chant #852) and slices out one node's drift for the inspect panel.
 *
 * chant classifies each resource by presence (declared vs observed) and, when a
 * previous snapshot exists, by field-level drift since that snapshot. The
 * field-level `changes` (path/oldValue/newValue) are the Argo-style diff; they're
 * only populated for `drifted` resources (a snapshot baseline is required).
 */

export interface AttributeChange {
  path: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface ResourceDrift {
  name: string;
  changes: AttributeChange[];
}

/** Why chant could not read live state for a declared entity (chant#1168,
 * #1089's tri-state observation contract) — reproduced from chant's own
 * `UnobservedReason` (observation.ts). */
export type UnobservedReason = "read-failed" | "no-credentials" | "no-binding" | "unsupported-kind" | "filtered";

/** A declared entity chant could not observe, as reported by `lifecycle diff
 * --live` (chant#1168, #1089) — chant's `UnobservedResource` (live-diff.ts). */
export interface UnobservedResource {
  name: string;
  type?: string;
  reason: UnobservedReason;
  detail?: string;
}

/** Mirror of chant's LiveDiffResult (per lexicon).
 *
 * `unobserved` (chant#1168, #1089) is additive: a chant that predates the
 * fix never emits it, so `missing`/`disappeared` keep meaning "confirmed not
 * there" either way — see `nodeDiff` below for how a node in this list is
 * classified as its own category, distinct from drift or absence. */
export interface LiveDiffResult {
  missing: string[];
  orphan: string[];
  disappeared: string[];
  newlyObserved: string[];
  driftedSinceSnapshot: ResourceDrift[];
  unchanged: string[];
  unobserved?: UnobservedResource[];
}

/** Observed live state of a resource — chant's ResourceMetadata (#862). */
export interface ObservedResource {
  type: string;
  physicalId?: string;
  status: string;
  lastUpdated?: string;
  attributes?: Record<string, unknown>;
  ownership?: "owned" | "foreign";
}

/** Shape of `chant lifecycle diff <env> --live --json`. */
export interface LiveDiffJson {
  environment: string;
  lexicons: Record<
    string,
    { resources?: LiveDiffResult; observed?: Record<string, ObservedResource>; artifacts?: unknown }
  >;
}

export type DiffCategory =
  | "missing" // declared, not in cloud
  | "orphan" // in cloud, not declared
  | "disappeared" // in last snapshot, gone now
  | "newlyObserved" // observed + declared, but no snapshot baseline
  | "drifted" // observed both then and now; fields changed
  | "unchanged"
  | "unobserved"; // declared; chant could not read live state (chant#1168, #1089) — never drift, never absence

export interface NodeDiff {
  category: DiffCategory;
  /** Field-level changes — only non-empty for `drifted` (needs a snapshot). */
  changes: AttributeChange[];
  /** Why chant could not observe this node — set only for `category:
   * "unobserved"` (chant#1168, #1089). */
  unobservedReason?: UnobservedReason;
  unobservedDetail?: string;
}

/** The observed live state of one node, if the diff captured it (#30). Pure. */
export function nodeObserved(json: LiveDiffJson, nodeId: string): ObservedResource | null {
  for (const lex of Object.values(json.lexicons ?? {})) {
    const o = lex.observed?.[nodeId];
    if (o) return o;
  }
  return null;
}

/** Find one node's drift within a parsed live-diff. Returns null if the node
 * isn't in any lexicon's result. Pure — unit-tested. */
export function nodeDiff(json: LiveDiffJson, nodeId: string): NodeDiff | null {
  for (const lex of Object.values(json.lexicons ?? {})) {
    const r = lex.resources;
    if (!r) continue;
    const drift = r.driftedSinceSnapshot?.find((d) => d.name === nodeId);
    if (drift) return { category: "drifted", changes: drift.changes ?? [] };
    // chant#1168 (#1089): a hole in the observation, not drift and not
    // confirmed absence — checked ahead of missing/disappeared below, though
    // chant's own diffLive already keeps the sets disjoint (an unobserved
    // entity is never also reported missing/disappeared).
    const unobserved = r.unobserved?.find((u) => u.name === nodeId);
    if (unobserved) {
      return {
        category: "unobserved",
        changes: [],
        unobservedReason: unobserved.reason,
        ...(unobserved.detail ? { unobservedDetail: unobserved.detail } : {}),
      };
    }
    if (r.missing?.includes(nodeId)) return { category: "missing", changes: [] };
    if (r.orphan?.includes(nodeId)) return { category: "orphan", changes: [] };
    if (r.disappeared?.includes(nodeId)) return { category: "disappeared", changes: [] };
    if (r.newlyObserved?.includes(nodeId)) return { category: "newlyObserved", changes: [] };
    if (r.unchanged?.includes(nodeId)) return { category: "unchanged", changes: [] };
  }
  return null;
}
