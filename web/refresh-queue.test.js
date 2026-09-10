import { describe, expect, it } from "vitest";
import { createRefreshQueue } from "./refresh-queue.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe("browser refresh queue", () => {
  it("a slow read plus an event burst makes one follow-up, never overlapping reads", async () => {
    const first = deferred(), second = deferred();
    let active = 0, peak = 0;
    const calls = [], current = [];
    const load = createRefreshQueue(async (opts, isCurrent) => {
      peak = Math.max(peak, ++active);
      calls.push(opts); current.push(isCurrent);
      await (calls.length === 1 ? first : second).promise;
      active--;
    });
    const initial = load();
    await Promise.resolve();
    const burst = Array.from({ length: 20 }, () => load({ quiet: true }));
    load({ quiet: false }); load({ quiet: true });
    expect(calls).toHaveLength(1);
    expect(current[0]()).toBe(false); // suppress the superseded response
    first.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toHaveLength(2);
    expect(calls[1].quiet).toBe(false); // foreground request wins
    expect(current[1]()).toBe(true);
    second.resolve();
    await Promise.all([initial, ...burst]);
    expect(peak).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("one change event makes exactly one read", async () => {
    let calls = 0;
    const load = createRefreshQueue(async () => { calls++; });
    await load();
    expect(calls).toBe(1);
    await load(); // a later notification remains fresh
    expect(calls).toBe(2);
  });

  it("a failed load does not wedge future refreshes", async () => {
    let calls = 0;
    const load = createRefreshQueue(async () => { if (++calls === 1) throw new Error("offline"); });
    await expect(load()).rejects.toThrow("offline");
    await load();
    expect(calls).toBe(2);
  });
});
