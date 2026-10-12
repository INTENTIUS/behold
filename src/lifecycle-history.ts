/**
 * Gate history from `chant/lifecycle`, for any product (#522).
 *
 * chant's `lifecycle/gate-audit` turns gate-ledger lines into audit entries:
 * requested, approved, override, revoked, each with the line it came from and
 * the commit that added (or removed) it. behold runs `git log -p` over
 * `_gates/<op>.jsonl` in the same bare cache #505 fetches `chant/lifecycle`
 * into (`src/terragucci-lifecycle.ts`), hands each file's log to chant's
 * `gateLedgerLinesFromLog` and the lines to `deriveGateAudit`. Nothing here
 * parses a ledger line itself, and nothing writes: the checkout is never
 * fetched into, and a failed fetch reads the checkout's own
 * `refs/remotes/origin/chant/lifecycle`, read-only, and says so.
 *
 * Every ledger file directly under `_gates/` is read, so a SQL Yodeler repo
 * (`override-<rule>` gates, per-environment ops) gets its history as a
 * terragucci one (`tf-apply`, `policy-override`) does. Applies come from a
 * product's own records, which the ledger does not hold, so `applied` and
 * `override-spent` entries appear only where a product's audit record has
 * them (terragucci's `audit.jsonl`, the timeline lane).
 */
import type { Hono } from "hono";
import { deriveGateAudit, gateLedgerLinesFromLog, type GateAuditEntry, type GateAuditGap } from "@intentius/chant/lifecycle/gate-audit";
import {
  CACHE_REF,
  CHECKOUT_REF,
  LIFECYCLE_BRANCH,
  cacheDir,
  fetchable,
  fetchIntoCache,
  realGit,
  redact,
  type GitRun,
  type LifecycleOptions,
  type LifecycleVia,
} from "./terragucci-lifecycle.ts";

/** Where gate ledgers live on the branch: `_gates/<op>.jsonl`. Deeper files (`_gates/tf-apply/applied.jsonl`) are a product's own. */
export const GATES_DIR = "_gates";
const LEDGER_FILE = /^_gates\/([^/]+)\.jsonl$/;

export const HISTORY_LIMIT = 200;
export const HISTORY_MAX = 1000;
/** The same 30 s as the lifecycle lane's read (#505). */
export const HISTORY_TTL_MS = 30_000;

/** The `--format` chant's `gateLedgerLinesFromLog` reads: commit, author, date, email. */
export const LOG_FORMAT = "--format=%x1e%H%x1f%an%x1f%aI%x1f%ae";

/** One file's history: its op, its path, and `git log -p` over it, oldest commit first. */
export interface LedgerLog {
  op: string;
  path: string;
  log: string;
}

/** One entry for the page: chant's entry, with the wave its gate names and the source said plainly. */
export interface HistoryEntry {
  id: string;
  kind: GateAuditEntry["kind"];
  at: string;
  op?: string;
  gate: string;
  /** `wave-<k>` gates (terragucci), or a `wave` the line carries. */
  wave?: number;
  digest?: string;
  /** Who approved, requested, overrode, or (for a revocation) removed the line. */
  actor?: string;
  seal?: GateAuditEntry["seal"];
  note?: string;
  rules?: string[];
  subject?: GateAuditEntry["subject"];
  /** The line in the ledger: its file, line number when known, the commit that added or removed it, and that commit's author. */
  source: { path: string; line?: number; commit?: string; committer?: string; committed?: string; change: GateAuditEntry["source"]["change"] };
  /** chant's whole entry, for anything the page or an agent wants beyond the above. */
  audit: GateAuditEntry;
}

export interface HistoryAnswer {
  branch: typeof LIFECYCLE_BRANCH;
  /** Where these entries came from, for the label beside the audit record's. */
  source: "ledger";
  found: boolean;
  via: LifecycleVia;
  origin?: string;
  fetch: { ok: boolean; error?: string };
  commit?: { sha: string; committed: string };
  read: { at: string };
  /** The ledger files read, `_gates/<op>.jsonl`. */
  ledgers: string[];
  op?: string;
  gate?: string;
  total: number;
  limit: number;
  /** Newest first. */
  entries: HistoryEntry[];
  /** chant's gaps: a resolution with no request, an unsealed approval, a line that is not a gate record. */
  gaps: GateAuditGap[];
  note: string;
}

/** A gate's wave, from `wave-<k>` or a numeric `wave` on the line. */
function waveOf(e: GateAuditEntry): number | undefined {
  const m = /^wave-(\d+)$/.exec(e.gate);
  if (m) return Number(m[1]);
  const w = e.detail.wave;
  return typeof w === "number" && Number.isInteger(w) ? w : undefined;
}

export function historyEntry(e: GateAuditEntry): HistoryEntry {
  const wave = waveOf(e);
  const author = e.source.author;
  return {
    id: e.id,
    kind: e.kind,
    at: e.at,
    ...(e.op ? { op: e.op } : {}),
    gate: e.gate,
    ...(wave !== undefined ? { wave } : {}),
    ...(e.digest ? { digest: e.digest } : {}),
    ...(e.by ? { actor: e.by } : {}),
    ...(e.seal ? { seal: e.seal } : {}),
    ...(e.note ? { note: e.note } : {}),
    ...(e.rules ? { rules: e.rules } : {}),
    ...(e.subject ? { subject: e.subject } : {}),
    source: {
      path: e.source.path,
      ...(e.source.line !== undefined ? { line: e.source.line } : {}),
      ...(e.source.commit ? { commit: e.source.commit } : {}),
      ...(author?.by ? { committer: author.by } : {}),
      ...(author?.at ? { committed: author.at } : {}),
      change: e.source.change,
    },
    audit: e,
  };
}

/** The entries the logs add up to, through chant, newest first, of `op` and `gate` when asked. */
export function historyFromLogs(logs: readonly LedgerLog[], q: { op?: string; gate?: string } = {}): { entries: HistoryEntry[]; gaps: GateAuditGap[] } {
  const ledgers = logs.filter((l) => !q.op || l.op === q.op).map((l) => ({ op: l.op, path: l.path, lines: gateLedgerLinesFromLog(l.log) }));
  const { entries, gaps } = deriveGateAudit({ ledgers });
  const kept = entries.filter((e) => !q.gate || e.gate === q.gate).map(historyEntry);
  kept.reverse(); // chant sorts oldest first
  return { entries: kept, gaps: q.gate ? gaps.filter((g) => !g.gate || g.gate === q.gate) : gaps };
}

/** Every ledger file the branch ever held at `ref`, and `git log -p` over each, oldest commit first. */
export async function ledgerLogs(git: GitRun, repo: string[], ref: string): Promise<LedgerLog[] | undefined> {
  const names = await git([...repo, "log", "--format=", "--name-only", "--no-renames", ref, "--", `${GATES_DIR}/`]);
  if (names.code !== 0) return undefined;
  const paths = [...new Set(names.stdout.split("\n").map((l) => l.trim()).filter((p) => LEDGER_FILE.test(p)))].sort();
  const out: LedgerLog[] = [];
  for (const path of paths) {
    const r = await git([...repo, "log", "-p", "--reverse", "--unified=0", "--no-renames", "--no-color", LOG_FORMAT, ref, "--", path]);
    if (r.code !== 0) continue;
    out.push({ op: LEDGER_FILE.exec(path)![1]!, path, log: r.stdout });
  }
  return out;
}

async function tipOf(git: GitRun, repo: string[], ref: string): Promise<{ sha: string; committed: string } | undefined> {
  const tip = await git([...repo, "log", "-1", "--format=%H%x00%cI", ref, "--"]);
  if (tip.code !== 0 || !tip.stdout.trim()) return undefined;
  const [sha, committed] = tip.stdout.trim().split("\0") as [string, string];
  return { sha, committed };
}

/** What was read, before a filter: the logs, and where they came from. */
export interface HistoryRead {
  found: boolean;
  via: LifecycleVia;
  origin?: string;
  fetch: { ok: boolean; error?: string };
  commit?: { sha: string; committed: string };
  read: { at: string };
  logs: LedgerLog[];
  note: string;
}

/**
 * Read every gate ledger's history on `chant/lifecycle` for the checkout at
 * `checkout`: fetched into behold's cache (#505's), else the checkout's
 * remote-tracking ref, read-only. Never throws for a git failure.
 */
export async function readHistory(checkout: string, opts: LifecycleOptions = {}): Promise<HistoryRead> {
  const git = opts.git ?? realGit;
  const at = (opts.now ?? (() => new Date()))().toISOString();
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
      return { found: false, via: "fetch", origin, fetch: { ok: true }, read: { at }, logs: [], note: `${origin} has no ${LIFECYCLE_BRANCH} branch, so no gate has a history yet.` };
    }
    if (f.ok) {
      const repo = ["--git-dir", cache];
      const commit = await tipOf(git, repo, CACHE_REF);
      const logs = commit ? await ledgerLogs(git, repo, CACHE_REF) : undefined;
      if (commit && logs) return { found: true, via: "fetch", origin, fetch: { ok: true }, commit, read: { at }, logs, note: `the gate ledgers' history on ${LIFECYCLE_BRANCH}, as fetched from ${origin} at ${at}.` };
      fetchError = `fetched ${LIFECYCLE_BRANCH}, but behold's cache could not read it`;
    } else {
      fetchError = f.error;
    }
  }
  const repo = ["-C", checkout];
  const commit = await tipOf(git, repo, CHECKOUT_REF);
  const logs = commit ? await ledgerLogs(git, repo, CHECKOUT_REF) : undefined;
  if (commit && logs) {
    return {
      found: true,
      via: "checkout-ref",
      ...(origin ? { origin } : {}),
      fetch: { ok: false, error: fetchError },
      commit,
      read: { at },
      logs,
      note: `behold could not fetch ${LIFECYCLE_BRANCH} (${fetchError}), so this history is the checkout's ${CHECKOUT_REF}, as of its last git fetch; its tip was committed ${commit.committed}.`,
    };
  }
  return {
    found: false,
    via: "none",
    ...(origin ? { origin } : {}),
    fetch: { ok: false, error: fetchError },
    read: { at },
    logs: [],
    note: `behold could not fetch ${LIFECYCLE_BRANCH} (${fetchError}) and the checkout has no ${CHECKOUT_REF}, so the gate history is unknown.`,
  };
}

/** The answer for one request. */
export function historyAnswer(r: HistoryRead, q: { op?: string; gate?: string; limit?: number } = {}): HistoryAnswer {
  const limit = q.limit ?? HISTORY_LIMIT;
  const { entries, gaps } = historyFromLogs(r.logs, q);
  return {
    branch: LIFECYCLE_BRANCH,
    source: "ledger",
    found: r.found,
    via: r.via,
    ...(r.origin ? { origin: r.origin } : {}),
    fetch: r.fetch,
    ...(r.commit ? { commit: r.commit } : {}),
    read: r.read,
    ledgers: r.logs.map((l) => l.path),
    ...(q.op ? { op: q.op } : {}),
    ...(q.gate ? { gate: q.gate } : {}),
    total: entries.length,
    limit,
    entries: entries.slice(0, limit),
    gaps,
    note: r.note,
  };
}

export interface HistoryRouteOptions extends LifecycleOptions {
  /** Injected by a test instead of readHistory. */
  readHistory?: (checkout: string) => Promise<HistoryRead>;
}

/** `GET /api/lifecycle/history?op=<op>&gate=<gate>&limit=<n>`. `base()` names the checkout per request. Read-only, cached 30 s, `?fresh=1` skips it. */
export function lifecycleHistoryRoute(app: Hono, base: () => string, opts: HistoryRouteOptions = {}): void {
  let cached: { at: number; base: string; read: Promise<HistoryRead> } | undefined;
  app.get("/api/lifecycle/history", async (c) => {
    const q = new URL(c.req.url).searchParams;
    const rawLimit = q.get("limit");
    let limit: number | undefined;
    if (rawLimit !== null) {
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_MAX) {
        return c.json({ error: `limit must be a whole number from 1 to ${HISTORY_MAX}, not ${JSON.stringify(rawLimit)}`, code: "lifecycle-history" }, 400);
      }
    }
    const b = base();
    const now = Date.now();
    if (q.get("fresh") === "1" || !cached || cached.base !== b || now - cached.at >= HISTORY_TTL_MS) {
      const p = opts.readHistory ? opts.readHistory(b) : readHistory(b, opts);
      cached = { at: now, base: b, read: p };
      p.catch(() => (cached = undefined));
    }
    const r = await cached!.read;
    const op = q.get("op") || undefined;
    const gate = q.get("gate") || undefined;
    return c.json(historyAnswer(r, { ...(op ? { op } : {}), ...(gate ? { gate } : {}), ...(limit ? { limit } : {}) }));
  });
}
