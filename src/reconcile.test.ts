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
    expect(summary).toEqual({
      env: "local",
      total: 0,
      byComponent: {},
      uncorrelated: 0,
      unobserved: 0,
      unobservedByComponent: {},
      unobservedUncorrelated: 0,
      runtime: 0,
      runtimeByComponent: {},
      runtimeUncorrelated: 0,
    });
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

// chant#1168 (#1089): `action: "unobserved"` — chant couldn't read an
// entity's live state. Its own category: not a pending change, not confirmed
// in sync. A plan from a chant that predates this fix never has this action,
// so these fixtures are purely additive to the ones above.
describe("summarizePlan — unobserved entries (chant#1168)", () => {
  const planWithUnobserved: LifecyclePlan = {
    env: "local",
    entries: [
      ...plan.entries,
      {
        name: "loom-db-parameter-group",
        action: "unobserved",
        evidence: { declared: true, inSnapshot: false, live: false, observed: false },
        ownership: "unknown",
        unobservedReason: "read-failed",
        unobservedDetail: "describe-stack-resources: connection timed out",
      },
      // An unobserved entity outside any discovered component.
      { name: "some-crd", action: "unobserved", evidence: { declared: true, inSnapshot: false, live: false, observed: false }, ownership: "unknown", unobservedReason: "unsupported-kind" },
    ],
  };

  const byComponentWithGroup: Record<string, ComponentResource[]> = {
    ...byComponent,
    "loom-db": [...byComponent["loom-db"]!, { id: "loom-db-parameter-group", kind: "RdsParameterGroup", lexicon: "aws" }],
  };

  it("counts unobserved entries separately, per component", () => {
    const summary = summarizePlan(planWithUnobserved, byComponentWithGroup);
    expect(summary.unobserved).toBe(2);
    expect(summary.unobservedByComponent).toEqual({ "loom-db": 1 });
    expect(summary.unobservedUncorrelated).toBe(1);
  });

  it("never counts an unobserved entry in `total`/`byComponent`/`uncorrelated` — it isn't a pending change", () => {
    const summary = summarizePlan(planWithUnobserved, byComponentWithGroup);
    // Same pending counts as the plain plan (2 loom-db + 1 loom-backend + 1 uncorrelated) — unaffected.
    expect(summary.total).toBe(4);
    expect(summary.byComponent).toEqual({ "loom-db": 2, "loom-backend": 1 });
    expect(summary.uncorrelated).toBe(1);
  });

  it("is 0 for a plan with no unobserved entries (backward compatible with a chant predating #1168)", () => {
    const summary = summarizePlan(plan, byComponent);
    expect(summary.unobserved).toBe(0);
    expect(summary.unobservedByComponent).toEqual({});
    expect(summary.unobservedUncorrelated).toBe(0);
  });

  it("skips a non-resource entity's unobserved entry entirely, same as a pending one", () => {
    const withParam: LifecyclePlan = {
      env: "local",
      entries: [
        ...planWithUnobserved.entries,
        { name: "pRdsEndpoint", action: "unobserved", evidence: { declared: true, inSnapshot: false, live: false, observed: false }, ownership: "unknown", unobservedReason: "read-failed" },
      ],
    };
    const withParamComponents = {
      ...byComponentWithGroup,
      "loom-db": [...byComponentWithGroup["loom-db"]!, { id: "pRdsEndpoint", kind: "AWS::CloudFormation::Parameter", lexicon: "aws" }],
    };
    const summary = summarizePlan(withParam, withParamComponents, new Set(["pRdsEndpoint"]));
    expect(summary.unobserved).toBe(2); // unchanged — the parameter is invisible
    expect(summary.unobservedByComponent).toEqual({ "loom-db": 1 });
  });
});

// chant#1180 (#1077): `action: "runtime"` — a live, undeclared resource whose
// owner-reference chain reaches a declared entity (a Pod its Deployment's
// controller created). Its own category: not a pending change, not confirmed
// in sync. A plan from a chant that predates this fix never has this action,
// so these fixtures are purely additive to the ones above.
describe("summarizePlan — runtime entries (chant#1180)", () => {
  const planWithRuntime: LifecyclePlan = {
    env: "local",
    entries: [
      ...plan.entries,
      {
        name: "loom-worker-pod-abc123",
        action: "runtime",
        evidence: { declared: false, inSnapshot: false, live: true },
        ownership: "unknown",
        runtimeOwner: "loom-backend-service",
      },
      // A runtime child with no `src/<component>/` source location at all —
      // the common case, since it's never declared anywhere.
      { name: "some-crd-child-pod", action: "runtime", evidence: { declared: false, inSnapshot: false, live: true }, ownership: "unknown", runtimeOwner: "some-crd" },
    ],
  };

  it("counts runtime entries separately, per component", () => {
    const summary = summarizePlan(planWithRuntime, byComponent);
    expect(summary.runtime).toBe(2);
    expect(summary.runtimeByComponent).toEqual({});
    expect(summary.runtimeUncorrelated).toBe(2); // neither maps to a component (no sourceLoc)
  });

  it("never counts a runtime entry in `total`/`byComponent`/`uncorrelated` — it isn't a pending change", () => {
    const summary = summarizePlan(planWithRuntime, byComponent);
    // Same pending counts as the plain plan (2 loom-db + 1 loom-backend + 1 uncorrelated) — unaffected.
    expect(summary.total).toBe(4);
    expect(summary.byComponent).toEqual({ "loom-db": 2, "loom-backend": 1 });
    expect(summary.uncorrelated).toBe(1);
  });

  it("is 0 for a plan with no runtime entries (backward compatible with a chant predating #1180)", () => {
    const summary = summarizePlan(plan, byComponent);
    expect(summary.runtime).toBe(0);
    expect(summary.runtimeByComponent).toEqual({});
    expect(summary.runtimeUncorrelated).toBe(0);
  });

  it("correlates a runtime entry to a component when its name happens to map to one", () => {
    const byComponentWithRuntimeChild: Record<string, ComponentResource[]> = {
      ...byComponent,
      "loom-backend": [...byComponent["loom-backend"]!, { id: "loom-worker-pod-abc123", kind: "K8s::Core::Pod", lexicon: "k8s" }],
    };
    const summary = summarizePlan(planWithRuntime, byComponentWithRuntimeChild);
    expect(summary.runtimeByComponent).toEqual({ "loom-backend": 1 });
    expect(summary.runtimeUncorrelated).toBe(1);
  });

  it("unobserved and runtime are independent buckets — a plan can carry both", () => {
    const both: LifecyclePlan = {
      env: "local",
      entries: [
        ...planWithRuntime.entries,
        { name: "some-crd", action: "unobserved", evidence: { declared: true, inSnapshot: false, live: false, observed: false }, ownership: "unknown", unobservedReason: "unsupported-kind" },
      ],
    };
    const summary = summarizePlan(both, byComponent);
    expect(summary.runtime).toBe(2);
    expect(summary.unobserved).toBe(1);
    expect(summary.total).toBe(4);
  });
});
