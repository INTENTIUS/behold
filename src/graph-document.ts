/**
 * behold-graph/1 (#1066): the graph document other programs read.
 *
 * A dashboard, a portal, the single-file viewer, the editor extension and a
 * cut all read one file, so behold writes one shape and versions it. Nodes
 * and edges are flat lists whose field names are the ones Grafana's node
 * graph panel takes (`id`, `title`, `subtitle`, `mainstat`, `secondarystat`,
 * `color`, `detail__*` on a node; `id`, `source`, `target` on an edge), so
 * the panel draws a document read through the Infinity data source with no
 * transform (#1075).
 *
 * The version rule is chant's: within `behold-graph/1` fields are only ever
 * added, and a reader ignores the fields it does not know. A change a reader
 * could not ignore is `behold-graph/2`, and {@link checkGraphDocument}
 * refuses a version it does not know rather than guessing at it.
 *
 * The JSON Schema is `schemas/graph/v1/graph.schema.json` in the package and
 * {@link GRAPH_DOCUMENT_SCHEMA_URL} on the docs site.
 *
 * This module imports nothing, so a browser host (the viewer, a cut run on a
 * fetched document) can load it as it is. The document is built from the
 * graph IR by `toDocument` in src/to-document.ts.
 */

/** The value of a document's `schema` field. */
export const GRAPH_DOCUMENT_SCHEMA = "behold-graph/1";

/** Where the JSON Schema is published (its `$id`). */
export const GRAPH_DOCUMENT_SCHEMA_URL = "https://intentius.io/behold/schemas/graph/v1/graph.schema.json";

/** The colour a card is painted with, pinhole's status names. */
export type GraphStatus = "good" | "warn" | "accent" | "neutral" | "runtime";

/** Which program wrote the document, and the chant that read the graph. */
export interface GraphGenerator {
  behold: string;
  chant?: string;
}

/** What was read. No absolute path: `dir` is relative to the repository root. */
export interface GraphOrigin {
  /** The directory read, relative to the repository root, `/`-separated. `.` is the root itself. */
  dir: string;
  /** The revision the graph was read at, when it was read at one rather than from the working tree. */
  rev?: string;
}

/**
 * Which part of the graph the document holds. `whole` is every card the view
 * draws. A cut adds its own kind (`around`, #1067; `changed`, #1059) with its
 * parameters beside `kind`.
 */
export interface GraphCut {
  kind: string;
  [key: string]: unknown;
}

/** One card. */
export interface GraphDocumentNode {
  /** The graph IR's node id. Unique in the document. */
  id: string;
  /** What the card is titled. */
  title: string;
  /** The tool that declares it: `terraform`, `kubernetes`, `helm`, `choudoufu`, or the chant lexicon. */
  subtitle: string;
  /** The resource type, as the graph IR has it. */
  kind: string;
  lexicon: string;
  /** The id of the innermost group the card is drawn in. */
  box?: string;
  /** In a cut (`around`, #1067): true on the cards the cut was asked for. */
  seed?: boolean;
  /** In a `changed` cut (#1059): what happened to the card between the two revisions, or `neighbour` for a card kept for being near one that did. */
  diff?: "added" | "removed" | "changed" | "neighbour";
  /** On a `changed` card: the attribute keys whose values differ between the revisions. */
  changedAttrs?: string[];
  /** The declaring file, relative to the repository root. Absent when behold cannot place it there. */
  file?: string;
  /** Line in {@link file}, when the reader knows it. */
  line?: number;
  /** What a plan would do to it (`create`, `update`, `replace`, `delete`), when a plan was read and it changes. */
  change?: string;
  /** The card's status, when an overlay painted one. */
  status?: GraphStatus;
  /** A colour for {@link status}, for a reader that paints by colour. */
  color?: string;
  /** The status in words. */
  mainstat?: string;
  secondarystat?: string;
  /** On a stacked card: the ids of the cards it stands for. */
  stackOf?: string[];
  /** The member the card belongs to, in a workspace. */
  detail__member?: string;
  /** The Terraform root that applies it. */
  detail__root?: string;
  /** The Kubernetes namespace it lives in. */
  detail__namespace?: string;
  /** The Helm release that installs it. */
  detail__release?: string;
  /** Which source a read of a cluster took the card from (behold#1115): the cluster, or a folder read beside it. Absent on a read of a folder alone. */
  read?: "cluster" | "folder";
  /** The graph IR's attributes. `source` is left out unless it was asked for. */
  attrs: Record<string, unknown>;
}

/** One edge: `source` references `target`. */
export interface GraphDocumentEdge {
  /** Deterministic: the same graph gives the same id. Unique in the document. */
  id: string;
  source: string;
  target: string;
  /** The graph IR's edge kind (`ref`, `needs`, `calls`, ...). */
  kind: string;
  /** True when behold or chant joined the two rather than a reader stating it. */
  inferred: boolean;
  /** On an inferred edge: the join that drew it, `behold:<pass>` or chant's catalog rule id. On the edge to a placeholder card (a reference that names nothing) and on each edge of a reference that names several candidates, the rule of that reference. */
  rule?: string;
  /** The consumer-side attribute the reference flows through. */
  via?: string;
  /** In a `changed` cut (#1059): `added` or `removed` when the edge exists in one revision only. */
  diff?: "added" | "removed";
}

/** A box cards are drawn in. */
export interface GraphDocumentGroup {
  /** `<kind>:<key>`, never a node id. */
  id: string;
  title: string;
  /** `stack` (a workspace member, or a Terraform root), `wave`, `pipeline` or `container`. */
  kind: string;
  /** The group this one is drawn inside. */
  parent?: string;
}

/** Something the view says about itself: what it left out, and why. */
export interface GraphDocumentNote {
  kind: string;
  text: string;
  short?: string;
  box?: string;
  count?: number;
}

/** Positions a host can draw without laying the graph out again. */
export interface GraphDocumentLayout {
  nodes: Record<string, { x: number; y: number; width?: number; height?: number }>;
  groups?: Record<string, { x: number; y: number; width: number; height: number }>;
}

export interface GraphDocument {
  schema: typeof GRAPH_DOCUMENT_SCHEMA;
  generator: GraphGenerator;
  origin: GraphOrigin;
  cut: GraphCut;
  nodes: GraphDocumentNode[];
  edges: GraphDocumentEdge[];
  groups: GraphDocumentGroup[];
  notes: GraphDocumentNote[];
  layout?: GraphDocumentLayout;
}

export type GraphDocumentCheck = { ok: true; document: GraphDocument } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Whether `value` is a document this reader can read: its `schema` is
 * `behold-graph/1` and it has the lists every reader walks. A later version
 * (`behold-graph/2`) is refused by name, since its readers are told to expect
 * a change they cannot ignore. Fields this reader does not know are kept.
 * The full check is the JSON Schema; this is the part a host needs before it
 * draws, with no validator loaded.
 */
export function checkGraphDocument(value: unknown): GraphDocumentCheck {
  if (!isRecord(value)) return { ok: false, error: "not a behold graph document: not a JSON object" };
  const schema = value.schema;
  if (typeof schema !== "string") return { ok: false, error: "not a behold graph document: no `schema` field" };
  if (schema !== GRAPH_DOCUMENT_SCHEMA) {
    return /^behold-graph\/\d+$/.test(schema)
      ? { ok: false, error: `${schema} is a graph document version this reader does not know; it reads ${GRAPH_DOCUMENT_SCHEMA}` }
      : { ok: false, error: `not a behold graph document: schema is ${JSON.stringify(schema)}` };
  }
  for (const list of ["nodes", "edges", "groups", "notes"] as const) {
    if (!Array.isArray(value[list])) return { ok: false, error: `${GRAPH_DOCUMENT_SCHEMA} document without a \`${list}\` list` };
  }
  return { ok: true, document: value as unknown as GraphDocument };
}
