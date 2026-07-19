/**
 * M3 (#54) — the "apply" step of the observe→reconcile→apply dial: behold's
 * first delegated WRITE. `chant run <target> --components --env <env>
 * --progress-json` (chant 0.18.30) deploys the named component (or every
 * component, `target: "all"`) through chant's own interpret driver on the
 * local executor, streaming one NDJSON `RunProgressEvent` per line while it
 * runs. This module turns that stream into a structured wave/component/
 * phase/step progress model the SPA renders live — the primary surface for
 * an apply, replacing the raw-log-tail now-line (src/op-runner.ts's `apply()`
 * feeds each stdout/stderr line through `parseProgressLine`, folds a
 * recognized event through `applyProgressReducer`, and broadcasts the result
 * as an `apply` SSE event via the existing Broadcaster — see src/events.ts).
 *
 * `RunProgressEvent` is chant's own type (`components/run-progress.ts`) but
 * isn't re-exported from `@intentius/chant`'s public index or its
 * `./components` subpath — only the deep `./components/run-progress` path
 * carries it. Mirrored here field-for-field (verified against chant 0.18.30's
 * `dist/components/run-progress.d.ts`) rather than reached for, matching
 * src/chant.ts's `LifecyclePlanEntry` precedent: don't reach past a
 * package's declared public export surface for an internal type.
 */

export type RunProgressStatus = "ok" | "failed";

export interface RunStartEvent {
  type: "run-start";
  /** The parallel-safe waves the run will attempt, in order — 1-based wave
   * numbers in every other event index into this array. */
  waves: string[][];
}
export interface WaveStartEvent {
  type: "wave-start";
  wave: number;
  components: string[];
}
export interface ComponentStartEvent {
  type: "component-start";
  wave: number;
  component: string;
}
export interface PhaseStartEvent {
  type: "phase-start";
  component: string;
  phase: string;
}
export interface StepEvent {
  type: "step";
  component: string;
  phase: string;
  step: string;
  status: "running" | "ok" | "failed";
  /** Present only alongside `status: "failed"`. */
  error?: string;
}
export interface PhaseDoneEvent {
  type: "phase-done";
  component: string;
  phase: string;
  status: RunProgressStatus;
}
export interface ComponentDoneEvent {
  type: "component-done";
  wave: number;
  component: string;
  status: RunProgressStatus;
}
export interface WaveDoneEvent {
  type: "wave-done";
  wave: number;
  status: RunProgressStatus;
}
export interface RunDoneEvent {
  type: "run-done";
  status: RunProgressStatus;
}

export type RunProgressEvent =
  | RunStartEvent
  | WaveStartEvent
  | ComponentStartEvent
  | PhaseStartEvent
  | StepEvent
  | PhaseDoneEvent
  | ComponentDoneEvent
  | WaveDoneEvent
  | RunDoneEvent;

const PROGRESS_EVENT_TYPES = new Set<RunProgressEvent["type"]>([
  "run-start",
  "wave-start",
  "component-start",
  "phase-start",
  "step",
  "phase-done",
  "component-done",
  "wave-done",
  "run-done",
]);

/**
 * Parse one line of `chant run --progress-json`'s combined stdout/stderr as a
 * `RunProgressEvent`. Returns null for anything else — a non-JSON line
 * (chant's human-readable driver summary still prints after the stream ends,
 * plus any warning/release-record lines), or JSON whose `type` isn't one of
 * the nine known event kinds. Never throws: `OpRunner.apply` (src/op-
 * runner.ts) feeds every streamed line here to decide whether it's structured
 * progress (broadcast as `apply`) or a raw log line (falls back to the `op`
 * now-line channel, same as any other Op). Pure; exported for testing.
 */
export function parseProgressLine(line: string): RunProgressEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string" || !PROGRESS_EVENT_TYPES.has(type as RunProgressEvent["type"])) return null;
  return parsed as RunProgressEvent;
}

// ---------------------------------------------------------------------------
// The structured progress model (M3): what the SPA actually renders — waves
// as ordered groups, each component showing its current phase/step and a
// status. Reduced incrementally from the NDJSON stream; broadcast whole (not
// diffed) after every recognized event, since a run is at most a few dozen
// components — small enough that resending the full state is simpler than
// patch events, and a client that (re)subscribes mid-run still renders
// correctly from the very next event instead of needing a replay log.
// ---------------------------------------------------------------------------

export type ApplyStatus = "pending" | "running" | "ok" | "failed";

export interface ApplyComponentState {
  component: string;
  wave: number;
  status: ApplyStatus;
  phase?: string;
  step?: string;
  /** Present once a step under this component has failed. */
  error?: string;
}

export interface ApplyWaveState {
  wave: number;
  components: string[];
  status: ApplyStatus;
}

export interface ApplyProgressState {
  /** "idle": no `run-start` seen yet (the initial/reset state) — distinct
   * from a component/wave's own "pending" (declared, not yet reached). */
  status: "idle" | "running" | RunProgressStatus;
  waves: ApplyWaveState[];
  components: ApplyComponentState[];
}

export const initialApplyProgress: ApplyProgressState = { status: "idle", waves: [], components: [] };

/**
 * Fold one `RunProgressEvent` into the running progress model. Pure and
 * immutable (returns a new state) — trivially unit-testable against a
 * fixture transcript (see apply.test.ts, which replays both a clean run and
 * one with a failed step). A `step` (or `phase-done`) reporting `failed`
 * marks the component `failed` immediately, not only once `component-done`
 * arrives — the DoD's "a failed step must show as failed, not silently
 * green" while later steps in a fail-fast phase are still being skipped.
 */
export function applyProgressReducer(state: ApplyProgressState, event: RunProgressEvent): ApplyProgressState {
  switch (event.type) {
    case "run-start": {
      const waves: ApplyWaveState[] = event.waves.map((components, i) => ({
        wave: i + 1,
        components,
        status: "pending",
      }));
      const components: ApplyComponentState[] = waves.flatMap((w) =>
        w.components.map((component) => ({ component, wave: w.wave, status: "pending" as const })),
      );
      return { status: "running", waves, components };
    }
    case "wave-start":
      return {
        ...state,
        waves: state.waves.map((w) => (w.wave === event.wave ? { ...w, status: "running" } : w)),
      };
    case "component-start":
      return {
        ...state,
        components: state.components.map((c) =>
          c.component === event.component ? { ...c, status: "running" } : c,
        ),
      };
    case "phase-start":
      return {
        ...state,
        components: state.components.map((c) =>
          c.component === event.component ? { ...c, phase: event.phase, step: undefined } : c,
        ),
      };
    case "step":
      return {
        ...state,
        components: state.components.map((c) =>
          c.component === event.component
            ? {
                ...c,
                phase: event.phase,
                step: event.step,
                ...(event.status === "failed" ? { status: "failed" as const, error: event.error } : {}),
              }
            : c,
        ),
      };
    case "phase-done":
      return {
        ...state,
        components: state.components.map((c) =>
          c.component === event.component && event.status === "failed" ? { ...c, status: "failed" } : c,
        ),
      };
    case "component-done":
      return {
        ...state,
        components: state.components.map((c) =>
          c.component === event.component ? { ...c, status: event.status } : c,
        ),
      };
    case "wave-done":
      return {
        ...state,
        waves: state.waves.map((w) => (w.wave === event.wave ? { ...w, status: event.status } : w)),
      };
    case "run-done":
      return { ...state, status: event.status };
    default:
      return state;
  }
}
