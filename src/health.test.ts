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

// #104 — the substrate-agnostic claim held for CloudFormation and failed on
// both non-AWS readers. Every string below is one chant's own plugins actually
// emit: gcp `statusFromCC` (Config Connector conditions) and azure's ARM
// `provisioningState`, checked against the lexicon source rather than guessed.
describe("classifyHealth — non-AWS substrates (#104)", () => {
  describe("Config Connector (gcp)", () => {
    it("does not read a NEGATED condition as healthy — the positive token is a substring of its own negation", () => {
      // The serious one. `NOT_READY` contains "ready", so a broken GCP resource
      // painted green. Config Connector states everything as Type=Status, so
      // this hit every resource that was not well.
      expect(classifyHealth("NOT_READY")).toBe("degraded");
      expect(classifyHealth("Ready=False")).toBe("degraded");
      expect(classifyHealth("Synced=False")).toBe("degraded");
    });

    it("lets a negation outweigh a positive condition alongside it", () => {
      // The condition-list fallback joins every type: a resource can be synced
      // and still not ready, and it is the not-ready that matters.
      expect(classifyHealth("Ready=False,Synced=True")).toBe("degraded");
    });

    it("still reads a genuinely positive condition as healthy", () => {
      expect(classifyHealth("READY")).toBe("healthy");
      expect(classifyHealth("Ready=True")).toBe("healthy");
      expect(classifyHealth("Synced=True")).toBe("healthy");
    });

    it("classifies a Ready-condition reason on its own merits", () => {
      expect(classifyHealth("UpdateFailed")).toBe("degraded");
      expect(classifyHealth("Updating")).toBe("progressing");
    });
  });

  describe("ARM (azure)", () => {
    it("maps the terminal states the CloudFormation vocabulary missed", () => {
      expect(classifyHealth("Succeeded")).toBe("healthy");
      expect(classifyHealth("Failed")).toBe("degraded");
      expect(classifyHealth("Canceled")).toBe("degraded");
    });

    it("maps Accepted to progressing — ARM has taken the request and is working", () => {
      expect(classifyHealth("Accepted")).toBe("progressing");
    });
  });

  it("reads PRESENT as healthy — the sentinel BOTH non-AWS readers emit", () => {
    // gcp emits it for a resource with no conditions at all; azure for any
    // resource type carrying no provisioningState, which is most of them.
    // Reading it as `unknown` meant a healthy Azure resource showed no verdict.
    expect(classifyHealth("PRESENT")).toBe("healthy");
  });

  it("leaves the CloudFormation vocabulary exactly as it was", () => {
    expect(classifyHealth("CREATE_COMPLETE")).toBe("healthy");
    expect(classifyHealth("UPDATE_ROLLBACK_COMPLETE")).toBe("degraded");
    expect(classifyHealth("CREATE_IN_PROGRESS")).toBe("progressing");
    expect(classifyHealth("DELETE_FAILED")).toBe("degraded");
  });
});
