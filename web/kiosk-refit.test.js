import { describe, expect, it, vi } from "vitest";
import { PAGE_TIMERS, REFIT_WAIT_MS, afterFrames, debounced } from "./kiosk-shot.js";

const fakeTimers = () => {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    set: (fn, ms) => (pending.set(next, { fn, at: now + ms }), next++),
    clear: (id) => pending.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, t] of [...pending]) if (t.at <= now) (pending.delete(id), t.fn());
    },
  };
};

describe("refit trigger", () => {
  it("runs once, after the last size change of a burst", () => {
    const t = fakeTimers();
    const runs = [];
    const refit = debounced(() => runs.push(1), REFIT_WAIT_MS, t);
    refit();
    t.advance(60);
    refit();
    t.advance(60);
    refit();
    t.advance(REFIT_WAIT_MS - 1);
    expect(runs).toHaveLength(0);
    t.advance(1);
    expect(runs).toHaveLength(1);
    t.advance(1000);
    expect(runs).toHaveLength(1);
  });

  it("cancel drops a pending run", () => {
    const t = fakeTimers();
    const runs = [];
    const refit = debounced(() => runs.push(1), 100, t);
    refit();
    refit.cancel();
    t.advance(500);
    expect(runs).toHaveLength(0);
  });

  it("afterFrames waits two animation frames by default", () => {
    const queue = [];
    const raf = (fn) => queue.push(fn);
    let done = 0;
    afterFrames(raf, () => done++);
    expect(done).toBe(0);
    queue.shift()();
    expect(done).toBe(0);
    queue.shift()();
    expect(done).toBe(1);
  });

  it("runs on the page's own timers by default (a bare setTimeout in the timers object threw Illegal invocation)", () => {
    vi.useFakeTimers();
    try {
      const runs = [];
      const refit = debounced(() => runs.push(1));
      expect(() => refit()).not.toThrow();
      vi.advanceTimersByTime(REFIT_WAIT_MS);
      expect(runs).toHaveLength(1);
      refit();
      refit.cancel();
      vi.advanceTimersByTime(1000);
      expect(runs).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the default timers are methods that work detached from a window", () => {
    // What throws in a browser: timers.set(...) with `this` the timers object. Calling through a plain object proves it.
    const holder = { set: PAGE_TIMERS.set, clear: PAGE_TIMERS.clear };
    const id = holder.set(() => {}, 5);
    expect(() => holder.clear(id)).not.toThrow();
  });
});
