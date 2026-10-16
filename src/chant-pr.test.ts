import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { chantPrFacets, chantPrRoute, cycleRunsOf, pinOf, prGate, prLoopIn, prLoopOf, prStageOfReport, prStagesInLog, readChantPr, type RunDoc } from "./chant-pr.ts";
import type { HistoryEntry } from "./lifecycle-history.ts";
import type { TerragucciSource } from "./terragucci-source.ts";

// The fixtures are from cycle 767 of terragucci's demo, scenario chant-pr-loop
// on demo-chant (behold#631): run 3843 planned pull request 13, the reviewer
// approved its digest on chant/lifecycle, and run 3844 applied the merge.
// pr-plan.json and pr-apply.json are the reports the two runs uploaded; the
// logs are the summary each stage printed at the end of its step.
const FIX = join(import.meta.dirname, "__fixtures__", "chant-pr");
const text = (n: string) => readFileSync(join(FIX, n), "utf8");
const DIGEST = "jcs1-sha256:909bbc5e4f02021bdff9d852c8253f215383a2489eee464ace2adb0fda138553";
const WORKFLOW = `jobs:
  plan:
    steps:
      - run: chant components pr-plan --base "$BASE_SHA" --pr "$PR_NUMBER" --env demo --gate pr-apply --output .chant/pr --forge forgejo
  apply:
    steps:
      - run: chant components pr-apply --base "$BASE_SHA" --env demo --gate pr-apply --output .chant/pr --forge forgejo --require-review
`;

function repo(): string {
  // Named as the forge's repo, as a view checkout is.
  const dir = join(mkdtempSync(join(tmpdir(), "behold-chant-pr-")), "demo-chant");
  mkdirSync(join(dir, ".forgejo", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".forgejo", "workflows", "chant-pr.yml"), WORKFLOW);
  return dir;
}

const HEAD = "facafb9e9f0a5a30ea1b8453e5e8774710a615cf";
const MERGE = "0c45b81ff5c050d1f9dfbdb1fe1638e24dee67ed";
const steps = (log: string) => [{ name: "the stage", status: "success", log: log.split("\n") }];
const planRun = (over: Partial<RunDoc> = {}): RunDoc => ({ id: 3843, repo: "terragucci-admin/demo-chant", event: "pull_request", trigger: "plan", commit: HEAD, pull: 13, status: "success", jobs: [{ name: "plan", status: "success", steps: steps(text("plan-log.txt")) }], ...over });
const applyRun = (over: Partial<RunDoc> = {}): RunDoc => ({ id: 3844, repo: "terragucci-admin/demo-chant", event: "push", trigger: "merge", commit: MERGE, pull: 13, status: "success", jobs: [{ name: "apply", status: "success", steps: steps(text("apply-log.txt")) }], ...over });

function source(runs: RunDoc[]): TerragucciSource {
  return {
    kind: "dir",
    location: "fixtures",
    async read(key: string) {
      if (key === "runs/index.json") return JSON.stringify({ schema: "demo.runs/v1", updated_at: "2026-10-16T08:19:04Z", keep: 30, runs: runs.map(({ jobs, ...r }) => ({ ...r, title: "t", created_at: null, started_at: null, ended_at: null, jobs: jobs.map(({ steps: _s, ...j }) => ({ id: 1, needs: [], ended_at: null, started_at: null, ...j })) })) });
      const m = /^runs\/(\d+)\.json$/.exec(key);
      const r = m ? runs.find((x) => x.id === Number(m[1])) : undefined;
      return r ? JSON.stringify({ schema: "demo.run/v1", ...r, title: "t", created_at: null, started_at: null, ended_at: null, jobs: r.jobs.map((j) => ({ id: 1, needs: [], started_at: null, ended_at: null, ...j, steps: (j.steps ?? []).map((s) => ({ ...s, truncated: 0 })) })) }) : undefined;
    },
  } as TerragucciSource;
}
const noGit = async () => ({ code: 1, stdout: "", stderr: "" });
const noLedger = { history: async () => ({ found: false, via: "none" as const, fetch: { ok: false }, read: { at: "" }, logs: [], note: "" }), git: noGit };

describe("the pull-request loop in a repo's pipeline (behold#631)", () => {
  it("is read from the lines that run chant components pr-plan and pr-apply", () => {
    expect(prLoopIn(WORKFLOW, "forgejo", ".forgejo/workflows/chant-pr.yml")).toEqual({ forge: "forgejo", workflow: ".forgejo/workflows/chant-pr.yml", env: "demo", gate: "pr-apply", output: ".chant/pr", stages: ["plan", "apply"] });
    expect(prLoopIn("jobs: { build: { run: chant build } }", "github", "x.yml")).toBeUndefined();
    expect(prLoopOf(repo())?.forge).toBe("forgejo");
  });

  it("gives each component its wave from chant graph --components, and each member its component", () => {
    const ir = { nodes: [{ id: "network", attrs: { wave: 1, liveNames: ["network"] } }, { id: "app", attrs: { liveNames: ["app-root"] } }], groups: { byWave: { "wave-1": ["network"], "wave-2": ["app"] } } };
    expect(chantPrFacets(repo(), ir, "opentofu")).toEqual({ forge: "forgejo", workflow: ".forgejo/workflows/chant-pr.yml", env: "demo", gate: "pr-apply", tools: ["chant", "opentofu"], waves: { network: 1, app: 2 }, members: { network: "network", "app-root": "app" } });
  });
});

describe("a stage's summary in its run's log (behold#631)", () => {
  it("reads pr-plan's members, digest and approve line", () => {
    const [s] = prStagesInLog(text("plan-log.txt").split("\n"), "run #3843", 3843);
    expect(s).toMatchObject({ stage: "plan", from: "log", run: 3843, status: "planned", digest: DIGEST, op: "pr-13", gate: "pr-apply", approval: { status: "pending" } });
    expect(s!.members.map((m) => [m.member, m.status, m.counts.create])).toEqual([["app", "planned", 1], ["edge", "planned", 1], ["network", "planned", 1]]);
  });

  it("reads pr-apply's members and who approved the plan it applied", () => {
    const [s] = prStagesInLog(text("apply-log.txt").split("\n"), "run #3844", 3844);
    expect(s).toMatchObject({ stage: "apply", status: "applied", digest: DIGEST, approval: { status: "approved", approvedBy: ["forgejo@forgejo:3000:demo-reviewer"] } });
    expect(s!.members.every((m) => m.status === "applied")).toBe(true);
  });

  it("reads a refused apply, its reason, colours and all", () => {
    const lines = ["\u001b[33mwarning\u001b[0m: pr-apply: refused (plan-changed)", `The plan changed after review, so nothing was applied. approved: sha256:aaa; planned now: ${DIGEST}. Read the new plan.`, "  network              planned      create 1 update 0 replace 0 delete 0"];
    const [s] = prStagesInLog(lines, "run #9");
    expect(s).toMatchObject({ stage: "apply", status: "refused", refusal: "plan-changed", digest: DIGEST, approval: { status: "changed", approved: "sha256:aaa" } });
  });

  it("finds nothing in a stage still running: chant prints its summary at the end", () => {
    expect(prStagesInLog(["Initializing the backend...", "Plan: 1 to add, 0 to change, 0 to destroy."], "run #1")).toEqual([]);
  });
});

describe("chant's pull-request report, pr-report/v1 (behold#631)", () => {
  it("is read with its waves and each member's component", () => {
    const s = prStageOfReport(JSON.parse(text("pr-plan.json")), ".chant/pr/pr-plan.json");
    expect(s).toMatchObject({ stage: "plan", from: "report", pr: 13, head: HEAD, digest: DIGEST, waves: [["network"], ["app"], ["edge"]] });
    expect(s!.members.find((m) => m.member === "app")).toMatchObject({ component: "app", status: "planned" });
    expect(prStageOfReport({ stage: "plan", members: [] }, "x")).toBeUndefined();
  });
});

describe("the runs a pin names (behold#631)", () => {
  const runs = [applyRun(), planRun()];
  it("a pull request's plan for pull-<n>-<sha>, without the merge", () => {
    expect(cycleRunsOf(runs, pinOf(`pull-13-${HEAD}`))).toMatchObject({ plan: { id: 3843 }, apply: null, pull: 13 });
    expect(cycleRunsOf(runs, pinOf(HEAD))).toMatchObject({ plan: { id: 3843 }, apply: null, pull: 13 });
  });
  it("the merge's apply and its pull request's plan for the merge commit", () => {
    expect(cycleRunsOf(runs, pinOf(MERGE))).toMatchObject({ plan: { id: 3843 }, apply: { id: 3844 }, pull: 13 });
  });
  it("nothing for the base", () => {
    expect(cycleRunsOf(runs, pinOf("base"))).toEqual({ plan: null, apply: null, pull: null });
  });
});

describe("the gate (behold#631)", () => {
  const plan = prStagesInLog(text("plan-log.txt").split("\n"), "run #3843", 3843)[0]!;
  const approved: HistoryEntry = { id: "x", kind: "approved", at: "2026-10-16T08:15:25.591Z", op: "pr-13", gate: "pr-apply", digest: DIGEST, actor: "forgejo@forgejo:3000:demo-reviewer", seal: "sealed", source: { path: "_gates/pr-13.jsonl", line: 1, commit: "10a36285", change: "added" } } as HistoryEntry;
  it("waits on the plan's digest until the ledger approves it", () => {
    expect(prGate(plan, null, [], null, 13)).toMatchObject({ op: "pr-13", gate: "pr-apply", digest: DIGEST, state: "waiting" });
    expect(prGate(plan, null, [approved], null, 13)).toMatchObject({ state: "approved", by: "forgejo@forgejo:3000:demo-reviewer", seal: "sealed", ledgerCommit: "10a36285", from: "ledger" });
  });
  it("is not approved by an approval of another digest, or another pull request's", () => {
    expect(prGate(plan, null, [{ ...approved, digest: "sha256:other" }], null, 13)!.state).toBe("waiting");
    expect(prGate(plan, null, [{ ...approved, op: "pr-12" }], null, 13)!.state).toBe("waiting");
  });
});

describe("GET /api/chant/pr (behold#631)", () => {
  const ask = async (runs: RunDoc[], pin: string) => {
    const app = new Hono();
    chantPrRoute(app, () => dir, { source: source(runs), ...noLedger });
    const dir = repo();
    return (await (await app.request(`/api/chant/pr?pin=${pin}`)).json()) as Awaited<ReturnType<typeof readChantPr>>;
  };
  it("at the pull request's plan: each member planned and the gate waiting on its digest", async () => {
    const a = await ask([planRun()], `pull-13-${HEAD}`);
    expect(a.plan).toMatchObject({ from: "log", status: "planned" });
    expect(a.apply).toBeNull();
    expect(a.gate).toMatchObject({ state: "waiting", digest: DIGEST });
    expect(a.gaps.map((g) => g.issue)).toContain("INTENTIUS/chant#4007");
  });
  it("while the merge's apply runs: the job, and no state per component it has not printed", async () => {
    const running = applyRun({ status: "running", jobs: [{ name: "apply", status: "running", steps: steps("Initializing the backend...") }] });
    const a = await ask([running, planRun()], MERGE);
    expect(a.apply).toBeNull();
    expect(a.running).toMatchObject({ stage: "apply", run: 3844, job: "apply", status: "running" });
    expect(a.gaps.some((g) => /progress per wave/.test(g.what))).toBe(true);
  });
  it("after the merge: each member applied", async () => {
    const a = await ask([applyRun(), planRun()], MERGE);
    expect(a.apply).toMatchObject({ status: "applied", digest: DIGEST });
    expect(a.gate).toMatchObject({ state: "approved", by: "forgejo@forgejo:3000:demo-reviewer", from: "log" });
  });
  it("reads the report chant wrote in the checkout, pr-report/v1, before the log", async () => {
    const dir = repo();
    mkdirSync(join(dir, ".chant", "pr"), { recursive: true });
    writeFileSync(join(dir, ".chant", "pr", "pr-plan.json"), text("pr-plan.json"));
    const a = await readChantPr(dir, `pull-13-${HEAD}`, { source: source([planRun()]), ...noLedger });
    expect(a.plan).toMatchObject({ from: "report", waves: [["network"], ["app"], ["edge"]] });
    expect(a.reads.find((r) => r.contract === "pr-report/v1")).toBeTruthy();
  });
  it("says nothing for a repo that runs no pull-request loop", async () => {
    const a = await readChantPr(mkdtempSync(join(tmpdir(), "behold-chant-none-")), null, noLedger);
    expect(a).toMatchObject({ loop: null, plan: null, apply: null, gate: null });
  });
});
