// Tours (behold.tour/v1): the file's schema, where a tour is found, and the
// numbers read from a run's report and plan for its facts and visuals.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOURS_DIR, distinctResources, taggedResources, durationWords, findTour, jobOf, planAddresses, planCounts, plannedOutput, tourProblem, tourRow } from "./terragucci-tour.ts";

const shipped = JSON.parse(readFileSync(join(TOURS_DIR, "terralith.json"), "utf8"));
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("the tour file's schema", () => {
  it("passes the terralith tour behold ships", () => {
    expect(tourProblem(shipped)).toBeUndefined();
  });

  it("refuses a file that is not behold.tour/v1", () => {
    expect(tourProblem({ ...shipped, schema: "behold.tour/v2" })).toMatch(/schema|const/);
    expect(tourProblem({ ...shipped, chapters: [] })).toBeDefined();
    expect(tourProblem({ ...shipped, chapters: [{ ...shipped.chapters[0], text: ["a", "b", "c"] }] })).toBeDefined();
    expect(tourProblem({ ...shipped, chapters: [{ ...shipped.chapters[0], trigger: { wave: 1 } }] })).toBeDefined();
  });

  it("refuses a name the file uses but does not define", () => {
    expect(tourProblem({ ...shipped, chapters: [{ ...shipped.chapters[0], text: ["{nope}"] }] })).toMatch(/\{nope\}/);
    expect(tourProblem({ ...shipped, facts: { ...shipped.facts, x: { run: "missing", value: "planned" } } })).toMatch(/missing/);
    expect(tourProblem({ ...shipped, runs: { ...shipped.runs, y: { repo: "{repo}", stage: "tf-plan", after: "gone" } } })).toMatch(/gone/);
  });
});

describe("where a tour is found", () => {
  it("is behold's own for the terralith tool, and none for another scenario", () => {
    expect(findTour({ tool: "terralith", scenario: "terralith" }, [], [])!.tour.name).toBe("terralith");
    expect(findTour({ tool: "terraform", scenario: "b-waves" }, [], [])).toBeNull();
  });

  it("prefers a served repo's .behold/tours, so a customer's tour wins", () => {
    const d = mkdtempSync(join(tmpdir(), "behold-tour-"));
    dirs.push(d);
    mkdirSync(join(d, ".behold", "tours"), { recursive: true });
    writeFileSync(join(d, ".behold", "tours", "mine.json"), JSON.stringify({ ...shipped, name: "mine" }));
    writeFileSync(join(d, ".behold", "tours", "bad.json"), JSON.stringify({ schema: "behold.tour/v1" }));
    const problems: string[] = [];
    const t = findTour({ tool: "terralith", scenario: "terralith" }, [d], problems)!;
    expect(t.tour.name).toBe("mine");
    expect(t.from).toContain("mine.json");
    expect(problems.join("\n")).toMatch(/bad\.json is not a behold\.tour\/v1 tour/);
  });
});

describe("numbers from a run's report and plan", () => {
  const report = {
    roots: [
      { path: "team-a", counts: { update: 1, "no-op": 12 } },
      { path: "terralith", counts: { "no-op": 43 } },
      { path: "team-b", counts: { create: 1, replace: 2, delete: 1 } },
    ],
  };
  it("counts what a plan planned, what it changes and what it would make again", () => {
    expect(planCounts(report)).toEqual({ planned: 60, changed: 5, recreated: 3, deleted: 1 });
    expect(planCounts(report, ["terralith"])).toEqual({ planned: 43, changed: 0, recreated: 0, deleted: 0 });
    expect(planCounts({})).toBeNull();
  });

  it("reads a plan.json's resources and an output's planned value", () => {
    const plan = {
      resource_changes: [
        { address: "aws_iam_role.a", mode: "managed", change: { actions: ["no-op"] } },
        { address: "aws_iam_role_policy.a", mode: "managed", change: { actions: ["update"] } },
        { address: "data.aws_x.y", mode: "data", change: { actions: ["read"] } },
      ],
      output_changes: { days: { actions: ["update"], before: 7, after: 14, after_unknown: false }, later: { after_unknown: true } },
    };
    expect(planAddresses(plan)).toEqual([
      { address: "aws_iam_role.a", changed: false },
      { address: "aws_iam_role_policy.a", changed: true },
    ]);
    expect(plannedOutput(plan, "days")).toBe(14);
    expect(plannedOutput(plan, "later")).toBeUndefined();
  });

  it("reads an index row, its job number and a cycle's time", () => {
    const r = tourRow({ project: "p", commit: "c", stage: "tf-apply", wave: 1, finished: "2026-10-17T16:52:46.547Z", path: "2026/10/c/tf-apply-wave-1", pull_request: "147", job_url: "http://forgejo:3000/a/b/actions/runs/3646" })!;
    expect(r.pull_request).toBe("147");
    expect(jobOf(r.job_url)).toBe(3646);
    expect(tourRow({ project: "p" })).toBeUndefined();
    expect(durationWords(561_000)).toBe("9 min 21 s");
    expect(durationWords(42_400)).toBe("42 s");
  });
});

describe("counts of resources, not lines", () => {
  // A team's custom attachment follows both its role and its policy, so it has two moved lines (terragucci#1146).
  const split = [
    { at: "t", address: "aws_iam_role.r", live_id: "r", outcome: "moved" },
    { at: "t", address: "aws_iam_policy.p", live_id: "p", outcome: "moved" },
    { at: "t", address: "aws_iam_role_policy_attachment.a", outcome: "moved", follows: "aws_iam_role.r" },
    { at: "t", address: "aws_iam_role_policy_attachment.a", outcome: "moved", follows: "aws_iam_policy.p" },
  ];
  const adopt = [
    { at: "t", address: "aws_iam_role.r", live_id: "r", outcome: "stamped" },
    { at: "t", address: "aws_iam_policy.p", live_id: "p", outcome: "stamped" },
    { at: "t", address: "aws_iam_role_policy_attachment.a", outcome: "skipped" },
  ];
  it("counts a resource moved once, however many lines name it", () => {
    expect(split).toHaveLength(4);
    expect(distinctResources(split, "moved")).toBe(3);
    expect(distinctResources(adopt, "stamped")).toBe(2);
  });
  it("counts the resources a tag write landed on once across migrations, and never a follower", () => {
    expect(taggedResources([adopt, split])).toBe(2);
  });
});

