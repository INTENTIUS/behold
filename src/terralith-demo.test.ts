import { describe, it, expect } from "vitest";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRatification, phaseCommand, readTerralith } from "./terralith-demo.ts";
import { snapshotFileFor, snapshotRunner } from "./choudoufu-snapshots.ts";

// Fixture provenance: src/__fixtures__/terralith is one real run of the demo
// copy's scripts (example-terralith/scripts), choudoufu v0.28.0 against floci
// ff46eb8d (choudoufu's live/floci-image pin): terralith-up.sh, then
// terralith-step.sh adopt, then terralith-step.sh split. The .err files were
// left out; everything else is as the tool printed it.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "__fixtures__", "terralith");

/** A copy holding the first `n` phases only. */
function copyWith(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "terralith-"));
  for (const p of ["1-stock", "2-adopt", "3-split"].slice(0, n)) cpSync(join(FIXTURE, "snapshots", p), join(dir, "snapshots", p), { recursive: true });
  if (n >= 3) cpSync(join(FIXTURE, "split.json"), join(dir, "split.json"));
  return dir;
}

describe("the stock terralith", () => {
  const model = readTerralith(copyWith(1));
  const [stock] = model.phases;

  it("is one stock box holding all 23 resources, each in the state file", () => {
    expect(model.phases).toHaveLength(1);
    expect(stock!.boxes.map((b) => [b.id, b.stock, b.spawned])).toEqual([["terralith", true, false]]);
    expect(stock!.counts).toMatchObject({ cards: 23, state: 23, marked: 0, moved: 0 });
    const vpc = stock!.boxes[0]!.cards.find((c) => c.id === "aws_vpc.main")!;
    expect(vpc.identity).toEqual({ source: "state", marked: false });
    expect(vpc.liveId).toMatch(/^vpc-/);
  });

  it("names adopt as the next phase, with the line that runs it", () => {
    expect(model.next).toEqual({ id: "adopt", n: 2, command: "bash scripts/terralith-step.sh adopt" });
  });
});

describe("adopt", () => {
  const model = readTerralith(copyWith(2));
  const adopt = model.phases[1]!;
  const card = (id: string) => adopt.boxes[0]!.cards.find((c) => c.id === id)!;

  it("keeps the same box and the same 23 card ids", () => {
    expect(adopt.boxes.map((b) => [b.id, b.estate, b.stock, b.spawned])).toEqual([["terralith", "terralith", false, false]]);
    expect(adopt.boxes[0]!.cards.map((c) => c.id).sort()).toEqual(model.phases[0]!.boxes[0]!.cards.map((c) => c.id).sort());
  });

  it("puts a marker on the 17 taggable resources, and none on the 6 that have no tags argument", () => {
    expect(adopt.counts).toMatchObject({ cards: 23, marked: 17, state: 0 });
    expect(card("aws_iam_role_policy.team_a_inline").identity).toEqual({ source: "derived", marked: false });
    expect(card("aws_iam_role_policy.team_a_inline").ratified).toBe("untaggable");
  });

  it("keeps how the plan found it apart from whether the object carries the marker", () => {
    // choudoufu binds a named resource by its name, stamped or not: the log
    // group carries the marker and still reads `derived`.
    expect(card("aws_cloudwatch_log_group.team_a_0").identity).toEqual({ source: "derived", marked: true });
    // A VPC has no name to derive, so the marker sweep binds it.
    expect(card("aws_vpc.main").identity).toEqual({ source: "marker", marked: true });
    expect(adopt.counts.marker).toBe(5);
  });

  it("carries live-import's own verdict per card", () => {
    expect(card("aws_vpc.main").ratified).toBe("verified");
    expect(card("aws_iam_role.team_b").ratified).toBe("drifted");
  });
});

describe("split", () => {
  const model = readTerralith(copyWith(3));
  const split = model.phases[2]!;
  const box = (id: string) => split.boxes.find((b) => b.id === id)!;

  it("spawns three team boxes beside the terralith, which keeps the network", () => {
    expect(split.boxes.map((b) => [b.id, b.spawned])).toEqual([
      ["terralith", false],
      ["team-a", true],
      ["team-b", true],
      ["team-c", true],
    ]);
    expect(box("terralith").cards.map((c) => c.id)).toEqual(["aws_subnet.app", "aws_vpc.main"]);
    expect(box("team-b").cards).toHaveLength(7);
  });

  it("marks each moved card with its retag, followers with the parent they follow", () => {
    const role = box("team-a").cards.find((c) => c.id === "aws_iam_role.team_a")!;
    expect(role.moved).toEqual({ from: "terralith", to: "team-a" });
    const inline = box("team-a").cards.find((c) => c.id === "aws_iam_role_policy.team_a_inline")!;
    expect(inline.moved).toEqual({ from: "terralith", to: "team-a", follows: "aws_iam_role.team_a" });
    expect(split.counts.moved).toBe(21);
    expect(split.counts.marked).toBe(17);
  });

  it("reads split.json, and has nothing left to run", () => {
    expect(model.split).toEqual({ moves: 15, estates: ["team-a", "team-b", "team-c"] });
    expect(model.next).toBeUndefined();
  });
});

describe("the reader's edges", () => {
  it("reads no phases from an empty copy, and names the stock line first", () => {
    const model = readTerralith(mkdtempSync(join(tmpdir(), "terralith-")));
    expect(model.phases).toEqual([]);
    expect(model.next).toEqual({ id: "stock", n: 1, command: phaseCommand("stock") });
  });

  it("parses a ratification heading and its rows, and stops at the summary", () => {
    const m = parseRatification(readFileSync(join(FIXTURE, "snapshots", "2-adopt", "terralith", "live-import.txt"), "utf8"));
    expect(m.size).toBe(23);
    expect(m.get("aws_subnet.app")).toEqual({ status: "verified", liveId: expect.stringMatching(/^subnet-/) });
  });
});

describe("snapshotRunner", () => {
  const run = snapshotRunner(join(FIXTURE, "snapshots", "3-split"));

  it("answers the reads behold spawns from the root's files", async () => {
    const ls = await run(["live-ls", "-estate=team-a", "-json", "-consistent", "."], "/anywhere/team-a");
    expect(ls.code).toBe(0);
    expect(JSON.parse(ls.stdout).estate).toBe("team-a");
    const plan = await run(["live-plan", "-json"], "/x/terralith");
    expect(JSON.parse(plan.stdout).bound).toHaveLength(2);
    const dry = await run(["live-mv", "-json", "-dry-run", "-from-estate=terralith", "aws_iam_role.team_a", "aws_iam_role.team_a"], "/x/team-a");
    expect(JSON.parse(dry.stdout).dry_run).toBe(true);
  });

  it("answers no write: a live-mv without -dry-run has no snapshot file", async () => {
    expect(snapshotFileFor(["live-mv", "-json", "-from-estate=terralith", "aws_iam_role.team_a", "aws_iam_role.team_a"], "team-a")).toBeUndefined();
    const r = await run(["live-mv", "-json", "-from-estate=terralith", "aws_iam_role.team_a", "aws_iam_role.team_a"], "/x/team-a");
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
  });
});
