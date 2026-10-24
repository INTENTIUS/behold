import { describe, expect, it } from "vitest";
import { REFIT_WAIT_MS, afterFrames, debounced } from "./kiosk-shot.js";

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
});
