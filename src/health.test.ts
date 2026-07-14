import { describe, it, expect } from "vitest";
import { classifyHealth } from "./health.ts";

describe("classifyHealth", () => {
  it("maps healthy terminal states", () => {
    for (const s of ["CREATE_COMPLETE", "UPDATE_COMPLETE", "Running", "Active", "Ready", "available", "Succeeded", "Bound"]) {
      expect(classifyHealth(s)).toBe("healthy");
    }
  });

  it("maps in-flight states to progressing", () => {
    for (const s of ["CREATE_IN_PROGRESS", "UPDATE_IN_PROGRESS", "Pending", "ContainerCreating", "Provisioning"]) {
      expect(classifyHealth(s)).toBe("progressing");
    }
  });

  it("maps failing states to degraded — even when they contain 'complete'", () => {
    for (const s of ["ROLLBACK_COMPLETE", "CREATE_FAILED", "UPDATE_ROLLBACK_FAILED", "CrashLoopBackOff", "Error", "ImagePullBackOff", "Evicted"]) {
      expect(classifyHealth(s)).toBe("degraded");
    }
  });

  it("returns unknown for unmapped or missing status (never fabricated)", () => {
    expect(classifyHealth("")).toBe("unknown");
    expect(classifyHealth(undefined)).toBe("unknown");
    expect(classifyHealth("SomeVendorSpecificState")).toBe("unknown");
  });
});
