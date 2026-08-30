/**
 * OpRunner — the single place a delegated Op (or write) is triggered. The HTTP
 * routes (Sync/Adopt/rollback/apply) and the auto-sync loop (#29) all go
 * through it, so they share one "something is already running" guard and one
 * post-run capture path. behold never applies directly; it runs `chant run
 * <op>` (or, since M3, `chant run <target> --components --progress-json`) on
 * the executor and streams the phases.
 */
import { runChantStream, runCommandStream, applyArgs } from "./chant.ts";
import type { CiPipeline } from "./chant.ts";
import { extractPrUrl } from "./adopt.ts";
import { parseProgressLine, applyProgressReducer, initialApplyProgress, type ApplyProgressState } from "./apply.ts";
import { pipelineProgress, foldPipelineLine, finishPipelineProgress, type PipelineProgressState } from "./ci-run.ts";
import {
  parseRunProgressLine,
  recordLine,
  initialRunState,
  runStarted,
  runRecord,
  runEnded,
  runGate,
  type RunState,
  type RunStatusResult,
} from "./run-playhead.ts";
import {
  initialOperatorState,
  operatorRead,
  type DeclaredConvergeOp,
  type OperatorState,
  type OperatorStatusResult,
} from "./operator.ts";
import type { Broadcaster } from "./events.ts";

export interface OpRunnerDeps {
  projectDir: string;
  broadcaster: Broadcaster;
  /** After an op finishes: capture a lanes frame for the op's env (#25). */
  onDone: (opEnv: string | undefined) => Promise<unknown> | void;
}

export class OpRunner {
  private current: string | null = null;
  /** The last known apply progress (M3): kept around after the run ends (and
   * across dial re-renders) so a client that opens `/api/ops` mid-run — or
   * after a page reload — can hydrate the structured view instead of starting
   * blank. Reset to a fresh idle state at the start of each new `apply()`
   * call (the reducer would clear it on `run-start` anyway; this seeds it
   * before the first event lands so a reload between trigger and first event
   * doesn't show the PREVIOUS run's stale terminal state). */
  private lastApplyProgress: ApplyProgressState = initialApplyProgress;
  /** The run playhead (#284 item 2): the settled StepRecords of the last Op
   * `trigger()` started, plus the last `gateState` answer. Kept after the run
   * ends and across renders for the same reason `lastApplyProgress` is — a
   * client opening the ops lens mid-run (or after a reload) hydrates the
   * playhead instead of starting blank. In-process only: a run started
   * elsewhere is invisible here, and `chant run status` (src/server.ts's
   * `/api/ops/:name/status`) is what answers for one. */
  private lastRunState: RunState = initialRunState;
  /** The operator strip (#234 join 3): the last `chant operator status --json`
   * read, plus the ConvergeOps the built project declares. Held here for the
   * reason `lastRunState` is — it is a durable status read, not a run, and a
   * client opening the ops lens hydrates from it instead of starting blank. */
  private lastOperatorState: OperatorState = initialOperatorState;

  constructor(private deps: OpRunnerDeps) {}

  /** #195: re-point delegated writes at a switched project. The runner reads
   * `deps.projectDir` at trigger time, so this is the whole retarget. */
  retarget(projectDir: string): void {
    this.deps.projectDir = projectDir;
  }

  /** Name of the running op, or null. */
  get running(): string | null {
    return this.current;
  }

  /** The last known apply progress model (M3) — `initialApplyProgress` if no
   * apply has run yet this session. */
  get applyProgress(): ApplyProgressState {
    return this.lastApplyProgress;
  }

  /** The run playhead's model (#284 item 2) — `initialRunState` until an Op has
   * been triggered this session. */
  get runState(): RunState {
    return this.lastRunState;
  }

  /**
   * Fold a `chant run status <name>` read (src/run-playhead.ts's
   * `readRunStatus`) into the playhead, and broadcast it.
   *
   * The gate is a workflow QUERY, not part of the record stream, so it can only
   * arrive this way. A read for an Op other than the one being watched is
   * returned to the caller but not folded — one playhead, one Op, and silently
   * re-pointing it at whatever was last polled would make the picture lie about
   * which run it shows. A read arriving before anything has run this session
   * adopts the Op: a gate pending on a run behold didn't start is exactly the
   * case the pending card exists for.
   */
  noteGate(op: string, result: RunStatusResult): RunState {
    if (this.lastRunState.op !== null && this.lastRunState.op !== op) return this.lastRunState;
    const base = this.lastRunState.op === op ? this.lastRunState : { ...initialRunState, op, mode: "temporal" as const };
    const next = runGate(base, result);
    // Broadcast only a CHANGED answer. A client asks when it opens the ops lens,
    // and the broadcast is what makes it re-pull that lens — so an unchanged
    // answer that still broadcast would have the two chasing each other.
    const changed = JSON.stringify(next) !== JSON.stringify(this.lastRunState);
    this.lastRunState = next;
    if (changed) this.emitRun();
    return this.lastRunState;
  }

  /**
   * Start `chant run <name>` unless one is already running (the Sync/Adopt/auto-
   * sync path). `cwd` is the Op's own project dir (#31 multi-estate); defaults to
   * the primary. Returns true if it started, false if busy.
   *
   * `temporal` — pass `--temporal` so the run gets the durable runtime. Callers
   * set it from the Op's declared gate: chant refuses a gated Op outright in
   * local mode ("gates and schedules need a durable runtime"), so without the
   * flag a gated Op could never run from behold at all.
   *
   * Either way the run is asked for structured per-step records (#284 item 2,
   * chant#1676) — `--progress-json` streams one NDJSON `StepRecord` per settled
   * step on the durable path; `--json` prints the whole `OpRunResult` at the end
   * on the local one. Same record shape, which is what lets one playhead render
   * both. `--json` replaces chant's own human per-step summary on the local
   * path, so each parsed record is re-emitted to the `op` now-line
   * ({@link recordLine}) and the operator loses no narration.
   */
  trigger(name: string, opEnv?: string, cwd?: string, temporal?: boolean): boolean {
    if (this.current) return false;
    const mode = temporal ? "temporal" : "local";
    const args = temporal ? ["run", name, "--temporal", "--progress-json"] : ["run", name, "--json"];
    this.lastRunState = runStarted(name, mode, new Date().toISOString());
    this.emitRun();
    return this.start(
      args,
      name,
      opEnv,
      cwd,
      (line) => {
        const records = parseRunProgressLine(line);
        if (!records) return false; // not progress — start() broadcasts it as a raw "op" line
        for (const record of records) {
          this.lastRunState = runRecord(this.lastRunState, record);
          this.deps.broadcaster.emit("op", recordLine(record));
        }
        this.emitRun();
        return true; // consumed — start() skips the raw "op" broadcast for this line
      },
      (code) => {
        this.lastRunState = runEnded(this.lastRunState, code, new Date().toISOString());
        this.emitRun();
      },
    );
  }

  private emitRun(): void {
    this.deps.broadcaster.emit("run", JSON.stringify(this.lastRunState));
  }

  /** The operator strip's model (#234 join 3) — `initialOperatorState` until the
   * ops lens has been opened once. */
  get operatorState(): OperatorState {
    return this.lastOperatorState;
  }

  /**
   * Record which ConvergeOps the built project declares, read from the emitted
   * op.json (src/operator.ts's `declaredConvergeOps`) — no subprocess, and the
   * thing that gates the strip. Broadcast on a change so a project rebuilt (or
   * switched, #195) under an open tab grows or loses its strip without a reload.
   */
  noteDeclaredConvergeOps(declared: DeclaredConvergeOp[]): OperatorState {
    return this.foldOperator({ ...this.lastOperatorState, declared });
  }

  /**
   * Fold a `chant operator status --json` read (src/operator.ts's
   * `readOperatorStatus`) into the strip, and broadcast it.
   *
   * Broadcast only a CHANGED answer, for `noteGate`'s reason: a client asks when
   * it opens the ops lens and re-pulls the lens on the broadcast, so an
   * unchanged answer that still broadcast would have the two chasing each other.
   */
  noteOperator(result: OperatorStatusResult, at = new Date().toISOString()): OperatorState {
    return this.foldOperator(operatorRead(this.lastOperatorState, result, at));
  }

  /** Compare-and-broadcast, ignoring `readAt` — the instant behold asked changes
   * on every poll and is not itself news; broadcasting on it would make the
   * interval a repaint loop. */
  private foldOperator(next: OperatorState): OperatorState {
    const same = JSON.stringify({ ...next, readAt: null }) === JSON.stringify({ ...this.lastOperatorState, readAt: null });
    this.lastOperatorState = next;
    if (!same) this.deps.broadcaster.emit("operator", JSON.stringify(next));
    return this.lastOperatorState;
  }

  /**
   * Run an arbitrary `chant` invocation through the same guard/stream/PR/capture
   * path — used by the delegated rollback command (#28), which is a lifecycle
   * command, not an Op. `label` is the display name (the running-guard key).
   */
  run(args: string[], label: string, opEnv?: string): boolean {
    return this.start(args, label, opEnv);
  }

  /**
   * Delegated write (M3, #54's apply step): `chant run <target> --components
   * --env <env> --progress-json`, guarded the same way as `trigger`/`run` —
   * only one write in flight at a time; returns false (the caller answers
   * 409) when something else is already running. `target` is a component
   * name or `"all"`.
   *
   * Each streamed line is checked with `parseProgressLine`: a recognized
   * `RunProgressEvent` folds into the structured progress model
   * (`applyProgressReducer`) and broadcasts as an `apply` SSE event — the
   * primary surface the SPA renders (web/app.js's live wave/phase view).
   * Everything else (chant's human-readable driver summary, a warning, a
   * release-record line) still reaches the `op` channel as a raw-log
   * fallback, exactly like any other Op — `start()`'s default behaviour,
   * skipped only for the lines this consumes.
   */
  apply(target: string, env: string): boolean {
    // Guard first, THEN reset: a rejected call (something else already running)
    // must leave whatever progress is currently on screen untouched — only a
    // write that actually STARTS gets to clear the previous run's terminal
    // state. `start()` re-checks `this.current` itself right after (same
    // synchronous tick, so it can't have changed) — this is just to sequence
    // the reset correctly, not a second real guard.
    if (this.current) return false;
    this.lastApplyProgress = initialApplyProgress;
    return this.start(applyArgs(target, env), `apply ${target}`, env, undefined, (line) => {
      const event = parseProgressLine(line);
      if (!event) return false; // not progress — start() broadcasts it as a raw "op" line
      this.lastApplyProgress = applyProgressReducer(this.lastApplyProgress, event);
      this.deps.broadcaster.emit("apply", JSON.stringify(this.lastApplyProgress));
      return true; // consumed — start() skips the raw "op" broadcast for this line
    });
  }

  /**
   * A local pipeline run as a first-class action (#163, the first slice of
   * #61): the same guarded/streamed shell-out as `bringUp`, but the run's
   * structure is KNOWN — `pipeline` is `/api/ci`'s parsed stages/jobs — so
   * progress renders on the dial exactly like an apply: stages as waves, jobs
   * correlated to their components (src/ci-run.ts). Every line still reaches
   * the `op` now-line (a pipeline log is worth reading raw); the classifier
   * only decides whether the structured model ALSO moved. The exit code, not
   * the log, settles the verdict.
   */
  pipeline(label: string, cmd: string, args: string[], cwd: string, pipeline: CiPipeline): boolean {
    if (this.current) return false;
    const { broadcaster } = this.deps;
    let state: PipelineProgressState = pipelineProgress(pipeline);
    this.lastApplyProgress = state;
    broadcaster.emit("op", `▶ ${cmd} ${args.join(" ")}`);
    broadcaster.emit("apply", JSON.stringify(state));
    const op = runCommandStream(cmd, args, cwd, (line) => {
      broadcaster.emit("op", line);
      const next = foldPipelineLine(state, line);
      if (next === state) return;
      state = next;
      this.lastApplyProgress = state;
      broadcaster.emit("apply", JSON.stringify(state));
    });
    this.current = label;
    void op.done.then((code) => {
      state = finishPipelineProgress(state, code);
      this.lastApplyProgress = state;
      broadcaster.emit("apply", JSON.stringify(state));
      broadcaster.emit("op", `■ ${label} exited ${code}`);
      this.current = null;
      Promise.resolve(this.deps.onDone(undefined))
        .then(() => broadcaster.emit("changed"))
        .catch((err) =>
          broadcaster.emit("op", `⚠ post-op capture: ${err instanceof Error ? err.message : String(err)}`));
    });
    return true;
  }

  /**
   * A tracked async action (#164): holds the same single-writer guard while a
   * code-driven loop (not a child process) does the work — the GitHub Actions
   * dispatch-and-follow, whose "stream" is polled structured JSON rather than
   * a process's stdout. The task reports lines for the now-line and
   * apply-shaped progress for the dial, and resolves to an exit code. The
   * guard releases the moment the task settles; a thrown task reads exit 1.
   */
  track(
    label: string,
    task: (io: { line: (s: string) => void; progress: (s: ApplyProgressState) => void }) => Promise<number>,
  ): boolean {
    if (this.current) return false;
    const { broadcaster } = this.deps;
    this.current = label;
    this.lastApplyProgress = initialApplyProgress;
    const io = {
      line: (s: string) => broadcaster.emit("op", s),
      progress: (s: ApplyProgressState) => {
        this.lastApplyProgress = s;
        broadcaster.emit("apply", JSON.stringify(s));
      },
    };
    void task(io)
      .catch((err) => {
        io.line(`✗ ${label}: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      })
      .then((code) => {
        broadcaster.emit("op", `■ ${label} exited ${code}`);
        this.current = null;
        Promise.resolve(this.deps.onDone(undefined))
          .then(() => broadcaster.emit("changed"))
          .catch((err) =>
            broadcaster.emit("op", `⚠ post-op capture: ${err instanceof Error ? err.message : String(err)}`));
      });
    return true;
  }

  /**
   * Substrate bring-up (M5, #54): run a project's local bring-up script (e.g.
   * `bash scripts/local/local-up.sh`, `test/gitlab-runtime-e2e.sh`) through the
   * SAME running-guard + stream + post-run capture as an Op — behold triggers,
   * the script does the work, its output streams to the `op` channel, and the
   * post-run `changed` re-checks the graph (and lets the readiness strip
   * re-detect). Returns false (→ 409) when something is already running. `cwd`
   * is the served project's dir.
   */
  bringUp(label: string, cmd: string, args: string[], cwd: string): boolean {
    if (this.current) return false;
    const { broadcaster } = this.deps;
    broadcaster.emit("op", `▶ ${cmd} ${args.join(" ")}`);
    const op = runCommandStream(cmd, args, cwd, (line) => broadcaster.emit("op", line));
    this.current = label;
    void op.done.then((code) => {
      broadcaster.emit("op", `■ ${label} exited ${code}`);
      this.current = null;
      Promise.resolve(this.deps.onDone(undefined))
        .then(() => broadcaster.emit("changed"))
        .catch((err) =>
          broadcaster.emit("op", `⚠ post-op capture: ${err instanceof Error ? err.message : String(err)}`));
    });
    return true;
  }

  /**
   * Shared runner: guard on a single in-flight invocation, stream output as `op`
   * events, lift a PR URL to a `pr` event, and on completion capture a frame and
   * emit `changed`. `onLine`, when given a streamed line, returns true if it
   * fully handled that line (apply()'s progress-JSON parsing) — `start()` then
   * skips its own `op`/`pr` broadcast for that one line, leaving every other
   * line's raw-log fallback untouched.
   *
   * `onExit` (the run playhead, #284 item 2) sees the exit code the moment the
   * process ends — the only signal that separates "the run finished" from "the
   * stream stopped", and the reason the playhead never has to infer completion.
   */
  private start(
    args: string[],
    label: string,
    opEnv?: string,
    cwd?: string,
    onLine?: (line: string) => boolean,
    onExit?: (code: number) => void,
  ): boolean {
    if (this.current) return false;
    const { projectDir, broadcaster } = this.deps;
    broadcaster.emit("op", `▶ chant ${args.join(" ")}`);
    const op = runChantStream(args, cwd ?? projectDir, (line) => {
      if (onLine?.(line)) return;
      broadcaster.emit("op", line);
      const pr = extractPrUrl(line);
      if (pr) broadcaster.emit("pr", pr);
    });
    this.current = label;
    void op.done.then((code) => {
      broadcaster.emit("op", `■ ${label} exited ${code}`);
      onExit?.(code);
      // Release the running-guard the instant the Op PROCESS ends. The post-op
      // frame capture is a live `chant graph --live` query that can take many
      // seconds against a slow/flaky emulator; it must NOT keep the guard held
      // (otherwise a finished Op still reads "an Op is already running") — run it
      // in the background and emit `changed` when it lands.
      this.current = null;
      Promise.resolve(this.deps.onDone(opEnv))
        .then(() => broadcaster.emit("changed"))
        .catch((err) =>
          broadcaster.emit("op", `⚠ post-op capture: ${err instanceof Error ? err.message : String(err)}`));
    });
    return true;
  }
}
