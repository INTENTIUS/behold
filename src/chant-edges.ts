/**
 * behold#1030, behold#1227: the inferred edges of a declared graph come from
 * chant.
 *
 * Ruling (behold#1024): behold is a control plane and every model lives in
 * chant. chant draws these edges itself: the catalog pass
 * (`reconstructIndexedEdges`, INTENTIUS/chant#4522) and the identity-match
 * pass (`reconstructIdentityEdges`, INTENTIUS/chant#4523), both in
 * `@intentius/chant/graph-refs` and built to behold#1023's ruling (scoped join
 * keys, no edge when a value names several nodes). Each edge they draw has
 * `origin: "derived"` and the `rule` that drew it, `identity-match:...` for
 * the identity pass.
 *
 * Every route that draws a declared graph calls {@link deriveGraphEdges},
 * which picks one of two sources per graph:
 *
 *  - `graph`: the graph already carries chant's derived edges (an index
 *    document's graph, or a chant that derives them on its own build). They
 *    are the answer, and behold adds nothing.
 *  - `chant`: chant's two passes run over the graph's nodes with the
 *    catalog of every lexicon of the graph whose plugin is installed beside
 *    behold with a `referenceCatalog`, and their edges are added. A declared
 *    graph is one declaration, so every node is in one scope (an account
 *    with no region), and chant's rules (target kinds, ambiguity) decide what
 *    a value joins to. A lexicon with no catalog draws no edges of its own;
 *    its nodes can still be named by another lexicon's rules.
 *
 * The pulumi lexicon's catalog (INTENTIUS/chant#5330) covers a Pulumi
 * member's resources. A choudoufu roster node carries `lexicon: "choudoufu"`
 * and its provider type as its kind, and the terraform catalog reads it
 * through the alias INTENTIUS/chant#5340 added (`NamedCatalog.aliases`,
 * {@link CATALOG_ALIASES}). behold's own name matcher (src/value-match.ts)
 * is retired: on behold's roster fixtures and the choudoufu examples it drew no
 * edge chant does not (behold#1227).
 *
 * The passes are a static import from `@intentius/chant/graph-refs`, which
 * every chant behold accepts carries (src/chant-release.ts, behold#1005). A
 * chant below `GRAPH_REFS_LEXICON_ALIAS_FLOOR` ignores `aliases`, so roster
 * nodes get no catalog edges from it.
 */
import type { GraphIR, IREdge, IRNode } from "@intentius/chant";
import { reconstructIdentityEdges, reconstructIndexedEdges } from "@intentius/chant/graph-refs";

/** chant's `IndexedNodeScope` (graph-refs.ts): the scope a node's identifiers are unique in. */
export interface EdgeScope {
  account: string;
  region?: string;
}

/** A lexicon plugin, as far as chant's two passes read it. */
export interface EdgeLexicon {
  name: string;
  referenceCatalog?: unknown;
  indexIdentity?: { nodeIdentities?(node: IRNode): Array<{ kind: string; value: string }> };
}

/** An edge as chant#4522/#4523 draw it. The published chant's `IREdge` has no `origin` or `rule` yet. */
export type DerivedEdge = IREdge & { origin?: string; rule?: string; relation?: string; grain?: string };

/** The two passes from `@intentius/chant/graph-refs`, typed as behold calls them. */
export interface ChantEdgePasses {
  reconstructIndexedEdges(
    nodes: readonly IRNode[],
    catalogs: ReadonlyArray<{ lexicon: string; catalog: unknown; aliases?: readonly string[] }>,
    scopeOf: (node: IRNode) => EdgeScope,
  ): { edges: DerivedEdge[] };
  reconstructIdentityEdges(
    nodes: readonly IRNode[],
    owners: ReadonlyArray<{ lexicon: string; aliases?: readonly string[]; identities?(node: IRNode): Array<{ kind: string; value: string }> }>,
    scopeOf: (node: IRNode) => EdgeScope,
    existing?: readonly DerivedEdge[],
  ): { edges: DerivedEdge[] };
}

/** Where a graph's inferred edges came from. `uncovered` lists the lexicons of the graph with no catalog beside behold. */
export type EdgeSource = { source: "graph"; edges: number } | { source: "chant"; edges: number; lexicons: string[]; uncovered?: string[] };

/**
 * Other lexicon names a catalog also reads (INTENTIUS/chant#5340): a
 * choudoufu roster node's kind is the provider type, so the terraform
 * catalog reads it. chant's `NamedCatalog.aliases` and
 * `IdentityOwners.aliases` take this, as `chant workspace graph`'s docs
 * write the entry.
 */
export const CATALOG_ALIASES: Readonly<Record<string, readonly string[]>> = { terraform: ["choudoufu"] };

export interface DeriveEdgeDeps {
  /** chant's passes; tests pass fakes. */
  passes?: () => Promise<ChantEdgePasses>;
  /** A lexicon's plugin, or undefined when it is not installed. */
  lexicon?: (name: string) => Promise<EdgeLexicon | undefined>;
}

/** The one scope every node of a declared graph is in. */
const DECLARED_SCOPE: EdgeScope = { account: "declared" };

/** Whether an edge is one chant's catalog or identity pass drew. */
export function isChantDerivedEdge(e: IREdge): boolean {
  const d = e as DerivedEdge;
  return d.origin === "derived" && typeof d.rule === "string" && d.rule !== "";
}

/** Whether the graph already carries chant's derived edges. */
export function graphCarriesChantEdges(ir: GraphIR): boolean {
  return ir.edges.some(isChantDerivedEdge);
}

type Lazy = Record<string, unknown> | undefined;

/** Imports a module by a name the bundler and the type checker do not follow. */
async function lazy(specifier: string): Promise<Lazy> {
  const name: string = specifier;
  try {
    return (await import(/* @vite-ignore */ name)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** chant#4522's and #4523's passes. */
export function chantEdgePasses(): Promise<ChantEdgePasses> {
  return Promise.resolve({ reconstructIndexedEdges, reconstructIdentityEdges } as unknown as ChantEdgePasses);
}

const lexiconCache = new Map<string, Promise<EdgeLexicon | undefined>>();

/**
 * The plugin of a chant lexicon by its name (`aws` is
 * `@intentius/chant-lexicon-aws`), found as the export whose `name` is the
 * lexicon's, or undefined when the package is not installed.
 */
export function chantLexicon(name: string): Promise<EdgeLexicon | undefined> {
  let p = lexiconCache.get(name);
  if (!p) {
    p = lazy(`@intentius/chant-lexicon-${name}`).then((m) => {
      // A lexicon exports more than one object named after it (k8s has its
      // capability plugin, its plugin and its serializer, #1122). The one the
      // passes need is the plugin that carries the reference catalog.
      const named = Object.values(m ?? {}).filter((v) => v && typeof v === "object" && (v as { name?: unknown }).name === name) as EdgeLexicon[];
      return named.find((v) => (v as { referenceCatalog?: unknown }).referenceCatalog !== undefined) ?? named[0];
    });
    lexiconCache.set(name, p);
  }
  return p;
}

/**
 * Run chant's passes over a declared graph's nodes and add their edges.
 * Mutates `ir`. An edge between a pair the graph already joins (a declared
 * ref, or a k8s contract join that ran first) is not added twice, which is
 * the matcher's dedup. Pure apart from the mutation.
 */
export function addChantEdges(ir: GraphIR, passes: ChantEdgePasses, lexicons: readonly EdgeLexicon[]): number {
  const scopeOf = () => DECLARED_SCOPE;
  const sorted = [...lexicons].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const aliased = (name: string) => (CATALOG_ALIASES[name] ? { aliases: [...CATALOG_ALIASES[name]] } : {});
  const catalogs = sorted.filter((l) => l.referenceCatalog !== undefined).map((l) => ({ lexicon: l.name, catalog: l.referenceCatalog, ...aliased(l.name) }));
  const owners = sorted
    .filter((l) => l.indexIdentity !== undefined)
    .map((l) => {
      const idx = l.indexIdentity!;
      return idx.nodeIdentities ? { lexicon: l.name, ...aliased(l.name), identities: (n: IRNode) => idx.nodeIdentities!(n) } : { lexicon: l.name, ...aliased(l.name) };
    });
  const catalogPass = passes.reconstructIndexedEdges(ir.nodes, catalogs, scopeOf).edges;
  const identityPass = owners.length > 0 ? passes.reconstructIdentityEdges(ir.nodes, owners, scopeOf, catalogPass).edges : [];

  const joined = new Set(ir.edges.map((e) => `${e.from}\0${e.to}`));
  let added = 0;
  for (const e of [...catalogPass, ...identityPass]) {
    const key = `${e.from}\0${e.to}`;
    if (joined.has(key)) continue;
    joined.add(key);
    ir.edges.push(e);
    added++;
  }
  return added;
}

/**
 * The inferred edges of a declared graph, from chant (see the module doc).
 * Mutates and returns `ir`, so it composes in the same pipelines as the other
 * edge passes.
 */
export async function deriveGraphEdges(ir: GraphIR, deps: DeriveEdgeDeps = {}): Promise<GraphIR> {
  return (await deriveGraphEdgesWithSource(ir, deps)).ir;
}

/** The lexicon names a graph's nodes carry, with each catalog's aliases read as the catalog's own lexicon. */
function catalogLexiconsOf(ir: GraphIR): string[] {
  const out = new Set<string>();
  for (const n of ir.nodes) {
    const l = n.lexicon;
    if (typeof l !== "string" || l === "") continue;
    const owner = Object.keys(CATALOG_ALIASES).find((k) => CATALOG_ALIASES[k].includes(l));
    out.add(l);
    if (owner) out.add(owner);
  }
  return [...out].sort();
}

/** {@link deriveGraphEdges}, saying which source it used. */
export async function deriveGraphEdgesWithSource(ir: GraphIR, deps: DeriveEdgeDeps = {}): Promise<{ ir: GraphIR; source: EdgeSource }> {
  if (graphCarriesChantEdges(ir)) {
    return { ir, source: { source: "graph", edges: ir.edges.filter(isChantDerivedEdge).length } };
  }
  const lexicons: EdgeLexicon[] = [];
  for (const name of catalogLexiconsOf(ir)) {
    const plugin = await (deps.lexicon ?? chantLexicon)(name);
    if (plugin?.referenceCatalog !== undefined) lexicons.push(plugin);
  }
  const read = new Set(lexicons.flatMap((l) => [l.name, ...(CATALOG_ALIASES[l.name] ?? [])]));
  const uncovered = [...new Set(ir.nodes.map((n) => n.lexicon))].filter((l): l is string => typeof l === "string" && l !== "" && !read.has(l)).sort();
  const edges = lexicons.length > 0 ? addChantEdges(ir, await (deps.passes ?? chantEdgePasses)(), lexicons) : 0;
  return { ir, source: { source: "chant", edges, lexicons: lexicons.map((l) => l.name), ...(uncovered.length ? { uncovered } : {}) } };
}
