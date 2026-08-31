/**
 * The run playhead (#284 item 2) — live run state painted over the declared op
 * track the ops lens (#284 item 1, src/ops-lens.ts) already draws, plus a
 * pending gate as a first-class card (#234's shape).
 *
 * Two chant surfaces feed it, both landed in chant 0.51 (chant#1676 /
 * chant#2004):
 *
 *  1. **`StepRecord`** — one per SETTLED step. `chant run <name> --temporal
 *     --progress-json` streams them as NDJSON, one line per record, while the
 *     Op runs; `chant run <name> --json` (the local executor) prints the whole
 *     `OpRunResult` envelope at the end. Same record shape either way, which is
 *     the point of chant#1676 — a consumer renders one way regardless of
 *     executor — so {@link parseRunProgressLine} accepts both framings and
 *     everything downstream sees a flat `StepRecord[]`.
 *  2. **`gateState`** — a generated workflow query answering "which gate, if
 *     any, is this workflow waiting on, and since when". Surfaced on `chant run
 *     status <name> --temporal`, which behold shells beside the `chant run
 *     signal` it already shells to approve one.
 *
 * ## The honesty rules this module exists to keep
 *
 *  - **Run state is strictly additive paint.** {@link paintPlayhead} takes the
 *    lens's own `GraphIR` and returns a new one; with no run data it returns the
 *    input untouched, so the declared track renders exactly as it did before.
 *  - **Only settled steps are painted as settled.** A `StepRecord` exists only
 *    for a step that completed or failed. The step AFTER the last settled one is
 *    marked as the playhead position and says "reached, not settled" — it is
 *    never coloured as done.
 *  - **A dead stream is never completion.** {@link runEnded} promotes a run to
 *    `ok` only on a clean exit, to `failed` only when a record actually reports
 *    a failure, and otherwise to `lost` — the playhead freezes at last-settled
 *    and says the stream was lost.
 *  - **Absence of a gate signal is never progress.** A gate paints as pending
 *    only when `gateState` NAMED it. When the query can't be reached at all (no
 *    Temporal, no run, an older chant) {@link readRunStatus} returns a refusal
 *    the view states plainly instead of a silently ungated track.
 *  - **behold never signals on its own initiative.** Nothing here writes. The
 *    pending card's approve action is the caller's existing
 *    `POST /api/ops/:name/signal/:gate` — the same delegated write the current
 *    gate button already uses.
 */
import type { GraphIR, IRNode } from "@intentius/chant";
import { opPlacedSteps, type OpIr, type PlacedStep } from "./ops-lens.ts";

// ── The chant shapes, mirrored ────────────────────────────────────────────────
//
// `StepRecord` and the `gateState` result are chant's own types (its core's
// `op/local-executor.ts` and `cli/handlers/op-progress.ts`) and neither is
// re-exported from `@intentius/chant`'s public index — only the deep
// `./cli/handlers/op-progress` path carries the gate one. Mirrored here
// field-for-field on src/apply.ts's precedent for `RunProgressEvent`: don't
// reach past a package's declared public export surface for an internal type.

/**
 * One settled step of an Op run — chant's `StepRecord`
 * (`packages/core/src/op/local-executor.ts`), verified against chant 0.51's
 * definition.
 *
 * `args` is present on a local-executor record and absent on one reconstructed
 * from Temporal workflow history: chant doesn't decode an activity's scheduled
 * input there, and omits the field rather than filling it with a guess.
 */
export interface StepRecord {
  phase: string;
  fn: string;
  args?: Record<string, unknown>;
  status: "ok" | "fail" | "skipped";
  durationMs: number;
  outcome?: { name: string; value: unknown };
  error?: string;
}

/** The whole-run envelope `chant run <name> --json` prints on the local path. */
export interface OpRunResult {
  op: string;
  records: StepRecord[];
  totalMs: number;
  ok: boolean;
}

/** chant's `GateQueryResult` — the `gateState` query's answer when a gate is
 * pending. `since` is an ISO instant the workflow stamped when it began waiting. */
export interface GateState {
  signalName: string;
  description?: string;
  since: string;
}

/** The two synthesized step names an effect step's read-compare-run-write
 * compiles to (chant's temporal serializer emits `receiptRead` before and
 * `receiptWrite` after the inner steps). Duplicated here for the same reason
 * chant's own op-progress.ts duplicates them: this module stays lexicon-free.
 * They arrive as records but have no card of their own — the effect card owns
 * them ({@link slotsFor}). */
const RECEIPT_READ_FN = "receiptRead";
const RECEIPT_WRITE_FN = "receiptWrite";

const STEP_STATUSES = new Set<StepRecord["status"]>(["ok", "fail", "skipped"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function asStepRecord(value: unknown): StepRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.phase !== "string" || typeof value.fn !== "string") return null;
  if (typeof value.status !== "string" || !STEP_STATUSES.has(value.status as StepRecord["status"])) return null;
  if (typeof value.durationMs !== "number") return null;
  return value as unknown as StepRecord;
}

/**
 * Parse one streamed line of a `chant run` as run progress.
 *
 * Returns the records it carried, or null for anything else — a non-JSON line
 * (an activity's own stdout, a warning, chant's human summary), or JSON that
 * isn't a StepRecord. Never throws: src/op-runner.ts feeds EVERY streamed line
 * here to decide whether it is structured progress or a raw log line, exactly
 * as it already does with `parseProgressLine` for the components driver.
 *
 * Both framings chant#1676 defines are accepted, because they carry the same
 * record and a reader shouldn't care which executor produced it:
 *  - one NDJSON `StepRecord` per line (`--temporal --progress-json`)
 *  - one whole `OpRunResult` (`--json`, the local executor's end-of-run print)
 */
export function parseRunProgressLine(line: string): StepRecord[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const one = asStepRecord(parsed);
  if (one) return [one];
  if (isRecord(parsed) && typeof parsed.op === "string" && Array.isArray(parsed.records)) {
    const records = parsed.records.map(asStepRecord).filter((r): r is StepRecord => r !== null);
    // An envelope whose `records` held nothing recognizable is not progress —
    // answering `[]` would make src/op-runner.ts swallow the line's raw-log
    // fallback for no gain.
    return records.length ? records : null;
  }
  return null;
}

/** A settled record as one now-line, so switching an Op run onto the structured
 * flags doesn't cost the operator chant's own per-step narration. */
export function recordLine(record: StepRecord): string {
  const mark = record.status === "ok" ? "✓" : record.status === "fail" ? "✗" : "•";
  const took =
    record.status === "skipped"
      ? "skipped"
      : record.durationMs < 1000
        ? `${record.durationMs}ms`
        : `${(record.durationMs / 1000).toFixed(1)}s`;
  return `${mark} ${record.phase} · ${record.fn} — ${took}${record.error ? ` — ${record.error}` : ""}`;
}

// ── `chant run status` — the gateState read ───────────────────────────────────

/** A refusal from the status read: why behold has no run state to show, and
 * what to do about it. #193's structured-error standard, the shape the SPA's
 * precondition card renders. */
export interface RunStatusRefusal {
  error: string;
  code: "no-temporal" | "no-run" | "run-status";
  remedy: string;
}

/** What `chant run status <name> --temporal` said. `gate: null` means the query
 * answered "nothing pending" (or the Op registers no `gateState` handler at
 * all, which chant reports the same way); a gate object means a human is being
 * waited on right now. */
export interface RunStatusRead {
  op: string;
  workflowId?: string;
  runId?: string;
  /** Temporal's own execution status word — RUNNING / COMPLETED / FAILED / … */
  status?: string;
  startedAt?: string;
  closedAt?: string;
  activities?: { completed: number; scheduled: number };
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
 * The `Gate` line, back into the `gateState` result it was printed from.
 *
 * chant prints it as, verbatim from `cli/handlers/run.ts`:
 *
 *     `  Gate        : ${gate.signalName}${gate.description ? ` — ${gate.description}` : ""} (waiting since ${gate.since})`
 *
 * so the signal name runs to the first ` — ` or ` (waiting since`, whichever
 * comes first, and a description is optional. A line that doesn't match this
 * shape yields nothing rather than a half-read gate: a card that names the
 * wrong signal would send the wrong approval.
 */
export function parseGateLine(line: string): GateState | null {
  const m = /^(.*?)(?: — (.*?))? \(waiting since (.+)\)$/.exec(line.trim());
  if (!m) return null;
  const signalName = m[1].trim();
  if (!signalName) return null;
  return { signalName, ...(m[2] ? { description: m[2].trim() } : {}), since: m[3].trim() };
}

/**
 * Read one `chant run status <name> --temporal` invocation.
 *
 * A non-zero exit is a refusal, never an empty run: the two chant authors
 * itself are recognised so the view can say WHY, and everything else is
 * surfaced verbatim under `run-status` rather than being guessed at. That
 * matters more here than anywhere else in behold — a status read that quietly
 * degraded to "no gate pending" would paint an un-signalled gate as progress.
 */
export function readRunStatus(op: string, run: { code: number; stdout: string; stderr: string }): RunStatusResult {
  if (run.code !== 0) {
    const message = strip(run.stderr).trim() || strip(run.stdout).trim() || `chant run status exited ${run.code}`;
    // chant's own refusal when the project isn't on the durable path
    // (`requireTemporalMode`), and when the Temporal client isn't installed.
    // Both mean the same thing to a reader: there is no durable run to report.
    if (/not available in local mode|@temporalio\/client is not installed/.test(message)) {
      return {
        ok: false,
        refusal: {
          error: `No Temporal run state for "${op}" — ${message.split("\n")[0].replace(/^error:\s*/, "")}`,
          code: "no-temporal",
          remedy:
            "Gate state and per-step run records come from a durable run. Configure a Temporal profile in " +
            "chant.config.ts (and `npm install @temporalio/client`), then run the Op with --temporal.",
        },
      };
    }
    if (/not found|NotFound/.test(message)) {
      return {
        ok: false,
        refusal: {
          error: `No run of "${op}" to report — ${message.split("\n")[0].replace(/^error:\s*/, "")}`,
          code: "no-run",
          remedy: "Start the Op (Run) and the playhead fills in as each step settles.",
        },
      };
    }
    return {
      ok: false,
      refusal: {
        error: `chant run status ${op} failed: ${message.split("\n")[0].replace(/^error:\s*/, "")}`,
        code: "run-status",
        remedy: "Run `chant run status " + op + " --temporal` in the project to see the whole error.",
      },
    };
  }

  const f = statusFields(run.stdout);
  const activities = /^(\d+)\/(\d+)/.exec(f.get("Activities") ?? "");
  const gateLine = f.get("Gate");
  return {
    ok: true,
    read: {
      op,
      ...(f.get("Workflow ID") ? { workflowId: f.get("Workflow ID") } : {}),
      ...(f.get("Run ID") ? { runId: f.get("Run ID") } : {}),
      ...(f.get("Status") ? { status: f.get("Status") } : {}),
      ...(f.get("Started") ? { startedAt: f.get("Started") } : {}),
      ...(f.get("Closed") ? { closedAt: f.get("Closed") } : {}),
      ...(activities ? { activities: { completed: Number(activities[1]), scheduled: Number(activities[2]) } } : {}),
      // No Gate line means chant printed none, which it does both when the
      // query says "nothing pending" and when the Op registers no handler.
      // Either way: no gate is waiting on a human right now.
      gate: gateLine ? parseGateLine(gateLine) : null,
    },
  };
}

// ── The run state behold holds and broadcasts ─────────────────────────────────

/**
 * How a run ended, from behold's side of the stream.
 *
 * `lost` is the honest fourth value: the watched process ended without either a
 * clean exit or a failed step to point at, so behold knows the stream stopped
 * and knows nothing about the run. It is never `ok`.
 */
export type RunStatus = "idle" | "running" | "ok" | "failed" | "lost";

export interface RunState {
  /** The Op being watched, or null when nothing has run this session. */
  op: string | null;
  /** Which executor's stream this is — `temporal` records arrive live, one per
   * settled step; `local` records all arrive at once when the run ends. */
  mode: "temporal" | "local" | null;
  status: RunStatus;
  /** Settled steps, in the order the stream delivered them. */
  records: StepRecord[];
  /** The last `gateState` answer: a gate object (a human is being waited on),
   * or null (nothing pending / never asked — `gateNote` says which). */
  gate: GateState | null;
  /** Why there is no gate answer, when there isn't one to be had. */
  gateNote: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Set with `status: "lost"` — what behold knows, and stops claiming. */
  lost: string | null;
}

export const initialRunState: RunState = {
  op: null,
  mode: null,
  status: "idle",
  records: [],
  gate: null,
  gateNote: null,
  startedAt: null,
  endedAt: null,
  lost: null,
};

/** A run behold just triggered. Clears the previous run's terminal state so a
 * reload between trigger and first record can't show the last run's colours. */
export function runStarted(op: string, mode: "temporal" | "local", at: string): RunState {
  return { ...initialRunState, op, mode, status: "running", startedAt: at };
}

/** Fold one settled step in. Records are appended in arrival order; the join to
 * cards ({@link joinRun}) is positional, so a stream that repeats a record —
 * whatever emitted it — can't shift the whole track. */
export function runRecord(state: RunState, record: StepRecord): RunState {
  return { ...state, records: [...state.records, record] };
}

/** Fold the `gateState` read in — an answer, or the refusal's reason. */
export function runGate(state: RunState, result: RunStatusResult): RunState {
  return result.ok
    ? { ...state, gate: result.read.gate, gateNote: null }
    : { ...state, gate: null, gateNote: result.refusal.error };
}

/**
 * The watched process ended.
 *
 * A clean exit is the only thing that reads as completion. A non-zero exit with
 * a failed step in the stream reads as a failed run — the stream said so. A
 * non-zero exit with NOTHING to point at is `lost`: chant may have failed, the
 * Op may have failed, the process may have been killed, and behold cannot tell
 * which — so the playhead stays exactly where the last settled record put it
 * and says the stream was lost rather than inferring an ending.
 */
export function runEnded(state: RunState, exitCode: number, at: string): RunState {
  if (state.status !== "running") return state;
  if (exitCode === 0) return { ...state, status: "ok", endedAt: at };
  if (state.records.some((r) => r.status === "fail")) return { ...state, status: "failed", endedAt: at };
  return {
    ...state,
    status: "lost",
    endedAt: at,
    lost:
      `the progress stream ended (exit ${exitCode}) after ${state.records.length} settled ` +
      `step${state.records.length === 1 ? "" : "s"} without a failed step — behold does not know whether the Op ` +
      `failed or the stream broke, so the playhead stays at the last settled step.`,
  };
}

/** The stream died outright (a spawn error, a killed process). Same rule as a
 * verdictless exit, with the caller's reason. */
export function runLost(state: RunState, reason: string, at: string): RunState {
  return state.status === "running" ? { ...state, status: "lost", endedAt: at, lost: reason } : state;
}

// ── Joining records to the cards the ops lens drew ────────────────────────────

/** What one card learned from the run. */
export interface StepRun {
  status: StepRecord["status"];
  durationMs: number;
  error?: string;
  outcome?: string;
  /** How many records landed on this card (an effect card owns several). */
  records: number;
}

export interface RunJoin {
  /** node id → what settled there. */
  byNode: Map<string, StepRun>;
  /** The node the playhead sits on: the first main-track step after the last
   * settled one, or the gate `gateState` named. Null when nothing has settled
   * and no gate is pending. */
  at: string | null;
  /** Why {@link at} is where it is — stated on the card, never inferred by the
   * reader. */
  atReason: string | null;
  /** Records that matched no card. A stream that outruns the declared track is
   * a fact worth showing, not one to silently drop. */
  unplaced: StepRecord[];
}

/** The (phase, fn) slots one Op's cards can absorb records into, in declared
 * order. A gate schedules no activity and has no slot; an effect card absorbs
 * the synthesized receipt reads/writes and every nested activity, because chant
 * emits a record per inner step while the lens draws the effect whole. */
function slotsFor(placed: PlacedStep[]): Array<{ id: string; phase: string; fn: string }> {
  const out: Array<{ id: string; phase: string; fn: string }> = [];
  for (const p of placed) {
    if (p.step.kind === "activity") {
      out.push({ id: p.id, phase: p.phase, fn: p.step.fn });
    } else if (p.step.kind === "effect") {
      out.push({ id: p.id, phase: p.phase, fn: RECEIPT_READ_FN });
      for (const nested of p.step.steps ?? []) {
        if (nested.kind === "activity") out.push({ id: p.id, phase: p.phase, fn: nested.fn });
      }
      out.push({ id: p.id, phase: p.phase, fn: RECEIPT_WRITE_FN });
    }
  }
  return out;
}

/** Merge a record onto a card that may already hold one (an effect's several).
 * A failure outranks an ok, and an ok outranks a skip: the card must not read
 * green because the LAST of its inner steps happened to succeed. */
function mergeRun(prev: StepRun | undefined, record: StepRecord): StepRun {
  const rank = { fail: 3, ok: 2, skipped: 1 } as const;
  const keepPrev = prev && rank[prev.status] >= rank[record.status];
  return {
    status: keepPrev ? prev.status : record.status,
    durationMs: (prev?.durationMs ?? 0) + record.durationMs,
    ...(keepPrev && prev.error ? { error: prev.error } : record.error ? { error: record.error } : {}),
    ...(keepPrev && prev.outcome
      ? { outcome: prev.outcome }
      : record.outcome
        ? { outcome: `${record.outcome.name}=${String(record.outcome.value)}` }
        : {}),
    records: (prev?.records ?? 0) + 1,
  };
}

/**
 * Join a run's records to the ops lens's own node ids.
 *
 * Positional, per (phase, fn), in declared order — the same rule chant uses to
 * build the records in the first place (its per-fn FIFO queue over scheduled
 * events), so the two agree by construction. A record for a (phase, fn) whose
 * slots are already used lands in `unplaced` rather than shifting the track:
 * defense-in-depth against any emitter repeating a record, not a workaround
 * for a live bug. chant 0.52.1's `--progress-json` did repeat one this way —
 * its poll-loop watermark counted emitted records, and the terminal pass
 * inserting a `skipped` record mid-list shifted what the count pointed at
 * (chant#2032) — fixed in chant 0.53.1 (chant PR #2041, declared-step
 * identity, not a count). The join still refuses to let a
 * repeat shift the track, because a blind append would paint every later
 * step one position early and a stream is an external input whatever
 * produces it; src/run-playhead.test.ts keeps the pre-fix chant#2032 stream
 * as the fixture that exercises this.
 */
export function joinRun(op: OpIr, records: StepRecord[], gate: GateState | null): RunJoin {
  const placed = opPlacedSteps(op);
  const slots = slotsFor(placed);
  const byKey = new Map<string, Array<{ id: string }>>();
  for (const s of slots) {
    const key = `${s.phase} ${s.fn}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push({ id: s.id });
  }

  const cursor = new Map<string, number>();
  const byNode = new Map<string, StepRun>();
  const unplaced: StepRecord[] = [];
  /** The last card, in declared order, that any record settled on. */
  let lastSettledIndex = -1;
  const indexOf = new Map(placed.map((p, i) => [p.id, i]));

  for (const record of records) {
    const key = `${record.phase} ${record.fn}`;
    const list = byKey.get(key);
    const i = cursor.get(key) ?? 0;
    const slot = list?.[i];
    if (!slot) {
      unplaced.push(record);
      continue;
    }
    cursor.set(key, i + 1);
    byNode.set(slot.id, mergeRun(byNode.get(slot.id), record));
    if (record.status !== "skipped") {
      lastSettledIndex = Math.max(lastSettledIndex, indexOf.get(slot.id) ?? -1);
    }
  }

  // Where the playhead sits. A named pending gate wins outright — it is the one
  // position chant actually CONFIRMS. Otherwise it is the next declared step on
  // the main track, labelled as reached-not-settled so nobody reads it as done.
  if (gate) {
    const gateNode = placed.find((p) => p.step.kind === "gate" && p.step.signalName === gate.signalName);
    if (gateNode) {
      return {
        byNode,
        at: gateNode.id,
        atReason: `waiting for ${gate.signalName} since ${gate.since}`,
        unplaced,
      };
    }
  }
  const next = placed.find((p, i) => i > lastSettledIndex && p.when === "phases");
  return {
    byNode,
    at: lastSettledIndex >= 0 && next ? next.id : null,
    atReason: lastSettledIndex >= 0 && next ? "reached — not settled yet" : null,
    unplaced,
  };
}

// ── Painting ──────────────────────────────────────────────────────────────────

/**
 * How a settled step paints, in the drift palette every other behold view uses
 * (src/overlay.ts documents the same enum): `good` = it did what it said,
 * `warn` = it failed, `neutral` = it never ran. The playhead position is
 * `accent` — the same "in progress, nothing observed yet" tone the entity
 * overlay gives a declared-but-unobserved node.
 */
const TONE: Record<StepRecord["status"], "good" | "warn" | "neutral"> = {
  ok: "good",
  fail: "warn",
  skipped: "neutral",
};

const RAN = { ok: "ok", fail: "failed", skipped: "skipped" } as const;

function tookLabel(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Paint one Op's run over the lens's graph.
 *
 * Additive by construction: nodes with nothing to say come back byte-identical,
 * and an empty join returns the input IR itself. Everything a run knows lands
 * in attrs (`run`, `ran`, `error`, `outcome`, `_playhead`), so the inspect pane
 * shows it without a second data path, and `_status` moves so the picture does.
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
      attrs.run = run.status === "skipped" ? "skipped" : `${RAN[run.status]} · ${tookLabel(run.durationMs)}`;
      attrs.ran = tookLabel(run.durationMs);
      if (run.error) attrs.error = run.error;
      if (run.outcome) attrs.outcome = run.outcome;
      if (run.records > 1) attrs.runRecords = run.records;
    }
    if (here) {
      attrs._playhead = true;
      // A pending gate keeps `warn` — it is a human decision, not a step in
      // flight — and says who it is waiting on and since when.
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

/**
 * What the playhead adds to the ops lens's own note — appended to
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
  const settled = join ? join.byNode.size : state.records.length;
  const bits: string[] = [];
  // `idle` with an Op named means the gate query adopted a run behold did NOT
  // start (src/op-runner.ts's `noteGate`): there is a run, and no per-step
  // record of it — say exactly that rather than counting zero steps as if the
  // stream had been watched from the beginning.
  const head =
    state.status === "idle"
      ? `Run state for ${state.op}: no per-step records — this behold session didn't start the run, so only the gate query answers`
      : `Run: ${state.op} (${state.mode === "temporal" ? "durable" : "local executor"}) — ${settled} step${settled === 1 ? "" : "s"} settled`;
  if (state.status === "running") {
    bits.push(
      state.mode === "local"
        ? "still running; the local executor reports every step at once when it ends, so the track fills in on completion"
        : "still running; only settled steps are painted",
    );
  }
  if (state.status === "ok") bits.push("the run exited cleanly");
  if (state.status === "failed") bits.push("a step failed");
  if (state.status === "lost") bits.push(`stream lost — ${state.lost ?? "the progress stream ended without a verdict"}`);
  if (state.gate) {
    bits.push(`waiting on gate ${state.gate.signalName} since ${state.gate.since} — approve is a delegated signal, behold never signals on its own`);
  } else if (state.gateNote) {
    bits.push(`gate state unavailable — ${state.gateNote}`);
  }
  if (join?.unplaced.length) {
    bits.push(
      `${join.unplaced.length} record${join.unplaced.length === 1 ? "" : "s"} matched no declared step and ${join.unplaced.length === 1 ? "is" : "are"} not painted`,
    );
  }
  if (!bits.length) return `${head}.`;
  const rest = bits.join("; ");
  return `${head} — ${rest}.`;
}
