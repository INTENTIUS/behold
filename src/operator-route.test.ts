import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn as spawnMock } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The HTTP half of the operator strip and the converge gate card (#234 joins 3
// + 1). src/operator.test.ts covers the parse and the two models against the
// chant-derived fixtures; this proves the routes reach a client — including the
// two things that are easy to get quietly wrong: behold never shells `chant
// operator status` at a project that declares no loop, and the approve route
// answers with the recorded-fact semantics rather than implying an unblock.
//
// `node:child_process`'s `spawn` is mocked the same way src/server.test.ts and
// src/chant.test.ts mock it, so `runChantRaw` runs for REAL against a fake
// process — a real exit code, real stdout/stderr — rather than the route's
// dependency being swapped for a stub.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

/** A minimal fake ChildProcess, mirroring src/server.test.ts's `fakeProc`. */
function fakeProc(code: number, stdout = "", stderr = ""): ReturnType<typeof spawnMock> {
  const proc = new EventEmitter() as unknown as ReturnType<typeof spawnMock>;
  const out = new EventEmitter();
  const err = new EventEmitter();
  Object.assign(proc, { stdout: out, stderr: err });
  let fired = false;
  proc.on("newListener", (event) => {
    if (event !== "close" || fired) return;
    fired = true;
    queueMicrotask(() => {
      if (stdout) out.emit("data", Buffer.from(stdout));
      if (stderr) err.emit("data", Buffer.from(stderr));
      proc.emit("close", code);
    });
  });
  return proc;
}

import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import type { OperatorState, OperatorHistory } from "./operator.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OPS = join(HERE, "__fixtures__", "ops-example-writes");
const OPERATOR = join(HERE, "__fixtures__", "operator-status");
const statusJson = readFileSync(join(OPERATOR, "chant-test-values.status.json"), "utf8");
/** The chant 0.53.1 record shape (chant#2027) — see src/operator.test.ts's
 * provenance note. Its ConvergeOp is `fountain-converge`, so the fixture below
 * re-labels it to the one this project declares. */
const verdictsJson = readFileSync(join(OPERATOR, "verdicts.status.json"), "utf8").replace(/fountain-converge/g, "staging-converge");
const gateUrlJson = readFileSync(join(OPERATOR, "gate-url.status.json"), "utf8");
const timelineJson = readFileSync(join(OPERATOR, "timeline.log.json"), "utf8");

/** A project dir with the given emitted op.json files laid out where chant
 * writes them. `staging-converge` is the ConvergeOp fixture; the rest come from
 * the ops lens's own real-emitted set.
 *
 * `chantVersion` installs a stand-in `@intentius/chant` in the project's own
 * node_modules, so `resolveChant(dir).version` answers with a version this test
 * pins rather than whatever the checkout happens to have installed. The log
 * route gates on it (chant#2029 landed in 0.53.1), and that gate is the one
 * thing here that must not depend on the machine it runs on. Nothing is ever
 * executed from it — every spawn in this file is mocked. */
function project(names: string[], chantVersion?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-operator-route-"));
  writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["aws", "temporal"] };\n');
  for (const name of names) {
    mkdirSync(join(dir, "dist", "ops", name), { recursive: true });
    const from = name === "staging-converge" ? join(OPERATOR, `${name}.op.json`) : join(OPS, `${name}.op.json`);
    cpSync(from, join(dir, "dist", "ops", name, "op.json"));
  }
  if (chantVersion) {
    const pkg = join(dir, "node_modules", "@intentius", "chant");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@intentius/chant", version: chantVersion, main: "index.js", bin: { chant: "bin/chant" } }),
    );
    writeFileSync(join(pkg, "index.js"), "module.exports = {};\n");
    writeFileSync(join(pkg, "bin", "chant"), "#!/usr/bin/env node\n");
  }
  return dir;
}

function appFor(dir: string) {
  const broadcaster = new Broadcaster();
  const events: Array<{ type: string; data: string }> = [];
  broadcaster.subscribe((type, data) => events.push({ type, data }));
  const runner = new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} });
  return { app: createApp({ projectDir: dir, port: 0 }, broadcaster, new FrameBuffer(), runner), events, runner };
}

const spawned = vi.mocked(spawnMock);
/** The argv of every chant invocation this test made. */
const calls = (): string[][] => spawned.mock.calls.map((c) => c[1] as string[]);

let withLoop: string;
let noLoop: string;
/** A loop whose project resolves a chant older than `operator log` (chant#2029). */
let oldChant: string;
beforeAll(() => {
  withLoop = project(["staging-converge", "prod-apply"], "0.53.1");
  noLoop = project(["prod-apply"]);
  oldChant = project(["staging-converge"], "0.52.2");
});
afterAll(() => {
  for (const dir of [withLoop, noLoop, oldChant]) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => spawned.mockReset());

describe("GET /api/operator/status (#234 join 3)", () => {
  it("never shells chant at a project that declares no ConvergeOp", async () => {
    const { app } = appFor(noLoop);
    const res = await app.request("/api/operator/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { operator: OperatorState };
    expect(body.operator.code).toBe("no-operator");
    expect(body.operator.declared).toEqual([]);
    // The whole point of gating on the declaration: no subprocess at all.
    expect(spawned).not.toHaveBeenCalled();
  });

  it("reads the loop's last tick, lease and pending gates through chant", async () => {
    spawned.mockImplementation(() => fakeProc(0, statusJson));
    const { app } = appFor(withLoop);
    const res = await app.request("/api/operator/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { operator: OperatorState };

    expect(calls()).toEqual([["operator", "status", "--json"]]);
    expect(body.operator.declared).toEqual([{ name: "staging-converge", env: "staging", dial: "apply" }]);
    expect(body.operator.strip?.rows).toHaveLength(1);
    expect(body.operator.strip?.rows[0]).toMatchObject({
      op: "staging-converge",
      env: "staging",
      log: "converge(staging): drifted=1 remediated=0 reported=0 skipped-budget=0 skipped-flap=0 gated=1 unobserved=0 adopted=0",
      at: "2026-01-01T00:00:00.000Z",
      pendingGates: 1,
    });
    expect(body.operator.gates).toHaveLength(1);
    expect(body.operator.gates[0]).toMatchObject({
      loop: "converge",
      rule: "drift-apply",
      op: "fountain-apply",
      gate: "rollout-gate",
      approve: { method: "POST", path: "/api/operator/approve/fountain-apply/rollout-gate" },
    });
  });

  it("carries the tick's id and its per-component verdicts through to the client (chant#2027)", async () => {
    spawned.mockImplementation(() => fakeProc(0, verdictsJson));
    const { app, runner } = appFor(withLoop);
    const body = (await (await app.request("/api/operator/status")).json()) as { operator: OperatorState };

    expect(body.operator.strip?.rows[0].tickId).toBe("9f1c7a52-3b64-4d0e-8a71-2e5c6d90b4af");
    expect(body.operator.verdicts).toEqual([
      {
        op: "staging-converge",
        env: "staging",
        at: "2026-01-01T00:00:00.000Z",
        tickId: "9f1c7a52-3b64-4d0e-8a71-2e5c6d90b4af",
        verdicts: [
          { component: "api", reconciliation: "drifted", detail: "live digest differs", live: true },
          { component: "worker", reconciliation: "unknown", detail: "unreadable", unobserved: { reason: "no-credentials" } },
        ],
      },
    ]);
    // This state is exactly what the component-DAG graph route reads to join
    // the verdicts onto the picked env's nodes — no second subprocess.
    expect(runner.operatorState.verdicts).toEqual(body.operator.verdicts);
  });

  it("holds no verdicts and no tick id for a pre-0.53.1 chant", async () => {
    spawned.mockImplementation(() => fakeProc(0, statusJson));
    const { app } = appFor(withLoop);
    const body = (await (await app.request("/api/operator/status")).json()) as { operator: OperatorState };
    expect(body.operator.verdicts).toEqual([]);
    expect(body.operator.strip?.rows[0].tickId).toBeNull();
  });

  it("carries the pending gate's approval address to the card (chant#2028)", async () => {
    spawned.mockImplementation(() => fakeProc(0, gateUrlJson));
    const { app } = appFor(withLoop);
    const body = (await (await app.request("/api/operator/status")).json()) as { operator: OperatorState };
    expect(body.operator.gates[0].url).toBe("https://github.com/INTENTIUS/chant/pull/2028");
  });

  it("422s a chant with no `operator status`, keeping the declaration", async () => {
    spawned.mockReturnValue(fakeProc(1, "", "error: Unknown command: operator\n"));
    const { app } = appFor(withLoop);
    const res = await app.request("/api/operator/status");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; operator: OperatorState };
    expect(body.code).toBe("no-operator-cli");
    // The strip must still render, saying why it is empty — a declared loop
    // that vanishes reads as "there is no loop", which is a different claim.
    expect(body.operator.declared).toHaveLength(1);
    expect(body.operator.strip).toBeNull();
    expect(body.operator.note).toMatch(/Unknown command/);
  });

  it("422s an answer it can't read rather than rendering an empty strip", async () => {
    spawned.mockReturnValue(fakeProc(0, "chant operator status: 1 loop\n"));
    const { app } = appFor(withLoop);
    const res = await app.request("/api/operator/status");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("operator-status");
  });

  it("broadcasts only a CHANGED answer, so the poll can't chase its own repaint", async () => {
    // A fresh fake per spawn: one emitter can only fire its `close` once, and
    // this suite asks twice.
    spawned.mockImplementation(() => fakeProc(0, statusJson));
    const { app, events } = appFor(withLoop);
    await app.request("/api/operator/status");
    const after = events.filter((e) => e.type === "operator").length;
    expect(after).toBeGreaterThan(0);
    await app.request("/api/operator/status");
    expect(events.filter((e) => e.type === "operator")).toHaveLength(after);
  });
});

describe("GET /api/operator/log (#234, chant#2029)", () => {
  it("asks for a BOUNDED window and answers with the timeline", async () => {
    spawned.mockImplementation(() => fakeProc(0, timelineJson));
    const { app } = appFor(withLoop);
    const res = await app.request("/api/operator/log");
    expect(res.status).toBe(200);
    const { history } = (await res.json()) as { history: OperatorHistory };

    // Never the whole ledger: `--limit` is on every invocation behold makes.
    expect(calls()).toEqual([["operator", "log", "--json", "--limit", "50"]]);
    expect(history.window).toEqual({ limit: 50, since: null });
    expect(history.entries.map((e) => e.kind)).toEqual(["tick", "gate-resolution", "tick"]);
    expect(history.malformed).toEqual({ converge: 0, gates: 0 });
    expect(history.more).toBe(false);
  });

  it("passes a caller's window through, clamped to behold's ceiling", async () => {
    spawned.mockImplementation(() => fakeProc(0, timelineJson));
    const { app } = appFor(withLoop);
    const res = await app.request("/api/operator/log?limit=9999&since=2026-01-02T00:00:00.000Z");
    const { history } = (await res.json()) as { history: OperatorHistory };
    expect(calls()).toEqual([["operator", "log", "--json", "--limit", "200", "--since", "2026-01-02T00:00:00.000Z"]]);
    // The clamp is reported, not silent — a full window would otherwise read as
    // the end of history.
    expect(history.window).toEqual({ limit: 200, since: "2026-01-02T00:00:00.000Z" });
  });

  it("400s a window chant itself would refuse, without spawning anything", async () => {
    const { app } = appFor(withLoop);
    for (const q of ["?limit=0", "?limit=1.5", "?since=last%20tuesday"]) {
      const res = await app.request(`/api/operator/log${q}`);
      expect(res.status).toBe(400);
    }
    expect(spawned).not.toHaveBeenCalled();
  });

  it("refuses a chant too old for `operator log` BEFORE spawning it", async () => {
    // The load-bearing one. chant's `resolveCommand` falls back from the
    // compound "operator log" to the simple "operator", so on an older chant
    // this invocation is the TICK DAEMON — which never returns and, at a dial of
    // apply, dispatches remediation. behold reading a history must never become
    // behold running an operator.
    const { app } = appFor(oldChant);
    const res = await app.request("/api/operator/log");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string; history: null };
    expect(body.code).toBe("no-operator-log-cli");
    expect(body.error).toMatch(/0\.52\.2/);
    expect(body.history).toBeNull();
    expect(spawned).not.toHaveBeenCalled();
  });

  it("never shells chant at a project that declares no ConvergeOp", async () => {
    const { app } = appFor(noLoop);
    const res = await app.request("/api/operator/log");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { code: string }).code).toBe("no-operator");
    expect(spawned).not.toHaveBeenCalled();
  });

  it("422s an answer it can't read rather than rendering an empty timeline", async () => {
    spawned.mockReturnValue(fakeProc(0, "chant operator log: 3 ticks\n"));
    const { app } = appFor(withLoop);
    const res = await app.request("/api/operator/log");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("operator-log");
  });

  it("surfaces the unreadable-line count instead of a silently short timeline", async () => {
    const parsed = JSON.parse(timelineJson) as { malformed: unknown };
    parsed.malformed = { converge: 3, gates: 1 };
    spawned.mockImplementation(() => fakeProc(0, JSON.stringify(parsed)));
    const { app } = appFor(withLoop);
    const { history } = (await (await app.request("/api/operator/log")).json()) as { history: OperatorHistory };
    expect(history.malformed).toEqual({ converge: 3, gates: 1 });
  });

  it("broadcasts nothing — the history is pulled by whoever opened it", async () => {
    // The strip is pushed because it is on screen and goes stale by itself. A
    // timeline event would make every other client repaint a panel none of them
    // asked for, and would turn a pull-on-demand read into a poll by proxy.
    spawned.mockImplementation(() => fakeProc(0, timelineJson));
    const { app, events } = appFor(withLoop);
    await app.request("/api/operator/log");
    expect(events.filter((e) => e.type === "operator")).toHaveLength(0);
  });
});

describe("POST /api/operator/approve/:op/:gate (#234 join 1)", () => {
  it("delegates `chant approve <op> <gate>` and answers with the recorded-fact semantics", async () => {
    spawned.mockReturnValue(fakeProc(0, "", "Gate \"rollout-gate\" on \"fountain-apply\" resolved by alex\n"));
    const { app, events } = appFor(withLoop);
    const res = await app.request("/api/operator/approve/fountain-apply/rollout-gate", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recorded: boolean; semantics: string };

    expect(calls()).toEqual([["approve", "fountain-apply", "rollout-gate"]]);
    expect(body.recorded).toBe(true);
    // chant's own gate-ledger doc: this writes a fact and "is not itself the
    // unblock". The response says so, and the card renders it.
    expect(body.semantics).toMatch(/records a fact/);
    expect(body.semantics).toMatch(/does not unblock the dispatch/);
    expect(body.semantics).toMatch(/next tick/);
    // …and the now-line narrates it the same way, so the log doesn't imply a
    // release the click never performed.
    expect(events.find((e) => e.type === "op")?.data).toMatch(/records a fact; the next tick acts on it/);
  });

  it("is NOT the run-gate signal — different command, different route", async () => {
    spawned.mockReturnValue(fakeProc(0, ""));
    const { app } = appFor(withLoop);
    await app.request("/api/operator/approve/fountain-apply/rollout-gate", { method: "POST" });
    // `chant run signal … --temporal` releases a waiting workflow; `chant
    // approve` records a fact. Confusing the two is exactly what #234's
    // inventory says the issue text did.
    expect(calls()[0]).not.toContain("signal");
    expect(calls()[0]).not.toContain("--temporal");
  });

  it("500s with chant's own message when the write fails", async () => {
    spawned.mockReturnValue(fakeProc(1, "", "error: could not write to chant/lifecycle\n"));
    const { app } = appFor(withLoop);
    const res = await app.request("/api/operator/approve/fountain-apply/rollout-gate", { method: "POST" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/could not write to chant\/lifecycle/);
  });
});

describe("GET /api/graph?ops=1 carries the operator strip's declaration (#234 join 3)", () => {
  it("reports the declared ConvergeOps without shelling anything", async () => {
    const { app } = appFor(withLoop);
    const res = await app.request("/api/graph?ops=1");
    expect(res.status).toBe(200);
    const meta = ((await res.json()) as { meta: { operator: OperatorState; note: string } }).meta;
    expect(meta.operator.declared).toEqual([{ name: "staging-converge", env: "staging", dial: "apply" }]);
    expect(meta.operator.strip).toBeNull();
    expect(meta.note).toMatch(/Operating loop: 1 ConvergeOp declared — not read yet/);
    // The lens's promise: no chant subprocess on this branch.
    expect(spawned).not.toHaveBeenCalled();
  });

  it("says there is no strip for a project that declares no loop", async () => {
    const { app } = appFor(noLoop);
    const meta = ((await (await app.request("/api/graph?ops=1")).json()) as { meta: { note: string; operator: OperatorState } }).meta;
    expect(meta.operator.declared).toEqual([]);
    expect(meta.note).toMatch(/declares no ConvergeOp/);
  });
});
