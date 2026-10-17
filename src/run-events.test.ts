// #679: chant's run-event stream, fed to behold as recorded.
//
// The fixtures in __fixtures__/run-events/ are real streams:
//  - gated-probe.gated.events.ndjson: `chant run gated-probe --events-json`
//    (gated-probe.op.ts.txt), stopped at its gate, exit 3.
//  - gated-probe.approved.events.ndjson: the same Op after `chant approve
//    gated-probe approve-probe`, run again: the gate resolves and it settles ok.
//  - fail-probe.events.ndjson: `chant run fail-probe --events-json`
//    (fail-probe.op.ts.txt), a step that exits 7 between two that pass.
// All three were recorded from chant main (54a030213's emitters, af9e261ad)
// in a throwaway git repository; that build reports itself as 0.124.27, the
// version before the release that ships the stream.
//  - components-gated.events.ndjson: a component run (skipped with a receipt,
//    a cache hit, a gate, a step not run) written through chant's own writer,
//    `createRunEventWriter` from packages/core/src/run-event.ts, since a real
//    component run deploys.
// The op.json files are the two Ops' compiled shape, written by hand from the
// .op.ts sources in the layout chant writes.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "./run-event-schema/run-event.schema.json" with { type: "json" };
import { readRunLine, foldRunEvents, foldRunEvent, initialFold, runEventLine, legacyRunLine, RUN_EVENT_SCHEMA_ID, RUN_EVENT_SCHEMA_SOURCE, type RunEventLine } from "./run-events.ts";
import { applyProgressOf, applyEnded } from "./apply.ts";
import { joinRun, paintPlayhead, playheadNote, runFromFold, runStarted, runEnded, type RunState } from "./run-playhead.ts";
import { opsToIr, readOpIr, type OpIr } from "./ops-lens.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "__fixtures__", "run-events");
const lines = (name: string): string[] => readFileSync(join(FIX, name), "utf8").trim().split("\n");
const events = (name: string): RunEventLine[] =>
  lines(name).map((l) => {
    const r = readRunLine(l);
    if (r?.kind !== "event") throw new Error(`not an event: ${l}`);
    return r.event;
  });
const op = (name: string): OpIr => {
  const r = readOpIr(join(FIX, name), (p) => readFileSync(p, "utf8"));
  if (!r.ok) throw new Error("fixture op.json did not parse");
  return r.ir;
};

describe("the vendored schema", () => {
  it("is chant's run-event schema, contract 1, with its source named", () => {
    expect(schema.$id).toBe(RUN_EVENT_SCHEMA_ID);
    expect(RUN_EVENT_SCHEMA_ID).toBe("https://intentius.io/chant/schemas/workspace/run-event/v1/run-event.schema.json");
    expect(RUN_EVENT_SCHEMA_SOURCE.release).toBe("0.124.28");
  });

  it("every recorded line validates against it", () => {
    const validate = new Ajv2020({ strict: false }).compile(schema as object);
    for (const f of ["gated-probe.gated.events.ndjson", "gated-probe.approved.events.ndjson", "fail-probe.events.ndjson", "components-gated.events.ndjson"]) {
      for (const l of lines(f)) expect(validate(JSON.parse(l)), `${f}: ${l.slice(0, 80)}`).toBe(true);
    }
  });
});

describe("readRunLine", () => {
  it("reads a run event, and leaves a log line alone", () => {
    expect(readRunLine(lines("fail-probe.events.ndjson")[0])?.kind).toBe("event");
    expect(readRunLine('Op "fail-probe" failed after 0.1s')).toBeNull();
    expect(readRunLine("{not json")).toBeNull();
    expect(readRunLine('{"hello":"world"}')).toBeNull();
  });

  it("refuses a line that names the schema and fails it, rather than folding half of it", () => {
    const good = JSON.parse(lines("fail-probe.events.ndjson")[2]);
    const r = readRunLine(JSON.stringify({ ...good, status: "exploded", type: "step-settle" }));
    expect(r?.kind).toBe("refused");
    const other = readRunLine(JSON.stringify({ ...good, contract: 2 }));
    expect(other).toEqual({ kind: "refused", reason: expect.stringContaining("contract 2") });
  });

  it("translates the older --progress-json lines in degraded mode", () => {
    expect(readRunLine('{"type":"step","component":"db","phase":"Apply","step":"cfn","status":"running"}')).toEqual({
      kind: "legacy",
      events: [{ type: "step-start", component: "db", phase: "Apply", step: "cfn" }],
    });
    expect(readRunLine('{"phase":"Deploy","fn":"shellCmd","status":"fail","durationMs":5,"error":"exit 7"}')).toEqual({
      kind: "legacy",
      events: [{ type: "step-settle", component: null, phase: "Deploy", step: "shellCmd", status: "failed", durationMs: 5, error: "exit 7" }],
    });
    expect(legacyRunLine({ op: "x", records: [{ phase: "P", fn: "f", status: "skipped", durationMs: 0 }] })).toEqual([
      { type: "step-settle", component: null, phase: "P", step: "f", status: "skipped", skip: null, durationMs: 0 },
    ]);
    expect(legacyRunLine({ type: "run-done", status: "ok" })).toEqual([{ type: "run-settle", status: "ok", durationMs: null }]);
  });
});

describe("an Op run, rendered from its recorded stream", () => {
  it("shows a step running between its start and its settle", () => {
    const all = events("fail-probe.events.ndjson");
    const mid = foldRunEvents(all.slice(0, 3)); // run-start, phase-start, step-start
    expect(mid.status).toBe("running");
    expect(mid.steps).toEqual([{ component: null, phase: "Build", step: "shellCmd", index: 0, state: "running", startedAt: all[2].at }]);

    const join = joinRun(op("fail-probe.op.json"), mid.steps, null);
    expect(join.at).toBe("fail-probe/Build/shellCmd");
    expect(join.atReason).toBe(`running since ${String(all[2].at)}`);
    expect(join.byNode.size).toBe(0);
  });

  it("settles each step in place, and the run's verdict is run-settle's", () => {
    const fold = foldRunEvents(events("fail-probe.events.ndjson"));
    expect(fold.settled).toBe(true);
    expect(fold.status).toBe("failed");
    expect(fold.error).toMatch(/exited 7/);
    expect(fold.steps.map((s) => `${s.phase}/${s.index}:${s.state}`)).toEqual(["Build/0:ok", "Build/1:ok", "Deploy/0:failed"]);
    expect(fold.runId).toMatch(/^local-/);
    expect(fold.runtime).toBe("local");
    expect(fold.missed).toBe(0);

    const ir = opsToIr([op("fail-probe.op.json")]);
    const join = joinRun(op("fail-probe.op.json"), fold.steps, null, { guessNext: false });
    expect(join.at).toBeNull();
    const painted = paintPlayhead(ir, join, null);
    const attrs = (id: string) => painted.nodes.find((n) => n.id === id)?.attrs ?? {};
    expect(attrs("fail-probe/Build/shellCmd")._status).toBe("good");
    expect(attrs("fail-probe/Build/shellCmd#2")._status).toBe("good");
    expect(attrs("fail-probe/Deploy/shellCmd")).toMatchObject({ _status: "warn", error: expect.stringContaining("exited 7") });
    // The phase the run never reached stays as declared.
    expect(attrs("fail-probe/Verify/shellCmd").run).toBeUndefined();
  });

  it("a gated run names its gate from gate-waiting, with no status read", () => {
    const fold = foldRunEvents(events("gated-probe.gated.events.ndjson"));
    expect(fold.status).toBe("gated");
    expect(fold.waitingOn).toMatchObject({ op: "gated-probe", gate: "approve-probe", point: null, phase: "Approve" });
    expect(fold.steps.at(-1)).toMatchObject({ step: "gate:approve-probe", state: "gated", durationMs: 680 });

    const state = runFromFold(runStarted("gated-probe", "local", "t0"), fold);
    expect(state.status).toBe("gated");
    expect(state.gate).toEqual({ signalName: "approve-probe", since: fold.waitingOn!.since });
    const join = joinRun(op("gated-probe.op.json"), state.steps, state.gate);
    expect(join.at).toBe("gated-probe/Approve/gate:approve-probe");
    expect(join.atReason).toContain("waiting for approve-probe");
    const painted = paintPlayhead(opsToIr([op("gated-probe.op.json")]), join, state.gate);
    expect(painted.nodes.find((n) => n.id === join.at)?.attrs).toMatchObject({ _status: "warn", _playhead: true });
  });

  it("an approved gate resolves, names who approved it, and the run settles ok", () => {
    const fold = foldRunEvents(events("gated-probe.approved.events.ndjson"));
    expect(fold.status).toBe("ok");
    expect(fold.waitingOn).toBeNull();
    expect(fold.steps.find((s) => s.step === "gate:approve-probe")).toMatchObject({ state: "ok", approvedBy: "alex" });
    const state = runFromFold(runStarted("gated-probe", "local", "t0"), fold);
    expect(state.gate).toBeNull();
    const join = joinRun(op("gated-probe.op.json"), state.steps, null);
    expect(join.byNode.get("gated-probe/Approve/gate:approve-probe")).toMatchObject({ status: "ok", approvedBy: "alex" });
    expect(playheadNote(state, join)).toContain("3 steps settled");
    expect(playheadNote(state, join)).toContain("the run settled ok");
  });

  it("a process that ends without run-settle is lost, never finished", () => {
    const all = events("fail-probe.events.ndjson");
    const fold = foldRunEvents(all.slice(0, 6)); // through Build's second settle
    let state: RunState = runFromFold(runStarted("fail-probe", "local", "t0"), fold);
    state = runEnded(state, 137, "t1", fold.settled);
    expect(state.status).toBe("lost");
    expect(state.lost).toContain("without run-settle");
    expect(state.steps.filter((s) => s.state === "ok")).toHaveLength(2);
  });

  it("re-says each event on the now-line", () => {
    const said = events("fail-probe.events.ndjson").map(runEventLine).filter(Boolean);
    expect(said).toContain("▶ Build · shellCmd");
    expect(said.some((l) => /^✗ Deploy · shellCmd: failed \(\d+ms\): command exited 7/.test(l!))).toBe(true);
    expect(said.at(-1)).toMatch(/^■ run failed/);
  });

  it("says when the sequence skipped events", () => {
    const all = events("fail-probe.events.ndjson");
    const fold = foldRunEvents([all[0], all[1], all[4]]);
    expect(fold.missed).toBe(2);
  });
});

describe("a component run, rendered from its stream", () => {
  const all = events("components-gated.events.ndjson");

  it("shows skipped with its reason, cached, gated and not-run on the dial", () => {
    const p = applyProgressOf(foldRunEvents(all), "events");
    expect(p.status).toBe("gated");
    expect(p.source).toBe("events");
    expect(p.waves.map((w) => w.status)).toEqual(["ok", "gated"]);
    const sf = p.components.find((c) => c.component === "shared-foundation")!;
    expect(sf.steps!.map((s) => `${s.step}:${s.state}:${s.skip ?? ""}`)).toEqual(["cfn-deploy:skipped:receipt", "cfn-outputs:cached:"]);
    const db = p.components.find((c) => c.component === "loom-db")!;
    expect(db.status).toBe("gated");
    expect(db.steps!.map((s) => `${s.step}:${s.state}:${s.skip ?? ""}`)).toEqual(["gate:approve-db:gated:", "cfn-deploy:skipped:not-run"]);
    expect(p.waitingOn).toMatchObject({ gate: "approve-db", component: "loom-db" });
  });

  it("moves as each event arrives: a component's step is running before it settles", () => {
    let fold = initialFold;
    const seen: string[] = [];
    for (const e of all) {
      fold = foldRunEvent(fold, e);
      const c = applyProgressOf(fold, "events").components.find((x) => x.component === "loom-cognito");
      if (c?.stepState) seen.push(`${c.status}/${c.stepState}`);
    }
    expect(seen[0]).toBe("running/running");
    expect(seen).toContain("running/ok");
    expect(seen.at(-1)).toBe("ok/ok");
  });

  it("a stream cut before run-settle leaves the dial lost; degraded mode reads the exit code", () => {
    const cut = applyProgressOf(foldRunEvents(all.slice(0, 10)), "events");
    expect(applyEnded(cut, false, 137)).toMatchObject({ status: "lost", lost: expect.stringContaining("without run-settle") });
    const old = applyProgressOf(foldRunEvents(all.slice(0, 10)), "progress");
    expect(applyEnded(old, false, 0).status).toBe("ok");
    expect(applyEnded(old, false, 1).status).toBe("failed");
  });
});
