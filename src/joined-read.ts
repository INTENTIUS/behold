/**
 * One graph of a live cluster and a folder that declares what it uses
 * (behold#1115): `behold graph --context <ctx> <dir>`, the GitOps sources
 * its apps deploy from (behold#1123): `--git <clone>`, and the cloud index of
 * the account it runs in (behold#1123): `--index aws`.
 *
 *     readJoined({ cluster, dir?, git?, index?, detail? }) => Promise<ReadJoinedResult>
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
 * too, since cluster objects named them), `folder`, `index` or `git`.
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
 * GitOps sources (behold#1123). Given `git`, the local clones the caller
 * named, each Argo CD Application and Flux Kustomization the cluster holds has
 * the path it deploys from read as a folder (src/gitops-source.ts says how the
 * path and the clone are found; nothing is fetched). The cards are drawn with
 * their ids under `<app>/git/`, in a box named `<app> from git`, beside the
 * live objects, with `read: "git"`. They are not handed to the catalog pass:
 * what joins a git manifest to the live object it declares is the drift
 * against git (behold#1118). The clone's working tree is read, and the note
 * names the revision the app tracks.
 *
 * The cluster's own resource (behold#1123). A folder that declares the cluster
 * the context serves (an `aws_eks_cluster`, a `google_container_cluster`, an
 * `azurerm_kubernetes_cluster`, or a chant kind in `MANAGED_CLUSTER_KINDS`)
 * has its card joined to the context: an edge from it to each Namespace the
 * read listed, `viaAttr: "runs-on"`, and `joined.cluster` names it. The match
 * is the one src/k8s-target.ts `contextBindsCluster` makes, on the cluster's
 * literal name as chant's catalog reads it (its identity rule is `name`)
 * against two names the kubeconfig gives: the context and the cluster entry
 * the context points at. Each provider's tool embeds the cluster name in
 * both: `aws eks update-kubeconfig` names the entry by the cluster's ARN
 * (`arn:aws:eks:<region>:<account>:cluster/<name>`), and the context too
 * unless `--alias` renames it; `gcloud` writes
 * `gke_<project>_<location>_<name>`; `az aks get-credentials` writes the
 * name. The server URL is not compared, because a folder does not hold the
 * endpoint a cloud assigns. One match joins; none or several join nothing,
 * and the note says which.
 *
 * The cloud index (behold#1123). Given `index`, the substrates named (`aws`,
 * `azure`, `gcp`), the newest version of each scope of that substrate in the
 * index stores is read: behold's per-user store, where `behold index` writes
 * (src/behold-index.ts), and with a folder its project's `local` and
 * `git-ref` stores (src/graph-db/sources.ts finds them). The read lists
 * nothing and uses no cloud credential: the index is filled only when the
 * person runs `behold index <substrate>`, and a substrate with no version
 * stored is named in a note that says so. Its nodes go to the pass beside the
 * cluster's through chant's `indexedMemberNodes` (chant#5245), each in the
 * member its document's scope key names, where chant's rules join a
 * ServiceAccount's IRSA annotation to the `AWS::IAM::Role` of that ARN and an
 * ExternalSecret's key to the `AWS::SecretsManager::Secret` in its store's
 * region. They join `held` as the folder's do, so no placeholder is made for
 * what the index holds. An account holds far more than the cluster names, so
 * only the indexed resources an edge from the cluster or the folder reaches
 * are drawn, in a box per scope, `<substrate> <scope> (index)`; the note says
 * how many were read and how many drawn. The lexicon that types the
 * substrate (`@intentius/chant-lexicon-aws` for aws) gives the pass the
 * resource's identities; without it the note says so.
 *
 * chant's modules are found at run time under specifiers the bundler leaves
 * alone, as src/chant-edges.ts does. Without the pass the two graphs are drawn
 * side by side with no edge between them, and the note says why.
 */
import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { GraphIR, IREdge, IRNode } from "@intentius/chant";
import { managedClusterName, MANAGED_CLUSTER_KINDS } from "./cluster-anchor.ts";
import { cloneFor, gitOpsSources, type GitClone, type GitOpsSource, type GitPathRule, type SourceNode } from "./gitops-source.ts";
import { findGitIndex, findIndexDir, LOCAL_INDEX_DIR, userIndexDir, type Found } from "./graph-db/sources.ts";
import type { IndexDocument } from "./graph-db/types.ts";
import { contextBindsCluster } from "./k8s-target.ts";
import { readCluster, type ReadClusterOptions, type ReadClusterResult } from "./read-cluster.ts";
import { readGraph, type ReadGraphResult } from "./read-graph.ts";

/** Where a card of a joined read was read from: the cluster, the folder, the cloud index, or a GitOps source's path in git. */
export type ReadSource = "cluster" | "folder" | "index" | "git";

/** The substrates `--index` reads. */
export const INDEX_SUBSTRATES = ["aws", "azure", "gcp"] as const;
export type IndexSubstrate = (typeof INDEX_SUBSTRATES)[number];

/** An index version found in a store. */
export interface StoredIndex {
  doc: IndexDocument;
  /** The file or ref it was read from. */
  from: string;
  version: string;
}

type Rec = Record<string, unknown>;

/** A lexicon's reference catalog, as far as the joined read touches it. */
export interface JoinCatalog {
  refs: ReadonlyArray<{ from: string; targetKind?: string; indexedTargetKind?: string }>;
  identities: ReadonlyArray<{ kind: string }>;
  scopes?: ReadonlyArray<{ kind: string }>;
  declaredNode?(node: IRNode, block?: IRNode): { kind: string; attrs: Rec; nonLiteral: number } | undefined;
  /** The repository paths a node names (chant#5102): an Argo CD Application's source paths. */
  pathRefs?: GitPathRule[];
}

/** A node as chant's pass takes it: an IR node with the member that holds it. */
type PassNode = IRNode & { member: string };

/** What `runCatalogPass` answers, as far as this module reads it. */
interface PassResult {
  edges: Array<IREdge & { member?: string; origin?: string; rule?: string }>;
  ambiguous: Array<{ from: string; candidates: string[] }>;
}

export type CatalogPassFn = (nodes: readonly PassNode[], catalogs: ReadonlyArray<{ lexicon: string; catalog: JoinCatalog }>) => PassResult;

/** chant's `indexedMemberNodes` (chant#5245): an index document's nodes, each in the member its scope key names. */
export type IndexedMemberNodesFn = (doc: IndexDocument) => PassNode[];

export interface JoinDeps {
  /** chant's `runCatalogPass`, or undefined when the chant beside behold has none. */
  catalogPass?: () => Promise<CatalogPassFn | undefined>;
  /** A lexicon's reference catalog by its name, or undefined. */
  catalog?: (lexicon: string) => Promise<JoinCatalog | undefined>;
  /** The k8s lexicon's group rule, listed type to kind, or undefined. */
  kindByRule?: () => Promise<((listedType: string) => string | undefined) | undefined>;
  /** chant's `indexedMemberNodes`, or undefined when the chant beside behold has none. */
  indexedNodes?: () => Promise<IndexedMemberNodesFn | undefined>;
  /** The newest version of each scope of `substrate` in the index stores, with the stores looked in. `dir` is the folder, when one was read. */
  indexes?: (substrate: IndexSubstrate, dir?: string) => { found: StoredIndex[]; stores: string[] };
}

export interface ReadJoinedOptions {
  /** The cluster half: everything `readCluster` takes. */
  cluster: ReadClusterOptions;
  /** The folder half: what `behold graph <dir>` reads. Left out, no folder is read. */
  dir?: string;
  /**
   * The local clones the GitOps sources are read from (behold#1123). Given,
   * each Argo CD Application and Flux Kustomization the cluster holds has its
   * path read from the clone that holds its repository; nothing is fetched.
   */
  git?: readonly GitClone[];
  /** The substrates whose stored cloud index joins the read (behold#1123). Nothing is listed: the newest stored version of each scope is read. */
  index?: readonly IndexSubstrate[];
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
  /** The folder card of the cluster the context serves (behold#1123), when the folder declares it. */
  cluster?: string;
  /** With `git`: each GitOps source found, the clone it was read from and the cards it gave. */
  git?: GitRead[];
  /** With `index`: each index version read, and how many of its resources were drawn. */
  index?: IndexRead[];
}

/** An index version a joined read took in. */
export interface IndexRead {
  substrate: string;
  /** The account, subscription or project. */
  scopeId: string;
  scopeKey: string;
  version: string;
  from: string;
  observedAt: string;
  /** Resources the version holds. */
  nodes: number;
  /** Of those, the ones drawn: what an edge from the cluster or the folder reaches. */
  drawn: number;
}

/** A GitOps source of a joined read, with what was read for it. */
export interface GitRead extends GitOpsSource {
  /** The clone that holds the repository; absent when none does. */
  clone?: string;
  /** Cards read from the path: 0 when it was not read. */
  cards: number;
}

export interface ReadJoinedResult extends ReadClusterResult {
  /** The folder read, for the document's member paths; absent when no folder was read. */
  folder?: ReadGraphResult;
  joined: JoinInfo;
}

const CATALOG_PASS = "@intentius/chant/workspace/catalog-edges";
/** The release that ships `indexedMemberNodes` and the k8s rules to indexed resources (chant#5245). */
export const INDEXED_NODES_CHANT = "0.124.104";
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
  indexedNodes: async () => {
    const m = await lazy(CATALOG_PASS);
    return typeof m?.indexedMemberNodes === "function" ? (m.indexedMemberNodes as IndexedMemberNodesFn) : undefined;
  },
  indexes: (substrate, dir) => storedIndexes(substrate, dir),
};

/** The newest version of each scope of `substrate`: behold's per-user store, and with a folder its project's `local` and `git-ref` stores. */
export function storedIndexes(substrate: IndexSubstrate, dir?: string, env: NodeJS.ProcessEnv = process.env): { found: StoredIndex[]; stores: string[] } {
  const found: Found = { documents: [], notes: [] };
  const stores = [userIndexDir(env)];
  findIndexDir(stores[0]!, found);
  if (dir !== undefined) {
    stores.push(join(dir, LOCAL_INDEX_DIR));
    findIndexDir(join(dir, LOCAL_INDEX_DIR), found);
    findGitIndex(dir, found);
  }
  // One version per scope: the newest, whichever store holds it (version names sort in time order).
  const newest = new Map<string, StoredIndex>();
  for (const d of found.documents) {
    if (d.kind !== "index") continue;
    const scope = d.doc.stamp.scope as { kind?: string; substrate?: string };
    if (scope.kind !== "cloud" || scope.substrate !== substrate) continue;
    const had = newest.get(d.doc.stamp.scopeKey);
    if (!had || had.version < d.version) newest.set(d.doc.stamp.scopeKey, { doc: d.doc, from: d.from, version: d.version });
  }
  return { found: [...newest.values()], stores };
}

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

/** The kinds of a cluster's own resource: the Terraform providers' and the chant lexicons'. */
export const CLUSTER_RESOURCE_KINDS: ReadonlySet<string> = new Set(["aws_eks_cluster", "google_container_cluster", "azurerm_kubernetes_cluster", ...MANAGED_CLUSTER_KINDS]);

/** Where the read cluster is among a folder's nodes: the one whose name the context binds, and how many clusters there were to choose from. */
export function contextCluster(nodes: ReadonlyArray<{ id: string; kind: string; attrs?: Rec }>, names: readonly string[]): { id?: string; declared: number; matched: string[] } {
  const clusters = nodes.filter((n) => CLUSTER_RESOURCE_KINDS.has(n.kind));
  const matched = clusters
    .filter((n) => {
      const name = managedClusterName(n);
      return name !== n.id && names.some((k) => contextBindsCluster(k, name) === true);
    })
    .map((n) => n.id);
  return { ...(matched.length === 1 ? { id: matched[0] } : {}), declared: clusters.length, matched };
}

const stamp = (n: IRNode, read: ReadSource): IRNode => ({ ...n, read }) as IRNode;

/** A read whose every card is marked as read from `source`, for a read of one source with the field a joined read carries. */
export function markRead<T extends { ir: GraphIR }>(read: T, source: ReadSource): T {
  return { ...read, ir: { ...read.ir, nodes: read.ir.nodes.map((n) => stamp(n, source)) } };
}

/** A git read's graph with every id under `<app>/git/`, and every card in one box for the app. */
function underApp(ir: GraphIR, app: string, box: string): { nodes: IRNode[]; edges: IREdge[]; groups: Rec; dangling: unknown[] } {
  const id = (x: string) => `${app}/git/${x}`;
  const groups: Rec = { byStack: { [box]: ir.nodes.map((n) => id(n.id)) } };
  for (const [k, v] of Object.entries((ir.groups ?? {}) as Record<string, Record<string, string[]>>)) {
    if (k !== "byStack") groups[k] = Object.fromEntries(Object.entries(v).map(([key, list]) => [key, list.map(id)]));
  }
  return {
    nodes: ir.nodes.map((n) => ({ ...n, id: id(n.id), ...(n.instanceOf !== undefined ? { instanceOf: id(n.instanceOf) } : {}) }) as IRNode),
    edges: ir.edges.map((e) => ({ ...e, from: id(e.from), to: id(e.to) })),
    groups,
    dangling: (ir.dangling ?? []).map((d) => ({ ...d, from: id(d.from) })),
  };
}

/** Read a cluster with a folder, the GitOps sources its apps name, or both, into one graph. The module header says how. */
export async function readJoined(opts: ReadJoinedOptions): Promise<ReadJoinedResult> {
  const deps = { ...defaultDeps, ...(opts.deps ?? {}) };
  const detail = opts.detail;
  const graphOpts = { ...(detail !== undefined ? { detail } : {}), ...(opts.cluster.context ? { k8sContext: opts.cluster.context } : {}) };

  // The catalog reads every argument, so the members it is handed are read at detail 3; the drawn folder keeps the detail asked for.
  let raw: IRNode[] = [];
  const keep = (ir: GraphIR) => void (raw = structuredClone(ir.nodes));
  let folder: ReadGraphResult | undefined;
  if (opts.dir !== undefined) {
    folder = await readGraph(opts.dir, detail === 3 ? { ...graphOpts, composed: keep } : graphOpts);
    if (detail !== 3) await readGraph(opts.dir, { ...graphOpts, detail: 3, composed: keep });
  }
  const folderIr = folder?.ir ?? ({ nodes: [], edges: [], groups: {} } as unknown as GraphIR);
  const names = folder?.members.map((m) => m.name) ?? [];

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
  // The cloud index: its nodes join `held`, so a placeholder is not made for what the index holds, and the pass below.
  const indexNodes: PassNode[] = [];
  const indexReads: IndexRead[] = [];
  const indexNotes: string[] = [];
  const boxOf = new Map<string, string>();
  if (opts.index?.length) {
    const toNodes = await deps.indexedNodes();
    for (const substrate of new Set(opts.index)) {
      const { found, stores } = deps.indexes(substrate, opts.dir);
      if (!found.length) {
        indexNotes.push(`no ${substrate} index is stored (looked in ${stores.join(", ")}): run behold index ${substrate} to fill one`);
        continue;
      }
      if (!toNodes) {
        indexNotes.push(`the chant beside behold has no indexedMemberNodes (${CATALOG_PASS}, chant ${INDEXED_NODES_CHANT}), so the ${substrate} index is not joined`);
        continue;
      }
      // The newest read of a resource wins when two scopes of one account hold it.
      found.sort((a, b) => (a.doc.stamp.observedAt < b.doc.stamp.observedAt ? 1 : a.doc.stamp.observedAt > b.doc.stamp.observedAt ? -1 : 0));
      for (const f of found) {
        const scopeId = (f.doc.stamp.scope as { scopeId?: string }).scopeId ?? f.doc.stamp.scopeKey;
        const box = `${substrate} ${scopeId} (index)`;
        const nodes = toNodes(f.doc).filter((n) => !boxOf.has(n.id));
        for (const n of nodes) boxOf.set(n.id, box);
        indexNodes.push(...nodes);
        indexReads.push({ substrate, scopeId, scopeKey: f.doc.stamp.scopeKey, version: f.version, from: f.from, observedAt: f.doc.stamp.observedAt, nodes: f.doc.graph.nodes.length, drawn: 0 });
      }
    }
    held.push(...indexNodes);
  }

  const cluster = await readCluster({ ...opts.cluster, held });
  const context = cluster.cluster.context;

  // The cluster's own resource: matched on the names it was declared with, drawn on the card the folder shows.
  const drawnFolder = new Set(folderIr.nodes.map((n) => n.id));
  const views = held as Array<{ id: string; kind: string; attrs?: Rec }>;
  const own = contextCluster(views.filter((v) => drawnFolder.has(v.id)), [context, cluster.cluster.cluster]);
  const anchors: IREdge[] = [];
  if (own.id) {
    for (const n of cluster.ir.nodes) {
      if (n.kind === "K8s::Core::Namespace" || (n as { listedType?: string }).listedType === "v1/Namespace") {
        anchors.push({ from: own.id, to: n.id, kind: "ref", viaAttr: "runs-on", inferred: true, join: "context" } as unknown as IREdge);
      }
    }
  }

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

  // The GitOps sources: each app's path, read from the clone the caller named, as a folder of its own.
  const gitReads: GitRead[] = [];
  const gitNotes: string[] = [];
  const gitParts: Array<ReturnType<typeof underApp>> = [];
  if (opts.git) {
    for (const src of gitOpsSources(clusterNodes as unknown as SourceNode[], k8s?.pathRefs ?? [])) {
      const where = `${src.path || "."} in ${src.repo}`;
      const clone = cloneFor(src.repo, opts.git);
      const entry: GitRead = { ...src, cards: 0 };
      gitReads.push(entry);
      if (!clone) {
        gitNotes.push(`${src.app} deploys from ${src.repo}, which no --git clone holds, so it is not read (behold fetches nothing: pass --git <dir> or --git <url>=<dir>)`);
        continue;
      }
      entry.clone = clone;
      const dir = join(clone, src.path);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        gitNotes.push(`${src.app} deploys from ${where}, and ${clone} has no directory ${src.path || "."}`);
        continue;
      }
      let read: ReadGraphResult;
      try {
        read = await readGraph(dir, graphOpts);
      } catch (e) {
        gitNotes.push(`${src.app} deploys from ${where}, which could not be read: ${(e as Error).message}`);
        continue;
      }
      const part = underApp(read.ir, src.app, `${src.app} from git`);
      gitParts.push(part);
      entry.cards = part.nodes.length;
      gitNotes.push(
        `${part.nodes.length} ${part.nodes.length === 1 ? "card" : "cards"} of ${src.app} from git (${src.path || "."} in the working tree of ${clone}${src.revision ? `; the app tracks ${src.revision}` : ""})`,
      );
    }
  }

  const folderNodes: PassNode[] = raw.map((n) => ({ ...n, member: memberOf(n.id, names) }));
  const passNodes = [...clusterNodes, ...folderNodes, ...indexNodes];
  for (const l of new Set(passNodes.map((n) => n.lexicon))) await catalogOf(l);
  for (const l of new Set(indexNodes.map((n) => n.lexicon))) {
    if (!catalogs.has(l)) indexNotes.push(`@intentius/chant-lexicon-${l} is not installed beside behold, so its indexed resources are matched by no identity of theirs`);
  }

  const pass = catalogs.size ? await deps.catalogPass() : undefined;
  const sourceOf = new Map<string, ReadSource>([
    ...cluster.ir.nodes.map((n) => [n.id, "cluster"] as const),
    ...folderIr.nodes.map((n) => [n.id, "folder"] as const),
    ...indexNodes.map((n) => [n.id, "index"] as const),
  ]);
  const joined = new Set([...cluster.ir.edges, ...folderIr.edges, ...anchors].map((e) => `${e.from}\0${e.to}`));
  const added: IREdge[] = [];
  let ambiguous = 0;
  if (pass && (folder || indexNodes.length)) {
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
    ambiguous = found.ambiguous.filter((a) => sourceOf.get(a.from) === "cluster" && a.candidates.some((c) => sourceOf.get(c) === "folder" || sourceOf.get(c) === "index")).length;
  }

  // The indexed resources an edge reaches are drawn, each in its scope's box.
  const drawnIndex = new Set(added.flatMap((e) => [e.from, e.to]).filter((id) => sourceOf.get(id) === "index"));
  const indexCards = indexNodes.filter((n) => drawnIndex.has(n.id)).map(({ member: _m, ...n }) => n as IRNode);
  const indexBoxes: Record<string, string[]> = {};
  for (const n of indexCards) (indexBoxes[boxOf.get(n.id)!] ??= []).push(n.id);
  for (const r of indexReads) r.drawn = indexNodes.filter((n) => n.member === r.scopeKey && drawnIndex.has(n.id)).length;
  if (indexReads.length) {
    const read = indexReads.reduce((t, r) => t + r.nodes, 0);
    const toIndex = added.filter((e) => sourceOf.get(e.to) === "index" && sourceOf.get(e.from) !== "index").length;
    indexNotes.unshift(
      `joined with the ${[...new Set(indexReads.map((r) => r.substrate))].join(" and ")} index (${indexReads.map((r) => `${r.scopeId} as of ${r.observedAt}`).join(", ")}): ${read} indexed ${read === 1 ? "resource" : "resources"} read, ${indexCards.length} drawn, ${toIndex} ${toIndex === 1 ? "edge" : "edges"} to ${indexCards.length === 1 ? "it" : "them"} drawn by chant's reference catalog`,
    );
  }

  // A folder box named like a namespace box is kept apart.
  const clusterGroups = (cluster.ir.groups ?? {}) as Rec;
  const clusterBoxes = new Set(Object.keys((clusterGroups.byStack ?? {}) as Rec));
  const rename = new Map(names.filter((n) => clusterBoxes.has(n)).map((n) => [n, `${n} (folder)`]));

  const placeholders = cluster.ir.nodes.filter((n) => n.lexicon === "outside").length;
  // The folder as the person named it; its member boxes may be named otherwise.
  const label = opts.dir !== undefined ? basename(resolve(opts.dir)) : "";
  const crossing = added.filter((e) => sourceOf.get(e.from) !== sourceOf.get(e.to) && (sourceOf.get(e.from) === "folder" || sourceOf.get(e.to) === "folder")).length;
  const joinNote = folder
    ? [
        pass
          ? `joined with ${label}: ${crossing} ${crossing === 1 ? "edge" : "edges"} between cluster objects and its cards, drawn by chant's reference catalog`
          : `joined with ${label}: the chant beside behold has no catalog pass (${CATALOG_PASS}), so no edge joins the cluster to it`,
        placeholders ? `${placeholders} ${placeholders === 1 ? "card stands" : "cards stand"} for what neither the cluster nor ${label} holds` : undefined,
        ambiguous ? `${ambiguous} ${ambiguous === 1 ? "reference names" : "references name"} several of its cards and ${ambiguous === 1 ? "draws" : "draw"} no edge` : undefined,
        own.id
          ? `cluster ${context} is ${own.id}`
          : own.matched.length > 1
            ? `cluster ${context} is named by ${own.matched.length} of its clusters (${own.matched.join(", ")}), so none is joined to it`
            : own.declared
              ? `${label} declares ${own.declared} ${own.declared === 1 ? "cluster" : "clusters"}, and the context names none of them`
              : undefined,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  const indexNote = indexNotes.join(" · ") || undefined;
  const gitNote = opts.git && !gitReads.length ? "no Argo CD Application or Flux Kustomization in the read names a git path" : gitNotes.join(" · ") || undefined;

  let groups = joinGroups(clusterGroups, (folderIr.groups ?? {}) as Rec, rename);
  for (const part of gitParts) groups = joinGroups(groups, part.groups, new Map());
  if (indexCards.length) groups = joinGroups(groups, { byStack: indexBoxes }, new Map());
  const ir = {
    ...folderIr,
    ...cluster.ir,
    nodes: [
      ...cluster.ir.nodes.map((n) => stamp(n, "cluster")),
      ...folderIr.nodes.map((n) => stamp(n, "folder")),
      ...indexCards.map((n) => stamp(n, "index")),
      ...gitParts.flatMap((p) => p.nodes.map((n) => stamp(n, "git"))),
    ],
    edges: [...cluster.ir.edges, ...folderIr.edges, ...anchors, ...added, ...gitParts.flatMap((p) => p.edges)],
    groups,
    dangling: [...(cluster.ir.dangling ?? []), ...(folderIr.dangling ?? []), ...gitParts.flatMap((p) => p.dangling)],
  } as unknown as GraphIR;

  return {
    ir,
    members: [...cluster.members, ...(folder?.members ?? [])],
    run: [...cluster.run, ...(folder?.run ?? [])],
    meta: { estate: cluster.meta.estate + (folder?.meta.estate ?? 0), note: [cluster.meta.note, folder?.meta.note, joinNote, indexNote, gitNote].filter(Boolean).join(" · ") },
    cluster: cluster.cluster,
    ...(cluster.apps ? { apps: cluster.apps } : {}),
    ...(folder ? { folder } : {}),
    joined: { members: names, edges: added.length, placeholders, ambiguous, pass: !!pass, ...(own.id ? { cluster: own.id } : {}), ...(opts.index?.length ? { index: indexReads } : {}), ...(opts.git ? { git: gitReads } : {}) },
  };
}
