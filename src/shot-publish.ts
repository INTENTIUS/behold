/**
 * behold#923: `behold shot ... --publish <remote>[/<branch>]`. Off by default:
 * nothing leaves the machine without the flag, and `behold mcp`, `GET
 * /api/shot` and a `--public` serve never reach this module.
 *
 * The PNG is committed to the shots branch (default `behold-shots`) of the
 * named remote, tracked with Git LFS, and pushed. It is done with plumbing on
 * a private index file: no working tree, index or HEAD of any checkout is
 * touched, and the branch checked out in the repo (or its upstream) is
 * refused, so a shot never lands in the served project's own branch.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const DEFAULT_SHOTS_BRANCH = "behold-shots";
export const LFS_ATTRIBUTES_LINE = "*.png filter=lfs diff=lfs merge=lfs -text";
export const LFS_INSTALL_LINE = "install git-lfs (https://git-lfs.com, e.g. `brew install git-lfs`), then run `git lfs install`";

export interface PublishTarget {
  remote: string;
  branch: string;
}

/** `<remote>[/<branch>]`, read. Throws a message on a usage error. */
export function parsePublishTarget(spec: string): PublishTarget {
  const slash = spec.indexOf("/");
  const remote = slash < 0 ? spec : spec.slice(0, slash);
  const branch = slash < 0 ? DEFAULT_SHOTS_BRANCH : spec.slice(slash + 1);
  if (!remote || !/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error(`--publish needs a remote name, as <remote>[/<branch>]: ${spec}`);
  if (!branch || branch.startsWith("-") || branch.endsWith("/") || branch.endsWith(".lock") || /\.\.|[\s~^:?*[\\]|@\{|\/\//.test(branch)) {
    throw new Error(`--publish has a branch git does not take: ${spec}`);
  }
  return { remote, branch };
}

/** A refusal: what went wrong and the line that sets it up. The local PNG is kept. */
export class PublishRefusal extends Error {
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
  }
}

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}
/** Runs git. `input` goes to stdin; `env` is added to the process env. */
export type GitRun = (args: string[], opts: { cwd: string; input?: Buffer | string; env?: Record<string, string> }) => GitResult;

export const runGit: GitRun = (args, { cwd, input, env }) => {
  const r = spawnSync("git", args, { cwd, input, env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) return { status: 127, stdout: "", stderr: r.error.message };
  return { status: r.status ?? 1, stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8") };
};

export interface PublishRequest {
  png: string;
  target: PublishTarget;
  /** The repo whose remote is named. Default: the current directory's. */
  repoDir: string;
  /** The served project, whose checked-out branch is refused too. */
  projectDir?: string;
  now?: Date;
}

export interface Published {
  commit: string;
  path: string;
  remoteUrl: string;
  /** The PNG's raw URL, for hosts behold knows (GitHub, GitLab). */
  rawUrl?: string;
}

/** The file's path in the shots branch: the default name is already stamped, others get the time first. */
export function shotPathInBranch(png: string, now = new Date()): string {
  const name = basename(png);
  return name.startsWith("behold-shot-") ? name : `${now.toISOString().replace(/[:.]/g, "-")}-${name}`;
}

/** The raw URL of `path` at `commit` on a GitHub or GitLab remote; undefined elsewhere. */
export function rawUrlFor(remoteUrl: string, commit: string, path: string): string | undefined {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)(github\.com|gitlab\.com)[:/](.+?)(?:\.git)?\/?$/.exec(remoteUrl);
  if (!m) return undefined;
  const [, host, repo] = m;
  const file = path.split("/").map(encodeURIComponent).join("/");
  return host === "github.com" ? `https://github.com/${repo}/raw/${commit}/${file}` : `https://gitlab.com/${repo}/-/raw/${commit}/${file}`;
}

/** Commit `png` to the shots branch of the target remote through Git LFS and push it. */
export function publishShot(req: PublishRequest, git: GitRun = runGit): Published {
  const { remote, branch } = req.target;
  const ok = (args: string[], cwd: string, more: { input?: Buffer | string; env?: Record<string, string> } = {}): string => {
    const r = git(args, { cwd, ...more });
    if (r.status !== 0) throw new PublishRefusal(`git ${args[0]} ${args[1] ?? ""} failed: ${r.stderr.trim() || `exit ${r.status}`}`.replace(/\s+:/, ":"), "nothing was pushed; fix the git error above and run the shot again");
    return r.stdout;
  };

  if (git(["lfs", "version"], { cwd: req.repoDir }).status !== 0) throw new PublishRefusal("git-lfs is not installed, and --publish only pushes shots through Git LFS", LFS_INSTALL_LINE);

  const top = git(["rev-parse", "--show-toplevel"], { cwd: req.repoDir });
  if (top.status !== 0) throw new PublishRefusal(`${req.repoDir} is not in a git repo`, "run the shot from the repo to publish to, or name it with --publish-repo <dir>");
  const repo = top.stdout.trim();
  const remoteUrlRes = git(["remote", "get-url", remote], { cwd: repo });
  if (remoteUrlRes.status !== 0) throw new PublishRefusal(`${repo} has no remote '${remote}'`, `add it with \`git -C ${repo} remote add ${remote} <url>\`, or name another remote`);
  const remoteUrl = remoteUrlRes.stdout.trim();

  // Never the served project's own branch: refuse the branch checked out in the repo, or its upstream.
  for (const dir of new Set([repo, ...(req.projectDir ? [req.projectDir] : [])])) {
    if (!existsSync(dir)) continue;
    const head = git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: dir });
    if (head.status !== 0) continue;
    const current = head.stdout.trim();
    const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: dir });
    const sameRepo = dir === repo || git(["rev-parse", "--show-toplevel"], { cwd: dir }).stdout.trim() === repo;
    if ((sameRepo && current === branch) || (upstream.status === 0 && upstream.stdout.trim() === `${remote}/${branch}`)) {
      throw new PublishRefusal(`'${branch}' is the branch checked out in ${dir}, and a shot is never committed to it`, `publish to a branch of its own, e.g. --publish ${remote}/${DEFAULT_SHOTS_BRANCH}`);
    }
  }

  // The branch as the remote has it, if it exists.
  const ls = ok(["ls-remote", "--heads", remote, `refs/heads/${branch}`], repo);
  let parent: string | undefined;
  if (ls.trim()) {
    ok(["fetch", "--quiet", "--no-tags", remote, `refs/heads/${branch}`], repo);
    parent = ok(["rev-parse", "FETCH_HEAD^{commit}"], repo).trim();
  }

  // The LFS pointer; `git lfs clean` keeps the object in the repo's LFS store for the push.
  const path = shotPathInBranch(req.png, req.now);
  const pointer = ok(["lfs", "clean", path], repo, { input: readFileSync(req.png) });
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(pointer)?.[1];
  if (!oid) throw new PublishRefusal("git lfs clean did not answer a pointer", LFS_INSTALL_LINE);

  const scratch = mkdtempSync(join(tmpdir(), "behold-publish-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  let commit: string;
  try {
    if (parent) ok(["read-tree", parent], repo, { env });
    else ok(["read-tree", "--empty"], repo, { env });
    const attrs = parent ? git(["cat-file", "blob", `${parent}:.gitattributes`], { cwd: repo }) : undefined;
    const current = attrs?.status === 0 ? attrs.stdout : "";
    if (!current.split("\n").some((l) => l.trim() === LFS_ATTRIBUTES_LINE)) {
      const next = `${current}${current && !current.endsWith("\n") ? "\n" : ""}${LFS_ATTRIBUTES_LINE}\n`;
      const blob = ok(["hash-object", "-w", "--stdin"], repo, { input: next }).trim();
      ok(["update-index", "--add", "--cacheinfo", `100644,${blob},.gitattributes`], repo, { env });
    }
    const ptrBlob = ok(["hash-object", "-w", "--stdin"], repo, { input: pointer }).trim();
    ok(["update-index", "--add", "--cacheinfo", `100644,${ptrBlob},${path}`], repo, { env });
    const tree = ok(["write-tree"], repo, { env }).trim();
    commit = ok(["-c", "commit.gpgsign=false", "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `behold shot: ${path}`], repo).trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // The object first: a remote that does not take LFS is refused before the branch moves.
  const lfs = git(["lfs", "push", "--object-id", remote, oid], { cwd: repo });
  if (lfs.status !== 0) {
    throw new PublishRefusal(`'${remote}' (${remoteUrl}) did not take the Git LFS object: ${lfs.stderr.trim().split("\n").pop() ?? ""}`, `enable Git LFS on the remote's host, then \`git lfs install\` and \`git lfs push --all ${remote}\``);
  }
  ok(["push", "--quiet", "--no-verify", remote, `${commit}:refs/heads/${branch}`], repo);
  const rawUrl = rawUrlFor(remoteUrl, commit, path);
  return { commit, path, remoteUrl, ...(rawUrl ? { rawUrl } : {}) };
}
