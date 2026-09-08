import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REFUSAL_CODES,
  discoverCarvePlans,
  dryRunArgs,
  handoffLine,
  moveMembers,
  moveReceipt,
  movesPayload,
  parseCarvePlan,
  parseLiveMv,
  readCarvePlan,
  type CarvePlan,
  type MoveMember,
} from "./choudoufu-moves.ts";

// Fixture provenance (#371). The three live-mv documents were printed by a
// choudoufu built from main at `9c7d3701e2` against a scratch floci with the
// live-mv workbench's monolith applied: the cross-estate move of
// `aws_iam_role.team_a` into a `tlmig-sample-team-a` copy as a dry run and
// then for real, and a refused move of `aws_iam_role.team_b` into the same
// destination, which does not declare it. `choudoufu-carve-plan.json` is
// hand-written in the workbench planner's shape (`tlmig/carve.py`).
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (name: string): string => readFileSync(join(HERE, "__fixtures__", name), "utf8");
const plan = (): CarvePlan => {
  const p = parseCarvePlan(JSON.parse(raw("choudoufu-carve-plan.json")));
  if (!p.ok) throw new Error(p.refusal.error);
  return p.plan;
};
const members: MoveMember[] = [
  { name: "mono", dir: "/est/mono", estate: "tlmig-sample-monolith" },
  { name: "team-a", dir: "/est/team-a", estate: "tlmig-sample-team-a" },
];

describe("the plan (#371)", () => {
  it("reads the workbench's carve.json shape; rules are carried, not acted on", () => {
    const p = plan();
    expect(p.from).toBe("tlmig-sample-monolith");
    expect(p.estates).toEqual(["tlmig-sample-team-a"]);
    expect(p.moves).toHaveLength(4);
    expect(p.rules).toHaveLength(1);
  });

  it("fills from and estates from the moves when the file omits them, and refuses what is not a plan", () => {
    const bare = parseCarvePlan({ moves: [{ address: "aws_vpc.x", from: "a", to: "b" }] });
    expect(bare).toMatchObject({ ok: true, plan: { from: "a", estates: ["b"] } });
    expect(parseCarvePlan([])).toMatchObject({ ok: false, refusal: { error: expect.stringContaining("not a JSON object") } });
    expect(parseCarvePlan({ rules: [] })).toMatchObject({ ok: false, refusal: { error: expect.stringContaining("no `moves` array") } });
    expect(parseCarvePlan({ moves: [{ address: "x" }] })).toMatchObject({ ok: false, refusal: { error: "moves[0] is not a move (needs string `address`, `from` and `to`)." } });
  });

  it("readCarvePlan refuses an unreadable file and non-JSON politely", () => {
    expect(readCarvePlan("/nope/carve.json")).toMatchObject({ ok: false, refusal: { error: expect.stringContaining("Couldn't read") } });
    expect(readCarvePlan("x", () => "{")).toMatchObject({ ok: false, refusal: { error: expect.stringContaining("is not JSON") } });
    expect(readCarvePlan("x", () => raw("choudoufu-carve-plan.json")).ok).toBe(true);
  });

  it("discovers carve.json at a member's root, relative to the base the SPA hands back", () => {
    const root = mkdtempSync(join(tmpdir(), "behold-plans-"));
    try {
      mkdirSync(join(root, "a"));
      mkdirSync(join(root, "b"));
      writeFileSync(join(root, "a", "carve.json"), "{}");
      expect(discoverCarvePlans([join(root, "a"), join(root, "b")], join(root, "a"))).toEqual(["carve.json"]);
      expect(discoverCarvePlans([join(root, "a"), join(root, "b")], join(root, "b"))).toEqual([join("..", "a", "carve.json")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("live-mv's document (#371)", () => {
  it("accepts the recorded dry run, the real run and the refusal — one document on every outcome", () => {
    const dry = parseLiveMv({ code: 0, stdout: raw("choudoufu-live-mv-cross-estate-dry-run.json"), stderr: "" }, "dry");
    expect(dry).toMatchObject({ ok: true, doc: { dry_run: true, written: false, verified: false, found_by: "IDENTITY", followers: [{ address: "aws_iam_role_policy.team_a_inline" }, { address: "aws_iam_role_policy_attachment.team_a" }] } });
    const real = parseLiveMv({ code: 0, stdout: raw("choudoufu-live-mv-cross-estate.json"), stderr: "" }, "real");
    expect(real).toMatchObject({ ok: true, doc: { dry_run: false, written: true, verified: true } });
    // request_id is absent, not empty: the provider protocol carries none.
    if (real.ok) expect("request_id" in real.doc).toBe(false);
    const refused = parseLiveMv({ code: 1, stdout: raw("choudoufu-live-mv-refused.json"), stderr: "" }, "refused");
    expect(refused).toMatchObject({ ok: true, doc: { refusal: { code: "destination_not_declared", summary: "Destination address missing from the configuration" } } });
    if (refused.ok) expect(REFUSAL_CODES).toContain(refused.doc.refusal!.code);
    expect(REFUSAL_CODES).toEqual(["nothing_at_old_address", "two_at_old_address", "new_address_claimed", "destination_not_declared", "plan_changes_more_than_tags"]);
  });

  it("empty stdout is not a document; 127 is no binary", () => {
    expect(parseLiveMv({ code: 2, stdout: "", stderr: "Usage:" }, "x")).toMatchObject({ ok: false, refusal: { error: expect.stringContaining("printed no document") } });
    expect(parseLiveMv({ code: 127, stdout: "", stderr: "" }, "x")).toMatchObject({ ok: false, refusal: { error: "choudoufu is not on PATH." } });
  });
});

describe("the handoff (#371)", () => {
  it("the line a person runs, in the destination's directory; a rename carries the new address", () => {
    expect(handoffLine({ address: "aws_iam_role.team_a", from: "mono", to: "team-a" })).toBe("choudoufu live-mv -from-estate=mono aws_iam_role.team_a aws_iam_role.team_a");
    expect(handoffLine({ address: "aws_vpc.old", from: "mono", to: "net", new_address: "aws_vpc.main" })).toBe("choudoufu live-mv -from-estate=mono aws_vpc.old aws_vpc.main");
  });

  it("the only spelling of live-mv behold runs is the dry run — asserted on the argv, not the prose", () => {
    const args = dryRunArgs({ address: "aws_iam_role.team_a", from: "mono", to: "team-a" });
    expect(args).toEqual(["live-mv", "-json", "-dry-run", "-from-estate=mono", "aws_iam_role.team_a", "aws_iam_role.team_a"]);
    expect(args).toContain("-dry-run");
  });

  it("movesPayload: a preview per move, the destination when served, the dry run when asked, and the apply note on the wire", async () => {
    const spawns: [string[], string][] = [];
    const run = async (args: string[], cwd: string) => {
      spawns.push([args, cwd]);
      const stdout = args[4] === "aws_iam_role.team_b" ? raw("choudoufu-live-mv-refused.json") : raw("choudoufu-live-mv-cross-estate-dry-run.json");
      return { code: 0, stdout, stderr: "" };
    };
    const payload = await movesPayload(plan(), members, { dryRun: true, run });
    expect(payload.plan).toEqual({ from: "tlmig-sample-monolith", estates: ["tlmig-sample-team-a"], moves: 4, rules: 1 });
    expect(payload.apply).toEqual({ human: true, note: expect.stringContaining("never runs the write") });
    const role = payload.moves[0]!;
    expect(role).toMatchObject({ address: "aws_iam_role.team_a", destination: { member: "team-a", dir: "/est/team-a" }, source: { member: "mono" }, command: "choudoufu live-mv -from-estate=tlmig-sample-monolith aws_iam_role.team_a aws_iam_role.team_a", runIn: "/est/team-a" });
    expect(role.dryRun).toMatchObject({ dry_run: true, followers: [{ address: "aws_iam_role_policy.team_a_inline" }, {}] });
    // A destination that is not served: the line still, no spawn, and where to run it said in words.
    const teamB = payload.moves[3]!;
    expect(teamB.destination).toBeUndefined();
    expect(teamB.dryRun).toBeUndefined();
    expect(teamB.runIn).toContain("not served here");
    // Every spawn was a dry run, in the destination's directory.
    expect(spawns).toHaveLength(3);
    for (const [args, cwd] of spawns) {
      expect(args[0]).toBe("live-mv");
      expect(args).toContain("-dry-run");
      expect(cwd).toBe("/est/team-a");
    }
    // Without dryRun, nothing is spawned at all.
    const quiet: string[][] = [];
    await movesPayload(plan(), members, { run: async (a) => (quiet.push(a), { code: 0, stdout: "", stderr: "" }) });
    expect(quiet).toEqual([]);
  });

  it("moveMembers names each served member's estate from its own live-check document", async () => {
    const run = async (_args: string[], cwd: string) => ({
      code: 0,
      stderr: "",
      stdout: cwd.endsWith("mono") ? raw("choudoufu-live-check-monolith.json") : raw("choudoufu-live-check-estate-references.json"),
    });
    const got = await moveMembers([{ name: "mono", dir: "/est/mono" }, { name: "refs", dir: "/est/refs" }], run);
    // The second declares no live block — not a destination, not an error.
    expect(got).toEqual([{ name: "mono", dir: "/est/mono", estate: "tlmig-sample-monolith" }]);
  });
});

describe("the receipt (#371)", () => {
  it("reads every named estate with -consistent and says where the account holds each address now", async () => {
    const spawns: string[][] = [];
    const run = async (args: string[], cwd: string) => {
      spawns.push(args);
      return { code: 0, stderr: "", stdout: cwd.endsWith("team-a") ? raw("choudoufu-live-ls-team-a-after-split.json") : raw("choudoufu-live-ls-monolith.json") };
    };
    const r = await moveReceipt(plan(), members, run);
    for (const a of spawns) expect(a).toEqual(["live-ls", expect.stringMatching(/^-estate=/), "-consistent", "-json", "."]);
    expect(r.estates["tlmig-sample-team-a"]).toEqual({ addresses: ["aws_iam_role.team_a"] });
    expect(r.estates["tlmig-sample-team-b"]).toEqual({ error: "not served here" });
    expect(r.moves).toEqual([
      { address: "aws_iam_role.team_a", to: "tlmig-sample-team-a", state: "moved" },
      { address: "aws_iam_policy.team_a", to: "tlmig-sample-team-a", state: "pending" },
      { address: "aws_cloudwatch_log_group.team_a_0", to: "tlmig-sample-team-a", state: "pending" },
      { address: "aws_iam_role.team_b", to: "tlmig-sample-team-b", state: "pending" },
    ]);
  });
});
