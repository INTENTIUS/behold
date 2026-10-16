// behold#571 `serve --repos`: one checkout per request, by name, and nothing else.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { checkoutCommit, listCheckouts, repoName, scopeServedDirs, viewRepoFacts, viewReposMiddleware, type ViewRepos } from "./view-repos.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("repoName", () => {
  it("takes a checkout name, or the last segment of <owner>/<name>", () => {
    expect(repoName("demo-terragrunt")).toBe("demo-terragrunt");
    expect(repoName("terragucci-admin/demo-terragrunt")).toBe("demo-terragrunt");
    expect(repoName("demo.git")).toBe("demo");
  });
  it("is no name for a path segment that could walk", () => {
    expect(repoName("..")).toBeUndefined();
    expect(repoName("a/")).toBeUndefined();
    expect(repoName(".git")).toBeUndefined();
  });
});

describe("listCheckouts", () => {
  it("lists the git checkouts directly under the parent", () => {
    const parent = mkdtempSync(join(tmpdir(), "behold-repos-test-"));
    made.push(parent);
    mkdirSync(join(parent, "demo", ".git"), { recursive: true });
    mkdirSync(join(parent, "demo-terragrunt", ".git"), { recursive: true });
    mkdirSync(join(parent, "not-a-checkout"));
    expect(listCheckouts(parent).map((c) => c.name)).toEqual(["demo", "demo-terragrunt"]);
  });
});

describe("checkoutCommit (behold#571)", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const repo = (head: string, files: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "behold-commit-test-"));
    made.push(dir);
    mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), head);
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, ".git", f), text);
    return dir;
  };
  it("reads a detached HEAD, a branch's loose ref and a packed one", () => {
    expect(checkoutCommit(repo(`${A}\n`))).toBe(A);
    expect(checkoutCommit(repo("ref: refs/heads/main\n", { "refs/heads/main": `${B}\n` }))).toBe(B);
    expect(checkoutCommit(repo("ref: refs/heads/main\n", { "packed-refs": `# pack-refs with: peeled\n${A} refs/heads/main\n` }))).toBe(A);
  });
  it("is undefined for what it can't read", () => {
    expect(checkoutCommit(repo("ref: refs/heads/gone\n"))).toBeUndefined();
    expect(checkoutCommit(repo("ref: refs/../../etc/passwd\n"))).toBeUndefined();
    expect(checkoutCommit(join(tmpdir(), "behold-no-such-checkout"))).toBeUndefined();
  });
  it("is on /api/project for each served checkout it can read", () => {
    const one = repo(`${A}\n`);
    const repos: ViewRepos = { parent: "/", repos: new Map([["demo", { projectDir: one }], ["demo.change", { projectDir: "/nowhere" }]]) };
    expect(viewRepoFacts(repos, one)).toEqual({ viewRepo: "demo", viewRepos: ["demo", "demo.change"], viewCommits: { demo: A } });
  });
});

describe("the request's repo", () => {
  const repos: ViewRepos = {
    parent: "/view",
    repos: new Map([
      ["demo", { projectDir: "/view/demo", projectDirs: ["/view/demo"] }],
      ["demo-terragrunt", { projectDir: "/view/demo-terragrunt", projectDirs: ["/view/demo-terragrunt"] }],
    ]),
    defaultName: "demo",
  };
  const app = () => {
    const cfg: { projectDir: string; projectDirs?: string[] } = { projectDir: "/view/demo", projectDirs: ["/view/demo"] };
    scopeServedDirs(cfg);
    const a = new Hono();
    viewReposMiddleware(a, repos);
    a.get("/api/project", async (c) => {
      await new Promise((r) => setTimeout(r, 1));
      return c.json({ projectDir: cfg.projectDir, projectDirs: cfg.projectDirs, ...viewRepoFacts(repos, cfg.projectDir) });
    });
    return { a, cfg };
  };

  it("serves the command line's directory without one, and the named checkout with one", async () => {
    const { a, cfg } = app();
    expect(await (await a.request("/api/project")).json()).toEqual({ projectDir: "/view/demo", projectDirs: ["/view/demo"], viewRepo: "demo", viewRepos: ["demo", "demo-terragrunt"] });
    const tg = await (await a.request("/api/project?repo=terragucci-admin/demo-terragrunt")).json();
    expect(tg).toMatchObject({ projectDir: "/view/demo-terragrunt", viewRepo: "demo-terragrunt" });
    // Outside a request, the default again.
    expect(cfg.projectDir).toBe("/view/demo");
  });

  it("refuses a name it doesn't serve, and a path, before any route runs", async () => {
    const { a } = app();
    for (const q of ["nope", "../demo", "%2Fetc%2Fpasswd", "demo/../../etc"]) {
      const r = await a.request(`/api/project?repo=${q}`);
      if (q === "../demo") {
        // The last segment is a served name; nothing of the rest is read.
        expect(r.status).toBe(200);
        continue;
      }
      expect(r.status).toBe(404);
      expect(await r.json()).toMatchObject({ code: "view-repo" });
    }
  });

  it("lets a project switch set the default", () => {
    const cfg: { projectDir: string; projectDirs?: string[] } = { projectDir: "/a" };
    scopeServedDirs(cfg);
    cfg.projectDir = "/b";
    cfg.projectDirs = ["/b"];
    expect(cfg.projectDir).toBe("/b");
    expect(cfg.projectDirs).toEqual(["/b"]);
  });
});
