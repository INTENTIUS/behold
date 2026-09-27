import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  drawnMembers,
  findDeclaration,
  parseWorkspaceLs,
  setServedWorkspace,
  undrawnMembers,
  unreadableMemberIr,
  unreadableMembers,
  workspaceMemberOf,
  LS_SCHEMA_ID,
  memberIrFromWorkspaceGraph,
  WorkspaceMemberError,
  workspaceGraphArgs,
  workspaceGraphTakes,
} from "./workspace.ts";

// #464: the declared half of serving. The listing is chant's (`workspace ls
// --json`, read contract 1); these pin what behold takes from it and the one
// check it never skips, the contract version.

const member = (name: string, kind: string, reason: { code: string; message: string } | null = null) => ({
  name,
  dir: name,
  kind,
  roles: [],
  upstream: null,
  because: kind === "other" ? "not read by chant" : null,
  readable: reason === null,
  reason,
  records: [],
});

const ls = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    $schema: LS_SCHEMA_ID,
    contract: 1,
    chant: "0.95.0",
    at: null,
    workspace: { name: "acme", root: ".", file: "chant.workspace.json", schema: 1, minReader: null, pins: [], records: [] },
    members: [
      member("api", "chant"),
      member("network", "terraform"),
      member("prod", "choudoufu"),
      member("docs", "other"),
      member("gone", "chant", { code: "dir-missing", message: "the member's directory does not exist" }),
      member("legacy", "flux", { code: "unknown-kind", message: "no installed kind is named flux" }),
    ],
    groups: [],
    ...extra,
  });

afterEach(() => setServedWorkspace(undefined));

describe("parseWorkspaceLs", () => {
  it("reads every member, with absolute dirs and chant's reason", () => {
    const read = parseWorkspaceLs(ls(), "/w");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.workspace.name).toBe("acme");
    expect(read.workspace.root).toBe("/w");
    expect(read.workspace.members.map((m) => [m.name, m.kind, m.abs])).toEqual([
      ["api", "chant", "/w/api"],
      ["network", "terraform", "/w/network"],
      ["prod", "choudoufu", "/w/prod"],
      ["docs", "other", "/w/docs"],
      ["gone", "chant", "/w/gone"],
      ["legacy", "flux", "/w/legacy"],
    ]);
    expect(read.workspace.members[4].reason).toEqual({ code: "dir-missing", message: "the member's directory does not exist" });
  });

  it("refuses any contract but 1, and a document with none", () => {
    for (const contract of [2, undefined, "1"]) {
      const read = parseWorkspaceLs(ls({ contract }), "/w");
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.refusal.code).toBe("workspace-contract");
    }
  });

  it("passes chant's own error code through when the declaration can't be read", () => {
    const text = JSON.stringify({ $schema: LS_SCHEMA_ID, contract: 1, chant: "0.95.0", error: { code: "declaration-invalid", message: "members[0].name repeats", location: null } });
    const read = parseWorkspaceLs(text, "/w");
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.refusal.code).toBe("declaration-invalid");
      expect(read.refusal.error).toContain("members[0].name repeats");
    }
  });

  it("ignores fields it does not know", () => {
    const read = parseWorkspaceLs(ls({ somethingNew: { a: 1 } }), "/w");
    expect(read.ok).toBe(true);
  });

  it("refuses output that is not a listing", () => {
    expect(parseWorkspaceLs("not json", "/w").ok).toBe(false);
    expect(parseWorkspaceLs(JSON.stringify({ contract: 1 }), "/w").ok).toBe(false);
  });
});

describe("which members draw", () => {
  const read = parseWorkspaceLs(ls(), "/w");
  if (!read.ok) throw new Error("fixture");
  const ws = read.workspace;

  it("draws readable members of a kind with a box", () => {
    expect(drawnMembers(ws).map((m) => m.name)).toEqual(["api", "network", "prod"]);
  });

  it("draws an unreadable member as unreadable, not missing", () => {
    expect(unreadableMembers(ws).map((m) => m.name)).toEqual(["gone", "legacy"]);
    const ir = unreadableMemberIr(unreadableMembers(ws)[0]) as unknown as { nodes: { attrs: Record<string, unknown> }[] };
    expect(ir.nodes).toHaveLength(1);
    expect(ir.nodes[0].attrs._unreadable).toEqual({ code: "dir-missing", message: "the member's directory does not exist" });
    expect(ir.nodes[0].attrs._status).toBe("neutral");
  });

  it("lists other members and draws no box for them", () => {
    expect(undrawnMembers(ws).map((m) => m.name)).toEqual(["docs"]);
  });

  it("answers which member a served directory is", () => {
    setServedWorkspace(ws);
    expect(workspaceMemberOf("/w/network")?.name).toBe("network");
    expect(workspaceMemberOf("/w/network/")?.name).toBe("network");
    expect(workspaceMemberOf("/elsewhere")).toBeUndefined();
  });
});

describe("findDeclaration", () => {
  it("finds either spelling and refuses both", () => {
    const dir = mkdtempSync(join(tmpdir(), "behold-ws-"));
    expect(findDeclaration(dir)).toBeUndefined();
    writeFileSync(join(dir, "chant.workspace.jsonc"), "{}");
    expect(findDeclaration(dir)).toEqual({ file: "chant.workspace.jsonc" });
    writeFileSync(join(dir, "chant.workspace.json"), "{}");
    expect(findDeclaration(dir)).toEqual({ ambiguous: true });
  });
});

describe("memberIrFromWorkspaceGraph", () => {
  const doc = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      $schema: "https://intentius.io/chant/schemas/workspace/graph/v1/graph.schema.json",
      contract: 1,
      chant: "0.95.0",
      at: null,
      version: 1,
      workspace: { name: "acme", root: "." },
      members: [
        { name: "api", dir: "api", kind: "chant", status: "composed", reason: null, chant: "0.95.0", irVersion: 1, meta: { _behaviour: { x: 1 } } },
        { name: "db", dir: "db", kind: "chant", status: "composed", reason: null, chant: "0.95.0", irVersion: 1 },
        { name: "net", dir: "net", kind: "terraform", status: "failed", reason: { code: "command-failed", message: "no lexicon" }, chant: null, irVersion: null },
      ],
      nodes: [
        { id: "api/Fn", kind: "Function", lexicon: "aws", member: "api", attrs: { role: { $ref: "api/Role" }, _drift: "in-sync" }, runtimeOwner: "api/Role" },
        { id: "api/Role", kind: "Role", lexicon: "aws", member: "api", attrs: {} },
        { id: "db/Table", kind: "Table", lexicon: "aws", member: "db", attrs: {} },
      ],
      edges: [
        { from: "api/Fn", to: "api/Role", member: "api" },
        { from: "db/Table", to: "db/Table", member: "db" },
      ],
      groups: { byMember: { api: ["api/Fn", "api/Role"], db: ["db/Table"] }, byLexicon: { aws: ["api/Fn", "api/Role", "db/Table"] }, byStack: { "api/web": ["api/Fn"], "db/data": ["db/Table"] } },
      exports: [{ name: "RoleArn", node: "api/Role", member: "api" }],
      imports: [],
      links: [],
      records: [],
      ...extra,
    });

  it("takes one member's part back out, in the member's own ids", () => {
    const ir = memberIrFromWorkspaceGraph(doc(), "api") as unknown as Record<string, any>;
    expect(ir.nodes.map((n: any) => n.id)).toEqual(["Fn", "Role"]);
    expect(ir.nodes[0].attrs).toEqual({ role: { $ref: "Role" }, _drift: "in-sync" });
    expect(ir.nodes[0].runtimeOwner).toBe("Role");
    expect(ir.nodes[0].member).toBeUndefined();
    expect(ir.edges).toEqual([{ from: "Fn", to: "Role" }]);
    expect(ir.groups).toEqual({ byLexicon: { aws: ["Fn", "Role"] }, byStack: { web: ["Fn"] } });
    expect(ir.exports).toEqual([{ name: "RoleArn", node: "Role" }]);
    expect(ir.meta).toEqual({ _behaviour: { x: 1 } });
  });

  it("carries chant's reason for a member it could not read", () => {
    expect(() => memberIrFromWorkspaceGraph(doc(), "net")).toThrow(WorkspaceMemberError);
    expect(() => memberIrFromWorkspaceGraph(doc(), "net")).toThrow(/command-failed: no lexicon/);
  });

  it("refuses another contract, and a failure document", () => {
    expect(() => memberIrFromWorkspaceGraph(doc({ contract: 2 }), "api")).toThrow(/contract 2/);
    expect(() => memberIrFromWorkspaceGraph(JSON.stringify({ contract: 1, error: { code: "declaration-invalid", message: "x" } }), "api")).toThrow(/declaration-invalid/);
  });

  it("reads a document chant 0.94 wrote", () => {
    const text = readFileSync(join(__dirname, "__fixtures__/workspace-graph-reference.json"), "utf8");
    const ir = memberIrFromWorkspaceGraph(text, "delivery") as unknown as Record<string, any>;
    expect(ir.nodes.map((n: any) => n.id)).toEqual(["appService"]);
  });

  it("passes only the flags the contract takes", () => {
    expect(workspaceGraphArgs("/w", "api", { env: "prod", live: true, overlay: true, traffic: "peak" })).toEqual([
      "workspace", "graph", "/w", "--member", "api", "--env", "prod", "--live", "--overlay", "--traffic", "peak",
    ]);
    expect(workspaceGraphTakes({ env: "prod", live: true })).toBe(true);
    expect(workspaceGraphTakes({ detail: 1 })).toBe(false);
    expect(workspaceGraphTakes({ lens: "k8s" })).toBe(false);
  });
});

describe("the root member's stamp (#464)", () => {
  it("leaves the other members' directories out", async () => {
    const { memberSourceStamp } = await import("./member-source.ts");
    const root = mkdtempSync(join(tmpdir(), "behold-ws-stamp-"));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(root, "api"));
    writeFileSync(join(root, "chant.config.ts"), "export default {};");
    writeFileSync(join(root, "api/a.ts"), "1");
    const text = JSON.stringify({ contract: 1, chant: "0.95.0", workspace: { name: "w" }, members: [member(".", "chant"), member("api", "chant")] });
    const read = parseWorkspaceLs(text.replace('"name":".","dir":"."', '"name":"root","dir":"."'), root);
    if (!read.ok) throw new Error(read.refusal.error);
    const before = memberSourceStamp(root);
    setServedWorkspace(read.workspace);
    const scoped = memberSourceStamp(root);
    writeFileSync(join(root, "api/a.ts"), "22");
    expect(memberSourceStamp(root)).toBe(scoped);
    expect(memberSourceStamp(join(root, "api"))).not.toBeUndefined();
    setServedWorkspace(undefined);
    expect(memberSourceStamp(root)).not.toBe(before);
  });
});
