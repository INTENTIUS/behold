/**
 * behold#1027: one LadybugDB per session, built from the loaded rows and
 * read-only once built.
 *
 * The database is behold's own file, under behold's per-user data directory
 * (`$BEHOLD_GRAPH_DIR`, else `$XDG_DATA_HOME/behold/graph`, else
 * `~/.local/share/behold/graph`, the home behold#1025 Q4 gives behold's local
 * data). Nothing in it is a source of truth: it is built from the sources each
 * session, and a rebuild writes a new file and drops the old one.
 *
 * Read-only is held three ways, so a query can never write:
 *
 *  1. after the build the database is closed and opened again with
 *     `readOnly: true`, so the engine itself refuses a write;
 *  2. every query is prepared first, and one LadybugDB does not call
 *     read-only (`PreparedStatement.isReadOnly()`) is refused before it runs;
 *  3. before that, a query holding a clause that writes the database or a
 *     file, or loads code (CREATE, MERGE, SET, DELETE, REMOVE, DROP, ALTER,
 *     COPY, LOAD, INSTALL, ATTACH, EXPORT, IMPORT, CALL, CHECKPOINT, USE,
 *     BEGIN, COMMIT, ROLLBACK), outside string literals and comments, is
 *     refused with that word. `COPY ... TO` and `EXPORT DATABASE` write files
 *     outside the database, and the read-only engine does not stop them.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LbugConnection, LbugDatabase, LbugModule, LbugQueryResult } from "./peer.ts";
import type { LoadedRows } from "./rows.ts";
import type { GraphLayout } from "./layout-gen.ts";
import { GRAPH_LAYOUT } from "./layout.generated.ts";

/** Where session databases live. */
export function graphDbDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.BEHOLD_GRAPH_DIR) return env.BEHOLD_GRAPH_DIR;
  const data = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(data, "behold", "graph");
}

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

/**
 * The schema, behold#1025's three tables plus the typed columns the templates
 * read, as generated from chant's graph schema (behold#1031,
 * ./layout.generated.ts). A session built with a newer installed chant's
 * schema uses that layout's statements instead (./layout.ts `activeLayout`).
 */
export const SCHEMA: readonly string[] = GRAPH_LAYOUT.ddl;

/** The DDL and the insert statement per table for one layout, in build order. */
export function statementsFor(layout: GraphLayout): { ddl: readonly string[]; inserts: { resource: string; cloudId: string; knownAs: string; ref: string } } {
  const ins = (t: string): string => {
    const s = layout.inserts[t];
    if (!s) throw new Error(`graph build: the layout has no ${t} table`);
    return s;
  };
  return { ddl: layout.ddl, inserts: { resource: ins("Resource"), cloudId: ins("CloudId"), knownAs: ins("KNOWN_AS"), ref: ins("REF") } };
}

const all = async (r: LbugQueryResult | LbugQueryResult[]): Promise<LbugQueryResult> => (Array.isArray(r) ? r[r.length - 1]! : r);

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

/** The session database. */
export class GraphDb {
  private constructor(
    private readonly lbug: LbugModule,
    readonly path: string,
    private db: LbugDatabase,
    private conn: LbugConnection,
  ) {}

  /** Build a database from `rows` at a new file under `dir`, then reopen it read-only. */
  static async build(lbug: LbugModule, rows: LoadedRows, dir: string = graphDbDir()): Promise<GraphDb> {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `session-${process.pid}-${Date.now()}.lbdb`);
    const w = new lbug.Database(path);
    await w.init();
    const c = new lbug.Connection(w);
    await c.init();
    try {
      const st = statementsFor(rows.layout ?? GRAPH_LAYOUT);
      for (const ddl of st.ddl) await c.query(ddl);
      const run = async (stmt: string, list: readonly object[]) => {
        if (!list.length) return;
        const p = await c.prepare(stmt);
        if (!p.isSuccess()) throw new Error(`graph build: ${p.getErrorMessage()}`);
        for (const params of list) await c.execute(p, params as Record<string, unknown>);
      };
      await run(st.inserts.resource, rows.resources);
      await run(st.inserts.cloudId, rows.cloudIds);
      await run(st.inserts.knownAs, rows.knownAs);
      await run(st.inserts.ref, rows.refs);
    } finally {
      await c.close();
      await w.close();
    }
    const db = new lbug.Database(path, 0, true, true);
    await db.init();
    const conn = new lbug.Connection(db);
    await conn.init();
    conn.setQueryTimeout(QUERY_TIMEOUT_MS);
    return new GraphDb(lbug, path, db, conn);
  }

  /** Run one read-only Cypher query with its parameters. */
  async query(cypher: string, params: Record<string, unknown> = {}): Promise<CypherAnswer> {
    const q = checkReadQuery(cypher);
    const p = await this.conn.prepare(q);
    if (!p.isSuccess()) throw new CypherRefused(p.getErrorMessage(), "cypher-invalid");
    if (!p.isReadOnly()) throw new CypherRefused("The graph is read-only, and LadybugDB says this query writes. Ask with MATCH ... RETURN.", "cypher-write");
    const res = await all(await this.conn.execute(p, params));
    const columns = await res.getColumnNames();
    const got = await res.getAll();
    res.close();
    const truncated = got.length > MAX_ROWS;
    const rows = got.slice(0, MAX_ROWS).map((r) => plain(r) as Record<string, unknown>);
    const keys = new Set<string>();
    for (const r of rows) for (const [col, v] of Object.entries(r)) keysIn(v, keys, col);
    return { columns, rows, keys: [...keys], truncated };
  }

  /** Close the database and remove its file (behold's own, and nothing else). */
  async close(): Promise<void> {
    await this.conn.close().catch(() => undefined);
    await this.db.close().catch(() => undefined);
    removeSessionFiles(this.path);
  }

  get version(): string | undefined {
    return this.lbug.VERSION;
  }
}

/** The database file and the files LadybugDB keeps beside it (`.wal`, `.shadow`, `.tmp`), and nothing else. */
export function removeSessionFiles(path: string): void {
  const dir = join(path, "..");
  const base = path.slice(dir.length + 1);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (f === base || f.startsWith(`${base}.`)) rmSync(join(dir, f), { recursive: true, force: true });
  }
}
