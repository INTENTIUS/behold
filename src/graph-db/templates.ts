/**
 * behold#1027: resolve-from-resource and the investigation templates
 * (behold#1022's design, ruled 2026-10-26).
 *
 * Resolve takes one thing a person or an agent has (a name, an IR id, a block
 * address or a cloud id) and lands on one node, or on the list of candidates
 * when it is ambiguous. It reads the loaded rows in memory, so it works with
 * or without the LadybugDB peer.
 *
 * A template is a fixed query with the node filled in, so a click and an
 * agent run the same query and draw the same view. Each says which language
 * it expands to (ruling Q4 on #1022): a `chant search` path pattern where one
 * can express the question, which keeps working without the peer, and Cypher
 * otherwise. Cypher templates take the node and their inputs as query
 * parameters, never spliced into the text.
 *
 * The catalog lives in chant (#1022 ruling Q5,
 * https://github.com/INTENTIUS/behold/issues/1022#issuecomment-6432728696),
 * as the capability catalog's second kind of entry (INTENTIUS/chant#4531),
 * and behold reads it through src/graph-db/chant-templates.ts. Every chant
 * behold accepts carries it (behold#1005 flipped src/chant-release.ts), so
 * behold keeps no copy of it.
 */
import type { ResourceRow, LoadedRows, SourceKind } from "./rows.ts";
import { CHANT_RELEASE } from "../chant-release.ts";
import { chantTemplates } from "./chant-templates.ts";

export type TemplateLanguage = "search" | "cypher";

/** What answering reads: the declared source, a live read, recorded snapshots, or only the session's database. */
export type TemplateReads = "source" | "live" | "snapshots" | "session";

export interface TemplateInput {
  name: string;
  description: string;
}

export interface Template {
  name: string;
  title: string;
  /** The sources whose nodes it applies to; absent means every source. */
  sources?: readonly SourceKind[];
  inputs: readonly TemplateInput[];
  language: TemplateLanguage;
  /** search: `{{node}}` and `{{<input>}}` are filled in. cypher: `$key` and `$<input>` are parameters. */
  query: string;
  reads: TemplateReads;
  /** What it does not answer, said where it is offered. */
  note?: string;
}

export type TemplateCatalogSource = "chant" | "missing";

export interface TemplateCatalog {
  source: TemplateCatalogSource;
  templates: readonly Template[];
  /** Said where the catalog is listed. */
  note: string;
}

/** chant's templates, or nothing when the installed chant somehow has none. */
export function selectTemplates(fromChant: readonly Template[] | undefined): TemplateCatalog {
  if (fromChant?.length) return { source: "chant", templates: fromChant, note: "chant's investigation templates (@intentius/chant/capabilities/templates, chant#4531)" };
  return { source: "missing", templates: [], note: `the installed chant has no investigation templates; chant ${CHANT_RELEASE.version} or later carries them` };
}

export const TEMPLATE_CATALOG: TemplateCatalog = selectTemplates(chantTemplates());

/** The templates behold offers: {@link TEMPLATE_CATALOG}'s. */
export const TEMPLATES: readonly Template[] = TEMPLATE_CATALOG.templates;

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
  /** search: an env the query is read in. */
  env?: string;
}

export function applies(t: Template, r: Pick<ResourceRow, "source">): boolean {
  return !t.sources || t.sources.includes(r.source);
}

/** Fill one template for one node. */
export function expandTemplate(name: string, node: Pick<ResourceRow, "key" | "source">, inputs: Record<string, string> = {}): Expanded {
  const t = TEMPLATES.find((x) => x.name === name);
  if (!t) throw new TemplateError(`no template ${name} (there are ${TEMPLATES.map((x) => x.name).join(", ")})`, "template-unknown");
  if (!applies(t, node)) throw new TemplateError(`${name} applies to ${t.sources!.join(", ")} nodes, and ${node.key} is a ${node.source} node`, "template-not-applicable");
  for (const i of t.inputs) if (!inputs[i.name]) throw new TemplateError(`${name} needs ${i.name}: ${i.description}`, "template-input");
  for (const k of Object.keys(inputs)) if (!t.inputs.some((i) => i.name === k)) throw new TemplateError(`${name} takes no input ${k}`, "template-input");
  if (t.language === "cypher") return { template: t.name, language: "cypher", reads: t.reads, query: t.query, params: { key: node.key, ...inputs } };
  let q = t.query.replace("{{node}}", node.key);
  let env: string | undefined;
  for (const i of t.inputs) {
    const v = inputs[i.name]!;
    if (i.name === "env") {
      if (!/^[A-Za-z0-9_.-]+$/.test(v)) throw new TemplateError(`env ${JSON.stringify(v)} is not an environment name`, "template-input");
      env = v;
      continue;
    }
    if (!SEARCH_INPUT.test(v)) throw new TemplateError(`${i.name} ${JSON.stringify(v)} is not one search term`, "template-input");
    q = q.replace(`{{${i.name}}}`, v);
  }
  return { template: t.name, language: "search", reads: t.reads, query: q, ...(env ? { env } : {}) };
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
