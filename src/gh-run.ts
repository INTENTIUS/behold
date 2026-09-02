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
import { ciWorkflowName, type CiPipeline } from "./chant.ts";
import { pipelineProgress, losePipelineProgress, type PipelineProgressState } from "./ci-run.ts";
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
  /** The workflow's `name:`, when it declares one — chant 0.54.0 writes
   * `chant-components-<env>` (chant#2046), the identity the picker matches. */
  name?: string;
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
  return { file, jobIds: jobs, dispatchable, ...(typeof d.name === "string" && d.name ? { name: d.name } : {}) };
}

/** Every committed workflow under `.github/workflows`, parsed; [] when the
 * directory is absent. */
function committedWorkflows(projectDir: string): WorkflowInfo[] {
  const dir = join(projectDir, ".github", "workflows");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  } catch {
    return [];
  }
  const out: WorkflowInfo[] = [];
  for (const f of files) {
    try {
      out.push(parseWorkflow(f, readFileSync(join(dir, f), "utf8")));
    } catch {
      /* unreadable: not a candidate */
    }
  }
  return out;
}

/**
 * The committed workflow that RUNS the generated pipeline, or the reason
 * there is none — never a guess where a guess could deploy the wrong env.
 *
 * Three rules, in order, each honest about what it knows (#165 §4):
 *
 *  1. A DESIGNATED file (`.behold.json` `executor.<env>.workflow`) is the
 *     answer or a refusal: missing, or without `workflow_dispatch`, disables
 *     the gesture with the reason. It never falls through to a picker, and
 *     never to the laptop.
 *  2. With no designation but a pipeline that knows its env (chant ≥ 0.54.0,
 *     chant#2046), the workflow NAMED for that env — `chant-components-<env>`
 *     — is the identity match. Exactly one dispatchable file with that name
 *     is the answer; several is a refusal naming them.
 *  3. Otherwise the pre-0.54 heuristic: the dispatchable workflow whose job
 *     ids overlap the pipeline's job names the most — and a TIE is a refusal.
 *     Two envs' pipelines carry identical job ids, so a tie is exactly the
 *     case where `readdirSync` order used to decide which environment got
 *     deployed; it now says so instead.
 */
export function resolveWorkflow(
  projectDir: string,
  pipeline: CiPipeline,
  designated?: string,
): { workflow: WorkflowInfo } | { reason: string } {
  const all = committedWorkflows(projectDir);
  if (designated) {
    const hit = all.find((w) => w.file === designated);
    if (!hit) return { reason: `the designated workflow .github/workflows/${designated} is not committed — Deploy is disabled for this env until it is (behold never falls back to a guess, or to running it here)` };
    if (!hit.dispatchable) return { reason: `the designated workflow ${designated} declares no workflow_dispatch — add it to its \`on:\` block; until then Deploy is disabled for this env` };
    return { workflow: hit };
  }
  const dispatchable = all.filter((w) => w.dispatchable);
  if (pipeline.env) {
    const named = dispatchable.filter((w) => w.name === ciWorkflowName(pipeline.env!));
    if (named.length === 1) return { workflow: named[0] };
    if (named.length > 1) return { reason: `${named.length} committed workflows are named ${ciWorkflowName(pipeline.env)} (${named.map((w) => w.file).join(", ")}) — designate one in .behold.json's executor block` };
  }
  const wanted = new Set(pipeline.jobs.map((j) => j.jobName));
  const scored = dispatchable
    .map((w) => ({ w, overlap: w.jobIds.filter((id) => wanted.has(id)).length }))
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);
  if (scored.length === 0) {
    return { reason: "no committed workflow_dispatch workflow whose jobs match the generated pipeline — commit one (or add `workflow_dispatch:` to its `on:` block)" };
  }
  if (scored.length > 1 && scored[1].overlap === scored[0].overlap) {
    const tied = scored.filter((x) => x.overlap === scored[0].overlap).map((x) => x.w.file);
    return { reason: `${tied.length} committed workflows match the pipeline equally (${tied.join(", ")}) — the generated job ids are the same for every env, so behold cannot tell which one deploys ${pipeline.env ?? "this env"}; designate it in .behold.json's executor block` };
  }
  return { workflow: scored[0].w };
}

/** {@link resolveWorkflow}'s pick alone, for callers that only need the file;
 * a refusal reads as undefined here. */
export function pickWorkflow(projectDir: string, pipeline: CiPipeline): WorkflowInfo | undefined {
  const r = resolveWorkflow(projectDir, pipeline);
  return "workflow" in r ? r.workflow : undefined;
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
  /** The run's page on the forge — where an environment protection rule's
   * approval lives, and the only affordance behold offers for it (#165 §4). */
  url?: string;
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
  if (view.url) state = { ...state, url: view.url };
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
  /**
   * Overall follow deadline (#165 §6). The old loop was `for (;;)` — a run
   * stuck queued behind a forge approval for a weekend would be polled
   * forever. Past the deadline the follow stops and the run promotes to
   * `lost` (the stream is what died; the run may still be live at `url`).
   * Default 6h — generously above any honest deploy, including a granted-
   * on-Monday approval within a working day.
   */
  followTimeoutMs?: number;
  /**
   * Consecutive failed polls before the stream is declared dead (#165 §6).
   * The old loop printed `⚠ … retrying` forever on a gh that had stopped
   * answering (network gone, token revoked, `gh` removed). One flaky poll is
   * still not a failed run; this many IN A ROW is a dead stream → `lost`.
   * Default 24 (~2 minutes at the default cadence).
   */
  pollFailBudget?: number;
  /** The dispatched run was adopted by watermark: the persistence hook (#165 §6) — save the id so a restarted behold still has a reader. */
  onAdopted?: (run: { runId: number; url?: string }) => void;
  /** The follow ended, with its honest verdict — `ok`/`failed` from GitHub's own conclusion, `lost` when the stream died without one. */
  onConcluded?: (outcome: { verdict: "ok" | "failed" | "lost" }) => void;
  /** Raw progress lines for the now-line. */
  onLine: (line: string) => void;
  /** Structured progress for the dial (the `apply` SSE channel). */
  onProgress: (state: PipelineProgressState) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Exit code `dispatchAndFollow`/`followRun` return for a lost stream — distinct from a failed run (1) and from dispatch failures. EX_TEMPFAIL: the truth is temporarily unreadable, not bad. */
export const LOST_EXIT = 75;

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
  deps.onAdopted?.({ runId });

  return followRun(runId, pipeline, deps);
}

/**
 * Follow an already-known run to completion — extracted from
 * {@link dispatchAndFollow} so a restarted behold can re-adopt a persisted
 * run id (#165 §6): `gh run view <id>` is the durable status read the
 * Temporal path has in `chant run status`, and with the id saved, a live
 * prod run has a reader again after a restart instead of nothing at all.
 *
 * The two §6 honesty rules the old `for (;;)` broke, kept here:
 *  - a dead stream is never completion — `pollFailBudget` consecutive
 *    failed polls, or the overall `followTimeoutMs` deadline, end the loop
 *    with the run promoted to `lost` (chips frozen at last-observed, the
 *    run possibly still live at its own page);
 *  - only GitHub's own `status: completed` + conclusion paints a verdict.
 */
export async function followRun(
  runId: number,
  pipeline: CiPipeline,
  deps: DispatchDeps,
): Promise<number> {
  const exec = deps.exec ?? defaultGhExec;
  const pollMs = deps.pollMs ?? 5000;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollFailBudget = deps.pollFailBudget ?? 24;
  const followDeadline = Date.now() + (deps.followTimeoutMs ?? 6 * 60 * 60 * 1000);

  let urlSaid = false;
  let state = pipelineProgress(pipeline);
  let consecutiveFailures = 0;

  const lose = (why: string): number => {
    deps.onLine(`✗ run ${runId}: ${why} — behold stopped following; the run itself may still be live${state.url ? ` at ${state.url}` : " on the forge"} (restart behold, or POST /api/ci/readopt, to re-adopt it)`);
    deps.onProgress(losePipelineProgress(state));
    deps.onConcluded?.({ verdict: "lost" });
    return LOST_EXIT;
  };

  for (;;) {
    const { code, out } = await exec(["run", "view", String(runId), "--json", "status,conclusion,jobs,url"]);
    if (code === 0) {
      consecutiveFailures = 0;
      let view: GhRunView | undefined;
      try {
        view = JSON.parse(out) as GhRunView;
      } catch {
        view = undefined;
      }
      if (view) {
        if (view.url && !urlSaid) {
          urlSaid = true;
          deps.onAdopted?.({ runId, url: view.url });
          deps.onLine(`● ${view.url} — if the workflow's environment requires an approval, it is granted there, by a GitHub identity; behold holds none that could`);
        }
        state = runViewToProgress(pipeline, view);
        deps.onProgress(state);
        if (view.status === "completed") {
          deps.onLine(`■ run ${runId} ${view.conclusion ?? "completed"}`);
          const ok = view.conclusion === "success";
          deps.onConcluded?.({ verdict: ok ? "ok" : "failed" });
          return ok ? 0 : 1;
        }
      }
    } else {
      // A flaky poll is not a failed run — say so once per miss and keep going,
      // up to the budget: this many in a row is a dead stream, not flake (§6).
      consecutiveFailures++;
      deps.onLine(`⚠ gh run view ${runId} failed (exit ${code}) — retrying (${consecutiveFailures}/${pollFailBudget})`);
      if (consecutiveFailures >= pollFailBudget) {
        return lose(`${pollFailBudget} consecutive polls failed — the stream is dead, not flaky`);
      }
    }
    if (Date.now() >= followDeadline) {
      return lose("the follow deadline passed");
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
