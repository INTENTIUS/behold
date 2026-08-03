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

/**
 * Branches of an open rollback (#117's interlock).
 *
 * `chant lifecycle rollback <env> --to <ref>` (chant#873, behold's /api/rollback)
 * restores source to a prior revision on a branch named
 * `chant/rollback-<env>-<ref>` and opens a PR. The branch existing is behold's
 * read-only tell that a rollback is in flight — no forge API call, no creds,
 * consistent with behold holding none.
 *
 * Scoped to `env` when given, since a rollback of `staging` says nothing about
 * an auto-sync loop watching `prod`. Pure — unit-tested.
 */
export function parseRollbackBranches(stdout: string, env?: string): string[] {
  const prefix = env ? `chant/rollback-${env}-` : "chant/rollback-";
  return stdout
    .split("\n")
    // `git branch --list` marks the checked-out branch with `* ` and a worktree
    // branch with `+ `.
    .map((l) => l.replace(/^[*+]?\s*/, "").trim())
    .filter((l) => l.startsWith(prefix))
    .sort();
}

/** Open rollback branches for `env`, local and remote. Empty on any git error
 * (not a repo, no branches) — a project behold cannot read git for simply has no
 * interlock, which is the same position it was in before #117. */
export async function openRollbackBranches(projectDir: string, env?: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["branch", "--list", "--all", "--format=%(refname:short)"],
      { cwd: projectDir },
    );
    // `--all` prefixes remotes (`origin/chant/rollback-prod-abc`); strip the
    // remote so a branch that exists both locally and on the forge is one entry.
    const stripped = stdout
      .split("\n")
      .map((l) => l.trim().replace(/^[^/]+\/(?=chant\/rollback-)/, ""))
      .join("\n");
    return [...new Set(parseRollbackBranches(stripped, env))];
  } catch {
    return [];
  }
}
