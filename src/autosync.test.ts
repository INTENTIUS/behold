import { describe, it, expect } from "vitest";
import { pickAutoSyncOps, suspendedByRollback, isAutoSyncMode, splitForgeRouted } from "./autosync.ts";
import type { OpInfo } from "./ops.ts";

/** A single-substrate project: one ApplyOp, one ReconcileOp, neither declaring a
 * substrate (chant's ReconcileOp takes no `target` at all). This is the shape
 * every project had before #117, and it must keep behaving identically. */
const ops: OpInfo[] = [
  { name: "prod-apply", kind: "apply", env: "prod", gate: "approve-prod-apply", dir: "/p" },
  { name: "prod-reconcile", kind: "reconcile", env: "prod", dir: "/p" },
];

/** The canonical mixed estate (chant `examples/cc-aws-canonical`): the cloud
 * half applied by CloudFormation, the k8s half by kubectl. Sorted so that
 * `find`-by-kind — what #117 replaced — would have returned the AWS Op for
 * everything, including k8s drift. */
const mixedOps: OpInfo[] = [
  { name: "cloud-apply", kind: "apply", env: "prod", substrate: "aws", dir: "/p" },
  { name: "k8s-apply", kind: "apply", env: "prod", substrate: "k8s", dir: "/p" },
];

describe("pickAutoSyncOps", () => {
  it("routes each moved substrate to the Op that declares it", () => {
    const { picks, declined } = pickAutoSyncOps("apply", mixedOps, null, ["k8s"]);
    expect(declined).toEqual([]);
    expect(picks).toHaveLength(1);
    expect(picks[0].op.name).toBe("k8s-apply");
    expect(picks[0].lexicons).toEqual(["k8s"]);
  });

  // The bug #117 exists for. `ops.find((o) => o.kind === "apply")` over a
  // name-sorted list returns cloud-apply for k8s drift, and the Op then runs and
  // succeeds without touching what actually moved.
  it("does not route k8s drift to the AWS apply", () => {
    const { picks } = pickAutoSyncOps("apply", mixedOps, null, ["k8s"]);
    expect(picks.map((p) => p.op.name)).not.toContain("cloud-apply");
  });

  it("routes both halves when both moved in one tick", () => {
    const { picks } = pickAutoSyncOps("apply", mixedOps, null, ["k8s", "aws"]);
    expect(picks.map((p) => p.op.name).sort()).toEqual(["cloud-apply", "k8s-apply"]);
  });

  it("a single unscoped Op covers every substrate that moved, as one trigger", () => {
    const { picks, declined } = pickAutoSyncOps("apply", ops, null, ["aws", "k8s"]);
    expect(declined).toEqual([]);
    expect(picks).toHaveLength(1);
    expect(picks[0].op.name).toBe("prod-apply");
    expect(picks[0].lexicons).toEqual(["aws", "k8s"]);
  });

  it("pull-request mode picks the ReconcileOp, which never declares a substrate", () => {
    const { picks } = pickAutoSyncOps("pull-request", ops, null, ["aws"]);
    expect(picks[0].op.name).toBe("prod-reconcile");
  });

  it("prefers the Op that declares the substrate over an unscoped one", () => {
    const withFallback: OpInfo[] = [
      ...mixedOps,
      { name: "catch-all-apply", kind: "apply", env: "prod", dir: "/p" },
    ];
    const { picks } = pickAutoSyncOps("apply", withFallback, null, ["aws"]);
    expect(picks).toHaveLength(1);
    expect(picks[0].op.name).toBe("cloud-apply");
  });

  it("declines rather than guessing when several Ops match one substrate", () => {
    const ambiguous: OpInfo[] = [
      { name: "a-apply", kind: "apply", substrate: "aws", dir: "/p" },
      { name: "b-apply", kind: "apply", substrate: "aws", dir: "/p" },
    ];
    const { picks, declined } = pickAutoSyncOps("apply", ambiguous, null, ["aws"]);
    expect(picks).toEqual([]);
    expect(declined).toHaveLength(1);
    expect(declined[0].lexicon).toBe("aws");
    expect(declined[0].reason).toContain("a-apply, b-apply");
  });

  it("declines rather than guessing when several unscoped Ops compete", () => {
    const ambiguous: OpInfo[] = [
      { name: "a-apply", kind: "apply", dir: "/p" },
      { name: "b-apply", kind: "apply", dir: "/p" },
    ];
    const { picks, declined } = pickAutoSyncOps("apply", ambiguous, null, ["aws"]);
    expect(picks).toEqual([]);
    expect(declined[0].reason).toContain("2 apply Ops match");
  });

  it("declines a substrate no Op answers for, and still routes the one that has an Op", () => {
    const { picks, declined } = pickAutoSyncOps("apply", mixedOps, null, ["aws", "gcp"]);
    expect(picks.map((p) => p.op.name)).toEqual(["cloud-apply"]);
    expect(declined).toEqual([{ lexicon: "gcp", reason: "no apply Op declares this substrate" }]);
  });

  it("off mode routes nothing and reports no decline — it made no decision", () => {
    expect(pickAutoSyncOps("off", ops, null, ["aws"])).toEqual({ picks: [], declined: [] });
  });

  it("routes nothing while an Op is already running (no concurrent triggers)", () => {
    expect(pickAutoSyncOps("apply", ops, "prod-apply", ["aws"])).toEqual({ picks: [], declined: [] });
  });

  it("routes nothing when nothing moved", () => {
    expect(pickAutoSyncOps("apply", ops, null, []).picks).toEqual([]);
  });

  it("picks nothing when the project has no Op of the mode's kind", () => {
    const onlyReconcile: OpInfo[] = [{ name: "r", kind: "reconcile", dir: "/p" }];
    expect(pickAutoSyncOps("apply", onlyReconcile, null, ["aws"]).picks).toEqual([]);
    const onlyApply: OpInfo[] = [{ name: "a", kind: "apply", dir: "/p" }];
    expect(pickAutoSyncOps("pull-request", onlyApply, null, ["aws"]).picks).toEqual([]);
  });

  // The rollback interlock (design question 3): a pull-request loop would open a
  // ReconcileOp PR re-adopting exactly what the rollback removed.
  it("pull-request mode declines a substrate with an open rollback", () => {
    const suspended = new Set(["aws"]);
    const { picks, declined } = pickAutoSyncOps("pull-request", ops, null, ["aws"], suspended);
    expect(picks).toEqual([]);
    expect(declined[0].reason).toContain("rollback is open");
  });

  // Healing toward newly-rolled-back source IS the intended completion of a
  // rollback — chant's own rollback PR body says merge, then apply.
  it("apply mode is unaffected by an open rollback", () => {
    const suspended = new Set(["aws"]);
    const { picks } = pickAutoSyncOps("apply", ops, null, ["aws"], suspended);
    expect(picks[0].op.name).toBe("prod-apply");
  });

  it("suspending one substrate leaves the others routable", () => {
    const reconcilers: OpInfo[] = [
      { name: "aws-reconcile", kind: "reconcile", substrate: "aws", dir: "/p" },
      { name: "k8s-reconcile", kind: "reconcile", substrate: "k8s", dir: "/p" },
    ];
    const { picks, declined } = pickAutoSyncOps("pull-request", reconcilers, null, ["aws", "k8s"], new Set(["aws"]));
    expect(picks.map((p) => p.op.name)).toEqual(["k8s-reconcile"]);
    expect(declined.map((d) => d.lexicon)).toEqual(["aws"]);
  });
});

describe("suspendedByRollback", () => {
  it("suspends nothing when no rollback is open", () => {
    expect(suspendedByRollback([], ["aws", "k8s"]).size).toBe(0);
  });

  // Whole-project, because behold's rollback takes no directory scope — see the
  // function's own note. Narrowing here would invent a distinction the command
  // does not make.
  it("suspends every moved substrate while a rollback is open", () => {
    const s = suspendedByRollback(["chant/rollback-prod-abc123"], ["aws", "k8s"]);
    expect([...s].sort()).toEqual(["aws", "k8s"]);
  });

  it("suspends only what moved, not the whole estate", () => {
    const s = suspendedByRollback(["chant/rollback-prod-abc123"], ["k8s"]);
    expect([...s]).toEqual(["k8s"]);
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


// #165: an ApplyOp whose env its OWN member designates to a forge is never a
// candidate, and the designation asked of is the member's, not the primary's.
describe("splitForgeRouted", () => {
  const ops = [
    { name: "prod-apply", kind: "apply" as const, env: "prod", dir: "/estate/member" },
    { name: "prod-apply-here", kind: "apply" as const, env: "prod", dir: "/estate/primary" },
    { name: "dev-apply", kind: "apply" as const, env: "dev", dir: "/estate/member" },
    { name: "prod-reconcile", kind: "reconcile" as const, env: "prod", dir: "/estate/member" },
  ];
  const designation = (dir: string, env: string | undefined) => (dir === "/estate/member" && env === "prod" ? { forge: "github", workflow: "deploy.yml" } : undefined);

  it("routes only the member's designated ApplyOp; the primary's same-env Op and a ReconcileOp stay local", () => {
    const { routed, local } = splitForgeRouted(ops, designation);
    expect(routed.map((r) => r.op.name)).toEqual(["prod-apply"]);
    expect(routed[0].designation).toEqual({ forge: "github", workflow: "deploy.yml" });
    expect(local.map((o) => o.name)).toEqual(["prod-apply-here", "dev-apply", "prod-reconcile"]);
  });

  it("an Op with no env cannot be designated", () => {
    const { routed } = splitForgeRouted([{ name: "x", kind: "apply", dir: "/estate/member" }], () => ({ forge: "github", workflow: "d.yml" }));
    expect(routed).toEqual([]);
  });
});
