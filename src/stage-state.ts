/**
 * #1236: each pipeline stage's state, for the Stages tab. Per member with a
 * `.chant/pipeline.ts`, in pipeline order: the release the stage runs, its
 * gate, the change risk the gate reads and why, its soak and the time left,
 * the canary soaks that hold it, a pause, a rollback request or a held
 * rollback, a hold or freeze window, and the releases queued for it.
 *
 * Every fact is chant's, from `chant workspace status <env> --json` through
 * the read contract (src/workspace-reader.ts):
 *
 *  - `members[].pipeline` (INTENTIUS/chant#5342): every stage, whatever env
 *    was asked for. behold keeps each stage's fields as chant wrote them.
 *  - `members[].promotionOrder[].held` (chant#5354): a stage's hold or
 *    freeze window, joined on the stage name.
 *  - `members[].stageQueues[]` (chant#5353, chant#5419): the release in a
 *    stage and the ones waiting for it, joined on the pipeline and stage
 *    name. status lists every stage of a member's own pipeline, whatever env
 *    was asked for, so one read answers every stage.
 *
 * The kind of member does not matter: a terraform, pulumi or sql member with
 * a pipeline reads the same way as any other. behold computes no state here;
 * `leftMs` is the time left at chant's read, and the page says so.
 */
import { floorFor, floorMet, floorRefusal } from "./chant-floors.ts";
import type { Workspace } from "./workspace.ts";
import { contractRefusal, rootReader, WorkspaceReadError, type WorkspaceDocument, type WorkspaceReader, type WorkspaceRefusal } from "./workspace-reader.ts";

/** The read this module makes, by its name in src/chant-floors.ts. */
export const STAGE_STATE_READ = "stage state";

export type SoakState = "unread" | "soaking" | "due" | "failing" | "clock-unknown" | "ended";

export interface StageRef {
  digest: string;
  label: string | null;
}

export interface StageRelease {
  releaseDigest: string | null;
  label: string | null;
  gitSha: string;
  at: string;
  components: string[];
  mixed: boolean;
}

export interface StageGate {
  name: string;
  policy: "always" | "never" | "on-destructive";
  state: "pending" | "approved" | "expired" | "superseded" | null;
  releaseDigest: string | null;
  label: string | null;
  planDigest: string | null;
  recordedAt: string | null;
  approvals: number;
  needed: number;
  approve: string | null;
}

export interface StageRisk {
  releaseDigest: string;
  label: string | null;
  score: number;
  level: "low" | "medium" | "high";
  reads: boolean;
  approveAbove: number | null;
  over: boolean;
  overBy: string[];
}

export interface StageSoak {
  gate: string;
  duration: string;
  checks: number;
  state: SoakState;
  releaseDigest: string | null;
  to: string | null;
  clockStart: string | null;
  due: string | null;
  leftMs: number | null;
  holds: string[];
  failing: string[];
  recordedAt: string | null;
  endedBy: string | null;
}

export interface CanaryHold {
  stage: string;
  state: SoakState;
  due: string | null;
  leftMs: number | null;
  holding: boolean;
}

export interface StagePause {
  by: string;
  at: string;
  reason: string | null;
  cause: "rollback" | null;
  waiting: StageRef[];
}

export interface StageRollback {
  id: string;
  requestedAt: string;
  by: string;
  failure: "verify" | "soak" | null;
  failed: StageRef | null;
  to: StageRef;
  members: { member: string; state: string; rollback?: string }[];
  gate: string;
  state: "pending" | "approved" | "expired" | "superseded" | null;
  approve: string;
  command: string;
}

export interface StageRollbackHeld {
  failureId: string;
  at: string;
  reason: string;
  failure: "verify" | "soak" | null;
  failed: StageRef | null;
}

/** A stage's hold or freeze window, from `promotionOrder[].held` (chant#5354). */
export interface StageHeld {
  kind: "hold" | "freeze";
  until: string | null;
  reason?: string;
  description?: string;
}

export interface QueuedRelease {
  digest: string;
  label: string | null;
  at: string;
}

/** A stage's queue, from `stageQueues[]` (chant#5353). */
export interface StageQueue {
  inStage: QueuedRelease | null;
  waiting: QueuedRelease[];
  replaced: (QueuedRelease & { by: string; byLabel: string | null })[];
}

/** One stage: chant's stage entry, with the hold and queue joined on its name. */
export interface StageView {
  name: string;
  canary: boolean;
  after: string[];
  release: StageRelease | null;
  gate: StageGate | null;
  risk: StageRisk | null;
  soak: StageSoak | null;
  canaryHolds: CanaryHold[];
  paused: StagePause | null;
  onVerifyFail: "hold" | "rollback" | null;
  rollback: StageRollback | null;
  rollbackHeld: StageRollbackHeld | null;
  /** Null when the stage is open. */
  held: StageHeld | null;
  /** Null when status gave no queue for the stage: its pipeline keeps no stage log, or the log names nothing for it. */
  queue: StageQueue | null;
}

export interface MemberStages {
  member: string;
  kind: string | null;
  pipeline: string;
  stages: StageView[];
}

export interface StageState {
  /** The env the status read asked for. */
  env: string;
  /** When behold asked chant, which is when chant counted `leftMs` from. Null for a document read from elsewhere. */
  readAt: string | null;
  members: MemberStages[];
  /** Members status gave no pipeline for: none declared, or it does not fold. */
  others: { member: string; kind: string | null }[];
}

export type StageStateRead = { ok: true; state: StageState } | { ok: false; refusal: WorkspaceRefusal };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");
/** A chant object as chant wrote it, or null: behold reshapes nothing. */
const rec = <T>(v: unknown): T | null => (isRecord(v) ? (v as T) : null);

/** The refusal for a chant below the stage-state floor, or undefined. An unknown version meets it. */
export function stagesFloorRefusal(version: string | undefined): WorkspaceRefusal | undefined {
  const f = floorFor(STAGE_STATE_READ);
  return floorMet(f, version) ? undefined : floorRefusal(f, version);
}

/** A status document chant wrote as a failure, or with another contract. */
function statusRefusal(doc: WorkspaceDocument): WorkspaceRefusal | undefined {
  const contract = contractRefusal(doc, "status");
  if (contract) return contract;
  if (isRecord(doc.error)) {
    const code = String(doc.error.code ?? "unknown");
    return { error: `chant could not read the workspace's status: ${code}: ${String(doc.error.message ?? "")}`, code, remedy: "`chant workspace check` names the problem and where it is." };
  }
  return undefined;
}

/** `member/pipeline/stage` for a queue. */
const queueKey = (member: string, pipeline: string, stage: string) => `${member}\u0000${pipeline}\u0000${stage}`;

/** The queues a status document lists, keyed member, pipeline and stage. */
export function queuesOf(doc: WorkspaceDocument): Map<string, StageQueue> {
  const out = new Map<string, StageQueue>();
  for (const m of arr(doc.members)) {
    if (!isRecord(m) || typeof m.name !== "string") continue;
    for (const q of arr(m.stageQueues)) {
      if (!isRecord(q) || typeof q.pipeline !== "string" || typeof q.stage !== "string") continue;
      out.set(queueKey(m.name, q.pipeline, q.stage), {
        inStage: rec<QueuedRelease>(q.inStage),
        waiting: arr(q.waiting).filter(isRecord) as unknown as QueuedRelease[],
        replaced: arr(q.replaced).filter(isRecord) as unknown as StageQueue["replaced"],
      });
    }
  }
  return out;
}

/** The stages of a status document, each with its hold and queue. */
export function stagesFromStatus(doc: WorkspaceDocument, opts: { readAt?: string } = {}): StageStateRead {
  const refusal = statusRefusal(doc);
  if (refusal) return { ok: false, refusal };
  const queues = queuesOf(doc);
  const members: MemberStages[] = [];
  const others: StageState["others"] = [];
  for (const m of arr(doc.members)) {
    if (!isRecord(m) || typeof m.name !== "string") continue;
    const kind = str(m.kind);
    const p = m.pipeline;
    if (!isRecord(p) || typeof p.name !== "string") {
      others.push({ member: m.name, kind });
      continue;
    }
    const held = new Map<string, StageHeld>();
    for (const step of arr(m.promotionOrder)) if (isRecord(step) && typeof step.name === "string" && isRecord(step.held)) held.set(step.name, step.held as unknown as StageHeld);
    const stages: StageView[] = [];
    for (const s of arr(p.stages)) {
      if (!isRecord(s) || typeof s.name !== "string") continue;
      const key = queueKey(m.name, p.name, s.name);
      stages.push({
        name: s.name,
        canary: s.canary === true,
        after: strs(s.after),
        release: rec<StageRelease>(s.release),
        gate: rec<StageGate>(s.gate),
        risk: rec<StageRisk>(s.risk),
        soak: rec<StageSoak>(s.soak),
        canaryHolds: arr(s.canaryHolds).filter(isRecord) as unknown as CanaryHold[],
        paused: rec<StagePause>(s.paused),
        onVerifyFail: s.onVerifyFail === "hold" || s.onVerifyFail === "rollback" ? s.onVerifyFail : null,
        rollback: rec<StageRollback>(s.rollback),
        rollbackHeld: rec<StageRollbackHeld>(s.rollbackHeld),
        held: held.get(s.name) ?? null,
        queue: queues.get(key) ?? null,
      });
    }
    members.push({ member: m.name, kind, pipeline: p.name, stages });
  }
  return { ok: true, state: { env: String(doc.env ?? ""), readAt: opts.readAt ?? null, members, others } };
}

/**
 * Read the stages of a served workspace: one status read at `env`. The
 * caller has checked {@link stagesFloorRefusal}.
 */
export async function readStageState(ws: Workspace, opts: { env: string; reader?: WorkspaceReader; now?: () => Date }): Promise<StageStateRead> {
  const reader = opts.reader ?? rootReader(ws.root);
  const readAt = (opts.now ?? (() => new Date()))().toISOString();
  let doc: WorkspaceDocument;
  try {
    doc = await reader.read("status", [opts.env]);
  } catch (e) {
    if (e instanceof WorkspaceReadError) return { ok: false, refusal: e.refusal };
    throw e;
  }
  return stagesFromStatus(doc, { readAt });
}
