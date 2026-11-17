/**
 * #1066: a behold graph snapshot (`{ ir, meta }`, what `/api/graph` answers
 * and what every export snapshot holds) as a `behold-graph/1` document.
 *
 * Pure: the same snapshot and options give byte-identical JSON, because every
 * list keeps the IR's order, every object is built with its keys in one fixed
 * order, and nothing reads a clock. The options carry what the IR does not:
 * which versions wrote it, where the read was rooted, each member's directory
 * (so a card's file can be named from the repository root), and a scrubber
 * for the paths of the machine that read it. src/graph-document-context.ts
 * builds them from a served directory.
 */
import { posix } from "node:path";
import type { GraphIR, IRNode } from "@intentius/chant";
import { cardLabel } from "./card-face.ts";
import {
  GRAPH_DOCUMENT_SCHEMA,
  type GraphCut,
  type GraphDocument,
  type GraphDocumentEdge,
  type GraphDocumentGroup,
  type GraphDocumentNode,
  type GraphDocumentNote,
  type GraphGenerator,
  type GraphOrigin,
  type GraphStatus,
} from "./graph-document.ts";

/** A member of the read, by the name its node ids start with. */
export interface DocumentMember {
  /** Relative to the origin directory, `/`-separated. `.` is the origin itself. */
  dir: string;
  /** Terraform roots in the member, by the name `attrs.root` carries, each relative to the member's directory. */
  roots?: Record<string, string>;
}

export interface ToDocumentOptions {
  generator: GraphGenerator;
  /** Default `{ dir: "." }`. */
  origin?: GraphOrigin;
  /** Default `{ kind: "whole" }`. */
  cut?: GraphCut;
  /** Each member's directory, so a card's file is named from the repository root. Without it, only a node whose `sourceLoc` is relative gets a `file`. */
  members?: Record<string, DocumentMember>;
  /** Keep `attrs.source` (a Terraform root's whole file, on every card from it). Left out by default. */
  source?: boolean;
  /** Applied to every string and key in the document, to take the reading machine's paths out. */
  scrub?: (text: string) => string;
}

/** The snapshot the document is made from: the body of `/api/graph`, without the SVG. */
export interface GraphSnapshot {
  ir: GraphIR;
  meta?: Record<string, unknown> | null;
}

const STATUSES = new Set<GraphStatus>(["good", "warn", "accent", "neutral", "runtime"]);

/**
 * A colour per status, from pinhole's card bars: the dark theme's for the
 * four with a hue, which read on a light page as well, and the light theme's
 * grey for `neutral`, since the dark theme's is meant for a dark card.
 */
export const STATUS_COLOR: Readonly<Record<GraphStatus, string>> = {
  good: "#43DC94",
  warn: "#FF5A5F",
  accent: "#4C8DFF",
  runtime: "#3DD2E0",
  neutral: "#9AA7B8",
};

/** The tool a lexicon's cards are declared with, where its name is not the tool's. */
const TOOL_OF_LEXICON: Readonly<Record<string, string>> = { k8s: "kubernetes" };

/** Plan actions that change nothing, so a card carrying one has no `change`. */
const NO_CHANGE = new Set(["no-op", "read"]);

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** `a/b/../c` joined and normalised, or undefined when it leaves the repository or is absolute. */
function repoPath(...parts: string[]): string | undefined {
  if (parts.some((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p))) return undefined;
  const joined = posix.normalize(posix.join(...parts.map((p) => p.split("\\").join("/"))));
  if (joined === ".." || joined.startsWith("../")) return undefined;
  return joined;
}

/** The member a node belongs to: the longest member name its id starts with, then `/`. */
function memberOf(id: string, names: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const name of names) if (id.startsWith(`${name}/`) && (!best || name.length > best.length)) best = name;
  return best;
}

interface Boxes {
  groups: GraphDocumentGroup[];
  /** Node id to its innermost group id. */
  boxOf: Map<string, string>;
  /** Node id to its `byStack` key, which is what the painter titles cards against. */
  stackOf: Map<string, string>;
}

/**
 * The groups the IR carries, as boxes. A node sits in its stack, a pipeline
 * box nests in the stack holding most of its jobs (as src/render.ts draws
 * it), and a live container (`byContainer`, keyed by the container's node id)
 * nests in whatever holds that node. Each node's `box` is the innermost.
 */
function boxesOf(ir: GraphIR): Boxes {
  const g = (ir.groups ?? {}) as Record<string, Record<string, string[]> | undefined>;
  const groups: GraphDocumentGroup[] = [];
  const boxOf = new Map<string, string>();
  const stackOf = new Map<string, string>();
  const first = (m: Map<string, string>, id: string, v: string) => {
    if (!m.has(id)) m.set(id, v);
  };

  for (const [key, ids] of Object.entries(g.byWave ?? {})) {
    groups.push({ id: `wave:${key}`, title: key, kind: "wave" });
    for (const id of ids) first(boxOf, id, `wave:${key}`);
  }
  // behold#1132: a box the IR titles itself, such as a cluster application's with its health.
  const titles = (ir as { boxTitles?: Record<string, string> }).boxTitles ?? {};
  for (const [key, ids] of Object.entries(g.byStack ?? {})) {
    groups.push({ id: `stack:${key}`, title: titles[key] ?? key, kind: "stack" });
    for (const id of ids) {
      first(stackOf, id, key);
      boxOf.set(id, `stack:${key}`);
    }
  }
  for (const [key, ids] of Object.entries(g.byPipeline ?? {})) {
    const counts = new Map<string, number>();
    for (const id of ids) {
      const s = stackOf.get(id);
      if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    let parent: string | undefined;
    for (const [s, n] of counts) if (!parent || n > counts.get(parent)!) parent = s;
    groups.push({ id: `pipeline:${key}`, title: key, kind: "pipeline", ...(parent ? { parent: `stack:${parent}` } : {}) });
    for (const id of ids) boxOf.set(id, `pipeline:${key}`);
  }
  const containers = Object.entries(g.byContainer ?? {});
  const containerKeys = new Set(containers.map(([k]) => k));
  // A container listed inside another is that one's child; otherwise it sits where its own node does.
  const containerParent = new Map<string, string>();
  for (const [key, ids] of containers) for (const id of ids) if (containerKeys.has(id)) first(containerParent, id, key);
  const containerHome = new Map<string, string | undefined>();
  for (const [key] of containers) containerHome.set(key, containerParent.has(key) ? `container:${containerParent.get(key)}` : boxOf.get(key));
  for (const [key, ids] of containers) {
    const parent = containerHome.get(key);
    groups.push({ id: `container:${key}`, title: key, kind: "container", ...(parent ? { parent } : {}) });
    for (const id of ids) if (!containerKeys.has(id) || containerParent.get(id) === key) boxOf.set(id, `container:${key}`);
  }
  return { groups, boxOf, stackOf };
}

/** The Helm release a node says installs it, from the release card itself or Helm's own marks on an object. */
function helmRelease(node: IRNode): string | undefined {
  const a = node.attrs ?? {};
  if (node.lexicon === "helm") return str(a.release) ?? (node.kind === "Helm::Chart" ? str(a.name) : undefined);
  const meta = rec(a.metadata);
  return str(rec(meta?.annotations)?.["meta.helm.sh/release-name"]);
}

function namespaceOf(node: IRNode): string | undefined {
  const a = node.attrs ?? {};
  return str(rec(a.metadata)?.namespace) ?? (node.lexicon === "k8s" ? str(a.namespace) : undefined);
}

function fileOf(node: IRNode, origin: string, member: DocumentMember | undefined): { file?: string; line?: number } {
  const a = node.attrs ?? {};
  const line = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 0 ? { line: n } : {});
  const root = str(a.root);
  const tfFile = str(a.file);
  if (root && tfFile && member?.roots && member.roots[root] !== undefined) {
    const file = repoPath(origin, member.dir, member.roots[root], tfFile);
    return file ? { file, ...line(a.line) } : {};
  }
  const loc = node.sourceLoc?.file;
  if (loc) {
    const file = repoPath(origin, member?.dir ?? ".", loc);
    return file ? { file, ...line(node.sourceLoc?.line) } : {};
  }
  return {};
}

/** A string keeps `scrub`'s rewrite; an object has its keys and values rewritten; anything else is kept. */
function scrubDeep(v: unknown, scrub: (s: string) => string): unknown {
  if (typeof v === "string") return scrub(v);
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, scrub));
  if (v !== null && typeof v === "object") {
    const out: Rec = {};
    for (const [k, x] of Object.entries(v)) out[scrub(k)] = scrubDeep(x, scrub);
    return out;
  }
  return v;
}

function documentNode(node: IRNode, boxes: Boxes, opts: ToDocumentOptions, members: readonly string[]): GraphDocumentNode {
  const a = node.attrs ?? {};
  const member = memberOf(node.id, members);
  const where = fileOf(node, opts.origin?.dir ?? ".", member ? opts.members?.[member] : undefined);
  const plan = rec(a._plan);
  const action = str(plan?.action);
  const status = typeof a._status === "string" && STATUSES.has(a._status as GraphStatus) ? (a._status as GraphStatus) : undefined;
  const drift = rec(a._drift);
  const mainstat = str(drift?.label) ?? (action && !NO_CHANGE.has(action) ? action : undefined);
  const stackOf = Array.isArray(a._stackOf) ? a._stackOf.map((m) => str(rec(m)?.id)).filter((id): id is string => !!id) : [];
  const box = boxes.boxOf.get(node.id);
  const { source: _source, ...rest } = a;
  const attrs = opts.source ? a : rest;
  const root = str(a.root);
  const namespace = namespaceOf(node);
  const release = helmRelease(node);
  const read = (node as { read?: unknown }).read;
  return {
    id: node.id,
    title: cardLabel(node, boxes.stackOf.get(node.id)) ?? node.id,
    subtitle: TOOL_OF_LEXICON[node.lexicon] ?? node.lexicon,
    kind: node.kind,
    lexicon: node.lexicon,
    ...(box ? { box } : {}),
    ...where,
    ...(action && !NO_CHANGE.has(action) ? { change: action } : {}),
    ...(status ? { status, color: STATUS_COLOR[status] } : {}),
    ...(mainstat ? { mainstat } : {}),
    ...(stackOf.length ? { secondarystat: `${stackOf.length} cards`, stackOf } : {}),
    ...(member ? { detail__member: member } : {}),
    ...(root ? { detail__root: root } : {}),
    ...(namespace ? { detail__namespace: namespace } : {}),
    ...(release ? { detail__release: release } : {}),
    ...(isReadSource(read) ? { read } : {}),
    attrs,
  };
}

const READ_SOURCES: ReadonlySet<unknown> = new Set(["cluster", "folder", "git"]);
const isReadSource = (v: unknown): v is NonNullable<GraphDocumentNode["read"]> => READ_SOURCES.has(v);

/** The rule an inferred edge was drawn by: chant's catalog rule, or the behold pass that joined it. */
function ruleOf(e: Rec): string | undefined {
  // chant's catalog rule, on its joined edge and on the edges behold draws for a reference of that rule that found no target or several (behold#1080).
  if ((e.origin === "derived" || e.dangling === true || (typeof e.ambiguous === "object" && e.ambiguous !== null)) && str(e.rule)) return e.rule as string;
  const join = str(e.join);
  return join ? `behold:${join}` : undefined;
}

/** The graph snapshot as a `behold-graph/1` document. */
export function toDocument(snapshot: GraphSnapshot, opts: ToDocumentOptions): GraphDocument {
  const { ir, meta } = snapshot;
  const boxes = boxesOf(ir);
  const members = Object.keys(opts.members ?? {});
  const nodes = ir.nodes.map((n) => documentNode(n, boxes, opts, members));
  const ids = new Set(nodes.map((n) => n.id));

  const edges: GraphDocumentEdge[] = [];
  const taken = new Map<string, number>();
  let dropped = 0;
  for (const raw of ir.edges) {
    const e = raw as unknown as Rec;
    const source = raw.from;
    const target = raw.to;
    if (!ids.has(source) || !ids.has(target)) {
      dropped++;
      continue;
    }
    const via = str(e.viaAttr);
    const base = `${source}->${target}:${raw.kind}${via ? `:${via}` : ""}`;
    const n = (taken.get(base) ?? 0) + 1;
    taken.set(base, n);
    const rule = ruleOf(e);
    const inferred = e.inferred === true || e.origin === "derived";
    edges.push({
      id: n === 1 ? base : `${base}#${n}`,
      source,
      target,
      kind: raw.kind,
      inferred,
      ...(inferred && rule ? { rule } : {}),
      ...(via ? { via } : {}),
      ...(str(e.field) ? { field: e.field as string } : {}),
    });
  }

  const notes: GraphDocumentNote[] = [];
  const note = str(meta?.note);
  if (note) notes.push({ kind: "view", text: note, ...(str(meta?.noteShort) ? { short: meta!.noteShort as string } : {}) });
  if (dropped) notes.push({ kind: "edges-left-out", text: `${dropped} edge${dropped === 1 ? "" : "s"} named a card this view does not draw and ${dropped === 1 ? "was" : "were"} left out`, count: dropped });

  const doc: GraphDocument = {
    schema: GRAPH_DOCUMENT_SCHEMA,
    generator: { behold: opts.generator.behold, ...(opts.generator.chant ? { chant: opts.generator.chant } : {}) },
    origin: { dir: opts.origin?.dir ?? ".", ...(opts.origin?.rev ? { rev: opts.origin.rev } : {}) },
    cut: opts.cut ?? { kind: "whole" },
    nodes,
    edges,
    groups: boxes.groups,
    notes,
  };
  return opts.scrub ? (scrubDeep(doc, opts.scrub) as GraphDocument) : doc;
}
