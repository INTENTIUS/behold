import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ghReady,
  parseWorkflow,
  pickWorkflow,
  ghJobStatus,
  runViewToProgress,
  dispatchAndFollow,
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
