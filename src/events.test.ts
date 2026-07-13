import { describe, it, expect, vi } from "vitest";
import { Broadcaster } from "./events.ts";

describe("Broadcaster", () => {
  it("delivers emitted events to every subscriber", () => {
    const b = new Broadcaster();
    const a = vi.fn();
    const c = vi.fn();
    b.subscribe(a);
    b.subscribe(c);
    b.emit("changed");
    expect(a).toHaveBeenCalledWith("changed");
    expect(c).toHaveBeenCalledWith("changed");
  });

  it("stops delivering after unsubscribe", () => {
    const b = new Broadcaster();
    const fn = vi.fn();
    const off = b.subscribe(fn);
    off();
    b.emit("changed");
    expect(fn).not.toHaveBeenCalled();
    expect(b.size).toBe(0);
  });

  it("tolerates a subscriber unsubscribing during emit", () => {
    const b = new Broadcaster();
    const seen: string[] = [];
    const off = b.subscribe(() => {
      seen.push("a");
      off(); // remove self mid-emit
    });
    b.subscribe(() => seen.push("b"));
    expect(() => b.emit("x")).not.toThrow();
    expect(seen).toEqual(["a", "b"]);
    expect(b.size).toBe(1);
  });
});
