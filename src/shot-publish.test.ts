import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SHOTS_BRANCH, LFS_ATTRIBUTES_LINE, LFS_INSTALL_LINE, parsePublishTarget, PublishRefusal, publishShot, rawUrlFor, runGit, shotPathInBranch, type GitRun } from "./shot-publish.ts";

const AUTHOR = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const hasLfs = runGit(["lfs", "version"], { cwd: tmpdir() }).status === 0;

/** git with a test identity. */
const realGit: GitRun = (args, o) => runGit(args, { ...o, env: { ...AUTHOR, ...o.env } });

/** git with LFS faked: `clean` answers a real pointer, `push` answers `pushOk`, nothing is uploaded. */
function fakeLfs({ installed = true, pushOk = true } = {}): GitRun & { pushed: string[] } {
  const pushed: string[] = [];
  const run: GitRun = (args, o) => {
    if (args[0] !== "lfs") return realGit(args, o);
    if (!installed) return { status: 127, stdout: "", stderr: "git: 'lfs' is not a git command" };
    if (args[1] === "version") return { status: 0, stdout: "git-lfs/3.0.0\n", stderr: "" };
    if (args[1] === "clean") {
      const buf = Buffer.from(o.input ?? "");
      const oid = createHash("sha256").update(buf).digest("hex");
      return { status: 0, stdout: `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${buf.length}\n`, stderr: "" };
    }
    if (args[1] === "push") {
      if (!pushOk) return { status: 2, stdout: "", stderr: "batch request: missing protocol" };
      pushed.push(args[args.length - 1]);
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  return Object.assign(run, { pushed });
}

const g = (cwd: string, ...args: string[]) => {
  const r = realGit(args, { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

describe("--publish <remote>[/<branch>] (behold#923)", () => {
  it("reads the remote and the branch, behold-shots by default", () => {
    expect(parsePublishTarget("origin")).toEqual({ remote: "origin", branch: DEFAULT_SHOTS_BRANCH });
    expect(parsePublishTarget("origin/shots/pr-1")).toEqual({ remote: "origin", branch: "shots/pr-1" });
    for (const bad of ["", "/x", "origin/", "origin/a..b", "origin/a b", "origin/-x", "git@github.com:o/r"]) expect(() => parsePublishTarget(bad)).toThrow(/--publish/);
  });

  it("names the raw URL on GitHub and GitLab, at the commit", () => {
    expect(rawUrlFor("https://github.com/o/r.git", "abc", "s.png")).toBe("https://github.com/o/r/raw/abc/s.png");
    expect(rawUrlFor("git@github.com:o/r.git", "abc", "a b.png")).toBe("https://github.com/o/r/raw/abc/a%20b.png");
    expect(rawUrlFor("https://gitlab.com/g/sub/r", "abc", "s.png")).toBe("https://gitlab.com/g/sub/r/-/raw/abc/s.png");
    expect(rawUrlFor("/srv/r.git", "abc", "s.png")).toBeUndefined();
  });

  it("keeps the default name and stamps any other", () => {
    expect(shotPathInBranch("/tmp/behold-shot-2026-01-01T00-00-00-000Z.png")).toBe("behold-shot-2026-01-01T00-00-00-000Z.png");
    expect(shotPathInBranch("/w/x.png", new Date("2026-01-02T03:04:05.006Z"))).toBe("2026-01-02T03-04-05-006Z-x.png");
  });
});

describe("publishShot: git plumbing against a temp bare repo", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** A bare remote, a work repo on `main` with one commit tracking origin/main, and a PNG outside both. */
  function setup() {
    const d = mkdtempSync(join(tmpdir(), "behold-publish-test-"));
    dirs.push(d);
    const bare = join(d, "remote.git");
    const work = join(d, "work");
    g(d, "init", "-q", "--bare", "-b", "main", bare);
    g(d, "init", "-q", "-b", "main", work);
    writeFileSync(join(work, "chant.ts"), "export {};\n");
    g(work, "add", ".");
    g(work, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
    g(work, "remote", "add", "origin", bare);
    g(work, "push", "-q", "-u", "origin", "main");
    const png = join(d, "behold-shot-x.png");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    return { d, bare, work, png };
  }

  it("commits the pointer and .gitattributes to the shots branch, pushes, and leaves the checkout alone", () => {
    const { bare, work, png, d } = setup();
    const head = g(work, "rev-parse", "HEAD");
    const git = fakeLfs();
    const first = publishShot({ png, target: { remote: "origin", branch: "behold-shots" }, repoDir: work, projectDir: work }, git);
    expect(first.path).toBe("behold-shot-x.png");
    expect(first.rawUrl).toBeUndefined();
    expect(g(bare, "rev-parse", "behold-shots")).toBe(first.commit);
    expect(g(bare, "show", `${first.commit}:.gitattributes`)).toBe(LFS_ATTRIBUTES_LINE);
    expect(g(bare, "show", `${first.commit}:behold-shot-x.png`)).toMatch(/^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:[0-9a-f]{64}\nsize 7$/);
    expect(git.pushed).toHaveLength(1);

    // A second shot builds on the branch; .gitattributes is not repeated.
    const png2 = join(d, "other.png");
    writeFileSync(png2, "second");
    const second = publishShot({ png: png2, target: { remote: "origin", branch: "behold-shots" }, repoDir: work }, git);
    expect(g(bare, "rev-parse", `${second.commit}^`)).toBe(first.commit);
    expect(g(bare, "ls-tree", "--name-only", second.commit).split("\n")).toHaveLength(3);
    expect(g(bare, "show", `${second.commit}:.gitattributes`)).toBe(LFS_ATTRIBUTES_LINE);

    // The project's checkout: same HEAD, same branch, clean tree, no local shots branch, main untouched on the remote.
    expect(g(work, "rev-parse", "HEAD")).toBe(head);
    expect(g(work, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(g(work, "status", "--porcelain")).toBe("");
    expect(realGit(["rev-parse", "--verify", "refs/heads/behold-shots"], { cwd: work }).status).not.toBe(0);
    expect(g(bare, "rev-parse", "main")).toBe(head);
  });

  it("refuses without git-lfs, with the setup line", () => {
    const { work, png, bare } = setup();
    const run = () => publishShot({ png, target: { remote: "origin", branch: "behold-shots" }, repoDir: work }, fakeLfs({ installed: false }));
    expect(run).toThrow(PublishRefusal);
    try {
      run();
    } catch (e) {
      expect((e as PublishRefusal).remedy).toBe(LFS_INSTALL_LINE);
    }
    expect(realGit(["rev-parse", "--verify", "behold-shots"], { cwd: bare }).status).not.toBe(0);
  });

  it("refuses a remote that does not take LFS, before the branch is pushed", () => {
    const { work, png, bare } = setup();
    expect(() => publishShot({ png, target: { remote: "origin", branch: "behold-shots" }, repoDir: work }, fakeLfs({ pushOk: false }))).toThrow(/did not take the Git LFS object/);
    expect(realGit(["rev-parse", "--verify", "behold-shots"], { cwd: bare }).status).not.toBe(0);
  });

  it("refuses the checked-out branch, its upstream, an unknown remote and a dir outside git", () => {
    const { work, png, d } = setup();
    expect(() => publishShot({ png, target: { remote: "origin", branch: "main" }, repoDir: work }, fakeLfs())).toThrow(/checked out/);
    g(work, "checkout", "-q", "-b", "feature", "--track", "origin/main");
    expect(() => publishShot({ png, target: { remote: "origin", branch: "main" }, repoDir: work }, fakeLfs())).toThrow(/checked out/);
    expect(() => publishShot({ png, target: { remote: "nope", branch: "behold-shots" }, repoDir: work }, fakeLfs())).toThrow(/no remote 'nope'/);
    const outside = mkdtempSync(join(tmpdir(), "behold-publish-nogit-"));
    dirs.push(outside);
    expect(() => publishShot({ png, target: { remote: "origin", branch: "behold-shots" }, repoDir: outside }, fakeLfs())).toThrow(/not in a git repo/);
    expect(existsSync(join(d, "remote.git", "refs", "heads", "behold-shots"))).toBe(false);
  });

  it.skipIf(!hasLfs)("uploads the object with the real git-lfs", () => {
    const { work, png, bare } = setup();
    const p = publishShot({ png, target: { remote: "origin", branch: "behold-shots" }, repoDir: work }, realGit);
    const oid = /oid sha256:([0-9a-f]{64})/.exec(g(bare, "show", `${p.commit}:${p.path}`))![1];
    expect(existsSync(join(bare, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid))).toBe(true);
  });
});
