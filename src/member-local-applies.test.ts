import { describe, expect, it, vi } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { CHANT_RELEASE, PUBLISHED_CHANT } from "./chant-release.ts";
import { floorFor, LEDGER_ROOT_MEMBER_CHANT_FLOOR } from "./chant-floors.ts";
import { memberRunsCard } from "./component-releases.ts";
import { meetsFloor } from "./floor.ts";
import {
  APPLY_RUNS_WHERE,
  LedgerRunsCache,
  ledgerRunsOf,
  LOCAL_APPLIES,
  memberLocalApplies,
  rootMemberWhere,
  unknownRootApplies,
  unknownRootNote,
  withLocalApplies,
} from "./member-local-applies.ts";
import { ledgerRunsArgv, workspaceReader } from "./workspace-reader.ts";
import { ledgerTip } from "./member-ledger.ts";
import { memberLocalApplyReads } from "./server.ts";
import type { GitRun } from "./terragucci-lifecycle.ts";
import type { Workspace } from "./workspace.ts";

// behold#1010: the member run card lists the member's local applies from
// `chant ledger runs --where root_member=<member> --json` (chant#4482,
// chant#4500). A null root_member means unknown (chant#4508).

const COLUMNS = ["member", "id", "op", "env", "started", "ended", "status", "git_sha", "forge", "run_url", "failure_code", "failure_reason", "failed_phase", "gate", "steward", "labels", "outcomes", "root_member"];
const HEAD = { $schema: "https://intentius.io/chant/schemas/workspace/ledger/v1/ledger.schema.json", contract: 1, table: "runs", at: null, malformed: 0 };

const row = (id: string, status: string, ended: string, rootMember: string | null, root = "aws") => ({
  member: "app",
  id,
  op: "apply-aws",
  env: "dev",
  started: ended,
  ended,
  status,
  git_sha: "57192f6aa0000000000000000000000000000000",
  forge: "local",
  run_url: null,
  labels: { Apply: "true", TerraformRoot: root },
  outcomes: rootMember ? { TerraformRootPath: "infra/aws" } : {},
  root_member: rootMember,
});

const doc = (rows: unknown[], where = [rootMemberWhere("aws")]) => ({ ...HEAD, columns: COLUMNS, filter: { where, since: null }, total: rows.length, rows });

describe("reading chant ledger runs (behold#1010)", () => {
  it("reads the member's runs, newest first", () => {
    const answer = ledgerRunsOf(doc([row("r1", "ok", "2026-10-24T10:00:00Z", "aws"), row("r2", "failed", "2026-10-25T10:00:00Z", "aws")]));
    expect(answer.supported).toBe(true);
    const runs = memberLocalApplies(answer, "aws");
    expect(runs.map((r) => r.runId)).toEqual(["r2", "r1"]);
    expect(runs[1]).toMatchObject({ op: "apply-aws", declaredBy: "app", root: "aws", rootMember: "aws", status: "ok", forge: "local" });
  });

  it("feature-detects root_member: a runs table without it is not supported, never empty", () => {
    const old = { ...doc([]), columns: COLUMNS.filter((c) => c !== "root_member") };
    expect(ledgerRunsOf(old)).toEqual({ supported: false, reason: "this chant's ledger runs carry no root_member" });
    expect(memberLocalApplies(ledgerRunsOf(old), "aws")).toEqual([]);
  });

  it("reads chant's refusal as not supported", () => {
    const refused = { ...HEAD, error: { code: "filter-invalid", message: "no field root_member" } };
    expect(ledgerRunsOf(refused)).toMatchObject({ supported: false });
  });

  it("reads a null root_member as unknown: on no member's card, and in the unknown-root note", () => {
    const answer = ledgerRunsOf(doc([row("r1", "ok", "2026-10-24T10:00:00Z", "aws"), row("r3", "failed", "2026-10-26T10:00:00Z", null, "net")], [APPLY_RUNS_WHERE]));
    expect(memberLocalApplies(answer, "aws").map((r) => r.runId)).toEqual(["r1"]);
    // Never the declaring member's either.
    expect(memberLocalApplies(answer, "app")).toEqual([]);
    const unknown = unknownRootApplies(answer);
    expect(unknown.map((r) => r.runId)).toEqual(["r3"]);
    expect(unknownRootNote(unknown)).toBe("1 local apply of an unknown root (net)");
    expect(unknownRootNote([])).toBeUndefined();
  });

  it("keeps an http(s) run_url only", () => {
    const runs = memberLocalApplies(ledgerRunsOf(doc([{ ...row("r1", "ok", "2026-10-24T10:00:00Z", "aws"), run_url: "https://ci.example/run/1" }, { ...row("r2", "ok", "2026-10-23T10:00:00Z", "aws"), run_url: "javascript:alert(1)" }])), "aws");
    expect(runs[0]!.url).toBe("https://ci.example/run/1");
    expect(runs[1]!.url).toBeUndefined();
  });
});

describe("the member run card's local applies (behold#1010)", () => {
  const ir = (): GraphIR => ({ nodes: [{ ...memberRunsCard("choudoufu"), id: "aws/choudoufu" }, { ...memberRunsCard("terraform"), id: "net/terraform" }], edges: [], groups: {} }) as unknown as GraphIR;

  it("lists the runs and leads with the newest that passed", () => {
    const runs = memberLocalApplies(ledgerRunsOf(doc([row("r1", "ok", "2026-10-24T10:00:00Z", "aws"), row("r2", "failed", "2026-10-25T10:00:00Z", "aws")])), "aws");
    const { ir: out, applied } = withLocalApplies(ir(), new Map([["aws", runs]]));
    expect(applied).toBe(1);
    const card = out.nodes.find((n) => n.id === "aws/choudoufu")!;
    expect((card.attrs[LOCAL_APPLIES] as Array<{ runId: string }>).map((r) => r.runId)).toEqual(["r2", "r1"]);
    expect(card.attrs.local).toBe("aws ok 57192f6 · 2026-10-24");
    // A member with no read keeps its card as the run index left it.
    expect(out.nodes.find((n) => n.id === "net/terraform")!.attrs).toEqual({ engine: "terraform" });
  });

  it("says so when the ledger names no run, or none that passed", () => {
    const failed = memberLocalApplies(ledgerRunsOf(doc([row("r2", "failed", "2026-10-25T10:00:00Z", "aws")])), "aws");
    const { ir: out } = withLocalApplies(ir(), new Map([["aws", failed], ["net", []]]));
    expect(out.nodes.find((n) => n.id === "aws/choudoufu")!.attrs.local).toBe("none passed (1 run)");
    expect(out.nodes.find((n) => n.id === "net/terraform")!.attrs.local).toBe("none in the ledger");
  });
});

describe("the read and its floor (behold#1010)", () => {
  it("runs `ledger runs --where <filter> --json` at the workspace root and hands back the document", async () => {
    expect(ledgerRunsArgv([rootMemberWhere("aws")])).toEqual(["ledger", "runs", "--where", "root_member=aws", "--json"]);
    const printed = doc([]);
    const calls: string[][] = [];
    const reader = workspaceReader({ run: async (argv) => (calls.push(argv), { status: 0, stdout: JSON.stringify(printed), stderr: "" }) });
    expect(await reader.readLedgerRuns([rootMemberWhere("aws")])).toEqual(printed);
    expect(calls).toEqual([["ledger", "runs", "--where", "root_member=aws", "--json"]]);
  });

  it("is floored at the chant release, which published chant does not meet while it is unreleased", () => {
    expect(LEDGER_ROOT_MEMBER_CHANT_FLOOR).toBe(CHANT_RELEASE.version);
    expect(floorFor("local applies per member").degraded).toBeTruthy();
    if (!CHANT_RELEASE.released) expect(meetsFloor(PUBLISHED_CHANT, LEDGER_ROOT_MEMBER_CHANT_FLOOR)).toBe(false);
    expect(meetsFloor(CHANT_RELEASE.version, LEDGER_ROOT_MEMBER_CHANT_FLOOR)).toBe(true);
  });
});

describe("the ledger reads, cached on the ledger tip (behold#1020)", () => {
  const scope = { root: "/ws", chant: "0.124.53" };
  const answer = (id: string) => ledgerRunsOf({ ...HEAD, columns: COLUMNS, rows: [row(id, "ok", "2026-10-26T10:00:00Z", "net")] });
  const TIP_A = "a".repeat(40);
  const TIP_B = "b".repeat(40);

  it("reuses a read while the tip holds, and reads again when the branch moves", async () => {
    const cache = new LedgerRunsCache();
    const load = vi.fn(async () => answer("r1"));
    await cache.read(scope, TIP_A, ["root_member=net"], load);
    await cache.read(scope, TIP_A, ["root_member=net"], load);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.read(scope, TIP_B, ["root_member=net"], load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keys on the where, the root and the chant", async () => {
    const cache = new LedgerRunsCache();
    const load = vi.fn(async () => answer("r1"));
    await cache.read(scope, TIP_A, ["root_member=net"], load);
    await cache.read(scope, TIP_A, ["root_member=app"], load);
    await cache.read({ ...scope, root: "/other" }, TIP_A, ["root_member=net"], load);
    await cache.read({ ...scope, chant: "0.124.54" }, TIP_A, ["root_member=net"], load);
    expect(load).toHaveBeenCalledTimes(4);
    expect(cache.size).toBe(4);
  });

  it("with no tip, keeps a read for the releases TTL only", async () => {
    let now = 1_000;
    const cache = new LedgerRunsCache(() => now);
    const load = vi.fn(async () => answer("r1"));
    await cache.read(scope, null, [APPLY_RUNS_WHERE], load);
    now += 29_000;
    await cache.read(scope, null, [APPLY_RUNS_WHERE], load);
    expect(load).toHaveBeenCalledTimes(1);
    now += 2_000;
    await cache.read(scope, null, [APPLY_RUNS_WHERE], load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never keeps a failed read or a chant that does not say", async () => {
    const cache = new LedgerRunsCache();
    const failing = vi.fn(async (): Promise<ReturnType<typeof ledgerRunsOf>> => {
      throw new Error("chant exited 1");
    });
    expect(await cache.read(scope, TIP_A, ["root_member=net"], failing)).toBeUndefined();
    expect(cache.size).toBe(0);
    const old = vi.fn(async () => ledgerRunsOf({ ...HEAD, columns: COLUMNS.filter((c) => c !== "root_member"), rows: [] }));
    expect((await cache.read(scope, TIP_A, ["root_member=net"], old))?.supported).toBe(false);
    expect(cache.size).toBe(0);
    await cache.read(scope, TIP_A, ["root_member=net"], old);
    expect(old).toHaveBeenCalledTimes(2);
  });

  it("ledgerTip reads the local chant/lifecycle branch, and is null without one", async () => {
    const seen: string[][] = [];
    const git = (stdout: string, code = 0): GitRun => async (args) => (seen.push(args), { code, stdout, stderr: "" });
    expect(await ledgerTip("/ws", git(TIP_A + "\n"))).toBe(TIP_A);
    expect(seen[0]).toEqual(["-C", "/ws", "rev-parse", "--verify", "--quiet", "refs/heads/chant/lifecycle^{commit}"]);
    expect(await ledgerTip("/ws", git("", 1))).toBeNull();
    expect(await ledgerTip("/ws", git("not a sha"))).toBeNull();
    expect(await ledgerTip("/ws", async () => Promise.reject(new Error("no git")))).toBeNull();
  });

  it("a second components read on an unchanged tip spawns no chant", async () => {
    const ws: Workspace = { name: "estate", root: "/ws", file: "chant.workspace.json", chant: LEDGER_ROOT_MEMBER_CHANT_FLOOR, members: [] };
    const readLedgerRuns = vi.fn(async (where: string[]) => ({ ...HEAD, columns: COLUMNS, rows: where[0] === APPLY_RUNS_WHERE ? [row("u1", "ok", "2026-10-26T09:00:00Z", null)] : [row("r1", "ok", "2026-10-26T10:00:00Z", where[0]!.slice("root_member=".length))] }));
    let tip = TIP_A;
    const deps = { cache: new LedgerRunsCache(), git: (async () => ({ code: 0, stdout: tip, stderr: "" })) as GitRun, reader: { readLedgerRuns } };
    const first = await memberLocalApplyReads(ws, ["net", "app"], deps);
    expect(readLedgerRuns).toHaveBeenCalledTimes(3);
    expect([...first.byMember.keys()].sort()).toEqual(["app", "net"]);
    expect(first.note).toMatch(/1 local apply of an unknown root/);
    const second = await memberLocalApplyReads(ws, ["net", "app"], deps);
    expect(readLedgerRuns).toHaveBeenCalledTimes(3);
    expect(second).toEqual(first);
    tip = TIP_B;
    await memberLocalApplyReads(ws, ["net", "app"], deps);
    expect(readLedgerRuns).toHaveBeenCalledTimes(6);
  });
});

