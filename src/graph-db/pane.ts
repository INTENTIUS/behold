/**
 * behold#1027: the graph pane's session and its routes.
 *
 * One session per served project: on the first ask, behold loads every
 * member's chant IR (the serve's own estate read), every engine graph
 * document, every index version and every cloud listing it finds
 * (src/graph-db/sources.ts) into rows (src/graph-db/rows.ts), then builds one
 * LadybugDB from them (src/graph-db/db.ts) and keeps it read-only. A switch of
 * the served project, or `GET /api/graphdb?rebuild=1`, builds a new one.
 *
 * The session also holds the project's template catalog (behold#1142):
 * chant's templates and the project's `.chant/templates.json`, read again on
 * a project switch or a rebuild. When the database opens, each project
 * Cypher template is prepared on it without running, and one the engine
 * cannot bind, or does not report read-only, moves to `refused`.
 *
 * Routes, every one a GET, none of which acts (the test in
 * src/graph-db/pane.test.ts walks them):
 *
 *   GET /api/graphdb              what is loaded, from where, read when; the peer's state
 *   GET /api/graphdb/query        ?cypher=&params=<JSON object>: one read-only Cypher query
 *   GET /api/graphdb/resolve      ?ref=: a name, id, address or cloud id to candidates and templates
 *   GET /api/graphdb/templates    the template catalog (chant's and the project's), with the refused project entries
 *   GET /api/graphdb/template     ?name=&node=&in.<input>=: one template filled for one node, run when it is Cypher
 *   GET /graph                    the pane's page (web/graph.html)
 *   GET /api/graphdb/index-versions, /api/graphdb/index-diff
 *                                 behold#1028: two reads of one index scope diffed, drawn as an overlay (./index-diff-routes.ts)
 *   GET /api/graphdb/estate-merge behold#1246: two sets of members side by side with the cloud ids they share (./estate-merge-routes.ts)
 *
 * Every answer carries `sources`: each source's `observedAt` (when it read
 * the world, null for a declared source) and `readAt` (when behold read it),
 * so an answer always says how fresh it is.
 *
 * Without the peer, query and a Cypher template refuse with the install line
 * (503, `graph-peer-missing`). Status, resolve, the catalog and a search
 * template still answer: they read the rows, not the database.
 *
 * A public serve (`--public`) refuses the pane: engine documents and index
 * versions hold cloud ids, and a public view shows the declared source only.
 */
import type { Hono, Context } from "hono";
import type { GraphIR } from "@intentius/chant";
import { GraphDb, graphDbDir } from "./db.ts";
import { countsOf, listedCatalog, queryAnswer, resolveAnswer, stamps, templateAnswer, type Answer, type PaneReads, type PeerState } from "./answers.ts";
import { loadLadybug, type PeerImport, type PeerRefusal } from "./peer.ts";
import { emptyRows, finishRows, rowsFromChantIr, rowsFromEngineGraph, rowsFromIndex, rowsFromListing, type LoadedRows } from "./rows.ts";
import { ESTATE_MERGE_ROUTES, mountEstateMerge } from "./estate-merge-routes.ts";
import { INDEX_DIFF_ROUTES, mountIndexDiff } from "./index-diff-routes.ts";
import { activeLayout, type ActiveLayout } from "./layout.ts";
import { findDocuments, type EngineRunner, type Git, type MemberRef } from "./sources.ts";
import { catalogFor, withEngineRefusals, type Template, type TemplateCatalog } from "./templates.ts";

export { subgraphOf, viewLinkFor } from "./answers.ts";

/** The chant read the session starts from: one project's IR, or a composed estate with its member names. */
export interface ChantRead {
  ir: GraphIR;
  /** A composed estate's member names (its ids are `<member>/<id>`). */
  members?: readonly string[];
  from: string;
}

export interface GraphPaneDeps {
  /** The served project, asked per request: a project switch changes it. */
  projectDir: () => string;
  /** Its members, with their kinds (src/estate.ts `estateMembers`). */
  members: () => readonly MemberRef[];
  /** chant's IR for them, as the serve reads it. */
  readChant: () => Promise<ChantRead>;
  /** `choudoufu ...` in a member, for `live-graph -json`. Absent: not run. */
  choudoufu?: EngineRunner;
  git?: Git;
  /** The peer's import; tests hand in a fake or a failing one. */
  peer?: PeerImport;
  /** Where session databases go (src/graph-db/db.ts `graphDbDir`). */
  dbDir?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  public?: boolean;
  now?: () => Date;
  /** The layout the database is built with (behold#1031); absent, the installed chant's schema when it ships one, else behold's vendored copy. */
  layout?: () => ActiveLayout;
  /** The project's template catalog (behold#1142); absent, chant's `templateCatalog` read through ./templates.ts `catalogFor`. */
  templates?: (projectDir: string) => TemplateCatalog;
}

export class GraphPeerMissing extends Error {
  constructor(readonly refusal: PeerRefusal) {
    super(refusal.error);
  }
}

interface Built {
  project: string;
  rows: LoadedRows;
  layout: ActiveLayout;
  builtAt: string;
}

/** One served project's loaded rows, and its database once a Cypher query needs it. */
export class GraphSession {
  private built?: Built;
  private building?: Promise<Built>;
  private db?: GraphDb;
  private dbFor?: Built;
  private opening?: Promise<GraphDb>;
  private cat?: { project: string; catalog: TemplateCatalog; checkedOn?: GraphDb };

  constructor(private readonly deps: GraphPaneDeps) {}

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /** The rows, loaded on first use and again when the project changed or a rebuild was asked. */
  async rows(rebuild = false): Promise<Built> {
    const project = this.deps.projectDir();
    if (!rebuild && this.built?.project === project) return this.built;
    if (!rebuild && this.building) return this.building;
    if (rebuild) this.cat = undefined;
    this.building = this.load(project).finally(() => (this.building = undefined));
    this.built = await this.building;
    return this.built;
  }

  private async load(project: string): Promise<Built> {
    const readAt = this.now();
    const layout = (this.deps.layout ?? activeLayout)();
    const rows = emptyRows(layout.from === "chant" ? layout.layout : undefined);
    rows.notes.push(...layout.notes);
    try {
      const chant = await this.deps.readChant();
      rowsFromChantIr(chant.ir, { ...(chant.members ? { members: chant.members } : {}), readAt, from: chant.from }, rows);
    } catch (e) {
      rows.notes.push(`chant's IR could not be read: ${(e as Error).message.split("\n")[0]}`);
    }
    const found = await findDocuments({
      projectDir: project,
      members: this.deps.members(),
      ...(this.deps.choudoufu ? { choudoufu: this.deps.choudoufu } : {}),
      ...(this.deps.git ? { git: this.deps.git } : {}),
      ...(this.deps.env ? { env: this.deps.env } : {}),
      ...(this.deps.home ? { home: this.deps.home } : {}),
    });
    rows.notes.push(...found.notes);
    for (const d of found.documents) {
      if (d.kind === "engine") rowsFromEngineGraph(d.doc, { ...(d.member !== undefined ? { member: d.member } : {}), readAt, from: d.from }, rows);
      else if (d.kind === "index") rowsFromIndex(d.doc, { version: d.version, readAt, from: d.from }, rows);
      else rowsFromListing(d.doc, { readAt, from: d.from }, rows);
    }
    finishRows(rows);
    return { project, rows, layout, builtAt: readAt };
  }

  /** The database for the current rows, built read-only on first use. Throws GraphPeerMissing without the peer. */
  async database(): Promise<GraphDb> {
    const built = await this.rows();
    if (this.db && this.dbFor === built) return this.db;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const peer = await loadLadybug(this.deps.peer);
      if (!peer.ok) throw new GraphPeerMissing(peer.refusal);
      const old = this.db;
      const db = await GraphDb.build(peer.lbug, built.rows, this.deps.dbDir ?? graphDbDir(this.deps.env));
      this.db = db;
      this.dbFor = built;
      await old?.close();
      await this.checkTemplates(db);
      return db;
    })().finally(() => (this.opening = undefined));
    return this.opening;
  }

  /** The project's template catalog, read once per project and again after a rebuild. */
  catalog(): TemplateCatalog {
    const project = this.deps.projectDir();
    if (this.cat?.project !== project) this.cat = { project, catalog: (this.deps.templates ?? catalogFor)(project) };
    return this.cat.catalog;
  }

  /** Prepare the project's Cypher templates on `db`, once per database, moving the ones it refuses. */
  private async checkTemplates(db: GraphDb): Promise<void> {
    this.catalog();
    const cat = this.cat!;
    if (cat.checkedOn === db) return;
    cat.catalog = await withEngineRefusals(cat.catalog, (q) => db.refusal(q));
    cat.checkedOn = db;
  }

  /** Whether the catalog's project Cypher templates have been prepared on the session's database. */
  engineChecked(): boolean {
    return !!this.cat?.checkedOn && this.cat.project === this.deps.projectDir() && this.cat.checkedOn === this.db;
  }

  /**
   * The catalog to offer: when it holds project Cypher templates and the peer
   * is installed, the database opens first, so what is offered has been
   * prepared on it. Without the peer, or when the database cannot be built,
   * they are listed unchecked (`engineChecked: false`); a Cypher template is
   * then offered as unavailable, or refused with the reason when run.
   */
  async offered(): Promise<TemplateCatalog> {
    const cat = this.catalog();
    if (this.deps.public || !cat.templates.some(ownCypher)) return cat;
    try {
      await this.checkTemplates(await this.database());
    } catch {
      // The query route reports why the database cannot open; the catalog still lists.
    }
    return this.catalog();
  }

  async peerState(): Promise<PeerState> {
    const p = await loadLadybug(this.deps.peer);
    return p.ok ? { available: true, ...(p.lbug.VERSION ? { version: p.lbug.VERSION } : {}) } : { available: false, refusal: p.refusal };
  }

  async close(): Promise<void> {
    await this.db?.close();
    this.db = undefined;
  }
}

const ownCypher = (t: Template): boolean => t.origin === "project" && t.language === "cypher";

/** Every route the pane mounts, for the API index and the no-action test. */
export const GRAPH_ROUTES = [
  { method: "GET", path: "/api/graphdb", desc: "behold#1027: the graph pane's sources (each with observedAt and readAt), counts, notes and whether the LadybugDB peer is installed; ?rebuild=1 reloads them" },
  { method: "GET", path: "/api/graphdb/query", desc: "behold#1027: one read-only Cypher query over every member's graph and every index: ?cypher=&params=<JSON>; refused without @ladybugdb/core" },
  { method: "GET", path: "/api/graphdb/resolve", desc: "behold#1027: a name, IR id, address or cloud id to candidate nodes, with the templates that apply: ?ref=" },
  { method: "GET", path: "/api/graphdb/templates", desc: "behold#1027: the investigation templates (search path patterns and Cypher), chant's and the project's own (.chant/templates.json, behold#1142), each with its origin, and the refused project entries" },
  { method: "GET", path: "/api/graphdb/template", desc: "behold#1027: one template filled for one node: ?name=&node=&in.<input>=; a Cypher one runs" },
  { method: "GET", path: "/graph", desc: "behold#1027: the graph pane (a Cypher box and resolve-from-resource)" },
  ...INDEX_DIFF_ROUTES,
  ...ESTATE_MERGE_ROUTES,
] as const;

/** Mount the pane's routes on `app`. Every one is a GET. */
export function mountGraphPane(app: Hono, deps: GraphPaneDeps): GraphSession {
  const session = new GraphSession(deps);
  const origin = (c: Context) => new URL(c.req.url).origin;
  const refusePublic = (c: Context) =>
    deps.public ? c.json({ error: "a public view shows the declared source only, and the graph pane loads engine documents and indexes", code: "public", remedy: "Serve without --public to use the graph pane." }, 403) : undefined;
  const reads = (c: Context): PaneReads => ({
    origin: origin(c),
    rows: async () => (await session.rows()).rows,
    catalog: () => session.offered(),
    peer: () => session.peerState(),
    run: async (cypher, params) => (await session.database()).query(cypher, params),
    refuse: (e, rows) => (e instanceof GraphPeerMissing ? { status: 503, body: { ...e.refusal, sources: stamps(rows) } } : undefined),
  });
  const send = (c: Context, a: Answer) => c.json(a.body, a.status as 200);

  app.get("/graph", (c) => c.redirect("/graph.html"));

  mountIndexDiff(app, {
    projectDir: deps.projectDir,
    ...(deps.git ? { git: deps.git } : {}),
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.home ? { home: deps.home } : {}),
    ...(deps.public ? { public: true } : {}),
  });

  mountEstateMerge(app, {
    rows: async () => {
      const built = await session.rows();
      return { rows: built.rows, builtAt: built.builtAt };
    },
    members: deps.members,
    ...(deps.public ? { public: true } : {}),
  });

  app.get("/api/graphdb", async (c) => {
    const pub = refusePublic(c);
    if (pub) return pub;
    const built = await session.rows(c.req.query("rebuild") === "1");
    const r = built.rows;
    return c.json({
      peer: await session.peerState(),
      builtAt: built.builtAt,
      counts: countsOf(r),
      tables: built.layout.layout.tables.map((t) => t.name),
      layout: {
        from: built.layout.from,
        ...(built.layout.path ? { path: built.layout.path } : {}),
        ...(built.layout.chantVersion ? { chantVersion: built.layout.chantVersion } : {}),
        schemaSha256: built.layout.layout.source.sha256,
        chantCommit: built.layout.layout.source.commit,
      },
      sources: stamps(r),
      notes: r.notes,
    });
  });

  app.get("/api/graphdb/query", async (c) => {
    const pub = refusePublic(c);
    if (pub) return pub;
    return send(c, await queryAnswer(reads(c), c.req.query("cypher") ?? "", c.req.query("params") ?? null));
  });

  app.get("/api/graphdb/templates", async (c) => {
    const cat = await session.offered();
    return c.json(listedCatalog(cat, session.engineChecked()));
  });

  app.get("/api/graphdb/resolve", async (c) => {
    const pub = refusePublic(c);
    if (pub) return pub;
    return send(c, await resolveAnswer(reads(c), c.req.query("ref") ?? ""));
  });

  app.get("/api/graphdb/template", async (c) => {
    const pub = refusePublic(c);
    if (pub) return pub;
    const inputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.req.queries())) if (k.startsWith("in.") && v[0] !== undefined) inputs[k.slice(3)] = v[0];
    return send(c, await templateAnswer(reads(c), c.req.query("name") ?? "", c.req.query("node") ?? "", inputs));
  });

  return session;
}
