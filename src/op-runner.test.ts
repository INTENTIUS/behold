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

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OpRunner } from "./op-runner.ts";
import { Broadcaster } from "./events.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "run-events");
const recorded = (name: string): string[] => readFileSync(join(FIX, name), "utf8").trim().split("\n");

/** A project whose chant is at the run-events floor or above (#679). */
const CURRENT = () => "0.124.28";
/** A project on a chant below it: degraded mode, the older --progress-json. */
const OLD = () => "0.124.24";

function makeRunner(onDone: (env: string | undefined) => Promise<unknown> | void, chantVersion = CURRENT) {
  return new OpRunner({ projectDir: "/proj", broadcaster: new Broadcaster(), onDone, chantVersion });
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

  it("shells `chant run <target> --components --env <env> --events-json`, guarded like any other write (#679)", () => {
    const runner = makeRunner(() => {});
    expect(runner.apply("all", "local")).toBe(true);
    expect(runner.running).toBe("apply all");
    expect(lastArgs).toEqual(["run", "all", "--components", "--env", "local", "--events-json"]);
    expect(lastCwd).toBe("/proj");
  });

  it("below the run-events floor, asks for --progress-json and says it is degraded (#679)", () => {
    const broadcaster = new Broadcaster();
    const seen: string[] = [];
    broadcaster.subscribe((type, data) => type === "op" && seen.push(data));
    const runner = new OpRunner({ projectDir: "/proj", broadcaster, onDone: () => {}, chantVersion: OLD });
    runner.apply("all", "local");
    expect(lastArgs).toEqual(["run", "all", "--components", "--env", "local", "--progress-json"]);
    expect(seen.some((l) => l.includes("degraded") && l.includes("0.124.24") && l.includes("0.124.28"))).toBe(true);
    lastOnLine!('{"type":"run-start","waves":[["shared-foundation"]]}');
    expect(runner.applyProgress.source).toBe("progress");
  });

  it("renders a component run from its recorded run events, and a cut stream as lost (#679)", async () => {
    const runner = makeRunner(() => {});
    runner.apply("all", "local");
    const lines = recorded("components-gated.events.ndjson");
    for (const l of lines.slice(0, 7)) lastOnLine!(l);
    const sf = runner.applyProgress.components.find((c) => c.component === "shared-foundation")!;
    expect(runner.applyProgress.source).toBe("events");
    expect(sf.steps!.map((s) => s.state)).toEqual(["skipped", "cached"]);
    resolveDone(137);
    await Promise.resolve();
    expect(runner.applyProgress.status).toBe("lost");
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

// #284 item 2 — the run playhead: trigger() asks chant for structured per-step
// records, folds them, and broadcasts a `run` event on the existing
// Broadcaster (the same channel `apply` already rides). No parallel plumbing.
describe("OpRunner.trigger — the run playhead", () => {
  beforeEach(() => {
    streamMock.mockClear();
    lastArgs = [];
    lastOnLine = undefined;
  });

  it("asks for run events with --events-json and never passes the removed --temporal (#459, #679)", () => {
    const runner = makeRunner(() => {});
    runner.trigger("prod-promote", "prod", "/proj");
    expect(lastArgs).toEqual(["run", "prod-promote", "--events-json"]);
    expect(lastArgs).not.toContain("--temporal");
    expect(runner.runState.mode).toBe("local");
    expect(runner.runState.source).toBe("events");
  });

  it("below the floor, streams the older records with --progress-json and says it is degraded (#679)", () => {
    const runner = makeRunner(() => {}, OLD);
    runner.trigger("prod-promote", "prod", "/proj");
    expect(lastArgs).toEqual(["run", "prod-promote", "--progress-json"]);
    expect(runner.runState.source).toBe("progress");
    expect(runner.runState.sourceNote).toContain("degraded");
  });

  it("renders a recorded gated run from its events: the gate is named by the stream (#679)", async () => {
    const runner = makeRunner(() => {});
    runner.trigger("gated-probe");
    for (const l of recorded("gated-probe.gated.events.ndjson")) lastOnLine!(l);
    resolveDone(3);
    await Promise.resolve();
    expect(runner.runState.status).toBe("gated");
    expect(runner.runState.gate).toMatchObject({ signalName: "approve-probe" });
    expect(runner.runState.steps.map((s) => s.state)).toEqual(["ok", "gated"]);
    expect(runner.runState.runId).toMatch(/^local-/);
  });

  it("a step is running between its step-start and step-settle (#679)", () => {
    const runner = makeRunner(() => {});
    runner.trigger("fail-probe");
    const lines = recorded("fail-probe.events.ndjson");
    for (const l of lines.slice(0, 3)) lastOnLine!(l);
    expect(runner.runState.steps).toMatchObject([{ phase: "Build", step: "shellCmd", state: "running" }]);
    lastOnLine!(lines[3]);
    expect(runner.runState.steps).toMatchObject([{ phase: "Build", step: "shellCmd", state: "ok" }]);
  });

  it("an events run whose process ends without run-settle is lost, not finished (#679)", async () => {
    const runner = makeRunner(() => {});
    runner.trigger("fail-probe");
    for (const l of recorded("fail-probe.events.ndjson").slice(0, 4)) lastOnLine!(l);
    resolveDone(0);
    await Promise.resolve();
    expect(runner.runState.status).toBe("lost");
  });

  it("reads chant's exit 3 as a run stopped at its gate on the older stream (#459)", async () => {
    const runner = makeRunner(() => {}, OLD);
    runner.trigger("gated-probe");
    lastOnLine!('{"phase":"Before","fn":"shellCmd","args":{"cmd":"echo before"},"status":"ok","durationMs":3}');
    lastOnLine!('{"phase":"Approve","fn":"gate:approve-probe","args":{},"status":"skipped","durationMs":137}');
    resolveDone(3);
    await Promise.resolve();
    expect(runner.runState.status).toBe("gated");
    expect(runner.runState.steps).toHaveLength(2);
  });

  it("folds one older NDJSON record and broadcasts the whole playhead as a `run` event", () => {
    const broadcaster = new Broadcaster();
    const runner = new OpRunner({ projectDir: "/proj", broadcaster, onDone: () => {}, chantVersion: OLD });
    const seen: Array<{ type: string; data: string }> = [];
    broadcaster.subscribe((type, data) => seen.push({ type, data }));

    runner.trigger("playhead-probe");
    lastOnLine!('{"phase":"Build","fn":"chantBuild","status":"ok","durationMs":1000}');

    expect(runner.runState.steps).toEqual([{ component: null, phase: "Build", step: "chantBuild", state: "ok", durationMs: 1000 }]);
    const runEvents = seen.filter((e) => e.type === "run");
    // One at trigger (so a client reloading mid-run sees "running" at once),
    // one per record.
    expect(runEvents).toHaveLength(2);
    expect(JSON.parse(runEvents[1]!.data)).toEqual(runner.runState);
  });

  it("re-narrates each settled record on the now-line, so the structured stream costs no output", () => {
    const broadcaster = new Broadcaster();
    const runner = new OpRunner({ projectDir: "/proj", broadcaster, onDone: () => {}, chantVersion: OLD });
    const seen: string[] = [];
    broadcaster.subscribe((type, data) => {
      if (type === "op") seen.push(data);
    });

    runner.trigger("playhead-probe");
    lastOnLine!('{"phase":"Deploy","fn":"shellCmd","status":"ok","durationMs":5}');
    expect(seen).toContain("✓ Deploy · shellCmd: 5ms");
    // ...and the raw JSON line itself never reaches the now-line.
    expect(seen.some((l) => l.includes('"durationMs"'))).toBe(false);
  });

  it("still relays a non-record line to the `op` channel — an activity's own stdout", () => {
    const broadcaster = new Broadcaster();
    const runner = new OpRunner({ projectDir: "/proj", broadcaster, onDone: () => {} });
    const seen: string[] = [];
    broadcaster.subscribe((type, data) => {
      if (type === "op") seen.push(data);
    });

    runner.trigger("floci-apply");
    lastOnLine!("> chant build src --lexicon aws");
    expect(seen).toContain("> chant build src --lexicon aws");
    expect(runner.runState.steps).toEqual([]);
  });

  it("on the older stream, a clean exit reads as completion; a verdictless one reads as a lost stream", async () => {
    const runner = makeRunner(() => {}, OLD);
    runner.trigger("playhead-probe");
    lastOnLine!('{"phase":"Build","fn":"chantBuild","status":"ok","durationMs":1000}');
    resolveDone(0);
    await Promise.resolve();
    expect(runner.runState.status).toBe("ok");

    const lost = makeRunner(() => {}, OLD);
    lost.trigger("playhead-probe");
    lastOnLine!('{"phase":"Build","fn":"chantBuild","status":"ok","durationMs":1000}');
    resolveDone(137);
    await Promise.resolve();
    expect(lost.runState.status).toBe("lost");
    expect(lost.runState.steps).toHaveLength(1); // frozen at last-settled
  });

  it("a rejected trigger (guard busy) leaves the playhead on screen untouched", () => {
    const runner = makeRunner(() => {});
    runner.trigger("playhead-probe");
    lastOnLine!('{"phase":"Build","fn":"chantBuild","status":"ok","durationMs":1000}');
    expect(runner.trigger("other")).toBe(false);
    expect(runner.runState.op).toBe("playhead-probe");
    expect(runner.runState.steps).toHaveLength(1);
  });

  it("folds a status read, and adopts an Op nothing has run this session", () => {
    const runner = makeRunner(() => {});
    const gate = { signalName: "approve-promote", since: "2026-08-29T18:00:12.000Z" };
    const state = runner.noteGate("prod-promote", { ok: true, read: { op: "prod-promote", gate } });
    expect(state).toMatchObject({ op: "prod-promote", mode: "local", gate });

    // A read for a DIFFERENT Op doesn't re-point the playhead at it.
    runner.noteGate("other-op", { ok: true, read: { op: "other-op", gate: null } });
    expect(runner.runState.op).toBe("prod-promote");
    expect(runner.runState.gate).toEqual(gate);
  });

  it("a gate refusal clears the gate and keeps its reason — never a silent 'nothing pending'", () => {
    const runner = makeRunner(() => {});
    runner.noteGate("prod-promote", {
      ok: false,
      refusal: { error: 'No run of "prod-promote" to report — nope', code: "no-run", remedy: "r" },
    });
    expect(runner.runState.gate).toBeNull();
    expect(runner.runState.gateNote).toContain("No run of");
  });
});

// #679: a run behold did not start is read from the events chant kept for it,
// `chant run events <run> --json --follow`, with a liveness check for a run
// killed outright (it never writes run-settle).
describe("OpRunner.follow: a run this session didn't start", () => {
  beforeEach(() => {
    streamMock.mockClear();
    lastArgs = [];
    lastOnLine = undefined;
  });
  const read = { runId: "local-1792211087627", runtime: "local", status: "gated" };

  it("replays and tails the run's events, and renders them like a run it started", async () => {
    const runner = makeRunner(() => {});
    expect(runner.follow("gated-probe", read, "/proj/ops")).toBe(true);
    expect(lastArgs).toEqual(["run", "events", "local-1792211087627", "--json", "--follow"]);
    expect(lastCwd).toBe("/proj/ops");
    expect(runner.runState).toMatchObject({ op: "gated-probe", following: true, source: "events", runId: read.runId });
    // It is a read, not a write: the running-guard stays free.
    expect(runner.running).toBeNull();
    for (const l of recorded("gated-probe.gated.events.ndjson")) lastOnLine!(l);
    resolveDone(3);
    await Promise.resolve();
    expect(runner.runState).toMatchObject({ status: "gated", following: false, gate: { signalName: "approve-probe" } });
    // Asked again for the same run, it does not follow twice.
    expect(runner.follow("gated-probe", read)).toBe(false);
  });

  it("declines below the floor, and for a steward run, and says why on the state", () => {
    const old = makeRunner(() => {}, OLD);
    expect(old.follow("gated-probe", read)).toBe(false);
    expect(old.runState.sourceNote).toContain("degraded");
    expect(streamMock).not.toHaveBeenCalled();

    const runner = makeRunner(() => {});
    expect(runner.follow("gated-probe", { ...read, runtime: "fountain" })).toBe(false);
    expect(runner.runState.sourceNote).toContain("steward run keeps no events on this host");
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("does not re-point the playhead at another Op's run", () => {
    const runner = makeRunner(() => {});
    runner.trigger("fail-probe");
    expect(runner.follow("gated-probe", read)).toBe(false);
    expect(runner.runState.op).toBe("fail-probe");
  });

  it("a run chant kept no events for says so, and is not painted as lost", async () => {
    const runner = makeRunner(() => {});
    runner.follow("gated-probe", read);
    resolveDone(1);
    await Promise.resolve();
    expect(runner.runState).toMatchObject({ status: "idle", following: false });
    expect(runner.runState.sourceNote).toContain("keeps no events");
  });

  it("a follow that goes silent asks whether the run is alive, and ends lost when it is not", async () => {
    const liveness = vi.fn(async () => false);
    const runner = new OpRunner({ projectDir: "/proj", broadcaster: new Broadcaster(), onDone: () => {}, chantVersion: CURRENT, liveness, followIdleMs: 20 });
    runner.follow("fail-probe", { runId: "local-1" });
    const lines = recorded("fail-probe.events.ndjson");
    for (const l of lines.slice(0, 4)) lastOnLine!(l);
    const kill = streamMock.mock.results.at(-1)!.value.kill as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => expect(runner.runState.status).toBe("lost"), { timeout: 2000 });
    expect(liveness).toHaveBeenCalledWith("fail-probe", "/proj");
    expect(kill).toHaveBeenCalled();
    expect(runner.runState.lost).toContain("no longer reports it running");
    expect(runner.runState.steps.filter((s) => s.state === "ok")).toHaveLength(1);
  });

  it("a silent run chant still reports running keeps being followed until the silence is too long", async () => {
    const liveness = vi.fn(async () => true);
    const runner = new OpRunner({ projectDir: "/proj", broadcaster: new Broadcaster(), onDone: () => {}, chantVersion: CURRENT, liveness, followIdleMs: 20, followMaxIdleMs: 300 });
    runner.follow("fail-probe", { runId: "local-2" });
    lastOnLine!(recorded("fail-probe.events.ndjson")[0]);
    await vi.waitFor(() => expect(liveness).toHaveBeenCalled(), { timeout: 2000 });
    expect(runner.runState.status).toBe("running");
    await vi.waitFor(() => expect(runner.runState.status).toBe("lost"), { timeout: 3000 });
    expect(runner.runState.lost).toContain("silent");
  });

  it("starting a run of its own stops the follow", () => {
    const runner = makeRunner(() => {});
    runner.follow("gated-probe", read);
    const kill = streamMock.mock.results.at(-1)!.value.kill as ReturnType<typeof vi.fn>;
    runner.trigger("gated-probe");
    expect(kill).toHaveBeenCalled();
    expect(runner.runState.following).toBe(false);
  });
});

describe("OpRunner.follow by name", () => {
  beforeEach(() => {
    streamMock.mockClear();
    lastArgs = [];
  });

  it("follows the Op's newest run by name when the status read has no run, and does not ask again at once", async () => {
    const runner = makeRunner(() => {});
    expect(runner.follow("slow-probe", {}, undefined, { byName: true })).toBe(true);
    expect(lastArgs).toEqual(["run", "events", "slow-probe", "--json", "--follow"]);
    resolveDone(1); // chant: no events are kept for it
    await Promise.resolve();
    expect(runner.runState.sourceNote).toContain("keeps no events for a run of slow-probe");
    expect(runner.runState.runId).toBeNull();
    expect(runner.follow("slow-probe", {}, undefined, { byName: true })).toBe(false);
    expect(runner.follow("slow-probe", {})).toBe(false); // no run id, no name asked for
  });
});
