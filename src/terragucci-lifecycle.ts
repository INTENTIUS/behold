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
  DEFAULT_SIGNERS_PATH,
  gateSealRefusal,
  gateSignersAt,
  identityGatesAt,
  parseAppliedGateLines,
  type AppliedGateRecord,
  type GateApprovalDecision,
  type GateApprovalSource,
  type GateResolutionRecord,
  type GateSigners,
  type IdentityGate,
  type PendingGateRecord,
} from "@intentius/chant/gate-decision";
import { parseGateLedger } from "@intentius/chant/lifecycle/gate-ledger";
import {
  decideOverride,
  OVERRIDE_APPLIED,
  OVERRIDE_LEDGER,
  OVERRIDE_OP,
  OVERRIDERS_PATH,
  overrideCommand,
  parseAppliedOverrides,
  parseOverriders,
  recordedDenials,
  type AppliedOverrideRecord,
} from "@intentius/chant/override-gate";
import { samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import type { HeadPlans } from "@intentius/chant/op/gate-review";
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
export const CACHE_REF = `refs/heads/${LIFECYCLE_BRANCH}`;
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
  /** Under `sealed` (the lane's or any wave's): the signers path at base, whether it exists, and any problem reading it. */
  signers?: { path: string; active: boolean; count: number; problems: string[] };
  /**
   * Each wave's own mode, when the waves at base name different ones (#537).
   * A wave listed here is decided under its mode; any other under `mode`.
   */
  waves?: { wave: number; name?: string; mode: GateApprovalSource }[];
  /** Something the person should know, such as a base behold could not read. */
  note?: string;
  /** The gates `identity.gates` in chant.workspace.json at base names, each counting only a sealed approval (from its class, when it names one). */
  identityGates?: IdentityGate[];
  /**
   * Why the mode is inferred: a wave's pending fact does not record the mode
   * it asked under (chant#3861), and a pipeline's `--approval` flag lives in
   * its generated CI, so the mode is the one read at base.
   */
  inferred?: string;
}

/** The lane's mode is read at base, never from the wave: what the lane says about it until chant#3861 records it on the pending fact. */
export const MODE_INFERRED =
  "the mode is inferred from the config at base: a wave's pending fact does not record the approval mode it asked under (INTENTIUS/chant#3861), and a pipeline's --approval flag in its generated CI can set another";

/** behold checks the seal on an identity.gates gate, not the class it names: gate-decision does not export the class check (INTENTIUS/chant#3862). */
export const CLASS_UNCHECKED = "behold checks the seal but not the class: chant's class check cannot be read at a base commit yet (INTENTIUS/chant#3862)";

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
  /** The gate wave `k` waits on, for a wave the lane knows only from another ledger (a policy denial, a hold). */
  gateOf(wave: number): string;
  /**
   * The line a person runs to approve a waiting gate. behold never runs it.
   * `at.op` is the op the pending fact names (the ledger's, not a constant);
   * `at.wave` is the gate's wave.
   */
  approveCommand(gate: string, digest: string | undefined, mode: GateApprovalSource, at?: { op: string; wave?: number }): string;
  /**
   * Who may override a policy denial, read at base (`show` reads a file
   * there). Default: chant's `.chant/overriders`.
   */
  overriders?(show: (path: string) => Promise<string | undefined>): Promise<{ principals: string[]; path: string }>;
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
  /**
   * Where `chant run wave --record-plans` keeps each pull request head's
   * plans, `<dir>/<head>.json` (chant's `headPlansPath`: `_wave-plans/<op>`),
   * read for a `pr-review` wave (#537).
   */
  headPlansDir?: string;
  /**
   * The project's ledger on the branch: `""`, or `_members/<member>/` per
   * level for a workspace member (chant's `resolveMemberLedger`, #537). Every
   * branch path above is read under it.
   */
  ledgerPrefix?: string;
}

/** A lane spec for `op` with chant's paths: `_gates/<op>.jsonl` and `_gates/<op>/applied.jsonl`. */
export function gateLanePaths(op: string): Pick<GateLaneSpec, "op" | "ledgerPath" | "appliedPath"> {
  const a = appliedGatePath(op);
  return { op, ledgerPath: `_gates/${op}.jsonl`, appliedPath: `${a.dir}/${a.file}` };
}

/**
 * A wave's gate name: terragucci's `wave-<k>`, chant op-waves' default
 * `<gate>-wave-<k>` (`tf-apply-wave-2`), or a product's own `<name>-wave-<k>`
 * (SQL Yodeler's `yodel-apply-wave-<k>`).
 */
export const WAVE_GATE = /^(?:[\w-]+-)?wave-(\d+)$/;

/** The wave a gate name is, by {@link WAVE_GATE}, or undefined. */
export function waveOfGate(gate: string): number | undefined {
  const m = WAVE_GATE.exec(gate);
  return m ? Number(m[1]) : undefined;
}

/** chant's own approve line (`chant approve <op> <gate> --plan <digest>`, `--sign` under sealed), as chant's op waves print it. */
export function chantApproveCommand(op: string, gate: string, digest: string | undefined, sealed: boolean): string {
  return `chant approve ${op} ${gate}${digest ? ` --plan ${digest}` : ""}${sealed ? " --sign" : ""}`;
}

/** The line that answers a decision point a gate asks (chant#3170): `chant workspace points answer <id>`. */
export function pointAnswerCommand(id: string): string {
  return `chant workspace points answer ${id}`;
}

/** terragucci's approve line for wave `k`: `npx terragucci approve wave-<k>`, whatever chant names the gate. */
export function terragucciApproveCommand(wave: number, digest: string | undefined | null, sealed = false): string {
  return `npx terragucci approve wave-${wave}${digest ? ` --plan ${digest}` : ""}${sealed ? " --sign" : ""}`;
}

/** A gate policy as chant names it: `on-destroy` is an alias of `on-destructive` (terragucci#863). */
export function gatePolicyName(policy: string): string {
  return policy === "on-destroy" ? "on-destructive" : policy;
}

/** The overriders in `.chant/overriders` at base (chant's default list). */
export async function chantOverriders(show: (path: string) => Promise<string | undefined>): Promise<{ principals: string[]; path: string }> {
  const text = await show(OVERRIDERS_PATH);
  return { principals: text === undefined ? [] : parseOverriders(text), path: OVERRIDERS_PATH };
}

/** chant's mode at base for a product with no approval key of its own: any `identity.gates` means sealed, else ledger. */
export async function chantApprovalMode(_show: (path: string) => Promise<string | undefined>, identityGates: number): Promise<Omit<ApprovalRule, "base" | "signers">> {
  if (identityGates > 0) return { mode: "sealed", source: "identity.gates in chant.workspace.json at base" };
  return { mode: "ledger", source: "the default" };
}

/**
 * A lane for any product whose waves run on chant's op waves (#521): the
 * gates of `op` named by {@link WAVE_GATE}, chant's approve line, spent
 * approvals, chant's mode rule and `.chant/overriders`. Pass `over` to set a
 * product's own gate name, approve line, mode or overriders.
 */
export function opWavesLane(op: string, over: Partial<Omit<GateLaneSpec, "op" | "ledgerPath" | "appliedPath">> = {}): GateLaneSpec {
  return {
    ...gateLanePaths(op),
    waveOf: waveOfGate,
    gateOf: (k) => `${op}-wave-${k}`,
    approveCommand: (gate, digest, mode, at) => chantApproveCommand(at?.op ?? op, gate, digest, mode === "sealed"),
    spend: true,
    approvalMode: chantApprovalMode,
    overriders: chantOverriders,
    ...over,
  };
}

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

/** terragucci's overriders: `policy.override` in its config at base (terragucci `src/override.ts`). */
export async function terragucciOverriders(show: (path: string) => Promise<string | undefined>): Promise<{ principals: string[]; path: string }> {
  for (const name of TERRAGUCCI_CONFIG_NAMES) {
    const text = await show(name);
    if (text === undefined || name.endsWith(".ts")) continue;
    try {
      const doc = (name.endsWith(".json") ? JSON.parse(text) : parseYAML(text)) as { policy?: { override?: unknown } } | null;
      const list = doc?.policy?.override;
      return { principals: Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [], path: "policy.override" };
    } catch {
      return { principals: [], path: "policy.override" };
    }
  }
  return { principals: [], path: "policy.override" };
}

/**
 * terragucci's lane: tf-apply's wave gates (`wave-<k>` today, chant's
 * `tf-apply-wave-<k>` or terragucci's own name once terragucci#879 lands),
 * its approve line, its lock file and its kept reports.
 */
export const TERRAGUCCI_LANE: GateLaneSpec = opWavesLane("tf-apply", {
  gateOf: (k) => `wave-${k}`,
  approveCommand: (gate, digest, mode, at) => {
    const k = at?.wave ?? waveOfGate(gate);
    return k !== undefined ? terragucciApproveCommand(k, digest, mode === "sealed") : chantApproveCommand(at?.op ?? "tf-apply", gate, digest, mode === "sealed");
  },
  approvalMode: terragucciApprovalMode,
  overriders: terragucciOverriders,
  locksPath: LOCKS_PATH,
  recordsDir: WAVE_RECORDS_DIR,
});

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
  /**
   * The other ledgers on the branch (`_gates/<op>.jsonl`), read for waves
   * held on another gate (#521). The override ledger is `override`.
   */
  others?: OtherLedger[];
  /** `_gates/policy-override.jsonl` and its applied lines: the policy's denials and the overrides of them (#521). */
  override?: { pending: PendingGateRecord[]; resolutions: GateResolutionRecord[]; applied: AppliedOverrideRecord[] };
}

/** Another op's ledger on the branch. */
export interface OtherLedger {
  op: string;
  path: string;
  pending: PendingGateRecord[];
  resolutions: GateResolutionRecord[];
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

/**
 * The ledger and the applied file, read with chant's parsers (and the
 * finished lines with terragucci's). `more` adds the other ledgers on the
 * branch, by path, and the override ledger's applied file, for the policy
 * refusals and holds (#521).
 */
export function readGateLedgerText(ledgerText: string, appliedText: string, more: { ledgers?: Record<string, string>; overrideApplied?: string } = {}): GateLedger {
  const { pending, resolutions } = parseGateLedger(ledgerText);
  const out: GateLedger = { pending, resolutions, applied: parseAppliedGateLines(appliedText), finished: parseFinished(appliedText) };
  const others: OtherLedger[] = [];
  for (const [path, text] of Object.entries(more.ledgers ?? {})) {
    const op = /^_gates\/([^/]+)\.jsonl$/.exec(path)?.[1];
    if (!op) continue;
    const l = parseGateLedger(text);
    if (path === OVERRIDE_LEDGER) out.override = { pending: l.pending, resolutions: l.resolutions, applied: parseAppliedOverrides(more.overrideApplied ?? "") };
    else others.push({ op, path, pending: l.pending, resolutions: l.resolutions });
  }
  if (others.length) out.others = others;
  return out;
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
 * recorded; with no `finished` line, as chant's op waves write none, the
 * outcome is not recorded and `applied.result` is absent).
 *
 * From the other ledgers (#521): `refused-by-policy` (the product's policy
 * denied a run of the wave and no override counts, chant's exit 7: a denial
 * on `_gates/policy-override.jsonl` newer than anything on the wave's own
 * gate) and `held` (a hook held the wave on another gate that waits: a
 * pending fact on that gate's ledger).
 */
export type GateState = "waiting" | "expired" | "refused" | "approved" | "applied" | "failed" | "refused-by-policy" | "held";
export const GATE_STATES: readonly GateState[] = ["waiting", "expired", "refused", "approved", "applied", "failed", "refused-by-policy", "held"];

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
  /** The op the gate's lines name. */
  op: string;
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
    /** The decision point the gate asks (chant#3170): answered with `chant workspace points answer <id>`, not an approval. */
    answer?: { point: string; id: string; path?: string };
  };
  /** The approval the state rests on: the counted one, the spent one a wave applied under, or under `refused` the one for another digest. */
  approval?: LaneApproval;
  /**
   * When `identity.gates` at base names this gate: only a sealed approval
   * counts, from `class` when it names one. `classChecked` is false when it
   * names a class, which behold cannot check (chant#3862).
   */
  identity?: { class: string | null; classChecked: boolean };
  /** Under `refused`: the digest the standing approval is for. */
  refused?: { digest?: string; by: string; at: string };
  /** Approvals of this digest the mode did not count (an unsealed approval under `sealed`), with chant's reason. */
  uncounted?: { approval: LaneApproval; reason: string }[];
  /** An approval of another digest a wave already applied under, which counts for nothing now. */
  spent?: LaneApproval;
  applied?: { at: string; approvedAt: string; approvedBy: string; runId?: string; commit?: string; wave?: { number: number; name: string }; review?: { pr?: number; head?: string }; result?: "applied" | "failed"; finished?: string };
  /** The reports a waiting wave kept on the branch, one per digest it asked approval for. */
  records: { digest: string; path: string }[];
  /** Under `refused-by-policy`: each run the policy denied, with no override that counts, and the line that overrides it. */
  denials?: { member: string; plan: string; rules: string[]; at: string; expiresAt: string; description?: string; url?: string; refusals: string[]; moved?: { by: string; was?: string }; command: string }[];
  /** Under `held`: the other gate a hook holds the wave on, which waits. */
  heldOn?: { op: string; gate: string; digest?: string; since: string; hook?: string; description?: string; url?: string; answer?: { point: string; id: string; path?: string } };
  /** The line a person runs, when the gate waits or the wave is held: an approval, or a decision point's answer. behold never runs it. */
  command?: string;
  /** The mode this wave is decided under, when it is its own and not the lane's (#537). */
  mode?: GateApprovalSource;
  /**
   * Under `pr-review`, for a gate not yet approved: the pull request heads
   * whose recorded plans (`_wave-plans/<op>/<head>.json`) name this wave's
   * digest. An approving review of the merged pull request at one of these
   * heads, by a writer other than its author, approves the wave when it runs
   * again; behold cannot see the review itself.
   */
  headPlans?: { head: string; timestamp: string; path: string }[];
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
    ...(typeof x.via === "string" ? { via: x.via } : r.review ? { via: "review" } : {}),
    ...(pr !== undefined ? { pr } : {}),
    ...(head ? { head } : {}),
    ...(reviewers && reviewers.length ? { reviewers } : {}),
    ...(r.relayedBy ? { relayedBy: r.relayedBy } : {}),
    ...(r.note ? { note: r.note } : {}),
    ...(r.url ? { url: r.url } : {}),
  };
}

/** What the lane decides one gate by: the mode, under `sealed` the signers at base, and who may override a policy denial. */
export interface LaneRule {
  mode: GateApprovalSource;
  /** Each wave's own mode, when it differs from the lane's (#537). */
  waves?: Record<number, GateApprovalSource>;
  /** The signers at base: under `sealed`, and whenever `identity.gates` names a gate. */
  signers?: GateSigners;
  /** The gates `identity.gates` at base names (chant's `identityGatesAt`). */
  identityGates?: IdentityGate[];
  overriders?: { principals: string[]; path: string };
}

/**
 * chant's `identity.gates` rule for `gate`, as `decideGateApproval`'s
 * `refuses`: an approval counts only when its seal verifies against the
 * signers at base (chant's `gateSealRefusal`), whatever the lane's mode.
 * chant also checks the class the gate names against the role grants at
 * base; gate-decision does not export that check (INTENTIUS/chant#3862), so
 * the gate's entry says the class was not checked. Undefined when
 * `identity.gates` does not name the gate.
 */
export function identityRefuses(rule: Pick<LaneRule, "identityGates" | "signers">, gate: string): ((r: GateResolutionRecord) => string | null) | undefined {
  const named = rule.identityGates?.find((g) => g.gate === gate);
  if (!named) return undefined;
  const signers: GateSigners = rule.signers ?? { base: null, signersPath: DEFAULT_SIGNERS_PATH, active: false, signers: [], problems: ["no signers were read at base"] };
  return (r) => {
    const why = gateSealRefusal(signers, r);
    return why === null ? null : `identity.gates.${gate} at base needs a sealed approval: ${why}`;
  };
}

/** The entry's `identity` field, for a gate `identity.gates` names. */
function identityOf(rule: Pick<LaneRule, "identityGates">, gate: string): Pick<GateEntry, "identity"> {
  const named = rule.identityGates?.find((g) => g.gate === gate);
  return named ? { identity: { class: named.class, classChecked: named.class === null } } : {};
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
): Pick<GateEntry, "state" | "digest" | "pending" | "approval" | "refused" | "uncounted" | "spent" | "applied" | "identity"> & { decision?: GateApprovalDecision } {
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
          ...(answerOf(pending) ? { answer: answerOf(pending)! } : {}),
        },
      }
    : {};
  const base = { ...(digest ? { digest } : {}), ...pendingOut, ...identityOf(rule, gate) };
  const refuses = identityRefuses(rule, gate);
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
    ...(refuses ? { refuses } : {}),
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

function answerOf(p: PendingGateRecord): { point: string; id: string; path?: string } | undefined {
  const a = (p as { answer?: unknown }).answer as { point?: unknown; id?: unknown; path?: unknown } | undefined;
  if (!a || typeof a !== "object" || typeof a.point !== "string" || typeof a.id !== "string") return undefined;
  return { point: a.point, id: a.id, ...(typeof a.path === "string" ? { path: a.path } : {}) };
}

function membersOf(p: PendingGateRecord): { member: string; planDigest: string }[] | undefined {
  const raw = (p as { members?: unknown }).members;
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((m): m is { member: string; planDigest: string } => !!m && typeof m.member === "string" && typeof m.planDigest === "string").map((m) => ({ member: m.member, planDigest: m.planDigest }));
  return out.length ? out : undefined;
}

/** The line for a waiting gate: a decision point's answer when its pending fact asks one, else the product's approve line. */
function waitingCommand(spec: Pick<GateLaneSpec, "approveCommand">, op: string, gate: string, wave: number, d: Pick<GateEntry, "digest" | "pending">, mode: GateApprovalSource): string {
  return d.pending?.answer ? pointAnswerCommand(d.pending.answer.id) : spec.approveCommand(gate, d.digest, mode, { op, wave });
}

/** The rule wave `k` is decided by: the lane's, under the wave's own mode when it names one (#537). */
export function waveRule(rule: LaneRule, wave: number): LaneRule {
  const mode = rule.waves?.[wave];
  return mode && mode !== rule.mode ? { ...rule, mode } : rule;
}

/** Each wave's gate, decided by chant's gate-decision under `rule`, with the waves the policy refused or a hook holds (#521). */
export function gateEntries(
  ledger: GateLedger,
  records: { wave: number; digest: string; path: string }[],
  source: LifecycleSource,
  now: Date,
  rule: LaneRule = { mode: "ledger" },
  spec: Pick<GateLaneSpec, "op" | "waveOf" | "gateOf" | "approveCommand" | "spend"> = TERRAGUCCI_LANE,
): GateEntry[] {
  const gates = new Map<string, string>();
  for (const r of [...ledger.pending, ...ledger.resolutions, ...ledger.applied]) if (spec.waveOf(r.gate) !== undefined) gates.set(r.gate, r.op || spec.op);
  const out: GateEntry[] = [];
  const recordsOf = (wave: number) => records.filter((r) => r.wave === wave).map(({ digest: dg, path }) => ({ digest: dg, path }));
  for (const [gate, op] of gates) {
    const wave = spec.waveOf(gate)!;
    const r = waveRule(rule, wave);
    const { decision: _d, ...d } = decideLaneGate(ledger, gate, r, now, spec.spend);
    out.push({
      gate,
      wave,
      op,
      ...d,
      ...(r !== rule ? { mode: r.mode } : {}),
      records: recordsOf(wave),
      ...(d.state === "waiting" ? { command: waitingCommand(spec, op, gate, wave, d, r.mode) } : {}),
      source,
    });
  }
  // A wave the policy refused, or a hook holds on another gate, shows that state when it is newer than anything on the wave's own gate.
  const since = (e: GateEntry): number => Math.max(e.pending ? t(e.pending.timestamp) : 0, e.approval ? t(e.approval.at) : 0, e.applied ? t(e.applied.at) : 0);
  const place = (wave: number, at: string, entry: Omit<GateEntry, "gate" | "wave" | "op" | "records" | "source">): void => {
    const i = out.findIndex((e) => e.wave === wave);
    const before = i >= 0 ? out[i]! : undefined;
    if (before && since(before) > t(at)) return;
    const gate = before?.gate ?? spec.gateOf(wave);
    const next: GateEntry = {
      gate,
      wave,
      op: before?.op ?? spec.op,
      ...(before?.digest ? { digest: before.digest } : {}),
      ...(before?.pending ? { pending: before.pending } : {}),
      ...entry,
      records: recordsOf(wave),
      source,
    };
    if (i >= 0) out[i] = next;
    else out.push(next);
  };
  for (const r of policyRefusals(ledger, rule, now, spec)) place(r.wave, r.at, { state: "refused-by-policy", denials: r.denials });
  for (const h of heldWaves(ledger, rule, now, spec)) place(h.wave, h.heldOn.since, { state: "held", heldOn: h.heldOn, command: h.command });
  return out.sort((a, b) => a.wave - b.wave);
}

/** chant op-waves' own descriptions, which name the wave: a denial's and a hold's (`op-waves-run.ts` settleDenials, settleOtherGate). */
const DENIAL_TEXT = /^wave (\d+) \((?:[^)]*)\) of (\S+): /;
const HELD_TEXT = /^wave (\d+) \((?:[^)]*)\) of (\S+) is held on it by (.+)$/;

/** The wave a run of this op is in, from the newest pending fact of a wave gate that lists it as a member. */
function waveOfMember(ledger: GateLedger, member: string, spec: Pick<GateLaneSpec, "waveOf">): number | undefined {
  const facts = ledger.pending.filter((p) => spec.waveOf(p.gate) !== undefined && membersOf(p)?.some((m) => m.member === member));
  const p = newest(facts, (x) => x.timestamp);
  return p ? spec.waveOf(p.gate) : undefined;
}

/**
 * The waves the policy refused (#521): each denial on the override ledger
 * (chant's `recordedDenials`) that no override counts for, as chant's
 * `decideOverride` decides under the lane's mode and overriders, and that no
 * run applied an override of since. Its wave is the one chant's description
 * names, else the wave whose pending fact lists the run.
 */
export function policyRefusals(
  ledger: GateLedger,
  rule: LaneRule,
  now: Date,
  spec: Pick<GateLaneSpec, "op" | "waveOf">,
): { wave: number; at: string; denials: NonNullable<GateEntry["denials"]> }[] {
  const o = ledger.override;
  if (!o) return [];
  const byWave = new Map<number, { at: string; denials: NonNullable<GateEntry["denials"]> }>();
  for (const d of recordedDenials(o.pending)) {
    const named = d.description ? DENIAL_TEXT.exec(d.description) : null;
    const wave = named ? (named[2] === spec.op ? Number(named[1]) : undefined) : waveOfMember(ledger, d.gate, spec);
    if (wave === undefined || !d.plan) continue;
    const r = waveRule(rule, wave);
    const sealed = r.mode === "sealed";
    const verdict = decideOverride({
      ledger: { pending: o.pending, resolutions: o.resolutions },
      applied: o.applied,
      subject: d.gate,
      planDigest: d.plan,
      rules: d.rules,
      overriders: rule.overriders?.principals ?? [],
      ...(rule.overriders ? { overridersPath: rule.overriders.path } : {}),
      mode: r.mode,
      ...(rule.signers ? { signers: rule.signers } : {}),
      now: now.toISOString(),
    });
    if (verdict.status === "overridden") continue;
    // A run applied under an override of this subject after the denial: the wave went on.
    if (o.applied.some((a) => a.op === OVERRIDE_OP && a.gate === d.gate && t(a.timestamp) >= t(d.timestamp))) continue;
    const w = byWave.get(wave) ?? { at: d.timestamp, denials: [] };
    if (t(d.timestamp) > t(w.at)) w.at = d.timestamp;
    w.denials.push({
      member: d.gate,
      plan: d.plan,
      rules: d.rules,
      at: d.timestamp,
      expiresAt: d.expiresAt,
      ...(d.description ? { description: d.description } : {}),
      ...(d.url ? { url: d.url } : {}),
      refusals: verdict.refusals,
      ...(verdict.status === "moved" ? { moved: { by: verdict.by, ...(verdict.was ? { was: verdict.was } : {}) } } : {}),
      command: overrideCommand(d.gate, d.rules, sealed),
    });
    byWave.set(wave, w);
  }
  return [...byWave.entries()].map(([wave, w]) => ({ wave, ...w }));
}

/**
 * The waves a hook holds on another gate that waits (#521): a pending fact
 * chant's op waves recorded on that gate's ledger, whose description names
 * this op's wave, with no approval of its digest that counts under the
 * lane's mode (`pr-review` counts the ledger, as chant settles a hold).
 */
export function heldWaves(
  ledger: GateLedger,
  rule: LaneRule,
  now: Date,
  spec: Pick<GateLaneSpec, "op">,
): { wave: number; heldOn: NonNullable<GateEntry["heldOn"]>; command: string }[] {
  const out = new Map<number, { wave: number; heldOn: NonNullable<GateEntry["heldOn"]>; command: string }>();
  const ledgers = [{ op: spec.op, pending: ledger.pending, resolutions: ledger.resolutions }, ...(ledger.others ?? [])];
  for (const l of ledgers) {
    const newestByGate = new Map<string, PendingGateRecord>();
    for (const p of l.pending) {
      const b = newestByGate.get(p.gate);
      if (!b || t(p.timestamp) >= t(b.timestamp)) newestByGate.set(p.gate, p);
    }
    for (const p of newestByGate.values()) {
      const m = p.description ? HELD_TEXT.exec(p.description) : null;
      if (!m || m[2] !== spec.op) continue;
      const wave = Number(m[1]);
      const mode: GateApprovalSource = waveRule(rule, wave).mode === "sealed" ? "sealed" : "ledger";
      if (p.planDigest) {
        const refuses = identityRefuses(rule, p.gate);
        const d = decideGateApproval({
          ledger: { pending: l.pending, resolutions: l.resolutions, applied: [] },
          gate: p.gate,
          planDigest: p.planDigest,
          mode,
          ...(rule.signers ? { signers: rule.signers } : {}),
          ...(refuses ? { refuses } : {}),
          now: now.toISOString(),
        });
        if (d.status === "approved") continue;
      }
      const answer = answerOf(p);
      const heldOn: NonNullable<GateEntry["heldOn"]> = {
        op: p.op || l.op,
        gate: p.gate,
        ...(p.planDigest ? { digest: p.planDigest } : {}),
        since: p.timestamp,
        hook: m[3]!,
        description: p.description!,
        ...(p.url ? { url: p.url } : {}),
        ...(answer ? { answer } : {}),
      };
      const before = out.get(wave);
      if (before && t(before.heldOn.since) > t(p.timestamp)) continue;
      out.set(wave, { wave, heldOn, command: answer ? pointAnswerCommand(answer.id) : chantApproveCommand(heldOn.op, p.gate, p.planDigest, mode === "sealed") });
    }
  }
  return [...out.values()];
}

/** How many head plans records a read takes, newest first: one per pull request head piles up over time. */
export const HEAD_PLANS_READ = 50;

/** A `_wave-plans/<op>/<head>.json` record as `chant run wave --record-plans` writes it (chant's `HeadPlans`), or undefined. */
export function parseHeadPlans(text: string): HeadPlans | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  const d = doc as Partial<HeadPlans> | null;
  if (!d || typeof d !== "object" || d.version !== 1 || typeof d.head !== "string" || typeof d.name !== "string" || !Array.isArray(d.waves)) return undefined;
  const waves = d.waves.filter((w): w is HeadPlans["waves"][number] => !!w && typeof w.wave === "number" && typeof w.digest === "string");
  return { version: 1, name: d.name, head: d.head, timestamp: typeof d.timestamp === "string" ? d.timestamp : "", waves };
}

/**
 * Each `pr-review` gate that is not approved or applied gets the heads whose
 * recorded plans name its wave's digest, newest first. Pure.
 */
export function withHeadPlans(gates: GateEntry[], records: { path: string; plans: HeadPlans }[], rule: LaneRule): GateEntry[] {
  return gates.map((g) => {
    if (waveRule(rule, g.wave).mode !== "pr-review" || !g.digest || ["approved", "applied", "failed"].includes(g.state)) return g;
    const heads = records
      .filter((r) => r.plans.waves.some((w) => w.wave === g.wave && samePlanDigest(w.digest, g.digest!)))
      .map((r) => ({ head: r.plans.head, timestamp: r.plans.timestamp, path: r.path }))
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    return heads.length ? { ...g, headPlans: heads } : g;
  });
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
  spec: Pick<GateLaneSpec, "approvalMode" | "overriders">,
  repo: string,
  base: string | undefined,
  show: (path: string) => Promise<string | undefined>,
): Promise<{ rule: ApprovalRule; lane: LaneRule }> {
  if (!base) {
    const m = await spec.approvalMode(async () => undefined, 0);
    return { rule: { ...m, inferred: MODE_INFERRED, note: [m.note, "behold could not read the default branch at base, so the mode is the default and no seal is checked"].filter(Boolean).join("; ") }, lane: { mode: m.mode } };
  }
  let identityGates: IdentityGate[] = [];
  let note: string | undefined;
  try {
    identityGates = identityGatesAt(repo, base);
  } catch (e) {
    note = e instanceof Error ? e.message : String(e);
  }
  const m = await spec.approvalMode(show, identityGates.length);
  const overriders = await (spec.overriders ?? chantOverriders)(show);
  const classes = identityGates.filter((g) => g.class !== null);
  const classNote = classes.length ? `identity.gates names a class for ${classes.map((g) => `${g.gate} (${g.class})`).join(", ")}; ${CLASS_UNCHECKED}` : undefined;
  const notes = [m.note, note, classNote].filter(Boolean).join("; ");
  const ids = identityGates.length ? { identityGates } : {};
  // #537: a wave whose mode is its own is decided under it.
  const waves = m.waves?.length ? { waves: Object.fromEntries(m.waves.map((w) => [w.wave, w.mode])) as Record<number, GateApprovalSource> } : {};
  if (m.mode !== "sealed" && !m.waves?.some((w) => w.mode === "sealed") && !identityGates.length) return { rule: { ...m, base, inferred: MODE_INFERRED, ...(notes ? { note: notes } : {}) }, lane: { mode: m.mode, overriders, ...waves } };
  // Sealed (the lane's mode or a wave's), or a gate identity.gates names: seals are checked against the signers at base.
  const signers = gateSignersAt(repo, base);
  return {
    rule: { ...m, base, inferred: MODE_INFERRED, signers: { path: signers.signersPath, active: signers.active, count: signers.signers.length, problems: signers.problems }, ...ids, ...(notes ? { note: notes } : {}) },
    lane: { mode: m.mode, signers, overriders, ...ids, ...waves },
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
export function fetchable(url: string, checkout: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/]+@[^:/]+:/.test(url) || isAbsolute(url)) return url;
  return resolve(checkout, url);
}

/** Fetch the branch, and origin's default branch tip as base, into behold's cache. `found: false` when the remote has no such branch. */
export async function fetchIntoCache(git: GitRun, origin: string, cache: string): Promise<{ ok: true; found: boolean; base?: string } | { ok: false; error: string }> {
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
  // #537: a workspace member's ledger sits under `_members/<member>/`; every path is read there.
  const at = (path: string): string => `${spec.ledgerPrefix ?? ""}${path}`;
  const [ledgerText, appliedText, locksText, tree, gatesDir, rule] = await Promise.all([
    show(at(spec.ledgerPath)),
    show(at(spec.appliedPath)),
    spec.locksPath ? show(at(spec.locksPath)) : Promise.resolve(""),
    spec.recordsDir ? git([...repo, "ls-tree", "-r", "--name-only", sha, "--", `${at(spec.recordsDir)}/`]) : Promise.resolve({ code: 1, stdout: "", stderr: "" }),
    git([...repo, "ls-tree", "--name-only", sha, "--", at("_gates/")]),
    approvalRuleAt(spec, dir, base, (path) => showAt(base!, path)),
  ]);
  // #521: the other ops' ledgers, for a wave held on another gate, and the override ledger, for a wave the policy refused.
  const otherPaths = (gatesDir.code === 0 ? lines(gatesDir.stdout) : [])
    .filter((p) => p.startsWith(at("")))
    .map((p) => p.slice(at("").length))
    .filter((p) => /^_gates\/[^/]+\.jsonl$/.test(p) && p !== spec.ledgerPath);
  const otherTexts = await Promise.all(otherPaths.map((p) => show(at(p))));
  const overrideApplied = otherPaths.includes(OVERRIDE_LEDGER) ? await show(at(OVERRIDE_APPLIED)) : "";
  const ledger = readGateLedgerText(ledgerText, appliedText, { ledgers: Object.fromEntries(otherPaths.map((p, i) => [p, otherTexts[i]!])), overrideApplied });
  const records = spec.recordsDir ? waveRecords(tree.code === 0 ? lines(tree.stdout) : [], at(spec.recordsDir)) : [];
  const any = ledger.pending.length || ledger.resolutions.length || ledger.applied.length || ledger.override?.pending.length || ledger.others?.some((o) => o.pending.length);
  let gates = any ? gateEntries(ledger, records, await changed(at(spec.ledgerPath), at(spec.appliedPath), ...otherPaths.map(at)), now, rule.lane, spec) : [];
  // #537: under `pr-review`, the heads whose recorded plans name a waiting wave's digest.
  if (spec.headPlansDir && gates.some((g) => waveRule(rule.lane, g.wave).mode === "pr-review")) {
    const dirPath = at(spec.headPlansDir);
    const log = await git([...repo, "log", "--format=", "--name-only", sha, "--", `${dirPath}/`]);
    const paths = [...new Set(log.code === 0 ? lines(log.stdout) : [])].filter((p) => p.startsWith(`${dirPath}/`) && p.endsWith(".json")).slice(0, HEAD_PLANS_READ);
    const texts = await Promise.all(paths.map((p) => showAt(sha, p)));
    const plans = paths.flatMap((path, i) => {
      const parsed = texts[i] === undefined ? undefined : parseHeadPlans(texts[i]!);
      return parsed ? [{ path, plans: parsed }] : [];
    });
    gates = withHeadPlans(gates, plans, rule.lane);
  }
  const lockMap = parseLocks(locksText);
  const lockSource = Object.keys(lockMap).length && spec.locksPath ? await changed(at(spec.locksPath)) : undefined;
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
