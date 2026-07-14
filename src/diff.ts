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

/** Mirror of chant's LiveDiffResult (per lexicon). */
export interface LiveDiffResult {
  missing: string[];
  orphan: string[];
  disappeared: string[];
  newlyObserved: string[];
  driftedSinceSnapshot: ResourceDrift[];
  unchanged: string[];
}

/** Shape of `chant lifecycle diff <env> --live --json`. */
export interface LiveDiffJson {
  environment: string;
  lexicons: Record<string, { resources?: LiveDiffResult; artifacts?: unknown }>;
}

export type DiffCategory =
  | "missing" // declared, not in cloud
  | "orphan" // in cloud, not declared
  | "disappeared" // in last snapshot, gone now
  | "newlyObserved" // observed + declared, but no snapshot baseline
  | "drifted" // observed both then and now; fields changed
  | "unchanged";

export interface NodeDiff {
  category: DiffCategory;
  /** Field-level changes — only non-empty for `drifted` (needs a snapshot). */
  changes: AttributeChange[];
}

/** Find one node's drift within a parsed live-diff. Returns null if the node
 * isn't in any lexicon's result. Pure — unit-tested. */
export function nodeDiff(json: LiveDiffJson, nodeId: string): NodeDiff | null {
  for (const lex of Object.values(json.lexicons ?? {})) {
    const r = lex.resources;
    if (!r) continue;
    const drift = r.driftedSinceSnapshot?.find((d) => d.name === nodeId);
    if (drift) return { category: "drifted", changes: drift.changes ?? [] };
    if (r.missing?.includes(nodeId)) return { category: "missing", changes: [] };
    if (r.orphan?.includes(nodeId)) return { category: "orphan", changes: [] };
    if (r.disappeared?.includes(nodeId)) return { category: "disappeared", changes: [] };
    if (r.newlyObserved?.includes(nodeId)) return { category: "newlyObserved", changes: [] };
    if (r.unchanged?.includes(nodeId)) return { category: "unchanged", changes: [] };
  }
  return null;
}
