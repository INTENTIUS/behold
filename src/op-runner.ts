/**
 * OpRunner — the single place a delegated Op is triggered. Both the HTTP route
 * (Sync/Adopt) and the auto-sync loop (#29) go through it, so they share one
 * "an Op is already running" guard and one post-op capture path. behold never
 * applies; it runs `chant run <op>` on the executor and streams the phases.
 */
import { runChantStream } from "./chant.ts";
import { extractPrUrl } from "./adopt.ts";
import type { Broadcaster } from "./events.ts";

export interface OpRunnerDeps {
  projectDir: string;
  broadcaster: Broadcaster;
  /** After an op finishes: capture a lanes frame for the op's env (#25). */
  onDone: (opEnv: string | undefined) => Promise<unknown> | void;
}

export class OpRunner {
  private current: string | null = null;

  constructor(private deps: OpRunnerDeps) {}

  /** Name of the running op, or null. */
  get running(): string | null {
    return this.current;
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
   * Shared runner: guard on a single in-flight invocation, stream output as `op`
   * events, lift a PR URL to a `pr` event, and on completion capture a frame and
   * emit `changed`.
   */
  private start(args: string[], label: string, opEnv?: string, cwd?: string): boolean {
    if (this.current) return false;
    const { projectDir, broadcaster } = this.deps;
    broadcaster.emit("op", `▶ chant ${args.join(" ")}`);
    const op = runChantStream(args, cwd ?? projectDir, (line) => {
      broadcaster.emit("op", line);
      const pr = extractPrUrl(line);
      if (pr) broadcaster.emit("pr", pr);
    });
    this.current = label;
    void op.done.then(async (code) => {
      broadcaster.emit("op", `■ ${label} exited ${code}`);
      await this.deps.onDone(opEnv);
      broadcaster.emit("changed");
      this.current = null;
    });
    return true;
  }
}
