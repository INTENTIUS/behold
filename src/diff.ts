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

/** A live, undeclared resource whose owner-reference chain reaches a declared
 * entity (chant#1180, #1077) — chant's `RuntimeChildResource` (live-diff.ts).
 * A Pod a declared Deployment's controller created, for instance: expected
 * runtime, not drift, never a delete/adopt candidate. */
export interface RuntimeChildResource {
  name: string;
  type: string;
  /** The declared chant entity this resource's owner chain resolves to. */
  owner: string;
}

/** Mirror of chant's LiveDiffResult (per lexicon).
 *
 * `unobserved` (chant#1168, #1089) is additive: a chant that predates the
 * fix never emits it, so `missing`/`disappeared` keep meaning "confirmed not
 * there" either way — see `nodeDiff` below for how a node in this list is
 * classified as its own category, distinct from drift or absence.
 *
 * `runtimeChildren` (chant#1180, #1077) is additive the same way: a chant
 * predating it never emits the field, and `orphan` already excludes anything
 * with a resolved owner chain on the chant side, so nothing here changes the
 * meaning of `orphan` for an older chant either. */
export interface LiveDiffResult {
  missing: string[];
  orphan: string[];
  disappeared: string[];
  newlyObserved: string[];
  driftedSinceSnapshot: ResourceDrift[];
  unchanged: string[];
  unobserved?: UnobservedResource[];
  runtimeChildren?: RuntimeChildResource[];
}

/** How one property differs between the declared and live trees — chant's
 * `PropertyDriftKind` (lifecycle/deep-diff.ts), part of the deep-observation
 * row (#1014; k8s via managed-fields pruning, #1076/#1181).
 *
 * - `changed` — declared and live both have the path, with different values.
 *   This is drift chant should act on whether the field is purely chant's own
 *   or *contested* (a foreign manager also currently holds it): chant's own
 *   pruning rule already excludes a confidently foreign-owned, undeclared
 *   field before this ever runs (#1181), so anything reaching `changed` is a
 *   deviation from what chant's OWN source declared.
 * - `undeclared` — live has the path, chant's source never declared it. On a
 *   substrate with managed-fields pruning, a confidently foreign-owned field
 *   never reaches here at all — it's dropped before the diff runs — so an
 *   `undeclared` entry is either an ambiguous-ownership field #1181
 *   deliberately left diffable, or a substrate with no pruning at all either
 *   way. Read as "foreign" — present live, chant's source says nothing about
 *   it — distinct from `changed`'s "chant said X, live says Y".
 * - `absent` — chant's source declares the path, the live tree doesn't carry
 *   it (weaker — a lexicon's own hook may already subtract provider defaults
 *   here).
 *
 * chant's own wire contract does not carry a field-manager NAME (which
 * manager currently owns a path) — only these three kinds, which is the
 * closest real signal to "chant-owned vs foreign vs contested" available
 * today; see `nodeFieldDrift` below for how this maps to the inspect panel. */
export type PropertyDriftKind = "changed" | "undeclared" | "absent";

/** One property-level difference — chant's `PropertyDrift` (lifecycle/deep-diff.ts). */
export interface PropertyDrift {
  path: string;
  kind: PropertyDriftKind;
  /** Value in source. Absent for `undeclared`. */
  declared?: unknown;
  /** Value in the live tree. Absent for `absent`. */
  live?: unknown;
  /** The accepted baseline value, when this path has one. */
  baseline?: unknown;
  /**
   * The field manager that owns this path live (chant#1189) — Kubernetes'
   * `managedFields`, and nowhere else today, so absent on every other
   * substrate.
   *
   * This is the half `kind` cannot carry. `spec.replicas` changed by
   * `hpa-controller` and by `kubectl-client-side-apply` are both `changed` and
   * mean opposite things: a controller doing its job, versus somebody editing
   * around the pipeline. #87 exists because colour alone cannot say which.
   */
  owner?: string;
}

/** Property-level drift for one declared entity — chant's `DeepEntityDrift`
 * (lifecycle/deep-diff.ts). */
export interface DeepEntityDrift {
  name: string;
  type: string;
  changes: PropertyDrift[];
}

/** Property-level (field-by-field) live diff for one lexicon — chant's
 * `DeepDiffResult` (lifecycle/deep-diff.ts), present only for a lexicon whose
 * plugin implements the deep-observation reader (#1014; k8s via managed-fields
 * pruning, #1076/#1181). Wholly additive and absent for a lexicon (or a chant)
 * with no deep reader — #87's acceptance criterion that objects without
 * per-field ownership fall back to whole-object colouring, unchanged. */
export interface DeepDiffResult {
  /** Entities with at least one reportable property difference. */
  drifted: DeepEntityDrift[];
  /** Differences suppressed by the accepted baseline. */
  accepted: DeepEntityDrift[];
  /** Entities whose property trees matched exactly. */
  unchanged: string[];
  /** Declared entities whose *properties* could not be read — independent of
   * the thin `unobserved` above; a deep hole is a hole in the property
   * surface, not a claim about existence. */
  unobserved: UnobservedResource[];
  /** Entities the deep reader returned that were never declared. */
  undeclaredEntities: string[];
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

/** Shape of `chant lifecycle diff <env> --live --json`. `deep` (#1014;
 * chant#1181 for k8s) is additive — present only for a lexicon whose plugin
 * implements the deep-observation reader. */
export interface LiveDiffJson {
  environment: string;
  lexicons: Record<
    string,
    { resources?: LiveDiffResult; observed?: Record<string, ObservedResource>; artifacts?: unknown; deep?: DeepDiffResult }
  >;
}

export type DiffCategory =
  | "missing" // declared, not in cloud
  | "orphan" // in cloud, not declared
  | "disappeared" // in last snapshot, gone now
  | "newlyObserved" // observed + declared, but no snapshot baseline
  | "drifted" // observed both then and now; fields changed
  | "unchanged"
  | "unobserved" // declared; chant could not read live state (chant#1168, #1089) — never drift, never absence
  | "runtime"; // live, undeclared, owner chain reaches a declared entity (chant#1180, #1077) — never drift, never orphan

export interface NodeDiff {
  category: DiffCategory;
  /** Field-level changes — only non-empty for `drifted` (needs a snapshot). */
  changes: AttributeChange[];
  /** Why chant could not observe this node — set only for `category:
   * "unobserved"` (chant#1168, #1089). */
  unobservedReason?: UnobservedReason;
  unobservedDetail?: string;
  /** The declared entity this node's owner chain resolves to — set only for
   * `category: "runtime"` (chant#1180, #1077). */
  runtimeOwner?: string;
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
    // chant#1180 (#1077): a live, undeclared resource whose owner chain
    // reaches a declared entity — expected runtime, never orphan/drift.
    // chant's own `diffLive` already keeps this disjoint from `orphan`, but
    // check first regardless, same defensive posture as `unobserved` above.
    const runtimeChild = r.runtimeChildren?.find((rc) => rc.name === nodeId);
    if (runtimeChild) return { category: "runtime", changes: [], runtimeOwner: runtimeChild.owner };
    if (r.missing?.includes(nodeId)) return { category: "missing", changes: [] };
    if (r.orphan?.includes(nodeId)) return { category: "orphan", changes: [] };
    if (r.disappeared?.includes(nodeId)) return { category: "disappeared", changes: [] };
    if (r.newlyObserved?.includes(nodeId)) return { category: "newlyObserved", changes: [] };
    if (r.unchanged?.includes(nodeId)) return { category: "unchanged", changes: [] };
  }
  return null;
}

/** One node's field-level (deep) drift — chant's `PropertyDrift[]`, sliced
 * from `lifecycle diff --live --json`'s additive `deep` section (#87,
 * chant#1076/#1181). */
export interface NodeFieldDrift {
  /** Property differences chant reports as real drift for this entity. */
  drifted: PropertyDrift[];
  /** Property differences suppressed by the accepted baseline. */
  accepted: PropertyDrift[];
}

/** Find one node's field-level drift within a parsed live-diff (#87). Returns
 * `null` when NO lexicon in this diff carries a `deep` section at all — a
 * lexicon with no deep reader, or a chant predating #1014/#1181 — which is
 * exactly #87's acceptance criterion that an object without per-field
 * ownership falls back to whole-object colouring, unchanged. An entity a deep
 * reader looked at but found nothing to report on gets `{ drifted: [],
 * accepted: [] }`, not `null` — deep data exists for this substrate, this
 * entity just has none. Pure — unit-tested. */
export function nodeFieldDrift(json: LiveDiffJson, nodeId: string): NodeFieldDrift | null {
  let sawDeep = false;
  for (const lex of Object.values(json.lexicons ?? {})) {
    const deep = lex.deep;
    if (!deep) continue;
    sawDeep = true;
    const drifted = deep.drifted.find((e) => e.name === nodeId)?.changes;
    const accepted = deep.accepted.find((e) => e.name === nodeId)?.changes;
    if (drifted || accepted) return { drifted: drifted ?? [], accepted: accepted ?? [] };
    if (deep.unchanged.includes(nodeId)) return { drifted: [], accepted: [] };
  }
  return sawDeep ? { drifted: [], accepted: [] } : null;
}
