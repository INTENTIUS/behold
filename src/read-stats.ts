/**
 * What a read cost (#420, M1 of #419).
 *
 * #367 bounded duplicate work and said plainly that it had not touched the
 * number: an 11-member Kubernetes estate took 153s to observe, then 147s on a
 * repeated read with the source cache warmed. That number is still one opaque
 * aggregate. Which member, which phase, how much was chant evaluating a
 * member's TypeScript and how much was the substrate answering — none of it is
 * observable from inside behold, so nobody can act on it and nobody can tell
 * upstream which share is theirs.
 *
 * This module is the ledger. `ReadScheduler` (src/read-scheduler.ts) is the one
 * chokepoint every scheduled chant read already passes through, so the timing
 * hangs off something that exists rather than needing a second path through the
 * read loop.
 *
 * Three things it deliberately is not:
 *
 *  - **Not a cache.** Nothing here is ever read back to answer a request. #367
 *    settled that a completed live result is never cached and this does not
 *    reopen it; a sample is a record of what a read cost, not the read.
 *  - **Not part of a read's identity.** The label travels beside the scheduler's
 *    key and never into it. Two reads that share in flight share because their
 *    key matched; what they are called cannot change that, which is why
 *    {@link ReadLabel} is passed separately from the key rather than folded in.
 *  - **Not a log.** Counters and one sample per member-and-phase, bounded. The
 *    shape `memberIrCacheStats()` already takes (src/member-ir.ts) — cheap
 *    enough to leave on permanently, because a diagnostic that has to be
 *    switched on is one nobody has on when they need it.
 */

/** How a read ended. `cancelled` is a subscriber leaving, `deadline` is the
 * scheduler's own timeout firing — different problems, so never one bucket. */
export type ReadOutcome = "completed" | "failed" | "cancelled" | "deadline";

/** What a read was for, in words. Never part of the scheduler's identity key. */
export interface ReadLabel {
  /** The member root this read was for, absolute. */
  dir: string;
  /** The read as a person would name it: `graph`, `graph --live`, `components status`. */
  what: string;
  /**
   * Does this read reach past the member's own source?
   *
   * The line is `chant graph` with neither `--live` nor `--overlay` on one side
   * and everything else on the other. src/estate.ts already names why the false
   * side is not free: a source read is "a whole Node process doing a full
   * TypeScript evaluation of that member's source — seconds of CPU each, before
   * the live half even talks to a cluster". Splitting the two is what lets #424
   * tell chant which half is which instead of handing it one number.
   */
  live: boolean;
}

/** One finished read. Durations are whole milliseconds. */
export interface ReadSample extends ReadLabel {
  /** Enqueued until a slot opened. Pure contention: the budget, not the work. */
  queuedMs: number;
  /** Started until it stopped. The work, plus whatever the substrate took. */
  runningMs: number;
  outcome: ReadOutcome;
}

/** Totals for one side of the source/live split. */
export interface PhaseTotals {
  runs: number;
  queuedMs: number;
  runningMs: number;
}

export interface ReadStats {
  /** Reads actually run — a slot taken and a process spawned. */
  runs: number;
  /** Subscribers handed a read that was already in flight. Work not done. */
  shared: number;
  /** Reads refused because the queue was full. */
  refused: number;
  source: PhaseTotals;
  live: PhaseTotals;
  byOutcome: Record<ReadOutcome, number>;
  /** The last read of each member and phase, most recent last. */
  recent: ReadSample[];
}

/** How many member-and-phase pairs keep their last sample. Beyond this the
 * oldest is dropped: an estate has members, not an unbounded stream of them. */
export const RECENT_LIMIT = 128;

const phase = (): PhaseTotals => ({ runs: 0, queuedMs: 0, runningMs: 0 });
const outcomes = (): Record<ReadOutcome, number> => ({ completed: 0, failed: 0, cancelled: 0, deadline: 0 });

let runs = 0;
let shared = 0;
let refused = 0;
let source = phase();
let live = phase();
let byOutcome = outcomes();
// Insertion-ordered Map: re-recording a pair re-inserts, so the oldest key is
// always the least recently read one.
let recent = new Map<string, ReadSample>();

/** A subscriber joined a read already in flight. No slot, no process, no time. */
export function recordShared(): void {
  shared++;
}

/** A read was turned away because the queue was full. */
export function recordRefused(): void {
  refused++;
}

/** One read finished, however it finished. */
export function recordRead(sample: ReadSample): void {
  runs++;
  const totals = sample.live ? live : source;
  totals.runs++;
  totals.queuedMs += sample.queuedMs;
  totals.runningMs += sample.runningMs;
  byOutcome[sample.outcome]++;
  const key = `${sample.dir}\0${sample.what}`;
  recent.delete(key);
  recent.set(key, sample);
  if (recent.size > RECENT_LIMIT) recent.delete(recent.keys().next().value!);
}

/** Everything the ledger holds. Cheap: counters and at most {@link RECENT_LIMIT} samples. */
export function readStats(): ReadStats {
  return {
    runs,
    shared,
    refused,
    source: { ...source },
    live: { ...live },
    byOutcome: { ...byOutcome },
    recent: [...recent.values()],
  };
}

/** Drop everything. For tests, and for a server that wants a fresh window. */
export function resetReadStats(): void {
  runs = 0;
  shared = 0;
  refused = 0;
  source = phase();
  live = phase();
  byOutcome = outcomes();
  recent = new Map();
}

/**
 * Name a read from its argv, and say which side of the split it sits on.
 *
 * The phases are not invented here: `isScheduledRead` (src/chant.ts) already
 * enumerates exactly which argv shapes reach this scheduler, and this is the
 * same list read for its words. An argv that is not one of them still gets a
 * label rather than an error — the allowlist can grow, and a read that arrives
 * unnamed should show up in the ledger as itself rather than vanish from it.
 */
export function labelRead(args: readonly string[], dir: string): ReadLabel {
  const verb = args[0] ?? "";
  const head = verb === "graph" ? "graph" : [verb, args[1]].filter(Boolean).join(" ");
  const reaches = args.includes("--live") || args.includes("--overlay");
  const what = verb === "graph" && reaches ? `graph ${args.includes("--overlay") ? "--overlay" : "--live"}` : head;
  return { dir, what, live: verb === "graph" ? reaches : true };
}
