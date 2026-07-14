/**
 * Source history (#28) — recent git commits of the served project, so the SPA can
 * offer them as rollback targets. Read-only (`git log`); behold never writes.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Commit {
  sha: string;
  subject: string;
  date: string;
  author: string;
}

const SEP = "\x1f"; // unit separator — safe against subjects containing anything printable

/** Parse `git log --format=%h<SEP>%s<SEP>%cs<SEP>%an` output. Pure — unit-tested. */
export function parseGitLog(stdout: string): Commit[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, date, author] = line.split(SEP);
      return { sha, subject: subject ?? "", date: date ?? "", author: author ?? "" };
    })
    .filter((c) => c.sha);
}

/** Recent commits of the project (newest first). Empty on any git error (not a repo). */
export async function sourceCommits(projectDir: string, limit = 20): Promise<Commit[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", `-n${limit}`, `--format=%h${SEP}%s${SEP}%cs${SEP}%an`],
      { cwd: projectDir },
    );
    return parseGitLog(stdout);
  } catch {
    return [];
  }
}
