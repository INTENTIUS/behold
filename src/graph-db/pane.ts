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
 * Routes, every one a GET, none of which acts (the test in
 * src/graph-db/pane.test.ts walks them):
 *
 *   GET /api/graphdb              what is loaded, from where, read when; the peer's state
 *   GET /api/graphdb/query        ?cypher=&params=<JSON object>: one read-only Cypher query
 *   GET /api/graphdb/resolve      ?ref=: a name, id, address or cloud id to candidates and templates
 *   GET /api/graphdb/templates    the template catalog (behold's stub of chant's, see templates.ts)
 *   GET /api/graphdb/template     ?name=&node=&in.<input>=: one template filled for one node, run when it is Cypher
 *   GET /graph                    the pane's page (web/graph.html)
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
import { CypherRefused, GraphDb, graphDbDir, type CypherAnswer } from "./db.ts";
import { loadLadybug, type PeerImport, type PeerRefusal } from "./peer.ts";
import { emptyRows, finishRows, rowsFromChantIr, rowsFromEngineGraph, rowsFromIndex, rowsFromListing, type LoadedRows, type SourceStamp } from "./rows.ts";
import { findDocuments, type EngineRunner, type Git, type MemberRef } from "./sources.ts";
import { TEMPLATES, TemplateError, applies, expandTemplate, resolveResource, type Expanded } from "./templates.ts";

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
}

export class GraphPeerMissing extends Error {
  constructor(readonly refusal: PeerRefusal) {
    super(refusal.error);
  }
}

interface Built {
  project: string;
  rows: LoadedRows;
  builtAt: string;
}

/** One served project's loaded rows, and its database once a Cypher query needs it. */
export class GraphSession {
  private built?: Built;
  private building?: Promise<Built>;
  private db?: GraphDb;
  private dbFor?: Built;
  private opening?: Promise<GraphDb>;

  constructor(private readonly deps: GraphPaneDeps) {}

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /** The rows, loaded on first use and again when the project changed or a rebuild was asked. */
  async rows(rebuild = false): Promise<Built> {
    const project = this.deps.projectDir();
    if (!rebuild && this.built?.project === project) return this.built;
    if (!rebuild && this.building) return this.building;
    this.building = this.load(project).finally(() => (this.building = undefined));
    this.built = await this.building;
    return this.built;
  }

  private async load(project: string): Promise<Built> {
    const readAt = this.now();
    const rows = emptyRows();
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
    return { project, rows, builtAt: readAt };
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
      return db;
    })().finally(() => (this.opening = undefined));
    return this.opening;
  }

  async peerState(): Promise<{ available: true; version?: string } | { available: false; refusal: PeerRefusal }> {
    const p = await loadLadybug(this.deps.peer);
    return p.ok ? { available: true, ...(p.lbug.VERSION ? { version: p.lbug.VERSION } : {}) } : { available: false, refusal: p.refusal };
  }

  async close(): Promise<void> {
    await this.db?.close();
    this.db = undefined;
  }
}

/** The answer's keys, with the edges among them: what the pane draws. */
export function subgraphOf(rows: LoadedRows, keys: readonly string[]): { nodes: Array<{ key: string; kind: string; name: string; source: string; scopeKey: string }>; edges: Array<{ from: string; to: string; viaAttr: string; origin: string; rule: string }> } {
  const want = new Set(keys);
  const nodes = rows.resources.filter((r) => want.has(r.key)).map((r) => ({ key: r.key, kind: r.kind, name: r.name, source: r.source, scopeKey: r.scopeKey }));
  const edges = rows.refs.filter((e) => want.has(e.from) && want.has(e.to)).map((e) => ({ from: e.from, to: e.to, viaAttr: e.viaAttr, origin: e.origin, rule: e.rule }));
  return { nodes, edges };
}

/**
 * The behold view that draws an answer: the members holding its chant nodes
 * (and the chant nodes that share a cloud id with its other nodes) brought
 * forward, the first one selected.
 */
export function viewLinkFor(origin: string, rows: LoadedRows, keys: readonly string[]): string | null {
  const byKey = new Map(rows.resources.map((r) => [r.key, r]));
  const chant = new Set<string>();
  const valuesOf = new Map<string, string[]>();
  for (const k of rows.knownAs) valuesOf.set(k.key, [...(valuesOf.get(k.key) ?? []), k.value]);
  const holders = new Map<string, string[]>();
  for (const k of rows.knownAs) holders.set(k.value, [...(holders.get(k.value) ?? []), k.key]);
  for (const key of keys) {
    const r = byKey.get(key);
    if (!r) continue;
    if (r.source === "chant") chant.add(key);
    else for (const v of valuesOf.get(key) ?? []) for (const h of holders.get(v) ?? []) if (byKey.get(h)?.source === "chant") chant.add(h);
  }
  if (!chant.size) return null;
  const members = [...new Set([...chant].map((k) => byKey.get(k)!.scopeKey.replace(/^chant\//, "")).filter((m) => m !== "."))];
  const q = new URLSearchParams();
  if (members.length) q.set("focus", members.join(","));
  q.set("node", [...chant][0]!);
  return `${origin}/?${q}`;
}

const stamps = (rows: LoadedRows): SourceStamp[] => rows.sources;

function parseParams(raw: string | null): Record<string, unknown> {
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

/** Every route the pane mounts, for the API index and the no-action test. */
export const GRAPH_ROUTES = [
  { method: "GET", path: "/api/graphdb", desc: "behold#1027: the graph pane's sources (each with observedAt and readAt), counts, notes and whether the LadybugDB peer is installed; ?rebuild=1 reloads them" },
  { method: "GET", path: "/api/graphdb/query", desc: "behold#1027: one read-only Cypher query over every member's graph and every index: ?cypher=&params=<JSON>; refused without @ladybugdb/core" },
  { method: "GET", path: "/api/graphdb/resolve", desc: "behold#1027: a name, IR id, address or cloud id to candidate nodes, with the templates that apply: ?ref=" },
  { method: "GET", path: "/api/graphdb/templates", desc: "behold#1027: the investigation templates (search path patterns and Cypher)" },
  { method: "GET", path: "/api/graphdb/template", desc: "behold#1027: one template filled for one node: ?name=&node=&in.<input>=; a Cypher one runs" },
  { method: "GET", path: "/graph", desc: "behold#1027: the graph pane (a Cypher box and resolve-from-resource)" },
] as const;

/** Mount the pane's routes on `app`. Every one is a GET. */
export function mountGraphPane(app: Hono, deps: GraphPaneDeps): GraphSession {
  const session = new GraphSession(deps);
  const origin = (c: Context) => new URL(c.req.url).origin;
  const refusePublic = (c: Context) =>
    deps.public ? c.json({ error: "a public view shows the declared source only, and the graph pane loads engine documents and indexes", code: "public", remedy: "Serve without --public to use the graph pane." }, 403) : undefined;
  const peerMissing = (c: Context, e: GraphPeerMissing, rows?: LoadedRows) => c.json({ ...e.refusal, ...(rows ? { sources: stamps(rows) } : {}) }, 503);
  const cypherAnswer = (c: Context, rows: LoadedRows, a: CypherAnswer, extra: Record<string, unknown> = {}) =>
    c.json({ ...extra, columns: a.columns, rows: a.rows, keys: a.keys, truncated: a.truncated, draw: subgraphOf(rows, a.keys), link: viewLinkFor(origin(c), rows, a.keys), sources: stamps(rows) });
  const runCypher = async (c: Context, cypher: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const { rows } = await session.rows();
    try {
      const db = await session.database();
      return cypherAnswer(c, rows, await db.query(cypher, params), extra);
    } catch (e) {
      if (e instanceof GraphPeerMissing) return peerMissing(c, e, rows);
      if (e instanceof CypherRefused) return c.json({ error: e.message, code: e.code, remedy: "The graph holds Resource, CloudId, KNOWN_AS and REF; see GET /api/graphdb for what is loaded.", ...extra, sources: stamps(rows) }, 400);
      throw e;
    }
  };

  app.get("/graph", (c) => c.redirect("/graph.html"));

  app.get("/api/graphdb", async (c) => {
    const pub = refusePublic(c);
    if (pub) return pub;
    const built = await session.rows(c.req.query("rebuild") === "1");
    const r = built.rows;
    return c.json({
      peer: await session.peerState(),
      builtAt: built.builtAt,
      counts: { resources: r.resources.length, cloudIds: r.cloudIds.length, knownAs: r.knownAs.length, refs: r.refs.length, derived: r.refs.filter((e) => e.origin === "derived").length },
      tables: ["Resource", "CloudId", "KNOWN_AS", "REF"],
      sources: stamps(r),
      notes: r.notes,
    });
  });

  app.get("/api/graphdb/query", async (c) => {
    const pub = refusePublic(c);
    if (pub) return pub;
    const cypher = c.req.query("cypher") ?? "";
    let params: Record<string, unknown>;
    try {
      params = parseParams(c.req.query("params") ?? null);
    } catch (e) {
      return c.json({ error: (e as Error).message, code: (e as CypherRefused).code ?? "cypher-invalid" }, 400);
    }
    return runCypher(c, cypher, params, { cypher });
  });

  app.get("/api/graphdb/templates", (c) => c.json({ templates: TEMPLATES, catalog: "behold stub; chant's template entry kind is pending (behold#1022 ruling Q5)" }));

  app.get("/api/graphdb/resolve", async (c) => {
    const pub = refusePublic(c);
    if (pub) return pub;
    const ref = c.req.query("ref") ?? "";
    if (!ref.trim()) return c.json({ error: "resolve needs ref: a name, an IR id, a block address or a cloud id", code: "resolve-empty" }, 400);
    const { rows } = await session.rows();
    const candidates = resolveResource(rows, ref);
    const peer = await session.peerState();
    const one = candidates.length === 1 ? rows.resources.find((r) => r.key === candidates[0]!.key) : undefined;
    const templates = one
      ? TEMPLATES.filter((t) => applies(t, one)).map((t) => ({
          name: t.name,
          title: t.title,
          language: t.language,
          reads: t.reads,
          inputs: t.inputs,
          ...(t.note ? { note: t.note } : {}),
          available: t.language === "search" || peer.available,
          ...(t.language === "cypher" && !peer.available ? { refusal: peer.refusal.error, install: peer.refusal.install } : {}),
          ...(t.inputs.length === 0 ? { expanded: expandTemplate(t.name, one) } : {}),
        }))
      : [];
    return c.json({ ref, resolved: candidates.length === 1, candidates, templates, link: viewLinkFor(origin(c), rows, candidates.map((x) => x.key)), sources: stamps(rows) });
  });

  app.get("/api/graphdb/template", async (c) => {
    const pub = refusePublic(c);
    if (pub) return pub;
    const name = c.req.query("name") ?? "";
    const nodeKey = c.req.query("node") ?? "";
    const { rows } = await session.rows();
    const node = rows.resources.find((r) => r.key === nodeKey);
    if (!node) return c.json({ error: `no node ${nodeKey}; resolve it first`, code: "template-node", sources: stamps(rows) }, 404);
    const inputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.req.queries())) if (k.startsWith("in.") && v[0] !== undefined) inputs[k.slice(3)] = v[0];
    let x: Expanded;
    try {
      x = expandTemplate(name, node, inputs);
    } catch (e) {
      if (e instanceof TemplateError) return c.json({ error: e.message, code: e.code, sources: stamps(rows) }, 400);
      throw e;
    }
    if (x.language === "search") {
      const q = new URLSearchParams({ q: x.query, ...(x.env ? { env: x.env } : {}) });
      return c.json({ expanded: x, search: `/api/search?${q}`, link: `${origin(c)}/?${q}`, sources: stamps(rows) });
    }
    return runCypher(c, x.query, x.params ?? {}, { expanded: x });
  });

  return session;
}
