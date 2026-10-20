/**
 * chant's run-event stream (#679, INTENTIUS/chant#4019): the one stream behold
 * reads for every run chant executes, an Op run, a component run (`chant run
 * --components`) or a pipeline run, local or not.
 *
 * Every event is one JSON line written to chant's `run-event.schema.json`,
 * contract 1. behold starts the runs it starts with `--events-json` (chant
 * 0.124.28, INTENTIUS/chant#4041) and reads a run it did not start with
 * `chant run events <run> --json --follow` (INTENTIUS/chant#4042). Both print
 * the same lines, and this module is the boundary they cross: each line is
 * validated against the schema before anything reads a field of it, and a
 * line that names the schema but fails it is refused out loud, never folded.
 *
 * ## Types and schema
 *
 * The event types are chant's own (`RunEvent`, `RunEventBody` and friends,
 * exported from `@intentius/chant` since 0.124.28), imported as types only:
 * behold loads none of chant's library at runtime. The lines come from the
 * project's chant, which may be a different version from behold's, so the
 * runtime check is the schema: `./run-event-schema/run-event.schema.json` is
 * chant's file, copied unchanged from {@link RUN_EVENT_SCHEMA_SOURCE}, and is
 * what {@link readRunLine} validates every line against before it is typed.
 *
 * ## The older streams, behind the floor
 *
 * A chant older than `RUN_EVENTS_CHANT_FLOOR` has no `--events-json`. behold
 * starts it with `--progress-json` (degraded mode, src/op-runner.ts), and
 * {@link legacyRunLine} translates each of that stream's lines into chant's
 * run-event bodies at this boundary, the way chant's own `runEventOfProgress`
 * and `runEventsOfStepRecord` do, so one fold renders both. The old shapes
 * are read field by field; behold keeps no type for them.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  RunEvent,
  RunEventBody,
  RunEventComponentSettleStatus,
  RunEventSettleStatus,
  RunEventStepStatus,
  RunEventStepSettle,
} from "@intentius/chant";
import runEventSchema from "./run-event-schema/run-event.schema.json" with { type: "json" };

/** Where the vendored schema comes from: chant's `workspace/run-event.schema.json`
 * as chant#4083 (#4007, for 0.124.29) changes it, at bf7a596203cc on
 * feat/4007-pr-progress: the 0.124.28 file (chant-v0.124.28, bc251b54ec0c) plus
 * component-settle's two additive statuses, `blocked` (with `blockedBy`) and
 * `already-applied`. Re-copy from the release tag once 0.124.29 ships. */
export const RUN_EVENT_SCHEMA_SOURCE = {
  repo: "INTENTIUS/chant",
  path: "packages/core/src/workspace/run-event.schema.json",
  commit: "bf7a596203ccea24daa53572e9d50c20d31faf2b",
  release: "0.124.29",
} as const;

/** The schema's `$id`, which every event carries as `$schema`. Read from the
 * vendored schema rather than chant's `RUN_EVENT_SCHEMA_ID`, which is a value
 * and would load chant's library. */
export const RUN_EVENT_SCHEMA_ID: string = runEventSchema.$id;

/** The run-event contract version behold reads. */
export const RUN_EVENT_CONTRACT = 1;

/** What the fold takes: a validated event (envelope and body), or a body
 * translated from the older stream, which has no envelope. */
export type RunLine = RunEvent | RunEventBody;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ── Validation at the boundary ────────────────────────────────────────────────

let validator: ((v: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null } | undefined;
function validate(v: unknown): string | null {
  if (!validator) {
    const ajv = new Ajv2020({ strict: false, allErrors: false });
    validator = ajv.compile(runEventSchema as object);
  }
  if (validator(v)) return null;
  const e = validator.errors?.[0];
  return e ? `${e.instancePath || "the event"} ${e.message ?? "does not match"}` : "does not match the schema";
}

/** What one line of a run's output was. */
export type RunLineRead =
  /** A contract-1 run event that passed the schema. */
  | { kind: "event"; event: RunEvent }
  /** A line that names the run-event schema but fails it, or names another
   * contract. It is not folded; the reason goes on the now-line. */
  | { kind: "refused"; reason: string }
  /** An older `--progress-json` line (degraded mode), translated. */
  | { kind: "legacy"; events: RunEventBody[] };

/**
 * Read one streamed line. `null` for anything that is not run progress: a
 * non-JSON line (chant's human summary, an activity's own stdout, a warning),
 * or JSON that is neither a run event nor an older progress line. Never
 * throws: src/op-runner.ts feeds every streamed line here.
 */
export function readRunLine(line: string): RunLineRead | null {
  const s = line.trim();
  if (!s.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.$schema === RUN_EVENT_SCHEMA_ID || ("contract" in parsed && "runId" in parsed && "seq" in parsed)) {
    if (parsed.contract !== RUN_EVENT_CONTRACT) {
      return { kind: "refused", reason: `a run event with contract ${JSON.stringify(parsed.contract)}; behold reads contract ${RUN_EVENT_CONTRACT}` };
    }
    const why = validate(parsed);
    if (why) return { kind: "refused", reason: `a run event that does not match chant's run-event schema: ${why}` };
    return { kind: "event", event: parsed as unknown as RunEvent };
  }
  const legacy = legacyRunLine(parsed);
  return legacy ? { kind: "legacy", events: legacy } : null;
}

// ── The older streams, translated (degraded mode) ─────────────────────────────

const LEGACY_SETTLE: ReadonlySet<string> = new Set(["ok", "failed", "gated"]);
const settleOf = (v: unknown): RunEventSettleStatus | null => (typeof v === "string" && LEGACY_SETTLE.has(v) ? (v as RunEventSettleStatus) : null);

/**
 * One parsed line of an older `--progress-json` stream, as run-event bodies:
 * the components driver's progress events (`run-start`, `step`, `phase-done`
 * ...) or the Op path's settled step records (`{phase, fn, status,
 * durationMs}`, one per line or a whole `{op, records}` envelope). Null for
 * anything else. The same mapping chant documents in `runEventOfProgress` and
 * `runEventsOfStepRecord`; a step record never says why it skipped, so a
 * translated skip carries `skip: null`.
 */
export function legacyRunLine(v: Record<string, unknown>): RunEventBody[] | null {
  const t = v.type;
  const s = (k: string): string | undefined => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  const component = s("component") ?? null;
  const phase = s("phase");
  if (typeof t === "string") {
    switch (t) {
      case "run-start":
        return Array.isArray(v.waves) ? [{ type: "run-start", waves: v.waves.filter(Array.isArray).map((w: unknown[]) => w.filter((c): c is string => typeof c === "string")) }] : null;
      case "wave-start":
        return typeof v.wave === "number" && Array.isArray(v.components)
          ? [{ type: "wave-start", wave: v.wave, components: v.components.filter((c): c is string => typeof c === "string") }]
          : null;
      case "component-start":
        return typeof v.wave === "number" && component ? [{ type: "component-start", wave: v.wave, component }] : null;
      case "phase-start":
        return phase ? [{ type: "phase-start", component, phase }] : null;
      case "step": {
        const step = s("step");
        const status = s("status");
        if (!phase || !step || !status) return null;
        if (status === "running") return [{ type: "step-start", component, phase, step }];
        if (status !== "ok" && status !== "failed") return null;
        return [{ type: "step-settle", component, phase, step, status, durationMs: null, ...(s("error") ? { error: s("error") } : {}) }];
      }
      case "phase-done": {
        const status = settleOf(v.status);
        return phase && status ? [{ type: "phase-settle", component, phase, status }] : null;
      }
      case "component-done": {
        const status = settleOf(v.status);
        return component && status && typeof v.wave === "number" ? [{ type: "component-settle", wave: v.wave, component, status }] : null;
      }
      case "wave-done": {
        const status = settleOf(v.status);
        return typeof v.wave === "number" && status ? [{ type: "wave-settle", wave: v.wave, status }] : null;
      }
      case "run-done": {
        const status = settleOf(v.status);
        return status ? [{ type: "run-settle", status, durationMs: null }] : null;
      }
      default:
        return null;
    }
  }
  const one = legacyStepRecord(v);
  if (one) return [one];
  if (typeof v.op === "string" && Array.isArray(v.records)) {
    const all = v.records.filter(isRecord).map(legacyStepRecord).filter((r): r is RunEventStepSettle => r !== null);
    return all.length ? all : null;
  }
  return null;
}

const LEGACY_RECORD_STATUS: Record<string, RunEventStepStatus> = { ok: "ok", fail: "failed", skipped: "skipped" };

function legacyStepRecord(v: Record<string, unknown>): RunEventStepSettle | null {
  if (typeof v.phase !== "string" || typeof v.fn !== "string" || typeof v.durationMs !== "number") return null;
  const status = typeof v.status === "string" ? LEGACY_RECORD_STATUS[v.status] : undefined;
  if (!status) return null;
  return {
    type: "step-settle",
    component: null,
    phase: v.phase,
    step: v.fn,
    status,
    ...(status === "skipped" ? { skip: null } : {}),
    durationMs: v.durationMs,
    ...(typeof v.error === "string" ? { error: v.error } : {}),
  };
}

// ── The fold: what behold renders ─────────────────────────────────────────────

/** How one step stands. `running` is a step-start not yet settled; the rest
 * are chant's step-settle statuses. */
export type StepState = "running" | RunEventStepStatus;

/** One step as behold draws it: started, then settled in place. */
export interface StepView {
  component: string | null;
  phase: string;
  step: string;
  index?: number;
  state: StepState;
  /** With `skipped`: chant's reason (`receipt`, `resumed`, `refused`,
   * `not-run`), or null when chant did not know. */
  skip?: string | null;
  durationMs?: number | null;
  error?: string;
  message?: string;
  startedAt?: string;
  settledAt?: string;
  /** Who approved the gate this step passed, from `gate-resolved`. */
  approvedBy?: string;
}

/** What a run waits on, from `gate-waiting`: a gate nobody has approved, or a
 * decision point nobody has answered. Cleared by `gate-resolved`. */
export interface WaitingOn {
  op: string;
  gate: string | null;
  point: string | null;
  component: string | null;
  phase: string;
  step: string;
  since: string;
  message?: string;
}

/** A run's verdict as the stream states it: `running` until run-settle. */
export type FoldStatus = "idle" | "running" | RunEventSettleStatus;
/** A wave's or a component's state. */
export type UnitStatus = "pending" | "running" | RunEventComponentSettleStatus;

export interface RunEventFold {
  /** The run's identity, from the envelope (absent on a translated older line). */
  runId: string | null;
  kind: string | null;
  name: string | null;
  runtime: string | null;
  url: string | null;
  status: FoldStatus;
  /** True once `run-settle` arrived: the stream's own end. */
  settled: boolean;
  error?: string;
  waves: Array<{ wave: number; components: string[]; status: UnitStatus }>;
  components: Array<{ component: string; wave: number; status: UnitStatus }>;
  steps: StepView[];
  waitingOn: WaitingOn | null;
  /** The last `seq` seen, and how many events the sequence skipped: a gap is
   * said, never papered over. */
  lastSeq: number | null;
  missed: number;
}

export const initialFold: RunEventFold = {
  runId: null,
  kind: null,
  name: null,
  runtime: null,
  url: null,
  status: "idle",
  settled: false,
  waves: [],
  components: [],
  steps: [],
  waitingOn: null,
  lastSeq: null,
  missed: 0,
};

const sameStep = (s: StepView, component: string | null, phase: string, step: string, index: number | undefined): boolean =>
  s.component === component && s.phase === phase && s.step === step && (index === undefined || s.index === undefined || s.index === index);

/** A component's state from what one of its steps just did: a failure, a gate
 * or a decision point shows on the component at once. */
function componentFromStep(prev: UnitStatus, state: StepState): UnitStatus {
  if (state === "failed") return "failed";
  if (state === "gated" || state === "waiting") return state;
  return prev === "pending" ? "running" : prev;
}

/**
 * Fold one event into the run. Pure; returns a new fold. Events the fold has
 * no use for (a phase start or settle) only move the sequence.
 */
export function foldRunEvent(fold: RunEventFold, e: RunLine): RunEventFold {
  let next: RunEventFold = { ...fold };
  let at: string | undefined;
  if ("seq" in e) {
    // A validated event: the envelope names the run and the moment.
    if (next.lastSeq !== null && e.seq > next.lastSeq + 1) next.missed += e.seq - next.lastSeq - 1;
    next.lastSeq = e.seq;
    next.runId = e.runId;
    next.kind = e.kind;
    next.name = e.name;
    next.runtime = e.runtime;
    if (e.runOrigin.url) next.url = e.runOrigin.url;
    at = e.at;
  }

  switch (e.type) {
    case "run-start": {
      const waves = e.waves ?? [];
      next = {
        ...next,
        status: "running",
        settled: false,
        waves: waves.map((components, i) => ({ wave: i + 1, components, status: "pending" as const })),
        components: waves.flatMap((components, i) => components.map((c) => ({ component: c, wave: i + 1, status: "pending" as const }))),
      };
      break;
    }
    case "wave-start":
      next.waves = next.waves.map((w) => (w.wave === e.wave ? { ...w, status: "running" } : w));
      break;
    case "wave-settle":
      next.waves = next.waves.map((w) => (w.wave === e.wave ? { ...w, status: e.status } : w));
      break;
    case "component-start":
      next.components = next.components.map((c) => (c.component === e.component ? { ...c, status: "running" } : c));
      break;
    case "component-settle":
      next.components = next.components.map((c) => (c.component === e.component ? { ...c, status: e.status } : c));
      break;
    case "step-start": {
      next.steps = [...next.steps, { component: e.component, phase: e.phase, step: e.step, ...(e.index !== undefined ? { index: e.index } : {}), state: "running", ...(at ? { startedAt: at } : {}) }];
      next.components = next.components.map((c) => (c.component === e.component && c.status === "pending" ? { ...c, status: "running" } : c));
      break;
    }
    case "step-settle": {
      const state: StepState = e.status;
      const settled: Partial<StepView> = {
        state,
        ...(e.skip !== undefined ? { skip: e.skip } : {}),
        durationMs: e.durationMs,
        ...(e.error ? { error: e.error } : {}),
        ...(e.message ? { message: e.message } : {}),
        ...(at ? { settledAt: at } : {}),
      };
      const i = next.steps.findIndex((s) => s.state === "running" && sameStep(s, e.component, e.phase, e.step, e.index));
      next.steps =
        i >= 0
          ? next.steps.map((s, j) => (j === i ? { ...s, ...settled } : s))
          : [...next.steps, { component: e.component, phase: e.phase, step: e.step, ...(e.index !== undefined ? { index: e.index } : {}), state, ...settled }];
      if (e.component !== null) next.components = next.components.map((c) => (c.component === e.component ? { ...c, status: componentFromStep(c.status, state) } : c));
      break;
    }
    case "gate-waiting":
      next.waitingOn = {
        op: e.op,
        gate: e.gate,
        point: e.point,
        component: e.component,
        phase: e.phase,
        step: e.step,
        since: at ?? "",
        ...(e.message ? { message: e.message } : {}),
      };
      break;
    case "gate-resolved": {
      next.waitingOn = null;
      const i = next.steps.findIndex((s) => s.state === "running" && sameStep(s, e.component, e.phase, e.step, e.index));
      if (i >= 0) next.steps = next.steps.map((s, j) => (j === i ? { ...s, approvedBy: e.resolvedBy } : s));
      break;
    }
    case "run-settle": {
      next = { ...next, status: e.status, settled: true, ...(e.error ? { error: e.error } : {}) };
      // A run that settled ok or failed waits on nobody.
      if (e.status === "ok" || e.status === "failed") next.waitingOn = null;
      break;
    }
    default:
      break;
  }
  return next;
}

/** Fold a whole stream, e.g. a recorded fixture or a replay. */
export function foldRunEvents(events: Iterable<RunLine>, from: RunEventFold = initialFold): RunEventFold {
  let f = from;
  for (const e of events) f = foldRunEvent(f, e);
  return f;
}

/** A step as one now-line, so reading the structured stream costs the
 * operator none of chant's per-step narration. Null for an event with no
 * line of its own. */
export function runEventLine(e: RunLine): string | null {
  const parts = (x: { component?: string | null; phase?: string; step?: string }): string => [x.component, x.phase, x.step].filter(Boolean).join(" · ");
  const took = (ms: number | null): string => (ms === null ? "" : ms < 1000 ? ` (${ms}ms)` : ` (${(ms / 1000).toFixed(1)}s)`);
  switch (e.type) {
    case "step-start":
      return `▶ ${parts(e)}`;
    case "step-settle": {
      const mark = e.status === "ok" ? "✓" : e.status === "failed" ? "✗" : e.status === "gated" || e.status === "waiting" ? "⏸" : "•";
      const why = e.status === "skipped" && e.skip ? ` (${e.skip})` : "";
      const tail = e.error ?? e.message;
      return `${mark} ${parts(e)}: ${e.status}${why}${e.status === "ok" || e.status === "failed" ? took(e.durationMs) : ""}${tail ? `: ${tail}` : ""}`;
    }
    case "gate-waiting":
      return `⏸ ${parts(e)}: waiting on ${e.gate ? `gate ${e.gate}` : `decision point ${e.point}`}`;
    case "gate-resolved":
      return `✓ ${parts(e)}: gate ${e.gate} approved by ${e.resolvedBy}`;
    case "run-settle":
      return `■ run ${e.status}${e.error ? `: ${e.error}` : ""}`;
    default:
      return null;
  }
}
