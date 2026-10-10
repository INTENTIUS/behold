import { describe, it, expect, afterAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";
import { choudoufuWorkspaceVia, joinBlockGraph } from "./choudoufu-workspace.ts";
import { joinLexiconEdges, indexRoster } from "./choudoufu-refs.ts";
import { liveCheckToIr, parseLiveCheck, choudoufuVersion, type Captured } from "./choudoufu-member.ts";
import { composeEstate } from "./estate.ts";
import { resetMemberIrCache } from "./member-ir.ts";
import { readWorkspace, setServedWorkspace, drawnMembers, type WorkspaceMember } from "./workspace.ts";
import { resolvedPackage } from "./terraform-member.ts";
import { linkDemoPins } from "./demo-pins.ts";

// #465. Provenance:
//  - choudoufu-workspace-graph-team-b.json: `chant workspace graph --member
//    team-b --json` (chant 0.102.0, terraform lexicon 0.102.0 pinned) in a copy
//    of example-choudoufu-estate, each node's `source` text and `at` removed.
//  - choudoufu-live-check-team-b.json: `choudoufu live-check -json .` (v0.16.0)
//    in the same copy's team-b.
//  - the terralith pair is choudoufu-refs.test.ts's, its lexicon IR recast in
//    the shape chant's workspace graph names a member's blocks: `<root>/<path>`.
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", name), "utf8")) as T;
const GRAPH = () => fixture<Record<string, unknown>>("choudoufu-workspace-graph-team-b.json");
const CHECK = () => fixture<unknown>("choudoufu-live-check-team-b.json");
const roster = (doc: unknown): GraphIR => {
  const p = parseLiveCheck(doc);
  if (!p.ok) throw new Error("fixture does not parse");
  return liveCheckToIr(p.doc);
};
const member: WorkspaceMember = { name: "team-b", dir: "team-b", kind: "choudoufu", abs: "/w/team-b", reason: null, because: null };
const reader = (doc: Record<string, unknown>) => () => ({ read: async () => doc });
const ok = (stdout: string): Captured => ({ code: 0, stdout, stderr: "" }) as Captured;

describe("joinBlockGraph: chant's block graph onto choudoufu's instance roster (#465)", () => {
  it("joins a terralith's blocks onto its instances exactly as the lexicon join does", () => {
    const lexicon = fixture<GraphIR>("choudoufu-lexicon-terralith.json");
    const asChant = {
      ...lexicon,
      nodes: lexicon.nodes.map((n) => ({ ...n, id: n.id.replace(/^estate\//, "terralith/"), attrs: { ...n.attrs, root: "terralith", line: 7 } })),
      edges: lexicon.edges.map((e) => ({ ...e, from: e.from.replace(/^estate\//, "terralith/"), to: e.to.replace(/^estate\//, "terralith/") })),
    } as GraphIR;
    const ir = roster(fixture("choudoufu-live-check-terralith.json"));
    const expected = joinLexiconEdges(lexicon.edges, indexRoster(ir.nodes.map((n) => n.id)));
    joinBlockGraph(ir, asChant);
    expect(ir.edges).toHaveLength(expected.length);
    expect(new Set(ir.edges.map((e) => `${e.from}>${e.to}`))).toEqual(new Set(expected.map((e) => `${e.from}>${e.to}`)));
    // An expanded block's instances each get the block's place in the source.
    const pod = ir.nodes.find((n) => n.id === 'module.team_pod["pod-a"].aws_iam_role.pod_role[0]')!;
    expect(pod.attrs).toMatchObject({ file: expect.any(String), line: 7 });
  });

  it("keeps the roster's ids, rungs and cross-estate reads, and adds chant's edges and lines", async () => {
    const via = choudoufuWorkspaceVia(member, "/w", {
      reader: reader(GRAPH()) as never,
      run: async (args) => (args[0] === "live-check" ? ok(JSON.stringify(CHECK())) : ok("{}")),
    });
    const ir = await via.read("/w/team-b", {});
    expect(ir.nodes.map((n) => n.id).sort()).toEqual([
      "aws_cloudwatch_log_group.team_b_0",
      "aws_cloudwatch_log_group.team_b_1",
      "aws_cloudwatch_log_group.team_b_2",
      "aws_iam_policy.team_b",
      "aws_iam_role.team_b",
      "aws_iam_role_policy.team_b_inline",
      "aws_iam_role_policy_attachment.team_b",
      "aws_subnet.app",
      "data.aws_vpc.team_a_network",
    ]);
    const subnet = ir.nodes.find((n) => n.id === "aws_subnet.app")!;
    expect(subnet).toMatchObject({ kind: "aws_subnet", lexicon: "choudoufu", attrs: { rung: "tag-governable", estate: "tlmig-sample-team-b", file: "main.tf", line: 70 } });
    // The cross-estate producer is choudoufu's; chant's graph has no such fact.
    expect(ir.nodes.find((n) => n.id === "data.aws_vpc.team_a_network")!.attrs.producer).toEqual({ estate: "tlmig-sample-team-a", address: "aws_vpc.main" });
    const edges = ir.edges.map((e) => `${e.from} -${e.viaAttr}-> ${e.to}`).sort();
    expect(edges).toEqual([
      "aws_iam_role_policy.team_b_inline -role-> aws_iam_role.team_b",
      "aws_iam_role_policy_attachment.team_b -policy_arn-> aws_iam_policy.team_b",
      "aws_iam_role_policy_attachment.team_b -role-> aws_iam_role.team_b",
      "aws_subnet.app -reads-> data.aws_vpc.team_a_network",
    ]);
  });

  it("refuses with choudoufu's words when live-check can't answer", async () => {
    const via = choudoufuWorkspaceVia(member, "/w", { reader: reader(GRAPH()) as never, run: async () => ({ code: 1, stdout: "", stderr: "Error: no estate here" }) as Captured });
    await expect(via.read("/w/team-b", {})).rejects.toThrow(/no estate here/);
  });

  it("refuses with chant's words when the contract can't graph the member", async () => {
    const doc = { ...GRAPH(), members: [{ name: "team-b", dir: "team-b", kind: "choudoufu", status: "failed", reason: { code: "unknown-kind", message: "no pinned package supplies kind choudoufu" } }] };
    const via = choudoufuWorkspaceVia(member, "/w", { reader: reader(doc) as never, run: async () => ok(JSON.stringify(CHECK())) });
    await expect(via.read("/w/team-b", {})).rejects.toThrow(/unknown-kind/);
  });

  it("caches a declared member apart from a loose one", () => {
    const via = choudoufuWorkspaceVia(member, "/w");
    expect(via.tool("/w/team-b").startsWith("workspace\0")).toBe(true);
  });
});

// The whole path, where chant's terraform lexicon and choudoufu are installed
// (neither is in CI): the bundled choudoufu estate, served declared, draws the
// same cards with the same ids and the same edges as served loose, so a
// layout saved on either keeps matching, and the declared cards carry chant's
// file and line.
describe("example-choudoufu-estate, declared against loose (#465)", () => {
  const ready = !!resolvedPackage("@intentius/chant-lexicon-terraform") && !!resolvedPackage("@cdktn/hcl2json") && !!choudoufuVersion();
  const made: string[] = [];
  afterAll(() => {
    setServedWorkspace(undefined);
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  it.skipIf(!ready)("keeps every id and edge, and reads the topology through chant", { timeout: 120_000 }, async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "behold-chdf-ws-")), "estate");
    made.push(join(dir, ".."));
    cpSync(join(import.meta.dirname, "..", "example-choudoufu-estate"), dir, { recursive: true });
    expect(linkDemoPins(dir).ok).toBe(true);
    const read = await readWorkspace(dir);
    if (!read.ok) throw new Error(read.refusal.error);
    const dirs = drawnMembers(read.workspace).map((m) => m.abs);

    resetMemberIrCache();
    setServedWorkspace(undefined);
    const loose = await composeEstate(dirs, { detail: 2 });
    resetMemberIrCache();
    setServedWorkspace(read.workspace);
    const declared = await composeEstate(dirs, { detail: 2 });

    expect(declared.nodes.map((n) => n.id).sort()).toEqual(loose.nodes.map((n) => n.id).sort());
    const edge = (g: GraphIR) => g.edges.map((e) => `${e.from}>${e.to}`).sort();
    expect(edge(declared)).toEqual(edge(loose));
    expect(declared.nodes.find((n) => n.id === "team-b/aws_subnet.app")!.attrs).toMatchObject({ file: "main.tf", line: expect.any(Number) });
    expect(loose.nodes.find((n) => n.id === "team-b/aws_subnet.app")!.attrs.line).toBeUndefined();
  });
});
