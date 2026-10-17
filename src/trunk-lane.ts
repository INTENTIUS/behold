/**
 * #680: the trunk lane. Per environment, in the promotion order chant
 * declares: which trunk commits are green, revoked or undecided, which wait
 * at a gate, and which release each environment runs now.
 *
 * Every fact comes from chant through the read contract (src/workspace-reader.ts):
 *
 *  - `chant ci list --json` (INTENTIUS/chant#4021): the trunk branch's
 *    first-parent commits within ci.green's window, newest first, each with its
 *    state, its required phases and their runs, and its work items (chant#4029).
 *    It reads local tags and never asks the forge, so a commit that failed
 *    without ever being green reads `undecided`.
 *  - `chant workspace status <env> --json`, once per environment: each
 *    member's `promotionOrder` (chant#4030), its gates with the commit and run
 *    that reached them and the change set they bind (chant#4020, chant#4022),
 *    and its deploy records.
 *  - `chant release list --json` in each member that declares environments
 *    (chant#4026): the releases, the commit each was cut from, and the
 *    environments that run it.
 *
 * behold keeps no state of its own here: the lane is those documents, joined
 * on the commit sha and the environment name, which is all the join there is.
 * Approving a waiting gate goes through the existing route
 * (`POST /api/workspace/gates/approve`), as the gate strip's button does.
 */
import { floorFor, floorMet, floorRefusal } from "./chant-floors.ts";
import type { Workspace } from "./workspace.ts";
import { gatesFromStatus, withOverrides, type WorkspaceGate } from "./workspace-gates.ts";
import { rootReader, WorkspaceReadError, type WorkspaceDocument, type WorkspaceReader, type WorkspaceRefusal } from "./workspace-reader.ts";

/** The reads the lane makes, by their names in src/chant-floors.ts. */
export const LANE_READS = ["trunk commits", "release list", "promotion order"] as const;

export type CommitState = "green" | "revoked" | "undecided";

export interface LaneRun {
  name: string;
  /** Only an http(s) address; anything else is dropped rather than put behind a link. */
  url: string | null;
  conclusion: string | null;
}

export interface LanePhase {
  phase: string;
  result: "pass" | "fail" | "pending" | "unrecorded";
  runs: LaneRun[];
}

/** The commit's work items as chant#4029 defines the link. */
export interface LaneWork {
  state: "linked" | "unlinked" | "wrong" | "merge";
  ids: string[];
  problems: { trailer: string; message: string }[];
}

/** Where a commit is: an environment runs it, or a gate in it waits on it. */
export interface CommitPlace {
  env: string;
  what: "runs" | "waits";
  /** For `waits`: the gate's key, member/op/gate. */
  gate?: string;
}

export interface LaneCommit {
  sha: string;
  committed: string;
  state: CommitState;
  phases: LanePhase[];
  /** The phase and run a revoked tag names. */
  revoked: { phase: string | null; run: LaneRun | null } | null;
  /** Null when chant said nothing about work: an older chant, or a workspace that declares no work kind. */
  work: LaneWork | null;
  /** ci tags that do not count, for want of a runner's signature (chant#4031). */
  ignored: { tag: string; status: string; reason: string }[];
  where: CommitPlace[];
}

/** A release an environment runs, from `release list`. */
export interface LaneRelease {
  member: string;
  label: string | null;
  releaseDigest: string;
  /** The commit it was cut from. */
  commit: string;
  /** Whether that commit is in the trunk list. */
  listed: boolean;
  /** The components whose latest deploy record in this environment names it. */
  components: string[];
  cutBy: string | null;
  cutAt: string | null;
  /** Who approved its deploy, from the deploy record of one of its components, when one names somebody. */
  approver: string | null;
}

/** A deploy record no release covers, from `workspace status <env>`. */
export interface LaneDeploy {
  member: string;
  component: string;
  digest: string;
  gitSha: string;
  listed: boolean;
  timestamp: string;
  actor: string;
  approver: string | null;
  runId: string;
}

export type LaneGate = Omit<WorkspaceGate, "dir"> & {
  /** The state of the commit the gate waits on, or null when the commit is not in the trunk list or chant recorded none. */
  commitState: CommitState | null;
};

export interface LaneEnvironment {
  env: string;
  canary: boolean;
  /** The members whose promotion order names this environment. */
  members: string[];
  releases: LaneRelease[];
  deploys: LaneDeploy[];
  waiting: LaneGate[];
  /** Set when this environment's status could not be read. */
  refusal?: WorkspaceRefusal;
}

export interface TrunkLane {
  /** ci.green's branch and window, or null when `ci list` refused. */
  trunk: { branch: string; ref: string; window: string | null; since: string | null; require: string[] } | null;
  trunkRefusal?: WorkspaceRefusal;
  commits: LaneCommit[];
  environments: LaneEnvironment[];
  /** `promotion`: from the members' promotion order. `env`: no member declares one, so the one environment behold serves. */
  order: "promotion" | "env";
  /** Members whose `release list` could not be read. */
  releaseRefusals: { member: string; refusal: WorkspaceRefusal }[];
  read: { at: string };
}

export type LaneRead = { ok: true; lane: TrunkLane } | { ok: false; refusal: WorkspaceRefusal };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const webUrl = (v: unknown): string | null => (typeof v === "string" && /^https?:\/\//.test(v) ? v : null);

/** The first floor of the lane's reads the project's chant does not meet, as the pane's refusal; undefined when it meets them all. */
export function laneFloorRefusal(version: string | undefined): WorkspaceRefusal | undefined {
  for (const read of LANE_READS) {
    const f = floorFor(read);
    if (!floorMet(f, version)) return floorRefusal(f, version);
  }
  return undefined;
}

/** A refusal for a document chant wrote as a failure (`{error: {code, message}}`). */
function errorRefusal(doc: WorkspaceDocument, shown: string): WorkspaceRefusal | undefined {
  if (!isRecord(doc.error)) return undefined;
  const code = String(doc.error.code ?? "unknown");
  const remedy =
    code === "ci-green-undeclared"
      ? "Declare ci.green in chant.workspace.json; chant ci tick then tags the trunk's commits green or revoked."
      : `Run \`${shown}\` to see what chant says.`;
  return { error: `${shown}: ${String(doc.error.message ?? code)}`, code, remedy };
}

const run = (r: unknown): LaneRun | null =>
  isRecord(r) && typeof r.name === "string" ? { name: r.name, url: webUrl(r.url), conclusion: str(r.conclusion) } : null;

/** The commits of a `ci list` document, with no places yet. */
export function commitsFromCiList(doc: WorkspaceDocument): LaneCommit[] {
  const out: LaneCommit[] = [];
  for (const c of arr(doc.commits)) {
    if (!isRecord(c) || typeof c.sha !== "string") continue;
    const state: CommitState = c.state === "green" || c.state === "revoked" ? c.state : "undecided";
    const phases = arr(c.phases)
      .filter(isRecord)
      .map((p) => ({
        phase: String(p.phase ?? ""),
        result: (["pass", "fail", "pending"].includes(String(p.result)) ? p.result : "unrecorded") as LanePhase["result"],
        runs: arr(p.runs).map(run).filter((r): r is LaneRun => r !== null),
      }));
    const rv = isRecord(c.revoked) ? { phase: str(c.revoked.phase), run: run(c.revoked.run) } : null;
    const w = isRecord(c.work) && ["linked", "unlinked", "wrong", "merge"].includes(String(c.work.state)) ? c.work : null;
    const work: LaneWork | null = w
      ? {
          state: w.state as LaneWork["state"],
          ids: arr(w.ids).filter((x): x is string => typeof x === "string"),
          problems: arr(w.problems)
            .filter(isRecord)
            .map((p) => ({ trailer: String(p.trailer ?? ""), message: String(p.message ?? "") })),
        }
      : null;
    const ignored = arr(c.ignored)
      .filter(isRecord)
      .map((t) => ({ tag: String(t.tag ?? ""), status: String(t.status ?? ""), reason: String(t.reason ?? "") }));
    out.push({ sha: c.sha, committed: String(c.committed ?? ""), state, phases, revoked: rv, work, ignored, where: [] });
  }
  return out;
}

/**
 * The environments in promotion order: each member's `promotionOrder`, merged
 * in member order, an environment taking its first position. Empty when no
 * member declares one.
 */
export function promotionOrder(status: WorkspaceDocument): { env: string; canary: boolean; members: string[] }[] {
  const out: { env: string; canary: boolean; members: string[] }[] = [];
  for (const m of arr(status.members)) {
    if (!isRecord(m) || typeof m.name !== "string") continue;
    for (const step of arr(m.promotionOrder)) {
      if (!isRecord(step) || typeof step.name !== "string") continue;
      let at = out.find((e) => e.env === step.name);
      if (!at) out.push((at = { env: step.name, canary: false, members: [] }));
      if (step.canary === true) at.canary = true;
      if (!at.members.includes(m.name)) at.members.push(m.name);
    }
  }
  return out;
}

/** The members that declare environments, with their directories: the ones `release list` is asked about. */
export function releaseMembers(status: WorkspaceDocument): { name: string; dir: string }[] {
  return arr(status.members)
    .filter(isRecord)
    .filter((m) => typeof m.name === "string" && arr(m.promotionOrder).length > 0)
    .map((m) => ({ name: m.name as string, dir: typeof m.dir === "string" ? m.dir : "." }));
}

/** One environment's deploy records in a status document, per member. */
function deployRecords(status: WorkspaceDocument, env: string): Omit<LaneDeploy, "listed">[] {
  const out: Omit<LaneDeploy, "listed">[] = [];
  for (const m of arr(status.members)) {
    if (!isRecord(m) || typeof m.name !== "string") continue;
    for (const e of arr(m.environments)) {
      if (!isRecord(e) || e.env !== env) continue;
      for (const r of arr(e.releases)) {
        if (!isRecord(r) || typeof r.component !== "string") continue;
        out.push({
          member: m.name,
          component: r.component,
          digest: String(r.digest ?? ""),
          gitSha: String(r.gitSha ?? ""),
          timestamp: String(r.timestamp ?? ""),
          actor: String(r.actor ?? ""),
          approver: str(r.approver),
          runId: String(r.runId ?? ""),
        });
      }
    }
  }
  return out;
}

/** One environment's releases in one member's `release list` document. */
function releasesIn(doc: WorkspaceDocument, member: string, env: string): Omit<LaneRelease, "listed" | "approver">[] {
  const out: Omit<LaneRelease, "listed" | "approver">[] = [];
  for (const r of arr(doc.releases)) {
    if (!isRecord(r) || typeof r.releaseDigest !== "string" || typeof r.commit !== "string") continue;
    const here = arr(r.environments).find((e) => isRecord(e) && e.env === env);
    if (!isRecord(here)) continue;
    const cuts = arr(r.cuts).filter(isRecord);
    const last = cuts.at(-1);
    out.push({
      member,
      label: str(r.label),
      releaseDigest: r.releaseDigest,
      commit: r.commit,
      components: arr(here.components).filter((c): c is string => typeof c === "string"),
      cutBy: last ? str(last.actor) : null,
      cutAt: last ? str(last.timestamp) : null,
    });
  }
  return out;
}

/** What the lane is joined from: chant's documents, or the refusal a read came back with. */
export interface LaneInput {
  ci: WorkspaceDocument | WorkspaceRefusal;
  /** Status per environment, in promotion order. */
  statuses: { env: string; canary: boolean; members: string[]; status: WorkspaceDocument | WorkspaceRefusal; gates: WorkspaceGate[] }[];
  releaseLists: { member: string; doc: WorkspaceDocument | WorkspaceRefusal }[];
  order: TrunkLane["order"];
  at: Date;
}

const isRefusal = (v: WorkspaceDocument | WorkspaceRefusal): v is WorkspaceRefusal => typeof v.error === "string" && typeof v.code === "string";

/** Join the documents into the lane. Pure. */
export function laneFrom(input: LaneInput): TrunkLane {
  let trunk: TrunkLane["trunk"] = null;
  let trunkRefusal: WorkspaceRefusal | undefined;
  let commits: LaneCommit[] = [];
  if (isRefusal(input.ci)) trunkRefusal = input.ci;
  else {
    const failed = errorRefusal(input.ci, "chant ci list");
    if (failed) trunkRefusal = failed;
    else {
      trunk = {
        branch: String(input.ci.branch ?? ""),
        ref: String(input.ci.ref ?? ""),
        window: str(input.ci.window),
        since: str(input.ci.since),
        require: arr(input.ci.require).filter((x): x is string => typeof x === "string"),
      };
      commits = commitsFromCiList(input.ci);
    }
  }
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const releaseRefusals: TrunkLane["releaseRefusals"] = [];
  const releaseDocs: { member: string; doc: WorkspaceDocument }[] = [];
  for (const r of input.releaseLists) {
    const refused = isRefusal(r.doc) ? r.doc : errorRefusal(r.doc, `chant release list (in ${r.member})`);
    if (refused) releaseRefusals.push({ member: r.member, refusal: refused });
    else releaseDocs.push({ member: r.member, doc: r.doc as WorkspaceDocument });
  }

  const place = (sha: string, p: CommitPlace) => {
    const c = bySha.get(sha);
    if (c && !c.where.some((w) => w.env === p.env && w.what === p.what && w.gate === p.gate)) c.where.push(p);
  };

  const environments: LaneEnvironment[] = input.statuses.map((s) => {
    const base = { env: s.env, canary: s.canary, members: s.members };
    if (isRefusal(s.status)) return { ...base, releases: [], deploys: [], waiting: [], refusal: s.status };
    const records = deployRecords(s.status, s.env);
    const releases: LaneRelease[] = releaseDocs.flatMap(({ member, doc }) =>
      releasesIn(doc, member, s.env).map((r) => ({
        ...r,
        listed: bySha.has(r.commit),
        approver: records.find((d) => d.member === member && r.components.includes(d.component) && d.approver)?.approver ?? null,
      })),
    );
    const covered = (d: Omit<LaneDeploy, "listed">) => releases.some((r) => r.member === d.member && r.components.includes(d.component));
    const deploys: LaneDeploy[] = records.filter((d) => !covered(d)).map((d) => ({ ...d, listed: bySha.has(d.gitSha) }));
    // A gate that records no environment (an Op gate) is listed in every
    // environment's status; it is not a step of the promotion, so the lane
    // leaves it to the gate strip.
    const waiting: LaneGate[] = s.gates
      .filter((g) => g.env === s.env)
      .map(({ dir: _dir, ...g }) => ({ ...g, commitState: g.gitSha ? (bySha.get(g.gitSha)?.state ?? null) : null }));
    for (const r of releases) place(r.commit, { env: s.env, what: "runs" });
    for (const d of deploys) place(d.gitSha, { env: s.env, what: "runs" });
    for (const g of waiting) if (g.gitSha && g.state === "pending") place(g.gitSha, { env: s.env, what: "waits", gate: g.key });
    return { ...base, releases, deploys, waiting };
  });

  return {
    trunk,
    ...(trunkRefusal ? { trunkRefusal } : {}),
    commits,
    environments,
    order: input.order,
    releaseRefusals,
    read: { at: input.at.toISOString() },
  };
}

/** Run one read, turning chant's refusal into a value. */
async function attempt(read: () => Promise<WorkspaceDocument>): Promise<WorkspaceDocument | WorkspaceRefusal> {
  try {
    return await read();
  } catch (e) {
    if (e instanceof WorkspaceReadError) return e.refusal;
    throw e;
  }
}

/**
 * Read the lane for a served workspace. `env` is the environment status is
 * first asked about, which also stands alone when no member declares a
 * promotion order. The caller has checked {@link laneFloorRefusal}.
 */
export async function readTrunkLane(ws: Workspace, opts: { env: string; reader?: WorkspaceReader; now?: () => Date }): Promise<LaneRead> {
  const reader = opts.reader ?? rootReader(ws.root);
  const first = await attempt(() => reader.read("status", [opts.env]));
  if (isRefusal(first)) return { ok: false, refusal: first };
  const firstGates = gatesFromStatus(first, ws.root);
  if (!firstGates.ok) return { ok: false, refusal: firstGates.refusal };

  const declared = promotionOrder(first);
  const order: TrunkLane["order"] = declared.length ? "promotion" : "env";
  const steps = declared.length ? declared : [{ env: opts.env, canary: false, members: [] as string[] }];
  const members = releaseMembers(first);

  const statusOf = async (env: string): Promise<{ status: WorkspaceDocument | WorkspaceRefusal; gates: WorkspaceGate[] }> => {
    const status = env === opts.env ? first : await attempt(() => reader.read("status", [env]));
    if (isRefusal(status)) return { status, gates: [] };
    const read = gatesFromStatus(status, ws.root);
    if (!read.ok) return { status: read.refusal, gates: [] };
    return { status, gates: await withOverrides(read.gates) };
  };

  const [ci, statuses, releaseLists] = await Promise.all([
    attempt(() => reader.readTrunk("ci list", [])),
    Promise.all(steps.map(async (s) => ({ ...s, ...(await statusOf(s.env)) }))),
    Promise.all(members.map(async (m) => ({ member: m.name, doc: await attempt(() => reader.readTrunk("release list", [], m.dir)) }))),
  ]);
  return { ok: true, lane: laneFrom({ ci, statuses, releaseLists, order, at: (opts.now ?? (() => new Date()))() }) };
}
