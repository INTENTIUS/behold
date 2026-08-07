/**
 * GitHub Actions as a triggerable, followable executor (#164 — the second
 * slice of #61).
 *
 * behold holds no forge credentials, ever. The trigger and every read go
 * through the operator's own `gh` CLI login — the same delegation posture as
 * chant applies: behold asks, the operator's tooling acts. No `gh`, or `gh`
 * unauthenticated, degrades to an honest refusal before anything is
 * attempted.
 *
 * The run renders exactly like #163's local pipeline: the generated pipeline
 * (`/api/ci`'s stages/jobs, each job correlated to its component) seeds the
 * apply-shaped progress model, and instead of classifying log lines, the
 * follow loop polls `gh run view --json` — STRUCTURED job status, so unlike
 * the local runner there is no guessing. The dispatched workflow is chosen by
 * job-id overlap with the generated pipeline and must declare
 * `workflow_dispatch` (behold never force-pushes a run onto a workflow that
 * didn't opt into being dispatched).
 *
 * Every `gh` invocation goes through an injectable exec, so the whole
 * dispatch-and-follow flow is testable hermetically — deliberately NOT
 * verified by live-dispatching an estate's committed workflows, whose real-ci
 * lanes deploy to real clouds.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYAML } from "@intentius/chant/yaml";
import type { CiPipeline } from "./chant.ts";
import { pipelineProgress, type PipelineProgressState } from "./ci-run.ts";
import type { ApplyStatus } from "./apply.ts";

/** One `gh <args>` invocation. Injectable; the default spawns the real CLI. */
export type GhExec = (args: string[]) => Promise<{ code: number; out: string }>;

export const defaultGhExec: GhExec = (args) =>
  new Promise((resolve) => {
    let out = "";
    let proc;
    try {
      proc = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ code: 127, out: "" });
      return;
    }
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    proc.on("error", () => resolve({ code: 127, out }));
    proc.on("close", (code) => resolve({ code: code ?? 1, out }));
  });

/** Is the operator's `gh` present and logged in? The reason is user-facing. */
export async function ghReady(exec: GhExec = defaultGhExec): Promise<{ ok: boolean; reason?: string }> {
  const { code, out } = await exec(["auth", "status"]);
  if (code === 127) return { ok: false, reason: "gh not installed — the trigger runs through YOUR gh login" };
  if (code !== 0) return { ok: false, reason: `gh not authenticated — run \`gh auth login\` (${out.trim().split("\n")[0] ?? ""})` };
  return { ok: true };
}

/** A committed workflow file, as much of it as the picker reads. */
export interface WorkflowInfo {
  file: string;
  jobIds: string[];
  dispatchable: boolean;
}

/** Parse one workflow file's job ids + whether it declares workflow_dispatch.
 * Top-level maps only — the shapes chant's own YAML parser reads reliably. */
export function parseWorkflow(file: string, text: string): WorkflowInfo {
  let doc: unknown;
  try {
    doc = parseYAML(text);
  } catch {
    return { file, jobIds: [], dispatchable: false };
  }
  const d = (doc ?? {}) as Record<string, unknown>;
  const jobs = d.jobs && typeof d.jobs === "object" && !Array.isArray(d.jobs) ? Object.keys(d.jobs as object) : [];
  // `on:` is a string, an array, or a map — workflow_dispatch counts in each.
  // (chant's parser reads the key as `true` in some shapes; the raw text is
  // the tiebreak, anchored to a line start so a comment can't fake it.)
  const on = d.on ?? d[true as unknown as string];
  const dispatchable =
    on === "workflow_dispatch" ||
    (Array.isArray(on) && on.includes("workflow_dispatch")) ||
    (!!on && typeof on === "object" && "workflow_dispatch" in (on as object)) ||
    /^\s{2,}workflow_dispatch\s*:?\s*$/m.test(text);
  return { file, jobIds: jobs, dispatchable };
}

/**
 * The committed workflow that RUNS the generated pipeline: the dispatchable
 * one whose job ids overlap the pipeline's job names the most. No overlap, or
 * nothing dispatchable → undefined, and the caller refuses with the reason.
 */
export function pickWorkflow(projectDir: string, pipeline: CiPipeline): WorkflowInfo | undefined {
  const dir = join(projectDir, ".github", "workflows");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  } catch {
    return undefined;
  }
  const wanted = new Set(pipeline.jobs.map((j) => j.jobName));
  let best: { info: WorkflowInfo; overlap: number } | undefined;
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    const info = parseWorkflow(f, text);
    if (!info.dispatchable) continue;
    const overlap = info.jobIds.filter((id) => wanted.has(id)).length;
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { info, overlap };
  }
  return best?.info;
}

/** `gh run list` reduced to the newest run's id for one workflow file. */
export async function latestRunId(workflowFile: string, exec: GhExec = defaultGhExec): Promise<number | undefined> {
  const { code, out } = await exec(["run", "list", "--workflow", workflowFile, "--limit", "1", "--json", "databaseId"]);
  if (code !== 0) return undefined;
  try {
    const rows = JSON.parse(out) as Array<{ databaseId?: number }>;
    return typeof rows[0]?.databaseId === "number" ? rows[0].databaseId : undefined;
  } catch {
    return undefined;
  }
}

/** The slice of `gh run view --json status,conclusion,jobs` this reads. */
export interface GhRunView {
  status?: string; // queued | in_progress | completed
  conclusion?: string; // success | failure | cancelled | ...
  jobs?: Array<{ name?: string; status?: string; conclusion?: string }>;
}

/** GitHub's per-job status/conclusion → the dial's vocabulary. */
export function ghJobStatus(job: { status?: string; conclusion?: string }): ApplyStatus {
  if (job.status !== "completed") return job.status === "queued" || job.status === undefined ? "pending" : "running";
  return job.conclusion === "success" ? "ok" : "failed";
}

/**
 * Fold a run view onto the pipeline-seeded progress state. GitHub reports a
 * job's DISPLAY name; chant's generated workflows set none, so it equals the
 * job id (= the pipeline's jobName) — matched exactly, with the run-level
 * status riding on top.
 */
export function runViewToProgress(pipeline: CiPipeline, view: GhRunView): PipelineProgressState {
  let state = pipelineProgress(pipeline);
  const byName = new Map((view.jobs ?? []).map((j) => [j.name, j]));
  state = {
    ...state,
    components: state.components.map((c) => {
      const job = byName.get(c.component);
      return job ? { ...c, status: ghJobStatus(job) } : c;
    }),
  };
  state = {
    ...state,
    waves: state.waves.map((w) => {
      const members = state.components.filter((c) => w.components.includes(c.component));
      const status: ApplyStatus = members.some((c) => c.status === "failed")
        ? "failed"
        : members.every((c) => c.status === "ok")
          ? "ok"
          : members.some((c) => c.status !== "pending")
            ? "running"
            : "pending";
      return { ...w, status };
    }),
  };
  if (view.status === "completed") {
    return { ...state, status: view.conclusion === "success" ? "ok" : "failed" };
  }
  return state;
}

export interface DispatchDeps {
  exec?: GhExec;
  /** Poll cadence in ms (GitHub API-backed; keep it civil). */
  pollMs?: number;
  /** Give up waiting for the dispatched run to APPEAR after this long. */
  appearTimeoutMs?: number;
  /** Raw progress lines for the now-line. */
  onLine: (line: string) => void;
  /** Structured progress for the dial (the `apply` SSE channel). */
  onProgress: (state: PipelineProgressState) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Dispatch the workflow and follow the run to completion. Returns an exit
 * code (0 = run concluded success) — the shape `OpRunner.track` expects.
 * The dispatched run is found by run-id watermark: the newest id BEFORE the
 * dispatch is captured, and the follow waits for a NEWER one, so a run that
 * was already in flight is never claimed as ours.
 */
export async function dispatchAndFollow(
  workflow: WorkflowInfo,
  pipeline: CiPipeline,
  ref: string,
  deps: DispatchDeps,
): Promise<number> {
  const exec = deps.exec ?? defaultGhExec;
  const pollMs = deps.pollMs ?? 5000;
  const appearTimeoutMs = deps.appearTimeoutMs ?? 60_000;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const watermark = await latestRunId(workflow.file, exec);
  deps.onLine(`▶ gh workflow run ${workflow.file} --ref ${ref}`);
  const dispatched = await exec(["workflow", "run", workflow.file, "--ref", ref]);
  if (dispatched.code !== 0) {
    deps.onLine(`✗ dispatch failed: ${dispatched.out.trim().split("\n")[0] ?? `exit ${dispatched.code}`}`);
    return dispatched.code || 1;
  }
  deps.onProgress(pipelineProgress(pipeline));

  let runId: number | undefined;
  const deadline = Date.now() + appearTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(pollMs, 3000));
    const id = await latestRunId(workflow.file, exec);
    if (id !== undefined && id !== watermark) {
      runId = id;
      break;
    }
  }
  if (runId === undefined) {
    deps.onLine("✗ dispatched, but the run never appeared in `gh run list` — check the Actions tab");
    return 1;
  }
  deps.onLine(`● run ${runId} started — following`);

  for (;;) {
    const { code, out } = await exec(["run", "view", String(runId), "--json", "status,conclusion,jobs"]);
    if (code === 0) {
      let view: GhRunView | undefined;
      try {
        view = JSON.parse(out) as GhRunView;
      } catch {
        view = undefined;
      }
      if (view) {
        deps.onProgress(runViewToProgress(pipeline, view));
        if (view.status === "completed") {
          deps.onLine(`■ run ${runId} ${view.conclusion ?? "completed"}`);
          return view.conclusion === "success" ? 0 : 1;
        }
      }
    } else {
      // A flaky poll is not a failed run — say so once per miss and keep going.
      deps.onLine(`⚠ gh run view ${runId} failed (exit ${code}) — retrying`);
    }
    await sleep(pollMs);
  }
}

/**
 * Join the last known pipeline run onto the component-DAG nodes: a plain `ci`
 * attr (a short scalar — pinhole's default card template prints it, so the
 * chip is free) plus `_ciJob` for the inspect panel. Component keys come from
 * each entry's `phase` (where the pipeline model carries the component —
 * src/ci-run.ts). Only from a pipeline-kind state; an apply's progress says
 * nothing about CI. In place; returns `ir`.
 */
export function joinCiProgress<T extends { nodes: Array<{ id: string; kind: string; attrs?: Record<string, unknown> }> }>(
  ir: T,
  state: { kind?: string; components?: Array<{ component: string; status: string; phase?: string }> } | undefined,
): T {
  if (!state || state.kind !== "pipeline" || !state.components?.length) return ir;
  const byComponent = new Map<string, { job: string; status: string }>();
  for (const entry of state.components) {
    if (!entry.phase) continue;
    const current = byComponent.get(entry.phase);
    // A component with several jobs reads its worst job's status.
    if (!current || entry.status === "failed" || (entry.status === "running" && current.status === "ok")) {
      byComponent.set(entry.phase, { job: entry.component, status: entry.status });
    }
  }
  for (const n of ir.nodes) {
    if (n.kind !== "Component") continue;
    const run = byComponent.get(n.id);
    if (!run) continue;
    const attrs = (n.attrs ??= {});
    attrs.ci = run.status;
    attrs._ciJob = run.job;
  }
  return ir;
}
