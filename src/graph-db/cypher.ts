/**
 * behold#1162: the graph database's rules, shared by the server's LadybugDB
 * (`@ladybugdb/core`, ./db.ts) and the exported page's WebAssembly build
 * (`@ladybugdb/wasm-core`, ./browser.ts), so both build the same tables from
 * the same rows and refuse and answer a query the same way.
 *
 * Nothing here imports Node: the browser module bundles it.
 *
 * The engine is reached through {@link ReadEngine} and {@link BuildEngine},
 * which each side fills from its own package. One difference stays outside
 * this file: `@ladybugdb/core` reports whether a prepared statement is
 * read-only, and wasm-core 0.22.3 does not, so the browser leaves `readOnly`
 * unset and relies on the clause check here and on its database being opened
 * read-only (./browser.ts).
 */
import type { GraphLayout } from "./layout-gen.ts";
import { GRAPH_LAYOUT } from "./layout.generated.ts";
import type { LoadedRows } from "./rows.ts";

/** The words a query may not hold as a clause. */
export const WRITE_CLAUSES = [
  "CREATE",
  "MERGE",
  "SET",
  "DELETE",
  "DETACH",
  "REMOVE",
  "DROP",
  "ALTER",
  "COPY",
  "LOAD",
  "INSTALL",
  "UNINSTALL",
  "ATTACH",
  "EXPORT",
  "IMPORT",
  "CALL",
  "CHECKPOINT",
  "USE",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
] as const;

/** A query refused before it ran. */
export class CypherRefused extends Error {
  constructor(
    message: string,
    readonly code: "cypher-write" | "cypher-invalid" | "cypher-empty" | "cypher-too-long",
  ) {
    super(message);
  }
}

/** The query with string literals, backquoted names and comments blanked, so a word inside them is not a clause. */
export function stripLiterals(q: string): string {
  return q
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`[^`]*`/g, "``");
}

/** The first write clause in a query, if it holds one. */
export function writeClause(q: string): string | undefined {
  const bare = stripLiterals(q).toUpperCase();
  // A property or label named like a clause (`r.set`, `:Copy`) is not one.
  const words = bare.split(/[^A-Z_.:$]+/).filter(Boolean);
  return WRITE_CLAUSES.find((w) => words.includes(w));
}

export const MAX_QUERY_LENGTH = 8_000;

/** Refuse a query that writes, before it reaches the engine. */
export function checkReadQuery(q: string): string {
  const s = q.trim();
  if (!s) throw new CypherRefused("an empty query", "cypher-empty");
  if (s.length > MAX_QUERY_LENGTH) throw new CypherRefused(`a query is at most ${MAX_QUERY_LENGTH} characters`, "cypher-too-long");
  const w = writeClause(s);
  if (w) throw new CypherRefused(`The graph is read-only: ${w} would write the database, a file, or load code, and is refused. Ask with MATCH ... RETURN.`, "cypher-write");
  return s;
}

/** What the engine said about a statement it prepared and did not report read-only. */
export const ENGINE_WRITE_REFUSAL = "The graph is read-only, and LadybugDB says this query writes. Ask with MATCH ... RETURN.";

/** A query's parameters from the JSON a person or an agent sent. */
export function parseParams(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new CypherRefused("params is not JSON", "cypher-invalid");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new CypherRefused("params is a JSON object of parameter names to values", "cypher-invalid");
  for (const [k, x] of Object.entries(v)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new CypherRefused(`parameter name ${JSON.stringify(k)} is not a name`, "cypher-invalid");
    if (x !== null && !["string", "number", "boolean"].includes(typeof x)) throw new CypherRefused(`parameter ${k} is a string, a number, a boolean or null`, "cypher-invalid");
  }
  return v as Record<string, unknown>;
}

/** The DDL and the insert statement per table for one layout, in build order. */
export function statementsFor(layout: Pick<GraphLayout, "ddl" | "inserts">): { ddl: readonly string[]; inserts: { resource: string; cloudId: string; knownAs: string; ref: string } } {
  const ins = (t: string): string => {
    const s = layout.inserts[t];
    if (!s) throw new Error(`graph build: the layout has no ${t} table`);
    return s;
  };
  return { ddl: layout.ddl, inserts: { resource: ins("Resource"), cloudId: ins("CloudId"), knownAs: ins("KNOWN_AS"), ref: ins("REF") } };
}

/** A value from LadybugDB as JSON: bigints as numbers (or strings past 2^53), nodes and rels as their properties. */
export function plain(v: unknown): unknown {
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), plain(x)]));
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      // `_id`, `_src`, `_dst` are the engine's internal offsets: meaningless outside this database.
      if (k === "_id" || k === "_src" || k === "_dst") continue;
      o[k === "_label" ? "label" : k] = plain(x);
    }
    return o;
  }
  return v;
}

export interface CypherAnswer {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Every Resource key the answer holds, in order: what `show` focuses. */
  keys: string[];
  truncated: boolean;
}

/** The Resource keys under a value: a node with a `key`, or a column named `key` / `*.key`. */
function keysIn(v: unknown, out: Set<string>, column?: string): void {
  if (typeof v === "string" && column && /(^|\.)key$/.test(column)) out.add(v);
  else if (Array.isArray(v)) v.forEach((x) => keysIn(x, out, column));
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.label === "Resource" && typeof o.key === "string") out.add(o.key);
    for (const x of Object.values(o)) if (x && typeof x === "object") keysIn(x, out);
  }
}

export const MAX_ROWS = 2_000;
export const QUERY_TIMEOUT_MS = 15_000;

/** The engine's columns and rows as an answer: at most {@link MAX_ROWS}, as JSON, with the Resource keys they hold. */
export function answerOf(columns: string[], got: readonly Record<string, unknown>[]): CypherAnswer {
  const truncated = got.length > MAX_ROWS;
  const rows = got.slice(0, MAX_ROWS).map((r) => plain(r) as Record<string, unknown>);
  const keys = new Set<string>();
  for (const r of rows) for (const [col, v] of Object.entries(r)) keysIn(v, keys, col);
  return { columns, rows, keys: [...keys], truncated };
}

/** One statement the engine prepared. */
export interface Prepared {
  /** The engine's message when it could not prepare the statement. */
  error?: string;
  /** Whether the engine reports the statement read-only; undefined when the engine cannot say (wasm-core 0.22.3). */
  readOnly?: boolean;
  /** Run it with its parameters: the column names and every row, as objects keyed by column. */
  run(params: Record<string, unknown>): Promise<{ columns: string[]; rows: Record<string, unknown>[] }>;
}

/** A read-only database, as much of it as a query needs. */
export interface ReadEngine {
  prepare(statement: string): Promise<Prepared>;
}

/** Run one read-only Cypher query with its parameters. Throws {@link CypherRefused}. */
export async function readQuery(engine: ReadEngine, cypher: string, params: Record<string, unknown> = {}): Promise<CypherAnswer> {
  const q = checkReadQuery(cypher);
  const p = await engine.prepare(q);
  if (p.error !== undefined) throw new CypherRefused(p.error, "cypher-invalid");
  if (p.readOnly === false) throw new CypherRefused(ENGINE_WRITE_REFUSAL, "cypher-write");
  const res = await p.run(params);
  return answerOf(res.columns, res.rows);
}

/**
 * Prepare one query without running it (behold#1142): undefined when it
 * passes the write guard, binds against the database's schema and the
 * engine does not report it a write; otherwise what refused it, the engine's
 * own message when the engine did.
 */
export async function queryRefusal(engine: ReadEngine, cypher: string): Promise<string | undefined> {
  let q: string;
  try {
    q = checkReadQuery(cypher);
  } catch (e) {
    if (e instanceof CypherRefused) return e.message;
    throw e;
  }
  const p = await engine.prepare(q);
  if (p.error !== undefined) return p.error;
  if (p.readOnly === false) return "LadybugDB does not report it read-only";
  return undefined;
}

/** A database being built, as much of it as the build needs. */
export interface BuildEngine {
  /** Run one statement without parameters (the DDL). */
  query(statement: string): Promise<void>;
  /** Prepare one insert; `run` loads one row. */
  prepare(statement: string): Promise<{ error?: string; run(params: Record<string, unknown>): Promise<void> }>;
}

/** Create the layout's tables and load every row, in the order the tables need. */
export async function loadRows(engine: BuildEngine, rows: LoadedRows): Promise<void> {
  const st = statementsFor(rows.layout ?? GRAPH_LAYOUT);
  for (const ddl of st.ddl) await engine.query(ddl);
  const run = async (stmt: string, list: readonly object[]) => {
    if (!list.length) return;
    const p = await engine.prepare(stmt);
    if (p.error !== undefined) throw new Error(`graph build: ${p.error}`);
    for (const params of list) await p.run(params as Record<string, unknown>);
  };
  await run(st.inserts.resource, rows.resources);
  await run(st.inserts.cloudId, rows.cloudIds);
  await run(st.inserts.knownAs, rows.knownAs);
  await run(st.inserts.ref, rows.refs);
}
