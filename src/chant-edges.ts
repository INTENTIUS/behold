/**
 * behold#1030: the inferred edges of a declared graph come from chant.
 *
 * Ruling (behold#1024): behold is a control plane and every model lives in
 * chant. behold's own name matcher (src/value-match.ts) is a model piece, and
 * chant now draws the same kind of edge itself: the catalog pass
 * (`reconstructIndexedEdges`, INTENTIUS/chant#4522) and the identity-match
 * pass (`reconstructIdentityEdges`, INTENTIUS/chant#4523), both in
 * `@intentius/chant/graph-refs` and built to behold#1023's ruling (scoped join
 * keys, no edge when a value names several nodes). Each edge they draw has
 * `origin: "derived"` and the `rule` that drew it, `identity-match:...` for
 * the identity pass.
 *
 * Every route that used to call `addValueMatchEdges` calls
 * {@link deriveGraphEdges}, which picks one of three sources per graph:
 *
 *  - `graph`: the graph already carries chant's derived edges (an index
 *    document's graph, or a chant that derives them on its own build). They
 *    are the answer, and behold adds nothing.
 *  - `chant`: chant's two passes are found, and every lexicon the graph's
 *    nodes belong to has its plugin installed beside behold with a
 *    `referenceCatalog`. The passes run over the graph's nodes and their
 *    edges are added. A declared graph is one declaration, so every node is
 *    in one scope (an account with no region): a value joins across the whole
 *    graph, as the matcher's did, and chant's rules (target kinds, ambiguity)
 *    decide what it joins to.
 *  - `value-match`: neither, so today's matcher runs, as before. This is what
 *    the published chant gets (it has no `reconstructIndexedEdges`), and what
 *    a graph with a lexicon chant has no catalog for gets (azure, gcp, k8s
 *    and terraform have none yet). A graph is never half one and half the
 *    other: mixing chant's rules and behold's on one picture would make an
 *    edge's meaning depend on which half it is in.
 *
 * The passes are looked for under specifiers the type checker and the
 * bundler leave alone, as src/behold-index.ts does for chant's `runCloudIndex`: a local
 * build of chant's integration branch has them (under tsx and vitest), the
 * published chant and the bundled dist/cli.js do not.
 *
 * TODO(behold#1005): once src/chant-release.ts says `released: true`, import
 * the passes statically, delete src/value-match.ts and the `value-match`
 * source here, and leave a graph whose lexicon has no catalog with the edges
 * chant gives it.
 */
import type { GraphIR, IREdge, IRNode } from "@intentius/chant";
import { addValueMatchEdges } from "./value-match.ts";

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
    catalogs: ReadonlyArray<{ lexicon: string; catalog: unknown }>,
    scopeOf: (node: IRNode) => EdgeScope,
  ): { edges: DerivedEdge[] };
  reconstructIdentityEdges(
    nodes: readonly IRNode[],
    owners: ReadonlyArray<{ lexicon: string; identities?(node: IRNode): Array<{ kind: string; value: string }> }>,
    scopeOf: (node: IRNode) => EdgeScope,
    existing?: readonly DerivedEdge[],
  ): { edges: DerivedEdge[] };
}

/** Where a graph's inferred edges came from, and why. */
export type EdgeSource =
  | { source: "graph"; edges: number }
  | { source: "chant"; edges: number; lexicons: string[] }
  | { source: "value-match"; reason: string };

export interface DeriveEdgeDeps {
  /** chant's passes, or undefined when the chant beside behold has none. */
  passes?: () => Promise<ChantEdgePasses | undefined>;
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

export const GRAPH_REFS_SPECIFIER = "@intentius/chant/graph-refs";

let passesCached: Promise<ChantEdgePasses | undefined> | undefined;

/** chant#4522's and #4523's passes, or undefined. Looked up once per process. */
export function chantEdgePasses(): Promise<ChantEdgePasses | undefined> {
  passesCached ??= lazy(GRAPH_REFS_SPECIFIER).then((m) =>
    typeof m?.reconstructIndexedEdges === "function" && typeof m?.reconstructIdentityEdges === "function"
      ? (m as unknown as ChantEdgePasses)
      : undefined,
  );
  return passesCached;
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
      for (const v of Object.values(m ?? {})) {
        if (v && typeof v === "object" && (v as { name?: unknown }).name === name) return v as EdgeLexicon;
      }
      return undefined;
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
  const catalogs = sorted.filter((l) => l.referenceCatalog !== undefined).map((l) => ({ lexicon: l.name, catalog: l.referenceCatalog }));
  const owners = sorted
    .filter((l) => l.indexIdentity !== undefined)
    .map((l) => {
      const idx = l.indexIdentity!;
      return idx.nodeIdentities ? { lexicon: l.name, identities: (n: IRNode) => idx.nodeIdentities!(n) } : { lexicon: l.name };
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
 * The inferred edges of a declared graph, from chant when it can draw them and
 * from today's matcher when it cannot (see the module doc). Mutates and
 * returns `ir`, the contract `addValueMatchEdges` had, so it composes in the
 * same pipelines.
 */
export async function deriveGraphEdges(ir: GraphIR, deps: DeriveEdgeDeps = {}): Promise<GraphIR> {
  return (await deriveGraphEdgesWithSource(ir, deps)).ir;
}

/** {@link deriveGraphEdges}, saying which source it used. */
export async function deriveGraphEdgesWithSource(ir: GraphIR, deps: DeriveEdgeDeps = {}): Promise<{ ir: GraphIR; source: EdgeSource }> {
  if (graphCarriesChantEdges(ir)) {
    return { ir, source: { source: "graph", edges: ir.edges.filter(isChantDerivedEdge).length } };
  }
  const passes = await (deps.passes ?? chantEdgePasses)();
  if (!passes) {
    addValueMatchEdges(ir);
    return { ir, source: { source: "value-match", reason: `the chant beside behold has no reconstructIndexedEdges/reconstructIdentityEdges (${GRAPH_REFS_SPECIFIER}, chant#4522/#4523)` } };
  }
  const names = [...new Set(ir.nodes.map((n) => n.lexicon).filter((l): l is string => typeof l === "string" && l !== ""))].sort();
  const lexicons: EdgeLexicon[] = [];
  const uncovered: string[] = [];
  for (const name of names) {
    const plugin = await (deps.lexicon ?? chantLexicon)(name);
    if (plugin?.referenceCatalog === undefined) uncovered.push(name);
    else lexicons.push(plugin);
  }
  if (uncovered.length > 0 || lexicons.length === 0) {
    addValueMatchEdges(ir);
    const why = uncovered.length > 0 ? uncovered.join(", ") : "none";
    return { ir, source: { source: "value-match", reason: `no referenceCatalog beside behold for lexicon(s) ${why}` } };
  }
  const edges = addChantEdges(ir, passes, lexicons);
  return { ir, source: { source: "chant", edges, lexicons: lexicons.map((l) => l.name) } };
}
