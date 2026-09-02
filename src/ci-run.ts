/**
 * Local pipeline runs as first-class progress (#163, the first slice of #61).
 *
 * The gitlab-ci-local / forgejo runtime scripts used to run as raw substrate
 * bring-ups: one guarded shell-out, output on the now-line, nothing on the
 * dial. But behold already KNOWS the pipeline's structure — `/api/ci` parses
 * the generated workflow into stages and jobs, each job carrying the
 * component it deploys — so a run can be rendered exactly like an apply:
 * stages as waves, jobs as the entries, each correlated to its component.
 *
 * The model deliberately REUSES `ApplyProgressState` (src/apply.ts): the SPA's
 * dial already renders that shape live over the `apply` SSE channel, and a
 * pipeline run is the same story told by a different executor. Entries are
 * keyed by JOB name (unique; two jobs may deploy one component), with the
 * component carried in `phase` — the dial's chip reads `job · component`.
 *
 * ## The classifier is best-effort, the exit code is the truth
 *
 * A local runner's stdout is not a protocol. The line classifier recognizes
 * the common shapes (`starting <job>`, `<job> > …`, `PASS/FAIL <job>`) to
 * move jobs through pending → running → ok/failed as the log streams; any
 * line it can't read just stays on the now-line. The run-level verdict never
 * comes from the log: `finishPipelineProgress` folds the process exit code,
 * and an unfinished job at a non-zero exit reads failed rather than forever
 * running.
 */
import type { CiPipeline } from "./chant.ts";
import type { ApplyProgressState, ApplyStatus } from "./apply.ts";

/** `ApplyProgressState` plus the label the SPA's summary line shows — an
 * apply-shaped state that says "pipeline", not "apply". */
export type PipelineProgressState = ApplyProgressState & {
  kind: "pipeline";
  /** The run's page on the forge, once a dispatched run reports one (#165):
   * the address of any approval the run waits on. */
  url?: string;
  /** True while GitHub holds the run at `waiting` — a deployment review on an
   * environment protection rule. The approval is granted there, by a GitHub
   * identity; behold's only affordance is `url`. */
  waiting?: boolean;
};

/** The initial running state for a known pipeline: stages as waves, jobs as
 * entries (keyed by job name — see the module doc), components in `phase`. */
export function pipelineProgress(pipeline: CiPipeline): PipelineProgressState {
  const stageIndex = new Map(pipeline.stages.map((s, i) => [s, i + 1]));
  const components = pipeline.jobs.map((j) => ({
    component: j.jobName,
    wave: stageIndex.get(j.stage) ?? 0,
    status: "pending" as ApplyStatus,
    phase: j.component,
  }));
  const waves = pipeline.stages.map((stage, i) => ({
    wave: i + 1,
    components: pipeline.jobs.filter((j) => j.stage === stage).map((j) => j.jobName),
    status: "pending" as ApplyStatus,
  }));
  return { kind: "pipeline", status: "running", waves, components };
}

/** Move one job's status; waves derive from their members. Pure. */
function withJobStatus(state: PipelineProgressState, job: string, status: ApplyStatus): PipelineProgressState {
  const components = state.components.map((c) => {
    if (c.component !== job) return c;
    // Terminal states don't regress: a PASS line followed by the job's name in
    // some later summary must not flip it back to running.
    if ((c.status === "ok" || c.status === "failed") && status === "running") return c;
    return { ...c, status };
  });
  const waves = state.waves.map((w) => {
    const members = components.filter((c) => w.components.includes(c.component));
    const status: ApplyStatus = members.some((c) => c.status === "failed")
      ? "failed"
      : members.every((c) => c.status === "ok")
        ? "ok"
        : members.some((c) => c.status !== "pending")
          ? "running"
          : "pending";
    return { ...w, status };
  });
  return { ...state, components, waves };
}

/**
 * Fold one streamed log line into the model. Returns the same state object
 * when the line said nothing (the caller skips the broadcast). Job names are
 * matched as whole tokens so `build` never matches `build-docs`.
 */
export function foldPipelineLine(state: PipelineProgressState, line: string): PipelineProgressState {
  let out = state;
  for (const c of state.components) {
    const job = c.component;
    const escaped = job.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mentioned = new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`).test(line);
    if (!mentioned) continue;
    if (/\b(FAIL(?:ED)?|ERROR)\b|✘|✗/i.test(line)) out = withJobStatus(out, job, "failed");
    else if (/\b(PASS(?:ED)?|OK|SUCCESS(?:FUL)?)\b|✔|✓/i.test(line)) out = withJobStatus(out, job, "ok");
    else if (c.status === "pending") out = withJobStatus(out, job, "running");
  }
  return out;
}

/**
 * The follow stream died without a verdict (#165 §6): behold stopped being
 * able to ask GitHub about the run — a dead `gh`, or the follow loop's own
 * deadline. This is NOT completion and must not paint like one: every chip
 * keeps its last-observed status verbatim (settled stays settled, running
 * stays running — that is what was last true), and only the run-level status
 * says `lost`, the run playhead's own vocabulary for a dead stream. The run
 * itself may still be live on the forge; `url` (kept) is where the truth
 * continues.
 */
export function losePipelineProgress(state: PipelineProgressState): PipelineProgressState {
  return { ...state, status: "lost" };
}

/** The process ended: the exit code is the verdict. A job the log never
 * finished reads from the code too — failed on non-zero, ok on zero (the
 * runner completed; the log just never said so legibly). */
export function finishPipelineProgress(state: PipelineProgressState, exitCode: number): PipelineProgressState {
  const terminal: ApplyStatus = exitCode === 0 ? "ok" : "failed";
  let out = state;
  for (const c of state.components) {
    if (c.status === "pending" || c.status === "running") out = withJobStatus(out, c.component, terminal);
  }
  return { ...out, status: exitCode === 0 ? "ok" : "failed" };
}
