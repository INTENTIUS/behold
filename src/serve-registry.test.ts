// behold#916: the per-user registry under the OS temp dir that `behold mcp` finds a serve through.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findServe, listServes, pidAlive, realDir, removeServeEntry, servesDir, within, writeServeEntry } from "./serve-registry.ts";

let dir: string;
const before = process.env.BEHOLD_SERVES_DIR;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "behold-serves-"));
  process.env.BEHOLD_SERVES_DIR = join(dir, "serves");
});
afterEach(() => {
  if (before === undefined) delete process.env.BEHOLD_SERVES_DIR;
  else process.env.BEHOLD_SERVES_DIR = before;
  rmSync(dir, { recursive: true, force: true });
});

const project = (): string => {
  const p = mkdtempSync(join(dir, "proj-"));
  return realDir(p);
};

describe("the serve registry", () => {
  it("lives under the OS temp dir by default", () => {
    delete process.env.BEHOLD_SERVES_DIR;
    expect(servesDir()).toBe(join(tmpdir(), "behold", "serves"));
  });

  it("writes one file per serve, the user's own, and removes it", () => {
    const p = project();
    writeServeEntry({ url: "http://127.0.0.1:4600", pid: process.pid, projectDir: p, version: "0.0.0", startedAt: "2026-10-23T00:00:00.000Z" });
    const file = join(servesDir(), `${process.pid}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(servesDir()).mode & 0o777).toBe(0o700);
    expect(listServes()).toEqual([{ url: "http://127.0.0.1:4600", pid: process.pid, projectDir: p, version: "0.0.0", startedAt: "2026-10-23T00:00:00.000Z" }]);
    removeServeEntry();
    expect(readdirSync(servesDir())).toEqual([]);
    removeServeEntry();
  });

  it("ignores and sweeps an entry whose pid is dead, and skips what isn't an entry", () => {
    const p = project();
    writeServeEntry({ url: "http://127.0.0.1:4601", pid: 999_999_1, projectDir: p, version: "0", startedAt: "2026-10-23T00:00:00.000Z" });
    mkdirSync(servesDir(), { recursive: true });
    writeFileSync(join(servesDir(), "12.json"), "{not json");
    writeFileSync(join(servesDir(), "notes.txt"), "x");
    expect(listServes((pid) => pid !== 999_999_1)).toEqual([]);
    expect(readdirSync(servesDir()).sort()).toEqual(["12.json", "notes.txt"]);
  });

  it("finds the newest live serve of a project, or of a directory holding it", () => {
    const p = project();
    const sub = join(p, "envs");
    mkdirSync(sub);
    writeServeEntry({ url: "http://127.0.0.1:4600", pid: 101, projectDir: p, version: "0", startedAt: "2026-10-23T00:00:00.000Z" });
    writeServeEntry({ url: "http://127.0.0.1:4700", pid: 102, projectDir: p, version: "0", startedAt: "2026-10-23T01:00:00.000Z" });
    writeServeEntry({ url: "http://127.0.0.1:4800", pid: 103, projectDir: project(), version: "0", startedAt: "2026-10-23T02:00:00.000Z" });
    const alive = (): boolean => true;
    expect(findServe(p, alive)?.url).toBe("http://127.0.0.1:4700");
    expect(findServe(sub, alive)?.url).toBe("http://127.0.0.1:4700");
    expect(findServe(dir, alive)).toBeUndefined();
  });

  it("knows a live pid from a dead one", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(999_999_1)).toBe(false);
    expect(pidAlive(0)).toBe(false);
  });

  it("within: a directory and what is under it, nothing beside it", () => {
    expect(within("/a/b", "/a/b")).toBe(true);
    expect(within("/a/b", "/a/b/c")).toBe(true);
    expect(within("/a/b", "/a/bc")).toBe(false);
    expect(within("/a/b", "/a")).toBe(false);
  });
});
