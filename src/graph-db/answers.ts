/**
 * behold#1162: what the graph pane's query, resolve and template routes
 * answer, as status and body, split from ./pane.ts so the exported page's
 * WebAssembly build (./browser.ts) answers with the same code. The routes in
 * ./pane.ts hand these a session that reads `@ladybugdb/core`; the browser
 * hands them one that reads `@ladybugdb/wasm-core` over `graphdb.json`.
 *
 * Nothing here imports Node.
 */
import { CypherRefused, parseParams, type CypherAnswer } from "./cypher.ts";
import type { PeerRefusal } from "./peer.ts";
import type { LoadedRows, SourceStamp } from "./rows.ts";
import { TemplateError, applies, expandTemplate, resolveResource, type Expanded, type TemplateCatalog } from "./template-rules.ts";

/** A route's answer: its HTTP status and its JSON body. */
export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

/** Why the engine cannot run Cypher: the server's missing peer, or the browser's engine that did not load. */
export type EngineRefusal = PeerRefusal | { error: string; code: string; remedy: string; install?: string; stillWorks?: string[] };

/** Whether the engine is there to run Cypher. */
export type PeerState = { available: true; version?: string } | { available: false; refusal: EngineRefusal };

/** What answering reads, from whichever engine holds the rows. */
export interface PaneReads {
  /** Where a view link points: the serve's origin, or the exported bundle's folder. */
  origin: string;
  rows(): Promise<LoadedRows>;
  /** The template catalog as offered (project Cypher templates checked on the engine when it is open). */
  catalog(): Promise<TemplateCatalog>;
  peer(): Promise<PeerState>;
  /** Run one read-only query; throws {@link CypherRefused}, or an error {@link refuse} answers. */
  run(cypher: string, params: Record<string, unknown>): Promise<CypherAnswer>;
  /** An answer for an error `run` threw that is not a CypherRefused, such as the server's missing peer. */
  refuse?(e: unknown, rows: LoadedRows): Answer | undefined;
}

export const stamps = (rows: LoadedRows): SourceStamp[] => rows.sources;

/** The counts the pane's header shows. */
export function countsOf(r: LoadedRows): { resources: number; cloudIds: number; knownAs: number; refs: number; derived: number } {
  return { resources: r.resources.length, cloudIds: r.cloudIds.length, knownAs: r.knownAs.length, refs: r.refs.length, derived: r.refs.filter((e) => e.origin === "derived").length };
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

/** The remedy a refused query carries. */
export const CYPHER_REMEDY = "The graph holds Resource, CloudId, KNOWN_AS and REF; see GET /api/graphdb for what is loaded.";

/** One query run, as the query and template routes answer it. */
export async function cypherAnswer(r: PaneReads, cypher: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Answer> {
  const rows = await r.rows();
  try {
    const a = await r.run(cypher, params);
    return { status: 200, body: { ...extra, columns: a.columns, rows: a.rows, keys: a.keys, truncated: a.truncated, draw: subgraphOf(rows, a.keys), link: viewLinkFor(r.origin, rows, a.keys), sources: stamps(rows) } };
  } catch (e) {
    const mapped = r.refuse?.(e, rows);
    if (mapped) return mapped;
    if (e instanceof CypherRefused) return { status: 400, body: { error: e.message, code: e.code, remedy: CYPHER_REMEDY, ...extra, sources: stamps(rows) } };
    throw e;
  }
}

/** GET /api/graphdb/query: `cypher` and `params` (a JSON object, as sent). */
export async function queryAnswer(r: PaneReads, cypher: string, rawParams: string | null | undefined): Promise<Answer> {
  let params: Record<string, unknown>;
  try {
    params = parseParams(rawParams);
  } catch (e) {
    return { status: 400, body: { error: (e as Error).message, code: (e as CypherRefused).code ?? "cypher-invalid" } };
  }
  return cypherAnswer(r, cypher, params, { cypher });
}

/** GET /api/graphdb/resolve: `ref` to candidates, with the templates that apply to the one it lands on. */
export async function resolveAnswer(r: PaneReads, ref: string): Promise<Answer> {
  if (!ref.trim()) return { status: 400, body: { error: "resolve needs ref: a name, an IR id, a block address or a cloud id", code: "resolve-empty" } };
  const rows = await r.rows();
  const candidates = resolveResource(rows, ref);
  const peer = await r.peer();
  const cat = await r.catalog();
  const one = candidates.length === 1 ? rows.resources.find((x) => x.key === candidates[0]!.key) : undefined;
  const templates = one
    ? cat.templates.filter((t) => applies(t, one)).map((t) => ({
        name: t.name,
        title: t.title,
        origin: t.origin,
        language: t.language,
        reads: t.reads,
        inputs: t.inputs,
        ...(t.note ? { note: t.note } : {}),
        available: t.language === "search" || peer.available,
        ...(t.language === "cypher" && !peer.available ? { refusal: peer.refusal.error, ...(peer.refusal.install !== undefined ? { install: peer.refusal.install } : {}) } : {}),
        ...(t.inputs.length === 0 ? { expanded: expandTemplate(cat.templates, t.name, one) } : {}),
      }))
    : [];
  return { status: 200, body: { ref, resolved: candidates.length === 1, candidates, templates, refused: cat.refused, link: viewLinkFor(r.origin, rows, candidates.map((x) => x.key)), sources: stamps(rows) } };
}

/** GET /api/graphdb/template: one template filled for one node; a Cypher one runs. */
export async function templateAnswer(r: PaneReads, name: string, nodeKey: string, inputs: Record<string, string>): Promise<Answer> {
  const rows = await r.rows();
  const node = rows.resources.find((x) => x.key === nodeKey);
  if (!node) return { status: 404, body: { error: `no node ${nodeKey}; resolve it first`, code: "template-node", sources: stamps(rows) } };
  const cat = await r.catalog();
  let x: Expanded;
  try {
    x = expandTemplate(cat.templates, name, node, inputs);
  } catch (e) {
    if (e instanceof TemplateError) return { status: 400, body: { error: e.message, code: e.code, sources: stamps(rows) } };
    throw e;
  }
  if (x.language === "search") {
    const q = new URLSearchParams({ q: x.query, ...(x.env ? { env: x.env } : {}) });
    return { status: 200, body: { expanded: x, search: `/api/search?${q}`, link: `${r.origin}/?${q}`, sources: stamps(rows) } };
  }
  return cypherAnswer(r, x.query, x.params ?? {}, { expanded: x });
}

/** A catalog as the routes list it: the templates and the refused project entries, without its helpers. */
export function listedCatalog(cat: TemplateCatalog, engineChecked: boolean) {
  return { templates: cat.templates, refused: cat.refused, catalog: cat.note, catalogSource: cat.source, engineChecked };
}
