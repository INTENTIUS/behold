import { AsyncLocalStorage } from "node:async_hooks";
import { availableParallelism } from "node:os";
import { recordRead, recordRefused, recordShared, type ReadLabel, type ReadOutcome } from "./read-stats.ts";

// Request-local cancellation never becomes part of a shared read's identity.
const signals = new AsyncLocalStorage<AbortSignal>();
export const withReadSignal = <T>(signal: AbortSignal, fn: () => T): T => signals.run(signal, fn);
export const currentReadSignal = (): AbortSignal | undefined => signals.getStore();
let generation = 0;
export const invalidateReadGeneration = (): void => { generation++; };
export const readGeneration = (): number => generation;

/** The existing estate knob now caps ALL simultaneous Chant reads in a process. */
export function readConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.BEHOLD_ESTATE_CONCURRENCY);
  return Number.isInteger(override) && override > 0 ? override : Math.min(2, availableParallelism());
}

export function readTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.BEHOLD_READ_TIMEOUT_MS);
  return Number.isInteger(override) && override > 0 ? override : 180_000;
}

interface Job<T> {
  key: string;
  run: (signal: AbortSignal) => Promise<T>;
  controller: AbortController;
  promise: Promise<T>;
  resolve: (result: T) => void;
  reject: (error: unknown) => void;
  users: number;
  started: boolean;
  /** What this read is, for the ledger (#420). Never part of `key` — see
   * src/read-stats.ts on why naming a read cannot change who it shares with.
   * Undefined when the caller named nothing, and then nothing is recorded. */
  label?: ReadLabel;
  /** When it was enqueued, and when a slot opened. */
  enqueuedAt: number;
  startedAt?: number;
  /** Set by the deadline timer, so an expiry is never filed as a cancellation. */
  expired: boolean;
}

/** FIFO process-wide budget with in-flight sharing, never a completed-result cache.
 * Each subscriber can leave independently. A slot stays occupied until the task
 * has actually stopped, even when all subscribers have gone or its deadline hit. */
export class ReadScheduler<T> {
  private active = 0;
  private pending = new Map<string, Job<T>>();
  private queue: Job<T>[] = [];

  constructor(
    private readonly width = readConcurrency,
    private readonly timeout = readTimeoutMs,
    private readonly queueLimit = 64,
  ) {}

  read(key: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, label?: ReadLabel): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let job = this.pending.get(key);
    if (job?.controller.signal.aborted) { this.pending.delete(key); job = undefined; }
    if (job) {
      // Handed a read already in flight: no slot, no process, no time (#420).
      recordShared();
    } else {
      if (this.active >= this.width() && this.queue.length >= this.queueLimit) {
        recordRefused();
        return Promise.reject(new Error("Chant read queue is full; retry after current reads finish"));
      }
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
      job = {
        key, run, promise, resolve, reject, controller: new AbortController(),
        users: 0, started: false, label, enqueuedAt: Date.now(), expired: false,
      };
      this.pending.set(key, job);
      this.queue.push(job);
    }
    const shared = job;
    shared.users++;
    const result = new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (error: unknown, value?: T, failed = false): void => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", abort);
        shared.users--;
        if (failed) reject(error); else resolve(value as T);
      };
      const abort = (): void => {
        finish(signal?.reason, undefined, true);
        if (shared.users === 0) {
          if (this.pending.get(key) === shared) this.pending.delete(key);
          shared.controller.abort(signal?.reason);
          if (!shared.started) {
            this.queue = this.queue.filter((item) => item !== shared);
            shared.reject(signal?.reason);
          }
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      shared.promise.then((value) => finish(undefined, value), (error) => finish(error, undefined, true));
    });
    this.drain();
    return result;
  }

  /** File what this read cost (#420). A job nobody named records nothing: the
   * scheduler is generic, and only its caller knows what an argv is called. */
  private record(job: Job<T>, outcome: ReadOutcome, now: number = Date.now()): void {
    if (!job.label || job.startedAt === undefined) return;
    recordRead({
      ...job.label,
      queuedMs: job.startedAt - job.enqueuedAt,
      runningMs: now - job.startedAt,
      outcome,
    });
  }

  private drain(): void {
    while (this.active < this.width() && this.queue.length) {
      const job = this.queue.shift()!;
      job.started = true;
      job.startedAt = Date.now();
      this.active++;
      const timeout = this.timeout();
      const timer = setTimeout(() => {
        job.expired = true;
        job.controller.abort(new Error(`Chant read exceeded ${timeout}ms`));
      }, timeout);
      const settle = (outcome: ReadOutcome): void => {
        clearTimeout(timer);
        if (this.pending.get(job.key) === job) this.pending.delete(job.key);
        this.active--;
        this.record(job, outcome);
        this.drain();
      };
      // Defer invocation so even a synchronous throw releases the slot.
      Promise.resolve().then(() => job.run(job.controller.signal)).then(
        (value) => { settle("completed"); job.resolve(value); },
        (error) => {
          // An expiry is the scheduler giving up; an abort with subscribers gone
          // is a caller leaving. Same rejection, different problems (#420).
          settle(job.expired ? "deadline" : job.controller.signal.aborted ? "cancelled" : "failed");
          job.reject(error);
        },
      );
    }
  }
}
