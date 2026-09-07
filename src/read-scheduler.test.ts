import { describe, expect, it } from "vitest";
import { ReadScheduler, readConcurrency } from "./read-scheduler.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("shared Chant read budget", () => {
  it("caps distinct HTTP/poll/capture reads together and shares matching work only while pending", async () => {
    const pool = new ReadScheduler<number>(() => 2);
    const gates = Array.from({ length: 5 }, () => deferred<number>());
    const starts: number[] = [];
    let active = 0, peak = 0;
    const read = (i: number) => pool.read(String(i), async () => {
      starts.push(i); peak = Math.max(peak, ++active);
      try { return await gates[i].promise; } finally { active--; }
    });
    const results = [read(0), read(1), read(2), read(3), read(4), read(0), read(2)];
    await Promise.resolve();
    expect(starts).toEqual([0, 1]);
    gates.forEach((gate, i) => gate.resolve(i));
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4, 0, 2]);
    expect(starts).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(await pool.read("0", async () => 99)).toBe(99);
  });

  it("one disconnected caller does not cancel another subscriber", async () => {
    const pool = new ReadScheduler<number>(() => 1);
    const gate = deferred<number>();
    const caller = new AbortController();
    let worker!: AbortSignal;
    const first = pool.read("same", async (signal) => { worker = signal; return gate.promise; }, caller.signal);
    const second = pool.read("same", async () => { throw new Error("duplicate spawn"); });
    await Promise.resolve();
    caller.abort(new Error("gone"));
    await expect(first).rejects.toThrow("gone");
    expect(worker.aborted).toBe(false);
    gate.resolve(7);
    expect(await second).toBe(7);
  });

  it("canceled queued work never starts; canceled running work holds its slot until cleanup finishes", async () => {
    const pool = new ReadScheduler<number>(() => 1);
    const cleanup = deferred<number>();
    const running = new AbortController(), queued = new AbortController();
    let worker!: AbortSignal, queuedStarted = false, replacementStarted = false;
    const first = pool.read("first", async (signal) => { worker = signal; return cleanup.promise; }, running.signal);
    const second = pool.read("queued", async () => { queuedStarted = true; return 2; }, queued.signal);
    await Promise.resolve();
    queued.abort(new Error("queued gone")); running.abort(new Error("running gone"));
    await expect(first).rejects.toThrow("running gone");
    await expect(second).rejects.toThrow("queued gone");
    expect(worker.aborted).toBe(true);
    const replacement = pool.read("first", async () => { replacementStarted = true; return 3; });
    await Promise.resolve();
    expect(replacementStarted).toBe(false);
    cleanup.resolve(1);
    expect(await replacement).toBe(3);
    expect(queuedStarted).toBe(false);
  });

  it("a failed read releases the slot and is not retained", async () => {
    const pool = new ReadScheduler<number>(() => 1);
    await expect(pool.read("failed", () => { throw new Error("failure"); })).rejects.toThrow("failure");
    expect(await pool.read("failed", async () => 2)).toBe(2);
  });

  it("bounds queued distinct work but still accepts subscribers to existing work", async () => {
    const pool = new ReadScheduler<number>(() => 1, () => 1000, 1);
    const gate = deferred<number>();
    const first = pool.read("one", () => gate.promise);
    const second = pool.read("two", async () => 2);
    const shared = pool.read("two", async () => 999);
    await expect(pool.read("three", async () => 3)).rejects.toThrow("queue is full");
    gate.resolve(1);
    expect(await Promise.all([first, second, shared])).toEqual([1, 2, 2]);
  });

  it("a deadline cancels the worker and allows the next read after it stops", async () => {
    const pool = new ReadScheduler<number>(() => 1, () => 10);
    const first = pool.read("slow", (signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const next = pool.read("next", async () => 2);
    await expect(first).rejects.toThrow("exceeded 10ms");
    expect(await next).toBe(2);
  });

  it("uses a conservative default and rejects malformed concurrency settings", () => {
    expect(readConcurrency({})).toBeLessThanOrEqual(2);
    expect(readConcurrency({ BEHOLD_ESTATE_CONCURRENCY: "3" })).toBe(3);
    for (const value of ["0", "-1", "NaN", "2garbage", "1.5"]) {
      expect(readConcurrency({ BEHOLD_ESTATE_CONCURRENCY: value })).toBe(readConcurrency({}));
    }
  });
});
