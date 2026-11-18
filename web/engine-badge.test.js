import { describe, expect, it } from "vitest";
import { LINGER_MS, createBadgeClock, freshAnswer } from "./engine-badge.js";

// behold#1182: the LadybugDB badge moves while a query runs and for a few seconds after a fresh result set.
describe("the badge's clock", () => {
  it("is still until a query starts, moves while it runs, and lingers LINGER_MS after a fresh result set", () => {
    const c = createBadgeClock();
    expect(LINGER_MS).toBe(3000);
    expect(c.active(0)).toBe(false);
    c.start();
    expect(c.active(10)).toBe(true);
    expect(c.nextChange(10)).toBe(null);
    expect(c.active(60_000)).toBe(true);
    c.result(true, 1000);
    expect(c.active(1000)).toBe(true);
    expect(c.active(3999)).toBe(true);
    expect(c.nextChange(3000)).toBe(1000);
    expect(c.active(4000)).toBe(false);
    expect(c.nextChange(4000)).toBe(null);
  });

  it("stops at once on an empty or refused answer", () => {
    const c = createBadgeClock();
    c.start();
    c.result(false, 500);
    expect(c.active(500)).toBe(false);
    c.start();
    c.result(true, 1000);
    c.start();
    c.result(false, 1500);
    expect(c.active(1500)).toBe(false);
  });

  it("extends across overlapping queries rather than restarting", () => {
    const c = createBadgeClock({ lingerMs: 1000 });
    c.start();
    c.start();
    c.result(true, 100);
    // One still runs: the badge moves past the first one's linger.
    expect(c.active(5000)).toBe(true);
    expect(c.nextChange(5000)).toBe(null);
    c.result(true, 5000);
    expect(c.active(5999)).toBe(true);
    expect(c.active(6000)).toBe(false);
    // A query that starts while the badge lingers keeps it moving, and a later fresh answer pushes the stop out.
    c.result(true, 10_000);
    c.start();
    expect(c.active(10_500)).toBe(true);
    c.result(true, 10_600);
    expect(c.active(11_500)).toBe(true);
    expect(c.active(11_600)).toBe(false);
  });

  it("an earlier, longer linger is not cut short by a later fresh answer", () => {
    const c = createBadgeClock({ lingerMs: 1000 });
    c.start();
    c.result(true, 2000);
    c.result(true, 1500);
    expect(c.active(2900)).toBe(true);
  });

  it("forgets everything on reset, and an end with no start is harmless", () => {
    const c = createBadgeClock();
    c.start();
    c.start();
    c.reset();
    expect(c.active(0)).toBe(false);
    c.result(false, 0);
    c.result(false, 0);
    c.start();
    expect(c.active(1)).toBe(true);
  });

  it("counts a 200 answer with rows as fresh, and nothing else", () => {
    expect(freshAnswer({ status: 200, body: { rows: [{ k: 1 }] } })).toBe(true);
    expect(freshAnswer({ status: 200, body: { rows: [] } })).toBe(false);
    expect(freshAnswer({ status: 200, body: {} })).toBe(false);
    expect(freshAnswer({ status: 409, body: { rows: [{ k: 1 }] } })).toBe(false);
    expect(freshAnswer(undefined)).toBe(false);
  });
});
