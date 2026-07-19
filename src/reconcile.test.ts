import { describe, it, expect } from "vitest";
import { summarizePlan } from "./reconcile.ts";
import type { LifecyclePlan } from "./chant.ts";
import type { ComponentResource } from "./resources.ts";

// Fixture mirrors `chant lifecycle plan local --live --json`'s shape
// (chant.ts's `LifecyclePlan`) — a handful of entity-level entries across two
// components, plus one entity outside any discovered component's resource set
// (uncorrelated) and one `noop` (already in sync, so not "pending").
const plan: LifecyclePlan = {
  env: "local",
  entries: [
    { name: "loom-db-instance", action: "update", evidence: { declared: true, inSnapshot: true, live: true }, ownership: "owned" },
    { name: "loom-db-secret", action: "create", evidence: { declared: true, inSnapshot: false, live: false }, ownership: "unknown" },
    { name: "loom-backend-service", action: "noop", evidence: { declared: true, inSnapshot: true, live: true }, ownership: "owned" },
    { name: "loom-backend-task-def", action: "delete", evidence: { declared: false, inSnapshot: true, live: true }, ownership: "owned" },
    { name: "some-unrelated-bucket", action: "adopt", evidence: { declared: false, inSnapshot: false, live: true }, ownership: "unknown" },
  ],
};

const byComponent: Record<string, ComponentResource[]> = {
  "loom-db": [
    { id: "loom-db-instance", kind: "RdsInstance", lexicon: "aws" },
    { id: "loom-db-secret", kind: "SecretsManagerSecret", lexicon: "aws" },
  ],
  "loom-backend": [
    { id: "loom-backend-service", kind: "EcsService", lexicon: "aws" },
    { id: "loom-backend-task-def", kind: "EcsTaskDefinition", lexicon: "aws" },
  ],
};

describe("summarizePlan", () => {
  it("counts pending (non-noop) entries per component", () => {
    const summary = summarizePlan(plan, byComponent);
    expect(summary.env).toBe("local");
    expect(summary.byComponent).toEqual({ "loom-db": 2, "loom-backend": 1 });
  });

  it("excludes noop entries from the total — they're not pending changes", () => {
    const summary = summarizePlan(plan, byComponent);
    // 5 entries total, 1 noop excluded -> 4 pending (2 loom-db + 1 loom-backend + 1 uncorrelated)
    expect(summary.total).toBe(4);
  });

  it("counts an entry that maps to no component as uncorrelated, not dropped or guessed", () => {
    const summary = summarizePlan(plan, byComponent);
    expect(summary.uncorrelated).toBe(1);
  });

  it("total equals the sum of per-component counts plus uncorrelated", () => {
    const summary = summarizePlan(plan, byComponent);
    const perComponentSum = Object.values(summary.byComponent).reduce((a, b) => a + b, 0);
    expect(summary.total).toBe(perComponentSum + summary.uncorrelated);
  });

  it("returns all zeros for an empty plan", () => {
    const summary = summarizePlan({ env: "local", entries: [] }, byComponent);
    expect(summary).toEqual({ env: "local", total: 0, byComponent: {}, uncorrelated: 0 });
  });

  it("is all-uncorrelated when byComponent has no matching resources", () => {
    const summary = summarizePlan(plan, {});
    expect(summary.byComponent).toEqual({});
    expect(summary.uncorrelated).toBe(4); // every non-noop entry
  });

  it("skips non-resource entities (CloudFormation Parameters) entirely — not counted anywhere", () => {
    // A cross-stack parameter that the plan reports as `create` (never live,
    // resolved via seeded outputs at build time). It maps to loom-db's dir but
    // isn't a resource, so it must not inflate loom-db nor `total`.
    const withParam: LifecyclePlan = {
      env: "local",
      entries: [...plan.entries, { name: "pRdsEndpoint", action: "create", evidence: { declared: true, inSnapshot: false, live: false }, ownership: "unknown" }],
    };
    const withParamComponents = {
      ...byComponent,
      "loom-db": [...byComponent["loom-db"]!, { id: "pRdsEndpoint", kind: "AWS::CloudFormation::Parameter", lexicon: "aws" }],
    };
    const nonResource = new Set(["pRdsEndpoint"]);
    const summary = summarizePlan(withParam, withParamComponents, nonResource);
    // Same as the plain plan — the parameter is invisible to the reconcile.
    expect(summary.total).toBe(4);
    expect(summary.byComponent).toEqual({ "loom-db": 2, "loom-backend": 1 });
    expect(summary.uncorrelated).toBe(1);
  });
});
