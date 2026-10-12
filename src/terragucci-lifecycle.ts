/**
 * The `chant/lifecycle` lane of a terragucci repo (#505): its apply gates and
 * its root locks, read without a write to the served checkout.
 *
 * terragucci keeps both on the repo's `chant/lifecycle` branch:
 *
 * - `_gates/tf-apply.jsonl`, the gate ledger: a wave's pending fact (the plan
 *   digest it waits on) and each approval, one JSON line each;
 * - `_gates/tf-apply/applied.jsonl`: the approvals a wave applied under, and
 *   how those applies finished;
 * - `_gates/tf-apply/wave-<k>/<digest>.json`: the report a waiting wave kept
 *   for the digest it asked approval for;
 * - `_locks/tf-apply.json`: the roots a pull request or an apply holds.
 *
 * Each wave is decided by chant's own rule (#520): the ledger is parsed with
 * chant's `parseGateLedger`, the applied lines with `parseAppliedGateLines`,
 * and the decision is `decideGateApproval` from `@intentius/chant/gate-decision`
 * with spent approvals left out, as terragucci decides it. Under `sealed` the
 * seals are checked against the signers at base, read with `gateSignersAt`.
 * Base is the tip of origin's default branch: the commit the next apply's
 * rule is read at. The op, its ledger path and the approval mode are a
 * `GateLaneSpec`, so another product's lane reads the same way
 * (`TERRAGUCCI_LANE` is terragucci's). Only the `finished` lines and the lock
 * file are terragucci's own formats, read here (terragucci
 * `packages/terragucci/src/apply.ts` parseFinished, `src/locks.ts` parseLocks).
 *
 * How it is read: the branch is fetched from the checkout's `origin` URL into
 * a bare repository behold owns, `<tmpdir>/behold-lifecycle-<hash of the
 * URL>`, with the person's own git and its credentials, together with the tip
 * of origin's default branch (depth 1) as base. The checkout is never fetched
 * into and no ref of it moves. When that fetch fails (offline, no access) the
 * checkout's own `refs/remotes/origin/chant/lifecycle` is read instead,
 * read-only, with its `origin/HEAD` (else HEAD) as base, and the answer says
 * so (`via: "checkout-ref"`). A remote with no such branch is an answer
 * (`found: false`), not an error.
 *
 * Nothing here approves, locks or unlocks: those are terragucci's, at a shell.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  appliedGatePath,
  decideGateApproval,
  gateSignersAt,
  identityGatesAt,
  parseAppliedGateLines,
  type AppliedGateRecord,
  type GateApprovalDecision,
  type GateApprovalSource,
  type GateResolutionRecord,
  type GateSigners,
  type PendingGateRecord,
} from "@intentius/chant/gate-decision";
import { parseGateLedger } from "@intentius/chant/lifecycle/gate-ledger";
import { samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { parseYAML } from "@intentius/chant/yaml";
import { assertScratch } from "./scratch.ts";
import { TERRAGUCCI_CONFIG_NAMES } from "./terragucci-repo.ts";

export const LIFECYCLE_BRANCH = "chant/lifecycle";
export const LEDGER_PATH = "_gates/tf-apply.jsonl";
export const APPLIED_PATH = "_gates/tf-apply/applied.jsonl";
/** Where a waiting wave keeps its report: `_gates/tf-apply/wave-<k>/<digest with ":" as "_">.json` (terragucci's approvedPath). */
export const WAVE_RECORDS_DIR = "_gates/tf-apply";
export const LOCKS_PATH = "_locks/tf-apply.json";
/** The checkout's own copy of the branch, read only when behold's fetch fails. */
export const CHECKOUT_REF = `refs/remotes/origin/${LIFECYCLE_BRANCH}`;
/** The ref behold keeps in its own cache. */
const CACHE_REF = `refs/heads/${LIFECYCLE_BRANCH}`;
/** The tip of origin's default branch in behold's cache: the base a gate's rule is read at. */
export const CACHE_BASE_REF = "refs/behold/base";
export const CACHE_PREFIX = "behold-lifecycle-";

export type { AppliedGateRecord, GateApprovalSource, GateResolutionRecord, PendingGateRecord };

// ── the product: which op, where its lines are, how its mode is read ─────

/** The rule a lane's gates are decided by, as read at base. */
export interface ApprovalRule {
  /** Which approvals count: `ledger`, `pr-review` or `sealed` (chant's GATE_APPROVAL_SOURCES). */
  mode: GateApprovalSource;
  /** Where the mode came from, in words. */
  source: string;
  /** The commit it was read at, when one could be read. */
  base?: string;
  /** Under `sealed`: the signers path at base, whether it exists, and any problem reading it. */
  signers?: { path: string; active: boolean; count: number; problems: string[] };
  /** Something the person should know, such as a base behold could not read. */
  note?: string;
}

/** What a product's lane is: its op, where its ledger lines are, its gate names, its approve line and its mode at base. */
export interface GateLaneSpec {
  /** The op whose gates the lane shows (`tf-apply`). */
  op: string;
  /** `_gates/<op>.jsonl` on chant/lifecycle. */
  ledgerPath: string;
  /** `_gates/<op>/applied.jsonl`: the approvals a wave applied under (chant's `appliedGatePath`). */
  appliedPath: string;
  /** The wave a gate name is, or undefined for a gate the lane does not show. */
  waveOf(gate: string): number | undefined;
  /** The line a person runs to approve a waiting gate. behold never runs it. */
  approveCommand(gate: string, digest: string | undefined, mode: GateApprovalSource): string;
  /** Whether a wave's applied approval is spent (chant#3784). */
  spend: boolean;
  /**
   * The mode at base. `show` reads a file at base (undefined when there is
   * none); `identityGates` is how many gates `chant.workspace.json` at base
   * lists under `identity.gates`.
   */
  approvalMode(show: (path: string) => Promise<string | undefined>, identityGates: number): Promise<Omit<ApprovalRule, "base" | "signers">>;
  /** The lock file, for a product that keeps one. */
  locksPath?: string;
  /** Where waiting waves keep their reports, `<dir>/wave-<k>/<digest>.json`, for a product that keeps them. */
  recordsDir?: string;
}

/** A lane spec for `op` with chant's paths: `_gates/<op>.jsonl` and `_gates/<op>/applied.jsonl`. */
export function gateLanePaths(op: string): Pick<GateLaneSpec, "op" | "ledgerPath" | "appliedPath"> {
  const a = appliedGatePath(op);
  return { op, ledgerPath: `_gates/${op}.jsonl`, appliedPath: `${a.dir}/${a.file}` };
}

const WAVE_GATE = /^wave-(\d+)$/;

/**
 * terragucci's mode at base (terragucci `src/approval.ts` effectiveApproval):
 * the `approval:` key of terragucci.yml at base; with none, any gate under
 * `identity.gates` in chant.workspace.json at base means sealed; then ledger.
 * A control repo's key (one with `projects:`) is not its projects'.
 */
export async function terragucciApprovalMode(show: (path: string) => Promise<string | undefined>, identityGates: number): Promise<Omit<ApprovalRule, "base" | "signers">> {
  let key: GateApprovalSource | undefined;
  let note: string | undefined;
  for (const name of TERRAGUCCI_CONFIG_NAMES) {
    const text = await show(name);
    if (text === undefined) continue;
    if (name.endsWith(".ts")) {
      note = `${name} at base is TypeScript, which behold does not run, so its approval key is not read`;
      break;
    }
    try {
      const doc = (name.endsWith(".json") ? JSON.parse(text) : parseYAML(text)) as { approval?: unknown; projects?: unknown } | null;
      const v = doc && !doc.projects ? doc.approval : undefined;
      if (v === "ledger" || v === "pr-review" || v === "sealed") key = v;
    } catch (e) {
      note = `${name} at base could not be parsed (${e instanceof Error ? e.message : String(e)}), so its approval key is not read`;
    }
    break;
  }
  if (key) return { mode: key, source: `approval: ${key} in the config at base`, ...(note ? { note } : {}) };
  if (identityGates > 0) return { mode: "sealed", source: "identity.gates in chant.workspace.json at base, with no approval key", ...(note ? { note } : {}) };
  return { mode: "ledger", source: "the default", ...(note ? { note } : {}) };
}

/** terragucci's lane: tf-apply's wave gates, its approve line, its lock file and its kept reports. */
export const TERRAGUCCI_LANE: GateLaneSpec = {
  ...gateLanePaths("tf-apply"),
  waveOf: (gate) => {
    const m = WAVE_GATE.exec(gate);
    return m ? Number(m[1]) : undefined;
  },
  approveCommand: (gate, digest, mode) => `npx terragucci approve ${gate}${digest ? ` --plan ${digest}` : ""}${mode === "sealed" ? " --sign" : ""}`,
  spend: true,
  approvalMode: terragucciApprovalMode,
  locksPath: LOCKS_PATH,
  recordsDir: WAVE_RECORDS_DIR,
};

// ── terragucci's own formats ─────────────────────────────────────────────

/** How the apply an applied line started ended, in the same file (terragucci's parseFinished). chant does not read these. */
export interface FinishedRecord {
  version: 1;
  kind: "finished";
  op: string;
  gate: string;
  planDigest: string;
  applied: string;
  result: "applied" | "failed";
  timestamp: string;
}

export interface GateLedger {
  pending: PendingGateRecord[];
  resolutions: GateResolutionRecord[];
  applied: AppliedGateRecord[];
  finished: FinishedRecord[];
}

const lines = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter(Boolean);
const json = (line: string): Record<string, unknown> | undefined => {
  try {
    const r = JSON.parse(line);
    return r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** The `finished` lines of an applied file. Malformed lines are skipped. */
export function parseFinished(text: string): FinishedRecord[] {
  const out: FinishedRecord[] = [];
  for (const line of lines(text)) {
    const r = json(line);
    if (r?.version === 1 && r.kind === "finished" && typeof r.gate === "string" && typeof r.planDigest === "string" && typeof r.applied === "string" && (r.result === "applied" || r.result === "failed"))
      out.push(r as unknown as FinishedRecord);
  }
  return out;
}

/** The ledger and the applied file, read with chant's parsers (and the finished lines with terragucci's). */
export function readGateLedgerText(ledgerText: string, appliedText: string): GateLedger {
  const { pending, resolutions } = parseGateLedger(ledgerText);
  return { pending, resolutions, applied: parseAppliedGateLines(appliedText), finished: parseFinished(appliedText) };
}

/** One root's lock, as `_locks/tf-apply.json` holds it. */
export interface RootLock {
  pr: number;
  by: string;
  at: string;
  head: string;
  via?: "lock";
  stage?: "plan";
}

/** The lock file: anything that is not a version 1 file with a map of locks reads as no locks (terragucci's parseLocks). */
export function parseLocks(text: string): Record<string, RootLock> {
  const doc = json(text.trim());
  const locks: Record<string, RootLock> = {};
  if (doc?.version !== 1 || !doc.locks || typeof doc.locks !== "object" || Array.isArray(doc.locks)) return locks;
  for (const [root, l] of Object.entries(doc.locks as Record<string, Record<string, unknown>>)) {
    if (Number.isInteger(l?.pr) && typeof l.by === "string" && typeof l.at === "string" && typeof l.head === "string")
      locks[root] = { pr: l.pr as number, by: l.by, at: l.at, head: l.head, ...(l.via === "lock" ? { via: "lock" as const } : {}), ...(l.stage === "plan" ? { stage: "plan" as const } : {}) };
  }
  return locks;
}

// ── the answer ───────────────────────────────────────────────────────────

/** The commit of `chant/lifecycle` an entry was read from: the newest one that changed its file, and when it was made. */
export interface LifecycleSource {
  branch: typeof LIFECYCLE_BRANCH;
  commit: string;
  committed: string;
  path: string;
}

/**
 * Where a wave's gate stands, as chant's `decideGateApproval` decides it:
 * `waiting` (no approval of its digest counts), `expired` (the pending fact's
 * `expiresAt` passed with none), `refused` (an unspent approval stands for
 * another digest: the wave refuses its plans), `approved` (an unspent approval
 * of the digest counts, and no wave applied under it yet), `applied` /
 * `failed` (a wave applied under the approval, and how it finished when
 * recorded).
 */
export type GateState = "waiting" | "expired" | "refused" | "approved" | "applied" | "failed";
export const GATE_STATES: readonly GateState[] = ["waiting", "expired", "refused", "approved", "applied", "failed"];

/** One approval line as the lane shows it. */
export interface LaneApproval {
  by: string;
  at: string;
  planDigest?: string;
  /** The seal carries a signature (chant's `sealOf`). Whether it verifies is `uncounted`'s, under `sealed`. */
  signed: boolean;
  via?: string;
  pr?: number;
  /** The pull request head a `pr-review` approval came from, and who approved it. */
  head?: string;
  reviewers?: string[];
  /** Who carried the approval to chant for its approver (a chat relay). */
  relayedBy?: string;
  note?: string;
  url?: string;
}

export interface GateEntry {
  gate: string;
  wave: number;
  state: GateState;
  /** The plan digest the gate is about: the newest pending fact's, else the newest approval's. */
  digest?: string;
  pending?: {
    timestamp: string;
    expiresAt: string;
    planDigest?: string;
    commit?: string;
    runId?: string;
    url?: string;
    description?: string;
    /** Each member's (root's) plan digest, as terragucci records them. */
    members?: { member: string; planDigest: string }[];
    /** The gate is never resolved over MCP or ACP (chant#3485). */
    neverOverMcp?: true;
  };
  /** The approval the state rests on: the counted one, the spent one a wave applied under, or under `refused` the one for another digest. */
  approval?: LaneApproval;
  /** Under `refused`: the digest the standing approval is for. */
  refused?: { digest?: string; by: string; at: string };
  /** Approvals of this digest the mode did not count (an unsealed approval under `sealed`), with chant's reason. */
  uncounted?: { approval: LaneApproval; reason: string }[];
  /** An approval of another digest a wave already applied under, which counts for nothing now. */
  spent?: LaneApproval;
  applied?: { at: string; approvedAt: string; approvedBy: string; runId?: string; commit?: string; wave?: { number: number; name: string }; review?: { pr?: number; head?: string }; result?: "applied" | "failed"; finished?: string };
  /** The reports a waiting wave kept on the branch, one per digest it asked approval for. */
  records: { digest: string; path: string }[];
  /** The line a person runs to approve, when the gate waits. behold never runs it. */
  command?: string;
  source: LifecycleSource;
}

export interface LockEntry extends RootLock {
  root: string;
  source: LifecycleSource;
}

export type LifecycleVia = "fetch" | "checkout-ref" | "none";

export interface LifecycleAnswer {
  branch: typeof LIFECYCLE_BRANCH;
  /** False when the branch was not found (the remote has none, or nothing could be read: see `via` and `fetch`). */
  found: boolean;
  /**
   * Where the branch was read: `fetch` (fetched from origin just now into
   * behold's own cache), `checkout-ref` (the fetch failed; the checkout's
   * `refs/remotes/origin/chant/lifecycle`, as old as its last fetch), `none`
   * (neither).
   */
  via: LifecycleVia;
  /** The origin URL fetched from, with any credentials in it removed. */
  origin?: string;
  fetch: { ok: boolean; error?: string };
  /** The branch's tip, when one was read. */
  commit?: { sha: string; committed: string };
  read: { at: string };
  /** The rule the gates were decided by, read at base. */
  approval?: ApprovalRule;
  gates: GateEntry[];
  locks: LockEntry[];
  /** One sentence for the page: where this came from, and how old it can be. */
  note: string;
}

const t = (iso: string): number => new Date(iso).getTime();
const newest = <T>(xs: T[], at: (x: T) => string): T | undefined => xs.reduce<T | undefined>((b, x) => (!b || t(at(x)) >= t(at(b)) ? x : b), undefined);

/** A resolution line as the lane shows it. `signed` follows `seal.signature`, as chant's sealOf does. */
export function laneApproval(r: GateResolutionRecord): LaneApproval {
  const x = r as GateResolutionRecord & { via?: unknown; pr?: unknown; head?: unknown; reviewers?: unknown };
  const seal = r.seal as { signature?: unknown } | null | undefined;
  const reviewers = Array.isArray(x.reviewers) ? x.reviewers.filter((v): v is string => typeof v === "string") : r.review?.approvers;
  const pr = typeof x.pr === "number" ? x.pr : r.review?.pr;
  const head = typeof x.head === "string" ? x.head : r.review?.head;
  return {
    by: r.resolvedBy,
    at: r.timestamp,
    ...(r.planDigest ? { planDigest: r.planDigest } : {}),
    signed: !!seal && typeof seal === "object" && typeof seal.signature === "string" && seal.signature.length > 0,
    ...(typeof x.via === "string" ? { via: x.via } : r.review ? { via: "pr-review" } : {}),
    ...(pr !== undefined ? { pr } : {}),
    ...(head ? { head } : {}),
    ...(reviewers && reviewers.length ? { reviewers } : {}),
    ...(r.relayedBy ? { relayedBy: r.relayedBy } : {}),
    ...(r.note ? { note: r.note } : {}),
    ...(r.url ? { url: r.url } : {}),
  };
}

/** What the lane decides one gate by: the mode, and under `sealed` the signers at base. */
export interface LaneRule {
  mode: GateApprovalSource;
  signers?: GateSigners;
}

/**
 * One gate decided by chant's `decideGateApproval` against the ledger, with
 * spent approvals left out when the spec spends them. The digest is the
 * newest pending fact's (the plan the wave waits on), else the newest
 * approval's. Returns the state and what it rests on; the caller adds the
 * wave, records, command and source.
 */
export function decideLaneGate(
  ledger: GateLedger,
  gate: string,
  rule: LaneRule,
  now: Date,
  spend = true,
): Pick<GateEntry, "state" | "digest" | "pending" | "approval" | "refused" | "uncounted" | "spent" | "applied"> & { decision?: GateApprovalDecision } {
  const pending = newest(ledger.pending.filter((p) => p.gate === gate), (p) => p.timestamp);
  const mine = ledger.resolutions.filter((r) => r.gate === gate);
  const digest = pending?.planDigest ?? newest(mine.filter((r) => !pending || t(r.timestamp) >= t(pending.timestamp)), (r) => r.timestamp)?.planDigest ?? newest(mine, (r) => r.timestamp)?.planDigest;
  const pendingOut = pending
    ? {
        pending: {
          timestamp: pending.timestamp,
          expiresAt: pending.expiresAt,
          ...(pending.planDigest ? { planDigest: pending.planDigest } : {}),
          ...(typeof (pending as { commit?: unknown }).commit === "string" ? { commit: (pending as unknown as { commit: string }).commit } : {}),
          ...(pending.runId ? { runId: pending.runId } : {}),
          ...(pending.url ? { url: pending.url } : {}),
          ...(pending.description ? { description: pending.description } : {}),
          ...(membersOf(pending) ? { members: membersOf(pending)! } : {}),
          ...(pending.neverOverMcp ? { neverOverMcp: true as const } : {}),
        },
      }
    : {};
  const base = { ...(digest ? { digest } : {}), ...pendingOut };
  if (!digest) {
    // A gate with no digest on any line binds no plan; the lane shows it waiting, as chant would never pass it.
    return { state: pending && t(pending.expiresAt) <= now.getTime() ? "expired" : "waiting", ...base };
  }
  const decision = decideGateApproval({
    ledger: { pending: ledger.pending, resolutions: ledger.resolutions, applied: ledger.applied },
    gate,
    planDigest: digest,
    mode: rule.mode,
    ...(rule.signers ? { signers: rule.signers } : {}),
    now: now.toISOString(),
    spend,
  });
  if (decision.status === "approved") {
    return { state: "approved", ...base, ...(decision.via === "ledger" ? { approval: laneApproval(decision.resolution) } : {}), decision };
  }
  const uncounted = decision.uncounted.length ? { uncounted: decision.uncounted.map((u) => ({ approval: laneApproval(u.resolution), reason: u.reason })) } : {};
  // A spent approval of this digest: a wave applied under it.
  if (decision.spent && samePlanDigest(decision.spent.planDigest, digest)) {
    const s = decision.spent;
    const applied = newest(ledger.applied.filter((a) => a.gate === gate && samePlanDigest(a.planDigest, s.planDigest!) && t(a.approvedAt) >= t(s.timestamp)), (a) => a.timestamp);
    if (applied) {
      const finished = newest(ledger.finished.filter((f) => f.gate === gate && samePlanDigest(f.planDigest, applied.planDigest) && f.applied === applied.timestamp), (f) => f.timestamp);
      return {
        state: finished?.result === "failed" ? "failed" : "applied",
        ...base,
        approval: laneApproval(s),
        ...uncounted,
        applied: {
          at: applied.timestamp,
          approvedAt: applied.approvedAt,
          approvedBy: applied.approvedBy,
          ...(applied.runId ? { runId: applied.runId } : {}),
          ...(applied.commit ? { commit: applied.commit } : {}),
          ...(applied.wave ? { wave: applied.wave } : {}),
          ...(applied.review ? { review: applied.review } : {}),
          ...(finished ? { result: finished.result, finished: finished.timestamp } : {}),
        },
        decision,
      };
    }
  }
  const spent = decision.spent && !samePlanDigest(decision.spent.planDigest, digest) ? { spent: laneApproval(decision.spent) } : {};
  if (decision.mismatched && pending) {
    const m = decision.mismatched;
    return { state: "refused", ...base, approval: laneApproval(m), refused: { ...(m.planDigest ? { digest: m.planDigest } : {}), by: m.resolvedBy, at: m.timestamp }, ...uncounted, ...spent, decision };
  }
  const expired = pending && t(pending.expiresAt) <= now.getTime();
  return { state: expired ? "expired" : "waiting", ...base, ...uncounted, ...spent, decision };
}

function membersOf(p: PendingGateRecord): { member: string; planDigest: string }[] | undefined {
  const raw = (p as { members?: unknown }).members;
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((m): m is { member: string; planDigest: string } => !!m && typeof m.member === "string" && typeof m.planDigest === "string").map((m) => ({ member: m.member, planDigest: m.planDigest }));
  return out.length ? out : undefined;
}

/** Each wave's gate, decided by chant's gate-decision under `rule`. */
export function gateEntries(
  ledger: GateLedger,
  records: { wave: number; digest: string; path: string }[],
  source: LifecycleSource,
  now: Date,
  rule: LaneRule = { mode: "ledger" },
  spec: Pick<GateLaneSpec, "waveOf" | "approveCommand" | "spend"> = TERRAGUCCI_LANE,
): GateEntry[] {
  const gates = new Set<string>();
  for (const r of [...ledger.pending, ...ledger.resolutions, ...ledger.applied]) if (spec.waveOf(r.gate) !== undefined) gates.add(r.gate);
  const out: GateEntry[] = [];
  for (const gate of gates) {
    const wave = spec.waveOf(gate)!;
    const { decision: _d, ...d } = decideLaneGate(ledger, gate, rule, now, spec.spend);
    out.push({
      gate,
      wave,
      ...d,
      records: records.filter((r) => r.wave === wave).map(({ digest: dg, path }) => ({ digest: dg, path })),
      ...(d.state === "waiting" ? { command: spec.approveCommand(gate, d.digest, rule.mode) } : {}),
      source,
    });
  }
  return out.sort((a, b) => a.wave - b.wave);
}

/** `<recordsDir>/wave-<k>/<digest>.json` paths, as `git ls-tree` names them, back to their wave and digest. */
export function waveRecords(paths: string[], dir: string = WAVE_RECORDS_DIR): { wave: number; digest: string; path: string }[] {
  const out: { wave: number; digest: string; path: string }[] = [];
  const prefix = `${dir}/wave-`;
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const m = /^(\d+)\/([^/]+)\.json$/.exec(path.slice(prefix.length));
    if (m) out.push({ wave: Number(m[1]), digest: m[2]!.replace("_", ":"), path });
  }
  return out;
}

/** The mode at base and, under `sealed`, the signers there. `repo` is a directory git can read `base` in. */
export async function approvalRuleAt(
  spec: Pick<GateLaneSpec, "approvalMode">,
  repo: string,
  base: string | undefined,
  show: (path: string) => Promise<string | undefined>,
): Promise<{ rule: ApprovalRule; lane: LaneRule }> {
  if (!base) {
    const m = await spec.approvalMode(async () => undefined, 0);
    return { rule: { ...m, note: [m.note, "behold could not read the default branch at base, so the mode is the default and no seal is checked"].filter(Boolean).join("; ") }, lane: { mode: m.mode } };
  }
  let identity = 0;
  let note: string | undefined;
  try {
    identity = identityGatesAt(repo, base).length;
  } catch (e) {
    note = e instanceof Error ? e.message : String(e);
  }
  const m = await spec.approvalMode(show, identity);
  const notes = [m.note, note].filter(Boolean).join("; ");
  if (m.mode !== "sealed") return { rule: { ...m, base, ...(notes ? { note: notes } : {}) }, lane: { mode: m.mode } };
  const signers = gateSignersAt(repo, base);
  return {
    rule: { ...m, base, signers: { path: signers.signersPath, active: signers.active, count: signers.signers.length, problems: signers.problems }, ...(notes ? { note: notes } : {}) },
    lane: { mode: m.mode, signers },
  };
}

// ── git, read-only on the checkout ───────────────────────────────────────

export type GitRun = (args: string[], o?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Runs git with no prompt (a fetch that would ask for a password fails instead) and no optional locks. */
export const realGit: GitRun = (args, o = {}) =>
  new Promise((res) => {
    execFile(
      process.env.GIT_BIN || "git",
      args,
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: o.timeoutMs ?? 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : -1) : 0;
        res({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (err ? err.message : "") });
      },
    );
  });

/** A URL with any `user:password@` taken out, for a payload or a message. */
export const redact = (s: string): string => s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1");

/** The cache directory for an origin URL: `<root>/behold-lifecycle-<16 hex of its sha256>`. */
export function cacheDir(origin: string, root: string = tmpdir()): string {
  return join(root, `${CACHE_PREFIX}${createHash("sha256").update(origin).digest("hex").slice(0, 16)}`);
}

/** One fetch at a time per cache directory, in this process. */
const inflight = new Map<string, Promise<unknown>>();
function serially<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = inflight.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  inflight.set(key, next);
  void next.finally(() => {
    if (inflight.get(key) === next) inflight.delete(key);
  }).catch(() => undefined);
  return next;
}

export interface LifecycleOptions {
  /** Where the cache directory goes. Default: the OS temp directory. */
  cacheRoot?: string;
  git?: GitRun;
  now?: () => Date;
  /** The product's lane: op, ledger paths, gate names, approve line, mode at base. Default: terragucci's. */
  spec?: GateLaneSpec;
}

/** The origin URL as git would fetch it: a relative local path is resolved against the checkout. */
function fetchable(url: string, checkout: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/]+@[^:/]+:/.test(url) || isAbsolute(url)) return url;
  return resolve(checkout, url);
}
/** Fetch the branch, and origin's default branch tip as base, into behold's cache. `found: false` when the remote has no such branch. */
async function fetchIntoCache(git: GitRun, origin: string, cache: string): Promise<{ ok: true; found: boolean; base?: string } | { ok: false; error: string }> {
  assertScratch(basename(cache));
  return serially(cache, async () => {
    if (!existsSync(join(cache, "HEAD"))) {
      if (existsSync(cache) && readdirSync(cache).length > 0) return { ok: false as const, error: `${cache} exists and is not behold's lifecycle cache; behold leaves it alone` };
      mkdirSync(cache, { recursive: true });
      const init = await git(["init", "--bare", "-q", cache]);
      if (init.code !== 0) return { ok: false as const, error: `could not make the cache ${cache}: ${init.stderr.trim()}` };
    }
    const f = await git(["--git-dir", cache, "fetch", "-q", "--no-tags", origin, `+refs/heads/${LIFECYCLE_BRANCH}:${CACHE_REF}`]);
    if (f.code !== 0) {
      if (/couldn't find remote ref|could not find remote ref/i.test(f.stderr)) return { ok: true as const, found: false };
      return { ok: false as const, error: redact(f.stderr.trim() || `git fetch exited ${f.code}`) };
    }
    // Base: the default branch's tip, one commit deep. A failure here leaves the mode at its default, and the answer says so.
    const b = await git(["--git-dir", cache, "fetch", "-q", "--no-tags", "--depth=1", origin, `+HEAD:${CACHE_BASE_REF}`]);
    const sha = b.code === 0 ? (await git(["--git-dir", cache, "rev-parse", "--verify", "-q", `${CACHE_BASE_REF}^{commit}`])).stdout.trim() : "";
    return { ok: true as const, found: true, ...(sha ? { base: sha } : {}) };
  });
}

/** The checkout's base, read-only: its `origin/HEAD`, else its HEAD. */
async function checkoutBase(git: GitRun, checkout: string): Promise<string | undefined> {
  for (const ref of ["refs/remotes/origin/HEAD", "HEAD"]) {
    const r = await git(["-C", checkout, "rev-parse", "--verify", "-q", `${ref}^{commit}`]);
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return undefined;
}

/** Read the lane at `ref` in `repo` (git args that name the repository; `dir` is its directory), deciding under the rule at `base`. */
async function readAt(
  git: GitRun,
  repo: string[],
  dir: string,
  ref: string,
  base: string | undefined,
  now: Date,
  spec: GateLaneSpec,
): Promise<{ commit: { sha: string; committed: string }; approval: ApprovalRule; gates: GateEntry[]; locks: LockEntry[] } | undefined> {
  const tip = await git([...repo, "log", "-1", "--format=%H%x00%cI", ref, "--"]);
  if (tip.code !== 0 || !tip.stdout.trim()) return undefined;
  const [sha, committed] = tip.stdout.trim().split("\0") as [string, string];
  const showAt = async (commit: string, path: string): Promise<string | undefined> => {
    const r = await git([...repo, "cat-file", "blob", `${commit}:${path}`]);
    return r.code === 0 ? r.stdout : undefined;
  };
  const show = async (path: string): Promise<string> => (await showAt(sha, path)) ?? "";
  const changed = async (...paths: string[]): Promise<LifecycleSource> => {
    const r = await git([...repo, "log", "-1", "--format=%H%x00%cI", sha, "--", ...paths]);
    const [c, at] = r.code === 0 && r.stdout.trim() ? (r.stdout.trim().split("\0") as [string, string]) : [sha, committed];
    return { branch: LIFECYCLE_BRANCH, commit: c, committed: at, path: paths.join(" ") };
  };
  const [ledgerText, appliedText, locksText, tree, rule] = await Promise.all([
    show(spec.ledgerPath),
    show(spec.appliedPath),
    spec.locksPath ? show(spec.locksPath) : Promise.resolve(""),
    spec.recordsDir ? git([...repo, "ls-tree", "-r", "--name-only", sha, "--", `${spec.recordsDir}/`]) : Promise.resolve({ code: 1, stdout: "", stderr: "" }),
    approvalRuleAt(spec, dir, base, (path) => showAt(base!, path)),
  ]);
  const ledger = readGateLedgerText(ledgerText, appliedText);
  const records = spec.recordsDir ? waveRecords(tree.code === 0 ? lines(tree.stdout) : [], spec.recordsDir) : [];
  const gates = ledger.pending.length || ledger.resolutions.length || ledger.applied.length ? gateEntries(ledger, records, await changed(spec.ledgerPath, spec.appliedPath), now, rule.lane, spec) : [];
  const lockMap = parseLocks(locksText);
  const lockSource = Object.keys(lockMap).length && spec.locksPath ? await changed(spec.locksPath) : undefined;
  const locks = Object.entries(lockMap)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([root, l]) => ({ root, ...l, source: lockSource! }));
  return { commit: { sha, committed }, approval: rule.rule, gates, locks };
}

/**
 * Read `chant/lifecycle` for the checkout at `checkout`: fetched from its
 * origin into behold's cache, else the checkout's remote-tracking ref,
 * read-only. Never throws for a git failure; the answer says what happened.
 */
export async function readLifecycle(checkout: string, opts: LifecycleOptions = {}): Promise<LifecycleAnswer> {
  const git = opts.git ?? realGit;
  const spec = opts.spec ?? TERRAGUCCI_LANE;
  const now = (opts.now ?? (() => new Date()))();
  const base = { branch: LIFECYCLE_BRANCH, read: { at: now.toISOString() } } as const;
  const empty = { gates: [] as GateEntry[], locks: [] as LockEntry[] };

  const remote = await git(["-C", checkout, "remote", "get-url", "origin"]);
  const url = remote.code === 0 ? remote.stdout.trim() : "";
  let fetchError: string;
  let origin: string | undefined;
  if (!url) {
    fetchError = "the checkout has no origin remote";
  } else {
    const from = fetchable(url, checkout);
    origin = redact(from);
    const cache = cacheDir(from, opts.cacheRoot);
    let f: Awaited<ReturnType<typeof fetchIntoCache>>;
    try {
      f = await fetchIntoCache(git, from, cache);
    } catch (e) {
      f = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (f.ok && !f.found) {
      return { ...base, found: false, via: "fetch", origin, fetch: { ok: true }, ...empty, note: `${origin} has no ${LIFECYCLE_BRANCH} branch: no wave has asked for an approval and no root is locked yet.` };
    }
    if (f.ok) {
      const lane = await readAt(git, ["--git-dir", cache], cache, CACHE_REF, f.base, now, spec);
      if (lane) return { ...base, found: true, via: "fetch", origin, fetch: { ok: true }, ...lane, note: `${LIFECYCLE_BRANCH} as fetched from ${origin} at ${base.read.at}.` };
      fetchError = `fetched ${LIFECYCLE_BRANCH}, but behold's cache could not read it`;
    } else {
      fetchError = f.error;
    }
  }

  // The fetch failed: the checkout's own copy, as old as its last fetch, read-only.
  const lane = await readAt(git, ["-C", checkout], checkout, CHECKOUT_REF, await checkoutBase(git, checkout), now, spec);
  if (lane) {
    return {
      ...base,
      found: true,
      via: "checkout-ref",
      ...(origin ? { origin } : {}),
      fetch: { ok: false, error: fetchError },
      ...lane,
      note: `behold could not fetch ${LIFECYCLE_BRANCH} (${fetchError}), so this is the checkout's ${CHECKOUT_REF}, as of its last git fetch; its tip was committed ${lane.commit.committed}.`,
    };
  }
  return {
    ...base,
    found: false,
    via: "none",
    ...(origin ? { origin } : {}),
    fetch: { ok: false, error: fetchError },
    ...empty,
    note: `behold could not fetch ${LIFECYCLE_BRANCH} (${fetchError}) and the checkout has no ${CHECKOUT_REF}, so the gates and locks are unknown.`,
  };
}
