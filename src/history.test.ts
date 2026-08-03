import { describe, it, expect } from "vitest";
import { parseGitLog, parseRollbackBranches } from "./history.ts";

const SEP = "\x1f";
const line = (sha: string, subject: string, date: string, author: string) =>
  [sha, subject, date, author].join(SEP);

describe("parseGitLog", () => {
  it("parses commits into structured fields", () => {
    const out = [
      line("a1b2c3d", "release: chant 0.18.9", "2026-07-13", "lex"),
      line("e4f5g6h", "fix: entry point", "2026-07-12", "lex"),
    ].join("\n");
    expect(parseGitLog(out)).toEqual([
      { sha: "a1b2c3d", subject: "release: chant 0.18.9", date: "2026-07-13", author: "lex" },
      { sha: "e4f5g6h", subject: "fix: entry point", date: "2026-07-12", author: "lex" },
    ]);
  });

  it("tolerates subjects with separators-safe content and trailing blank lines", () => {
    const out = line("abc", "feat: add x, y | z", "2026-07-01", "me") + "\n\n";
    expect(parseGitLog(out)).toEqual([
      { sha: "abc", subject: "feat: add x, y | z", date: "2026-07-01", author: "me" },
    ]);
  });

  it("returns [] for empty output", () => {
    expect(parseGitLog("")).toEqual([]);
  });
});

describe("parseRollbackBranches (#117 interlock)", () => {
  // `chant lifecycle rollback <env> --to <ref>` (chant#873) restores source on a
  // branch named chant/rollback-<env>-<ref>. The branch existing is behold's
  // read-only tell that a rollback is in flight — no forge API, no creds.
  const out = [
    "main",
    "chant/rollback-prod-73d04c0",
    "feat/something",
    "chant/rollback-staging-abc1234",
  ].join("\n");

  it("finds rollback branches for the env it was given", () => {
    expect(parseRollbackBranches(out, "prod")).toEqual(["chant/rollback-prod-73d04c0"]);
  });

  // A rollback of staging says nothing about a loop watching prod.
  it("ignores a rollback of another environment", () => {
    expect(parseRollbackBranches(out, "prod")).not.toContain("chant/rollback-staging-abc1234");
  });

  it("finds every rollback when given no env", () => {
    expect(parseRollbackBranches(out)).toEqual([
      "chant/rollback-prod-73d04c0",
      "chant/rollback-staging-abc1234",
    ]);
  });

  it("strips the checked-out and worktree markers git branch prints", () => {
    expect(parseRollbackBranches("* chant/rollback-prod-aaa\n+ chant/rollback-prod-bbb")).toEqual([
      "chant/rollback-prod-aaa",
      "chant/rollback-prod-bbb",
    ]);
  });

  it("returns [] when no rollback is open", () => {
    expect(parseRollbackBranches("main\nfeat/x", "prod")).toEqual([]);
    expect(parseRollbackBranches("")).toEqual([]);
  });
});
