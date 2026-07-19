import { describe, it, expect, vi, beforeEach } from "vitest";

// The runner shells Ops (and, since M3, apply) via runChantStream; stub it so
// we control when the "op process" ends and can inspect the running-guard,
// the argv it was called with, and feed it lines to exercise the onLine
// callback (M3's progress-JSON parsing) without Docker/chant.
let resolveDone: (code: number) => void;
let lastArgs: string[] = [];
let lastCwd: string | undefined;
let lastOnLine: ((line: string) => void) | undefined;
const streamMock = vi.fn((args: string[], cwd: string, onLine: (line: string) => void) => {
  lastArgs = args;
  lastCwd = cwd;
  lastOnLine = onLine;
  return {
    pid: 1,
    kill: vi.fn(),
    done: new Promise<number>((res) => {
      resolveDone = res;
    }),
  };
});
vi.mock("./chant.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chant.ts")>();
  return {
    ...actual,
    runChantStream: (args: string[], cwd: string, onLine: (line: string) => void) => streamMock(args, cwd, onLine),
  };
});

import { OpRunner } from "./op-runner.ts";
import { Broadcaster } from "./events.ts";

function makeRunner(onDone: (env: string | undefined) => Promise<unknown> | void) {
  return new OpRunner({ projectDir: "/proj", broadcaster: new Broadcaster(), onDone });
}

describe("OpRunner running-guard", () => {
  beforeEach(() => streamMock.mockClear());

  it("releases the guard when the op process ends, even if the post-op capture hangs", async () => {
    // onDone never resolves — simulates a slow live `chant graph --live` capture.
    const runner = makeRunner(() => new Promise(() => {}));
    expect(runner.trigger("floci-apply")).toBe(true);
    expect(runner.running).toBe("floci-apply");

    resolveDone(0); // the op PROCESS closes
    await Promise.resolve(); // let the .then microtask run

    // Guard is free immediately — a finished Op must not read "already running"
    // just because the background frame capture is still in flight.
    expect(runner.running).toBeNull();
    expect(runner.trigger("floci-apply")).toBe(true);
  });

  it("refuses a second Op while the first process is still running", () => {
    const runner = makeRunner(() => {});
    expect(runner.trigger("a")).toBe(true);
    expect(runner.trigger("b")).toBe(false);
    expect(runner.running).toBe("a");
  });
});

// M3 (#54) — the apply() delegated write: same guard as trigger()/run(), plus
// the NDJSON progress-JSON parsing that makes it distinct from a plain Op.
describe("OpRunner.apply", () => {
  beforeEach(() => {
    streamMock.mockClear();
    lastArgs = [];
    lastOnLine = undefined;
  });

  it("shells `chant run <target> --components --env <env> --progress-json`, guarded like any other write", () => {
    const runner = makeRunner(() => {});
    expect(runner.apply("all", "local")).toBe(true);
    expect(runner.running).toBe("apply all");
    expect(lastArgs).toEqual(["run", "all", "--components", "--env", "local", "--progress-json"]);
    expect(lastCwd).toBe("/proj");
  });

  it("refuses a second apply — or any other delegated write — while one is already running", () => {
    const runner = makeRunner(() => {});
    expect(runner.apply("shared-foundation", "local")).toBe(true);
    expect(runner.apply("loom-db", "local")).toBe(false);
    expect(runner.trigger("some-op")).toBe(false);
    expect(runner.running).toBe("apply shared-foundation");
  });

  it("frees the guard once the apply process ends, same as trigger()/run()", async () => {
    const runner = makeRunner(() => {});
    runner.apply("all", "local");
    resolveDone(0);
    await Promise.resolve();
    expect(runner.running).toBeNull();
    expect(runner.apply("all", "local")).toBe(true);
  });

  it("folds a streamed RunProgressEvent line into applyProgress and broadcasts it as an `apply` event", () => {
    const broadcaster = new Broadcaster();
    const runner = new OpRunner({ projectDir: "/proj", broadcaster, onDone: () => {} });
    const seen: Array<{ type: string; data: string }> = [];
    broadcaster.subscribe((type, data) => seen.push({ type, data }));

    runner.apply("all", "local");
    lastOnLine!('{"type":"run-start","waves":[["shared-foundation"]]}');

    expect(runner.applyProgress.status).toBe("running");
    expect(runner.applyProgress.waves).toEqual([{ wave: 1, components: ["shared-foundation"], status: "pending" }]);

    const applyEvents = seen.filter((e) => e.type === "apply");
    expect(applyEvents).toHaveLength(1);
    expect(JSON.parse(applyEvents[0]!.data)).toEqual(runner.applyProgress);
  });

  it("does NOT broadcast a progress-JSON line on the raw `op` channel — it's the structured `apply` event's job", () => {
    const broadcaster = new Broadcaster();
    const runner = new OpRunner({ projectDir: "/proj", broadcaster, onDone: () => {} });
    const seen: Array<{ type: string; data: string }> = [];
    broadcaster.subscribe((type, data) => seen.push({ type, data }));

    runner.apply("all", "local");
    lastOnLine!('{"type":"run-start","waves":[["shared-foundation"]]}');

    const opLines = seen.filter((e) => e.type === "op").map((e) => e.data);
    expect(opLines.some((l) => l.includes("run-start"))).toBe(false);
  });

  it("still relays a non-progress line (chant's human summary) to the `op` channel — the raw-log fallback", () => {
    const broadcaster = new Broadcaster();
    const runner = new OpRunner({ projectDir: "/proj", broadcaster, onDone: () => {} });
    const seen: Array<{ type: string; data: string }> = [];
    broadcaster.subscribe((type, data) => seen.push({ type, data }));

    runner.apply("all", "local");
    lastOnLine!('Component "shared-foundation" completed successfully.');

    const opLines = seen.filter((e) => e.type === "op").map((e) => e.data);
    expect(opLines).toContain('Component "shared-foundation" completed successfully.');
    // And it did NOT get folded into the structured progress model.
    expect(runner.applyProgress).toEqual({ status: "idle", waves: [], components: [] });
  });

  it("a failed step's progress event still broadcasts — the structured view must show red, not silently drop it", () => {
    const broadcaster = new Broadcaster();
    const runner = new OpRunner({ projectDir: "/proj", broadcaster, onDone: () => {} });
    runner.apply("loom-db", "local");
    lastOnLine!('{"type":"run-start","waves":[["loom-db"]]}');
    lastOnLine!('{"type":"component-start","wave":1,"component":"loom-db"}');
    lastOnLine!(
      '{"type":"step","component":"loom-db","phase":"Apply","step":"cfn-deploy","status":"failed","error":"UPDATE_ROLLBACK_COMPLETE"}',
    );
    const db = runner.applyProgress.components.find((c) => c.component === "loom-db");
    expect(db?.status).toBe("failed");
    expect(db?.error).toBe("UPDATE_ROLLBACK_COMPLETE");
  });

  it("a REJECTED apply (guard busy) leaves the currently-displayed progress alone — no false reset behind a 409", () => {
    const runner = makeRunner(() => {});
    runner.apply("loom-db", "local");
    lastOnLine!('{"type":"run-done","status":"failed"}');
    expect(runner.applyProgress.status).toBe("failed");

    expect(runner.apply("all", "local")).toBe(false); // still busy — first process hasn't closed
    // The failed run's progress is still what the SPA should be showing.
    expect(runner.applyProgress.status).toBe("failed");
  });

  it("resets applyProgress to idle at the start of a new apply, not the previous run's terminal state", async () => {
    const runner = makeRunner(() => {});
    runner.apply("all", "local");
    lastOnLine!('{"type":"run-done","status":"failed"}');
    expect(runner.applyProgress.status).toBe("failed");
    resolveDone(1);
    await Promise.resolve();

    runner.apply("all", "local"); // a second, fresh apply
    expect(runner.applyProgress).toEqual({ status: "idle", waves: [], components: [] });
  });
});
