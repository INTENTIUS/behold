// behold#931: an org-level workspace (chant#3168), read through fixture documents shaped
// as chant 0.124.47 prints them. No fetch, no forge: the documents are literals.
import { describe, expect, it } from "vitest";
import { ORG_SCOPE_CHANT_FLOOR } from "./chant-floors.ts";
import { orgFloorRefusal, orgReposFromGraph, readOrgRepos } from "./org-workspace.ts";
import { drawnMembers, isOrgWorkspace, setServedWorkspace, undrawnMembers, workspaceFromLs, workspaceMemberOf, type Workspace } from "./workspace.ts";
import { workspaceReader } from "./workspace-reader.ts";

const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "89abcdef0123456789abcdef0123456789abcdef";

const ls = {
  contract: 1,
  chant: "0.124.47",
  workspace: { name: "acme", file: "chant.workspace.json", repo: "https://forge.example/acme/org.git" },
  members: [
    { name: "payments", dir: "@repo/payments", kind: "repo", readable: true, reason: null, repo: { url: "https://forge.example/acme/payments", rev: SHA_A, workspace: "." } },
    { name: "ops", dir: "@repo/ops", kind: "repo", readable: true, reason: null, repo: { url: "git@forge.example:acme/ops.git", rev: SHA_B, workspace: "infra" } },
  ],
};

const graph = {
  contract: 1,
  chant: "0.124.47",
  workspace: { name: "acme", root: ".", repo: "https://forge.example/acme/org.git" },
  members: [
    {
      name: "payments",
      dir: "@repo/payments",
      kind: "repo",
      status: "composed",
      reason: null,
      repo: { url: "https://forge.example/acme/payments", rev: SHA_A, workspace: ".", read: "https://forge.example/acme/payments.git" },
      nested: {
        name: "infra",
        contract: 1,
        members: [
          { name: "api", dir: "api", kind: "chant", status: "composed", reason: null },
          { name: "legacy", dir: "legacy", kind: "other", status: "skipped", reason: { code: "kind-not-run", message: "kind other is not run" } },
        ],
        links: [],
      },
    },
    {
      name: "ops",
      dir: "@repo/ops",
      kind: "repo",
      status: "failed",
      reason: { code: "command-failed", message: `revision ${SHA_B} is not in git@forge.example:acme/ops.git` },
      repo: { url: "git@forge.example:acme/ops.git", rev: SHA_B, workspace: "infra", read: null },
    },
  ],
  nodes: [],
  edges: [],
};

describe("an org workspace's ls (behold#931)", () => {
  it("lists repo members with their reference, and no directory", () => {
    const read = workspaceFromLs(ls, "/srv/org");
    if (!read.ok) throw new Error(read.refusal.error);
    const ws = read.workspace;
    expect(ws.repo).toBe("https://forge.example/acme/org.git");
    expect(isOrgWorkspace(ws)).toBe(true);
    expect(ws.members.map((m) => [m.name, m.kind, m.abs, m.repo])).toEqual([
      ["payments", "repo", "", { url: "https://forge.example/acme/payments", rev: SHA_A, workspace: "." }],
      ["ops", "repo", "", { url: "git@forge.example:acme/ops.git", rev: SHA_B, workspace: "infra" }],
    ]);
    expect(drawnMembers(ws)).toEqual([]);
    expect(undrawnMembers(ws).map((m) => m.name)).toEqual(["payments", "ops"]);
  });

  it("serves it without mapping a repo member to a path", () => {
    const read = workspaceFromLs(ls, "/srv/org");
    if (!read.ok) throw new Error(read.refusal.error);
    setServedWorkspace(read.workspace);
    try {
      expect(workspaceMemberOf("")).toBeUndefined();
      expect(workspaceMemberOf("/srv/org/@repo/payments")).toBeUndefined();
    } finally {
      setServedWorkspace(undefined);
    }
  });

  it("reads an older chant's ls, with no workspace.repo", () => {
    const { repo: _r, ...bare } = ls.workspace;
    const read = workspaceFromLs({ ...ls, workspace: bare }, "/srv/org");
    expect(read.ok && read.workspace.repo).toBe(undefined);
  });
});

describe("the repo members of a workspace graph", () => {
  it("lists each repo, its nested members and chant's reasons as given", () => {
    const read = orgReposFromGraph(graph);
    if (!read.ok) throw new Error(read.refusal.error);
    expect(read.org.repo).toBe("https://forge.example/acme/org.git");
    const [payments, ops] = read.org.repos;
    expect(payments).toMatchObject({ name: "payments", url: "https://forge.example/acme/payments", rev: SHA_A, workspace: ".", status: "composed", reason: null, workspaceName: "infra", read: "https://forge.example/acme/payments.git" });
    expect(payments.label).toBe("infra (https://forge.example/acme/payments.git)");
    expect(payments.members).toEqual([
      { name: "api", kind: "chant", status: "composed", reason: null },
      { name: "legacy", kind: "other", status: "skipped", reason: { code: "kind-not-run", message: "kind other is not run" } },
    ]);
    expect(ops).toMatchObject({ status: "failed", reason: { code: "command-failed", message: expect.stringContaining(SHA_B) }, read: null, workspaceName: null, members: [], label: "git@forge.example:acme/ops.git" });
  });

  it("tells two repositories that declare one workspace name apart by the identity they were read as", () => {
    const twin = (name: string, read: string) => ({ ...graph.members[0], name, repo: { ...graph.members[0].repo, read } });
    const read = orgReposFromGraph({ ...graph, members: [twin("a", "https://f/x/a"), twin("b", "https://f/x/b")] });
    if (!read.ok) throw new Error(read.refusal.error);
    expect(read.org.repos.map((r) => r.label)).toEqual(["infra (https://f/x/a)", "infra (https://f/x/b)"]);
  });

  it("ignores members of other kinds and refuses an error document", () => {
    const read = orgReposFromGraph({ ...graph, members: [...graph.members, { name: "d", kind: "chant", status: "composed" }] });
    expect(read.ok && read.org.repos).toHaveLength(2);
    const bad = orgReposFromGraph({ error: { code: "WSP013", message: "an org workspace holds only repo members" } });
    expect(bad.ok).toBe(false);
  });

  it("is one graph read through the reader, and a document of another contract is refused", async () => {
    const seen: string[][] = [];
    const reader = (doc: unknown) => workspaceReader({ run: async (argv) => (seen.push(argv), { status: 0, stdout: JSON.stringify(doc), stderr: "" }) });
    const ws = { root: "/srv/org" } as Workspace;
    const ok = await readOrgRepos(ws, reader(graph));
    expect(ok.ok).toBe(true);
    expect(seen).toEqual([["workspace", "graph", "/srv/org"]]);
    const old = await readOrgRepos(ws, reader({ ...graph, contract: 2 }));
    expect(old).toMatchObject({ ok: false, refusal: { code: "workspace-contract" } });
  });
});

describe("the floor", () => {
  it("is 0.124.47, and refuses an older chant", () => {
    expect(ORG_SCOPE_CHANT_FLOOR).toBe("0.124.47");
    expect(orgFloorRefusal("0.124.46")).toMatchObject({ code: "chant-too-old", error: expect.stringContaining("0.124.47") });
    expect(orgFloorRefusal("0.124.47")).toBeUndefined();
  });
});
