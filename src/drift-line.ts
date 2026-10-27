/**
 * behold#998: the drift stream's lines, as behold reads them.
 *
 * chant's drift record (INTENTIUS/chant#4451, `@intentius/chant/drift-record`,
 * `packages/core/src/drift-record.ts`) defines an NDJSON stream with a `type`
 * on every line: one `drift-start` naming the member, the read and every
 * address it expects, one `drift-record` per resource instance as its read
 * finishes, and one `drift-settle`. It is the layout choudoufu's `live-plan
 * -resource` writes (INTENTIUS/choudoufu#2245), and `chant workspace drift
 * --member <name> --stream` prints it.
 *
 * behold#1005: the lists and the version are chant's, re-exported, and
 * {@link decodeDriftLine} decodes with chant's own `decodeDriftLine`, so
 * chant's checks decide which lines are read and its words are the refusal.
 * chant's line is then narrowed to the fields below, the shape a card reads.
 * One difference, from behold#995: a status outside chant's list is kept, not
 * refused, so it can be painted neutral and labelled unknown. chant refuses
 * such a record, so behold's own checks read that line, and a settle line's
 * count of such a status is dropped before chant reads it. Those checks are
 * the narrowing as well: the discriminator, the version, member, engine,
 * read and status from chant's closed lists, and a reason on every
 * `not-observed`. Unknown fields are dropped, as chant's decoder drops them.
 */
import { decodeDriftLine as chantDecodeDriftLine, DRIFT_ENGINES, DRIFT_READS, DRIFT_STATUSES, DRIFT_VERSION, type DriftEngine, type DriftRead, type DriftStatus } from "@intentius/chant/drift-record";
import { UNOBSERVED_REASONS, type UnobservedReason } from "@intentius/chant/observation";

export { DRIFT_ENGINES, DRIFT_READS, DRIFT_STATUSES, DRIFT_VERSION, UNOBSERVED_REASONS };
export type { DriftEngine, DriftRead, DriftStatus, UnobservedReason };

export interface DriftUnobserved {
  reason: UnobservedReason;
  detail?: string;
}

export interface DriftAttribute {
  path: string;
  sensitive?: true;
}

/** A record, with the fields a card reads. chant's `DriftRecord` carries more. */
export interface DriftRecord {
  member: string;
  engine: DriftEngine;
  address: string;
  node: string | null;
  instanceOf?: string;
  observedAt: string;
  read: DriftRead;
  fellBackFrom?: string;
  /**
   * chant's status, or one a newer chant added: behold#995 paints a status it
   * does not know neutral and labelled unknown (src/drift-tone.ts), so the
   * decoder keeps it rather than refusing the line.
   */
  status: DriftStatus | (string & {});
  unobserved?: DriftUnobserved;
  attributes?: DriftAttribute[];
  ownership?: { verdict: string; ownedBy?: string };
  evidence: { tool: string; engineCode?: string };
}

export interface DriftExpected {
  address: string;
  node?: string | null;
  instanceOf?: string;
}

export interface DriftStartLine {
  type: "drift-start";
  drift: typeof DRIFT_VERSION;
  member: string;
  engine: DriftEngine;
  read: DriftRead;
  resource?: string;
  at?: string;
  expected: DriftExpected[];
}

export type DriftRecordLine = DriftRecord & { type: "drift-record" };

export interface DriftSettleLine {
  type: "drift-settle";
  drift: typeof DRIFT_VERSION;
  member: string;
  engine: DriftEngine;
  read: DriftRead;
  counts: Partial<Record<DriftStatus, number>>;
  at?: string;
  notReached?: string[];
}

export type DriftLine = DriftStartLine | DriftRecordLine | DriftSettleLine;

/** A line behold will not read. */
export class DriftLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriftLineError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

function head(v: Record<string, unknown>, type: string): { member: string; engine: DriftEngine; read: DriftRead } {
  if (v.drift !== DRIFT_VERSION) throw new DriftLineError(`a ${type} line says drift ${JSON.stringify(v.drift)}, not "${DRIFT_VERSION}"`);
  if (!nonEmpty(v.member)) throw new DriftLineError(`a ${type} line needs a member`);
  if (!oneOf(DRIFT_ENGINES, v.engine)) throw new DriftLineError(`a ${type} line for ${v.member} names engine ${JSON.stringify(v.engine)}`);
  if (!oneOf(DRIFT_READS, v.read)) throw new DriftLineError(`a ${type} line for ${v.member} names read ${JSON.stringify(v.read)}`);
  return { member: v.member, engine: v.engine, read: v.read };
}

function record(v: Record<string, unknown>): DriftRecordLine {
  const where = `drift record ${JSON.stringify(v.address)} in member ${JSON.stringify(v.member)}`;
  if (!nonEmpty(v.member)) throw new DriftLineError(`${where}: member must be a non-empty string`);
  if (!nonEmpty(v.address)) throw new DriftLineError(`${where}: address must be a non-empty string`);
  if (!oneOf(DRIFT_ENGINES, v.engine)) throw new DriftLineError(`${where}: engine ${JSON.stringify(v.engine)}`);
  if (!oneOf(DRIFT_READS, v.read)) throw new DriftLineError(`${where}: read ${JSON.stringify(v.read)}`);
  if (!nonEmpty(v.status)) throw new DriftLineError(`${where}: status must be a non-empty string`);
  if (v.node !== null && !nonEmpty(v.node)) throw new DriftLineError(`${where}: node must be a graph id or null`);
  if (!nonEmpty(v.observedAt)) throw new DriftLineError(`${where}: observedAt is missing`);
  if (!isObject(v.evidence) || !nonEmpty(v.evidence.tool)) throw new DriftLineError(`${where}: evidence.tool must be a non-empty string`);
  // chant's state-read rule: a state read never says the account matches.
  if (v.read === "state" && oneOf(DRIFT_STATUSES, v.status) && !["recorded", "pending", "not-observed"].includes(v.status)) {
    throw new DriftLineError(`${where}: a state read can only be recorded, pending or not-observed, never ${v.status}`);
  }
  let unobserved: DriftUnobserved | undefined;
  if (v.status === "not-observed") {
    if (!isObject(v.unobserved) || !oneOf(UNOBSERVED_REASONS, v.unobserved.reason)) throw new DriftLineError(`${where}: not-observed needs unobserved.reason`);
    unobserved = { reason: v.unobserved.reason, ...(nonEmpty(v.unobserved.detail) ? { detail: v.unobserved.detail } : {}) };
  }
  const attributes = Array.isArray(v.attributes) && v.status === "drifted"
    ? v.attributes.filter((a): a is Record<string, unknown> => isObject(a) && nonEmpty(a.path)).map((a) => ({ path: a.path as string, ...(a.sensitive === true ? { sensitive: true as const } : {}) }))
    : undefined;
  const own = isObject(v.ownership) && nonEmpty(v.ownership.verdict) ? { verdict: v.ownership.verdict, ...(nonEmpty(v.ownership.ownedBy) ? { ownedBy: v.ownership.ownedBy } : {}) } : undefined;
  return {
    type: "drift-record",
    member: v.member,
    engine: v.engine,
    address: v.address,
    node: v.node as string | null,
    ...(nonEmpty(v.instanceOf) ? { instanceOf: v.instanceOf } : {}),
    observedAt: v.observedAt,
    read: v.read,
    ...(nonEmpty(v.fellBackFrom) ? { fellBackFrom: v.fellBackFrom } : {}),
    status: v.status,
    ...(unobserved ? { unobserved } : {}),
    ...(attributes ? { attributes } : {}),
    ...(own ? { ownership: own } : {}),
    evidence: { tool: v.evidence.tool, ...(nonEmpty(v.evidence.engineCode) ? { engineCode: v.evidence.engineCode } : {}) },
  };
}

/**
 * Read one line of the stream, checking it. Throws {@link DriftLineError}.
 * chant decodes the line and behold narrows chant's result; a record whose
 * status chant does not list is read by behold's own checks (behold#995).
 */
export function decodeDriftLine(text: string): DriftLine {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return decodeOwn(text);
  }
  if (!isObject(v)) return decodeOwn(text);
  const known = (s: unknown) => (DRIFT_STATUSES as readonly unknown[]).includes(s);
  if (v.type === "drift-record" && typeof v.status === "string" && !known(v.status)) return decodeOwn(text);
  let input = text;
  if (v.type === "drift-settle" && isObject(v.counts) && Object.keys(v.counts).some((s) => !known(s))) {
    input = JSON.stringify({ ...v, counts: Object.fromEntries(Object.entries(v.counts).filter(([s]) => known(s))) });
  }
  let line: unknown;
  try {
    line = chantDecodeDriftLine(input);
  } catch (err) {
    throw new DriftLineError((err as Error).message);
  }
  return decodeOwn(JSON.stringify(line));
}

/** behold's own checks: the narrowing after chant's decoder, and the reader of a status chant does not list. */
function decodeOwn(text: string): DriftLine {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    throw new DriftLineError(`a drift line is not JSON: ${(err as Error).message}`);
  }
  if (!isObject(v)) throw new DriftLineError("a drift line must be an object");
  switch (v.type) {
    case "drift-start": {
      const h = head(v, "drift-start");
      if (!Array.isArray(v.expected)) throw new DriftLineError(`the drift-start line for ${h.member} needs an expected array`);
      const expected = v.expected.map((e, i): DriftExpected => {
        if (nonEmpty(e)) return { address: e };
        if (!isObject(e) || !nonEmpty(e.address)) throw new DriftLineError(`the drift-start line for ${h.member}: expected[${i}] needs an address`);
        return { address: e.address, ...(e.node === null || nonEmpty(e.node) ? { node: e.node as string | null } : {}), ...(nonEmpty(e.instanceOf) ? { instanceOf: e.instanceOf } : {}) };
      });
      return { type: "drift-start", drift: DRIFT_VERSION, ...h, ...(nonEmpty(v.resource) ? { resource: v.resource } : {}), ...(nonEmpty(v.at) ? { at: v.at } : {}), expected };
    }
    case "drift-record":
      return record(v);
    case "drift-settle": {
      const h = head(v, "drift-settle");
      if (!isObject(v.counts)) throw new DriftLineError(`the drift-settle line for ${h.member} needs counts`);
      const counts: Partial<Record<DriftStatus, number>> = {};
      for (const [s, n] of Object.entries(v.counts)) {
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new DriftLineError(`the drift-settle line for ${h.member} has a bad count for ${JSON.stringify(s)}`);
        // A status a newer chant added is counted by it and not here (behold#995).
        if (oneOf(DRIFT_STATUSES, s)) counts[s] = n;
      }
      const notReached = Array.isArray(v.notReached) ? v.notReached.filter(nonEmpty) : undefined;
      return { type: "drift-settle", drift: DRIFT_VERSION, ...h, counts, ...(nonEmpty(v.at) ? { at: v.at } : {}), ...(notReached ? { notReached } : {}) };
    }
    default:
      throw new DriftLineError(`a drift line has type ${JSON.stringify(v.type)}, not drift-start, drift-record or drift-settle`);
  }
}

/**
 * The record chant's fold gives an expected address that settled with no
 * record (`notReachedRecord` in chant's drift-record.ts): not-observed,
 * reason `not-reached`, at the settle's time, else the start's.
 */
export function notReachedRecord(start: DriftStartLine, expected: DriftExpected, at: string): DriftRecord {
  return {
    member: start.member,
    engine: start.engine,
    address: expected.address,
    node: expected.node ?? null,
    ...(expected.instanceOf !== undefined && expected.node ? { instanceOf: expected.instanceOf } : {}),
    observedAt: at,
    read: start.read,
    status: "not-observed",
    unobserved: { reason: "not-reached", detail: `the ${start.read} read settled without reporting ${expected.address}` },
    evidence: { tool: start.engine },
  };
}
