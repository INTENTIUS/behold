import { AsyncLocalStorage } from "node:async_hooks";
import { availableParallelism } from "node:os";

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

  read(key: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let job = this.pending.get(key);
    if (job?.controller.signal.aborted) { this.pending.delete(key); job = undefined; }
    if (!job) {
      if (this.active >= this.width() && this.queue.length >= this.queueLimit) {
        return Promise.reject(new Error("Chant read queue is full; retry after current reads finish"));
      }
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
      job = { key, run, promise, resolve, reject, controller: new AbortController(), users: 0, started: false };
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

  private drain(): void {
    while (this.active < this.width() && this.queue.length) {
      const job = this.queue.shift()!;
      job.started = true;
      this.active++;
      const timeout = this.timeout();
      const timer = setTimeout(() => job.controller.abort(new Error(`Chant read exceeded ${timeout}ms`)), timeout);
      const settle = (): void => {
        clearTimeout(timer);
        if (this.pending.get(job.key) === job) this.pending.delete(job.key);
        this.active--;
        this.drain();
      };
      // Defer invocation so even a synchronous throw releases the slot.
      Promise.resolve().then(() => job.run(job.controller.signal)).then(
        (value) => { settle(); job.resolve(value); },
        (error) => { settle(); job.reject(error); },
      );
    }
  }
}
