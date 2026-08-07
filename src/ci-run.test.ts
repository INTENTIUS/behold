import { describe, it, expect } from "vitest";
import { pipelineProgress, foldPipelineLine, finishPipelineProgress } from "./ci-run.ts";
import type { CiPipeline } from "./chant.ts";

// loomster's generated shape: stages are waves, one job per component.
const pipeline: CiPipeline = {
  stages: ["wave-1", "wave-2"],
  jobs: [
    { jobName: "deploy-shared-foundation", component: "shared-foundation", stage: "wave-1", needs: [], script: ["chant run --components shared-foundation"] },
    { jobName: "deploy-loom-backend", component: "loom-backend", stage: "wave-2", needs: ["deploy-shared-foundation"], script: ["chant run --components loom-backend"] },
  ],
};

describe("pipelineProgress", () => {
  it("maps stages to waves and jobs to component-correlated entries", () => {
    const s = pipelineProgress(pipeline);
    expect(s.kind).toBe("pipeline");
    expect(s.status).toBe("running");
    expect(s.waves).toEqual([
      { wave: 1, components: ["deploy-shared-foundation"], status: "pending" },
      { wave: 2, components: ["deploy-loom-backend"], status: "pending" },
    ]);
    // Keyed by JOB (unique); the component rides in `phase`, so the dial's
    // chip reads `job · component`.
    expect(s.components).toContainEqual({ component: "deploy-loom-backend", wave: 2, status: "pending", phase: "loom-backend" });
  });
});

describe("foldPipelineLine", () => {
  it("a job's first mention runs it; PASS/FAIL settle it; unrelated lines change nothing", () => {
    let s = pipelineProgress(pipeline);
    const before = s;
    s = foldPipelineLine(s, "docker pull node:22");
    expect(s).toBe(before); // same object — the caller skips the broadcast

    s = foldPipelineLine(s, "starting deploy-shared-foundation (node:22)");
    expect(s.components.find((c) => c.component === "deploy-shared-foundation")?.status).toBe("running");
    expect(s.waves[0].status).toBe("running");

    s = foldPipelineLine(s, "PASS  deploy-shared-foundation  00:41");
    expect(s.components.find((c) => c.component === "deploy-shared-foundation")?.status).toBe("ok");
    expect(s.waves[0].status).toBe("ok");

    s = foldPipelineLine(s, "FAIL  deploy-loom-backend  00:07");
    expect(s.components.find((c) => c.component === "deploy-loom-backend")?.status).toBe("failed");
    expect(s.waves[1].status).toBe("failed");
  });

  it("matches whole tokens — `build` never claims `build-docs`'s lines", () => {
    const p: CiPipeline = {
      stages: ["wave-1"],
      jobs: [
        { jobName: "build", component: "app", stage: "wave-1", needs: [], script: [] },
        { jobName: "build-docs", component: "docs", stage: "wave-1", needs: [], script: [] },
      ],
    };
    const s = foldPipelineLine(pipelineProgress(p), "starting build-docs (node:22)");
    expect(s.components.find((c) => c.component === "build-docs")?.status).toBe("running");
    expect(s.components.find((c) => c.component === "build")?.status).toBe("pending");
  });

  it("a settled job doesn't regress to running on a later mention", () => {
    let s = pipelineProgress(pipeline);
    s = foldPipelineLine(s, "PASS  deploy-shared-foundation");
    s = foldPipelineLine(s, "deploy-shared-foundation > cleanup output");
    expect(s.components.find((c) => c.component === "deploy-shared-foundation")?.status).toBe("ok");
  });
});

describe("finishPipelineProgress — the exit code is the verdict", () => {
  it("zero: unfinished jobs read ok, run ok", () => {
    const s = finishPipelineProgress(pipelineProgress(pipeline), 0);
    expect(s.status).toBe("ok");
    expect(s.components.every((c) => c.status === "ok")).toBe(true);
  });

  it("non-zero: unfinished jobs read failed, a job the log already passed keeps its ok", () => {
    let s = pipelineProgress(pipeline);
    s = foldPipelineLine(s, "PASS  deploy-shared-foundation");
    const done = finishPipelineProgress(s, 1);
    expect(done.status).toBe("failed");
    expect(done.components.find((c) => c.component === "deploy-shared-foundation")?.status).toBe("ok");
    expect(done.components.find((c) => c.component === "deploy-loom-backend")?.status).toBe("failed");
  });
});
