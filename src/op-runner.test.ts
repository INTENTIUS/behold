import { describe, it, expect, vi, beforeEach } from "vitest";

// The runner shells Ops via runChantStream; stub it so we control when the "op
// process" ends and inspect the running-guard without Docker/chant.
let resolveDone: (code: number) => void;
const streamMock = vi.fn(() => ({
  pid: 1,
  kill: vi.fn(),
  done: new Promise<number>((res) => { resolveDone = res; }),
}));
vi.mock("./chant.ts", () => ({ runChantStream: (...a: unknown[]) => streamMock(...a) }));

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
