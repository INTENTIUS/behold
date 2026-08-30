import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same seam estate.test.ts mocks: the ONE shell-out. Everything else in
// chant.ts stays real — `resolveChant` is part of the cache key (rule 3: a
// member that moved onto a new chant graphs to something else from the same
// source), and stubbing it would leave that untested.
vi.mock("./chant.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chant.ts")>()),
  graphIr: vi.fn(),
}));
import { graphIr } from "./chant.ts";
import {
  invalidateMember,
  memberIr,
  memberIrCacheSize,
  memberIrCacheStats,
  memberSourceStamp,
  resetMemberIrCache,
} from "./member-ir.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A member project on disk: real files, so the stamp is a real stamp. No chant
 * of its own, so it resolves behold's — the tests that care install one. */
function member(): string {
  const root = mkdtempSync(join(tmpdir(), "behold-member-"));
  made.push(root);
  write(root, "package.json", JSON.stringify({ name: "member", private: true }));
  write(root, "src/app.ts", "export const a = 1;\n");
  return root;
}

function write(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const ir = (nodeId: string) => ({ nodes: [{ id: nodeId, kind: "X", lexicon: "k8s", attrs: {} }], edges: [], groups: {} });

beforeEach(() => {
  resetMemberIrCache();
  vi.unstubAllEnvs();
  vi.mocked(graphIr).mockReset();
  vi.mocked(graphIr).mockImplementation((async () => ir("a")) as never);
});

describe("memberSourceStamp (#307)", () => {
  it("stamps a member's real files and moves when one of them does", () => {
    const dir = member();
    const before = memberSourceStamp(dir);
    expect(before).toBeTypeOf("string");
    write(dir, "src/app.ts", "export const a = 2;\n");
    expect(memberSourceStamp(dir)).not.toBe(before);
  });

  it("moves when a file appears or disappears, not only when one is edited", () => {
    const dir = member();
    const before = memberSourceStamp(dir);
    write(dir, "src/extra.ts", "export const b = 1;\n");
    const withExtra = memberSourceStamp(dir);
    expect(withExtra).not.toBe(before);
    rmSync(join(dir, "src/extra.ts"));
    expect(memberSourceStamp(dir)).toBe(before);
  });

  it("ignores node_modules — an installed tree is not the member's declared source, and walking it would cost more than the spawn the stamp saves", () => {
    const dir = member();
    const before = memberSourceStamp(dir);
    write(dir, "node_modules/whatever/index.js", "module.exports = {};\n");
    expect(memberSourceStamp(dir)).toBe(before);
  });

  it("is undefined for a member that cannot be walked — an unstampable member is never cached", () => {
    expect(memberSourceStamp(join(tmpdir(), "behold-no-such-member-307"))).toBeUndefined();
  });
});

describe("memberIr (#307) — the warm estate read", () => {
  it("shells chant on the first read and reports the miss", async () => {
    const dir = member();
    expect((await memberIr(dir, { detail: 3 })).nodes.map((n) => n.id)).toEqual(["a"]);
    expect(graphIr).toHaveBeenCalledTimes(1);
    expect(memberIrCacheStats()).toMatchObject({ hits: 0, misses: 1, entries: 1 });
  });

  it("serves the second read from the cache — no second chant process for source that did not move", async () => {
    const dir = member();
    await memberIr(dir, { detail: 3 });
    const second = await memberIr(dir, { detail: 3 });
    expect(graphIr).toHaveBeenCalledTimes(1);
    expect(second.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(memberIrCacheStats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("re-reads once the member's source moves — a stale IR is the one thing this must never serve", async () => {
    const dir = member();
    await memberIr(dir, { detail: 3 });
    vi.mocked(graphIr).mockImplementation((async () => ir("b")) as never);
    write(dir, "src/app.ts", "export const a = 2;\n");
    expect((await memberIr(dir, { detail: 3 })).nodes.map((n) => n.id)).toEqual(["b"]);
    expect(graphIr).toHaveBeenCalledTimes(2);
  });

  it("re-reads after invalidateMember — the watcher's signal, for the edit an mtime stamp's granularity can hide", async () => {
    const dir = member();
    await memberIr(dir, { detail: 3 });
    invalidateMember(dir);
    await memberIr(dir, { detail: 3 });
    expect(graphIr).toHaveBeenCalledTimes(2);
  });

  it("invalidateMember drops only the named member; the rest of the estate stays warm", async () => {
    const [a, b] = [member(), member()];
    await memberIr(a, {});
    await memberIr(b, {});
    invalidateMember(a);
    await memberIr(a, {});
    await memberIr(b, {});
    expect(graphIr).toHaveBeenCalledTimes(3); // a twice, b once
    invalidateMember();
    await memberIr(b, {});
    expect(graphIr).toHaveBeenCalledTimes(4);
  });

  it("never caches a live or overlay read — a cluster moves with nothing on disk to notice", async () => {
    const dir = member();
    await memberIr(dir, { live: true, overlay: true, env: "prod" });
    await memberIr(dir, { live: true, overlay: true, env: "prod" });
    await memberIr(dir, { overlay: true });
    await memberIr(dir, { overlay: true });
    expect(graphIr).toHaveBeenCalledTimes(4);
    expect(memberIrCacheStats()).toMatchObject({ hits: 0, misses: 0, entries: 0 });
  });

  it("keys on the options that reach the invocation — a different detail, env or namespace is a different read", async () => {
    const dir = member();
    await memberIr(dir, { detail: 3 });
    await memberIr(dir, { detail: 2 });
    await memberIr(dir, { detail: 3, env: "prod" });
    await memberIr(dir, { detail: 3, env: "prod", namespace: "app-b" });
    expect(graphIr).toHaveBeenCalledTimes(4);
    // …and the same option set built in a different key order is the SAME read.
    await memberIr(dir, { env: "prod", detail: 3 });
    expect(graphIr).toHaveBeenCalledTimes(4);
  });

  it("keys on the member's resolved chant — an install that moves the member onto its own chant re-reads, though the stamp (which skips node_modules) saw nothing", async () => {
    const dir = member(); // no chant of its own yet: resolves behold's fallback
    await memberIr(dir, {});
    await memberIr(dir, {});
    expect(graphIr).toHaveBeenCalledTimes(1);
    const stamp = memberSourceStamp(dir);
    const chant = "node_modules/@intentius/chant";
    write(dir, `${chant}/package.json`, JSON.stringify({ name: "@intentius/chant", version: "0.44.5", main: "index.js", bin: { chant: "bin/chant" } }));
    write(dir, `${chant}/index.js`, "");
    write(dir, `${chant}/bin/chant`, "#!/usr/bin/env node\n");
    expect(memberSourceStamp(dir)).toBe(stamp); // the source really did not move
    await memberIr(dir, {});
    expect(graphIr).toHaveBeenCalledTimes(2);
  });

  it("hands out a copy, never the cached object — the estate's own passes mutate what they are given", async () => {
    const dir = member();
    const first = await memberIr(dir, {});
    first.nodes[0].attrs = { _unobserved: "cluster unreachable" };
    first.nodes.push({ id: "invented", kind: "X", lexicon: "k8s", attrs: {} } as never);
    const second = await memberIr(dir, {});
    expect(second.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(second.nodes[0].attrs).toEqual({});
  });

  it("caches nothing for a member it cannot stamp — a missing project shells every time rather than guessing", async () => {
    const gone = join(tmpdir(), "behold-no-such-member-307");
    await memberIr(gone, {});
    await memberIr(gone, {});
    expect(graphIr).toHaveBeenCalledTimes(2);
    expect(memberIrCacheStats().entries).toBe(0);
  });

  it("caches nothing when the source moves WHILE chant is reading — the entry would describe source that no longer exists", async () => {
    const dir = member();
    vi.mocked(graphIr).mockImplementation((async () => {
      write(dir, "src/app.ts", `export const a = ${Math.random()};\n`);
      return ir("a") as never;
    }) as never);
    await memberIr(dir, {});
    expect(memberIrCacheStats().entries).toBe(0);
  });
});

describe("memberIrCacheSize (#307) — a bound, not a tuning knob", () => {
  it("defaults to 64 and honours BEHOLD_ESTATE_IR_CACHE, ignoring a value that is not a size", () => {
    expect(memberIrCacheSize({})).toBe(64);
    expect(memberIrCacheSize({ BEHOLD_ESTATE_IR_CACHE: "8" })).toBe(8);
    expect(memberIrCacheSize({ BEHOLD_ESTATE_IR_CACHE: "0" })).toBe(0);
    expect(memberIrCacheSize({ BEHOLD_ESTATE_IR_CACHE: "-1" })).toBe(64);
    expect(memberIrCacheSize({ BEHOLD_ESTATE_IR_CACHE: "lots" })).toBe(64);
  });

  it("caches nothing at all at size 0 — the pre-#307 read path, kept reachable", async () => {
    vi.stubEnv("BEHOLD_ESTATE_IR_CACHE", "0");
    const dir = member();
    await memberIr(dir, {});
    await memberIr(dir, {});
    expect(graphIr).toHaveBeenCalledTimes(2);
    expect(memberIrCacheStats().entries).toBe(0);
  });

  it("evicts the least recently used entry once the bound is reached — #306 fixed an OOM and this must not reintroduce one", async () => {
    vi.stubEnv("BEHOLD_ESTATE_IR_CACHE", "2");
    const dir = member();
    await memberIr(dir, { detail: 1 });
    await memberIr(dir, { detail: 2 });
    await memberIr(dir, { detail: 1 }); // detail 1 is now the most recent
    expect(graphIr).toHaveBeenCalledTimes(2);
    await memberIr(dir, { detail: 3 }); // evicts detail 2, the oldest use
    expect(memberIrCacheStats().entries).toBe(2);
    await memberIr(dir, { detail: 1 });
    expect(graphIr).toHaveBeenCalledTimes(3); // still cached
    await memberIr(dir, { detail: 2 });
    expect(graphIr).toHaveBeenCalledTimes(4); // evicted, re-read
  });
});
