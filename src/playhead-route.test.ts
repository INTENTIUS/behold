import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphIR } from "@intentius/chant";

// The HTTP half of the run playhead (#284 item 2). src/run-playhead.test.ts
// covers the parsing/join/paint against chant's real record shapes; this proves
// they reach a client through the routes that already exist — the ops lens's
// own `/api/graph?ops=1`, and a gate read beside the `chant run signal` behold
// already shells — and, just as much, that the refusal paths say so plainly.
//
// chant is stubbed at the one seam behold shells it through (src/chant.ts), so
// no Temporal server and no worker are needed: `runChantStream` feeds the
// process's stdout line by line, `runChantRaw` answers `chant run status`.
let resolveDone: (code: number) => void;
let lastOnLine: ((line: string) => void) | undefined;
let rawReply: { code: number; stdout: string; stderr: string } = { code: 0, stdout: "", stderr: "" };
let lastRawArgs: string[] = [];

vi.mock("./chant.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chant.ts")>();
  return {
    ...actual,
    runChantStream: (_args: string[], _cwd: string, onLine: (line: string) => void) => {
      lastOnLine = onLine;
      return { pid: 1, kill: vi.fn(), done: new Promise<number>((res) => { resolveDone = res; }) };
    },
    runChantRaw: (args: string[]) => {
      lastRawArgs = args;
      return Promise.resolve(rawReply);
    },
  };
});

const { createApp } = await import("./server.ts");
const { Broadcaster } = await import("./events.ts");
const { FrameBuffer } = await import("./frames.ts");
const { OpRunner } = await import("./op-runner.ts");

const HERE = dirname(fileURLToPath(import.meta.url));
const OPS_FIXTURES = join(HERE, "__fixtures__", "ops-example-writes");
const RUN_FIXTURES = join(HERE, "__fixtures__", "ops-playhead");

const streamLines = readFileSync(join(RUN_FIXTURES, "playhead-probe.progress.ndjson"), "utf8").trim().split("\n");

/** A built project carrying the probe Op (the one with a real record stream)
 * and prod-promote (the one with a gate), laid out where chant writes them. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-playhead-"));
  writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["aws", "temporal"] };\n');
  mkdirSync(join(dir, "dist", "ops", "playhead-probe"), { recursive: true });
  cpSync(join(RUN_FIXTURES, "playhead-probe.op.json"), join(dir, "dist", "ops", "playhead-probe", "op.json"));
  mkdirSync(join(dir, "dist", "ops", "prod-promote"), { recursive: true });
  cpSync(join(OPS_FIXTURES, "prod-promote.op.json"), join(dir, "dist", "ops", "prod-promote", "op.json"));
  return dir;
}

let dir: string;
beforeAll(() => {
  dir = project();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function harness() {
  const broadcaster = new Broadcaster();
  const runner = new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} });
  const app = createApp({ projectDir: dir, port: 0 }, broadcaster, new FrameBuffer(), runner);
  return { app, runner, broadcaster };
}

type OpsBody = {
  ir: GraphIR;
  meta: { note: string; run: { status: string; op: string | null; records: unknown[] }; gate: Record<string, unknown> | null };
};
const attrsOf = (body: OpsBody, id: string) => body.ir.nodes.find((n) => n.id === id)?.attrs ?? {};

beforeEach(() => {
  lastOnLine = undefined;
  lastRawArgs = [];
  rawReply = { code: 0, stdout: "", stderr: "" };
});

describe("GET /api/graph?ops=1 — run state is additive paint (#284 item 2)", () => {
  it("renders the declared track unchanged when nothing has run", async () => {
    const { app } = harness();
    const body = (await (await app.request("/api/graph?ops=1")).json()) as OpsBody;
    // Item 1's picture, byte for byte: no step claims to have run.
    expect(body.ir.nodes.every((n) => n.attrs.run === undefined && n.attrs._playhead === undefined)).toBe(true);
    expect(body.ir.nodes.find((n) => n.id === "playhead-probe/Build/chantBuild")?.attrs._status).toBe("neutral");
    expect(body.meta.run.status).toBe("idle");
    expect(body.meta.gate).toBeNull();
    expect(body.meta.note).toContain("No estate cross-links"); // item 1's note survives
    expect(body.meta.note).toContain("No run state");
  });

  it("paints a real streamed run over the same track", async () => {
    const { app, runner } = harness();
    runner.trigger("playhead-probe", undefined, dir, true);
    for (const line of streamLines) lastOnLine!(line);

    const body = (await (await app.request("/api/graph?ops=1")).json()) as OpsBody;
    expect(attrsOf(body, "playhead-probe/Build/chantBuild")).toMatchObject({ _status: "good", run: "ok · 1.0s" });
    expect(attrsOf(body, "playhead-probe/Deploy/shellCmd#2")).toMatchObject({ _status: "good" });
    expect(attrsOf(body, "playhead-probe/Verify/httpCheck")).toMatchObject({ _status: "warn" });
    // The phase the run never reached is left exactly as declared.
    expect(attrsOf(body, "playhead-probe/Never/httpCheck")).toMatchObject({ _status: "neutral" });
    expect(attrsOf(body, "playhead-probe/Never/httpCheck").run).toBeUndefined();
    // A second Op's track is untouched — the playhead is one run, not a mood.
    expect(attrsOf(body, "prod-promote/Plan/lifecycleDiff")._status).toBe("neutral");
    expect(body.meta.run.status).toBe("running");
    expect(body.meta.note).toContain("7 steps settled");
  });

  it("a dead stream freezes the playhead and says so — it never reads as completion", async () => {
    const { app, runner } = harness();
    runner.trigger("playhead-probe", undefined, dir, true);
    for (const line of streamLines.slice(0, 3)) lastOnLine!(line);
    resolveDone(137);
    await Promise.resolve();

    const body = (await (await app.request("/api/graph?ops=1")).json()) as OpsBody;
    expect(body.meta.run.status).toBe("lost");
    expect(body.meta.note).toContain("stream lost");
    expect(body.meta.note).not.toMatch(/complete|finished/i);
    // Frozen where the records stopped: Deploy settled, Fanout is the playhead.
    expect(attrsOf(body, "playhead-probe/Deploy/shellCmd#2")._status).toBe("good");
    expect(attrsOf(body, "playhead-probe/Fanout/shellCmd")).toMatchObject({
      _status: "accent",
      _playhead: true,
      run: "reached — not settled yet",
    });
    expect(attrsOf(body, "playhead-probe/Verify/httpCheck")._status).toBe("neutral");
  });
});

describe("GET /api/ops/:name/status — the gateState read", () => {
  it("shells `chant run status <name> --temporal` and reads the pending gate", async () => {
    const { app } = harness();
    rawReply = { code: 0, stdout: readFileSync(join(RUN_FIXTURES, "run-status-gate-pending.txt"), "utf8"), stderr: "" };
    const res = await app.request("/api/ops/prod-promote/status");
    expect(res.status).toBe(200);
    expect(lastRawArgs).toEqual(["run", "status", "prod-promote", "--temporal"]);
    const body = (await res.json()) as { gate: { signalName: string; since: string }; status: string };
    expect(body.status).toBe("RUNNING");
    expect(body.gate).toMatchObject({ signalName: "approve-promote", since: "2026-08-29T18:00:12.000Z" });
  });

  it("renders the pending gate as a card, with approve delegated to the EXISTING op-signal route", async () => {
    const { app } = harness();
    rawReply = { code: 0, stdout: readFileSync(join(RUN_FIXTURES, "run-status-gate-pending.txt"), "utf8"), stderr: "" };
    await app.request("/api/ops/prod-promote/status");

    const body = (await (await app.request("/api/graph?ops=1")).json()) as OpsBody;
    expect(body.meta.gate).toMatchObject({
      op: "prod-promote",
      signalName: "approve-promote",
      description: "Approve the prod promotion",
      since: "2026-08-29T18:00:12.000Z",
      node: "prod-promote/Approve/gate:approve-promote",
      guards: "awsApply",
      approve: { method: "POST", path: "/api/ops/prod-promote/signal/approve-promote" },
    });
    // The card's approve path is a route that exists and is the one the current
    // gate button already uses — behold signals nothing on its own initiative.
    expect(String((body.meta.gate as { approve: { path: string } }).approve.path)).toBe(
      "/api/ops/prod-promote/signal/approve-promote",
    );
    // And the gate's card in the track is where the playhead sits.
    expect(attrsOf(body, "prod-promote/Approve/gate:approve-promote")).toMatchObject({
      _status: "warn",
      _playhead: true,
    });
    expect(body.meta.note).toContain("behold never signals on its own");
  });

  it("says so plainly when the project isn't on the durable path", async () => {
    const { app } = harness();
    rawReply = { code: 1, stdout: "", stderr: readFileSync(join(RUN_FIXTURES, "run-status-local-mode.txt"), "utf8") };
    const res = await app.request("/api/ops/floci-apply/status");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string; remedy: string };
    expect(body.code).toBe("no-temporal");
    expect(body.error).toContain("not available in local mode");
    expect(body.remedy).toContain("--temporal");
  });

  it("says so plainly when there is no run — absence of a signal is never progress", async () => {
    const { app } = harness();
    rawReply = { code: 1, stdout: "", stderr: "error: workflow not found for workflowId: chant-op-prod-promote" };
    const res = await app.request("/api/ops/prod-promote/status");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; runState: { gate: unknown; gateNote: string } };
    expect(body.code).toBe("no-run");
    expect(body.runState.gate).toBeNull();
    expect(body.runState.gateNote).toContain("No run of");

    // ...and the graph states it rather than drawing an ungated track.
    const graph = (await (await app.request("/api/graph?ops=1")).json()) as OpsBody;
    expect(graph.meta.gate).toBeNull();
    expect(graph.meta.note).toContain("gate state unavailable");
  });

  it("a `no gate pending` answer is distinct from a refusal", async () => {
    const { app, runner } = harness();
    rawReply = { code: 0, stdout: readFileSync(join(RUN_FIXTURES, "run-status-no-gate.txt"), "utf8"), stderr: "" };
    const res = await app.request("/api/ops/prod-promote/status");
    expect(res.status).toBe(200);
    expect(runner.runState.gate).toBeNull();
    expect(runner.runState.gateNote).toBeNull();
  });
});

describe("GET /api/ops — hydrating a client that arrives mid-run", () => {
  it("carries the playhead so a reload doesn't start blank", async () => {
    const { app, runner } = harness();
    runner.trigger("playhead-probe", undefined, dir, true);
    for (const line of streamLines.slice(0, 2)) lastOnLine!(line);

    const body = (await (await app.request("/api/ops")).json()) as {
      runState: { op: string; status: string; records: unknown[] };
    };
    expect(body.runState).toMatchObject({ op: "playhead-probe", status: "running" });
    expect(body.runState.records).toHaveLength(2);
  });
});
