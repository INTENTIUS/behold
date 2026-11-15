/**
 * behold#1058: what `behold graph` can print, one entry per output format.
 *
 * Every format reads the same input: the view `graphView` answered
 * (src/graph-view.ts) and the options `toDocument` takes for it, which carry
 * the path scrubber, so no format prints this machine's paths. A format
 * returns text or bytes and never writes; the CLI decides between stdout and
 * `-o <file>`.
 *
 * A new format is one more entry in `GRAPH_FORMATS`, and the CLI takes its
 * flag from the entry's name (`--json`, `--ir`, `--mermaid`). The SVG
 * painter (#1061) is listed in `PENDING_FORMATS` until it applies, so its flag
 * already answers with what to use meanwhile instead of an unknown-flag error.
 * A cut (#1067's `cutDocument` in src/graph-cut.ts for `--around`, #1059's
 * `cutChanged` in src/graph-changed.ts for `--changed`) works on the document:
 * the CLI hands it to a format
 * as `cut`, and `graphDocument` applies it before the format prints, so a
 * format that reads the document needs nothing of its own for it.
 */
import type { GraphDocument } from "./graph-document.ts";
import { toMermaid } from "./graph-mermaid.ts";
import type { Forge } from "./mermaid-budgets.ts";
import type { GraphView } from "./graph-view.ts";
import { toDocument, type ToDocumentOptions } from "./to-document.ts";

export interface GraphFormatInput {
  view: GraphView;
  /** For `toDocument`, scrubber included. */
  document: ToDocumentOptions;
  /** Keep `attrs.source` on the cards (`--source`). */
  source: boolean;
  /** For `mermaid`: the forge whose character budget the diagram fits (src/mermaid-budgets.ts). Default github. */
  forge?: Forge;
  /** A cut over the document, applied before a document format prints. None is the whole graph. */
  cut?: (doc: GraphDocument) => GraphDocument;
}

export interface GraphFormat {
  /** The flag without its dashes. */
  name: string;
  /** One line for the usage text. */
  summary: string;
  emit(input: GraphFormatInput): string | Uint8Array;
}

type Rec = Record<string, unknown>;

/** The view as a `behold-graph/1` document. */
export function graphDocument(input: GraphFormatInput): GraphDocument {
  const { view, document, source, cut } = input;
  const doc = toDocument({ ir: view.ir, meta: view.meta as unknown as Rec }, { ...document, source });
  return cut ? cut(doc) : doc;
}

/** A string keeps `scrub`'s rewrite, an object has its keys and values rewritten. */
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

/**
 * The view as `{ir, meta}`, the shape `/api/graph` answers without its SVG:
 * chant's GraphIR with behold's fields. Not versioned; a program that keeps
 * what it reads should take the document instead. A cut is over the
 * document, so this is always the whole view.
 */
export function graphSnapshot(input: GraphFormatInput): { ir: unknown; meta: unknown } {
  const { view, document, source } = input;
  const ir = source
    ? view.ir
    : {
        ...view.ir,
        nodes: view.ir.nodes.map((n) => {
          if (!n.attrs || !("source" in n.attrs)) return n;
          const { source: _source, ...attrs } = n.attrs as Rec;
          return { ...n, attrs };
        }),
      };
  const snapshot = { ir, meta: view.meta };
  return document.scrub ? (scrubDeep(snapshot, document.scrub) as typeof snapshot) : snapshot;
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

export const GRAPH_FORMATS: readonly GraphFormat[] = [
  { name: "json", summary: "the behold-graph/1 document (the default)", emit: (input) => json(graphDocument(input)) },
  { name: "ir", summary: "the unversioned {ir, meta} snapshot /api/graph answers, without its SVG", emit: (input) => json(graphSnapshot(input)) },
  {
    name: "mermaid",
    summary: "a Mermaid flowchart within a forge's character budget (--forge gitlab|github|forgejo, default github)",
    emit: (input) => toMermaid(graphDocument(input), input.forge ? { forge: input.forge } : {}),
  },
];

/** Formats whose flag is reserved for an emitter that has not applied yet, and what to use meanwhile. */
export const PENDING_FORMATS: Readonly<Record<string, string>> = {
  svg: "the SVG painter for behold graph is not in this version; `behold export` writes the pictures meanwhile",
};

export function graphFormat(name: string): GraphFormat | undefined {
  return GRAPH_FORMATS.find((f) => f.name === name);
}
