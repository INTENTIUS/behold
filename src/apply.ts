/**
 * M3 (#54): the "apply" step of the observe, reconcile, apply dial, behold's
 * first delegated WRITE. `chant run <target> --components --env <env>
 * --events-json` deploys the named component (or every component, `target:
 * "all"`) through chant's own interpret driver on the local executor, and
 * streams chant's run events (#679, src/run-events.ts) while it runs. This
 * module is the model the SPA's dial renders: waves of components, each with
 * its current phase and step and every step's state as it happens.
 *
 * The stream is folded by src/run-events.ts's `foldRunEvent`; {@link
 * applyProgressOf} turns the fold into this model. src/op-runner.ts's
 * `apply()` broadcasts the result as an `apply` SSE event after every event.
 *
 * Below chant 0.124.28 (`RUN_EVENTS_CHANT_FLOOR`) behold starts the run with
 * the older `--progress-json` instead, and src/run-events.ts translates those
 * lines into the same events: `source: "progress"`, which the dial labels as
 * degraded. A local pipeline run (src/ci-run.ts) and a GitHub dispatch
 * (src/gh-run.ts) reuse the model with their own `source`.
 */
import type { RunEventFold, StepView, UnitStatus, WaitingOn } from "./run-events.ts";

/** A wave's or a component's state: chant's settle statuses, plus `pending`
 * (declared, not yet reached) and `running`. `gated` and `waiting` wait on a
 * person and are not failures. */
export type ApplyStatus = UnitStatus;

/**
 * Where a run's progress came from, which the dial says beside it.
 *
 * - `events`: chant ran it and wrote its run events (contract 1).
 * - `progress`: chant ran it, but older than 0.124.28: the older
 *   `--progress-json` lines, with no step timings, skips or gates (degraded).
 * - `classifier`: chant did not run it (a local CI runner). Read from the
 *   runner's log by a best-effort classifier; only the exit code is certain.
 * - `forge`: a forge's own job states, polled (GitHub Actions).
 */
export type ProgressSource = "events" | "progress" | "classifier" | "forge";

export interface ApplyComponentState {
  component: string;
  wave: number;
  status: ApplyStatus;
  phase?: string;
  step?: string;
  /** The state of `step`, as it happens: `running`, then how it settled. */
  stepState?: StepView["state"];
  /** With a skipped `step`: chant's reason, or null when it did not know. */
  skip?: string | null;
  /** Present once a step under this component has failed. */
  error?: string;
  /** This component's steps, in the order they started (or settled). */
  steps?: StepView[];
}

export interface ApplyWaveState {
  wave: number;
  components: string[];
  status: ApplyStatus;
}

export interface ApplyProgressState {
  /** "idle": no `run-start` seen yet (the initial/reset state), distinct from
   * a component/wave's own "pending" (declared, not yet reached). "lost": the
   * stream ended without a verdict (#165 §6): no `run-settle` before the
   * process exited, or the CI follow stopped polling. The run itself may still
   * be live; the chips freeze at last-observed and the summary says the stream
   * was lost, the same honesty rule the run playhead's `runEnded` keeps. */
  status: "idle" | "running" | "lost" | "ok" | "failed" | "gated" | "waiting";
  waves: ApplyWaveState[];
  components: ApplyComponentState[];
  /** Where the progress came from; absent on the idle state. */
  source?: ProgressSource;
  /** What the run waits on, from chant's `gate-waiting`. */
  waitingOn?: WaitingOn | null;
  /** The run's id and runtime, from the event envelope. */
  runId?: string;
  runtime?: string;
  /** Why the stream was lost, when it was. */
  lost?: string;
  /** Events the stream's sequence skipped, when any were. */
  missed?: number;
}

export const initialApplyProgress: ApplyProgressState = { status: "idle", waves: [], components: [] };

/**
 * A component run's fold as the dial's model. Each component carries its
 * newest step (the one running, else the last to settle) and all of its
 * steps, so start, settle, skipped (with the reason), cached, gated and
 * waiting all show as they happen. Pure.
 */
export function applyProgressOf(fold: RunEventFold, source: "events" | "progress"): ApplyProgressState {
  if (fold.status === "idle") return { ...initialApplyProgress, source };
  const components: ApplyComponentState[] = fold.components.map((c) => {
    const steps = fold.steps.filter((s) => s.component === c.component);
    const current = [...steps].reverse().find((s) => s.state === "running") ?? steps.at(-1);
    const failed = steps.find((s) => s.state === "failed");
    return {
      component: c.component,
      wave: c.wave,
      status: c.status,
      ...(current ? { phase: current.phase, step: current.step, stepState: current.state } : {}),
      ...(current?.state === "skipped" ? { skip: current.skip ?? null } : {}),
      ...(failed?.error ? { error: failed.error } : {}),
      ...(steps.length ? { steps } : {}),
    };
  });
  return {
    status: fold.status,
    waves: fold.waves,
    components,
    source,
    waitingOn: fold.waitingOn,
    ...(fold.runId ? { runId: fold.runId } : {}),
    ...(fold.runtime ? { runtime: fold.runtime } : {}),
    ...(fold.missed ? { missed: fold.missed } : {}),
  };
}

/**
 * The run's process ended. A stream that settled keeps its own verdict. One
 * that did not is `lost` on the events path: chant always closes the stream
 * with `run-settle`, so its absence means the process died (a SIGKILL writes
 * none). In degraded mode the older stream had no such guarantee, and the
 * exit code reads as before: 0 is ok, anything else failed.
 */
export function applyEnded(state: ApplyProgressState, settled: boolean, exitCode: number): ApplyProgressState {
  if (settled || state.status === "idle") return state;
  if (state.source === "progress") return { ...state, status: exitCode === 0 ? "ok" : "failed" };
  return {
    ...state,
    status: "lost",
    lost: `the run-event stream ended (exit ${exitCode}) without run-settle, so behold does not know how the run ended; the chips stay at what was last observed.`,
  };
}
