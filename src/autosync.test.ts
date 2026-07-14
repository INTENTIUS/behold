import { describe, it, expect } from "vitest";
import { pickAutoSyncOp, isAutoSyncMode } from "./autosync.ts";
import type { OpInfo } from "./ops.ts";

const ops: OpInfo[] = [
  { name: "prod-apply", kind: "apply", env: "prod", gate: "approve-prod-apply" },
  { name: "prod-reconcile", kind: "reconcile", env: "prod" },
];

describe("pickAutoSyncOp", () => {
  it("apply mode picks the ApplyOp", () => {
    expect(pickAutoSyncOp("apply", ops, null)?.name).toBe("prod-apply");
  });

  it("pull-request mode picks the ReconcileOp", () => {
    expect(pickAutoSyncOp("pull-request", ops, null)?.name).toBe("prod-reconcile");
  });

  it("off mode picks nothing", () => {
    expect(pickAutoSyncOp("off", ops, null)).toBeNull();
  });

  it("picks nothing while an Op is already running (no concurrent triggers)", () => {
    expect(pickAutoSyncOp("apply", ops, "prod-apply")).toBeNull();
  });

  it("picks nothing when the project has no matching Op", () => {
    expect(pickAutoSyncOp("apply", [{ name: "r", kind: "reconcile" }], null)).toBeNull();
    expect(pickAutoSyncOp("pull-request", [{ name: "a", kind: "apply" }], null)).toBeNull();
  });
});

describe("isAutoSyncMode", () => {
  it("accepts valid modes, rejects others", () => {
    expect(isAutoSyncMode("apply")).toBe(true);
    expect(isAutoSyncMode("pull-request")).toBe(true);
    expect(isAutoSyncMode("off")).toBe(true);
    expect(isAutoSyncMode("nonsense")).toBe(false);
  });
});
