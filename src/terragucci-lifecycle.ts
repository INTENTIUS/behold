/**
 * The `chant/lifecycle` lane of a terragucci repo (#505): its apply gates and
 * its root locks, read without a write to the served checkout.
 *
 * terragucci keeps both on the repo's `chant/lifecycle` branch:
 *
 * - `_gates/tf-apply.jsonl`, the gate ledger: a wave's pending fact (the plan
 *   digest it waits on) and each approval, one JSON line each, the lines
 *   chant's `parseGateLedger` reads;
 * - `_gates/tf-apply/applied.jsonl`: the approvals a wave applied under, and
 *   how those applies finished;
 * - `_gates/tf-apply/wave-<k>/<digest>.json`: the report a waiting wave kept
 *   for the digest it asked approval for;
 * - `_locks/tf-apply.json`: the roots a pull request or an apply holds.
 *
 * Formats: terragucci `packages/terragucci/src/apply.ts` (LEDGER_PATH,
 * APPLIED_PATH, approvedPath, parseLedger, parseApplied, parseFinished) and
 * `src/locks.ts` (LOCKS_PATH, parseLocks). The parsers here mirror those, line
 * for line, so behold reads what terragucci reads.
 *
 * How it is read: the branch is fetched from the checkout's `origin` URL into
 * a bare repository behold owns, `<tmpdir>/behold-lifecycle-<hash of the
 * URL>`, with the person's own git and its credentials. The checkout is never
 * fetched into and no ref of it moves. When that fetch fails (offline, no
 * access) the checkout's own `refs/remotes/origin/chant/lifecycle` is read
 * instead, read-only, and the answer says so (`via: "checkout-ref"`). A remote
 * with no such branch is an answer (`found: false`), not an error.
 *
 * Nothing here approves, locks or unlocks: those are terragucci's, at a shell.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { assertScratch } from "./scratch.ts";

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
export const CACHE_PREFIX = "behold-lifecycle-";

// ── terragucci's formats ─────────────────────────────────────────────────

export interface PendingRecord {
  version: 1;
  kind: "pending";
  op: string;
  gate: string;
  timestamp: string;
  expiresAt: string;
  planDigest?: string;
  description?: string;
  runId?: string;
  url?: string;
  commit?: string;
}

export interface ResolutionRecord {
  version: 1;
  kind?: "resolution";
  op: string;
  gate: string;
  resolvedBy: string;
  timestamp: string;
  planDigest?: string;
  seal?: unknown;
  note?: string;
  via?: string;
  pr?: number;
  relayedBy?: string;
}

export interface AppliedRecord {
  version: 1;
  kind: "applied";
  op: string;
  gate: string;
  planDigest: string;
  approvedAt: string;
  approvedBy: string;
  timestamp: string;
  runId?: string;
  commit?: string;
}

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
  pending: PendingRecord[];
  resolutions: ResolutionRecord[];
  applied: AppliedRecord[];
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

/** The lines of `_gates/tf-apply.jsonl`, as chant's `parseGateLedger` reads them. Malformed lines are skipped. */
export function parseLedger(text: string): Pick<GateLedger, "pending" | "resolutions"> {
  const out: Pick<GateLedger, "pending" | "resolutions"> = { pending: [], resolutions: [] };
  for (const line of lines(text)) {
    const r = json(line);
    if (!r) continue;
    if (r.version !== 1 || typeof r.op !== "string" || typeof r.gate !== "string" || typeof r.timestamp !== "string") continue;
    if (r.planDigest !== undefined && typeof r.planDigest !== "string") continue;
    if (r.kind === "pending") {
      if (typeof r.expiresAt === "string") out.pending.push(r as unknown as PendingRecord);
    } else if (typeof r.resolvedBy === "string") {
      out.resolutions.push(r as unknown as ResolutionRecord);
    }
  }
  return out;
}

/** The applied and finished lines of `_gates/tf-apply/applied.jsonl`. Malformed lines are skipped. */
export function parseApplied(text: string): Pick<GateLedger, "applied" | "finished"> {
  const out: Pick<GateLedger, "applied" | "finished"> = { applied: [], finished: [] };
  for (const line of lines(text)) {
    const r = json(line);
    if (!r || r.version !== 1 || typeof r.gate !== "string" || typeof r.planDigest !== "string") continue;
    if (r.kind === "applied" && typeof r.approvedAt === "string") out.applied.push(r as unknown as AppliedRecord);
    else if (r.kind === "finished" && typeof r.applied === "string" && (r.result === "applied" || r.result === "failed")) out.finished.push(r as unknown as FinishedRecord);
  }
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

const DIGEST = /^(?:jcs1-)?sha256:([0-9a-f]{64})$/;
/** chant's samePlanDigest: the `sha256:` and `jcs1-sha256:` spellings of one hex are one digest. */
export function samePlanDigest(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const x = DIGEST.exec(a);
  const y = DIGEST.exec(b);
  return x !== null && y !== null && x[1] === y[1];
}

// ── the answer ───────────────────────────────────────────────────────────

/** The commit of `chant/lifecycle` an entry was read from: the newest one that changed its file, and when it was made. */
export interface LifecycleSource {
  branch: typeof LIFECYCLE_BRANCH;
  commit: string;
  committed: string;
  path: string;
}

export type GateState = "waiting" | "expired" | "approved" | "applied" | "failed";

export interface GateEntry {
  gate: string;
  wave: number;
  /**
   * The ledger's word for where the gate stands, as of `source.commit`:
   * `waiting` (a pending fact, no approval of its digest), `expired` (the
   * pending fact's `expiresAt` passed with no approval), `approved` (an
   * approval of the digest no wave applied under yet), `applied` / `failed`
   * (a wave applied under that approval, and how it finished when recorded).
   */
  state: GateState;
  /** The plan digest the gate is about: the newest pending fact's, else the approval's. */
  digest?: string;
  pending?: { timestamp: string; expiresAt: string; planDigest?: string; commit?: string; runId?: string; url?: string; description?: string };
  approval?: { by: string; at: string; planDigest?: string; signed: boolean; via?: string; pr?: number; note?: string };
  applied?: { at: string; approvedAt: string; approvedBy: string; runId?: string; commit?: string; result?: "applied" | "failed"; finished?: string };
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
  gates: GateEntry[];
  locks: LockEntry[];
  /** One sentence for the page: where this came from, and how old it can be. */
  note: string;
}

const t = (iso: string): number => new Date(iso).getTime();
const newest = <T>(xs: T[], at: (x: T) => string): T | undefined => xs.reduce<T | undefined>((b, x) => (!b || t(at(x)) >= t(at(b)) ? x : b), undefined);

/** Each wave's gate, decided from the ledger the way terragucci's decideGate reads it for the newest pending digest. */
export function gateEntries(ledger: GateLedger, records: { wave: number; digest: string; path: string }[], source: LifecycleSource, now: Date): GateEntry[] {
  const gates = new Set<string>();
  for (const r of [...ledger.pending, ...ledger.resolutions, ...ledger.applied]) if (/^wave-\d+$/.test(r.gate)) gates.add(r.gate);
  const out: GateEntry[] = [];
  for (const gate of gates) {
    const wave = Number(gate.slice("wave-".length));
    const pending = newest(ledger.pending.filter((p) => p.gate === gate), (p) => p.timestamp);
    const since = pending ? t(pending.timestamp) : 0;
    const resolutions = ledger.resolutions.filter((r) => r.gate === gate && t(r.timestamp) >= since);
    const approval = pending ? newest(resolutions.filter((r) => samePlanDigest(r.planDigest, pending.planDigest)), (r) => r.timestamp) : newest(resolutions, (r) => r.timestamp);
    const digest = pending?.planDigest ?? approval?.planDigest;
    const applied = approval
      ? newest(ledger.applied.filter((a) => a.gate === gate && samePlanDigest(a.planDigest, approval.planDigest) && t(a.approvedAt) >= t(approval.timestamp)), (a) => a.timestamp)
      : !pending
        ? newest(ledger.applied.filter((a) => a.gate === gate), (a) => a.timestamp)
        : undefined;
    const finished = applied ? newest(ledger.finished.filter((f) => f.gate === gate && samePlanDigest(f.planDigest, applied.planDigest) && f.applied === applied.timestamp), (f) => f.timestamp) : undefined;
    const state: GateState = applied ? (finished?.result === "failed" ? "failed" : "applied") : approval ? "approved" : pending && t(pending.expiresAt) <= now.getTime() ? "expired" : "waiting";
    out.push({
      gate,
      wave,
      state,
      ...(digest ? { digest } : {}),
      ...(pending
        ? {
            pending: {
              timestamp: pending.timestamp,
              expiresAt: pending.expiresAt,
              ...(pending.planDigest ? { planDigest: pending.planDigest } : {}),
              ...(pending.commit ? { commit: pending.commit } : {}),
              ...(pending.runId ? { runId: pending.runId } : {}),
              ...(pending.url ? { url: pending.url } : {}),
              ...(pending.description ? { description: pending.description } : {}),
            },
          }
        : {}),
      ...(approval
        ? {
            approval: {
              by: approval.resolvedBy,
              at: approval.timestamp,
              ...(approval.planDigest ? { planDigest: approval.planDigest } : {}),
              signed: !!approval.seal,
              ...(approval.via ? { via: approval.via } : {}),
              ...(approval.pr !== undefined ? { pr: approval.pr } : {}),
              ...(approval.note ? { note: approval.note } : {}),
            },
          }
        : {}),
      ...(applied
        ? {
            applied: {
              at: applied.timestamp,
              approvedAt: applied.approvedAt,
              approvedBy: applied.approvedBy,
              ...(applied.runId ? { runId: applied.runId } : {}),
              ...(applied.commit ? { commit: applied.commit } : {}),
              ...(finished ? { result: finished.result, finished: finished.timestamp } : {}),
            },
          }
        : {}),
      records: records.filter((r) => r.wave === wave).map(({ digest: d, path }) => ({ digest: d, path })),
      ...(state === "waiting" ? { command: `npx terragucci approve ${gate}${digest ? ` --plan ${digest}` : ""}` } : {}),
      source,
    });
  }
  return out.sort((a, b) => a.wave - b.wave);
}

/** `_gates/tf-apply/wave-<k>/<digest>.json` paths, as `git ls-tree` names them, back to their wave and digest. */
export function waveRecords(paths: string[]): { wave: number; digest: string; path: string }[] {
  const out: { wave: number; digest: string; path: string }[] = [];
  for (const path of paths) {
    const m = /^_gates\/tf-apply\/wave-(\d+)\/([^/]+)\.json$/.exec(path);
    if (m) out.push({ wave: Number(m[1]), digest: m[2]!.replace("_", ":"), path });
  }
  return out;
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
}

/** The origin URL as git would fetch it: a relative local path is resolved against the checkout. */
function fetchable(url: string, checkout: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/]+@[^:/]+:/.test(url) || isAbsolute(url)) return url;
  return resolve(checkout, url);
}

/** Fetch the branch into behold's cache. `found: false` when the remote has no such branch. */
async function fetchIntoCache(git: GitRun, origin: string, cache: string): Promise<{ ok: true; found: boolean } | { ok: false; error: string }> {
  assertScratch(basename(cache));
  return serially(cache, async () => {
    if (!existsSync(join(cache, "HEAD"))) {
      if (existsSync(cache) && readdirSync(cache).length > 0) return { ok: false as const, error: `${cache} exists and is not behold's lifecycle cache; behold leaves it alone` };
      mkdirSync(cache, { recursive: true });
      const init = await git(["init", "--bare", "-q", cache]);
      if (init.code !== 0) return { ok: false as const, error: `could not make the cache ${cache}: ${init.stderr.trim()}` };
    }
    const f = await git(["--git-dir", cache, "fetch", "-q", "--no-tags", origin, `+refs/heads/${LIFECYCLE_BRANCH}:${CACHE_REF}`]);
    if (f.code === 0) return { ok: true as const, found: true };
    if (/couldn't find remote ref|could not find remote ref/i.test(f.stderr)) return { ok: true as const, found: false };
    return { ok: false as const, error: redact(f.stderr.trim() || `git fetch exited ${f.code}`) };
  });
}

/** Read the lane at `ref` in `repo` (git args that name the repository). */
async function readAt(git: GitRun, repo: string[], ref: string, now: Date): Promise<{ commit: { sha: string; committed: string }; gates: GateEntry[]; locks: LockEntry[] } | undefined> {
  const tip = await git([...repo, "log", "-1", "--format=%H%x00%cI", ref, "--"]);
  if (tip.code !== 0 || !tip.stdout.trim()) return undefined;
  const [sha, committed] = tip.stdout.trim().split("\0") as [string, string];
  const show = async (path: string): Promise<string> => {
    const r = await git([...repo, "show", `${sha}:${path}`]);
    return r.code === 0 ? r.stdout : "";
  };
  const changed = async (...paths: string[]): Promise<LifecycleSource> => {
    const r = await git([...repo, "log", "-1", "--format=%H%x00%cI", sha, "--", ...paths]);
    const [c, at] = r.code === 0 && r.stdout.trim() ? (r.stdout.trim().split("\0") as [string, string]) : [sha, committed];
    return { branch: LIFECYCLE_BRANCH, commit: c, committed: at, path: paths.join(" ") };
  };
  const [ledgerText, appliedText, locksText, tree] = await Promise.all([
    show(LEDGER_PATH),
    show(APPLIED_PATH),
    show(LOCKS_PATH),
    git([...repo, "ls-tree", "-r", "--name-only", sha, "--", `${WAVE_RECORDS_DIR}/`]),
  ]);
  const ledger: GateLedger = { ...parseLedger(ledgerText), ...parseApplied(appliedText) };
  const records = waveRecords(tree.code === 0 ? lines(tree.stdout) : []);
  const gates = ledger.pending.length || ledger.resolutions.length || ledger.applied.length ? gateEntries(ledger, records, await changed(LEDGER_PATH, APPLIED_PATH), now) : [];
  const lockMap = parseLocks(locksText);
  const lockSource = Object.keys(lockMap).length ? await changed(LOCKS_PATH) : undefined;
  const locks = Object.entries(lockMap)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([root, l]) => ({ root, ...l, source: lockSource! }));
  return { commit: { sha, committed }, gates, locks };
}

/**
 * Read `chant/lifecycle` for the checkout at `checkout`: fetched from its
 * origin into behold's cache, else the checkout's remote-tracking ref,
 * read-only. Never throws for a git failure; the answer says what happened.
 */
export async function readLifecycle(checkout: string, opts: LifecycleOptions = {}): Promise<LifecycleAnswer> {
  const git = opts.git ?? realGit;
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
      const lane = await readAt(git, ["--git-dir", cache], CACHE_REF, now);
      if (lane) return { ...base, found: true, via: "fetch", origin, fetch: { ok: true }, ...lane, note: `${LIFECYCLE_BRANCH} as fetched from ${origin} at ${base.read.at}.` };
      fetchError = `fetched ${LIFECYCLE_BRANCH}, but behold's cache could not read it`;
    } else {
      fetchError = f.error;
    }
  }

  // The fetch failed: the checkout's own copy, as old as its last fetch, read-only.
  const lane = await readAt(git, ["-C", checkout], CHECKOUT_REF, now);
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
