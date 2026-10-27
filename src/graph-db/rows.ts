/**
 * behold#1027: the loaders. Each source becomes rows of the three tables
 * behold#1025's design comment lays out for LadybugDB:
 *
 *   Resource(key PK, source, scopeKey, version, id, kind, lexicon, listedType,
 *            location, nativeId, ownership, engineOwnership, attrs, tags,
 *            facts, observedAt, ...)
 *   CloudId(value PK, kind), with KNOWN_AS from each Resource
 *   REF(FROM Resource TO Resource, kind, viaAttr, toAttr, grain, origin, rule,
 *       relation, ambiguous)
 *
 * `key` is `<prefix>/<id>`: a chant member's name, as `chant workspace search`
 * prints `<member>/<id>`, widened to every source. An engine document takes
 * the member it sits beside, else `engine/<engine>/<estate or project/stack>`;
 * an index version takes its `stamp.scopeKey`; a cloud listing the scope key
 * chant's index store would give it.
 *
 * `attrs`, `tags` and `facts` are JSON strings, as the design says, with a few
 * typed columns the resolve rules and #1022's templates read (`name`,
 * `address`, `ownership`). Every attribute value is masked with the cloud
 * lister's key list (src/graph-db/mask.ts) before it is a row, whatever
 * the source, so nothing in the database holds what the lister would hide.
 *
 * The columns are chant's graph schema's, laid out by ./layout-gen.ts
 * (behold#1031): ./layout.generated.ts for the vendored schema, which these
 * row types are checked against (./layout.ts), or the installed chant's
 * schema at run time. A column that layout has and the vendored one does not
 * (a field a newer chant added) is filled here from the node or edge field
 * it names, so a newer chant's field reaches the database without a behold
 * release.
 *
 * Everything here is pure: documents in, rows out. Building the database is
 * src/graph-db/db.ts; finding the documents is src/graph-db/sources.ts.
 */
import type { GraphIR } from "@intentius/chant";
import { indexScopeKey } from "@intentius/chant/lifecycle/index-document";
import type { CloudScope, ListingResult } from "./listing.ts";
import { maskValue } from "./mask.ts";
import type { GraphLayout, LayoutColumn } from "./layout-gen.ts";
import { GRAPH_LAYOUT } from "./layout.generated.ts";
import type { EngineFacts, EngineGraphDocument, FactEdge, FactGraph, FactNode, IndexDocument } from "./types.ts";

export type SourceKind = "chant" | "engine" | "index" | "cloud";

export interface ResourceRow {
  key: string;
  source: SourceKind;
  scopeKey: string;
  /** The index version name, the engine's version, or "" for a chant read. */
  version: string;
  id: string;
  kind: string;
  lexicon: string;
  listedType: string;
  location: string;
  nativeId: string;
  /** A display name: attrs.name, Name, address or the id's last segment. */
  name: string;
  /** An engine address (choudoufu instance address, plunge URN) or attrs.address. */
  address: string;
  /** chant's verdict, the IR node's `ownership` (owned, foreign), or "" (behold#906 Q4). */
  ownership: string;
  /** The engine's verdict, `facts.ownership` (bound, unowned, pending, foreign), or "" when no engine said. */
  engineOwnership: string;
  attrs: string;
  tags: string;
  facts: string;
  /** When this node's facts were read, or "" when nothing was read live. */
  observedAt: string;
}

export interface CloudIdRow {
  value: string;
  kind: string;
}

export interface KnownAsRow {
  key: string;
  value: string;
}

export interface RefRow {
  from: string;
  to: string;
  kind: string;
  viaAttr: string;
  toAttr: string;
  grain: string;
  origin: "declared" | "observed" | "derived";
  rule: string;
  relation: "reference" | "containment";
  ambiguous: boolean;
}

/** One loaded source, and when it was read: every answer carries these (#1027 "Rules"). */
export interface SourceStamp {
  scopeKey: string;
  source: SourceKind;
  /** chant, choudoufu, plunge, behold-lister, or the index's source name. */
  name: string;
  /** The member it belongs to, when it belongs to one. */
  member?: string;
  version?: string;
  /** When the source read the world, or null for a source-only read (declared, not observed). */
  observedAt: string | null;
  /** When behold read the document. */
  readAt: string;
  /** Where behold found it: a file path, a command, or a store key. */
  from: string;
  nodes: number;
  edges: number;
}

export interface LoadedRows {
  resources: ResourceRow[];
  cloudIds: CloudIdRow[];
  knownAs: KnownAsRow[];
  refs: RefRow[];
  sources: SourceStamp[];
  notes: string[];
  /** The layout the rows are for; absent is the vendored one (./layout.generated.ts). */
  layout?: GraphLayout;
}

export const emptyRows = (layout?: GraphLayout): LoadedRows => ({ resources: [], cloudIds: [], knownAs: [], refs: [], sources: [], notes: [], ...(layout ? { layout } : {}) });

const vendoredColumns = (table: string): Set<string> => new Set(GRAPH_LAYOUT.tables.find((t) => t.name === table)?.columns.map((c) => c.name) ?? []);
const VENDORED = { Resource: vendoredColumns("Resource"), REF: vendoredColumns("REF") };

/** The schema-field columns `layout` has on `table` that the vendored layout lacks: what the loaders fill generically. */
export function extraColumns(layout: GraphLayout | undefined, table: "Resource" | "REF"): LayoutColumn[] {
  if (!layout || layout === (GRAPH_LAYOUT as unknown as GraphLayout)) return [];
  const t = layout.tables.find((x) => x.name === table);
  return (t?.columns ?? []).filter((c) => c.from !== "behold" && !VENDORED[table].has(c.name));
}

/** A field's value as its column holds it: JSON (masked) for a structured column, else the value when it has the column's type, else the type's empty value. */
export function columnValue(c: LayoutColumn, v: unknown): string | number | boolean {
  if (c.json) return v === undefined ? "" : JSON.stringify(maskValue(v));
  if (c.type === "BOOLEAN") return v === true;
  if (c.type === "DOUBLE" || c.type === "INT64") return typeof v === "number" && Number.isFinite(v) ? (c.type === "INT64" ? Math.trunc(v) : v) : 0;
  return typeof v === "string" ? v : "";
}

function fillExtras(row: object, from: object, cols: readonly LayoutColumn[]): void {
  for (const c of cols) (row as Record<string, unknown>)[c.name] = columnValue(c, (from as Record<string, unknown>)[c.from.slice(c.from.indexOf(".") + 1)]);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function lastSegment(id: string): string {
  const i = id.lastIndexOf("/");
  return i < 0 ? id : id.slice(i + 1);
}

function nameOf(node: FactNode): string {
  const a = node.attrs ?? {};
  return str(a.name) || str(a.Name) || str(a.metadata && (a.metadata as { name?: unknown }).name) || str(a.address) || lastSegment(node.id);
}

/** A cloud id's kind, guessed from its spelling when the source gave none (a physicalId). */
export function cloudIdKind(value: string): string {
  if (value.startsWith("arn:")) return "arn";
  if (/^\/subscriptions\//i.test(value)) return "provider-id";
  if (value.startsWith("//")) return "provider-id";
  if (/^https:\/\/[^/]*googleapis\.com\//.test(value)) return "self-link";
  return "provider-id";
}

/**
 * The values a node is known by: `facts.cloudIds`, its `physicalId`, and for
 * an ARM id one lowercased copy too, because Resource Graph lowercases
 * (behold#1025 "Normalization of cloudIds").
 */
export function cloudIdsOf(node: FactNode, extra: ReadonlyArray<{ kind: string; value: string }> = []): CloudIdRow[] {
  const out = new Map<string, string>();
  const add = (value: string, kind: string) => {
    if (!value || out.has(value)) return;
    out.set(value, kind);
    if (/^\/subscriptions\//i.test(value)) {
      const lower = value.toLowerCase();
      if (!out.has(lower)) out.set(lower, kind);
    }
  };
  for (const c of node.facts?.cloudIds ?? []) add(c.value, c.kind);
  for (const c of extra) add(c.value, c.kind);
  if (node.physicalId) add(node.physicalId, cloudIdKind(node.physicalId));
  return [...out].map(([value, kind]) => ({ value, kind }));
}

/** chant's verdict and the engine's, kept apart (behold#906 Q4). */
function ownershipOf(node: FactNode): { ownership: string; engineOwnership: string } {
  return { ownership: str(node.ownership), engineOwnership: str(node.facts?.ownership) };
}

interface NodeLoad {
  source: SourceKind;
  scopeKey: string;
  version: string;
  keyOf: (id: string) => string;
  /** The node's observedAt when its facts carry none. */
  observedAt: string;
  extra?: (node: FactNode) => Partial<ResourceRow> & { cloudIds?: Array<{ kind: string; value: string }>; tags?: string };
}

function json(v: unknown): string {
  return v === undefined ? "" : JSON.stringify(v);
}

function loadGraph(rows: LoadedRows, graph: FactGraph | GraphIR, o: NodeLoad): { nodes: number; edges: number } {
  const g = graph as FactGraph;
  const nodeExtras = extraColumns(rows.layout, "Resource");
  const edgeExtras = extraColumns(rows.layout, "REF");
  const seen = new Set<string>();
  let nodes = 0;
  for (const node of g.nodes ?? []) {
    if (!node || typeof node.id !== "string") continue;
    const key = o.keyOf(node.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const extra = o.extra?.(node) ?? {};
    const { cloudIds: extraIds, ...cols } = extra;
    const facts: EngineFacts | undefined = node.facts;
    const row: ResourceRow = {
      key,
      source: o.source,
      scopeKey: o.scopeKey,
      version: o.version,
      id: node.id,
      kind: str(node.kind),
      lexicon: str(node.lexicon),
      listedType: "",
      location: "",
      nativeId: "",
      name: nameOf(node),
      address: str(node.attrs?.address),
      ...ownershipOf(node),
      attrs: json(maskValue(node.attrs ?? {})),
      tags: "",
      facts: json(facts),
      observedAt: facts?.observedAt ?? o.observedAt,
      ...cols,
    };
    fillExtras(row, node, nodeExtras);
    rows.resources.push(row);
    for (const c of cloudIdsOf(node, extraIds)) {
      rows.cloudIds.push(c);
      rows.knownAs.push({ key, value: c.value });
    }
    nodes++;
  }
  let edges = 0;
  for (const e of (g.edges ?? []) as FactEdge[]) {
    const from = o.keyOf(e.from);
    const to = o.keyOf(e.to);
    // A reference whose end is not in this source is dangling, never an edge (behold#1025 "Edge").
    if (!seen.has(from) || !seen.has(to)) continue;
    const ref: RefRow = {
      from,
      to,
      kind: str(e.kind),
      viaAttr: str(e.viaAttr),
      toAttr: str(e.toAttr),
      grain: str(e.grain),
      origin: e.origin ?? (o.source === "chant" ? "declared" : "observed"),
      rule: str(e.rule),
      relation: e.relation ?? "reference",
      ambiguous: e.ambiguous === true,
    };
    fillExtras(ref, e, edgeExtras);
    rows.refs.push(ref);
    edges++;
  }
  return { nodes, edges };
}

/**
 * chant's IR for chant members. `member` names one member's IR, keyed
 * `<member>/<id>`. With `members` instead, `ir` is a composed estate whose ids
 * are already `<member>/<id>` (src/estate.ts `composeEstate`), and each member
 * gets its own source line. With neither, a single project: keys are the ids,
 * as `chant search` prints them, under scope `chant/.`.
 */
export function rowsFromChantIr(ir: GraphIR, o: { member?: string; members?: readonly string[]; readAt: string; from: string }, rows: LoadedRows = emptyRows()): LoadedRows {
  if (o.member !== undefined) {
    const scopeKey = `chant/${o.member}`;
    const n = loadGraph(rows, ir, { source: "chant", scopeKey, version: "", keyOf: (id) => `${o.member}/${id}`, observedAt: "" });
    rows.sources.push({ scopeKey, source: "chant", name: "chant", member: o.member, observedAt: null, readAt: o.readAt, from: o.from, ...n });
    return rows;
  }
  if (o.members?.length) {
    const names = [...o.members].sort((a, b) => b.length - a.length);
    const memberOf = (id: string): string => names.find((m) => id.startsWith(`${m}/`)) ?? ".";
    const byMember = new Map<string, { nodes: FactNode[]; edges: FactEdge[] }>();
    for (const node of ir.nodes as FactNode[]) {
      const m = memberOf(node.id);
      if (!byMember.has(m)) byMember.set(m, { nodes: [], edges: [] });
      byMember.get(m)!.nodes.push(node);
    }
    const stamps = new Map<string, SourceStamp>();
    for (const [m, part] of [...byMember].sort(([a], [b]) => a.localeCompare(b))) {
      const scopeKey = `chant/${m}`;
      const n = loadGraph(rows, { ...ir, nodes: part.nodes, edges: [] }, { source: "chant", scopeKey, version: "", keyOf: (id) => id, observedAt: "" });
      const stamp: SourceStamp = { scopeKey, source: "chant", name: "chant", member: m, observedAt: null, readAt: o.readAt, from: o.from, ...n };
      stamps.set(m, stamp);
      rows.sources.push(stamp);
    }
    // Edges of a composed estate cross members (cross-stack references), so they load once, over every member,
    // and count toward the member the edge starts in.
    const keys = new Set(rows.resources.map((r) => r.key));
    for (const e of ir.edges as FactEdge[]) {
      if (!keys.has(e.from) || !keys.has(e.to)) continue;
      const ref: RefRow = { from: e.from, to: e.to, kind: str(e.kind), viaAttr: str(e.viaAttr), toAttr: str(e.toAttr), grain: str(e.grain), origin: e.origin ?? "declared", rule: str(e.rule), relation: e.relation ?? "reference", ambiguous: e.ambiguous === true };
      fillExtras(ref, e, extraColumns(rows.layout, "REF"));
      rows.refs.push(ref);
      const s = stamps.get(memberOf(e.from));
      if (s) s.edges++;
    }
    return rows;
  }
  const scopeKey = "chant/.";
  const n = loadGraph(rows, ir, { source: "chant", scopeKey, version: "", keyOf: (id) => id, observedAt: "" });
  rows.sources.push({ scopeKey, source: "chant", name: "chant", observedAt: null, readAt: o.readAt, from: o.from, ...n });
  return rows;
}

/** `engine/<engine>/<estate>` or `engine/<engine>/<project>/<stack>`: an engine document's prefix when no member claims it. */
export function engineScopeKey(doc: EngineGraphDocument): string {
  const g = doc.meta.engineGraph;
  const s = g.scope;
  const enc = encodeURIComponent;
  return s.kind === "estate" ? `engine/${enc(g.engine.name)}/${enc(s.estate)}` : `engine/${enc(g.engine.name)}/${enc(s.project)}/${enc(s.stack)}`;
}

/**
 * An engine graph document (chant#4520 section 3, chant#4527), loaded as it
 * is: node ids are the engine's own addresses, facts sit in `facts`, and the
 * read time is `meta.engineGraph.observedAt`. `member` keys it under the
 * member it belongs to.
 *
 * The engine's ids are not chant's (`entityKeyFor`, `pulumiNodeKey` map them,
 * chant#4520 open question 2), so its nodes are separate Resources. They join
 * the member's chant nodes through the cloud ids both carry: one CloudId, two
 * KNOWN_AS edges.
 */
export function rowsFromEngineGraph(doc: EngineGraphDocument, o: { member?: string; readAt: string; from: string }, rows: LoadedRows = emptyRows()): LoadedRows {
  const g = doc.meta.engineGraph;
  const scopeKey = o.member !== undefined ? `${engineScopeKey(doc)}@${o.member}` : engineScopeKey(doc);
  const prefix = o.member !== undefined ? `${o.member}/${g.engine.name}` : engineScopeKey(doc);
  const n = loadGraph(rows, doc as unknown as FactGraph, {
    source: "engine",
    scopeKey,
    version: g.engine.version ?? "",
    keyOf: (id) => `${prefix}/${id}`,
    observedAt: g.observedAt ?? "",
    extra: (node) => ({ address: str(node.attrs?.address) || node.id, ...(node.facts?.markers ? { tags: json(node.facts.markers) } : {}) }),
  });
  for (const gap of g.gaps ?? []) rows.notes.push(`${g.engine.name} could not describe ${gap.address}: ${gap.reason}${gap.detail ? ` (${gap.detail})` : ""}`);
  rows.sources.push({ scopeKey, source: "engine", name: g.engine.name, ...(o.member !== undefined ? { member: o.member } : {}), ...(g.engine.version ? { version: g.engine.version } : {}), observedAt: g.observedAt ?? null, readAt: o.readAt, from: o.from, ...n });
  return rows;
}

/** An index version (chant#4519, behold#1025): keyed `<stamp.scopeKey>/<id>`, version the store's name for it. */
export function rowsFromIndex(doc: IndexDocument, o: { version: string; readAt: string; from: string }, rows: LoadedRows = emptyRows()): LoadedRows {
  const scopeKey = doc.stamp.scopeKey;
  const n = loadGraph(rows, doc.graph, {
    source: "index",
    scopeKey,
    version: o.version,
    keyOf: (id) => `${scopeKey}/${id}`,
    observedAt: doc.stamp.observedAt,
    extra: (node) => {
      const a = node as FactNode & { listedType?: unknown; location?: unknown; nativeId?: unknown; tags?: unknown };
      return {
        listedType: str(a.listedType),
        location: str(a.location),
        nativeId: str(a.nativeId),
        ...(a.tags && typeof a.tags === "object" ? { tags: json(maskValue(a.tags)) } : {}),
      };
    },
  });
  for (const note of doc.notes ?? []) rows.notes.push(`${scopeKey}: ${note.message}`);
  for (const c of doc.coverage ?? []) if (c.verdict !== "listed") rows.notes.push(`${scopeKey}: ${c.listedType} in ${c.location} not observed (${c.verdict}${c.detail ? `: ${c.detail}` : ""})`);
  rows.sources.push({ scopeKey, source: "index", name: doc.stamp.source.name, ...(doc.stamp.source.version ? { version: doc.stamp.source.version } : {}), observedAt: doc.stamp.observedAt, readAt: o.readAt, from: o.from, ...n });
  return rows;
}

/** `cloud/<substrate>/<scopeId>/<digest12>`: chant#4519's `indexScopeKey` for a cloud scope, so a listing loads under the key the index store would give it. */
export function cloudScopeKey(scope: CloudScope): string {
  return indexScopeKey({ kind: "cloud", ...scope });
}

/**
 * The cloud lister's output (behold#1029), before chant's `typeListing`
 * (chant#4521) types it: each listed object is a node of kind `listedType`
 * in lexicon `<substrate>`, unmapped, with its properties as attrs. No edges:
 * deriving them is chant#4522's.
 */
export function rowsFromListing(listing: ListingResult, o: { readAt: string; from: string }, rows: LoadedRows = emptyRows()): LoadedRows {
  const scopeKey = cloudScopeKey(listing.scope);
  const nodes: FactNode[] = listing.resources.map((r) => ({
    id: r.id,
    kind: r.listedType,
    lexicon: listing.scope.substrate,
    attrs: r.properties,
    facts: { ...(r.facts.markers ? { markers: r.facts.markers } : {}), cloudIds: r.cloudIds, observedAt: r.observedAt },
  }));
  const byId = new Map(listing.resources.map((r) => [r.id, r]));
  const n = loadGraph(rows, { version: 1, nodes, edges: [], groups: {} } as unknown as FactGraph, {
    source: "cloud",
    scopeKey,
    version: listing.startedAt,
    keyOf: (id) => `${scopeKey}/${id}`,
    observedAt: listing.startedAt,
    extra: (node) => {
      const r = byId.get(node.id)!;
      return { listedType: r.listedType, location: r.location, nativeId: r.nativeId, tags: json(r.tags), name: str(r.tags.Name) || str(r.tags.name) || lastSegment(r.nativeId) };
    },
  });
  for (const note of listing.notes) rows.notes.push(`${scopeKey}: ${note.message}`);
  rows.sources.push({ scopeKey, source: "cloud", name: listing.source.name, version: listing.source.version, observedAt: listing.startedAt, readAt: o.readAt, from: o.from, ...n });
  return rows;
}

/** Strings under a value, with their paths, to a fixed depth: what an identity match compares. */
function stringsUnder(v: unknown, path: string, out: Array<{ path: string; value: string }>, depth: number): void {
  if (depth < 0 || out.length > 500) return;
  if (typeof v === "string") out.push({ path, value: v });
  else if (Array.isArray(v)) v.forEach((x, i) => stringsUnder(x, `${path}[${i}]`, out, depth - 1));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) stringsUnder(x, path ? `${path}.${k}` : k, out, depth - 1);
}

/** Shorter values join too much by accident (a name like "web"); they are never matched. */
export const IDENTITY_MIN_LENGTH = 8;

/**
 * Mixed substrate: edges derived from identity (behold#1022 "Mixed
 * substrate"). An attribute value on one node that equals another source's
 * node's cloud id becomes a REF with `origin: derived`, `rule:
 * identity:<cloud id kind>` and `grain: property`, and `ambiguous` when the
 * value names more than one node. They are labelled derived wherever they are
 * drawn, because how often one joins wrongly is behold#1023's measurement.
 */
export function deriveIdentityEdges(rows: LoadedRows): number {
  const owners = new Map<string, Array<{ key: string; scopeKey: string }>>();
  const scopeOf = new Map(rows.resources.map((r) => [r.key, r.scopeKey]));
  const kindOf = new Map(rows.cloudIds.map((c) => [c.value, c.kind]));
  for (const k of rows.knownAs) {
    if (k.value.length < IDENTITY_MIN_LENGTH) continue;
    const list = owners.get(k.value) ?? [];
    list.push({ key: k.key, scopeKey: scopeOf.get(k.key) ?? "" });
    owners.set(k.value, list);
  }
  const have = new Set(rows.refs.map((r) => `${r.from}\u0000${r.to}\u0000${r.viaAttr}`));
  const edgeExtras = extraColumns(rows.layout, "REF");
  let added = 0;
  for (const r of rows.resources) {
    if (!r.attrs) continue;
    let attrs: unknown;
    try {
      attrs = JSON.parse(r.attrs);
    } catch {
      continue;
    }
    const found: Array<{ path: string; value: string }> = [];
    stringsUnder(attrs, "", found, 5);
    for (const { path, value } of found) {
      const hits = (owners.get(value) ?? owners.get(value.toLowerCase()) ?? []).filter((o) => o.key !== r.key && o.scopeKey !== r.scopeKey);
      for (const hit of hits) {
        const id = `${r.key}\u0000${hit.key}\u0000${path}`;
        if (have.has(id)) continue;
        have.add(id);
        const ref: RefRow = { from: r.key, to: hit.key, kind: "ref", viaAttr: path, toAttr: "", grain: "property", origin: "derived", rule: `identity:${kindOf.get(value) ?? "provider-id"}`, relation: "reference", ambiguous: hits.length > 1 };
        fillExtras(ref, {}, edgeExtras);
        rows.refs.push(ref);
        added++;
      }
    }
  }
  return added;
}

/** CloudId rows with one row per value: the first kind a source gave it wins. */
export function dedupeCloudIds(rows: LoadedRows): void {
  const seen = new Map<string, CloudIdRow>();
  for (const c of rows.cloudIds) if (!seen.has(c.value)) seen.set(c.value, c);
  rows.cloudIds = [...seen.values()];
  const ka = new Set<string>();
  rows.knownAs = rows.knownAs.filter((k) => {
    const id = `${k.key}\u0000${k.value}`;
    if (ka.has(id)) return false;
    ka.add(id);
    return true;
  });
}

/** Resource keys must be unique across sources; a later duplicate is dropped with a note. */
export function dedupeResources(rows: LoadedRows): void {
  const seen = new Set<string>();
  rows.resources = rows.resources.filter((r) => {
    if (seen.has(r.key)) {
      rows.notes.push(`two sources load ${r.key}; the first is kept`);
      return false;
    }
    seen.add(r.key);
    return true;
  });
}

/** Every source in one set of rows, deduplicated and with identity edges derived: what the database is built from. */
export function finishRows(rows: LoadedRows): LoadedRows {
  dedupeResources(rows);
  dedupeCloudIds(rows);
  deriveIdentityEdges(rows);
  return rows;
}
