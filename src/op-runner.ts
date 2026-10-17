/**
 * OpRunner: the single place a delegated Op (or write) is triggered. The HTTP
 * routes (Sync/Adopt/rollback/apply) and the auto-sync loop (#29) all go
 * through it, so they share one "something is already running" guard and one
 * post-run capture path. behold never applies directly; it runs `chant run
 * <op> --events-json` (or, since M3, `chant run <target> --components
 * --events-json`) on the executor and renders chant's run events (#679,
 * src/run-events.ts). Below chant 0.124.28 it asks for the older
 * `--progress-json` instead and labels the run degraded.
 */
import { runChantStream, runCommandStream, runChantRaw, applyArgs, opRunArgs, runEventsArgs, resolveChant, type RunStream } from "./chant.ts";
import type { CiPipeline } from "./chant.ts";
import { extractPrUrl } from "./adopt.ts";
import { applyProgressOf, applyEnded, initialApplyProgress, type ApplyProgressState } from "./apply.ts";
import { pipelineProgress, foldPipelineLine, finishPipelineProgress, type PipelineProgressState } from "./ci-run.ts";
import { floorFor, floorMet } from "./chant-floors.ts";
import { readRunLine, foldRunEvent, runEventLine, initialFold, type RunEventFold, type RunEventLine } from "./run-events.ts";
import {
  stepLine,
  initialRunState,
  runStarted,
  runFromFold,
  runEnded,
  runGate,
  runLost,
  readRunStatus,
  type RunState,
  type RunStatusRead,
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

/** How long a followed run may be silent before behold asks whether it is
 * still running (`chant run status`), and how long it may be silent at all.
 * A run killed with SIGKILL never writes `run-settle` (chant#4042), so a
 * follow does not end on its own; these end it. Overridable for tests and
 * for estates with long silent steps. */
export const FOLLOW_IDLE_MS = Number(process.env.BEHOLD_RUN_EVENTS_IDLE_MS) || 60_000;
export const FOLLOW_MAX_IDLE_MS = Number(process.env.BEHOLD_RUN_EVENTS_MAX_IDLE_MS) || 30 * 60_000;
/** How long behold waits before asking again for a run chant kept no events for. */
const FOLLOW_RETRY_MS = 60_000;

/** Why a run renders from the older stream: the project's chant is below the
 * run-events floor. Said on the playhead and the dial. */
export function degradedNote(version: string | undefined): string {
  const f = floorFor("run events");
  return `degraded: this project's chant (${version ?? "unknown version"}) is older than ${f.floor}, so behold reads the older --progress-json stream, which has no step starts, skip reasons, cache hits or gate events, and cannot read a run it did not start`;
}

export interface OpRunnerDeps {
  projectDir: string;
  broadcaster: Broadcaster;
  /** After an op finishes: capture a lanes frame for the op's env (#25). */
  onDone: (opEnv: string | undefined) => Promise<unknown> | void;
  /** The chant version a directory resolves, for the run-events floor.
   * Defaults to src/chant.ts's `resolveChant`. */
  chantVersion?: (dir: string) => string | undefined;
  /** Is a followed run still running? Asked when its stream has been silent
   * for {@link FOLLOW_IDLE_MS}. Defaults to `chant run status <op>`. */
  liveness?: (op: string, cwd: string) => Promise<boolean>;
  followIdleMs?: number;
  followMaxIdleMs?: number;
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
  /** The run events folded so far for the playhead's run and for the apply. */
  private runFold: RunEventFold = initialFold;
  private applyFold: RunEventFold = initialFold;
  /** Stops the follow of a run behold did not start, while one is open. */
  private followStop: (() => void) | null = null;
  /** Runs chant kept no events for, and when behold last asked, so a status
   * poll does not spawn a follow for the same answer every time. */
  private followRefused = new Map<string, number>();

  constructor(private deps: OpRunnerDeps) {}

  /** Which stream to ask `dir`'s chant for (#679): run events at or above the
   * floor, the older progress stream below it. */
  private streamFor(dir: string): { stream: RunStream; version: string | undefined } {
    const version = (this.deps.chantVersion ?? ((d: string) => resolveChant(d).version))(dir);
    return { stream: floorMet(floorFor("run events"), version) ? "events" : "progress", version };
  }

  /**
   * Read one streamed line of a run as run progress, folding it into `fold`.
   * Returns the new fold and whether the line was progress (consumed), and
   * says on the now-line what each event did. A line that names the run-event
   * schema and fails it is refused on the now-line and not folded.
   */
  private foldLine(fold: RunEventFold, line: string): { fold: RunEventFold; consumed: boolean } {
    const read = readRunLine(line);
    if (!read) return { fold, consumed: false };
    if (read.kind === "refused") {
      this.deps.broadcaster.emit("op", `⚠ behold did not read ${read.reason}`);
      return { fold, consumed: true };
    }
    const events: RunEventLine[] = read.kind === "event" ? [read.event] : read.events;
    let next = fold;
    for (const e of events) {
      next = foldRunEvent(next, e);
      const said = read.kind === "event" ? runEventLine(e) : e.type === "step-settle" ? stepLine(next.steps.at(-1)!) : null;
      if (said) this.deps.broadcaster.emit("op", said);
    }
    return { fold: next, consumed: true };
  }

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
    const base: RunState = this.lastRunState.op === op ? this.lastRunState : { ...initialRunState, op, mode: "local" as const };
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
   * Every run is `chant run <name> --events-json` on the project's resolved
   * runtime (#679): chant's run events on stdout, one JSON line per event, and
   * its human summary on stderr. A gated Op runs locally too: it stops at its
   * gate, says so in `gate-waiting` and `run-settle`, and exits 3 (#459).
   * Below chant 0.124.28 the run is `--progress-json` (one line per settled
   * step) and the state says it is degraded. Each event is re-said on the
   * `op` now-line ({@link runEventLine}).
   */
  trigger(name: string, opEnv?: string, cwd?: string): boolean {
    if (this.current) return false;
    this.stopFollow();
    const mode = "local" as const;
    const { stream, version } = this.streamFor(cwd ?? this.deps.projectDir);
    this.runFold = initialFold;
    this.lastRunState = runStarted(name, mode, new Date().toISOString(), stream, stream === "progress" ? degradedNote(version) : null);
    this.emitRun();
    return this.start(
      opRunArgs(name, stream),
      name,
      opEnv,
      cwd,
      (line) => {
        const { fold, consumed } = this.foldLine(this.runFold, line);
        if (!consumed) return false; // not progress: start() broadcasts it as a raw "op" line
        if (fold !== this.runFold) {
          this.runFold = fold;
          this.lastRunState = runFromFold(this.lastRunState, fold);
          this.emitRun();
        }
        return true; // consumed: start() skips the raw "op" broadcast for this line
      },
      (code) => {
        this.lastRunState = runEnded(this.lastRunState, code, new Date().toISOString(), this.runFold.settled);
        this.emitRun();
      },
    );
  }

  /**
   * Follow a run behold did not start (#679): `chant run events <run> --json
   * --follow` replays the events chant kept for it on this host and tails it
   * until `run-settle`. `read` is the status read that named the run.
   *
   * It is a read, not a write, so it takes no running-guard. It does not
   * start when the playhead already shows that run from its events, when the
   * playhead belongs to another Op's run, when the project's chant is below
   * the floor, or when the run ran off this host (a steward run keeps no
   * events here); the last two say so on the state. A run killed with SIGKILL
   * never writes `run-settle`, so a follow that goes silent asks whether the
   * run is still running and ends as `lost` when it is not, or when it has
   * been silent too long. Returns true when it started.
   *
   * With no run id (`chant run status` records a local run only once it
   * settles, so a run in progress elsewhere is "no run" to it), `byName`
   * follows the Op's newest run by name, which `chant run events` accepts.
   */
  follow(op: string, read: Pick<RunStatusRead, "runId" | "runtime" | "status">, cwd?: string, opts: { byName?: boolean } = {}): boolean {
    const state = this.lastRunState;
    if (state.op !== null && state.op !== op) return false;
    if (this.current && state.op === op) return false;
    if (state.following && state.op === op && (!read.runId || state.runId === read.runId)) return false;
    const runId = read.runId ?? (opts.byName ? op : undefined);
    if (!runId) return false;
    if (state.runId === runId && state.source === "events") return false;
    const refusedAt = this.followRefused.get(runId);
    if (refusedAt !== undefined && Date.now() - refusedAt < FOLLOW_RETRY_MS) return false;
    const dir = cwd ?? this.deps.projectDir;
    const { stream, version } = this.streamFor(dir);
    const base: RunState = state.op === op ? state : { ...initialRunState, op, mode: "local" };
    if (stream === "progress") {
      this.setRun({ ...base, runId: read.runId ?? base.runId, sourceNote: degradedNote(version) });
      return false;
    }
    if (read.runtime && read.runtime !== "local") {
      this.setRun({
        ...base,
        runId: read.runId ?? base.runId,
        runtime: read.runtime,
        sourceNote: `this run ran on ${read.runtime}; a steward run keeps no events on this host, so only the status read answers`,
      });
      return false;
    }
    this.stopFollow();
    this.runFold = initialFold;
    this.lastRunState = {
      ...initialRunState,
      op,
      mode: "local",
      // Followed by name, there may be no run at all until an event says so.
      status: read.runId ? "running" : "idle",
      source: "events",
      runId: read.runId ?? null,
      runtime: read.runtime ?? "local",
      following: true,
      startedAt: new Date().toISOString(),
      gate: base.gate,
      // The status read's "no run" is the reason behold looked by name; the
      // stream answers now, so it is not repeated as a gate refusal.
      gateNote: read.runId ? base.gateNote : null,
    };
    this.emitRun();

    const { broadcaster } = this.deps;
    broadcaster.emit("op", `▶ chant ${runEventsArgs(runId).join(" ")}`);
    let lastHeard = Date.now();
    let stopped = false;
    const child = runChantStream(runEventsArgs(runId), dir, (line) => {
      lastHeard = Date.now();
      const { fold, consumed } = this.foldLine(this.runFold, line);
      if (!consumed) {
        broadcaster.emit("op", line);
        return;
      }
      if (fold !== this.runFold && !stopped) {
        this.runFold = fold;
        this.lastRunState = runFromFold(this.lastRunState, fold);
        this.emitRun();
      }
    });
    const idleMs = this.deps.followIdleMs ?? FOLLOW_IDLE_MS;
    const maxIdleMs = this.deps.followMaxIdleMs ?? FOLLOW_MAX_IDLE_MS;
    const alive = this.deps.liveness ?? defaultLiveness;
    let asking = false;
    const timer = setInterval(() => {
      if (stopped || asking || Date.now() - lastHeard < idleMs) return;
      asking = true;
      void alive(op, dir)
        .catch(() => false)
        .then((running) => {
          asking = false;
          if (stopped) return;
          const silent = Date.now() - lastHeard;
          if (running && silent < maxIdleMs) return;
          const why = running
            ? `the run's events have been silent for ${Math.round(silent / 1000)}s, longer than behold follows a silent run`
            : `the run's events stopped without run-settle and chant run status no longer reports it running (a run killed outright writes no settle)`;
          stop();
          child.kill();
          this.lastRunState = runLost(this.lastRunState, `${why}; the playhead stays at the last settled step.`, new Date().toISOString());
          this.emitRun();
        });
    }, Math.max(50, Math.min(idleMs, 5_000)));
    (timer as { unref?: () => void }).unref?.();
    const stop = (): void => {
      stopped = true;
      clearInterval(timer);
      if (this.followStop === stopAndKill) this.followStop = null;
    };
    const stopAndKill = (): void => {
      stop();
      child.kill();
    };
    this.followStop = stopAndKill;
    void child.done.then((code) => {
      if (stopped) return;
      stop();
      const at = new Date().toISOString();
      if (this.runFold.settled) {
        this.lastRunState = { ...runFromFold(this.lastRunState, this.runFold), following: false, endedAt: this.lastRunState.endedAt ?? at };
      } else if (this.runFold.lastSeq === null) {
        // chant kept no events for the run (an older run, --no-record, or a
        // run that started before chant 0.124.28): say so, and keep the run
        // as the status read left it.
        this.followRefused.set(runId, Date.now());
        this.lastRunState = {
          ...this.lastRunState,
          status: "idle",
          following: false,
          source: null,
          runId: read.runId ?? null,
          sourceNote: `chant keeps no events for ${read.runId ? `run ${runId}` : `a run of ${op}`} on this host (chant run events exited ${code}), so only the status read answers`,
        };
      } else {
        this.lastRunState = runLost(this.lastRunState, `the follow ended (exit ${code}) without run-settle; the playhead stays at the last settled step.`, at);
      }
      this.emitRun();
    });
    return true;
  }

  /** Stop following a run behold did not start, if one is being followed. */
  stopFollow(): void {
    this.followStop?.();
    this.followStop = null;
    if (this.lastRunState.following) this.lastRunState = { ...this.lastRunState, following: false };
  }

  private setRun(next: RunState): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.lastRunState);
    this.lastRunState = next;
    if (changed) this.emitRun();
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
   * --env <env> --events-json`, guarded the same way as `trigger`/`run`:
   * only one write in flight at a time; returns false (the caller answers
   * 409) when something else is already running. `target` is a component
   * name or `"all"`.
   *
   * Each streamed line is read by src/run-events.ts: a run event (or, below
   * chant 0.124.28, an older `--progress-json` line, translated) folds into
   * the run, and the dial's model (`applyProgressOf`) broadcasts as an `apply`
   * SSE event. Everything else (chant's human-readable driver summary, a
   * warning, a release-record line) still reaches the `op` channel as a
   * raw-log fallback, exactly like any other Op. A process that ends without
   * `run-settle` leaves the dial `lost`, never green.
   */
  apply(target: string, env: string): boolean {
    // Guard first, THEN reset: a rejected call (something else already running)
    // must leave whatever progress is currently on screen untouched; only a
    // write that actually STARTS gets to clear the previous run's terminal
    // state. `start()` re-checks `this.current` itself right after (same
    // synchronous tick, so it can't have changed); this only sequences the reset.
    if (this.current) return false;
    const { stream, version } = this.streamFor(this.deps.projectDir);
    const source = stream === "events" ? "events" : "progress";
    this.applyFold = initialFold;
    this.lastApplyProgress = initialApplyProgress;
    if (stream === "progress") this.deps.broadcaster.emit("op", `⚠ ${degradedNote(version)}`);
    return this.start(
      applyArgs(target, env, stream),
      `apply ${target}`,
      env,
      undefined,
      (line) => {
        const { fold, consumed } = this.foldLine(this.applyFold, line);
        if (!consumed) return false; // not progress: start() broadcasts it as a raw "op" line
        if (fold !== this.applyFold) {
          this.applyFold = fold;
          this.lastApplyProgress = applyProgressOf(fold, source);
          this.deps.broadcaster.emit("apply", JSON.stringify(this.lastApplyProgress));
        }
        return true; // consumed: start() skips the raw "op" broadcast for this line
      },
      (code) => {
        const next = applyEnded(this.lastApplyProgress, this.applyFold.settled, code);
        if (next !== this.lastApplyProgress) {
          this.lastApplyProgress = next;
          this.deps.broadcaster.emit("apply", JSON.stringify(next));
        }
      },
    );
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

/** Is `op`'s newest run still running, by `chant run status`? A read that
 * fails answers no: a follow that cannot confirm the run is alive ends. */
async function defaultLiveness(op: string, cwd: string): Promise<boolean> {
  const result = readRunStatus(op, await runChantRaw(["run", "status", op], cwd));
  return result.ok && (result.read.status === "running" || result.read.status === "waiting");
}
