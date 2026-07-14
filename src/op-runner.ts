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
   * Start `chant run <name>` unless one is already running. Returns true if it
   * started, false if busy. Streams output as `op` events; lifts a PR URL to a
   * `pr` event; on completion captures a frame and emits `changed`.
   */
  trigger(name: string, opEnv?: string): boolean {
    if (this.current) return false;
    const { projectDir, broadcaster } = this.deps;
    broadcaster.emit("op", `▶ chant run ${name}`);
    const op = runChantStream(["run", name], projectDir, (line) => {
      broadcaster.emit("op", line);
      const pr = extractPrUrl(line);
      if (pr) broadcaster.emit("pr", pr);
    });
    this.current = name;
    void op.done.then(async (code) => {
      broadcaster.emit("op", `■ ${name} exited ${code}`);
      await this.deps.onDone(opEnv);
      broadcaster.emit("changed");
      this.current = null;
    });
    return true;
  }
}
