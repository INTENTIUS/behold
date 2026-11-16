/**
 * One graph of a live cluster and a folder that declares what it uses
 * (behold#1115): `behold graph --context <ctx> <dir>`.
 *
 *     readJoined({ cluster, dir, detail? }) => Promise<ReadJoinedResult>
 *
 * Each source is read as it is read alone, so each keeps its own edges, boxes
 * and notes: the folder through `readGraph` (src/read-graph.ts), the cluster
 * through `readCluster` (src/read-cluster.ts). The two graphs are then put side
 * by side, and the edges between them are drawn by chant's own catalog pass,
 * `runCatalogPass` from `@intentius/chant/workspace/catalog-edges`, the pass
 * `chant workspace graph` runs over a declared workspace (chant#5097). It is
 * handed the cluster's listed objects and the folder's members as chant read
 * them, each lexicon's `referenceCatalog`, and applies each catalog's
 * `declaredNode` itself, so a ServiceAccount's IRSA annotation reaches an
 * `aws_iam_role` (chant#5099) and an ExternalSecret's key reaches an
 * `aws_secretsmanager_secret` through its store (chant#5098) by the same rules
 * as on files. behold draws no edge of its own here.
 *
 * Of what the pass draws, behold adds the edges between a cluster object and a
 * folder card, and the edges inside the cluster that touch a kind the live read
 * left untyped (below). A pair either read already joins gets no second edge.
 *
 * Placeholders (behold#1082). `outsideRefs` is handed the folder's nodes as the
 * catalog reads them, through `readCluster`'s `held`, so a placeholder for a
 * target the folder declares is not made, and the derived edge stands for it.
 * A target neither source holds stays a placeholder, and the note says what
 * was read.
 *
 * Each card carries `read`, the source it came from: `cluster` (placeholders
 * too, since cluster objects named them) or `folder`.
 *
 * Untyped kinds. The live read keeps an ExternalSecret, a SecretStore and a
 * ClusterSecretStore under their listed type (`external-secrets.io/v1/ExternalSecret`,
 * lexicon `kubernetes`): the k8s lexicon's `kindFor` answers only the kinds it
 * generated, while its catalog's rules are written for
 * `K8s::ExternalSecrets::ExternalSecret`. For the pass only, such a node is
 * handed over under the kind the lexicon's own group rule (`k8sKindByRule`)
 * gives, when that is a kind the k8s catalog names. The drawn card keeps its
 * listed kind.
 *
 * chant's modules are found at run time under specifiers the bundler leaves
 * alone, as src/chant-edges.ts does. Without the pass the two graphs are drawn
 * side by side with no edge between them, and the note says why.
 */
import { basename, resolve } from "node:path";
import type { GraphIR, IREdge, IRNode } from "@intentius/chant";
import { readCluster, type ReadClusterOptions, type ReadClusterResult } from "./read-cluster.ts";
import { readGraph, type ReadGraphResult } from "./read-graph.ts";

/** Where a card of a joined read was read from. `index` and `git` are the cloud index and a GitOps source. */
export type ReadSource = "cluster" | "folder" | "index" | "git";

type Rec = Record<string, unknown>;

/** A lexicon's reference catalog, as far as the joined read touches it. */
export interface JoinCatalog {
  refs: ReadonlyArray<{ from: string; targetKind?: string; indexedTargetKind?: string }>;
  identities: ReadonlyArray<{ kind: string }>;
  scopes?: ReadonlyArray<{ kind: string }>;
  declaredNode?(node: IRNode, block?: IRNode): { kind: string; attrs: Rec; nonLiteral: number } | undefined;
}

/** A node as chant's pass takes it: an IR node with the member that holds it. */
type PassNode = IRNode & { member: string };

/** What `runCatalogPass` answers, as far as this module reads it. */
interface PassResult {
  edges: Array<IREdge & { member?: string; origin?: string; rule?: string }>;
  ambiguous: Array<{ from: string; candidates: string[] }>;
}

export type CatalogPassFn = (nodes: readonly PassNode[], catalogs: ReadonlyArray<{ lexicon: string; catalog: JoinCatalog }>) => PassResult;

export interface JoinDeps {
  /** chant's `runCatalogPass`, or undefined when the chant beside behold has none. */
  catalogPass?: () => Promise<CatalogPassFn | undefined>;
  /** A lexicon's reference catalog by its name, or undefined. */
  catalog?: (lexicon: string) => Promise<JoinCatalog | undefined>;
  /** The k8s lexicon's group rule, listed type to kind, or undefined. */
  kindByRule?: () => Promise<((listedType: string) => string | undefined) | undefined>;
}

export interface ReadJoinedOptions {
  /** The cluster half: everything `readCluster` takes. */
  cluster: ReadClusterOptions;
  /** The folder half: what `behold graph <dir>` reads. */
  dir: string;
  detail?: number;
  deps?: JoinDeps;
}

export interface JoinInfo {
  /** The folder's member names. */
  members: string[];
  /** Edges chant's pass drew between the two, or inside the cluster to an untyped kind. */
  edges: number;
  /** Placeholder cards left: what neither source holds. */
  placeholders: number;
  /** References from a cluster object that name several cards, drawn as no edge. */
  ambiguous: number;
  /** Whether chant's catalog pass was found. */
  pass: boolean;
}

export interface ReadJoinedResult extends ReadClusterResult {
  /** The folder read, for the document's member paths. */
  folder: ReadGraphResult;
  joined: JoinInfo;
}

const CATALOG_PASS = "@intentius/chant/workspace/catalog-edges";
const K8S_LISTED_TYPES = "@intentius/chant-lexicon-k8s/listed-types";

async function lazy(specifier: string): Promise<Rec | undefined> {
  const name: string = specifier;
  try {
    return (await import(/* @vite-ignore */ name)) as Rec;
  } catch {
    return undefined;
  }
}

const defaultDeps: Required<JoinDeps> = {
  catalogPass: async () => {
    const m = await lazy(CATALOG_PASS);
    return typeof m?.runCatalogPass === "function" ? (m.runCatalogPass as CatalogPassFn) : undefined;
  },
  // A lexicon package exports more than one object named for it (its capability plugin, its serializer); the plugin is the one with a catalog.
  catalog: async (lexicon) => {
    const m = await lazy(`@intentius/chant-lexicon-${lexicon}`);
    for (const v of Object.values(m ?? {})) {
      const p = v as { name?: unknown; referenceCatalog?: JoinCatalog } | null;
      if (p && typeof p === "object" && p.name === lexicon && p.referenceCatalog) return p.referenceCatalog;
    }
    return undefined;
  },
  kindByRule: async () => {
    const m = await lazy(K8S_LISTED_TYPES);
    return typeof m?.k8sKindByRule === "function" ? (m.k8sKindByRule as (t: string) => string | undefined) : undefined;
  },
};

/** The member a folder node belongs to: the longest member name its id starts with. */
function memberOf(id: string, names: readonly string[]): string {
  let best = "";
  for (const n of names) if (id.startsWith(`${n}/`) && n.length > best.length) best = n;
  return best || names[0] || "";
}

/** The kinds a catalog's rules and identities name. */
function namedKinds(catalog: JoinCatalog): Set<string> {
  const out = new Set<string>();
  for (const r of catalog.refs) {
    out.add(r.from);
    const t = r.targetKind ?? r.indexedTargetKind;
    if (t) out.add(t);
  }
  for (const i of catalog.identities) out.add(i.kind);
  for (const s of catalog.scopes ?? []) out.add(s.kind);
  return out;
}

/** The manifest tree the k8s catalog reads: a listed object without `apiVersion` and `kind`. */
function observedTree(attrs: Rec | undefined): Rec {
  const { apiVersion: _a, kind: _k, ...rest } = attrs ?? {};
  return rest;
}

/** Two `groups` records joined: lists under one key concatenated, `byStack` boxes kept apart. */
function joinGroups(cluster: Rec, folder: Rec, rename: ReadonlyMap<string, string>): Rec {
  const out: Rec = {};
  for (const key of new Set([...Object.keys(cluster), ...Object.keys(folder)])) {
    const a = (cluster[key] ?? {}) as Record<string, string[]>;
    const b = (folder[key] ?? {}) as Record<string, string[]>;
    const merged: Record<string, string[]> = { ...a };
    for (const [k, list] of Object.entries(b)) {
      const name = key === "byStack" ? (rename.get(k) ?? k) : k;
      merged[name] = [...(merged[name] ?? []), ...list];
    }
    out[key] = merged;
  }
  return out;
}

const stamp = (n: IRNode, read: ReadSource): IRNode => ({ ...n, read }) as IRNode;

/** A read whose every card is marked as read from `source`, for a read of one source with the field a joined read carries. */
export function markRead<T extends { ir: GraphIR }>(read: T, source: ReadSource): T {
  return { ...read, ir: { ...read.ir, nodes: read.ir.nodes.map((n) => stamp(n, source)) } };
}

/** Read a cluster and a folder into one graph. The module header says how. */
export async function readJoined(opts: ReadJoinedOptions): Promise<ReadJoinedResult> {
  const deps = { ...defaultDeps, ...(opts.deps ?? {}) };
  const detail = opts.detail;
  const graphOpts = { ...(detail !== undefined ? { detail } : {}), ...(opts.cluster.context ? { k8sContext: opts.cluster.context } : {}) };

  // The catalog reads every argument, so the members it is handed are read at detail 3; the drawn folder keeps the detail asked for.
  let raw: IRNode[] = [];
  const keep = (ir: GraphIR) => void (raw = structuredClone(ir.nodes));
  const folder = await readGraph(opts.dir, detail === 3 ? { ...graphOpts, composed: keep } : graphOpts);
  if (detail !== 3) await readGraph(opts.dir, { ...graphOpts, detail: 3, composed: keep });
  const names = folder.members.map((m) => m.name);

  const catalogs = new Map<string, JoinCatalog>();
  const catalogOf = async (lexicon: string) => {
    if (!catalogs.has(lexicon)) {
      const c = await deps.catalog(lexicon);
      if (c) catalogs.set(lexicon, c);
    }
    return catalogs.get(lexicon);
  };

  // The folder's nodes as the catalog reads them: what `outsideRefs` counts as held.
  const rawById = new Map(raw.map((n) => [n.id, n]));
  const held: object[] = [];
  for (const n of raw) {
    const view = (await catalogOf(n.lexicon))?.declaredNode?.(n, n.instanceOf !== undefined ? rawById.get(n.instanceOf) : undefined);
    held.push(view ? { id: n.id, kind: view.kind, lexicon: n.lexicon, attrs: view.attrs } : n);
  }

  const cluster = await readCluster({ ...opts.cluster, held });
  const context = cluster.cluster.context;

  // The cluster's listed objects for the pass, with an untyped kind the k8s catalog names handed over under that kind.
  const k8s = await catalogOf("k8s");
  const kindByRule = k8s ? await deps.kindByRule() : undefined;
  const k8sKinds = k8s ? namedKinds(k8s) : new Set<string>();
  const bridged = new Set<string>();
  const clusterNodes: PassNode[] = [];
  for (const n of cluster.ir.nodes) {
    if (n.lexicon === "outside") continue;
    const listedType = (n as { listedType?: string }).listedType;
    const kind = n.lexicon !== "k8s" && listedType && kindByRule ? kindByRule(listedType) : undefined;
    if (kind && k8sKinds.has(kind)) {
      bridged.add(n.id);
      clusterNodes.push({ ...n, kind, lexicon: "k8s", attrs: observedTree(n.attrs as Rec), member: context });
    } else {
      clusterNodes.push({ ...n, member: context });
    }
  }
  const folderNodes: PassNode[] = raw.map((n) => ({ ...n, member: memberOf(n.id, names) }));
  const passNodes = [...clusterNodes, ...folderNodes];
  for (const l of new Set(passNodes.map((n) => n.lexicon))) await catalogOf(l);

  const pass = catalogs.size ? await deps.catalogPass() : undefined;
  const sourceOf = new Map<string, ReadSource>([...cluster.ir.nodes.map((n) => [n.id, "cluster"] as const), ...folder.ir.nodes.map((n) => [n.id, "folder"] as const)]);
  const joined = new Set([...cluster.ir.edges, ...folder.ir.edges].map((e) => `${e.from}\0${e.to}`));
  const added: IREdge[] = [];
  let ambiguous = 0;
  if (pass) {
    const found = pass(passNodes, [...catalogs].map(([lexicon, catalog]) => ({ lexicon, catalog })));
    for (const { member: _m, ...e } of found.edges) {
      const from = sourceOf.get(e.from);
      const to = sourceOf.get(e.to);
      if (!from || !to) continue;
      if (from === to && !(from === "cluster" && (bridged.has(e.from) || bridged.has(e.to)))) continue;
      const key = `${e.from}\0${e.to}`;
      if (joined.has(key)) continue;
      joined.add(key);
      added.push(e);
    }
    ambiguous = found.ambiguous.filter((a) => sourceOf.get(a.from) === "cluster" && a.candidates.some((c) => sourceOf.get(c) === "folder")).length;
  }

  // A folder box named like a namespace box is kept apart.
  const clusterGroups = (cluster.ir.groups ?? {}) as Rec;
  const clusterBoxes = new Set(Object.keys((clusterGroups.byStack ?? {}) as Rec));
  const rename = new Map(names.filter((n) => clusterBoxes.has(n)).map((n) => [n, `${n} (folder)`]));

  const placeholders = cluster.ir.nodes.filter((n) => n.lexicon === "outside").length;
  // The folder as the person named it; its member boxes may be named otherwise.
  const label = basename(resolve(opts.dir));
  const crossing = added.filter((e) => sourceOf.get(e.from) !== sourceOf.get(e.to)).length;
  const joinNote = [
    pass
      ? `joined with ${label}: ${crossing} ${crossing === 1 ? "edge" : "edges"} between cluster objects and its cards, drawn by chant's reference catalog`
      : `joined with ${label}: the chant beside behold has no catalog pass (${CATALOG_PASS}), so no edge joins the cluster to it`,
    placeholders ? `${placeholders} ${placeholders === 1 ? "card stands" : "cards stand"} for what neither the cluster nor ${label} holds` : undefined,
    ambiguous ? `${ambiguous} ${ambiguous === 1 ? "reference names" : "references name"} several of its cards and ${ambiguous === 1 ? "draws" : "draw"} no edge` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  const ir = {
    ...folder.ir,
    ...cluster.ir,
    nodes: [...cluster.ir.nodes.map((n) => stamp(n, "cluster")), ...folder.ir.nodes.map((n) => stamp(n, "folder"))],
    edges: [...cluster.ir.edges, ...folder.ir.edges, ...added],
    groups: joinGroups(clusterGroups, (folder.ir.groups ?? {}) as Rec, rename),
    dangling: [...(cluster.ir.dangling ?? []), ...(folder.ir.dangling ?? [])],
  } as unknown as GraphIR;

  return {
    ir,
    members: [...cluster.members, ...folder.members],
    run: [...cluster.run, ...folder.run],
    meta: { estate: cluster.meta.estate + folder.meta.estate, note: [cluster.meta.note, folder.meta.note, joinNote].filter(Boolean).join(" · ") },
    cluster: cluster.cluster,
    folder,
    joined: { members: names, edges: added.length, placeholders, ambiguous, pass: !!pass },
  };
}
