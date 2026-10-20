/**
 * #472: a declared workspace's open decision points, from `chant workspace
 * points --open --json` (points.schema.json, ws-058) under read contract 1.
 *
 * The approvals inbox is the host's rail (arugula-salad/arugula#621), so
 * behold draws the questions and answers none. Each open question is drawn
 * beside the gate that waits on it: since chant 0.107.0 (chant#3170) a gate
 * can ask a declared point, and `workspace status` names the question as the
 * gate's `answer` (src/workspace-gates.ts). The page joins the two by the
 * question's id, which both documents carry; a question no waiting gate names
 * is drawn on its own in the gate strip. A question asked by a gate says so in
 * its subject (`gate:<op>/<gate>@<env>`), which is kept as `gate` so a card can
 * name the gate when it waits in another environment.
 *
 * What a card says is chant's: the point's question, who may answer (the
 * quorum's count and roles), a model's proposal waiting to be confirmed, and
 * the `points answer` line to run at a shell. There is no write route.
 */
import { floorFor, floorMet, floorRefusal } from "./chant-floors.ts";
import type { Workspace } from "./workspace.ts";
import { rootReader, WorkspaceReadError, type WorkspaceDocument, type WorkspaceReader, type WorkspaceRefusal } from "./workspace-reader.ts";

export const POINTS_READ_NAME = "decision points";

/** One open question, as a card draws it. */
export interface OpenPoint {
  /** The answer record's id: what `points answer` takes, and what a gate's `answer.id` names. */
  id: string;
  point: string;
  /** The point's title. */
  title: string;
  /** The question's text: an ad-hoc point's as asked, else the point's instructions. */
  question: string;
  questionType: string;
  candidates: (string | boolean)[];
  /** What the question is about, the record's first `constrains` entry, or null. */
  subject: string | null;
  /** The gate that asked it, read from a `gate:<op>/<gate>[@<env>]` subject, or null. */
  gate: { op: string; gate: string; env: string | null } | null;
  /** `escalated` (open for people) or `proposed` (a model's answer waiting for a person to confirm it). */
  state: string;
  /** Who may answer: how many people, and the roles they hold when the quorum names any. */
  quorum: { count: number; roles: string[] };
  /** A model's answer, for a proposal or an escalation below the threshold, or null. */
  model: { answer: string | boolean | null; confidence: number | null; threshold: number | null; model: string | null } | null;
  askedOn: string | null;
  /** The steward whose turn asked it, or null. */
  askedBy: string | null;
  /** The point's declaration changed since the question was asked (chant's `current: false`). */
  stale: boolean;
  /** The answer record, from the repository root. */
  path: string;
  /** The line a person runs at the workspace root to answer it. */
  command: string;
}

export interface OpenPoints {
  points: OpenPoint[];
  /** Answer kinds chant could not read, with its reason: their questions are missing from `points`. */
  unread: { kind: string; code: string; message: string }[];
  read: { at: string };
}

export type PointsRead = { ok: true; points: OpenPoints } | { ok: false; refusal: WorkspaceRefusal };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const answerValue = (v: unknown): string | boolean | null => (typeof v === "string" || typeof v === "boolean" ? v : null);

/** The refusal when the project's chant is older than the points read's floor, else undefined. */
export function pointsFloorRefusal(version: string | undefined): WorkspaceRefusal | undefined {
  const f = floorFor(POINTS_READ_NAME);
  return floorMet(f, version) ? undefined : floorRefusal(f, version);
}

/** The gate a question's subject names: `gate:<op>/<gate>`, with `@<env>` when the run named one (chant#3170). */
export function gateOfSubject(subject: string | null): OpenPoint["gate"] {
  const m = subject ? /^gate:([^/@\s]+)\/([^@\s]+)(?:@(\S+))?$/.exec(subject) : null;
  return m ? { op: m[1], gate: m[2], env: m[3] ?? null } : null;
}

/** chant's own line for answering a question, as `workspace status` prints it on a gate. */
export function answerCommand(id: string): string {
  return `chant workspace points answer ${id} --answer <value> --by <name>`;
}

/** The open questions in a points document. Pure. */
export function openPointsFrom(doc: WorkspaceDocument, at: Date = new Date()): PointsRead {
  if (isRecord(doc.error)) {
    const code = String(doc.error.code ?? "unknown");
    return { ok: false, refusal: { error: `chant could not read the workspace's decision points: ${code}: ${String(doc.error.message ?? "")}`, code, remedy: "`chant workspace check` names the problem and where it is." } };
  }
  const declared = new Map<string, Record<string, unknown>>();
  for (const p of arr(doc.points)) if (isRecord(p) && typeof p.name === "string") declared.set(p.name, p);
  const points: OpenPoint[] = [];
  for (const q of arr(doc.questions)) {
    if (!isRecord(q) || q.open !== true) continue;
    const id = str(q.id);
    const name = str(q.point);
    if (!id || !name) continue;
    const p = declared.get(name);
    const asked = isRecord(q.asked) ? q.asked : null;
    const quorum = p && isRecord(p.quorum) ? p.quorum : isRecord(q.decider) && q.decider.kind === "quorum" ? q.decider : null;
    const m = isRecord(q.model) ? q.model : null;
    const subject = str(q.subject);
    const by = isRecord(q.askedBy) ? str(q.askedBy.steward) : null;
    points.push({
      id,
      point: name,
      title: str(p?.title) ?? str(q.title) ?? name,
      question: str(asked?.question) ?? str(p?.instructions) ?? str(q.title) ?? name,
      questionType: str(q.questionType) ?? str(p?.questionType) ?? "",
      candidates: arr(q.candidates).filter((c): c is string | boolean => typeof c === "string" || typeof c === "boolean"),
      subject,
      gate: gateOfSubject(subject),
      state: str(q.state) ?? "escalated",
      quorum: { count: num(quorum?.count) ?? 1, roles: arr(quorum?.roles).filter((r): r is string => typeof r === "string") },
      model: m ? { answer: answerValue(m.answer), confidence: num(m.confidence), threshold: num(m.threshold), model: str(m.model) } : null,
      askedOn: str(q.askedOn),
      askedBy: by,
      stale: q.current === false,
      path: str(q.path) ?? "",
      command: answerCommand(id),
    });
  }
  points.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const unread = arr(doc.sources)
    .filter(isRecord)
    .filter((s) => isRecord(s.reason))
    .map((s) => ({ kind: String(s.kind ?? ""), code: String((s.reason as Record<string, unknown>).code ?? ""), message: String((s.reason as Record<string, unknown>).message ?? "") }));
  return { ok: true, points: { points, unread, read: { at: at.toISOString() } } };
}

/** Ask the workspace's chant for its open decision points, through the reader (#468). */
export async function readOpenPoints(ws: Workspace, opts: { reader?: WorkspaceReader; now?: () => Date } = {}): Promise<PointsRead> {
  const reader = opts.reader ?? rootReader(ws.root);
  try {
    return openPointsFrom(await reader.readPoints(), (opts.now ?? (() => new Date()))());
  } catch (e) {
    if (e instanceof WorkspaceReadError) return { ok: false, refusal: e.refusal };
    throw e;
  }
}
