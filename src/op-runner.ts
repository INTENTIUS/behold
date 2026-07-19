/**
 * OpRunner — the single place a delegated Op (or write) is triggered. The HTTP
 * routes (Sync/Adopt/rollback/apply) and the auto-sync loop (#29) all go
 * through it, so they share one "something is already running" guard and one
 * post-run capture path. behold never applies directly; it runs `chant run
 * <op>` (or, since M3, `chant run <target> --components --progress-json`) on
 * the executor and streams the phases.
 */
import { runChantStream, applyArgs } from "./chant.ts";
import { extractPrUrl } from "./adopt.ts";
import { parseProgressLine, applyProgressReducer, initialApplyProgress, type ApplyProgressState } from "./apply.ts";
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

  constructor(private deps: OpRunnerDeps) {}

  /** Name of the running op, or null. */
  get running(): string | null {
    return this.current;
  }

  /** The last known apply progress model (M3) — `initialApplyProgress` if no
   * apply has run yet this session. */
  get applyProgress(): ApplyProgressState {
    return this.lastApplyProgress;
  }

  /**
   * Start `chant run <name>` unless one is already running (the Sync/Adopt/auto-
   * sync path). `cwd` is the Op's own project dir (#31 multi-estate); defaults to
   * the primary. Returns true if it started, false if busy.
   */
  trigger(name: string, opEnv?: string, cwd?: string): boolean {
    return this.start(["run", name], name, opEnv, cwd);
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
   * Shared runner: guard on a single in-flight invocation, stream output as `op`
   * events, lift a PR URL to a `pr` event, and on completion capture a frame and
   * emit `changed`. `onLine`, when given a streamed line, returns true if it
   * fully handled that line (apply()'s progress-JSON parsing) — `start()` then
   * skips its own `op`/`pr` broadcast for that one line, leaving every other
   * line's raw-log fallback untouched.
   */
  private start(
    args: string[],
    label: string,
    opEnv?: string,
    cwd?: string,
    onLine?: (line: string) => boolean,
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
