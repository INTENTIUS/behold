/**
 * behold#1247: where each member's state lives, for the State tab.
 *
 * An estate with Terraform, CloudFormation and Kubernetes members keeps state
 * in several places. `chant workspace state [--member] [--env] --json`
 * (INTENTIUS/chant#5456) answers, for every member and environment: which
 * substrate holds the state, where, how it is locked, and whether chant's read
 * with the caller's credentials could reach it. The values are each lexicon's,
 * published on its graph meta; chant masks a value that carries a secret and
 * strips credentials from a URL.
 *
 * behold draws a table from that document and probes no backend itself.
 * Reachability is chant's: `reachable`, `unreachable` with a reason, or
 * `unchecked`, which finding a Terraform backend always is. A member whose
 * lexicon publishes nothing (a Kubernetes context, a Pulumi backend) is listed
 * as that, with no row of invented locations, and a member chant could not read
 * carries chant's reason.
 *
 * Every field is kept as chant wrote it. The words for a status are in
 * src/status-vocabulary.ts.
 */
import { floorFor, floorMet, floorRefusal } from "./chant-floors.ts";
import { stateReachLabel, STATE_MEMBER_LABELS } from "./status-vocabulary.ts";
import type { Workspace } from "./workspace.ts";
import { contractRefusal, rootReader, WorkspaceReadError, type WorkspaceDocument, type WorkspaceReader, type WorkspaceRefusal } from "./workspace-reader.ts";

/** The read this module makes, by its name in src/chant-floors.ts. */
export const STATE_LOCATIONS_READ = "state locations";

export type Scalar = string | number | boolean | null;
export type Reach = { status: "reachable" } | { status: "unreachable"; reason: string } | { status: "unchecked"; reason?: string } | { status: string; reason?: string };

/** One place a member's state lives in one environment, as chant wrote it. */
export interface StateLocation {
  environment: string | null;
  unit?: string;
  substrate: string;
  backend: { kind: string; location: Record<string, Scalar> };
  lock: { mechanism: string; location?: Record<string, Scalar> } | null;
  reach: Reach;
}

export interface MemberState {
  member: string;
  kind: string;
  status: string;
  reason: { code: string; message: string } | null;
  published: boolean;
  states: StateLocation[];
}

/** One table row: a location, or a member with none to list (`location` null, and `note` saying why). */
export interface StateRow {
  member: string;
  kind: string;
  environment: string | null;
  unit: string | null;
  substrate: string | null;
  backend: string | null;
  location: Record<string, Scalar> | null;
  lock: { mechanism: string; location?: Record<string, Scalar> } | null;
  reach: { status: string; label: string; reason: string | null } | null;
  /** Why the row has no location: its lexicon publishes none, it was skipped, or it was not read (with chant's reason). */
  note: string | null;
}

export interface StateLocations {
  /** The `--env` asked for, or null for every environment each member names. */
  env: string | null;
  /** The member asked for, or null for all. */
  member: string | null;
  chant: string | null;
  readAt: string | null;
  members: MemberState[];
  rows: StateRow[];
  summary: { members: number; published: number; locations: number; unreachable: number };
}

export type StateLocationsRead = { ok: true; state: StateLocations } | { ok: false; refusal: WorkspaceRefusal };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const scalars = (v: unknown): Record<string, Scalar> => {
  const out: Record<string, Scalar> = {};
  if (isRecord(v)) for (const [k, x] of Object.entries(v)) if (x === null || ["string", "number", "boolean"].includes(typeof x)) out[k] = x as Scalar;
  return out;
};

/** The refusal for a chant below the state-locations floor, or undefined. An unknown version meets it. */
export function stateFloorRefusal(version: string | undefined): WorkspaceRefusal | undefined {
  const f = floorFor(STATE_LOCATIONS_READ);
  return floorMet(f, version) ? undefined : floorRefusal(f, version);
}

/** The words for a member that has no location to list. */
function noteFor(m: MemberState): string | null {
  if (m.status === "failed") return `${STATE_MEMBER_LABELS.failed}${m.reason ? `: ${m.reason.message || m.reason.code}` : ""}`;
  if (m.status === "skipped") return `${STATE_MEMBER_LABELS.skipped}${m.reason ? `: ${m.reason.message || m.reason.code}` : ""}`;
  if (!m.published) return STATE_MEMBER_LABELS.unpublished;
  return m.states.length === 0 ? "published no location" : null;
}

/** The state locations a `workspace state` document lists, or chant's refusal. */
export function stateLocationsFromDocument(doc: WorkspaceDocument, opts: { member?: string | null; readAt?: string } = {}): StateLocationsRead {
  const contract = contractRefusal(doc, "state");
  if (contract) return { ok: false, refusal: contract };
  if (isRecord(doc.error)) {
    const code = String(doc.error.code ?? "unknown");
    return { ok: false, refusal: { error: `chant could not read the workspace's state locations: ${code}: ${String(doc.error.message ?? "")}`, code, remedy: "`chant workspace check` names the problem and where it is." } };
  }
  const members: MemberState[] = [];
  for (const m of arr(doc.members)) {
    if (!isRecord(m) || typeof m.member !== "string") continue;
    const states: StateLocation[] = [];
    for (const s of arr(m.states)) {
      if (!isRecord(s) || !isRecord(s.backend) || !isRecord(s.reach)) continue;
      states.push({
        environment: str(s.environment),
        ...(typeof s.unit === "string" ? { unit: s.unit } : {}),
        substrate: String(s.substrate ?? ""),
        backend: { kind: String(s.backend.kind ?? ""), location: scalars(s.backend.location) },
        lock: isRecord(s.lock) ? { mechanism: String(s.lock.mechanism ?? ""), ...(isRecord(s.lock.location) ? { location: scalars(s.lock.location) } : {}) } : null,
        reach: { status: String(s.reach.status ?? ""), ...(typeof s.reach.reason === "string" ? { reason: s.reach.reason } : {}) } as Reach,
      });
    }
    members.push({
      member: m.member,
      kind: String(m.kind ?? ""),
      status: String(m.status ?? ""),
      reason: isRecord(m.reason) ? { code: String(m.reason.code ?? ""), message: String(m.reason.message ?? "") } : null,
      published: m.published === true,
      states,
    });
  }
  const rows: StateRow[] = [];
  for (const m of members) {
    const note = noteFor(m);
    if (m.states.length === 0 || m.status !== "read") {
      rows.push({ member: m.member, kind: m.kind, environment: null, unit: null, substrate: null, backend: null, location: null, lock: null, reach: null, note: note ?? "no state location" });
      continue;
    }
    for (const s of m.states) {
      rows.push({
        member: m.member,
        kind: m.kind,
        environment: s.environment,
        unit: s.unit ?? null,
        substrate: s.substrate,
        backend: s.backend.kind,
        location: s.backend.location,
        lock: s.lock,
        reach: { status: s.reach.status, label: stateReachLabel(s.reach.status), reason: "reason" in s.reach && typeof s.reach.reason === "string" ? s.reach.reason : null },
        note: null,
      });
    }
  }
  const sum = isRecord(doc.summary) ? doc.summary : {};
  const n = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);
  return {
    ok: true,
    state: {
      env: str(doc.environment),
      member: opts.member ?? null,
      chant: str(doc.chant),
      readAt: opts.readAt ?? null,
      members,
      rows,
      summary: {
        members: n(sum.members, members.length),
        published: n(sum.published, members.filter((m) => m.published).length),
        locations: n(sum.locations, members.reduce((k, m) => k + m.states.length, 0)),
        unreachable: n(sum.unreachable, members.reduce((k, m) => k + m.states.filter((s) => s.reach.status === "unreachable").length, 0)),
      },
    },
  };
}

/**
 * Read the state locations of a served workspace: one `workspace state` read,
 * for `env` and `member` when given. The caller has checked
 * {@link stateFloorRefusal} and that both are names.
 */
export async function readStateLocations(ws: Workspace, opts: { env?: string; member?: string; reader?: WorkspaceReader; now?: () => Date } = {}): Promise<StateLocationsRead> {
  const reader = opts.reader ?? rootReader(ws.root);
  const readAt = (opts.now ?? (() => new Date()))().toISOString();
  const args = [...(opts.member ? ["--member", opts.member] : []), ...(opts.env ? ["--env", opts.env] : [])];
  let doc: WorkspaceDocument;
  try {
    doc = await reader.read("state", args);
  } catch (e) {
    if (e instanceof WorkspaceReadError) return { ok: false, refusal: e.refusal };
    throw e;
  }
  return stateLocationsFromDocument(doc, { member: opts.member ?? null, readAt });
}
