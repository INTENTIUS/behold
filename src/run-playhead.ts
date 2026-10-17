/**
 * The run playhead (#284 item 2): live run state painted over the declared op
 * track the ops lens (#284 item 1, src/ops-lens.ts) already draws, plus a
 * pending gate as a first-class card (#234's shape).
 *
 * Two chant surfaces feed it:
 *
 *  1. **The run's events** (#679, INTENTIUS/chant#4019): `chant run <name>
 *     --events-json` streams every step's start and settle, each skip with its
 *     reason, a cache hit, and the gate or decision point a run waits on, as
 *     it happens. A run behold did not start is read with `chant run events
 *     <run> --json --follow`. src/run-events.ts validates and folds the lines;
 *     the state below keeps the fold's {@link StepView}s. Below chant 0.124.28
 *     behold starts the run with the older `--progress-json` (one line per
 *     settled step, translated at the same boundary) and says it is degraded.
 *  2. **The run's status**: `chant run status <name>` on the resolved runtime
 *     (chant#2121): the newest run's state, its id, and the gate it stopped at
 *     when it is `gated`. behold shells it beside the `chant run approve` it
 *     shells to record a gate's resolution.
 *
 * ## The honesty rules this module exists to keep
 *
 *  - **Run state is strictly additive paint.** {@link paintPlayhead} takes the
 *    lens's own `GraphIR` and returns a new one; with no run data it returns the
 *    input untouched, so the declared track renders exactly as it did before.
 *  - **Only settled steps are painted as settled.** A step chant says started
 *    is painted running; on the older stream, which says nothing until a step
 *    settles, the step AFTER the last settled one is marked as the playhead
 *    position and says "reached, not settled". Neither is coloured as done.
 *  - **A dead stream is never completion.** The run's verdict is the stream's
 *    own `run-settle`. A process that ends without one is `lost`: the playhead
 *    freezes at last-settled and says the stream was lost.
 *  - **Absence of a gate signal is never progress.** A gate paints as pending
 *    only when chant NAMED it (`gate-waiting`, or the status read). When the
 *    read can't be had at all (no runtime, no run, an older chant)
 *    {@link readRunStatus} returns a refusal the view states plainly instead
 *    of a silently ungated track.
 *  - **behold never signals on its own initiative.** Nothing here writes. The
 *    pending card's approve action is the caller's existing
 *    `POST /api/ops/:name/signal/:gate`, the same delegated write the current
 *    gate button already uses.
 */
import type { GraphIR, IRNode } from "@intentius/chant";
import { opPlacedSteps, receiptName, type OpIr, type PlacedStep } from "./ops-lens.ts";
import type { RunEventFold, StepView, WaitingOn } from "./run-events.ts";

/** The gate a run stopped at: from chant's `gate-waiting` event, or the
 * status read's `Gate` line. `signalName` is the gate's name (the field keeps
 * its old spelling: the page and the approve route key on it); `since` is
 * when the run began waiting. */
export interface GateState {
  signalName: string;
  description?: string;
  since: string;
}

/** The two synthesized step names an effect step's read-compare-run-write
 * compiles to (`receiptRead` before and `receiptWrite` after the inner steps).
 * Kept here so this module stays lexicon-free. They arrive as steps but have
 * no card of their own: the effect card owns them ({@link slotsFor}). */
const RECEIPT_READ_FN = "receiptRead";
const RECEIPT_WRITE_FN = "receiptWrite";

/** A settled step as one now-line, for a step the older stream reported. */
export function stepLine(step: StepView): string {
  const mark = step.state === "ok" ? "✓" : step.state === "failed" ? "✗" : "•";
  const took = step.durationMs == null ? step.state : step.state === "skipped" ? "skipped" : tookLabel(step.durationMs);
  return `${mark} ${step.phase} · ${step.step}: ${took}${step.error ? `: ${step.error}` : ""}`;
}

// ── `chant run status` — the gate read ────────────────────────────────────────

/** A refusal from the status read: why behold has no run state to show, and
 * what to do about it. #193's structured-error standard, the shape the SPA's
 * precondition card renders. */
export interface RunStatusRefusal {
  error: string;
  code: "no-run" | "run-status";
  remedy: string;
}

/** What `chant run status <name>` said (chant's `renderRuntimeStatus`,
 * `packages/core/src/cli/handlers/run.ts`). `gate: null` means the newest run
 * is not waiting on a gate; a gate object means a human is being waited on
 * right now. */
export interface RunStatusRead {
  op: string;
  /** The runtime that answered (`local` unless the project names another). */
  runtime?: string;
  runId?: string;
  /** chant's `OpRunState`: running / completed / failed / gated / waiting / cancelled. */
  status?: string;
  startedAt?: string;
  endedAt?: string;
  /** `Steps : <settled>/<total> settled`, when the runtime had the records. */
  steps?: { settled: number; total: number };
  /** chant's `Error` line for a failed run. */
  error?: string;
  gate: GateState | null;
}

export type RunStatusResult = { ok: true; read: RunStatusRead } | { ok: false; refusal: RunStatusRefusal };

/** chant paints its CLI errors, and stdout isn't a TTY under behold, so the
 * bold/colour escapes ride along in what we capture. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, "");

/** The labelled block `chant run status` prints (`  Gate        : …`). Read as
 * "label, colon, value", not by column, so chant widening its label gutter
 * doesn't break the read. */
function statusFields(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of strip(stdout).split("\n")) {
    const m = /^\s{2,}([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/.exec(raw);
    if (m) out.set(m[1].trim(), m[2].trim());
  }
  return out;
}

/**
 * The `Gate` line, back into the gate it was printed from.
 *
 * chant prints it as, verbatim from `renderRuntimeStatus` in
 * `packages/core/src/cli/handlers/run.ts`:
 *
 *     `  Gate        : ${status.gate.name} (pending since ${status.gate.since})`
 *
 * A ` — <description>` after the name is still read, since chant printed one
 * before chant#2121. A line that doesn't match this shape yields nothing
 * rather than a half-read gate: a card that names the wrong gate would record
 * the wrong approval.
 */
export function parseGateLine(line: string): GateState | null {
  const m = /^(.*?)(?: — (.*?))? \((?:pending|waiting) since (.+)\)$/.exec(line.trim());
  if (!m) return null;
  const signalName = m[1].trim();
  if (!signalName) return null;
  return { signalName, ...(m[2] ? { description: m[2].trim() } : {}), since: m[3].trim() };
}

/**
 * Read one `chant run status <name>` invocation.
 *
 * A non-zero exit is a refusal, never an empty run: surfaced verbatim under
 * `run-status` rather than being guessed at. So is chant's "No run of Op …
 * is recorded" line, which it prints on stderr with exit 0 and nothing on
 * stdout: that is a true answer ("this runtime has never run it"), and it is
 * not "no gate pending". A status read that quietly degraded to "no gate
 * pending" would paint an un-approved gate as progress.
 */
export function readRunStatus(op: string, run: { code: number; stdout: string; stderr: string }): RunStatusResult {
  const err = strip(run.stderr).trim();
  const firstLine = (m: string): string => m.split("\n")[0].replace(/^error:\s*/, "");
  if (run.code !== 0) {
    const message = err || strip(run.stdout).trim() || `chant run status exited ${run.code}`;
    return {
      ok: false,
      refusal: {
        error: `chant run status ${op} failed: ${firstLine(message)}`,
        code: "run-status",
        remedy: "Run `chant run status " + op + "` in the project to see the whole error.",
      },
    };
  }

  const f = statusFields(run.stdout);
  if (!f.has("State")) {
    // Exit 0 with no status block: chant's "no run recorded" answer.
    return {
      ok: false,
      refusal: {
        error: `No run of "${op}" to report — ${firstLine(err) || "chant printed no run status"}`,
        code: "no-run",
        remedy: "Start the Op (Run) and the playhead fills in when it settles.",
      },
    };
  }
  const steps = /^(\d+)\/(\d+)/.exec(f.get("Steps") ?? "");
  const gateLine = f.get("Gate");
  return {
    ok: true,
    read: {
      op,
      ...(f.get("Runtime") ? { runtime: f.get("Runtime") } : {}),
      ...(f.get("Run ID") ? { runId: f.get("Run ID") } : {}),
      ...(f.get("State") ? { status: f.get("State") } : {}),
      ...(f.get("Started") ? { startedAt: f.get("Started") } : {}),
      ...(f.get("Ended") ? { endedAt: f.get("Ended") } : {}),
      ...(steps ? { steps: { settled: Number(steps[1]), total: Number(steps[2]) } } : {}),
      ...(f.get("Error") ? { error: f.get("Error") } : {}),
      // chant prints a Gate line only for a gated run; no line means no gate is
      // waiting on a human right now.
      gate: gateLine ? parseGateLine(gateLine) : null,
    },
  };
}

// ── The run state behold holds and broadcasts ─────────────────────────────────

/**
 * How a run ended, from behold's side of the stream.
 *
 * `lost` is the honest extra value: the watched stream ended without chant's
 * `run-settle` (or, on the older stream, without a clean exit or a failed step
 * to point at), so behold knows the stream stopped and knows nothing about
 * the run. It is never `ok`.
 *
 * `gated`: the run stopped at a gate nobody has approved (`run-settle` says
 * so, or chant exited {@link GATED_EXIT_CODE} on the older stream). `waiting`:
 * it stopped at a decision point nobody has answered. Nothing after either ran.
 */
export type RunStatus = "idle" | "running" | "ok" | "failed" | "gated" | "waiting" | "lost";

/** chant's exit code for a run that stopped at a gate (`GATED_EXIT_CODE`,
 * `packages/core/src/cli/handlers/run.ts`, chant#2119). behold never passes
 * `--gated-exit`, so a gated run always exits with it. */
export const GATED_EXIT_CODE = 3;

/** Where the run state came from: chant's run events, or the older
 * `--progress-json` stream of a chant below the run-events floor (degraded). */
export type RunSource = "events" | "progress";

export interface RunState {
  /** The Op being watched, or null when nothing has run this session. */
  op: string | null;
  /** Which executor's stream this is. Only `local` is left since chant removed
   * the temporal lexicon (#459). */
  mode: "local" | null;
  status: RunStatus;
  /** The run's steps as chant reported them: started, then settled in place. */
  steps: StepView[];
  /** The gate the run waits on (a human is being waited on), or null (nothing
   * pending, or never asked: `gateNote` says which). */
  gate: GateState | null;
  /** Why there is no gate answer, when there isn't one to be had. */
  gateNote: string | null;
  /** The decision point the run waits on, from `gate-waiting` with no gate. */
  point: { id: string; since: string; message?: string } | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Set with `status: "lost"`: what behold knows, and stops claiming. */
  lost: string | null;
  /** Where the steps came from; null before any run. */
  source: RunSource | null;
  /** Why the state is less than chant's run events (degraded mode, a steward
   * run with no events on this host), when it is. */
  sourceNote: string | null;
  /** The run's id and runtime, from the event envelope or the status read. */
  runId: string | null;
  runtime: string | null;
  /** True while behold follows a run it did not start (`chant run events
   * --follow`). */
  following: boolean;
}

export const initialRunState: RunState = {
  op: null,
  mode: null,
  status: "idle",
  steps: [],
  gate: null,
  gateNote: null,
  point: null,
  startedAt: null,
  endedAt: null,
  lost: null,
  source: null,
  sourceNote: null,
  runId: null,
  runtime: null,
  following: false,
};

/** A run behold just triggered. Clears the previous run's terminal state so a
 * reload between trigger and first event can't show the last run's colours. */
export function runStarted(op: string, mode: "local", at: string, source: RunSource = "events", sourceNote: string | null = null): RunState {
  return { ...initialRunState, op, mode, status: "running", startedAt: at, source, sourceNote };
}

/** The gate a `gate-waiting` names, as the card's shape. */
function gateOf(w: WaitingOn): GateState | null {
  return w.gate ? { signalName: w.gate, since: w.since, ...(w.message ? { description: w.message } : {}) } : null;
}

/**
 * The run state after the fold moved. The steps are the fold's; the gate is
 * the one chant's `gate-waiting` named, or, when the stream named none, the
 * last status read's (kept, since the status read is the only gate source on
 * the older stream). A settled run takes the stream's verdict.
 */
export function runFromFold(state: RunState, fold: RunEventFold): RunState {
  const waiting = fold.waitingOn;
  const status: RunStatus = fold.settled ? (fold.status as RunStatus) : state.status === "idle" ? "running" : state.status;
  return {
    ...state,
    status,
    steps: fold.steps,
    // On the events path the stream names the gate (gate-waiting) and clears
    // it (gate-resolved, or a run that settled ok or failed). The older
    // stream names none, so the status read's answer stays.
    gate: state.source === "events" ? (waiting ? gateOf(waiting) : null) : state.gate,
    point: waiting && !waiting.gate && waiting.point ? { id: waiting.point, since: waiting.since, ...(waiting.message ? { message: waiting.message } : {}) } : null,
    ...(waiting?.gate ? { gateNote: null } : {}),
    runId: fold.runId ?? state.runId,
    runtime: fold.runtime ?? state.runtime,
    ...(fold.settled && !state.endedAt ? { endedAt: new Date().toISOString() } : {}),
  };
}

/** Fold the status read in: an answer, or the refusal's reason. A gate the
 * stream named stays: the stream saw it happen. */
export function runGate(state: RunState, result: RunStatusResult): RunState {
  if (!result.ok) return { ...state, gate: state.source === "events" && state.gate ? state.gate : null, gateNote: result.refusal.error };
  return {
    ...state,
    gate: result.read.gate ?? (state.source === "events" && state.status === "gated" ? state.gate : null),
    gateNote: null,
    runId: state.runId ?? result.read.runId ?? null,
    runtime: state.runtime ?? result.read.runtime ?? null,
  };
}

/**
 * The watched process ended.
 *
 * On the events path the stream's own `run-settle` is the verdict, and a
 * process that ended without one is `lost`: chant always closes the stream,
 * so a missing settle means the process died (a SIGKILL writes none).
 *
 * On the older stream (degraded mode), a clean exit is the only thing that
 * reads as completion. A non-zero exit with a failed step reads as a failed
 * run. Exit 3 with none is a gate. A non-zero exit with NOTHING to point at
 * is `lost`.
 */
export function runEnded(state: RunState, exitCode: number, at: string, settled = false): RunState {
  if (state.status !== "running") return state.endedAt ? state : { ...state, endedAt: at };
  const n = state.steps.filter((s) => s.state !== "running").length;
  const failed = state.steps.some((s) => s.state === "failed");
  if (state.source !== "progress") {
    if (settled) return { ...state, endedAt: at };
    return {
      ...state,
      status: "lost",
      endedAt: at,
      lost:
        `the run-event stream ended (exit ${exitCode}) after ${n} settled step${n === 1 ? "" : "s"} without run-settle, ` +
        `so behold does not know how the run ended; the playhead stays at the last settled step.`,
    };
  }
  if (exitCode === 0) return { ...state, status: "ok", endedAt: at };
  if (exitCode === GATED_EXIT_CODE && !failed) return { ...state, status: "gated", endedAt: at };
  if (failed) return { ...state, status: "failed", endedAt: at };
  return {
    ...state,
    status: "lost",
    endedAt: at,
    lost:
      `the progress stream ended (exit ${exitCode}) after ${n} settled ` +
      `step${n === 1 ? "" : "s"} without a failed step, so behold does not know whether the Op ` +
      `failed or the stream broke; the playhead stays at the last settled step.`,
  };
}

/** The stream died outright (a spawn error, a killed process, a follow that
 * went silent). Same rule as a verdictless exit, with the caller's reason. */
export function runLost(state: RunState, reason: string, at: string): RunState {
  return state.status === "running" || state.following
    ? { ...state, status: state.status === "running" ? "lost" : state.status, endedAt: at, lost: reason, following: false }
    : state;
}

// ── Joining steps to the cards the ops lens drew ──────────────────────────────

/** What one card learned from the run. */
export interface StepRun {
  status: Exclude<StepView["state"], "running">;
  durationMs: number;
  /** With `skipped`: chant's reason. */
  skip?: string | null;
  error?: string;
  message?: string;
  approvedBy?: string;
  /** How many steps this card took (an effect card owns several). */
  records: number;
}

export interface RunJoin {
  /** node id, then what settled there. */
  byNode: Map<string, StepRun>;
  /** The node the playhead sits on: the step chant says is running, the gate
   * a run waits on, or (on the older stream) the first main-track step after
   * the last settled one. Null when nothing has happened yet. */
  at: string | null;
  /** Why {@link at} is where it is, stated on the card, never inferred by the
   * reader. */
  atReason: string | null;
  /** Steps that matched no card. A stream that outruns the declared track is
   * a fact worth showing, not one to silently drop. */
  unplaced: StepView[];
}

/** The (phase, step) slots one Op's cards can absorb steps into, in declared
 * order. A gate's slot takes chant's `gate:<name>` step; an effect card absorbs
 * its own `effect:<receipt>` step, the synthesized receipt reads and writes and
 * every nested activity, because chant reports each while the lens draws the
 * effect whole. */
function slotsFor(placed: PlacedStep[]): Array<{ id: string; phase: string; fn: string }> {
  const out: Array<{ id: string; phase: string; fn: string }> = [];
  for (const p of placed) {
    if (p.step.kind === "activity") {
      out.push({ id: p.id, phase: p.phase, fn: p.step.fn });
    } else if (p.step.kind === "effect") {
      out.push({ id: p.id, phase: p.phase, fn: `effect:${receiptName(p.step)}` });
      out.push({ id: p.id, phase: p.phase, fn: RECEIPT_READ_FN });
      for (const nested of p.step.steps ?? []) {
        if (nested.kind === "activity") out.push({ id: p.id, phase: p.phase, fn: nested.fn });
      }
      out.push({ id: p.id, phase: p.phase, fn: RECEIPT_WRITE_FN });
    } else if (p.step.kind === "gate") {
      // chant's executor names a gate step `gate:<name>`.
      out.push({ id: p.id, phase: p.phase, fn: `gate:${p.step.signalName}` });
    }
  }
  return out;
}

/** Which of two outcomes a card shows when several steps fall on it: a
 * failure outranks a stop at a gate, which outranks an ok, which outranks a
 * cache hit and a skip. The card must not read green because the LAST of its
 * inner steps happened to succeed. */
const RANK: Record<StepRun["status"], number> = { failed: 6, gated: 5, waiting: 5, ok: 3, cached: 2, skipped: 1 };

function mergeRun(prev: StepRun | undefined, step: StepView): StepRun {
  const status = step.state as StepRun["status"];
  const keepPrev = prev && RANK[prev.status] >= RANK[status];
  const top = keepPrev ? prev : undefined;
  return {
    status: top ? top.status : status,
    durationMs: (prev?.durationMs ?? 0) + (step.durationMs ?? 0),
    ...(top ? (top.skip !== undefined ? { skip: top.skip } : {}) : status === "skipped" ? { skip: step.skip ?? null } : {}),
    ...(top?.error ? { error: top.error } : step.error ? { error: step.error } : {}),
    ...(top?.message ? { message: top.message } : step.message ? { message: step.message } : {}),
    ...(prev?.approvedBy ? { approvedBy: prev.approvedBy } : step.approvedBy ? { approvedBy: step.approvedBy } : {}),
    records: (prev?.records ?? 0) + 1,
  };
}

/**
 * Join a run's steps to the ops lens's own node ids.
 *
 * Positional, per (phase, step), in declared order: the same rule chant uses
 * to build the steps in the first place, so the two agree by construction. A
 * step for a (phase, step) whose slots are already used goes to `unplaced`
 * rather than shifting the track: defense-in-depth against any emitter
 * repeating a step (chant 0.52.1's `--progress-json` did, chant#2032, fixed in
 * 0.53.1). src/run-playhead.test.ts keeps that pre-fix stream as a fixture.
 *
 * `guessNext: false` (a run read from chant's run events) turns off the
 * reached-not-settled marker: the events name the running step themselves.
 */
export function joinRun(op: OpIr, steps: StepView[], gate: GateState | null, opts: { guessNext?: boolean } = {}): RunJoin {
  const placed = opPlacedSteps(op);
  const slots = slotsFor(placed);
  const byKey = new Map<string, Array<{ id: string }>>();
  for (const s of slots) {
    const key = JSON.stringify([s.phase, s.fn]);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push({ id: s.id });
  }

  const cursor = new Map<string, number>();
  const byNode = new Map<string, StepRun>();
  const unplaced: StepView[] = [];
  /** The last card, in declared order, that any step settled on. */
  let lastSettledIndex = -1;
  /** The card chant says is running now. */
  let running: { id: string; since?: string } | null = null;
  const indexOf = new Map(placed.map((p, i) => [p.id, i]));

  for (const step of steps) {
    const key = JSON.stringify([step.phase, step.step]);
    const list = byKey.get(key);
    const i = cursor.get(key) ?? 0;
    const slot = list?.[i];
    if (!slot) {
      unplaced.push(step);
      continue;
    }
    cursor.set(key, i + 1);
    if (step.state === "running") {
      running = { id: slot.id, ...(step.startedAt ? { since: step.startedAt } : {}) };
      continue;
    }
    byNode.set(slot.id, mergeRun(byNode.get(slot.id), step));
    if (step.state !== "skipped" && step.state !== "cached") {
      lastSettledIndex = Math.max(lastSettledIndex, indexOf.get(slot.id) ?? -1);
    }
  }

  // Where the playhead sits. A named pending gate wins outright: it is the one
  // position chant CONFIRMS a human owes. Then the step chant says is running.
  // Otherwise (the older stream, which says nothing until a step settles) it is
  // the next declared step on the main track, labelled reached-not-settled so
  // nobody reads it as done.
  if (gate) {
    const gateNode = placed.find((p) => p.step.kind === "gate" && p.step.signalName === gate.signalName);
    if (gateNode) {
      return { byNode, at: gateNode.id, atReason: `waiting for ${gate.signalName} since ${gate.since}`, unplaced };
    }
  }
  if (running) {
    return { byNode, at: running.id, atReason: running.since ? `running since ${running.since}` : "running", unplaced };
  }
  // Run events say which step runs; with none running there is no position to
  // guess, so only the older stream (`guessNext`) gets the reached marker.
  if (opts.guessNext === false) return { byNode, at: null, atReason: null, unplaced };
  const next = placed.find((p, i) => i > lastSettledIndex && p.when === "phases" && !byNode.has(p.id));
  return {
    byNode,
    at: lastSettledIndex >= 0 && next ? next.id : null,
    atReason: lastSettledIndex >= 0 && next ? "reached, not settled yet" : null,
    unplaced,
  };
}

// ── Painting ──────────────────────────────────────────────────────────────────

/**
 * How a settled step paints, in the drift palette every other behold view uses
 * (src/overlay.ts documents the same enum): `good` = it did what it said (or a
 * cache hit stood in for it), `warn` = it failed or holds the run for a
 * person, `neutral` = it never ran. The playhead position is `accent`, the
 * same "in progress, nothing observed yet" tone the entity overlay gives a
 * declared-but-unobserved node.
 */
const TONE: Record<StepRun["status"], "good" | "warn" | "neutral"> = {
  ok: "good",
  cached: "good",
  failed: "warn",
  gated: "warn",
  waiting: "warn",
  skipped: "neutral",
};

/** One card's run line: `ok · 1.0s`, `skipped (receipt)`, `gated`. */
export function runLabel(run: StepRun): string {
  if (run.status === "skipped") return `skipped${run.skip ? ` (${run.skip})` : ""}`;
  if (run.status === "gated" || run.status === "waiting" || run.status === "cached") return run.status;
  return `${run.status} · ${tookLabel(run.durationMs)}`;
}

function tookLabel(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Paint one Op's run over the lens's graph.
 *
 * Additive by construction: nodes with nothing to say come back byte-identical,
 * and an empty join returns the input IR itself. Everything a run knows lands
 * in attrs (`run`, `ran`, `skip`, `error`, `message`, `approvedBy`,
 * `_playhead`), so the inspect pane shows it without a second data path, and
 * `_status` moves so the picture does.
 */
export function paintPlayhead(ir: GraphIR, join: RunJoin, gate: GateState | null): GraphIR {
  if (!join.byNode.size && !join.at) return ir;
  const nodes: IRNode[] = ir.nodes.map((node) => {
    const run = join.byNode.get(node.id);
    const here = join.at === node.id;
    if (!run && !here) return node;
    const isGate = node.attrs?._step === "gate";
    const attrs: Record<string, unknown> = { ...node.attrs };
    if (run) {
      attrs._status = TONE[run.status];
      attrs.run = runLabel(run);
      attrs.ran = tookLabel(run.durationMs);
      if (run.skip) attrs.skip = run.skip;
      if (run.error) attrs.error = run.error;
      if (run.message) attrs.message = run.message;
      if (run.approvedBy) attrs.approvedBy = run.approvedBy;
      if (run.records > 1) attrs.runRecords = run.records;
    }
    if (here) {
      attrs._playhead = true;
      // A pending gate keeps `warn`: it is a human decision, not a step in
      // flight, and says who it is waiting on and since when.
      attrs._status = isGate && gate ? "warn" : "accent";
      attrs.run = isGate && gate ? `waiting for approval since ${gate.since}` : (join.atReason ?? "here");
      if (isGate && gate?.description) attrs.gateDescription = gate.description;
    }
    return { ...node, attrs };
  });
  return { ...ir, nodes };
}

// ── The pending gate card (#234) ──────────────────────────────────────────────

/**
 * The pending-approval card #234 describes: gate name, description, since-when,
 * and the approve action — which is a POST to the EXISTING op-signal route, the
 * same delegated write today's gate button uses. behold never signals on its
 * own initiative; this card is a button a human presses.
 *
 * `node` is the gate's card in the ops lens, so clicking the card selects the
 * step in the graph rather than being a floating panel about nothing.
 */
export interface PendingGateCard {
  op: string;
  signalName: string;
  description?: string;
  since: string;
  /** The ops-lens node id of the gate step, when the declared track has one. */
  node?: string;
  /** The step this gate holds back, from the lens's own `guards` attr. */
  guards?: string;
  /** The delegated write the approve button performs. Stated, not implied. */
  approve: { method: "POST"; path: string };
}

export function pendingGateCard(op: string, gate: GateState, ir: GraphIR): PendingGateCard {
  const node = ir.nodes.find((n) => n.attrs?._step === "gate" && n.attrs?.gate === gate.signalName && n.attrs?.op === op);
  return {
    op,
    signalName: gate.signalName,
    ...(gate.description ? { description: gate.description } : {}),
    since: gate.since,
    ...(node ? { node: node.id } : {}),
    ...(node && typeof node.attrs?.guards === "string" ? { guards: node.attrs.guards } : {}),
    approve: {
      method: "POST",
      path: `/api/ops/${encodeURIComponent(op)}/signal/${encodeURIComponent(gate.signalName)}`,
    },
  };
}

// ── The statusbar sentence ────────────────────────────────────────────────────

/** How many steps settled, a skipped or cached one included. */
export function settledCount(steps: StepView[]): number {
  return steps.filter((s) => s.state !== "running").length;
}

/**
 * What the playhead adds to the ops lens's own note, appended to
 * {@link import("./ops-lens.ts").opsNote}, never replacing it, because the
 * declared track's honesty (no estate cross-links, read-only) still holds.
 *
 * Every branch here says what behold KNOWS. There is no wording for "probably
 * finished".
 */
export function playheadNote(state: RunState, join: RunJoin | null): string {
  if (!state.op) {
    return "No run state: nothing has been run from this behold session, so every step paints as declared.";
  }
  const settled = join ? join.byNode.size : settledCount(state.steps);
  const bits: string[] = [];
  // `idle` with an Op named means the status read adopted a run behold did NOT
  // start and has no events for (src/op-runner.ts's `noteGate`): say exactly
  // that rather than counting zero steps as if the stream had been watched.
  const from = state.source === "events" ? "chant's run events" : "chant's older progress stream (degraded)";
  const head =
    state.status === "idle"
      ? `Run state for ${state.op}: no per-step events; this behold session didn't start the run, so only the status read answers`
      : `Run: ${state.op} (${state.runtime ?? "local"}, from ${from}${state.following ? ", followed" : ""}): ${settled} step${settled === 1 ? "" : "s"} settled`;
  if (state.status === "running") {
    bits.push(state.source === "events" ? "still running; a running step paints as running and only settled steps paint as settled" : "still running; only settled steps are painted");
  }
  if (state.status === "ok") bits.push("the run settled ok");
  if (state.status === "failed") bits.push("a step failed");
  if (state.status === "gated") bits.push("the run stopped at a gate; nothing after it ran");
  if (state.status === "waiting") bits.push("the run stopped at a decision point nobody has answered; nothing after it ran");
  if (state.status === "lost") bits.push(`stream lost: ${state.lost ?? "the stream ended without a verdict"}`);
  if (state.gate) {
    bits.push(`waiting on gate ${state.gate.signalName} since ${state.gate.since}; approve records the resolution (chant run approve) and the Op runs again; behold never approves on its own`);
  } else if (state.point) {
    bits.push(`waiting on decision point ${state.point.id} since ${state.point.since}; it is answered with chant workspace points answer`);
  } else if (state.gateNote) {
    bits.push(`gate state unavailable: ${state.gateNote}`);
  }
  if (state.sourceNote) bits.push(state.sourceNote);
  if (join?.unplaced.length) {
    bits.push(
      `${join.unplaced.length} step${join.unplaced.length === 1 ? "" : "s"} matched no declared step and ${join.unplaced.length === 1 ? "is" : "are"} not painted`,
    );
  }
  if (!bits.length) return `${head}.`;
  return `${head}; ${bits.join("; ")}.`;
}
