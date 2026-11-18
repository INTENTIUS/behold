/**
 * behold#1162: `graphdb.json`, the graph pane's session as `behold export
 * --graphdb` writes it, for the exported page's WebAssembly build
 * (./browser.ts) to load.
 *
 *   {
 *     "graphdb": 1,
 *     "behold": "<behold's version>",
 *     "ladybug": { "package": "@ladybugdb/wasm-core", "version": "0.22.3",
 *                  "module": "lbug-wasm.js", "worker": "lbug_wasm_worker.js" },
 *     "status":  GET /api/graphdb's answer at export, without `peer`, `sources`
 *                and `notes` (builtAt, counts, tables, layout),
 *     "layout":  the GraphLayout the rows are for (./layout-gen.ts): its DDL and
 *                insert statements build the database,
 *     "rows":    the session's LoadedRows (./rows.ts) without `layout`:
 *                resources, cloudIds, knownAs, refs, sources, notes,
 *     "catalog": the project's template catalog (chant's templates and the
 *                project's `.chant/templates.json`): source, note, templates,
 *                refused, `projectFile` (chant's name for the project's
 *                file) and `fields`, each project Cypher template's field
 *                in its file, for a refusal the browser's engine makes
 *   }
 *
 * The rows are the ones the server loads, masked as ./rows.ts masks them,
 * and the export masks attribute values again with chant's list
 * (./mask.ts) before writing them. Nothing here imports Node.
 */
import type { GraphLayout } from "./layout-gen.ts";
import type { LoadedRows } from "./rows.ts";
import type { RefusedTemplate, Template, TemplateCatalog, TemplateCatalogSource } from "./template-rules.ts";

export const GRAPHDB_FILE = "graphdb.json";
export const GRAPHDB_FORMAT = 1;

/** The bundle's copy of wasm-core's module, its worker, and the browser module that loads them. */
export const LBUG_MODULE_FILE = "lbug-wasm.js";
export const LBUG_WORKER_FILE = "lbug_wasm_worker.js";
export const GRAPHDB_MODULE_FILE = "graph-db-wasm.js";

export interface GraphDbStatus {
  builtAt: string;
  counts: Record<string, number>;
  tables: string[];
  layout: Record<string, unknown>;
}

export interface GraphDbFile {
  graphdb: typeof GRAPHDB_FORMAT;
  behold: string;
  ladybug: { package: string; version: string; module: string; worker: string };
  status: GraphDbStatus;
  layout: GraphLayout;
  rows: Omit<LoadedRows, "layout">;
  catalog: {
    source: TemplateCatalogSource;
    note: string;
    templates: readonly Template[];
    refused: readonly RefusedTemplate[];
    /** The project's templates file, as chant names it, for a refusal the browser's engine makes. */
    projectFile: string;
    /** A project Cypher template's name to its query's field in the templates file (`templates[2].query.text`). */
    fields: Record<string, string>;
  };
}

/** A catalog as graphdb.json holds it: `fieldOf` becomes the fields it would answer for the engine's check. */
export function catalogToFile(cat: TemplateCatalog, projectFile: string): GraphDbFile["catalog"] {
  const fields: Record<string, string> = {};
  for (const t of cat.templates) {
    if (t.origin !== "project" || t.language !== "cypher") continue;
    const f = cat.fieldOf?.(t.name, ".query.text");
    if (f) fields[t.name] = f;
  }
  return { source: cat.source, note: cat.note, templates: cat.templates, refused: cat.refused, projectFile, fields };
}

/** The catalog back from graphdb.json. */
export function catalogFromFile(c: GraphDbFile["catalog"]): TemplateCatalog {
  return {
    source: c.source,
    note: c.note,
    templates: c.templates,
    refused: c.refused,
    fieldOf: (id, rest) => (rest === ".query.text" ? c.fields[id] : undefined),
  };
}

/** The rows back from graphdb.json, with their layout. */
export function rowsFromFile(f: Pick<GraphDbFile, "rows" | "layout">): LoadedRows {
  return { ...f.rows, layout: f.layout };
}

/** Whether `v` is shaped like a graphdb.json this build reads. */
export function isGraphDbFile(v: unknown): v is GraphDbFile {
  if (!v || typeof v !== "object") return false;
  const f = v as Partial<GraphDbFile>;
  return f.graphdb === GRAPHDB_FORMAT && !!f.rows && Array.isArray(f.rows.resources) && !!f.layout && Array.isArray(f.layout.ddl) && !!f.catalog && Array.isArray(f.catalog.templates);
}
