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
 * ## The schema, vendored
 *
 * `./run-event-schema/run-event.schema.json` is chant's file, copied
 * unchanged from {@link RUN_EVENT_SCHEMA_SOURCE}. chant exports the matching
 * TypeScript types (`RunEvent*` from `@intentius/chant`) from 0.124.28, which
 * is not published yet, so behold does not copy them by hand: it validates
 * against the schema and reads each validated event's fields through the
 * small accessors below.
 *
 * TODO(chant 0.124.28, behold#679): once @intentius/chant 0.124.28 is on npm,
 * bump behold's dependency, import `RunEvent` and `RunEventBody` from
 * `@intentius/chant` as `RunEventLine`'s type, drop the accessors, and keep
 * the schema check at the boundary.
 *
 * ## The older streams, behind the floor
 *
 * A chant older than {@link RUN_EVENTS_CHANT_FLOOR} has no `--events-json`.
 * behold starts it with `--progress-json` (degraded mode, src/op-runner.ts),
 * and {@link legacyRunLine} translates each of that stream's lines into the
 * same event shape at this boundary, the way chant's own `runEventOfProgress`
 * and `runEventsOfStepRecord` do, so one fold renders both. The old shapes
 * have no types here: the translation reads their fields by name.
 *
 * Pure apart from the schema compile. No chant library import.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import runEventSchema from "./run-event-schema/run-event.schema.json" with { type: "json" };

/** Where the vendored schema comes from. The schema file last changed in
 * chant at af9e261ad (#4057); it is unchanged at the commit named here. */
export const RUN_EVENT_SCHEMA_SOURCE = {
  repo: "INTENTIUS/chant",
  path: "packages/core/src/workspace/run-event.schema.json",
  commit: "54a03021356381611d94cfbe267935420a497182",
  release: "0.124.28",
} as const;

/** The schema's `$id`, which every event carries as `$schema`. */
export const RUN_EVENT_SCHEMA_ID: string = runEventSchema.$id;

/** The run-event contract version behold reads. */
export const RUN_EVENT_CONTRACT = 1;

/**
 * One validated line of a run's stream: the envelope (`runId`, `kind`,
 * `name`, `runtime`, `seq`, `at` ...) and the body, as chant wrote them. Read
 * its fields through {@link str}, {@link num} and friends.
 *
 * TODO(chant 0.124.28, behold#679): this becomes chant's exported `RunEvent`.
 */
export type RunEventLine = { readonly type: string; readonly [field: string]: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A string field, or undefined. */
export const str = (e: RunEventLine, k: string): string | undefined => (typeof e[k] === "string" ? (e[k] as string) : undefined);
/** A string-or-null field (`component`, `gate`, `point`, `gitSha`), with null kept. */
export const strOrNull = (e: RunEventLine, k: string): string | null => (typeof e[k] === "string" ? (e[k] as string) : null);
/** A number field, or undefined. */
export const num = (e: RunEventLine, k: string): number | undefined => (typeof e[k] === "number" ? (e[k] as number) : undefined);

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
  | { kind: "event"; event: RunEventLine }
  /** A line that names the run-event schema but fails it, or names another
   * contract. It is not folded; the reason goes on the now-line. */
  | { kind: "refused"; reason: string }
  /** An older `--progress-json` line (degraded mode), translated. */
  | { kind: "legacy"; events: RunEventLine[] };

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
    return { kind: "event", event: parsed as RunEventLine };
  }
  const legacy = legacyRunLine(parsed);
  return legacy ? { kind: "legacy", events: legacy } : null;
}

// ── The older streams, translated (degraded mode) ─────────────────────────────

const LEGACY_SETTLE = new Set(["ok", "failed", "gated"]);

/**
 * One parsed line of an older `--progress-json` stream, as run-event bodies:
 * the components driver's progress events (`run-start`, `step`, `phase-done`
 * ...) or the Op path's settled step records (`{phase, fn, status,
 * durationMs}`, one per line or a whole `{op, records}` envelope). Null for
 * anything else. The same mapping chant documents in `runEventOfProgress` and
 * `runEventsOfStepRecord`; a step record never says why it skipped, so a
 * translated skip carries `skip: null`.
 */
export function legacyRunLine(v: Record<string, unknown>): RunEventLine[] | null {
  const t = v.type;
  const s = (k: string): string | undefined => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  const component = s("component") ?? null;
  if (typeof t === "string") {
    switch (t) {
      case "run-start":
        return Array.isArray(v.waves) ? [{ type: "run-start", waves: v.waves }] : null;
      case "wave-start":
        return typeof v.wave === "number" && Array.isArray(v.components) ? [{ type: "wave-start", wave: v.wave, components: v.components }] : null;
      case "component-start":
        return typeof v.wave === "number" && component ? [{ type: "component-start", wave: v.wave, component }] : null;
      case "phase-start":
        return s("phase") ? [{ type: "phase-start", component, phase: s("phase") }] : null;
      case "step": {
        const phase = s("phase");
        const step = s("step");
        const status = s("status");
        if (!phase || !step || !status) return null;
        if (status === "running") return [{ type: "step-start", component, phase, step }];
        if (status !== "ok" && status !== "failed") return null;
        return [{ type: "step-settle", component, phase, step, status, durationMs: null, ...(s("error") ? { error: s("error") } : {}) }];
      }
      case "phase-done":
        return s("phase") && LEGACY_SETTLE.has(s("status") ?? "") ? [{ type: "phase-settle", component, phase: s("phase"), status: s("status") }] : null;
      case "component-done":
        return component && LEGACY_SETTLE.has(s("status") ?? "") ? [{ type: "component-settle", wave: v.wave, component, status: s("status") }] : null;
      case "wave-done":
        return typeof v.wave === "number" && LEGACY_SETTLE.has(s("status") ?? "") ? [{ type: "wave-settle", wave: v.wave, status: s("status") }] : null;
      case "run-done":
        return LEGACY_SETTLE.has(s("status") ?? "") ? [{ type: "run-settle", status: s("status"), durationMs: null }] : null;
      default:
        return null;
    }
  }
  const one = legacyStepRecord(v);
  if (one) return [one];
  if (typeof v.op === "string" && Array.isArray(v.records)) {
    const all = v.records.filter(isRecord).map(legacyStepRecord).filter((r): r is RunEventLine => r !== null);
    return all.length ? all : null;
  }
  return null;
}

const LEGACY_RECORD_STATUS: Record<string, string> = { ok: "ok", fail: "failed", skipped: "skipped" };

function legacyStepRecord(v: Record<string, unknown>): RunEventLine | null {
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
export type StepState = "running" | "ok" | "failed" | "skipped" | "cached" | "gated" | "waiting";

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
export type FoldStatus = "idle" | "running" | "ok" | "failed" | "gated" | "waiting";
/** A wave's or a component's state. */
export type UnitStatus = "pending" | "running" | "ok" | "failed" | "gated" | "waiting";

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
export function foldRunEvent(fold: RunEventFold, e: RunEventLine): RunEventFold {
  let next: RunEventFold = { ...fold };
  const seq = num(e, "seq");
  if (seq !== undefined) {
    if (next.lastSeq !== null && seq > next.lastSeq + 1) next.missed += seq - next.lastSeq - 1;
    next.lastSeq = seq;
  }
  if (str(e, "runId")) next.runId = str(e, "runId")!;
  if (str(e, "kind")) next.kind = str(e, "kind")!;
  if (str(e, "name")) next.name = str(e, "name")!;
  if (str(e, "runtime")) next.runtime = str(e, "runtime")!;
  const origin = e.runOrigin;
  if (isRecord(origin) && typeof origin.url === "string") next.url = origin.url;
  const at = str(e, "at");
  const component = strOrNull(e, "component");
  const phase = str(e, "phase") ?? "";
  const step = str(e, "step") ?? "";
  const index = num(e, "index");

  switch (e.type) {
    case "run-start": {
      const waves = Array.isArray(e.waves) ? (e.waves as unknown[]).filter(Array.isArray).map((w) => (w as unknown[]).filter((c): c is string => typeof c === "string")) : [];
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
      next.waves = next.waves.map((w) => (w.wave === e.wave ? { ...w, status: (str(e, "status") ?? "ok") as UnitStatus } : w));
      break;
    case "component-start":
      next.components = next.components.map((c) => (c.component === component ? { ...c, status: "running" } : c));
      break;
    case "component-settle":
      next.components = next.components.map((c) => (c.component === component ? { ...c, status: (str(e, "status") ?? "ok") as UnitStatus } : c));
      break;
    case "step-start": {
      next.steps = [...next.steps, { component, phase, step, ...(index !== undefined ? { index } : {}), state: "running", ...(at ? { startedAt: at } : {}) }];
      next.components = next.components.map((c) => (c.component === component && c.status === "pending" ? { ...c, status: "running" } : c));
      break;
    }
    case "step-settle": {
      const state = (str(e, "status") ?? "ok") as StepState;
      const settled: Partial<StepView> = {
        state,
        ...("skip" in e ? { skip: (e.skip as string | null) ?? null } : {}),
        ...("durationMs" in e ? { durationMs: (e.durationMs as number | null) ?? null } : {}),
        ...(str(e, "error") ? { error: str(e, "error") } : {}),
        ...(str(e, "message") ? { message: str(e, "message") } : {}),
        ...(at ? { settledAt: at } : {}),
      };
      const i = next.steps.findIndex((s) => s.state === "running" && sameStep(s, component, phase, step, index));
      next.steps =
        i >= 0
          ? next.steps.map((s, j) => (j === i ? { ...s, ...settled } : s))
          : [...next.steps, { component, phase, step, ...(index !== undefined ? { index } : {}), state, ...settled }];
      if (component !== null) next.components = next.components.map((c) => (c.component === component ? { ...c, status: componentFromStep(c.status, state) } : c));
      break;
    }
    case "gate-waiting":
      next.waitingOn = {
        op: str(e, "op") ?? next.name ?? "",
        gate: strOrNull(e, "gate"),
        point: strOrNull(e, "point"),
        component,
        phase,
        step,
        since: at ?? "",
        ...(str(e, "message") ? { message: str(e, "message") } : {}),
      };
      break;
    case "gate-resolved": {
      next.waitingOn = null;
      const who = str(e, "resolvedBy");
      const i = next.steps.findIndex((s) => s.state === "running" && sameStep(s, component, phase, step, index));
      if (i >= 0 && who) next.steps = next.steps.map((s, j) => (j === i ? { ...s, approvedBy: who } : s));
      break;
    }
    case "run-settle": {
      const status = (str(e, "status") ?? "ok") as FoldStatus;
      next = { ...next, status, settled: true, ...(str(e, "error") ? { error: str(e, "error") } : {}) };
      // A run that settled ok or failed waits on nobody.
      if (status === "ok" || status === "failed") next.waitingOn = null;
      break;
    }
    default:
      break;
  }
  return next;
}

/** Fold a whole stream, e.g. a recorded fixture or a replay. */
export function foldRunEvents(events: Iterable<RunEventLine>, from: RunEventFold = initialFold): RunEventFold {
  let f = from;
  for (const e of events) f = foldRunEvent(f, e);
  return f;
}

/** A step as one now-line, so reading the structured stream costs the
 * operator none of chant's per-step narration. Null for an event with no
 * line of its own. */
export function runEventLine(e: RunEventLine): string | null {
  const where = [str(e, "component"), str(e, "phase"), str(e, "step")].filter(Boolean).join(" · ");
  const took = (ms: unknown): string => (typeof ms !== "number" ? "" : ms < 1000 ? ` (${ms}ms)` : ` (${(ms / 1000).toFixed(1)}s)`);
  switch (e.type) {
    case "step-start":
      return `▶ ${where}`;
    case "step-settle": {
      const status = str(e, "status");
      const mark = status === "ok" ? "✓" : status === "failed" ? "✗" : status === "gated" || status === "waiting" ? "⏸" : "•";
      const why = status === "skipped" && typeof e.skip === "string" ? ` (${e.skip})` : "";
      const tail = str(e, "error") ?? str(e, "message");
      return `${mark} ${where}: ${status}${why}${status === "ok" || status === "failed" ? took(e.durationMs) : ""}${tail ? `: ${tail}` : ""}`;
    }
    case "gate-waiting":
      return `⏸ ${where}: waiting on ${e.gate ? `gate ${String(e.gate)}` : `decision point ${String(e.point)}`}`;
    case "gate-resolved":
      return `✓ ${where}: gate ${String(e.gate)} approved by ${String(e.resolvedBy)}`;
    case "run-settle":
      return `■ run ${str(e, "status")}${str(e, "error") ? `: ${str(e, "error")}` : ""}`;
    default:
      return null;
  }
}
