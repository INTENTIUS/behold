import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memberSourceStamp } from "./member-source.ts";

// `memberSourceStamp` is the cache key for BOTH caches: the source IR cache
// (src/member-ir.ts, #307) and the live overlay document cache
// (src/overlay-ir.ts, #396). Six modules read it and it had no test.
//
// The two ways it can fail are opposite and both expensive. Too sensitive and
// every cache misses, which puts the ~800ms-per-spawn cost back on every read —
// the number #419 spent five milestones on. Too blunt and a cache serves a
// stale graph, which is a viewer showing an estate that no longer exists.
//
// Nothing here is a bug fix; all of it passed when it was written.
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function member(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "behold-stamp-"));
  made.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

describe("memberSourceStamp", () => {
  it("stamps a member, and the same member twice the same way", () => {
    const dir = member({ "src/main.ts": "export const x = 1;" });
    const first = memberSourceStamp(dir);
    expect(first).toBeTruthy();
    expect(memberSourceStamp(dir)).toBe(first);
  });

  it("sees a source edit", () => {
    const dir = member({ "src/main.ts": "export const x = 1;" });
    const before = memberSourceStamp(dir);
    writeFileSync(join(dir, "src/main.ts"), "export const x = 2;");
    expect(memberSourceStamp(dir)).not.toBe(before);
  });

  it("sees a file appear and disappear", () => {
    const dir = member({ "src/main.ts": "export const x = 1;" });
    const before = memberSourceStamp(dir);
    writeFileSync(join(dir, "src/second.ts"), "export const y = 2;");
    const added = memberSourceStamp(dir);
    expect(added).not.toBe(before);
    rmSync(join(dir, "src/second.ts"));
    expect(memberSourceStamp(dir)).toBe(before);
  });

  it("walks the whole root, since a config can put source outside src/", () => {
    const dir = member({ "src/main.ts": "x", "infra/extra.ts": "y" });
    const before = memberSourceStamp(dir);
    writeFileSync(join(dir, "infra/extra.ts"), "z");
    expect(memberSourceStamp(dir)).not.toBe(before);
  });

  it("IGNORES node_modules, dist and .git", () => {
    // The load-bearing one. Without this an `npm install` in any member
    // invalidates its cache, and an estate pays a full re-read for a change
    // that cannot affect what its source graphs to.
    const dir = member({ "src/main.ts": "export const x = 1;" });
    const before = memberSourceStamp(dir);
    for (const [rel, content] of [
      ["node_modules/dep/index.js", "module.exports = 1"],
      ["dist/cli.js", "built"],
      [".git/HEAD", "ref: refs/heads/main"],
    ]) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    expect(memberSourceStamp(dir)).toBe(before);
  });

  it("answers undefined for a root it cannot stamp, which is never cached", () => {
    // Undefined is the caller's signal to cache nothing — an empty or
    // unreadable member must not share a key with anything.
    expect(memberSourceStamp(member({}))).toBeUndefined();
    expect(memberSourceStamp(join(tmpdir(), "behold-stamp-does-not-exist"))).toBeUndefined();
  });

  it("cannot see a change that moves neither size nor mtime", () => {
    // The documented blind spot, pinned so it stays documented rather than
    // being discovered. It is why src/member-ir.ts wires `invalidateMember` to
    // the source watcher instead of relying on this alone: a filesystem whose
    // mtime granularity is coarse can hide an edit landing in the same tick.
    const dir = member({ "src/main.ts": "aaaa" });
    const path = join(dir, "src/main.ts");
    const pinned = new Date(2020, 0, 1);
    utimesSync(path, pinned, pinned);
    const before = memberSourceStamp(dir);
    writeFileSync(path, "bbbb");
    utimesSync(path, pinned, pinned);
    expect(memberSourceStamp(dir)).toBe(before);
  });
});
