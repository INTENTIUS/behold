/**
 * #683: feature flags on the graph, on or off per environment.
 *
 * A flag is a workspace record (chant#4024) naming a member, the build
 * parameter of that member it backs, an owner, the work item it hides and a
 * value per environment. `chant workspace status <env> --json` lists each
 * member's flags as `featureFlags` (chant 0.124.29 and newer; null when the
 * records can't be read, absent from an older chant), with `stale`, the
 * stale-flag lint's verdict (WSP118).
 *
 * Which cards a flag affects: chant names no graph node that reads a build
 * parameter (the graph carries no parameter reads, and a release target's
 * `params` are per member), so behold marks every card of the flag's member
 * and says so (`nodes: "member"`). Where a waiting gate's stored change set
 * moves the flag's parameter, the entry that moves it is read as chant wrote
 * it, `param:<param>` on the attribute, with the graph node chant mapped the
 * entry to; a release's `chant:component` entry has none, so it is listed by
 * component, never placed on a card behold chose.
 *
 * Turning a flag on is never a toggle here: behold writes no flag record. A
 * flip that waits at a gate (a release cut from the commit that changed the
 * record, promoted to the environment) is opened as that gate's change set
 * (#681). Otherwise the answer carries the lines a person runs: amend the
 * record with chant and commit it. The change set appears once a release cut
 * from that commit is promoted and waits at the environment's gate.
 *
 * Reads, all through the read contract (src/workspace-reader.ts): `status`
 * once per environment in promotion order, and `change-set show` once per
 * waiting gate with a stored change set of a member that has flags. Floors in
 * src/chant-floors.ts, checked by the route before anything is spawned.
 */
import { floorFor, floorMet, floorRefusal } from "./chant-floors.ts";
import { showRefusal } from "./change-set-overlay.ts";
import { promotionOrder } from "./trunk-lane.ts";
import type { Workspace } from "./workspace.ts";
import { gatesFromStatus, type WorkspaceGate } from "./workspace-gates.ts";
import { rootReader, WorkspaceReadError, type WorkspaceDocument, type WorkspaceReader, type WorkspaceRefusal } from "./workspace-reader.ts";

/** The reads the flags make, by their names in src/chant-floors.ts. */
export const FLAG_READS = ["feature flags", "promotion order", "change set"] as const;

export type FlagValue = string | number | boolean;
/** A flag's state in one environment: `on` (true), `off` (false), `default` (the record gives no value, so the parameter's default builds), `set` (a string or number). */
export type FlagState = "on" | "off" | "default" | "set";

/** A waiting gate whose change set moves the flag's parameter. */
export interface FlagWaiting {
  env: string;
  /** The gate's key, `<member>/<op>/<gate>`, as /api/workspace/change-set takes it. */
  gate: string;
  changeSet: string;
  releaseDigest: string | null;
  gitSha: string | null;
  /** The parameter's value before and after, as the change set writes them. */
  before: unknown;
  after: unknown;
  /** The entries that move it: their address (a component, for a release) and the node chant mapped, or null. */
  entries: { address: string; node: string | null }[];
}

/** What a person runs to turn the flag on in one environment. */
export interface FlagTurnOn {
  env: string;
  lines: string[];
}

export interface FlagView {
  /** `<member>/<id>`. */
  key: string;
  member: string;
  id: string;
  param: string;
  owner: string;
  work: { id: string; state: string | null } | null;
  implements: { id: string; state: string | null; confirmed: boolean }[];
  /** The stale-flag lint's verdict (WSP118): due for removal. */
  stale: boolean;
  kind: string;
  path: string;
  /** The values as the record writes them. */
  values: Record<string, FlagValue>;
  /** Per environment of {@link FeatureFlags.environments}: the value and state. */
  envs: Record<string, { value: FlagValue | null; state: FlagState }>;
  waiting: FlagWaiting[];
  turnOn: FlagTurnOn[];
}

export interface FeatureFlags {
  /** The environments in promotion order, then any other a flag names, in the order first named. */
  environments: string[];
  order: "promotion" | "env";
  flags: FlagView[];
  /** How cards are tied to flags: every card of the flag's member, since chant names no node that reads a parameter. */
  nodes: "member";
  /** Members whose flag records chant could not read (`featureFlags: null`). */
  unreadable: string[];
  /** Reads that failed without stopping the answer: a status in one environment, or a gate's change set. */
  refusals: { env: string; gate?: string; error: string; remedy: string }[];
  read: { at: string };
}

export type FlagsRead = { ok: true; flags: FeatureFlags } | { ok: false; refusal: WorkspaceRefusal };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isValue = (v: unknown): v is FlagValue => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** The first floor of the flags' reads the project's chant does not meet, as the tab's refusal. */
export function flagsFloorRefusal(version: string | undefined): WorkspaceRefusal | undefined {
  for (const read of FLAG_READS) {
    const f = floorFor(read);
    if (!floorMet(f, version)) return floorRefusal(f, version);
  }
  return undefined;
}

/** A value's state in an environment. */
export function flagState(value: FlagValue | undefined): FlagState {
  if (value === undefined) return "default";
  if (value === true) return "on";
  if (value === false) return "off";
  return "set";
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The lines that turn `flag` on in `env`: amend the record's values with chant, then commit the record. */
export function turnOnLines(flag: Pick<FlagView, "id" | "kind" | "path" | "values">, env: string): string[] {
  const values = { ...flag.values, [env]: true };
  return [
    `echo ${shellQuote(JSON.stringify({ values }))} | chant workspace records amend ${flag.id} --kind ${flag.kind} --set -`,
    `git commit -m ${shellQuote(`flags: turn on ${flag.id} in ${env}`)} ${flag.path}`,
  ];
}

/** The flags status lists, per member, before any gate is read. `null` when no member carries `featureFlags` (a chant older than 0.124.29). */
export function flagsFromStatus(status: WorkspaceDocument): { flags: Omit<FlagView, "envs" | "waiting" | "turnOn">[]; unreadable: string[] } | null {
  const members = arr(status.members).filter(isRecord);
  if (!members.some((m) => "featureFlags" in m)) return null;
  const flags: Omit<FlagView, "envs" | "waiting" | "turnOn">[] = [];
  const unreadable: string[] = [];
  for (const m of members) {
    const member = str(m.name);
    if (!member || !("featureFlags" in m)) continue;
    if (m.featureFlags === null) {
      unreadable.push(member);
      continue;
    }
    for (const f of arr(m.featureFlags)) {
      if (!isRecord(f) || !str(f.id)) continue;
      const values: Record<string, FlagValue> = {};
      if (isRecord(f.values)) for (const [env, v] of Object.entries(f.values)) if (isValue(v)) values[env] = v;
      const work = isRecord(f.work) && str(f.work.id) ? { id: str(f.work.id)!, state: str(f.work.state) } : null;
      flags.push({
        key: `${member}/${f.id}`,
        member,
        id: String(f.id),
        param: String(f.param ?? ""),
        owner: String(f.owner ?? ""),
        work,
        implements: arr(f.implements)
          .filter(isRecord)
          .map((d) => ({ id: String(d.id ?? ""), state: str(d.state), confirmed: d.confirmed === true })),
        stale: f.stale === true,
        kind: String(f.kind ?? ""),
        path: String(f.path ?? ""),
        values,
      });
    }
  }
  return { flags, unreadable };
}

/** The entries of a `change-set show` document that move `param` of `member`'s build, with the value before and after. */
export function paramMoves(doc: WorkspaceDocument, param: string): { before: unknown; after: unknown; entries: { address: string; node: string | null }[] } | null {
  const cs = isRecord(doc.changeSet) ? doc.changeSet : null;
  if (!cs) return null;
  const path = `param:${param}`;
  let found: { before: unknown; after: unknown; entries: { address: string; node: string | null }[] } | null = null;
  for (const e of arr(cs.entries)) {
    if (!isRecord(e)) continue;
    const a = arr(e.attributes).find((x) => isRecord(x) && x.path === path) as Record<string, unknown> | undefined;
    if (!a) continue;
    found ??= { before: a.before, after: a.after, entries: [] };
    found.entries.push({ address: String(e.address ?? ""), node: str(e.node) });
  }
  return found;
}

export interface FlagsInput {
  /** The first status read: the flags, and the promotion order. */
  status: WorkspaceDocument;
  /** The environment it was read for, which stands alone when no member declares a promotion order. */
  env: string;
  /** Per environment, its waiting gates, or the refusal its status read gave. */
  gates: { env: string; gates: Omit<WorkspaceGate, "dir">[] | WorkspaceRefusal }[];
  /** Per gate key and environment, the `change-set show` document of its change set, or the refusal. */
  shown: Map<string, WorkspaceDocument | WorkspaceRefusal>;
  at: Date;
}

const isRefusal = (v: unknown): v is WorkspaceRefusal => isRecord(v) && typeof v.error === "string" && typeof v.code === "string" && typeof v.remedy === "string";

/** The key {@link FlagsInput.shown} is kept by. */
export const shownKey = (env: string, gate: string): string => `${env}\u0000${gate}`;

/** The answer from the documents read. Pure. Null when status carries no `featureFlags` at all. */
export function flagsFrom(input: FlagsInput): FeatureFlags | null {
  const listed = flagsFromStatus(input.status);
  if (!listed) return null;
  const declared = promotionOrder(input.status).map((s) => s.env);
  const environments = declared.length ? [...declared] : [input.env];
  for (const f of listed.flags) for (const env of Object.keys(f.values)) if (!environments.includes(env)) environments.push(env);

  const refusals: FeatureFlags["refusals"] = [];
  for (const g of input.gates) if (isRefusal(g.gates)) refusals.push({ env: g.env, error: g.gates.error, remedy: g.gates.remedy });
  for (const [k, doc] of input.shown) {
    if (!isRefusal(doc)) continue;
    const [env, gate] = k.split("\u0000");
    refusals.push({ env, gate, error: doc.error, remedy: doc.remedy });
  }

  const flags: FlagView[] = listed.flags.map((f) => {
    const waiting: FlagWaiting[] = [];
    for (const g of input.gates) {
      if (isRefusal(g.gates)) continue;
      for (const gate of g.gates) {
        if (gate.member !== f.member || !gate.changeSet) continue;
        const doc = input.shown.get(shownKey(g.env, gate.key));
        if (!doc || isRefusal(doc)) continue;
        const moves = paramMoves(doc, f.param);
        if (!moves) continue;
        waiting.push({ env: g.env, gate: gate.key, changeSet: gate.changeSet, releaseDigest: gate.releaseDigest ?? null, gitSha: gate.gitSha ?? null, ...moves });
      }
    }
    const envs: FlagView["envs"] = {};
    const turnOn: FlagTurnOn[] = [];
    for (const env of environments) {
      const value = f.values[env];
      const state = flagState(value);
      envs[env] = { value: value ?? null, state };
      const boolean = typeof value === "boolean" || value === undefined;
      if (state !== "on" && boolean && !waiting.some((w) => w.env === env && w.after === true)) turnOn.push({ env, lines: turnOnLines(f, env) });
    }
    return { ...f, envs, waiting, turnOn };
  });
  return { environments, order: declared.length ? "promotion" : "env", flags, nodes: "member", unreadable: listed.unreadable, refusals, read: { at: input.at.toISOString() } };
}

async function attempt(read: () => Promise<WorkspaceDocument>): Promise<WorkspaceDocument | WorkspaceRefusal> {
  try {
    return await read();
  } catch (e) {
    if (e instanceof WorkspaceReadError) return e.refusal;
    throw e;
  }
}

/**
 * Read the flags of a served workspace: status for `env` first (the flags and
 * the promotion order), then status in every other environment of the order,
 * and the change set of each waiting gate of a member with flags. The caller
 * has checked {@link flagsFloorRefusal}.
 */
export async function readFeatureFlags(ws: Workspace, opts: { env: string; reader?: WorkspaceReader; now?: () => Date }): Promise<FlagsRead> {
  const reader = opts.reader ?? rootReader(ws.root);
  const first = await attempt(() => reader.read("status", [opts.env]));
  if (isRefusal(first)) return { ok: false, refusal: first };
  const listed = flagsFromStatus(first);
  if (!listed) {
    return {
      ok: false,
      refusal: {
        error: "chant's workspace status lists no feature flags (featureFlags) for any member.",
        code: "no-feature-flags",
        remedy: `Feature flags need chant ${floorFor("feature flags").floor} or newer in the project.`,
      },
    };
  }
  const flagged = new Set(listed.flags.map((f) => f.member));
  const declared = promotionOrder(first).map((s) => s.env);
  const envs = declared.length ? declared : [opts.env];

  const gates: FlagsInput["gates"] = await Promise.all(
    envs.map(async (env) => {
      const status = env === opts.env ? first : await attempt(() => reader.read("status", [env]));
      if (isRefusal(status)) return { env, gates: status };
      const read = gatesFromStatus(status, ws.root);
      if (!read.ok) return { env, gates: read.refusal };
      return { env, gates: read.gates.map(({ dir: _dir, ...g }) => g) };
    }),
  );
  const shown = new Map<string, WorkspaceDocument | WorkspaceRefusal>();
  await Promise.all(
    gates.flatMap((g) =>
      isRefusal(g.gates)
        ? []
        : g.gates
            .filter((gate) => gate.changeSet && flagged.has(gate.member))
            .map(async (gate) => {
              const doc = await attempt(() => reader.readChangeSet(gate.changeSet!, gate.member));
              shown.set(shownKey(g.env, gate.key), isRefusal(doc) ? doc : (showRefusal(doc, gate.changeSet!, gate.member) ?? doc));
            }),
    ),
  );
  return { ok: true, flags: flagsFrom({ status: first, env: opts.env, gates, shown, at: (opts.now ?? (() => new Date()))() })! };
}
