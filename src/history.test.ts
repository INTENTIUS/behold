import { describe, it, expect } from "vitest";
import { parseGitLog } from "./history.ts";

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
