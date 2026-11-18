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
 *
 * A project's own Cypher templates (behold#1142) go through the same guards
 * when the database opens: {@link GraphDb.refusal} prepares each one without
 * running it.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LbugConnection, LbugDatabase, LbugModule, LbugPreparedStatement, LbugQueryResult } from "./peer.ts";
import type { LoadedRows } from "./rows.ts";
import { GRAPH_LAYOUT } from "./layout.generated.ts";
import { QUERY_TIMEOUT_MS, loadRows, queryRefusal, readQuery, type BuildEngine, type CypherAnswer, type ReadEngine } from "./cypher.ts";

// behold#1162: the rules live in ./cypher.ts, which the exported page's WebAssembly build shares.
export {
  CypherRefused,
  ENGINE_WRITE_REFUSAL,
  MAX_QUERY_LENGTH,
  MAX_ROWS,
  QUERY_TIMEOUT_MS,
  WRITE_CLAUSES,
  answerOf,
  checkReadQuery,
  parseParams,
  plain,
  statementsFor,
  stripLiterals,
  writeClause,
  type CypherAnswer,
} from "./cypher.ts";

/** Where session databases live. */
export function graphDbDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.BEHOLD_GRAPH_DIR) return env.BEHOLD_GRAPH_DIR;
  const data = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(data, "behold", "graph");
}

/**
 * The schema, behold#1025's three tables plus the typed columns the templates
 * read, as generated from chant's graph schema (behold#1031,
 * ./layout.generated.ts). A session built with a newer installed chant's
 * schema uses that layout's statements instead (./layout.ts `activeLayout`).
 */
export const SCHEMA: readonly string[] = GRAPH_LAYOUT.ddl;

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
      await loadRows(buildEngine(c), rows);
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
    return readQuery(readEngine(this.conn), cypher, params);
  }

  /**
   * Prepare one query without running it (behold#1142): undefined when it
   * passes the write guard, binds against this database's schema and the
   * engine reports it read-only; otherwise what refused it, the engine's own
   * message when the engine did.
   */
  async refusal(cypher: string): Promise<string | undefined> {
    return queryRefusal(readEngine(this.conn), cypher);
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

const all = async (r: LbugQueryResult | LbugQueryResult[]): Promise<LbugQueryResult> => (Array.isArray(r) ? r[r.length - 1]! : r);

/** `@ladybugdb/core`'s connection as ./cypher.ts reads a database. */
function readEngine(conn: LbugConnection): ReadEngine {
  return {
    async prepare(statement) {
      const p = await conn.prepare(statement);
      if (!p.isSuccess()) return { error: p.getErrorMessage(), run: notPrepared };
      return {
        readOnly: p.isReadOnly(),
        async run(params) {
          const res = await all(await conn.execute(p, params));
          const columns = await res.getColumnNames();
          const rows = await res.getAll();
          res.close();
          return { columns, rows };
        },
      };
    },
  };
}

/** `@ladybugdb/core`'s connection as ./cypher.ts builds a database. */
function buildEngine(conn: LbugConnection): BuildEngine {
  return {
    async query(statement) {
      await conn.query(statement);
    },
    async prepare(statement) {
      const p: LbugPreparedStatement = await conn.prepare(statement);
      if (!p.isSuccess()) return { error: p.getErrorMessage(), run: notPrepared };
      return {
        async run(params) {
          await conn.execute(p, params);
        },
      };
    },
  };
}

const notPrepared = async (): Promise<never> => {
  throw new Error("graph: a statement that did not prepare was run");
};

/** The database file and the files LadybugDB keeps beside it (`.wal`, `.shadow`, `.tmp`), and nothing else. */
export function removeSessionFiles(path: string): void {
  const dir = join(path, "..");
  const base = path.slice(dir.length + 1);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (f === base || f.startsWith(`${base}.`)) rmSync(join(dir, f), { recursive: true, force: true });
  }
}
