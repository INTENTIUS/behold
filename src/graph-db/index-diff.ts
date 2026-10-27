/**
 * behold#1028: what changed between two reads of one index scope.
 *
 * A pure function over two index versions (chant#4519's `IndexDocument`, laid
 * out on behold#1025): nodes added and removed, properties changed, edges
 * added and removed. It reads nothing and writes nothing.
 *
 * This module imports nothing from the rest of behold, so it can move into
 * chant unchanged (the maintainer's constraint on behold#1028: behold stays a
 * control plane and chant defines the models). Its shapes are structural
 * copies of chant's `IndexDocument`, `CoverageEntry`, `IRNode` and `IREdge`,
 * every field optional where chant's is.
 *
 * chant has no diff for two observed reads to reuse. Its deep diff
 * (packages/core/src/lifecycle/deep-diff.ts) compares a declared tree against
 * a live one, and a path present on one side only is "unclaimed" there, not a
 * change. Between two reads both sides are observed, so the comparison here
 * is symmetric.
 *
 * Rules:
 *
 *  - One scope per diff (behold#1025 Q6: one version per run). Two versions
 *    whose `stamp.scopeKey` differ are refused by name with
 *    {@link IndexScopeMismatch}: a node missing from one could just be out
 *    of its scope.
 *  - A node is reported removed only when the later read listed its
 *    (type, location). Otherwise it is "not observed" in that read, with the
 *    coverage verdict that says why (the observation contract, chant#1089).
 *    The same holds the other way: a node is added only when the earlier
 *    read listed its (type, location); otherwise it is "first observed".
 *    Coverage is looked up per (type, location), where `"*"` matches every
 *    type or every location; the lookup is chant's `indexCoverageFor`,
 *    passed in by the caller when the installed chant has it, else
 *    {@link coverageForFallback}, which applies the same rule.
 *  - An edge is removed (or added) only when both its ends were observed in
 *    the read that lacks it. An edge whose end sits in an unobserved
 *    (type, location) is "not observed".
 *  - Properties: `kind`, and each leaf path of `attrs` (arrays compare as
 *    whole values). `tags` is compared only for a node whose `attrs` show no
 *    change, because the lister's tags are a projection of the listed
 *    properties: one tag edit is then one changed property, not two.
 *    `facts` is never compared (its `observedAt` moves on every read, and
 *    facts are never read for a decision).
 *  - Two versions with the same `stamp.digest` hold the same graph and
 *    coverage, so the diff is empty and nothing is walked.
 */

/** chant#4519 `CoverageEntry`. */
export interface DiffCoverageEntry {
  listedType: string;
  location: string;
  verdict: string;
  detail?: string;
}

/** The parts of an index node the diff reads. */
export interface DiffNode {
  id: string;
  kind: string;
  lexicon?: string;
  attrs?: Record<string, unknown>;
  tags?: Record<string, string>;
  listedType?: string;
  location?: string;
  nativeId?: string;
  physicalId?: string;
}

/** The parts of an index edge the diff reads. */
export interface DiffEdge {
  from: string;
  to: string;
  kind?: string;
  viaAttr?: string;
  relation?: string;
  origin?: string;
  rule?: string;
}

/** The parts of an index version the diff reads. */
export interface DiffDocument {
  index: string;
  stamp: { scopeKey: string; observedAt: string; completedAt?: string; digest: string; source?: { kind: string; name: string; version?: string } };
  coverage: readonly DiffCoverageEntry[];
  graph: { nodes: readonly DiffNode[]; edges: readonly DiffEdge[] };
}

/** chant's `indexCoverageFor`, or its fallback here. */
export type CoverageLookup = (coverage: readonly DiffCoverageEntry[], listedType: string, location: string) => DiffCoverageEntry | undefined;

/**
 * The coverage entry that speaks for one (type, location), or undefined.
 * The same rule as chant's `indexCoverageFor` (index-document.ts on chant's
 * integration/consolidation-graph): an exact entry wins over a wildcard one,
 * and a wildcard on one side over a wildcard on both.
 */
export const coverageForFallback: CoverageLookup = (coverage, listedType, location) => {
  let best: DiffCoverageEntry | undefined;
  let bestScore = -1;
  for (const e of coverage) {
    const typeHit = e.listedType === listedType ? 2 : e.listedType === "*" ? 0 : -1;
    const locHit = e.location === location ? 1 : e.location === "*" ? 0 : -1;
    if (typeHit < 0 || locHit < 0) continue;
    if (typeHit + locHit > bestScore) {
      best = e;
      bestScore = typeHit + locHit;
    }
  }
  return best;
};

/** Two versions of different scopes. Refused by name, never diffed. */
export class IndexScopeMismatch extends Error {
  readonly code = "index-scope-mismatch";
  constructor(
    readonly fromScopeKey: string,
    readonly toScopeKey: string,
  ) {
    super(
      `refused: the two index versions have different scopes (${fromScopeKey} and ${toScopeKey}), and a node missing from one could just be out of its scope. Diff two versions of one scope.`,
    );
    this.name = "IndexScopeMismatch";
  }
}

/** A document that is not an index version. */
export class NotAnIndexVersion extends Error {
  readonly code = "not-an-index-version";
}

export interface DiffStamp {
  scopeKey: string;
  observedAt: string;
  completedAt?: string;
  digest: string;
  source?: { kind: string; name: string; version?: string };
  version?: string;
}

export interface DiffNodeRef {
  key: string;
  kind: string;
  listedType: string;
  location: string;
}

export interface PropertyChange {
  path: string;
  before?: unknown;
  after?: unknown;
}

export interface NodeChanged extends DiffNodeRef {
  properties: PropertyChange[];
}

/** A node one read has and the other did not observe. `side` names the read that did not observe it. */
export interface NodeNotObserved extends DiffNodeRef {
  side: "from" | "to";
  /** The coverage verdict for its (type, location) in that read, or `not-in-coverage`. */
  verdict: string;
  detail?: string;
}

export interface EdgeRef {
  from: string;
  to: string;
  kind: string;
  viaAttr?: string;
  relation: string;
  origin?: string;
  rule?: string;
}

export interface EdgeNotObserved extends EdgeRef {
  side: "from" | "to";
  /** The end whose (type, location) was not observed in that read. */
  unobservedEnd: string;
  verdict: string;
}

export interface IndexDiff {
  diff: "v1";
  scopeKey: string;
  from: DiffStamp;
  to: DiffStamp;
  /** Same digest: same graph and coverage. */
  unchanged: boolean;
  nodes: {
    added: DiffNodeRef[];
    removed: DiffNodeRef[];
    changed: NodeChanged[];
    notObserved: NodeNotObserved[];
  };
  edges: {
    added: EdgeRef[];
    removed: EdgeRef[];
    notObserved: EdgeNotObserved[];
  };
  /** (type, location) pairs whose verdict moved between the reads. */
  coverage: Array<{ listedType: string; location: string; before?: string; after?: string }>;
  counts: { added: number; removed: number; changed: number; properties: number; notObserved: number; edgesAdded: number; edgesRemoved: number; edgesNotObserved: number };
}

export interface DiffOptions {
  /** chant's `indexCoverageFor` when the installed chant has it. */
  coverageFor?: CoverageLookup;
  /** Version names, for the stamps. */
  fromVersion?: string;
  toVersion?: string;
}

function decodeSegment(s: string): string {
  return s.replace(/%2F/gi, "/").replace(/%25/g, "%");
}

/**
 * A node's (type, location). Its own `listedType` and `location` (chant#4521
 * writes both), else the path-style id's third and fourth segments
 * (behold#1025 Q2, `<substrate>/<scopeId>/<location>/<listedType>/<nativeId>`),
 * else its kind at every location.
 */
export function nodeTypeAndLocation(n: DiffNode): { listedType: string; location: string } {
  if (n.listedType && n.location) return { listedType: n.listedType, location: n.location };
  const parts = n.id.split("/");
  if (parts.length >= 5) return { listedType: n.listedType ?? decodeSegment(parts[3]!), location: n.location ?? decodeSegment(parts[2]!) };
  return { listedType: n.listedType ?? n.kind, location: n.location ?? "*" };
}

function stampOf(doc: DiffDocument, version?: string): DiffStamp {
  const s = doc.stamp;
  return {
    scopeKey: s.scopeKey,
    observedAt: s.observedAt,
    ...(s.completedAt ? { completedAt: s.completedAt } : {}),
    digest: s.digest,
    ...(s.source ? { source: s.source } : {}),
    ...(version ? { version } : {}),
  };
}

function check(doc: DiffDocument, which: string): void {
  if (!doc || doc.index !== "v1" || typeof doc.stamp?.scopeKey !== "string" || !Array.isArray(doc.graph?.nodes)) {
    throw new NotAnIndexVersion(`the ${which} document is not an index version (index: "v1" with a stamp and a graph)`);
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** JSON with keys sorted, so equal values compare equal. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (isPlain(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x)) ?? "undefined";
}

/** Leaf paths of an object; arrays and scalars are leaves. */
function leaves(v: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isPlain(v) && Object.keys(v).length > 0) {
    for (const [k, x] of Object.entries(v)) leaves(x, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out.set(prefix, v);
  }
}

function changedPaths(before: unknown, after: unknown, root: string): PropertyChange[] {
  const a = new Map<string, unknown>();
  const b = new Map<string, unknown>();
  leaves(before ?? {}, root, a);
  leaves(after ?? {}, root, b);
  const out: PropertyChange[] = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(path);
    const y = b.get(path);
    if (canon(x) === canon(y)) continue;
    out.push({ path, ...(a.has(path) ? { before: x } : {}), ...(b.has(path) ? { after: y } : {}) });
  }
  return out;
}

/** The property changes of one node between two reads. */
export function nodePropertyChanges(before: DiffNode, after: DiffNode): PropertyChange[] {
  const out: PropertyChange[] = [];
  if (before.kind !== after.kind) out.push({ path: "kind", before: before.kind, after: after.kind });
  const attrs = changedPaths(before.attrs, after.attrs, "attrs");
  out.push(...attrs);
  if (attrs.length === 0) out.push(...changedPaths(before.tags, after.tags, "tags"));
  return out;
}

function edgeKey(e: DiffEdge): string {
  return [e.from, e.to, e.kind ?? "", e.viaAttr ?? "", e.relation ?? "reference"].join("\u0000");
}

function edgeRef(e: DiffEdge): EdgeRef {
  return {
    from: e.from,
    to: e.to,
    kind: e.kind ?? "",
    ...(e.viaAttr ? { viaAttr: e.viaAttr } : {}),
    relation: e.relation ?? "reference",
    ...(e.origin ? { origin: e.origin } : {}),
    ...(e.rule ? { rule: e.rule } : {}),
  };
}

const refOf = (n: DiffNode): DiffNodeRef => ({ key: n.id, kind: n.kind, ...nodeTypeAndLocation(n) });

/**
 * What changed from `from` to `to`, two versions of one index scope.
 * Throws {@link IndexScopeMismatch} when their scope keys differ, and
 * {@link NotAnIndexVersion} for a document of another shape.
 */
export function diffIndexVersions(from: DiffDocument, to: DiffDocument, o: DiffOptions = {}): IndexDiff {
  check(from, "first");
  check(to, "second");
  if (from.stamp.scopeKey !== to.stamp.scopeKey) throw new IndexScopeMismatch(from.stamp.scopeKey, to.stamp.scopeKey);
  const coverageFor = o.coverageFor ?? coverageForFallback;
  const out: IndexDiff = {
    diff: "v1",
    scopeKey: from.stamp.scopeKey,
    from: stampOf(from, o.fromVersion),
    to: stampOf(to, o.toVersion),
    unchanged: false,
    nodes: { added: [], removed: [], changed: [], notObserved: [] },
    edges: { added: [], removed: [], notObserved: [] },
    coverage: [],
    counts: { added: 0, removed: 0, changed: 0, properties: 0, notObserved: 0, edgesAdded: 0, edgesRemoved: 0, edgesNotObserved: 0 },
  };
  if (from.stamp.digest && from.stamp.digest === to.stamp.digest) {
    out.unchanged = true;
    return out;
  }

  /** Whether `doc` listed this node's (type, location), and its verdict when it did not. */
  const observed = (doc: DiffDocument, n: DiffNode): { ok: true } | { ok: false; verdict: string; detail?: string } => {
    const { listedType, location } = nodeTypeAndLocation(n);
    const e = coverageFor(doc.coverage, listedType, location);
    if (e?.verdict === "listed") return { ok: true };
    return e ? { ok: false, verdict: e.verdict, ...(e.detail ? { detail: e.detail } : {}) } : { ok: false, verdict: "not-in-coverage" };
  };

  const before = new Map(from.graph.nodes.map((n) => [n.id, n]));
  const after = new Map(to.graph.nodes.map((n) => [n.id, n]));
  for (const [id, n] of [...before].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const m = after.get(id);
    if (m) {
      const properties = nodePropertyChanges(n, m);
      if (properties.length > 0) out.nodes.changed.push({ ...refOf(m), properties });
      continue;
    }
    const seen = observed(to, n);
    if (seen.ok) out.nodes.removed.push(refOf(n));
    else out.nodes.notObserved.push({ ...refOf(n), side: "to", verdict: seen.verdict, ...(seen.detail ? { detail: seen.detail } : {}) });
  }
  for (const [id, n] of [...after].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (before.has(id)) continue;
    const seen = observed(from, n);
    if (seen.ok) out.nodes.added.push(refOf(n));
    else out.nodes.notObserved.push({ ...refOf(n), side: "from", verdict: seen.verdict, ...(seen.detail ? { detail: seen.detail } : {}) });
  }

  // An edge's ends are looked up in either read: a removed edge's ends may be gone from `to`.
  const nodeFor = (id: string): DiffNode => after.get(id) ?? before.get(id) ?? { id, kind: "" };
  const edgesIn = (doc: DiffDocument) => new Map(doc.graph.edges.map((e) => [edgeKey(e), e]));
  const ea = edgesIn(from);
  const eb = edgesIn(to);
  const classify = (e: DiffEdge, lacking: DiffDocument, side: "from" | "to", into: EdgeRef[]) => {
    for (const end of [e.from, e.to]) {
      const seen = observed(lacking, nodeFor(end));
      if (!seen.ok) {
        out.edges.notObserved.push({ ...edgeRef(e), side, unobservedEnd: end, verdict: seen.verdict });
        return;
      }
    }
    into.push(edgeRef(e));
  };
  for (const [k, e] of [...ea].sort(([a], [b]) => (a < b ? -1 : 1))) if (!eb.has(k)) classify(e, to, "to", out.edges.removed);
  for (const [k, e] of [...eb].sort(([a], [b]) => (a < b ? -1 : 1))) if (!ea.has(k)) classify(e, from, "from", out.edges.added);

  const cov = new Map<string, { listedType: string; location: string; before?: string; after?: string }>();
  for (const e of from.coverage) cov.set(`${e.listedType}\u0000${e.location}`, { listedType: e.listedType, location: e.location, before: e.verdict });
  for (const e of to.coverage) {
    const k = `${e.listedType}\u0000${e.location}`;
    cov.set(k, { ...(cov.get(k) ?? { listedType: e.listedType, location: e.location }), after: e.verdict });
  }
  out.coverage = [...cov.values()].filter((c) => c.before !== c.after).sort((a, b) => (a.listedType + a.location < b.listedType + b.location ? -1 : 1));

  out.counts = {
    added: out.nodes.added.length,
    removed: out.nodes.removed.length,
    changed: out.nodes.changed.length,
    properties: out.nodes.changed.reduce((s, c) => s + c.properties.length, 0),
    notObserved: out.nodes.notObserved.length,
    edgesAdded: out.edges.added.length,
    edgesRemoved: out.edges.removed.length,
    edgesNotObserved: out.edges.notObserved.length,
  };
  return out;
}
