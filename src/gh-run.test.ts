import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ghReady,
  parseWorkflow,
  pickWorkflow,
  resolveWorkflow,
  workflowsDir,
  ghJobStatus,
  runViewToProgress,
  dispatchAndFollow,
  followRun,
  LOST_EXIT,
  joinCiProgress,
  type GhExec,
  type GhRunView,
} from "./gh-run.ts";
import type { CiPipeline } from "./chant.ts";

const pipeline: CiPipeline = {
  stages: ["wave-1", "wave-2"],
  jobs: [
    { jobName: "shared-foundation", component: "shared-foundation", stage: "wave-1", needs: [], script: [] },
    { jobName: "loom-backend", component: "loom-backend", stage: "wave-2", needs: ["shared-foundation"], script: [] },
  ],
};

/** A scripted gh: each call is matched by its first tokens, in order. */
function scriptedGh(script: Array<{ match: string[]; code?: number; out?: string }>): { exec: GhExec; calls: string[][] } {
  const calls: string[][] = [];
  const remaining = [...script];
  const exec: GhExec = async (args) => {
    calls.push(args);
    const i = remaining.findIndex((s) => s.match.every((m, k) => args[k] === m));
    if (i === -1) return { code: 1, out: `unscripted: gh ${args.join(" ")}` };
    const step = remaining[i];
    if (script.filter((s) => s === step).length <= 1 && remaining.indexOf(step) !== -1) remaining.splice(i, 1);
    return { code: step.code ?? 0, out: step.out ?? "" };
  };
  return { exec, calls };
}

describe("ghReady", () => {
  it("distinguishes not-installed from not-authenticated from ready", async () => {
    expect((await ghReady(async () => ({ code: 127, out: "" }))).reason).toContain("not installed");
    expect((await ghReady(async () => ({ code: 1, out: "You are not logged in" }))).reason).toContain("not authenticated");
    expect((await ghReady(async () => ({ code: 0, out: "Logged in" }))).ok).toBe(true);
  });
});

describe("parseWorkflow / pickWorkflow", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "behold-gh-run-"));
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const wf = (name: string, text: string) => writeFileSync(join(dir, ".github", "workflows", name), text);

  it("reads job ids and the workflow_dispatch opt-in", () => {
    const info = parseWorkflow("deploy.yml", "name: deploy\non:\n  workflow_dispatch:\n  push:\njobs:\n  shared-foundation:\n    runs-on: ubuntu-latest\n  loom-backend:\n    runs-on: ubuntu-latest\n");
    expect(info.jobIds).toEqual(["shared-foundation", "loom-backend"]);
    expect(info.dispatchable).toBe(true);
  });

  it("picks the dispatchable workflow with the largest pipeline overlap", () => {
    wf("ci.yml", "on:\n  pull_request:\njobs:\n  check:\n    runs-on: ubuntu-latest\n");
    wf("deploy.yml", "on:\n  workflow_dispatch:\njobs:\n  shared-foundation:\n    runs-on: x\n  loom-backend:\n    runs-on: x\n");
    wf("docs.yml", "on:\n  workflow_dispatch:\njobs:\n  docs:\n    runs-on: x\n");
    expect(pickWorkflow(dir, pipeline)?.file).toBe("deploy.yml");
  });

  it("a matching workflow WITHOUT workflow_dispatch is never picked — behold won't force a run", () => {
    wf("deploy.yml", "on:\n  push:\njobs:\n  shared-foundation:\n    runs-on: x\n  loom-backend:\n    runs-on: x\n");
    expect(pickWorkflow(dir, pipeline)).toBeUndefined();
  });

  // #165 §4 / chant#2046: the picker sees the env, and refuses what it cannot tell apart.
  const twoEnvs = () => {
    wf("deploy-staging.yml", "name: chant-components-staging\non:\n  workflow_dispatch:\njobs:\n  shared-foundation:\n    runs-on: x\n  loom-backend:\n    runs-on: x\n");
    wf("deploy-prod.yml", "name: chant-components-prod\non:\n  workflow_dispatch:\njobs:\n  shared-foundation:\n    runs-on: x\n  loom-backend:\n    runs-on: x\n");
  };

  it("reads the workflow's name — chant 0.54.0 names a generated workflow for its env", () => {
    expect(parseWorkflow("d.yml", "name: chant-components-prod\non:\n  workflow_dispatch:\njobs: {}\n").name).toBe("chant-components-prod");
  });

  it("two envs' workflows carry identical job ids: with no env on the pipeline the tie is a refusal, not a directory-order pick", () => {
    twoEnvs();
    const r = resolveWorkflow(dir, pipeline);
    expect("reason" in r && r.reason).toMatch(/match the pipeline equally.*deploy-prod\.yml.*deploy-staging\.yml|deploy-staging\.yml.*deploy-prod\.yml/);
    expect(pickWorkflow(dir, pipeline)).toBeUndefined();
  });

  it("a pipeline that knows its env picks the workflow NAMED for it, whatever the overlap says", () => {
    twoEnvs();
    expect(resolveWorkflow(dir, { ...pipeline, env: "prod" })).toEqual({ workflow: expect.objectContaining({ file: "deploy-prod.yml", name: "chant-components-prod" }) });
    expect(resolveWorkflow(dir, { ...pipeline, env: "staging" })).toEqual({ workflow: expect.objectContaining({ file: "deploy-prod.yml".replace("prod", "staging") }) });
  });

  it("two workflows named for the same env is a refusal naming both", () => {
    twoEnvs();
    wf("deploy-prod-copy.yml", "name: chant-components-prod\non:\n  workflow_dispatch:\njobs:\n  shared-foundation:\n    runs-on: x\n");
    const r = resolveWorkflow(dir, { ...pipeline, env: "prod" });
    expect("reason" in r && r.reason).toMatch(/2 committed workflows are named chant-components-prod/);
  });

  it("a designated file is the answer — and a missing or non-dispatchable one is a refusal that never falls back", () => {
    twoEnvs();
    wf("release.yml", "on:\n  push:\njobs:\n  shared-foundation:\n    runs-on: x\n");
    expect(resolveWorkflow(dir, { ...pipeline, env: "prod" }, "deploy-staging.yml")).toEqual({ workflow: expect.objectContaining({ file: "deploy-staging.yml" }) });
    const missing = resolveWorkflow(dir, { ...pipeline, env: "prod" }, "nope.yml");
    expect("reason" in missing && missing.reason).toMatch(/nope\.yml is not committed/);
    const undispatchable = resolveWorkflow(dir, { ...pipeline, env: "prod" }, "release.yml");
    expect("reason" in undispatchable && undispatchable.reason).toMatch(/declares no workflow_dispatch/);
  });

  it("a workflow named for ANOTHER env never stands in on the overlap fallback — and the refusal says so", () => {
    // Only prod's workflow is committed; a staging pipeline must not dispatch it.
    wf("deploy-prod.yml", "name: chant-components-prod\non:\n  workflow_dispatch:\njobs:\n  shared-foundation:\n    runs-on: x\n  loom-backend:\n    runs-on: x\n");
    const r = resolveWorkflow(dir, { ...pipeline, env: "staging" });
    expect("reason" in r && r.reason).toMatch(/deploy-prod\.yml \(chant-components-prod\) is named for another env/);
    // Without an env on the pipeline (pre-0.54) the overlap match still applies.
    expect(resolveWorkflow(dir, pipeline)).toEqual({ workflow: expect.objectContaining({ file: "deploy-prod.yml" }) });
  });

  it("reads the workflows of the REPOSITORY the project belongs to — a project nested in a monorepo has none of its own", () => {
    // example-ci's shape: the project is one directory of a repository whose
    // .github/workflows sits at the root. The first real-forge run failed here.
    execFileSync("git", ["init", "-q", dir]);
    mkdirSync(join(dir, "packages", "app"), { recursive: true });
    wf("deploy-prod.yml", "name: chant-components-prod\non:\n  workflow_dispatch:\njobs:\n  shared-foundation:\n    runs-on: x\n");
    const nested = join(dir, "packages", "app");
    // realpath both: macOS's tmpdir is a symlink (/var → /private/var), and git reports the real path.
    expect(realpathSync(workflowsDir(nested))).toBe(realpathSync(join(dir, ".github", "workflows")));
    expect(resolveWorkflow(nested, { ...pipeline, env: "prod" }, "deploy-prod.yml")).toEqual({ workflow: expect.objectContaining({ file: "deploy-prod.yml" }) });
  });

  it("no candidate at all is the old refusal, unchanged", () => {
    wf("ci.yml", "on:\n  pull_request:\njobs:\n  check:\n    runs-on: x\n");
    const r = resolveWorkflow(dir, pipeline);
    expect("reason" in r && r.reason).toMatch(/no committed workflow_dispatch workflow/);
  });
});

describe("the run's own address (#165)", () => {
  it("rides from `gh run view --json url` onto the pipeline progress state", () => {
    const state = runViewToProgress(pipeline, { status: "in_progress", url: "https://github.com/o/r/actions/runs/42", jobs: [] });
    expect(state.url).toBe("https://github.com/o/r/actions/runs/42");
    expect(runViewToProgress(pipeline, { status: "in_progress", jobs: [] }).url).toBeUndefined();
  });
});

describe("run status mapping", () => {
  it("queued→pending, in_progress→running, completed reads the conclusion", () => {
    expect(ghJobStatus({ status: "queued" })).toBe("pending");
    expect(ghJobStatus({ status: "in_progress" })).toBe("running");
    expect(ghJobStatus({ status: "completed", conclusion: "success" })).toBe("ok");
    expect(ghJobStatus({ status: "completed", conclusion: "failure" })).toBe("failed");
  });

  it("folds a run view onto the pipeline shape, run-level verdict on completion", () => {
    const view: GhRunView = {
      status: "completed",
      conclusion: "failure",
      jobs: [
        { name: "shared-foundation", status: "completed", conclusion: "success" },
        { name: "loom-backend", status: "completed", conclusion: "failure" },
      ],
    };
    const s = runViewToProgress(pipeline, view);
    expect(s.kind).toBe("pipeline");
    expect(s.status).toBe("failed");
    expect(s.components.find((c) => c.component === "shared-foundation")?.status).toBe("ok");
    expect(s.waves[1].status).toBe("failed");
  });
});

describe("dispatchAndFollow (hermetic — a scripted gh, no GitHub)", () => {
  const workflow = { file: "deploy.yml", jobIds: ["shared-foundation", "loom-backend"], dispatchable: true };
  const noSleep = async () => {};

  it("dispatches, waits past the watermark for OUR run, follows to success", async () => {
    const running: GhRunView = { status: "in_progress", jobs: [{ name: "shared-foundation", status: "in_progress" }] };
    const done: GhRunView = {
      status: "completed",
      conclusion: "success",
      jobs: [
        { name: "shared-foundation", status: "completed", conclusion: "success" },
        { name: "loom-backend", status: "completed", conclusion: "success" },
      ],
    };
    const { exec, calls } = scriptedGh([
      { match: ["run", "list"], out: JSON.stringify([{ databaseId: 41 }]) }, // watermark: a PREVIOUS run
      { match: ["workflow", "run"] },
      { match: ["run", "list"], out: JSON.stringify([{ databaseId: 41 }]) }, // ours hasn't appeared yet
      { match: ["run", "list"], out: JSON.stringify([{ databaseId: 42 }]) },
      { match: ["run", "view", "42"], out: JSON.stringify(running) },
      { match: ["run", "view", "42"], out: JSON.stringify(done) },
    ]);
    const progress: string[] = [];
    const code = await dispatchAndFollow(workflow, pipeline, "main", {
      exec,
      pollMs: 1,
      onLine: () => {},
      onProgress: (s) => progress.push(s.status),
      sleep: noSleep,
    });
    expect(code).toBe(0);
    expect(progress.at(-1)).toBe("ok");
    expect(calls.some((c) => c[0] === "workflow" && c[1] === "run" && c[2] === "deploy.yml" && c[4] === "main")).toBe(true);
  });

  it("a failed dispatch returns its code without polling", async () => {
    const { exec } = scriptedGh([
      { match: ["run", "list"], out: "[]" },
      { match: ["workflow", "run"], code: 1, out: "HTTP 403" },
    ]);
    const code = await dispatchAndFollow(workflow, pipeline, "main", { exec, pollMs: 1, onLine: () => {}, onProgress: () => {}, sleep: noSleep });
    expect(code).toBe(1);
  });

  it("a run that never appears times out honestly", async () => {
    const { exec } = scriptedGh([
      { match: ["run", "list"], out: JSON.stringify([{ databaseId: 7 }]) },
      { match: ["workflow", "run"] },
      // every later list keeps answering the watermark id
    ]);
    const stuck: GhExec = async (args) =>
      args[0] === "run" && args[1] === "list" ? { code: 0, out: JSON.stringify([{ databaseId: 7 }]) } : exec(args);
    const lines: string[] = [];
    const code = await dispatchAndFollow(workflow, pipeline, "main", {
      exec: stuck,
      pollMs: 1,
      appearTimeoutMs: 5,
      onLine: (l) => lines.push(l),
      onProgress: () => {},
      sleep: noSleep,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("never appeared");
  });

  it("adoption fires onAdopted with the run id, and the url once a poll reports one — the persistence hooks (#165 §6)", async () => {
    const done: GhRunView = { status: "completed", conclusion: "success", url: "https://github.com/o/r/actions/runs/42", jobs: [] };
    const { exec } = scriptedGh([
      { match: ["run", "list"], out: JSON.stringify([{ databaseId: 41 }]) },
      { match: ["workflow", "run"] },
      { match: ["run", "list"], out: JSON.stringify([{ databaseId: 42 }]) },
      { match: ["run", "view", "42"], out: JSON.stringify(done) },
    ]);
    const adopted: Array<{ runId: number; url?: string }> = [];
    const concluded: string[] = [];
    const code = await dispatchAndFollow(workflow, pipeline, "main", {
      exec,
      pollMs: 1,
      onLine: () => {},
      onProgress: () => {},
      onAdopted: (r) => adopted.push(r),
      onConcluded: (o) => concluded.push(o.verdict),
      sleep: noSleep,
    });
    expect(code).toBe(0);
    expect(adopted[0]).toEqual({ runId: 42 });
    expect(adopted[1]).toEqual({ runId: 42, url: "https://github.com/o/r/actions/runs/42" });
    expect(concluded).toEqual(["ok"]);
  });
});

describe("followRun — the §6 honesty rules (a dead stream is never completion)", () => {
  const noSleep = async () => {};

  it("this many failed polls IN A ROW is a dead stream: lost, frozen chips, LOST_EXIT — never ok, never failed", async () => {
    const dead: GhExec = async () => ({ code: 1, out: "connect: network is unreachable" });
    const lines: string[] = [];
    const progress: Array<{ status: string }> = [];
    const concluded: string[] = [];
    const code = await followRun(42, pipeline, {
      exec: dead,
      pollMs: 1,
      pollFailBudget: 3,
      onLine: (l) => lines.push(l),
      onProgress: (s) => progress.push(s),
      onConcluded: (o) => concluded.push(o.verdict),
      sleep: noSleep,
    });
    expect(code).toBe(LOST_EXIT);
    expect(progress.at(-1)?.status).toBe("lost");
    expect(concluded).toEqual(["lost"]);
    expect(lines.join("\n")).toContain("stopped following");
    expect(lines.join("\n")).toContain("may still be live");
  });

  it("one flaky poll among good ones resets the budget and never loses the run", async () => {
    const running: GhRunView = { status: "in_progress", jobs: [] };
    const done: GhRunView = { status: "completed", conclusion: "success", jobs: [] };
    let call = 0;
    const flaky: GhExec = async () => {
      call++;
      if (call === 2) return { code: 1, out: "flake" }; // one miss between two good polls
      return { code: 0, out: JSON.stringify(call >= 3 ? done : running) };
    };
    const code = await followRun(42, pipeline, {
      exec: flaky,
      pollMs: 1,
      pollFailBudget: 2,
      onLine: () => {},
      onProgress: () => {},
      sleep: noSleep,
    });
    expect(code).toBe(0);
  });

  it("the overall follow deadline ends a live-but-unfinished follow as lost — the old for(;;) had no such bound", async () => {
    const running: GhRunView = { status: "in_progress", url: "https://github.com/o/r/actions/runs/42", jobs: [] };
    const alive: GhExec = async () => ({ code: 0, out: JSON.stringify(running) });
    const lines: string[] = [];
    const progress: Array<{ status: string; url?: string }> = [];
    const code = await followRun(42, pipeline, {
      exec: alive,
      pollMs: 1,
      followTimeoutMs: 0, // expires after the first poll
      onLine: (l) => lines.push(l),
      onProgress: (s) => progress.push(s),
      sleep: noSleep,
    });
    expect(code).toBe(LOST_EXIT);
    const last = progress.at(-1);
    expect(last?.status).toBe("lost");
    // The run's own page survives on the lost state — the truth continues there.
    expect(last?.url).toContain("/runs/42");
    expect(lines.join("\n")).toContain("readopt");
  });

  it("a re-adopted follow (no dispatch) reaches a verdict and reports the url via onAdopted — the restart reader", async () => {
    const done: GhRunView = { status: "completed", conclusion: "failure", url: "https://github.com/o/r/actions/runs/7", jobs: [] };
    const adopted: Array<{ runId: number; url?: string }> = [];
    const concluded: string[] = [];
    const code = await followRun(7, pipeline, {
      exec: async () => ({ code: 0, out: JSON.stringify(done) }),
      pollMs: 1,
      onLine: () => {},
      onProgress: () => {},
      onAdopted: (r) => adopted.push(r),
      onConcluded: (o) => concluded.push(o.verdict),
      sleep: noSleep,
    });
    expect(code).toBe(1);
    expect(adopted).toEqual([{ runId: 7, url: "https://github.com/o/r/actions/runs/7" }]);
    expect(concluded).toEqual(["failed"]);
  });
});

describe("joinCiProgress", () => {
  const ir = () => ({
    nodes: [
      { id: "loom-backend", kind: "Component", attrs: { wave: 2 } as Record<string, unknown> },
      { id: "shared-foundation", kind: "Component", attrs: { wave: 1 } as Record<string, unknown> },
      { id: "bucket", kind: "AWS::S3::Bucket", attrs: {} as Record<string, unknown> },
    ],
  });

  it("stamps ci (a printable card field) + _ciJob per component from a pipeline state", () => {
    const out = joinCiProgress(ir(), {
      kind: "pipeline",
      components: [
        { component: "shared-foundation", status: "ok", phase: "shared-foundation" },
        { component: "loom-backend", status: "failed", phase: "loom-backend" },
      ],
    });
    expect(out.nodes[0].attrs?.ci).toBe("failed");
    expect(out.nodes[1].attrs?.ci).toBe("ok");
    expect(out.nodes[2].attrs?.ci).toBeUndefined(); // never on non-Component nodes
  });

  it("an apply's progress stamps nothing — it says nothing about CI", () => {
    const out = joinCiProgress(ir(), { components: [{ component: "loom-backend", status: "ok", phase: "loom-backend" }] });
    expect(out.nodes[0].attrs?.ci).toBeUndefined();
  });
});
