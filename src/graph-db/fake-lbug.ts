/**
 * behold#1027: a stand-in for `@ladybugdb/core` in tests, shaped after its
 * `lbug.d.ts` (0.22.0). It runs nothing: it records every statement, answers
 * `isReadOnly()` from the statement's first word, and returns the rows a test
 * hands it. The real engine is exercised by src/graph-db/db.test.ts when the
 * peer is installed.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { globalNodeModules } from "../shot.ts";
import { LADYBUG_PACKAGE, loadLadybug, type LbugConnection, type LbugDatabase, type LbugModule, type LbugPreparedStatement, type LbugQueryResult } from "./peer.ts";

export interface FakeLbugLog {
  opened: Array<{ path: string | undefined; readOnly: boolean }>;
  statements: string[];
  executed: Array<{ statement: string; params: Record<string, unknown> }>;
}

export function fakeLbug(
  answer: (statement: string, params: Record<string, unknown>) => Record<string, unknown>[] = () => [],
  opts: { readOnly?: (statement: string) => boolean } = {},
): { module: LbugModule; log: FakeLbugLog } {
  const log: FakeLbugLog = { opened: [], statements: [], executed: [] };
  const result = (rows: Record<string, unknown>[]): LbugQueryResult => ({
    getAll: async () => rows,
    getColumnNames: async () => (rows[0] ? Object.keys(rows[0]) : []),
    close: () => undefined,
  });
  class Database implements LbugDatabase {
    readOnly: boolean;
    constructor(path?: string, _buffer?: number, _compression?: boolean, readOnly = false) {
      this.readOnly = readOnly;
      log.opened.push({ path, readOnly });
    }
    async init() {}
    async close() {}
  }
  class Connection implements LbugConnection {
    constructor(private readonly db: LbugDatabase) {}
    async init() {}
    setQueryTimeout() {}
    async close() {}
    async query(statement: string) {
      log.statements.push(statement);
      if ((this.db as Database).readOnly && /^\s*(CREATE|MERGE|SET|DELETE)/i.test(statement)) throw new Error("Cannot execute write operations in a read-only database!");
      return result([]);
    }
    async prepare(statement: string): Promise<LbugPreparedStatement & { statement: string }> {
      log.statements.push(statement);
      const writes = opts.readOnly ? !opts.readOnly(statement) : /\b(CREATE|MERGE|SET|DELETE)\b/i.test(statement);
      return { statement, isSuccess: () => !/SYNTAX ERROR/.test(statement), isReadOnly: () => !writes, getErrorMessage: () => "Parser exception: syntax error" };
    }
    async execute(p: LbugPreparedStatement, params: Record<string, unknown> = {}) {
      const statement = (p as LbugPreparedStatement & { statement: string }).statement;
      log.executed.push({ statement, params });
      if ((this.db as Database).readOnly && !p.isReadOnly()) throw new Error("Cannot execute write operations in a read-only database!");
      return result(answer(statement, params));
    }
  }
  return { module: { Database, Connection, VERSION: "0.22.3-fake" }, log };
}

/**
 * The real peer for the real-engine tests: beside behold, or where `npm i -g`
 * put it. Under vitest a package missing beside behold fails to import with
 * vite's own resolve error rather than ERR_MODULE_NOT_FOUND, so
 * `importLadybug` never reaches its global fallback there; this looks in the
 * global roots itself (behold#1121).
 *
 * `BEHOLD_REQUIRE_LADYBUG=1` (CI's unit test step, where `npm ci` installs
 * the dev dependency) makes a missing engine throw here, so the test file
 * fails instead of its real-engine suites skipping (behold#1126).
 */
export async function realLadybug(): ReturnType<typeof loadLadybug> {
  const found = await findLadybug();
  if (!found.ok && process.env.BEHOLD_REQUIRE_LADYBUG === "1") {
    throw new Error(`BEHOLD_REQUIRE_LADYBUG=1 but the real engine is not available: ${found.refusal.detail ?? found.refusal.error}`);
  }
  return found;
}

async function findLadybug(): ReturnType<typeof loadLadybug> {
  const beside = await loadLadybug();
  if (beside.ok) return beside;
  for (const g of globalNodeModules()) {
    const dir = join(g, ...LADYBUG_PACKAGE.split("/"));
    if (existsSync(join(dir, "package.json"))) return loadLadybug(async () => createRequire(join(g, "noop.js"))(dir) as unknown);
  }
  return beside;
}
