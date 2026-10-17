import { describe, it, expect } from "vitest";
import { applyProgressOf, initialApplyProgress, type ApplyProgressState } from "./apply.ts";
import { readRunLine, foldRunEvent, initialFold, type RunEventFold } from "./run-events.ts";

// Degraded mode (#679): a chant below 0.124.28 streams the older
// `--progress-json` lines, which src/run-events.ts translates into run events
// at the boundary. These transcripts are that older shape, so this file proves
// the degraded path still renders the dial the way it always did. The run-event
// path itself is src/run-events.test.ts, fed recorded streams.
type LegacyLine = Record<string, unknown>;

describe("readRunLine on the older stream", () => {
  it("translates a well-formed progress line", () => {
    expect(readRunLine('{"type":"run-start","waves":[["a"]]}')).toEqual({ kind: "legacy", events: [{ type: "run-start", waves: [["a"]] }] });
    expect(readRunLine('{"type":"run-done","status":"ok"}')).toEqual({ kind: "legacy", events: [{ type: "run-settle", status: "ok", durationMs: null }] });
  });

  it("returns null for non-JSON: chant's human summary, warnings, blank-ish lines", () => {
    expect(readRunLine("Spawning worker for component...")).toBeNull();
    expect(readRunLine("✓ Component \"svc\" completed successfully.")).toBeNull();
    expect(readRunLine("")).toBeNull();
  });

  it("returns null for JSON with no recognized `type`", () => {
    expect(readRunLine('{"hello":"world"}')).toBeNull();
    expect(readRunLine('{"type":"something-else"}')).toBeNull();
    expect(readRunLine("42")).toBeNull();
    expect(readRunLine("null")).toBeNull();
    expect(readRunLine('["a","b"]')).toBeNull();
  });

  it("never throws on garbage input", () => {
    expect(() => readRunLine("{not json")).not.toThrow();
    expect(readRunLine("{not json")).toBeNull();
  });
});

// A realistic transcript shaped like loomster's 4-wave graph (docs/roadmap/
// m1-cli-notes.md Q1): wave 1 = [loom-cognito, shared-foundation] (no deps),
// wave 2 = [loom-db] (depends on shared-foundation). Two components across two
// waves is enough to exercise wave/component sequencing without a huge fixture.
const CLEAN_RUN: LegacyLine[] = [
  { type: "run-start", waves: [["loom-cognito", "shared-foundation"], ["loom-db"]] },
  { type: "wave-start", wave: 1, components: ["loom-cognito", "shared-foundation"] },
  { type: "component-start", wave: 1, component: "loom-cognito" },
  { type: "component-start", wave: 1, component: "shared-foundation" },
  { type: "phase-start", component: "loom-cognito", phase: "Apply" },
  { type: "step", component: "loom-cognito", phase: "Apply", step: "cfn-deploy", status: "running" },
  { type: "step", component: "loom-cognito", phase: "Apply", step: "cfn-deploy", status: "ok" },
  { type: "phase-done", component: "loom-cognito", phase: "Apply", status: "ok" },
  { type: "component-done", wave: 1, component: "loom-cognito", status: "ok" },
  { type: "phase-start", component: "shared-foundation", phase: "Apply" },
  { type: "step", component: "shared-foundation", phase: "Apply", step: "cfn-deploy", status: "running" },
  { type: "step", component: "shared-foundation", phase: "Apply", step: "cfn-deploy", status: "ok" },
  { type: "phase-done", component: "shared-foundation", phase: "Apply", status: "ok" },
  { type: "component-done", wave: 1, component: "shared-foundation", status: "ok" },
  { type: "wave-done", wave: 1, status: "ok" },
  { type: "wave-start", wave: 2, components: ["loom-db"] },
  { type: "component-start", wave: 2, component: "loom-db" },
  { type: "phase-start", component: "loom-db", phase: "Apply" },
  { type: "step", component: "loom-db", phase: "Apply", step: "cfn-deploy", status: "running" },
  { type: "step", component: "loom-db", phase: "Apply", step: "cfn-deploy", status: "ok" },
  { type: "phase-done", component: "loom-db", phase: "Apply", status: "ok" },
  { type: "component-done", wave: 2, component: "loom-db", status: "ok" },
  { type: "wave-done", wave: 2, status: "ok" },
  { type: "run-done", status: "ok" },
];

// loom-db's stack is UPDATE_ROLLBACK_COMPLETE in the demo estate (M3 verify
// notes) — re-applying it fails at the cfn-deploy step. Same shape as
// CLEAN_RUN's wave 2, but the step reports failed with an error, and the run
// never reaches wave-done/run-done "ok".
const FAILED_RUN: LegacyLine[] = [
  { type: "run-start", waves: [["shared-foundation"], ["loom-db"]] },
  { type: "wave-start", wave: 1, components: ["shared-foundation"] },
  { type: "component-start", wave: 1, component: "shared-foundation" },
  { type: "phase-start", component: "shared-foundation", phase: "Apply" },
  { type: "step", component: "shared-foundation", phase: "Apply", step: "cfn-deploy", status: "running" },
  { type: "step", component: "shared-foundation", phase: "Apply", step: "cfn-deploy", status: "ok" },
  { type: "phase-done", component: "shared-foundation", phase: "Apply", status: "ok" },
  { type: "component-done", wave: 1, component: "shared-foundation", status: "ok" },
  { type: "wave-done", wave: 1, status: "ok" },
  { type: "wave-start", wave: 2, components: ["loom-db"] },
  { type: "component-start", wave: 2, component: "loom-db" },
  { type: "phase-start", component: "loom-db", phase: "Apply" },
  { type: "step", component: "loom-db", phase: "Apply", step: "cfn-deploy", status: "running" },
  {
    type: "step",
    component: "loom-db",
    phase: "Apply",
    step: "cfn-deploy",
    status: "failed",
    error: "stack loom-local-a-loom-db is in UPDATE_ROLLBACK_COMPLETE — cannot update",
  },
  { type: "phase-done", component: "loom-db", phase: "Apply", status: "failed" },
  { type: "component-done", wave: 2, component: "loom-db", status: "failed" },
  { type: "wave-done", wave: 2, status: "failed" },
  { type: "run-done", status: "failed" },
];

function foldLines(lines: LegacyLine[], from: RunEventFold = initialFold): RunEventFold {
  let fold = from;
  for (const l of lines) {
    const read = readRunLine(JSON.stringify(l));
    if (read?.kind !== "legacy") continue;
    for (const e of read.events) fold = foldRunEvent(fold, e);
  }
  return fold;
}
function replay(lines: LegacyLine[]): ApplyProgressState {
  return applyProgressOf(foldLines(lines), "progress");
}

describe("the dial's model, from the older stream", () => {
  it("starts idle", () => {
    expect(initialApplyProgress).toEqual({ status: "idle", waves: [], components: [] });
  });

  it("run-start seeds every wave/component as pending, in wave order", () => {
    const state = replay(CLEAN_RUN.slice(0, 1));
    expect(state.status).toBe("running");
    expect(state.source).toBe("progress");
    expect(state.waves).toEqual([
      { wave: 1, components: ["loom-cognito", "shared-foundation"], status: "pending" },
      { wave: 2, components: ["loom-db"], status: "pending" },
    ]);
    expect(state.components).toEqual([
      { component: "loom-cognito", wave: 1, status: "pending" },
      { component: "shared-foundation", wave: 1, status: "pending" },
      { component: "loom-db", wave: 2, status: "pending" },
    ]);
  });

  it("replays a full clean run to a terminal ok state, every wave/component ok", () => {
    const state = replay(CLEAN_RUN);
    expect(state.status).toBe("ok");
    expect(state.waves.map((w) => w.status)).toEqual(["ok", "ok"]);
    expect(state.components.map((c) => ({ component: c.component, status: c.status, phase: c.phase, step: c.step, stepState: c.stepState }))).toEqual([
      { component: "loom-cognito", status: "ok", phase: "Apply", step: "cfn-deploy", stepState: "ok" },
      { component: "shared-foundation", status: "ok", phase: "Apply", step: "cfn-deploy", stepState: "ok" },
      { component: "loom-db", status: "ok", phase: "Apply", step: "cfn-deploy", stepState: "ok" },
    ]);
  });

  it("tracks phase/step live as component-start/phase-start/step events arrive mid-run", () => {
    const state = replay(CLEAN_RUN.slice(0, 6)); // through the first "running" step event
    const cognito = state.components.find((c) => c.component === "loom-cognito")!;
    expect(cognito.status).toBe("running");
    expect(cognito.phase).toBe("Apply");
    expect(cognito.step).toBe("cfn-deploy");
    expect(cognito.stepState).toBe("running");
    const db = state.components.find((c) => c.component === "loom-db")!;
    expect(db.status).toBe("pending");
  });

  it("a failed step marks its component failed IMMEDIATELY, not silently green until component-done", () => {
    const state = replay(FAILED_RUN.slice(0, 14)); // through the failed `step` event, before phase-done
    const db = state.components.find((c) => c.component === "loom-db")!;
    expect(db.status).toBe("failed");
    expect(db.error).toMatch(/UPDATE_ROLLBACK_COMPLETE/);
  });

  it("replays a full failed run: the failed component/wave/run all read failed, the healthy wave stays ok", () => {
    const state = replay(FAILED_RUN);
    expect(state.status).toBe("failed");
    expect(state.waves.find((w) => w.wave === 1)!.status).toBe("ok");
    expect(state.waves.find((w) => w.wave === 2)!.status).toBe("failed");
    expect(state.components.find((c) => c.component === "shared-foundation")!.status).toBe("ok");
    const db = state.components.find((c) => c.component === "loom-db")!;
    expect(db.status).toBe("failed");
    expect(db.error).toBeDefined();
  });

  it("ignores an event for a component not in the current run (no crash, no phantom entry)", () => {
    const state = replay([{ type: "component-start", wave: 1, component: "ghost" }]);
    expect(state.status).toBe("idle");
    expect(state.components).toEqual([]);
  });

  it("folding is pure: it never mutates the fold it was handed", () => {
    const before = foldLines(CLEAN_RUN.slice(0, 3));
    const snapshot = JSON.parse(JSON.stringify(before));
    foldLines(CLEAN_RUN.slice(3, 4), before);
    expect(before).toEqual(snapshot);
  });
});
