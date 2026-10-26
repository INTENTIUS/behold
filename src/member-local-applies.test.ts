import { describe, expect, it } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { CHANT_RELEASE, PUBLISHED_CHANT } from "./chant-release.ts";
import { floorFor, LEDGER_ROOT_MEMBER_CHANT_FLOOR } from "./chant-floors.ts";
import { memberRunsCard } from "./component-releases.ts";
import { meetsFloor } from "./floor.ts";
import {
  APPLY_RUNS_WHERE,
  ledgerRunsOf,
  LOCAL_APPLIES,
  memberLocalApplies,
  rootMemberWhere,
  unknownRootApplies,
  unknownRootNote,
  withLocalApplies,
} from "./member-local-applies.ts";
import { ledgerRunsArgv, workspaceReader } from "./workspace-reader.ts";

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
