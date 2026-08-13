import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broadcaster, watchSources } from "./events.ts";

describe("Broadcaster", () => {
  it("delivers typed events (with data) to every subscriber", () => {
    const b = new Broadcaster();
    const a = vi.fn();
    const c = vi.fn();
    b.subscribe(a);
    b.subscribe(c);
    b.emit("changed");
    expect(a).toHaveBeenCalledWith("changed", "");
    b.emit("op", "▶ chant run prod-apply");
    expect(c).toHaveBeenCalledWith("op", "▶ chant run prod-apply");
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

// #297: `serve a b c` watched only the primary's src/ — an edit anywhere else in
// the estate never fired. Real fs.watch here, so the waits are generous and the
// edit is re-issued until the (recursive, platform-lagged) watcher reports it.
describe("watchSources", () => {
  const estateMember = (tag: string): string => {
    const dir = mkdtempSync(join(tmpdir(), `behold-watch-${tag}-`));
    mkdirSync(join(dir, "src"));
    return dir;
  };

  it("watches every member's src/ and says which member changed", async () => {
    const a = estateMember("a");
    const b = estateMember("b");
    const seen: string[] = [];
    const stop = watchSources([a, b], (dir) => seen.push(dir), 20);
    try {
      // Retry the edit until the watcher reports it — fs.watch arms asynchronously.
      await vi.waitFor(
        () => {
          writeFileSync(join(b, "src", "stack.ts"), `export const beat = ${Date.now()};\n`);
          expect(seen).toContain(b);
        },
        { timeout: 5000, interval: 250 },
      );
      expect(seen).not.toContain(a); // attribution: b's edit is b's event, never a's
    } finally {
      stop();
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("one stop function closes every member's watcher", async () => {
    const a = estateMember("a");
    const b = estateMember("b");
    const seen: string[] = [];
    const stop = watchSources([a, b], (dir) => seen.push(dir), 20);
    stop();
    try {
      writeFileSync(join(a, "src", "stack.ts"), "export const x = 1;\n");
      writeFileSync(join(b, "src", "stack.ts"), "export const x = 1;\n");
      await new Promise((r) => setTimeout(r, 400)); // past the debounce + fs lag
      expect(seen).toEqual([]);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
