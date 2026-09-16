import { beforeEach, describe, expect, it } from "vitest";
import { ReadScheduler } from "./read-scheduler.ts";
import { RECENT_LIMIT, labelRead, readStats, recordRead, resetReadStats } from "./read-stats.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const sample = (over: Partial<Parameters<typeof recordRead>[0]> = {}) => ({
  dir: "/e/monolith", what: "graph", live: false, queuedMs: 1, runningMs: 10, outcome: "completed" as const, ...over,
});

beforeEach(resetReadStats);

describe("labelRead — naming a read from its argv (#420)", () => {
  it("splits a source graph from one that reaches a substrate", () => {
    expect(labelRead(["graph", "src", "--format", "json"], "/e/a")).toEqual({ dir: "/e/a", what: "graph", live: false });
    expect(labelRead(["graph", "src", "--live", "--env", "prod"], "/e/a")).toEqual({ dir: "/e/a", what: "graph --live", live: true });
    expect(labelRead(["graph", "src", "--live", "--overlay"], "/e/a")).toEqual({ dir: "/e/a", what: "graph --overlay", live: true });
  });

  it("names the two-word reads isScheduledRead allows, and calls all of them live", () => {
    // Everything that is not a bare `chant graph` reaches past the member's own
    // source, which is the whole of the split #424 sends upstream.
    expect(labelRead(["components", "status"], "/e/a")).toEqual({ dir: "/e/a", what: "components status", live: true });
    expect(labelRead(["lifecycle", "diff", "prod"], "/e/a")).toMatchObject({ what: "lifecycle diff", live: true });
    expect(labelRead(["helm", "renders"], "/e/a")).toMatchObject({ what: "helm renders", live: true });
    expect(labelRead(["operator", "status"], "/e/a")).toMatchObject({ what: "operator status", live: true });
  });

  it("labels an argv the allowlist does not know rather than dropping it", () => {
    // The allowlist can grow; a read that arrives unnamed should appear in the
    // ledger as itself, not vanish from it.
    expect(labelRead(["future", "verb"], "/e/a")).toEqual({ dir: "/e/a", what: "future verb", live: true });
    expect(labelRead([], "/e/a")).toEqual({ dir: "/e/a", what: "", live: true });
  });
});

describe("the ledger (#420)", () => {
  it("totals the two phases apart", () => {
    recordRead(sample({ runningMs: 10 }));
    recordRead(sample({ what: "graph --live", live: true, queuedMs: 5, runningMs: 100 }));
    recordRead(sample({ what: "components status", live: true, queuedMs: 2, runningMs: 30 }));
    const s = readStats();
    expect(s.runs).toBe(3);
    expect(s.source).toEqual({ runs: 1, queuedMs: 1, runningMs: 10 });
    expect(s.live).toEqual({ runs: 2, queuedMs: 7, runningMs: 130 });
  });

  it("keeps the last read of each member and phase, not a stream of them", () => {
    recordRead(sample({ runningMs: 10 }));
    recordRead(sample({ runningMs: 20 }));
    recordRead(sample({ dir: "/e/team-a", runningMs: 30 }));
    const s = readStats();
    expect(s.runs).toBe(3);
    expect(s.recent).toHaveLength(2);
    expect(s.recent.map((r) => [r.dir, r.runningMs])).toEqual([["/e/monolith", 20], ["/e/team-a", 30]]);
  });

  it("drops the least recently read pair past the limit", () => {
    for (let i = 0; i <= RECENT_LIMIT; i++) recordRead(sample({ dir: `/e/m${i}` }));
    const s = readStats();
    expect(s.recent).toHaveLength(RECENT_LIMIT);
    expect(s.recent[0]!.dir).toBe("/e/m1");
  });

  it("counts the four outcomes apart", () => {
    recordRead(sample({ outcome: "completed" }));
    recordRead(sample({ dir: "/e/b", outcome: "deadline" }));
    recordRead(sample({ dir: "/e/c", outcome: "cancelled" }));
    expect(readStats().byOutcome).toEqual({ completed: 1, failed: 0, cancelled: 1, deadline: 1 });
  });
});

describe("what the scheduler files (#420)", () => {
  const label = { dir: "/e/monolith", what: "graph --live", live: true };

  it("counts a shared subscriber as work not done, and never as a run", async () => {
    const pool = new ReadScheduler<number>(() => 1);
    const gate = deferred<number>();
    const first = pool.read("same", async () => gate.promise, undefined, label);
    const second = pool.read("same", async () => { throw new Error("duplicate spawn"); }, undefined, label);
    await Promise.resolve();
    expect(readStats().shared).toBe(1);
    gate.resolve(7);
    expect(await Promise.all([first, second])).toEqual([7, 7]);
    // One spawn, two callers: the run is counted once and the saving once.
    const s = readStats();
    expect(s.runs).toBe(1);
    expect(s.shared).toBe(1);
    expect(s.live.runs).toBe(1);
  });

  it("files an expiry as a deadline and a caller leaving as a cancellation", async () => {
    const expiring = new ReadScheduler<number>(() => 1, () => 1);
    // The deadline aborts the worker; a slot is held until the worker actually
    // stops, so an honest task is one that stops when told (as spawnChant does).
    const slow = expiring.read("slow", (signal) => new Promise<number>((_, no) => {
      signal.addEventListener("abort", () => no(signal.reason), { once: true });
    }), undefined, label);
    await expect(slow).rejects.toThrow(/exceeded 1ms/);
    expect(readStats().byOutcome).toMatchObject({ deadline: 1, cancelled: 0, failed: 0 });

    resetReadStats();
    const pool = new ReadScheduler<number>(() => 1);
    const caller = new AbortController();
    const started = deferred<void>();
    const read = pool.read("gone", (signal) => new Promise<number>((_, no) => {
      started.resolve();
      signal.addEventListener("abort", () => no(signal.reason), { once: true });
    }), caller.signal, label);
    await started.promise;
    caller.abort(new Error("disconnected"));
    await expect(read).rejects.toThrow("disconnected");
    expect(readStats().byOutcome).toMatchObject({ cancelled: 1, deadline: 0, failed: 0 });
  });

  it("files a read that threw as failed, not as cancelled", async () => {
    const pool = new ReadScheduler<number>(() => 1);
    await expect(pool.read("bad", async () => { throw new Error("chant blew up"); }, undefined, label)).rejects.toThrow("chant blew up");
    expect(readStats().byOutcome).toMatchObject({ failed: 1, cancelled: 0, deadline: 0 });
  });

  it("counts a refusal when the queue is full, and records nothing for a read nobody named", async () => {
    const pool = new ReadScheduler<number>(() => 1, () => 60_000, 1);
    const gate = deferred<number>();
    const running = pool.read("a", async () => gate.promise);
    const queued = pool.read("b", async () => 2);
    await Promise.resolve();
    await expect(pool.read("c", async () => 3)).rejects.toThrow(/queue is full/);
    expect(readStats().refused).toBe(1);
    gate.resolve(1);
    await Promise.all([running, queued]);
    // The scheduler is generic; only its caller knows what an argv is called.
    expect(readStats().runs).toBe(0);
  });

  it("separates time spent waiting for a slot from time spent running", async () => {
    const pool = new ReadScheduler<number>(() => 1);
    const first = deferred<number>();
    const held = pool.read("first", async () => first.promise, undefined, { ...label, dir: "/e/first" });
    const waiting = pool.read("second", async () => 2, undefined, { ...label, dir: "/e/second" });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 12));
    first.resolve(1);
    await Promise.all([held, waiting]);
    const by = Object.fromEntries(readStats().recent.map((r) => [r.dir, r]));
    expect(by["/e/first"]!.queuedMs).toBeLessThan(10);
    expect(by["/e/second"]!.queuedMs).toBeGreaterThanOrEqual(10);
    expect(by["/e/second"]!.runningMs).toBeLessThan(10);
  });
});
