/**
 * behold#1162: the template and resolve rules that read only rows and the
 * catalog, split from ./templates.ts so the exported page's WebAssembly build
 * (./browser.ts) runs the same code as the server. Nothing here imports Node
 * or chant's library; ./templates.ts reads the catalog from chant and
 * re-exports all of this.
 */
import type { ResourceRow, LoadedRows, SourceKind } from "./rows.ts";

export type TemplateLanguage = "search" | "cypher";

/** What answering reads: the declared source, a live read, recorded snapshots, or only the session's database. */
export type TemplateReads = "source" | "live" | "snapshots" | "session";

/** Where a template came from: chant's own catalog, or the project's `.chant/templates.json`. */
export type TemplateOrigin = "chant" | "project";

export interface TemplateInput {
  name: string;
  /** scope: the environment the query is read in, passed as the env. term: a value filled into the query. */
  kind: "scope" | "term";
  description: string;
}

export interface Template {
  name: string;
  title: string;
  origin: TemplateOrigin;
  /** The sources whose nodes it applies to; absent means every source. */
  sources?: readonly SourceKind[];
  /** The node kinds it applies to, as the graph holds them; absent means every kind. */
  kinds?: readonly string[];
  inputs: readonly TemplateInput[];
  language: TemplateLanguage;
  /** search: `{{node}}` and `{{<input>}}` are filled in. cypher: `$key` and `$<input>` are parameters. */
  query: string;
  reads: TemplateReads;
  /** What it does not answer, said where it is offered. */
  note?: string;
}

/**
 * A project entry left out of the catalog. `by` is the check that refused it:
 * chant's shape check (`templateCatalog`), behold's own, or the engine's
 * prepare when the session's database opened. `message` names the file and
 * the field.
 */
export interface RefusedTemplate {
  id?: string;
  file: string;
  field?: string;
  message: string;
  by: "chant" | "behold" | "engine";
}

export type TemplateCatalogSource = "chant" | "missing";

export interface TemplateCatalog {
  source: TemplateCatalogSource;
  templates: readonly Template[];
  refused: readonly RefusedTemplate[];
  /** Said where the catalog is listed. */
  note: string;
  /** A loaded project entry's field, such as `templates[2].query.text`, for a refusal made after chant's. */
  fieldOf?: (id: string, rest: string) => string | undefined;
}

/**
 * The catalog with the project's Cypher templates the engine refused moved
 * to `refused`. `check` prepares one query without running it and answers
 * the engine's message, or undefined when it binds and is read-only. `file`
 * is the project's templates file, as chant names it.
 */
export async function engineRefusals(catalog: TemplateCatalog, check: (cypher: string) => Promise<string | undefined>, file: string): Promise<TemplateCatalog> {
  const kept: Template[] = [];
  const refused = [...catalog.refused];
  for (const t of catalog.templates) {
    const why = t.origin === "project" && t.language === "cypher" ? await check(t.query) : undefined;
    if (!why) {
      kept.push(t);
      continue;
    }
    const field = catalog.fieldOf?.(t.name, ".query.text");
    refused.push({
      id: t.name,
      file,
      ...(field ? { field } : {}),
      message: `${file}${field ? ` ${field}` : ""}: template ${t.name}: LadybugDB cannot run it on this project's graph: ${why}`,
      by: "engine",
    });
  }
  return { ...catalog, templates: kept, refused };
}

/** A search input is a term, never a second clause: letters, digits and `_ : . - / * ( ) ,` only. */
const SEARCH_INPUT = /^[A-Za-z0-9_:.\-/*(),]+$/;

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly code: "template-unknown" | "template-input" | "template-not-applicable",
  ) {
    super(message);
  }
}

export interface Expanded {
  template: string;
  language: TemplateLanguage;
  reads: TemplateReads;
  /** search: the chant search query. cypher: the statement. */
  query: string;
  /** cypher: the parameters. */
  params?: Record<string, string>;
  /** The scope input's value: the env a search query is read in. */
  env?: string;
}

type TemplateNode = Pick<ResourceRow, "key" | "source"> & { kind?: string; scopeKey?: string };

/** Whether a template is offered on a node: its sources, and its kinds when it names them. */
export function applies(t: Template, r: Pick<TemplateNode, "source" | "kind">): boolean {
  return (!t.sources || t.sources.includes(r.source)) && (!t.kinds || (r.kind !== undefined && t.kinds.includes(r.kind)));
}

/**
 * The id a chant search query names a node by. A member's node is keyed
 * `<member>/<id>` (scope key `chant/<member>`), and `chant workspace search`
 * matches a pattern's id against each member's own ids, so the member prefix
 * comes off. A single project's node (`chant/.`) is keyed by its id already.
 */
export function searchIdOf(node: Pick<ResourceRow, "key"> & { scopeKey?: string }): string {
  const member = node.scopeKey?.startsWith("chant/") ? node.scopeKey.slice("chant/".length) : undefined;
  if (member && member !== "." && node.key.startsWith(`${member}/`)) return node.key.slice(member.length + 1);
  return node.key;
}

/** Fill one template of `templates` (a session's catalog) for one node. */
export function expandTemplate(templates: readonly Template[], name: string, node: TemplateNode, inputs: Record<string, string> = {}): Expanded {
  const t = templates.find((x) => x.name === name);
  if (!t) throw new TemplateError(`no template ${name} (there are ${templates.map((x) => x.name).join(", ")})`, "template-unknown");
  if (!applies(t, node)) {
    const what = t.sources && !t.sources.includes(node.source) ? `${t.sources.join(", ")} nodes, and ${node.key} is a ${node.source} node` : `${t.kinds!.join(", ")}, and ${node.key} is ${node.kind ? `a ${node.kind}` : "of no kind"}`;
    throw new TemplateError(`${name} applies to ${what}`, "template-not-applicable");
  }
  for (const i of t.inputs) if (!inputs[i.name]) throw new TemplateError(`${name} needs ${i.name}: ${i.description}`, "template-input");
  for (const k of Object.keys(inputs)) if (!t.inputs.some((i) => i.name === k)) throw new TemplateError(`${name} takes no input ${k}`, "template-input");
  let env: string | undefined;
  for (const i of t.inputs) {
    if (i.kind !== "scope") continue;
    const v = inputs[i.name]!;
    if (!/^[A-Za-z0-9_.-]+$/.test(v)) throw new TemplateError(`${i.name} ${JSON.stringify(v)} is not an environment name`, "template-input");
    env = v;
  }
  const head = { template: t.name, reads: t.reads, ...(env ? { env } : {}) };
  if (t.language === "cypher") {
    // A scope says where the query is read, not part of its text (chant's expandTemplate leaves it out of the parameters too).
    const params: Record<string, string> = { key: node.key };
    for (const i of t.inputs) if (i.kind !== "scope") params[i.name] = inputs[i.name]!;
    return { ...head, language: "cypher", query: t.query, params };
  }
  let q = t.query.replace("{{node}}", searchIdOf(node));
  for (const i of t.inputs) {
    if (i.kind === "scope") continue;
    const v = inputs[i.name]!;
    if (!SEARCH_INPUT.test(v)) throw new TemplateError(`${i.name} ${JSON.stringify(v)} is not one search term`, "template-input");
    q = q.replace(`{{${i.name}}}`, v);
  }
  return { ...head, language: "search", query: q };
}

export type MatchedBy = "key" | "id" | "cloud-id" | "native-id" | "address" | "name";

export interface Candidate {
  key: string;
  kind: string;
  source: SourceKind;
  scopeKey: string;
  name: string;
  matchedBy: MatchedBy;
  observedAt: string;
}

/** The order a match is trusted in: an exact key first, a name last. */
const RANK: Record<MatchedBy, number> = { key: 0, id: 1, "cloud-id": 2, "native-id": 3, address: 4, name: 5 };

export const MAX_CANDIDATES = 50;

/**
 * Resolve a name, IR id, address or cloud id to candidates (behold#1022
 * "Resolve"). An exact key is one node. Otherwise every node matched by the
 * best rule that matched any, so a cloud id never loses to a node that only
 * shares its name.
 */
export function resolveResource(rows: Pick<LoadedRows, "resources" | "knownAs">, ref: string): Candidate[] {
  const q = ref.trim();
  if (!q) return [];
  const lower = q.toLowerCase();
  const byKey = new Map(rows.resources.map((r) => [r.key, r]));
  const hits = new Map<string, MatchedBy>();
  const hit = (key: string, how: MatchedBy) => {
    const had = hits.get(key);
    if (had === undefined || RANK[how] < RANK[had]) hits.set(key, how);
  };
  if (byKey.has(q)) hit(q, "key");
  for (const k of rows.knownAs) if (k.value === q || k.value === lower) hit(k.key, "cloud-id");
  for (const r of rows.resources) {
    if (r.id === q) hit(r.key, "id");
    if (r.nativeId && r.nativeId === q) hit(r.key, "native-id");
    if (r.address && r.address === q) hit(r.key, "address");
    if (r.name && r.name === q) hit(r.key, "name");
  }
  if (hits.get(q) === "key") return [candidate(byKey.get(q)!, "key")];
  const best = Math.min(...[...hits.values()].map((h) => RANK[h]));
  return [...hits]
    .filter(([k, h]) => RANK[h] === best && byKey.has(k))
    .map(([k, h]) => candidate(byKey.get(k)!, h))
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, MAX_CANDIDATES);
}

function candidate(r: ResourceRow, matchedBy: MatchedBy): Candidate {
  return { key: r.key, kind: r.kind, source: r.source, scopeKey: r.scopeKey, name: r.name, matchedBy, observedAt: r.observedAt };
}
