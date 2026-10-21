/**
 * #825: runtime health and rotation, from `chant lifecycle health <env> --json`.
 *
 * Drift says whether the account matches the source. Health says whether a
 * declared thing is serving: a Route 53 health check, an ECS service, a
 * Container App, a Cloud Run service (chant#4177). chant prints a
 * `chant-health/v1` document and puts every entity it was asked about in
 * exactly one of three places: `entities` (read, with a state of healthy,
 * unhealthy or unknown), `unobserved` (the read failed, with a reason) and
 * `absent` (the provider says it is not deployed). A failed read is never
 * unhealthy, and behold keeps it that way: an unobserved check is a hole with
 * its reason, drawn apart from an unhealthy one.
 *
 * Rotation is behold's, because chant does not model routing. A Route 53
 * record whose `HealthCheckId` names a declared health check is out of
 * rotation when that check is unhealthy, in rotation when it is healthy, and
 * unknown otherwise (unknown, unobserved, absent, or a check behold has no
 * health for). behold never guesses a record out of rotation from a check it
 * could not read.
 *
 * The document is checked against chant's published schema, vendored in
 * src/health-schema/ ({@link HEALTH_SCHEMA_SOURCE}).
 *
 * Pure: the read itself is `readHealth` in src/workspace-reader.ts, the route
 * is src/health-overlay.ts.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import healthSchema from "./health-schema/health.schema.json" with { type: "json" };

/** The document version behold reads. */
export const HEALTH_SCHEMA = "chant-health/v1";

/**
 * Where the vendored schema comes from: chant main after chant PR #4193, the
 * first published shape of chant-health/v1. The file is copied unchanged into
 * src/health-schema/; its `$id` does not resolve.
 */
export const HEALTH_SCHEMA_SOURCE = {
  repo: "INTENTIUS/chant",
  path: "packages/core/src/health.schema.json",
  pr: 4193,
  commit: "d727944c472e95feff72f22ab88c0e1aadfebeea",
} as const;

export const HEALTH_SCHEMA_ID: string = healthSchema.$id;

export type HealthState = "healthy" | "unhealthy" | "unknown";

/** One entity chant read. */
export interface HealthEntry {
  type: string;
  state: HealthState;
  detail: string;
  observedAt: string;
  checkedAt?: string;
}

/** One entity chant could not read: `read-failed`, `no-credentials`, `no-binding`, `unsupported-kind`. */
export interface HealthHole {
  reason: string;
  type?: string;
  detail?: string;
}

/** One lexicon's answer. */
export interface HealthLexiconResult {
  entities: Record<string, HealthEntry>;
  unobserved: Record<string, HealthHole>;
  absent: string[];
}

/** The document `chant lifecycle health <env> --json` prints. A multi-stack project has `stacks` where `lexicons` would be. */
export interface HealthDocument {
  schema: typeof HEALTH_SCHEMA;
  chantVersion?: string;
  environment: string;
  observedAt: string;
  lexicons?: Record<string, HealthLexiconResult>;
  stacks?: Record<string, Record<string, HealthLexiconResult>>;
  summary?: Record<string, number>;
}

/** What behold draws for one node. `unobserved` and `absent` are behold's words for chant's other two places. */
export type NodeHealth =
  | ({ state: HealthState } & Omit<HealthEntry, "state">)
  | { state: "unobserved"; reason: string; type?: string; detail?: string }
  | { state: "absent"; type?: string };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";

/**
 * The schema behold validates with: chant's, with a hole's `reason` loosened
 * to any string. chant may add a reason within v1, and a hole with a reason
 * behold does not know is still a hole, drawn with chant's word for it.
 * Everything else is as chant wrote it, so a state other than healthy,
 * unhealthy or unknown refuses the document.
 */
export function readerHealthSchema(): Record<string, unknown> {
  const schema = structuredClone(healthSchema) as Record<string, any>;
  schema.$defs.hole.properties.reason = { type: "string" };
  return schema;
}

type Validator = ((v: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };
let validator: Validator | undefined;

/**
 * What is wrong with a health document, or nothing: the vendored
 * chant-health/v1 schema ({@link readerHealthSchema}) through ajv. A document
 * it refuses is refused whole, never half drawn.
 */
export function healthProblems(doc: unknown): string[] {
  if (!validator) validator = new Ajv2020({ strict: false, allErrors: true }).compile(readerHealthSchema()) as Validator;
  if (validator(doc)) return [];
  return (validator.errors ?? []).map((e) => `${e.instancePath || "the document"} ${e.message ?? "does not match"}`);
}

/**
 * The lexicon results of a document, single-stack or multi-stack alike, each
 * with the stack it came from. #824: a project that declares `stacks` has its
 * live overlay drawn with ids `<stack>::<name>` (chant's multi-stack form),
 * so its health is keyed the same way, or no card would match it.
 */
function results(doc: HealthDocument): Array<{ stack?: string; result: HealthLexiconResult }> {
  if (doc.lexicons) return Object.values(doc.lexicons).map((result) => ({ result }));
  return Object.entries(doc.stacks ?? {}).flatMap(([stack, byLexicon]) => Object.values(byLexicon).map((result) => ({ stack, result })));
}

/**
 * Per node id, what the document says. `prefix` is the member name in a
 * workspace or an estate, so ids become `<member>/<id>` like every other
 * composed id; in a multi-stack document the id is `<stack>::<name>`.
 */
export function nodeHealthOf(doc: HealthDocument, prefix?: string): Record<string, NodeHealth> {
  const out: Record<string, NodeHealth> = {};
  for (const { stack, result: r } of results(doc)) {
    const id = (name: string) => {
      const local = stack ? `${stack}::${name}` : name;
      return prefix ? `${prefix}/${local}` : local;
    };
    for (const [name, e] of Object.entries(r.entities)) out[id(name)] = { ...e };
    for (const [name, h] of Object.entries(r.unobserved)) out[id(name)] = { state: "unobserved", reason: h.reason, ...(h.type ? { type: h.type } : {}), ...(h.detail ? { detail: h.detail } : {}) };
    for (const name of r.absent) out[id(name)] = { state: "absent" };
  }
  return out;
}

/** Counts per state, plus the records out of rotation. */
export interface HealthCounts {
  healthy: number;
  unhealthy: number;
  unknown: number;
  unobserved: number;
  absent: number;
  outOfRotation: number;
}

export function healthCounts(nodes: Record<string, NodeHealth>, rotation: Record<string, Rotation>): HealthCounts {
  const c: HealthCounts = { healthy: 0, unhealthy: 0, unknown: 0, unobserved: 0, absent: 0, outOfRotation: 0 };
  for (const n of Object.values(nodes)) c[n.state]++;
  c.outOfRotation = Object.values(rotation).filter((r) => r.inRotation === false).length;
  return c;
}

/** A record's place in rotation, derived from the health check its `HealthCheckId` names. */
export interface Rotation {
  record: string;
  /** The health check's node id, or the literal id when the record names one this estate does not declare. */
  check: string;
  /** What behold has for the check: a state, `unobserved`, `absent`, or `none` when it has nothing. */
  checkState: NodeHealth["state"] | "none";
  /** `false` only when the check is unhealthy; `null` is unknown. */
  inRotation: boolean | null;
  /** One line for the card and the pane. */
  line: string;
}

/** The parts of a graph rotation reads. */
export interface RotationGraph {
  nodes: Array<{ id: string; kind?: string; attrs?: Record<string, unknown> }>;
  edges: Array<{ from: string; to: string; viaAttr?: string }>;
}

/** The attribute that names a record's health check (AWS::Route53::RecordSet). */
export const HEALTH_CHECK_ATTR = "HealthCheckId";
const RECORD_KIND = "AWS::Route53::RecordSet";

/**
 * Which check each record names, from one member's graph (ids as that graph
 * has them): an edge labelled `HealthCheckId`, which chant draws for a
 * reference to a declared check, else the record's own `HealthCheckId`
 * attribute, a `$ref` to `<check>.HealthCheckId` or a literal id.
 */
export function recordChecks(graph: RotationGraph): Map<string, { check: string; declared: boolean }> {
  const out = new Map<string, { check: string; declared: boolean }>();
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const e of graph.edges) if (e.viaAttr === HEALTH_CHECK_ATTR && ids.has(e.to)) out.set(e.from, { check: e.to, declared: true });
  for (const n of graph.nodes) {
    if (out.has(n.id) || n.kind !== RECORD_KIND) continue;
    const v = n.attrs?.[HEALTH_CHECK_ATTR];
    if (isRecord(v) && isString(v.$ref)) {
      const target = v.$ref.split(".")[0];
      if (ids.has(target)) out.set(n.id, { check: target, declared: true });
    } else if (isString(v) && v) out.set(n.id, { check: v, declared: ids.has(v) });
  }
  return out;
}

/**
 * Each record's rotation, from one member's graph and the composed health.
 * `prefix` composes the graph's ids the way {@link nodeHealthOf} composed the
 * health's.
 */
export function rotationOf(graph: RotationGraph, health: Record<string, NodeHealth>, prefix?: string): Record<string, Rotation> {
  const id = (name: string) => (prefix ? `${prefix}/${name}` : name);
  const out: Record<string, Rotation> = {};
  for (const [record, { check, declared }] of recordChecks(graph)) {
    const checkId = declared ? id(check) : check;
    const h = declared ? health[checkId] : undefined;
    const checkState = h ? h.state : "none";
    const name = declared ? check : `health check ${check}`;
    const inRotation = checkState === "unhealthy" ? false : checkState === "healthy" ? true : null;
    const line =
      inRotation === false
        ? `out of rotation: ${name} unhealthy`
        : inRotation === true
          ? `in rotation: ${name} healthy`
          : `rotation unknown: ${!declared ? `${name} is not declared here` : checkState === "none" ? `no health read for ${name}` : checkState === "unobserved" ? `${name} not read` : checkState === "absent" ? `${name} not deployed` : `${name} unknown`}`;
    out[id(record)] = { record: id(record), check: checkId, checkState, inRotation, line };
  }
  return out;
}
