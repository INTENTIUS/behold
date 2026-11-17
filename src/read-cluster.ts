/**
 * Draw a bare cluster from a kubeconfig context (behold#1083), with no chant
 * project and no directory.
 *
 *     readCluster({ kubeconfig?, context?, namespaces?, types?, allowExecPlugin? })
 *       => Promise<{ ir, members, run, meta, cluster }>
 *
 * There is no reader of behold's own. The read is chant's cloud lister
 * (chant#4532, the one `behold index kubernetes` runs): API discovery, then a
 * paged LIST per served kind, with every request held to the read allowlist.
 * `indexCloud` types the result with the k8s lexicon and derives its edges, and
 * the store is `none`, so nothing is written anywhere. What comes back goes
 * through `readComposed` (src/read-graph.ts, behold#1057), the passes
 * `readGraph` runs over a directory's estate: the declared Kubernetes
 * contracts, chant's derived edges, cluster anchoring. The cards are drawn in
 * a box per namespace, and cluster-scoped objects in a box named `cluster`.
 *
 * Reading a kubeconfig is this module's job and no other module's: `readGraph`
 * still reads none unless a caller hands it a context.
 *
 * Credentials. The lister takes a token, a token file, or a client certificate
 * and key. A user whose entry is an exec plugin (what the GKE, EKS and AKS
 * command line tools write) is refused, naming the context, unless the caller
 * passes `allowExecPlugin`, in which case src/kube-exec.ts runs the plugin and
 * the credential it prints is handed to the lister. An `auth-provider` user is
 * always refused: kubectl removed those, and no plugin stands behind them. The
 * refusal is a policy answer for the maintainer to change (behold#1083), not a
 * limit of the read. Nothing is listed before it.
 *
 * Reference fields. A live read masks every key matching /secret/i, so on
 * chant 0.124.58 an ExternalSecret's `spec.secretStoreRef` reads as `<masked>`
 * and the card says so; chant#5116 keeps such reference fields readable. This
 * module changes nothing for either answer: it draws what the lister returned.
 * The same holds for an Argo CD cluster Secret's name and server, which
 * chant#5116 either exposes or leaves masked.
 *
 * Imports nothing from `hono`. chant's index module is found at run time under
 * a specifier the bundler leaves alone, as src/behold-index.ts does, because a
 * static import pulls chant's plugin loader into dist/cli.js.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type { GraphIR } from "@intentius/chant";
import { parseYAML } from "@intentius/chant/yaml";
import { runExecPlugin, ExecPluginError, type ExecRunner, type ExecUser } from "./kube-exec.ts";
import { readComposed, type ReadGraphResult } from "./read-graph.ts";
import { drawnApps, type ClusterApps, type InferApps } from "./cluster-apps.ts";
// @ts-expect-error plain browser ESM with no declarations
import { outsideRefs } from "../web/outside-refs.js";

const CHANT_CLOUD_INDEX = "@intentius/chant/lifecycle/cloud-index";
const CHANT_LISTER = "@intentius/chant/cloud-lister/index";

type Rec = Record<string, unknown>;

export type ClusterRefusalCode = "exec-plugin" | "auth-provider" | "kubeconfig" | "context" | "chant" | "read";

/** The read would not start, or could not finish, with a message for the person and what to do about it. */
export class ClusterReadRefusal extends Error {
  constructor(
    readonly code: ClusterRefusalCode,
    message: string,
    readonly remedy: string,
  ) {
    super(message);
    this.name = "ClusterReadRefusal";
  }
}

export interface ReadClusterOptions {
  /** The kubeconfig file. Default: the first path in `KUBECONFIG`, then `~/.kube/config`. */
  kubeconfig?: string;
  /** The context. Default: the kubeconfig's `current-context`. */
  context?: string;
  /** Namespaces to list, and `cluster` for cluster-scoped objects. Default: all of them. */
  namespaces?: readonly string[];
  /** Listed types (`apps/v1/Deployment`, `v1/Service`). Default: every listable kind but events and leases. */
  types?: readonly string[];
  /** Run the exec plugin the context's user names. Off: such a context is refused (behold#1083). */
  allowExecPlugin?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  /** behold's version, for the index stamp. */
  version?: string;
  /** Runs the exec plugin; tests pass a fake. */
  runExec?: ExecRunner;
  /** Replaces chant's `indexCloud` and `kubeTargetFromKubeconfig`; tests pass fakes. */
  chant?: ChantLister;
  /**
   * Nodes another source of a joined read holds (behold#1115, src/joined-read.ts),
   * as chant's catalog reads them. A placeholder for a target among them is not made.
   */
  held?: readonly object[];
}

/** The parts of chant's lister this module calls, held loosely. */
export interface ChantLister {
  indexCloud(req: Rec, deps?: Rec): Promise<{ doc: IndexDoc }>;
  noneStore(): Promise<unknown>;
  lexicons(): Promise<unknown[]>;
  kubeTarget(text: string, opts: { context?: string; baseDir?: string }): { server: string; token?: string; tls?: object; contextName: string; clusterName: string };
  /** chant's applications of a read (`inferK8sComponents`, chant#5252), when the chant beside behold has it. */
  inferApps?: InferApps;
}

interface IndexDoc {
  stamp: { observedAt: string; scope: Rec };
  coverage: { listedType: string; location: string; verdict: string; detail?: string }[];
  graph: GraphIR;
  notes?: { kind: string; message: string }[];
}

export interface ClusterInfo {
  /** The kubeconfig context read. */
  context: string;
  /** The kubeconfig's name for its cluster, which the lister's ids carry. */
  cluster: string;
  /** Where the kubeconfig was read from. */
  kubeconfig: string;
  /** When the lister started reading, ISO UTC. */
  observedAt: string;
  /** Kinds the lister could not list, with why (a 403, a kind with no list verb). */
  notListed: { listedType: string; verdict: string; detail?: string }[];
  /** The namespaces read (`--namespace`); absent when the read took every namespace. */
  namespaces?: string[];
}

export interface ReadClusterResult extends ReadGraphResult {
  cluster: ClusterInfo;
  /**
   * The applications chant infers from the read (behold#1132, src/cluster-apps.ts),
   * keyed by the drawn ids. Absent when the chant beside behold has no
   * `inferK8sComponents`.
   */
  apps?: ClusterApps;
}


/** chant's lister and index pipeline, found at run time. */
export async function chantLister(): Promise<ChantLister> {
  const index: string = CHANT_CLOUD_INDEX;
  const lister: string = CHANT_LISTER;
  let mod: Rec;
  let listerMod: Rec;
  try {
    mod = (await import(/* @vite-ignore */ index)) as Rec;
    listerMod = (await import(/* @vite-ignore */ lister)) as Rec;
  } catch (e) {
    throw new ClusterReadRefusal("chant", `the chant beside behold has no cloud lister (${CHANT_CLOUD_INDEX}) or could not load it: ${(e as Error).message}`, "install chant 0.124.54 or newer beside behold and run behold under tsx. Nothing was listed.");
  }
  if (typeof mod.indexCloud !== "function" || typeof listerMod.kubeTargetFromKubeconfig !== "function") {
    throw new ClusterReadRefusal("chant", "the chant beside behold lacks indexCloud or kubeTargetFromKubeconfig", "install chant 0.124.54 or newer beside behold. Nothing was listed.");
  }
  const lexiconsOf = mod.substrateLexicons as (s: string) => Promise<{ lexicons: unknown[] }>;
  const planStore = mod.planIndexStore as (o: Rec) => unknown;
  const openStore = mod.openIndexStore as (plan: unknown, cwd: string) => Promise<unknown>;
  return {
    indexCloud: mod.indexCloud as ChantLister["indexCloud"],
    noneStore: () => openStore(planStore({ store: "none", cwd: process.cwd(), env: {}, defaultStoreDir: () => process.cwd(), command: "behold graph" }), process.cwd()),
    lexicons: async () => (await lexiconsOf("kubernetes")).lexicons,
    kubeTarget: listerMod.kubeTargetFromKubeconfig as ChantLister["kubeTarget"],
    ...(typeof listerMod.inferK8sComponents === "function" ? { inferApps: listerMod.inferK8sComponents as InferApps } : {}),
  };
}

/** The kubeconfig file a read uses, and why. */
export function kubeconfigPath(opts: Pick<ReadClusterOptions, "kubeconfig" | "env" | "home"> = {}): string {
  if (opts.kubeconfig) return resolve(opts.kubeconfig);
  const env = opts.env ?? process.env;
  const first = (env.KUBECONFIG ?? "").split(delimiter).find(Boolean);
  return first ? resolve(first) : join(opts.home ?? homedir(), ".kube", "config");
}

const named = (list: unknown, name: string, field: string): Rec | undefined => {
  for (const e of Array.isArray(list) ? list : []) {
    const o = e as Rec;
    if (o?.name === name) return (o[field] ?? {}) as Rec;
  }
  return undefined;
};

/** A context's refusal, or its user, cluster and the kubeconfig as the lister reads it. */
function inspect(text: string, path: string, wanted: string | undefined) {
  let doc: Rec;
  try {
    doc = parseYAML(text) as Rec;
  } catch (e) {
    throw new ClusterReadRefusal("kubeconfig", `${path} is not a kubeconfig: ${(e as Error).message}`, "name a kubeconfig file with --kubeconfig. Nothing was listed.");
  }
  if (!doc || typeof doc !== "object") throw new ClusterReadRefusal("kubeconfig", `${path} is not a kubeconfig`, "name a kubeconfig file with --kubeconfig. Nothing was listed.");
  const context = wanted ?? (typeof doc["current-context"] === "string" ? (doc["current-context"] as string) : undefined);
  if (!context) throw new ClusterReadRefusal("context", `${path} names no current context and none was given`, "pass --context <name>. Nothing was listed.");
  const ctx = named(doc.contexts, context, "context");
  if (!ctx) throw new ClusterReadRefusal("context", `${path} has no context ${context}`, "pass the name of a context the kubeconfig has. Nothing was listed.");
  const userName = String(ctx.user ?? "");
  const clusterName = String(ctx.cluster ?? "");
  const user = named(doc.users, userName, "user") ?? {};
  const cluster = named(doc.clusters, clusterName, "cluster") ?? {};
  return { doc, context, user, userName, cluster, clusterName };
}

/** The kubeconfig text the lister reads, with an exec user swapped for the credential its plugin printed. */
async function withExecCredential(doc: Rec, found: ReturnType<typeof inspect>, baseDir: string, opts: ReadClusterOptions): Promise<string> {
  const exec = found.user.exec as ExecUser;
  const b64 = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const cred = await runExecPlugin(
    exec,
    { server: String(found.cluster.server ?? ""), ...(b64(found.cluster["certificate-authority-data"]) ? { caData: b64(found.cluster["certificate-authority-data"])! } : {}), ...(found.cluster["insecure-skip-tls-verify"] === true ? { insecureSkipVerify: true } : {}) },
    { baseDir, ...(opts.env ? { env: opts.env } : {}), ...(opts.runExec ? { run: opts.runExec } : {}) },
  );
  const swapped = JSON.parse(JSON.stringify(doc)) as Rec;
  const users = swapped.users as Rec[];
  const entry = users.find((u) => u.name === found.userName)!;
  entry.user = {
    ...(cred.token ? { token: cred.token } : {}),
    ...(cred.clientCertificateData && cred.clientKeyData
      ? { "client-certificate-data": Buffer.from(cred.clientCertificateData).toString("base64"), "client-key-data": Buffer.from(cred.clientKeyData).toString("base64") }
      : {}),
  };
  return JSON.stringify(swapped);
}

/** The refusal for a context whose user runs a plugin, worded for a person who has not ruled either way. */
export function execRefusal(context: string, userName: string, command: string | undefined): ClusterReadRefusal {
  return new ClusterReadRefusal(
    "exec-plugin",
    `context ${context}: user ${userName} authenticates through an exec plugin${command ? ` (${command})` : ""}, and behold does not run a command a kubeconfig names unless you say so`,
    "use a context with a token, a token file or a client certificate (k3d and kind write those), or pass --allow-exec-plugin to let behold run the plugin once and read with the credential it prints. Nothing was listed.",
  );
}

interface ListedNode {
  id: string;
  listedType?: string;
  location?: string;
  attrs?: { metadata?: { name?: string } };
}

/**
 * The ids the picture uses: `<namespace>/<Kind>/<name>`, and `cluster/<Kind>/<name>`
 * for a cluster-scoped object, in place of the lister's `kubernetes/<cluster>/...`
 * ids with their percent-encoded type. Two kinds that share a name in different
 * API groups keep the group in the id (`shop/networking.k8s.io/Ingress/web`).
 */
export function drawnIds(nodes: readonly ListedNode[]): Map<string, string> {
  const parts = (n: ListedNode) => {
    const type = (n.listedType ?? "").split("/");
    const kind = type[type.length - 1] || "Object";
    const group = type.length === 3 ? type[0]! : "";
    const name = n.attrs?.metadata?.name ?? n.id.split("/").pop() ?? n.id;
    return { place: n.location || "cluster", group, kind, name };
  };
  const plain = (p: ReturnType<typeof parts>) => `${p.place}/${p.kind}/${p.name}`;
  const count = new Map<string, number>();
  for (const n of nodes) count.set(plain(parts(n)), (count.get(plain(parts(n))) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const n of nodes) {
    const p = parts(n);
    out.set(n.id, (count.get(plain(p)) ?? 0) > 1 && p.group ? `${p.place}/${p.group}/${p.kind}/${p.name}` : plain(p));
  }
  return out;
}

/** The lister's graph drawn: new ids, a box per namespace, and no edge to a card that was not listed. */
function drawIr(graph: GraphIR): { ir: GraphIR; dropped: number; ids: Map<string, string> } {
  const ids = drawnIds(graph.nodes as unknown as ListedNode[]);
  const idOf = (id: string) => ids.get(id);
  const nodes = graph.nodes.map((n) => ({ ...n, id: idOf(n.id)! }));
  const edges = graph.edges.filter((e) => idOf(e.from) && idOf(e.to)).map((e) => ({ ...e, from: idOf(e.from)!, to: idOf(e.to)! }));
  const byStack: Record<string, string[]> = {};
  for (const n of graph.nodes as unknown as ListedNode[]) (byStack[n.location || "cluster"] ??= []).push(idOf(n.id)!);
  const groups: Record<string, unknown> = { byStack };
  for (const [k, v] of Object.entries((graph.groups ?? {}) as Record<string, Record<string, string[]>>)) {
    if (k !== "byStack") groups[k] = Object.fromEntries(Object.entries(v).map(([key, list]) => [key, list.map((id) => idOf(id)).filter((x): x is string => !!x)]));
  }
  // A namespace the read left out is the box, not a missing target.
  const dangling = (graph.dangling ?? []).filter((d) => !(d.path === "metadata.namespace") && idOf(d.from)).map((d) => ({ ...d, from: idOf(d.from)! }));
  return { ir: { ...graph, nodes, edges, groups, dangling } as unknown as GraphIR, dropped: graph.edges.length - edges.length, ids };
}

/**
 * The lister writes `<masked>` over a sensitive value and chant's typing then
 * writes `[REDACTED]` over the same value in the IR (seen on chant 0.124.58, an
 * ExternalSecret's `spec.secretStoreRef`). outsideRefs knows the first, so the
 * copy it reads says the first.
 */
function maskedAsListed(v: unknown): unknown {
  if (v === "[REDACTED]") return "<masked>";
  if (Array.isArray(v)) return v.map(maskedAsListed);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskedAsListed(x)]));
  return v;
}

interface OutsideResult {
  cards: { id: string; kind: string; label?: string; attrs?: Record<string, unknown> }[];
  edges: { from: string; to: string; viaAttr: string; kind: string }[];
  notes: { code: string; waitsOn?: string }[];
}

/** The longest outside card title drawn whole; past it the card is titled with the name's last part, and its rows hold the whole name. */
const OUTSIDE_TITLE_MAX = 40;

/**
 * The short name an outside card is titled with (behold#1132): an IAM role's
 * name, a Google service account's account part, a repository's name, or the
 * card's label when it fits. The card's rows hold the whole ARN or address
 * (src/operator-cards.ts).
 */
export function outsideTitle(kind: string, attrs: Record<string, unknown>): string | undefined {
  const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  if (kind === "CloudIdentity") {
    if (s(attrs.role)) return s(attrs.role);
    if (s(attrs.email)) return s(attrs.email)!.split("@")[0];
    if (s(attrs.clientId)) return `identity ${s(attrs.clientId)!.slice(0, 8)}`;
  }
  if (s(attrs.repoURL)) {
    const repo = s(attrs.repoURL)!.replace(/\/+$/, "").replace(/\.git$/, "");
    return repo.slice(repo.lastIndexOf("/") + 1) || repo;
  }
  const label = s(attrs.label);
  if (!label) return undefined;
  if (label.length <= OUTSIDE_TITLE_MAX) return label;
  const tail = label.split(/[/\s]/).filter(Boolean).pop() ?? label;
  return tail.length <= OUTSIDE_TITLE_MAX ? tail : `${tail.slice(0, OUTSIDE_TITLE_MAX - 1)}\u2026`;
}

/** The box the placeholder cards sit in. */
export const OUTSIDE_BOX = "Outside the cluster";

/**
 * What the listed objects name outside the cluster (behold#1082,
 * web/outside-refs.js): a ServiceAccount's cloud identity, an ExternalSecret's
 * provider, an Application's repo. The cards go in a box of their own and each
 * edge starts at the drawn card of the object that names it. A field the live
 * read masked gives no card, and is counted so the note can say so.
 */
export function addOutsideCards(ir: GraphIR, held: readonly object[] = []): { ir: GraphIR; cards: number; masked: number } {
  const listed = ir.nodes as unknown as { id: string; attrs?: Record<string, unknown>; listedType?: string }[];
  const key = (group: string, kind: string, ns: string, name: string) => `${group}/${kind}/${ns}/${name}`;
  const idByRef = new Map<string, string>();
  const manifests: Record<string, unknown>[] = [];
  for (const n of listed) {
    if (!n.listedType) continue;
    const type = n.listedType.split("/");
    const kind = type[type.length - 1]!;
    const group = type.length === 3 ? type[0]! : "";
    const version = type[type.length - 2]!;
    const meta = (n.attrs?.metadata ?? {}) as { name?: string; namespace?: string };
    manifests.push({ ...(maskedAsListed(n.attrs ?? {}) as Record<string, unknown>), apiVersion: group ? `${group}/${version}` : version, kind });
    idByRef.set(key(group, kind, kind === "ClusterSecretStore" ? "" : meta.namespace || "default", meta.name ?? ""), n.id);
  }
  const out = outsideRefs(manifests, { graph: { nodes: [...ir.nodes, ...held] } }) as OutsideResult;
  const masked = out.notes.filter((n) => n.code === "masked").length;
  if (!out.cards.length) return { ir, cards: 0, masked };
  const cards = out.cards.map((c) => {
    const attrs: Record<string, unknown> = { ...(c.attrs ?? {}), ...(c.label ? { label: c.label } : {}) };
    const title = outsideTitle(c.kind, attrs);
    return { id: c.id, kind: c.kind, lexicon: "outside", attrs: { ...attrs, ...(title ? { _title: title } : {}) } };
  });
  const edges = out.edges.flatMap((e) => {
    const from = idByRef.get(e.from);
    return from ? [{ from, to: e.to, kind: "ref", viaAttr: e.viaAttr, inferred: true }] : [];
  });
  const groups = { ...(ir.groups ?? {}), byStack: { ...((ir.groups as { byStack?: Record<string, string[]> } | undefined)?.byStack ?? {}), [OUTSIDE_BOX]: cards.map((c) => c.id) } };
  return { ir: { ...ir, nodes: [...ir.nodes, ...cards], edges: [...ir.edges, ...edges], groups } as unknown as GraphIR, cards: cards.length, masked };
}

/** Read the cluster a kubeconfig context points at into behold's graph. The module header says how. */
export async function readCluster(opts: ReadClusterOptions = {}): Promise<ReadClusterResult> {
  const path = kubeconfigPath(opts);
  if (!existsSync(path)) throw new ClusterReadRefusal("kubeconfig", `no kubeconfig at ${path}`, "pass --kubeconfig <file> or set KUBECONFIG. Nothing was listed.");
  const text = readFileSync(path, "utf8");
  const baseDir = dirname(path);
  const found = inspect(text, path, opts.context);

  // The credential rule comes before chant is loaded and before any request.
  let kubeconfigText = text;
  if (found.user["auth-provider"]) {
    throw new ClusterReadRefusal("auth-provider", `context ${found.context}: user ${found.userName} authenticates through an auth-provider, which kubectl no longer supports`, "use a context with a token, a token file or a client certificate, or an exec plugin with --allow-exec-plugin. Nothing was listed.");
  }
  const exec = found.user.exec as ExecUser | undefined;
  if (exec && !opts.allowExecPlugin) throw execRefusal(found.context, found.userName, exec.command);

  const chant = opts.chant ?? (await chantLister());
  if (exec) {
    try {
      kubeconfigText = await withExecCredential(found.doc, found, baseDir, opts);
    } catch (e) {
      if (e instanceof ExecPluginError) throw new ClusterReadRefusal("exec-plugin", `context ${found.context}: the exec plugin gave no credential: ${e.message}`, "run the plugin's command yourself to see its error. Nothing was listed.");
      throw e;
    }
  }
  const target = chant.kubeTarget(kubeconfigText, { context: found.context, baseDir });

  const namespaces = opts.namespaces?.length ? [...opts.namespaces] : undefined;
  let doc: IndexDoc;
  try {
    ({ doc } = await chant.indexCloud({
      scope: { substrate: "kubernetes", scopeId: target.clusterName, locations: namespaces ?? "*", types: opts.types?.length ? [...opts.types] : "*" },
      target: { substrate: "kubernetes", kubernetes: { server: target.server, ...(target.token ? { token: target.token } : {}), ...(target.tls ? { tls: target.tls } : {}) } },
      store: await chant.noneStore(),
      lexicons: await chant.lexicons(),
      ...(opts.version ? { version: opts.version } : {}),
    }));
  } catch (e) {
    throw new ClusterReadRefusal("read", `context ${found.context}: ${(e as Error).message}`, "check that the cluster is reachable and the credential is accepted. Nothing was written.");
  }

  const { ir: drawn, dropped, ids } = drawIr(doc.graph);
  const apps = chant.inferApps ? drawnApps(chant.inferApps(doc.graph), ids) : undefined;
  const members = [{ name: found.context, dir: "", kind: "chant" as const }];
  const composed = await readComposed(drawn, members, [], { k8sContext: found.context });
  const outside = addOutsideCards(composed.ir, opts.held);
  const read = { ...composed, ir: outside.ir };
  const notListed = doc.coverage.filter((c) => c.verdict !== "listed").map((c) => ({ listedType: c.listedType, verdict: c.verdict, ...(c.detail ? { detail: c.detail } : {}) }));
  const clauses = [
    `read from cluster ${found.context}, ${drawn.nodes.length} objects`,
    notListed.length ? `${new Set(notListed.map((n) => n.listedType)).size} kinds not listed (${[...new Set(notListed.map((n) => n.verdict))].join(", ")})` : undefined,
    dropped ? `${dropped} edges to objects outside the read are left out` : undefined,
    outside.cards ? `${outside.cards} ${outside.cards === 1 ? "card" : "cards"} for what the objects name outside the cluster` : undefined,
    apps ? `${apps.ir.nodes.length} ${apps.ir.nodes.length === 1 ? "application" : "applications"}` : undefined,
    outside.masked ? `${outside.masked} reference ${outside.masked === 1 ? "field is masked by the live read and draws" : "fields are masked by the live read and draw"} no card (chant#5116)` : undefined,
  ].filter(Boolean);
  const note = [read.meta.note, clauses.join(" · ")].filter(Boolean).join(" · ");
  return {
    ...read,
    meta: { estate: 1, note },
    cluster: { context: found.context, cluster: target.clusterName, kubeconfig: path, observedAt: doc.stamp.observedAt, notListed, ...(namespaces ? { namespaces } : {}) },
    ...(apps ? { apps } : {}),
  };
}
