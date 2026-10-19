/**
 * `behold serve <dir> --repos <parent>` (behold#571): one server, several
 * checkouts, one picked per request.
 *
 * The demo host runs one forge repo per tool (terragucci's demo driver:
 * `<admin>/demo` for Terraform, `<admin>/demo-terragrunt` for Terragrunt) and
 * keeps a checkout of each under one directory. Each page asks about one of
 * them: the kiosk about the repo its demo.json names, a tool's page about its
 * tool's repo. So a request may carry `?repo=<name>`, and for that request the
 * served directory is that checkout: the graph, the components, the
 * terragucci reports' project and roots, the popover all read it, through
 * the same `cfg.projectDir` they always read.
 *
 * Decided: a per-request switch, not several members of one estate. An estate
 * would draw both repos in one picture, change what a single-repo serve
 * answers, and leave the reports with two projects to choose between; the
 * switch keeps each repo's picture exactly what serving it alone draws. A
 * request with no `repo` gets the directory on the command line, so a serve
 * without `--repos` is unchanged, and so is one with it for every page that
 * doesn't ask.
 *
 * Safe under `--public`: the value is a name, never a path. It is looked up in
 * the set read at startup (the git checkouts directly under the parent,
 * by directory name); `<owner>/<name>`, as demo.json writes a repo, is
 * matched by its last segment. Anything else is refused with 404 before any
 * route runs, and nothing from the request reaches the filesystem.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Hono } from "hono";

/** What one checkout serves as: the same shape `serve` computes for a directory on the command line. */
export interface RepoTarget {
  projectDir: string;
  projectDirs?: string[];
}

export interface ViewRepos {
  /** The parent directory, for the startup line. */
  parent: string;
  /** name -> what it serves as. */
  repos: Map<string, RepoTarget>;
  /** The name of the checkout a request with no `repo` gets, when it is one of them. */
  defaultName?: string;
}

/** A repo name as a request may give it: `demo-terragrunt`, or `<owner>/demo-terragrunt`. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The checkout name a `repo` value asks for, or undefined when it is not a name at all. */
export function repoName(value: string): string | undefined {
  const v = value.trim().replace(/\.git$/, "");
  const last = v.slice(v.lastIndexOf("/") + 1);
  return NAME.test(last) ? last : undefined;
}

/** The git checkouts directly under `parent`, by directory name, sorted. */
export function listCheckouts(parent: string): { name: string; dir: string }[] {
  let names: string[];
  try {
    names = readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && NAME.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  return names.map((name) => ({ name, dir: resolve(parent, name) })).filter((c) => existsSync(join(c.dir, ".git")));
}

const scope = new AsyncLocalStorage<RepoTarget>();

/** The checkout this request asked for, when it asked for one. */
export const requestRepo = (): RepoTarget | undefined => scope.getStore();

/**
 * behold#749: whether this request reads another checkout than the one on the command line: a `?repo=` naming
 * any checkout but `defaultName`. Such a request reads its own terragucci project, never `--terragucci-project`'s,
 * which names the command line's checkout (src/terragucci-view.ts `otherRepo`).
 */
export function readsOtherRepo(repos: ViewRepos): boolean {
  const asked = requestRepo();
  if (!asked) return false;
  const own = repos.defaultName !== undefined ? repos.repos.get(repos.defaultName) : undefined;
  return !own || asked.projectDir !== own.projectDir;
}

/**
 * Make `cfg.projectDir` and `cfg.projectDirs` answer for the request's repo.
 * Assignments (a project switch) set what a request without `repo` gets.
 */
export function scopeServedDirs(cfg: { projectDir: string; projectDirs?: string[] }): void {
  let projectDir = cfg.projectDir;
  let projectDirs = cfg.projectDirs;
  Object.defineProperty(cfg, "projectDir", {
    configurable: true,
    enumerable: true,
    get: () => scope.getStore()?.projectDir ?? projectDir,
    set: (v: string) => {
      projectDir = v;
    },
  });
  Object.defineProperty(cfg, "projectDirs", {
    configurable: true,
    enumerable: true,
    get: () => {
      const s = scope.getStore();
      return s ? s.projectDirs : projectDirs;
    },
    set: (v: string[] | undefined) => {
      projectDirs = v;
    },
  });
}

/** The middleware: `?repo=` picks a checkout for the request, an unknown one is refused. */
export function viewReposMiddleware(app: Hono, repos: ViewRepos): void {
  app.use("*", async (c, next) => {
    const asked = new URL(c.req.url).searchParams.get("repo");
    if (asked === null || asked === "") return next();
    const name = repoName(asked);
    const target = name ? repos.repos.get(name) : undefined;
    if (!target) {
      return c.json({ error: `this behold serves no repo ${JSON.stringify(asked.slice(0, 120))}; it serves ${[...repos.repos.keys()].join(", ") || "none"}`, code: "view-repo" }, 404);
    }
    return scope.run(target, () => next());
  });
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * The commit a checkout has checked out, read from its `.git` files: a
 * detached HEAD's sha, or the branch's from its ref file or `packed-refs`.
 * Undefined when it can't be read (no checkout, a worktree's `.git` file).
 */
export function checkoutCommit(dir: string): string | undefined {
  const read = (f: string): string | undefined => {
    try {
      return readFileSync(join(dir, ".git", f), "utf8");
    } catch {
      return undefined;
    }
  };
  const head = read("HEAD")?.trim();
  if (!head) return undefined;
  if (SHA.test(head)) return head;
  const ref = /^ref: (refs\/[^\s]+)$/.exec(head)?.[1];
  if (!ref || ref.split("/").includes("..")) return undefined;
  const loose = read(ref)?.trim();
  if (loose && SHA.test(loose)) return loose;
  for (const line of (read("packed-refs") ?? "").split("\n")) {
    const [sha, name] = line.trim().split(" ");
    if (name === ref && sha && SHA.test(sha)) return sha;
  }
  return undefined;
}

/**
 * What `/api/project` says about the repos: the one this request reads, every
 * one there is, and the commit each has checked out (behold#571: a page that
 * follows a change picks the checkout at that change's commit).
 */
export function viewRepoFacts(
  repos: ViewRepos | undefined,
  servedDir: string,
): { viewRepo?: string; viewRepos?: string[]; viewCommits?: Record<string, string> } {
  if (!repos) return {};
  const here = [...repos.repos].find(([, t]) => t.projectDir === servedDir)?.[0];
  const commits: Record<string, string> = {};
  for (const [name, t] of repos.repos) {
    const sha = checkoutCommit(t.projectDir);
    if (sha) commits[name] = sha;
  }
  return { ...(here ? { viewRepo: here } : {}), viewRepos: [...repos.repos.keys()], ...(Object.keys(commits).length ? { viewCommits: commits } : {}) };
}
