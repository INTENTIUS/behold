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
 * and behold reads it as data through src/graph-db/chant-templates.ts. While
 * `CHANT_RELEASE.released` is false (src/chant-release.ts) a published chant
 * has no catalog, so {@link STUB_TEMPLATES} is the fallback: the same ids,
 * the same queries, Cypher binding `$key`.
 *
 * TODO(behold#1027, chant#4531): when the switch flips, delete
 * STUB_TEMPLATES and the fallback in {@link selectTemplates}.
 */
import type { ResourceRow, LoadedRows, SourceKind } from "./rows.ts";
import { CHANT_RELEASE } from "../chant-release.ts";
import { loadChantTemplates } from "./chant-templates.ts";

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

/** behold's copy of chant#4531's initial set, for a chant without the catalog. */
export const STUB_TEMPLATES: readonly Template[] = [
  {
    name: "dependents",
    title: "What depends on it",
    sources: ["chant"],
    inputs: [],
    language: "search",
    query: "->*{{node}}",
    reads: "source",
  },
  {
    name: "dependencies",
    title: "What it depends on",
    sources: ["chant"],
    inputs: [],
    language: "search",
    query: "<-*{{node}}",
    reads: "source",
  },
  {
    name: "paths-to-kind",
    title: "Paths from it to a kind",
    sources: ["chant"],
    inputs: [{ name: "kind", description: "A kind or type, as kind: takes it (aws_internet_gateway, EC2::InternetGateway)." }],
    language: "search",
    query: "{{node}} ->*kind:{{kind}}",
    reads: "source",
  },
  {
    name: "capability",
    title: "Whether a capability holds for it",
    sources: ["chant"],
    inputs: [{ name: "capability", description: "A capability from chant's catalog, with its arguments: internet-reachable(22)." }],
    language: "search",
    query: "{{node}} cap:{{capability}}",
    reads: "source",
  },
  {
    name: "drift",
    title: "Drift",
    sources: ["chant"],
    inputs: [{ name: "env", description: "The environment to read live." }],
    language: "search",
    query: "{{node}}",
    reads: "live",
    note: "Draws the node in the environment's live read, coloured by drift.",
  },
  {
    name: "dependents-all",
    title: "What depends on it, across every source",
    inputs: [],
    language: "cypher",
    query: "MATCH (o:Resource)-[:REF*1..6]->(r:Resource {key: $key}) RETURN DISTINCT o.key AS key, o.kind AS kind, o.scopeKey AS scope",
    reads: "session",
  },
  {
    name: "dependencies-all",
    title: "What it depends on, across every source",
    inputs: [],
    language: "cypher",
    query: "MATCH (r:Resource {key: $key})-[:REF*1..6]->(o:Resource) RETURN DISTINCT o.key AS key, o.kind AS kind, o.scopeKey AS scope",
    reads: "session",
  },
  {
    name: "ownership",
    title: "Ownership",
    inputs: [],
    language: "cypher",
    query:
      "MATCH (r:Resource {key: $key}) OPTIONAL MATCH (r)-[:KNOWN_AS]->(:CloudId)<-[:KNOWN_AS]-(o:Resource) WHERE o.key <> r.key " +
      "RETURN r.key AS key, r.ownership AS ownership, r.engineOwnership AS engineOwnership, r.facts AS facts, r.observedAt AS observedAt, collect(DISTINCT o.key) AS sameObject",
    reads: "session",
    note: "ownership is chant's verdict (owned or foreign); engineOwnership is an engine's (bound, unowned, pending or foreign). Absent is unknown, never guessed. A cloud listing reads markers only.",
  },
  {
    name: "same-object",
    title: "The same object in other sources",
    inputs: [],
    language: "cypher",
    query: "MATCH (r:Resource {key: $key})-[:KNOWN_AS]->(c:CloudId)<-[:KNOWN_AS]-(o:Resource) WHERE o.scopeKey <> r.scopeKey RETURN DISTINCT o.key AS key, o.scopeKey AS scope, c.value AS cloudId, c.kind AS cloudIdKind",
    reads: "session",
  },
  {
    name: "readers",
    title: "Who reads it from another estate or root",
    inputs: [],
    language: "cypher",
    query:
      "MATCH (o:Resource)-[e:REF]->(r:Resource {key: $key}) WHERE o.scopeKey <> r.scopeKey RETURN o.key AS key, o.scopeKey AS scope, e.viaAttr AS via, e.origin AS origin, e.rule AS rule " +
      "UNION MATCH (r:Resource {key: $key})-[:KNOWN_AS]->(:CloudId)<-[:KNOWN_AS]-(t:Resource)<-[e:REF]-(o:Resource) WHERE o.scopeKey <> r.scopeKey RETURN o.key AS key, o.scopeKey AS scope, e.viaAttr AS via, e.origin AS origin, e.rule AS rule",
    reads: "session",
    note: "A derived edge (origin derived, rule identity:<kind>) is an identity match, not a declared reference.",
  },
  {
    name: "history",
    title: "History",
    inputs: [],
    language: "cypher",
    query: "MATCH (r:Resource {key: $key}) RETURN r.key AS key, r.facts AS facts, r.version AS version, r.observedAt AS observedAt",
    reads: "snapshots",
    note: "The record's versions come from facts.recordVersions, when the engine ran with -history or --versions. Snapshot history (chant#4519's store) is not loaded into the session yet.",
  },
];

export type TemplateCatalogSource = "chant" | "behold-stub" | "missing";

export interface TemplateCatalog {
  source: TemplateCatalogSource;
  templates: readonly Template[];
  /** Said where the catalog is listed. */
  note: string;
}

/**
 * chant's templates when the installed chant has them. Otherwise, while the
 * chant release is not out, behold's stub; once it is out, nothing, because
 * every chant behold accepts then carries the catalog.
 */
export function selectTemplates(fromChant: readonly Template[] | undefined, released: boolean = CHANT_RELEASE.released): TemplateCatalog {
  if (fromChant) return { source: "chant", templates: fromChant, note: "chant's investigation templates (@intentius/chant/capabilities/templates.json, chant#4531)" };
  if (released)
    return { source: "missing", templates: [], note: `the installed chant has no investigation templates; chant ${CHANT_RELEASE.version} or later carries them` };
  return { source: "behold-stub", templates: STUB_TEMPLATES, note: `behold's stub of chant's templates: the installed chant predates ${CHANT_RELEASE.version} (chant#4531)` };
}

export const TEMPLATE_CATALOG: TemplateCatalog = selectTemplates(await loadChantTemplates());

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
