/**
 * behold#1162: the graph pane's database in the browser, for a bundle
 * `behold export --graphdb` wrote. It is built to `graph-db-wasm.js` at the
 * bundle's root, beside `graphdb.json` (./graphdb-file.ts), `lbug-wasm.js`
 * (`@ladybugdb/wasm-core`'s default build: async, single-threaded, no
 * cross-origin isolation) and its worker, `lbug_wasm_worker.js`.
 *
 * The API, for the exported /graph page (web/graph-static.js) and any other
 * page in the bundle:
 *
 *   import { openGraphDb } from "./graph-db-wasm.js";
 *   const db = openGraphDb("./graphdb.json");
 *
 *   db.ready                    Promise<void>: the database is built. Rejects with
 *                               the reason when graphdb.json or the engine fails.
 *   db.file                     Promise<GraphDbFile>: graphdb.json, parsed. Settles
 *                               before `ready`, so a page can show counts early.
 *   db.status()                 GET /api/graphdb's answer
 *   db.query(cypher, params?)   GET /api/graphdb/query's answer; params is an object
 *   db.resolve(ref)             GET /api/graphdb/resolve's answer
 *   db.template(name, node, inputs?)
 *                               GET /api/graphdb/template's answer; a Cypher one runs
 *   db.templates()              GET /api/graphdb/templates's answer
 *   db.fetchJson(url)           any of those by its /api/graphdb URL, so a page
 *                               written for `behold serve` (web/graph-query.js
 *                               `initGraphPane`) runs unchanged
 *   db.close()                  stop the engine's worker
 *
 * Each answer is `{ status, body }`, the HTTP status and JSON body the
 * server's route gives (src/graph-db/answers.ts builds both), so a Cypher
 * answer's body is a `CypherAnswer` with `draw`, `link` and `sources`, and a
 * refusal is `{ error, code, remedy }` with the server's words. Every method
 * waits for `ready` where it needs the database; nothing here writes outside
 * the page, and nothing is fetched but graphdb.json, the module and its
 * worker.
 *
 * `openGraphDb(url, { workerUrl, moduleUrl, origin })` takes the worker's and
 * the module's URLs (beside this file by default) and the origin view links
 * start from (the bundle's folder by default).
 *
 * Read-only is held as on the server, less one check: the query passes
 * src/graph-db/cypher.ts `checkReadQuery`, and the database is built in the
 * worker's memory file system, closed and opened again read-only, so the
 * engine refuses a write when it prepares it. wasm-core 0.22.3 does not
 * report whether a prepared statement is read-only, and has no query
 * timeout, so neither is applied here.
 */
import { countsOf, listedCatalog, queryAnswer, resolveAnswer, stamps, templateAnswer, type Answer, type EngineRefusal, type PaneReads, type PeerState } from "./answers.ts";
import { loadRows, queryRefusal, readQuery, type BuildEngine, type CypherAnswer, type ReadEngine } from "./cypher.ts";
import { LBUG_MODULE_FILE, LBUG_WORKER_FILE, catalogFromFile, isGraphDbFile, rowsFromFile, type GraphDbFile } from "./graphdb-file.ts";
import type { LoadedRows } from "./rows.ts";
import { engineRefusals, type TemplateCatalog } from "./template-rules.ts";

/** The parts of `@ladybugdb/wasm-core`'s async API this module uses. */
interface WasmResult {
  isSuccess(): boolean;
  getErrorMessage(): Promise<string>;
  getColumnNames(): Promise<string[]>;
  getAllObjects(): Promise<Record<string, unknown>[]>;
  toArray?(): WasmResult[];
  close(): Promise<void>;
}
interface WasmPrepared {
  isSuccess(): boolean;
  getErrorMessage(): Promise<string>;
}
interface WasmConnection {
  init(): Promise<void>;
  query(statement: string): Promise<WasmResult>;
  prepare(statement: string): Promise<WasmPrepared>;
  execute(p: WasmPrepared, params?: Record<string, unknown>): Promise<WasmResult>;
  close(): Promise<void>;
}
interface WasmDatabase {
  init(): Promise<void>;
  close(): Promise<void>;
}
export interface WasmLbug {
  setWorkerPath(path: string): void;
  getVersion(): Promise<string>;
  close(): Promise<void>;
  Database: new (path?: string, bufferPoolSize?: number, maxNumThreads?: number, enableCompression?: boolean, readOnly?: boolean) => WasmDatabase;
  Connection: new (db: WasmDatabase, numThreads?: number) => WasmConnection;
}

export interface OpenOptions {
  /** wasm-core's worker; `lbug_wasm_worker.js` beside this module by default. */
  workerUrl?: string;
  /** wasm-core's module; `lbug-wasm.js` beside this module by default. */
  moduleUrl?: string;
  /** Where view links start; the bundle's folder by default. */
  origin?: string;
  /** For a test: the engine, instead of importing `moduleUrl`. */
  lbug?: WasmLbug;
}

export interface BrowserGraphDb {
  ready: Promise<void>;
  file: Promise<GraphDbFile>;
  status(): Promise<Answer>;
  query(cypher: string, params?: Record<string, unknown>): Promise<Answer>;
  resolve(ref: string): Promise<Answer>;
  template(name: string, node: string, inputs?: Record<string, string>): Promise<Answer>;
  templates(): Promise<Answer>;
  fetchJson(url: string): Promise<Answer>;
  close(): Promise<void>;
}

/** The database file, in the worker's memory file system. */
const DB_PATH = "/behold-graph.lbdb";

/** The engine did not load or build: what the Cypher routes answer instead. */
export class GraphDbUnavailable extends Error {}

const here = (): string => (typeof import.meta !== "undefined" && import.meta.url ? import.meta.url : globalThis.location?.href ?? "");
const beside = (file: string): string => new URL(`./${file}`, here()).href;

function lastResult(r: WasmResult): WasmResult {
  const all = typeof r.toArray === "function" ? r.toArray() : [r];
  return all[all.length - 1] ?? r;
}

function readEngine(conn: WasmConnection): ReadEngine {
  return {
    async prepare(statement) {
      const p = await conn.prepare(statement);
      if (!p.isSuccess()) return { error: await p.getErrorMessage(), run: notPrepared };
      return {
        async run(params) {
          const res = lastResult(await conn.execute(p, params));
          if (!res.isSuccess()) throw new Error(await res.getErrorMessage());
          const columns = await res.getColumnNames();
          const rows = await res.getAllObjects();
          await res.close();
          return { columns, rows };
        },
      };
    },
  };
}

function buildEngine(conn: WasmConnection): BuildEngine {
  return {
    async query(statement) {
      const r = await conn.query(statement);
      if (!r.isSuccess()) throw new Error(`graph build: ${await r.getErrorMessage()}`);
      await r.close();
    },
    async prepare(statement) {
      const p = await conn.prepare(statement);
      if (!p.isSuccess()) return { error: await p.getErrorMessage(), run: notPrepared };
      return {
        async run(params) {
          const r = await conn.execute(p, params);
          if (!r.isSuccess()) throw new Error(`graph build: ${await r.getErrorMessage()}`);
          await r.close();
        },
      };
    },
  };
}

const notPrepared = async (): Promise<never> => {
  throw new Error("graph: a statement that did not prepare was run");
};

async function importLbug(moduleUrl: string): Promise<WasmLbug> {
  const m = (await import(/* @vite-ignore */ moduleUrl)) as { default?: WasmLbug } & WasmLbug;
  return m.default ?? m;
}

/** Build the read-only database from graphdb.json's rows, in wasm-core's worker. */
async function build(lbug: WasmLbug, rows: LoadedRows): Promise<WasmConnection> {
  const w = new lbug.Database(DB_PATH);
  await w.init();
  const c = new lbug.Connection(w);
  await c.init();
  try {
    await loadRows(buildEngine(c), rows);
  } finally {
    await c.close();
    await w.close();
  }
  const db = new lbug.Database(DB_PATH, 0, 1, true, true);
  await db.init();
  const conn = new lbug.Connection(db);
  await conn.init();
  return conn;
}

function bundleOrigin(): string {
  const loc = globalThis.location;
  if (!loc) return "";
  return new URL(".", loc.href).href.replace(/\/$/, "");
}

/** Open the graph database a bundle carries. See the header for what it answers. */
export function openGraphDb(url: string | URL, opts: OpenOptions = {}): BrowserGraphDb {
  const file: Promise<GraphDbFile> = fetch(String(url), { headers: { accept: "application/json" } }).then(async (r) => {
    if (!r.ok) throw new GraphDbUnavailable(`${String(url)} answered ${r.status}`);
    const v: unknown = await r.json();
    if (!isGraphDbFile(v)) throw new GraphDbUnavailable(`${String(url)} is not a graphdb.json this page reads`);
    return v;
  });
  const rows = file.then(rowsFromFile);
  let lbug: WasmLbug | undefined;
  let version: string | undefined;
  let settled = false;
  const conn: Promise<WasmConnection> = (async () => {
    const f = await file;
    lbug = opts.lbug ?? (await importLbug(opts.moduleUrl ?? beside(LBUG_MODULE_FILE)));
    // Before the first call: the worker sits beside this module, not wherever wasm-core guesses.
    lbug.setWorkerPath(opts.workerUrl ?? beside(LBUG_WORKER_FILE));
    version = await lbug.getVersion();
    return build(lbug, rowsFromFile(f));
  })().finally(() => (settled = true));
  const ready = conn.then(() => undefined);
  // A failure is answered by every route; keep it from reaching the console as unhandled.
  ready.catch(() => undefined);
  file.catch(() => undefined);

  let checked: Promise<TemplateCatalog> | undefined;
  const catalog = async (): Promise<{ cat: TemplateCatalog; engineChecked: boolean }> => {
    const f = await file;
    const plain = catalogFromFile(f.catalog);
    try {
      const c = await conn;
      // The project's Cypher templates, prepared on this database once, as the server does when its database opens.
      checked ??= engineRefusals(plain, (q) => queryRefusal(readEngine(c), q), f.catalog.projectFile);
      return { cat: await checked, engineChecked: true };
    } catch {
      return { cat: plain, engineChecked: false };
    }
  };

  const peer = async (): Promise<PeerState> => {
    try {
      await conn;
      return { available: true, ...(version ? { version: `${version} (WebAssembly)` } : {}) };
    } catch (e) {
      return { available: false, refusal: unavailable(e) };
    }
  };

  const reads: PaneReads = {
    origin: opts.origin ?? bundleOrigin(),
    rows: () => rows,
    catalog: async () => (await catalog()).cat,
    peer,
    run: async (cypher: string, params: Record<string, unknown>): Promise<CypherAnswer> => {
      let c: WasmConnection;
      try {
        c = await conn;
      } catch (e) {
        throw new GraphDbUnavailable(unavailable(e).error);
      }
      return readQuery(readEngine(c), cypher, params);
    },
    refuse: (e, r) => (e instanceof GraphDbUnavailable ? { status: 503, body: { ...unavailable(e), sources: stamps(r) } } : undefined),
  };

  const guard = async (f: () => Promise<Answer>): Promise<Answer> => {
    try {
      return await f();
    } catch (e) {
      return { status: e instanceof GraphDbUnavailable ? 503 : 500, body: { error: (e as Error).message ?? String(e), code: e instanceof GraphDbUnavailable ? "graph-wasm-unavailable" : "graph-error" } };
    }
  };

  const status = () =>
    guard(async () => {
      const f = await file;
      const r = await rows;
      return { status: 200, body: { peer: await peerNow(), ...f.status, counts: countsOf(r), sources: stamps(r), notes: r.notes } };
    });
  // The header shows the engine's state as it is now: loading, ready, or why it failed.
  const peerNow = async (): Promise<PeerState> => (settled ? peer() : { available: false, refusal: LOADING });

  const api: BrowserGraphDb = {
    ready,
    file,
    status,
    query: (cypher, params = {}) => guard(() => queryAnswer(reads, cypher, Object.keys(params).length ? JSON.stringify(params) : null)),
    resolve: (ref) => guard(() => resolveAnswer(reads, ref)),
    template: (name, node, inputs = {}) => guard(() => templateAnswer(reads, name, node, inputs)),
    templates: () =>
      guard(async () => {
        const { cat, engineChecked } = await catalog();
        return { status: 200, body: listedCatalog(cat, engineChecked) };
      }),
    fetchJson: (u) => {
      const at = new URL(u, "http://bundle.invalid/");
      const q = at.searchParams;
      switch (at.pathname) {
        case "/api/graphdb":
          return status();
        case "/api/graphdb/query":
          return guard(() => queryAnswer(reads, q.get("cypher") ?? "", q.get("params")));
        case "/api/graphdb/resolve":
          return api.resolve(q.get("ref") ?? "");
        case "/api/graphdb/templates":
          return api.templates();
        case "/api/graphdb/template": {
          const inputs: Record<string, string> = {};
          for (const [k, v] of q) if (k.startsWith("in.") && !(k.slice(3) in inputs)) inputs[k.slice(3)] = v;
          return api.template(q.get("name") ?? "", q.get("node") ?? "", inputs);
        }
        default:
          return Promise.resolve({ status: 404, body: { error: `this bundle answers the graph pane's query, resolve and template reads, and not ${at.pathname}`, code: "not-in-bundle" } });
      }
    },
    close: async () => {
      await lbug?.close().catch(() => undefined);
    },
  };
  return api;
}

/** What the header says while the engine loads. */
export const LOADING: EngineRefusal = { error: "LadybugDB's WebAssembly build is loading in this page.", code: "graph-wasm-loading", remedy: "Cypher answers once it has loaded." };

function unavailable(e: unknown): EngineRefusal {
  const why = (e as Error)?.message ?? String(e);
  return {
    error: `LadybugDB's WebAssembly build did not load in this page: ${why}`,
    code: "graph-wasm-unavailable",
    remedy: "Reload the page. It needs a browser with WebAssembly and module workers, and the bundle's graphdb.json, lbug-wasm.js and lbug_wasm_worker.js.",
    stillWorks: ["resolving a resource by name, id, address or cloud id"],
  };
}
