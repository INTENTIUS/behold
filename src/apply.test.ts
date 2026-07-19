import { describe, it, expect } from "vitest";
import {
  parseProgressLine,
  applyProgressReducer,
  initialApplyProgress,
  type RunProgressEvent,
  type ApplyProgressState,
} from "./apply.ts";

describe("parseProgressLine", () => {
  it("parses a well-formed RunProgressEvent line", () => {
    expect(parseProgressLine('{"type":"run-start","waves":[["a"]]}')).toEqual({
      type: "run-start",
      waves: [["a"]],
    });
    expect(parseProgressLine('{"type":"run-done","status":"ok"}')).toEqual({ type: "run-done", status: "ok" });
  });

  it("returns null for non-JSON — chant's human summary, warnings, blank-ish lines", () => {
    expect(parseProgressLine("Spawning worker for component...")).toBeNull();
    expect(parseProgressLine("✓ Component \"svc\" completed successfully.")).toBeNull();
    expect(parseProgressLine("")).toBeNull();
  });

  it("returns null for JSON with no recognized `type`", () => {
    expect(parseProgressLine('{"hello":"world"}')).toBeNull();
    expect(parseProgressLine('{"type":"something-else"}')).toBeNull();
    expect(parseProgressLine("42")).toBeNull(); // valid JSON, not an object
    expect(parseProgressLine("null")).toBeNull();
    expect(parseProgressLine('["a","b"]')).toBeNull(); // valid JSON, an array not an object
  });

  it("never throws on garbage input", () => {
    expect(() => parseProgressLine("{not json")).not.toThrow();
    expect(parseProgressLine("{not json")).toBeNull();
  });
});

// A realistic transcript shaped like loomster's 4-wave graph (docs/roadmap/
// m1-cli-notes.md Q1): wave 1 = [loom-cognito, shared-foundation] (no deps),
// wave 2 = [loom-db] (depends on shared-foundation). Two components across two
// waves is enough to exercise wave/component sequencing without a huge fixture.
const CLEAN_RUN: RunProgressEvent[] = [
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
const FAILED_RUN: RunProgressEvent[] = [
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

function replay(events: RunProgressEvent[]): ApplyProgressState {
  return events.reduce(applyProgressReducer, initialApplyProgress);
}

describe("applyProgressReducer", () => {
  it("starts idle", () => {
    expect(initialApplyProgress).toEqual({ status: "idle", waves: [], components: [] });
  });

  it("run-start seeds every wave/component as pending, in wave order", () => {
    const state = applyProgressReducer(initialApplyProgress, CLEAN_RUN[0]!);
    expect(state.status).toBe("running");
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
    expect(state.components.map((c) => ({ component: c.component, status: c.status, phase: c.phase, step: c.step }))).toEqual([
      { component: "loom-cognito", status: "ok", phase: "Apply", step: "cfn-deploy" },
      { component: "shared-foundation", status: "ok", phase: "Apply", step: "cfn-deploy" },
      { component: "loom-db", status: "ok", phase: "Apply", step: "cfn-deploy" },
    ]);
  });

  it("tracks phase/step live as component-start/phase-start/step events arrive mid-run", () => {
    // Replay only up through loom-cognito's running step (not yet done) —
    // the DoD's "each component showing its phase/step and a status".
    const upToRunning = CLEAN_RUN.slice(0, 6); // through the first "running" step event
    const state = replay(upToRunning);
    const cognito = state.components.find((c) => c.component === "loom-cognito")!;
    expect(cognito.status).toBe("running");
    expect(cognito.phase).toBe("Apply");
    expect(cognito.step).toBe("cfn-deploy");
    // Not yet started — still pending, not accidentally marked running/ok.
    const db = state.components.find((c) => c.component === "loom-db")!;
    expect(db.status).toBe("pending");
  });

  it("a failed step marks its component failed IMMEDIATELY — not silently green until component-done", () => {
    const upToFailedStep = FAILED_RUN.slice(0, 14); // through the failed `step` event, before phase-done
    const state = replay(upToFailedStep);
    const db = state.components.find((c) => c.component === "loom-db")!;
    expect(db.status).toBe("failed");
    expect(db.error).toMatch(/UPDATE_ROLLBACK_COMPLETE/);
  });

  it("replays a full failed run: the failed component/wave/run all read failed, the healthy wave stays ok", () => {
    const state = replay(FAILED_RUN);
    expect(state.status).toBe("failed");
    const wave1 = state.waves.find((w) => w.wave === 1)!;
    const wave2 = state.waves.find((w) => w.wave === 2)!;
    expect(wave1.status).toBe("ok");
    expect(wave2.status).toBe("failed");
    const foundation = state.components.find((c) => c.component === "shared-foundation")!;
    expect(foundation.status).toBe("ok");
    const db = state.components.find((c) => c.component === "loom-db")!;
    expect(db.status).toBe("failed");
    expect(db.error).toBeDefined();
  });

  it("ignores an event for a component/wave not in the current run (defensive — no crash, no phantom entry)", () => {
    const state = applyProgressReducer(initialApplyProgress, {
      type: "component-start",
      wave: 1,
      component: "ghost",
    });
    expect(state).toEqual(initialApplyProgress);
  });

  it("is a pure function — never mutates the input state", () => {
    const before = replay(CLEAN_RUN.slice(0, 3));
    const snapshot = JSON.parse(JSON.stringify(before));
    applyProgressReducer(before, CLEAN_RUN[3]!);
    expect(before).toEqual(snapshot);
  });
});
